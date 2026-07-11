import { describe, it, expect, vi, afterEach } from "vitest";
import { openSanctionsScreen } from "@/lib/providers/opensanctions";
import {
  chainalysisOracleScreen,
  DEFAULT_ORACLE_ADDRESS,
} from "@/lib/providers/chainalysis";
import { providerTimeoutMs } from "@/lib/providers/http";
import { sanctionsCheck, walletRiskCheck } from "@/lib/compliance";
import type { Entity, Wallet } from "@prisma/client";

// Pure unit tests: fetch is stubbed, no network, no DB writes (the compliance
// dispatch helpers take entities/wallets as plain objects). The oracle adapter
// talks JSON-RPC through viem's http transport — which also uses global fetch —
// so stubbing fetch exercises the real ABI encode/decode path.

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

function stubFetch(status: number, body: unknown) {
  const calls: { url: string; init: RequestInit }[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return { status, json: async () => body };
    })
  );
  return calls;
}

const BOOL_TRUE = `0x${"0".repeat(63)}1`;
const BOOL_FALSE = `0x${"0".repeat(64)}`;

/** JSON-RPC stub for the oracle: answers eth_call per `isSanctioned`, plus block number. */
function stubRpc(handler: (method: string, params: unknown[]) => unknown) {
  const calls: { method: string; params: unknown[] }[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url: string, init: RequestInit) => {
      const req = JSON.parse(init.body as string);
      const reqs: { id: number; method: string; params: unknown[] }[] = Array.isArray(req)
        ? req
        : [req];
      const replies = reqs.map((r) => {
        calls.push({ method: r.method, params: r.params });
        try {
          return { jsonrpc: "2.0", id: r.id, result: handler(r.method, r.params) };
        } catch (err) {
          return { jsonrpc: "2.0", id: r.id, error: { code: -32000, message: String(err) } };
        }
      });
      return new Response(JSON.stringify(Array.isArray(req) ? replies : replies[0]), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    })
  );
  return calls;
}

function oracleRpc(isSanctioned: boolean) {
  return stubRpc((method) => {
    if (method === "eth_call") return isSanctioned ? BOOL_TRUE : BOOL_FALSE;
    if (method === "eth_blockNumber") return "0x10";
    if (method === "eth_chainId") return "0x1";
    throw new Error(`unexpected method ${method}`);
  });
}

function entity(overrides: Partial<Entity> = {}): Entity {
  return {
    name: "ACME Corp",
    country: "US",
    ...overrides,
  } as Entity;
}

function wallet(overrides: Partial<Wallet> = {}): Wallet {
  return {
    address: "0x1111111111111111111111111111111111111111",
    network: "base-local",
    allowlisted: true,
    riskScore: 5,
    ...overrides,
  } as Wallet;
}

describe("openSanctionsScreen", () => {
  const parties = [
    { kind: "sender" as const, name: "ACME Corp", country: "US" },
    { kind: "recipient" as const, name: "Tokyo Supplier KK", country: "JP" },
  ];

  it("FAILs when the API reports a match, naming the matched party", async () => {
    const body = {
      responses: {
        sender: { results: [] },
        recipient: { results: [{ score: 0.95, match: true }] },
      },
    };
    stubFetch(200, body);
    const res = await openSanctionsScreen(parties);
    expect(res.status).toBe("FAIL");
    expect(res.reason_codes).toContain("recipient_sanctions_list_match");
    expect(res.raw).toEqual(body);
  });

  it("routes near-threshold scores to MANUAL_REVIEW", async () => {
    stubFetch(200, {
      responses: { sender: { results: [{ score: 0.62, match: false }] }, recipient: { results: [] } },
    });
    const res = await openSanctionsScreen(parties);
    expect(res.status).toBe("MANUAL_REVIEW");
    expect(res.reason_codes).toContain("sanctions_possible_match");
    expect(res.score).toBe(62);
  });

  it("PASSes clean results and keeps the raw response as evidence", async () => {
    stubFetch(200, { responses: { sender: { results: [{ score: 0.1, match: false }] }, recipient: { results: [] } } });
    const res = await openSanctionsScreen(parties);
    expect(res.status).toBe("PASS");
    expect(res.raw).toBeTruthy();
  });

  it("sends the ApiKey auth header and one Company query per party", async () => {
    vi.stubEnv("OPENSANCTIONS_API_KEY", "test-key-123");
    const calls = stubFetch(200, { responses: {} });
    await openSanctionsScreen(parties);

    expect(calls[0].url).toBe("https://api.opensanctions.org/match/default");
    expect((calls[0].init.headers as Record<string, string>).Authorization).toBe("ApiKey test-key-123");
    const payload = JSON.parse(calls[0].init.body as string);
    expect(payload.queries.sender.schema).toBe("Company");
    expect(payload.queries.sender.properties.name).toEqual(["ACME Corp"]);
    expect(payload.queries.recipient.properties.country).toEqual(["JP"]);
  });

  it("fails safe to MANUAL_REVIEW on non-200 responses", async () => {
    stubFetch(401, { error: "bad key" });
    const res = await openSanctionsScreen(parties);
    expect(res.status).toBe("MANUAL_REVIEW");
    expect(res.reason_codes).toContain("provider_error");
    expect(res.reason_codes).toContain("provider_http_401");
  });

  it("fails safe to MANUAL_REVIEW on network errors / timeouts", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Promise.reject(new Error("socket hang up"))));
    const res = await openSanctionsScreen(parties);
    expect(res.status).toBe("MANUAL_REVIEW");
    expect(res.reason_codes).toEqual(["provider_error", "provider_unreachable"]);
    expect((res.raw as { error: string }).error).toBe("socket hang up");
  });
});

describe("chainalysisOracleScreen", () => {
  const addr = "0x7f367cc41522ce07553e823bf3be79a889debe1b";

  it("FAILs sanctioned addresses with the oracle read as evidence", async () => {
    vi.stubEnv("CHAINALYSIS_ORACLE_RPC_URL", "http://oracle-rpc.test");
    oracleRpc(true);
    const res = await chainalysisOracleScreen(addr);
    expect(res.status).toBe("FAIL");
    expect(res.reason_codes).toContain("wallet_sanctioned");
    expect(res.raw).toMatchObject({
      oracle: DEFAULT_ORACLE_ADDRESS,
      checked_address: addr,
      is_sanctioned: true,
      block_number: "16",
    });
  });

  it("PASSes clean addresses, calling isSanctioned on the default oracle contract", async () => {
    vi.stubEnv("CHAINALYSIS_ORACLE_RPC_URL", "http://oracle-rpc.test");
    const calls = oracleRpc(false);
    const res = await chainalysisOracleScreen(addr);
    expect(res.status).toBe("PASS");

    const call = calls.find((c) => c.method === "eth_call")!;
    const { to, data } = call.params[0] as { to: string; data: string };
    expect(to.toLowerCase()).toBe(DEFAULT_ORACLE_ADDRESS.toLowerCase());
    // isSanctioned(address) selector + the screened address as the argument
    expect(data.toLowerCase()).toContain(addr.slice(2));
  });

  it("screens addresses with broken EIP-55 casing by normalizing to lowercase", async () => {
    vi.stubEnv("CHAINALYSIS_ORACLE_RPC_URL", "http://oracle-rpc.test");
    oracleRpc(false);
    // Mixed case that fails checksum validation — must not block screening.
    const res = await chainalysisOracleScreen("0x7F367CC41522CE07553e823bf3be79A889DEbe1B");
    expect(res.status).toBe("PASS");
    expect((res.raw as { checked_address: string }).checked_address).toBe(addr);
  });

  it("honors CHAINALYSIS_ORACLE_ADDRESS for chains with a different deployment", async () => {
    const baseOracle = "0x3A91A31cB3dC49b4db9Ce721F50a9D076c8D739B";
    vi.stubEnv("CHAINALYSIS_ORACLE_RPC_URL", "http://oracle-rpc.test");
    vi.stubEnv("CHAINALYSIS_ORACLE_ADDRESS", baseOracle);
    const calls = oracleRpc(false);
    await chainalysisOracleScreen(addr);
    const call = calls.find((c) => c.method === "eth_call")!;
    expect((call.params[0] as { to: string }).to.toLowerCase()).toBe(baseOracle.toLowerCase());
  });

  it("fails safe when no RPC URL is configured or the address is malformed", async () => {
    vi.stubEnv("CHAINALYSIS_ORACLE_RPC_URL", "");
    expect((await chainalysisOracleScreen(addr)).status).toBe("MANUAL_REVIEW");

    vi.stubEnv("CHAINALYSIS_ORACLE_RPC_URL", "http://oracle-rpc.test");
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const res = await chainalysisOracleScreen("not-an-address");
    expect(res.status).toBe("MANUAL_REVIEW");
    expect(res.reason_codes).toContain("provider_error");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("fails safe on RPC errors and network failures", async () => {
    vi.stubEnv("CHAINALYSIS_ORACLE_RPC_URL", "http://oracle-rpc.test");
    stubRpc(() => {
      throw new Error("execution reverted");
    });
    expect((await chainalysisOracleScreen(addr)).status).toBe("MANUAL_REVIEW");

    vi.stubGlobal("fetch", vi.fn(async () => Promise.reject(new Error("ECONNREFUSED"))));
    const res = await chainalysisOracleScreen(addr);
    expect(res.status).toBe("MANUAL_REVIEW");
    expect(res.reason_codes).toContain("provider_error");
  });
});

describe("provider registry dispatch", () => {
  it("uses the mock sanctions provider when no API key is set", async () => {
    vi.stubEnv("OPENSANCTIONS_API_KEY", "");
    const res = await sanctionsCheck(entity(), entity({ name: "Tokyo Supplier KK", country: "JP" }));
    expect(res.provider).toBe("mock_sanctions");
    expect(res.status).toBe("PASS");
  });

  it("uses OpenSanctions when the API key is set", async () => {
    vi.stubEnv("OPENSANCTIONS_API_KEY", "test-key");
    stubFetch(200, { responses: {} });
    const res = await sanctionsCheck(entity(), entity({ name: "Tokyo Supplier KK" }));
    expect(res.provider).toBe("opensanctions");
  });

  it("uses the mock wallet-risk provider when no oracle RPC is set", async () => {
    vi.stubEnv("CHAINALYSIS_ORACLE_RPC_URL", "");
    const res = await walletRiskCheck(wallet({ riskScore: 85 }));
    expect(res.provider).toBe("mock_wallet_risk");
    expect(res.status).toBe("FAIL");
  });

  it("uses the Chainalysis oracle when an RPC URL is set", async () => {
    vi.stubEnv("CHAINALYSIS_ORACLE_RPC_URL", "http://oracle-rpc.test");
    oracleRpc(false);
    const res = await walletRiskCheck(wallet());
    expect(res.provider).toBe("chainalysis_oracle");
    expect(res.status).toBe("PASS");
  });

  it("applies platform policy (registration/allowlist) before any provider call", async () => {
    vi.stubEnv("CHAINALYSIS_ORACLE_RPC_URL", "http://oracle-rpc.test");
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);

    const missing = await walletRiskCheck(null);
    expect(missing.status).toBe("MANUAL_REVIEW");
    expect(missing.reason_codes).toContain("wallet_not_registered");

    const blocked = await walletRiskCheck(wallet({ allowlisted: false }));
    expect(blocked.status).toBe("MANUAL_REVIEW");
    expect(blocked.reason_codes).toContain("wallet_not_allowlisted");

    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe("provider timeout config", () => {
  it("defaults to 5s and honors COMPLIANCE_PROVIDER_TIMEOUT_MS", () => {
    vi.stubEnv("COMPLIANCE_PROVIDER_TIMEOUT_MS", "");
    expect(providerTimeoutMs()).toBe(5000);
    vi.stubEnv("COMPLIANCE_PROVIDER_TIMEOUT_MS", "1500");
    expect(providerTimeoutMs()).toBe(1500);
    vi.stubEnv("COMPLIANCE_PROVIDER_TIMEOUT_MS", "not-a-number");
    expect(providerTimeoutMs()).toBe(5000);
  });
});
