// The read/write RPC split (F1): a network with a declared read replica serves
// balance/display reads from it, while writes — and every read that gates a
// write — stay on the sequencer RPC. lib/networks reads env at import time, so
// each test stubs env and re-imports fresh copies of networks + chain.

import { describe, it, expect, afterEach, vi } from "vitest";

describe("readClientFor", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  async function freshChain() {
    vi.resetModules();
    return await import("@/lib/chain");
  }

  it("without a read RPC, read and write clients are the same object", async () => {
    vi.stubEnv("FORTEL2_SEPOLIA_READ_RPC_URL", "");
    const chain = await freshChain();
    expect(chain.readClientFor("fortel2-sepolia")).toBe(chain.publicClientFor("fortel2-sepolia"));
    // Networks that never declare one behave identically.
    expect(chain.readClientFor("base-sepolia")).toBe(chain.publicClientFor("base-sepolia"));
  });

  it("with a read RPC, reads go to the replica and writes stay on the sequencer", async () => {
    vi.stubEnv("FORTEL2_SEPOLIA_RPC_URL", "http://127.0.0.1:9545");
    vi.stubEnv("FORTEL2_SEPOLIA_READ_RPC_URL", "http://127.0.0.1:9601");
    const chain = await freshChain();
    const read = chain.readClientFor("fortel2-sepolia");
    const write = chain.publicClientFor("fortel2-sepolia");
    expect(read).not.toBe(write);
    expect(read.transport.url).toBe("http://127.0.0.1:9601");
    expect(write.transport.url).toBe("http://127.0.0.1:9545");
  });

  it("fails closed on unknown networks rather than falling back", async () => {
    const chain = await freshChain();
    expect(() => chain.readClientFor("fortel2")).toThrow(/Unknown network/);
    expect(() => chain.publicClientFor("fortel2")).toThrow(/Unknown network/);
  });
});

describe("Cloudflare Access write headers", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  async function freshChain() {
    vi.resetModules();
    return await import("@/lib/chain");
  }

  function accessHeaders(client: { transport: Record<string, unknown> }) {
    const opts = client.transport.fetchOptions as { headers?: unknown } | undefined;
    return opts?.headers;
  }

  it("with CF env set, write transport has the two headers; read transport does not", async () => {
    vi.stubEnv("FORTEL2_SEPOLIA_RPC_URL", "https://fortel2-write.ente.ltd");
    vi.stubEnv("FORTEL2_SEPOLIA_READ_RPC_URL", "http://fortel2-replica:10000");
    vi.stubEnv("CF_ACCESS_CLIENT_ID", "test-access-id");
    vi.stubEnv("CF_ACCESS_CLIENT_SECRET", "test-access-secret");
    const chain = await freshChain();
    const write = chain.publicClientFor("fortel2-sepolia");
    const read = chain.readClientFor("fortel2-sepolia");
    expect(accessHeaders(write)).toEqual({
      "CF-Access-Client-Id": "test-access-id",
      "CF-Access-Client-Secret": "test-access-secret",
    });
    expect(accessHeaders(read)).toBeUndefined();

    const { privateKeyToAccount } = await import("viem/accounts");
    const account = privateKeyToAccount(
      "0x1111111111111111111111111111111111111111111111111111111111111111"
    );
    const wallet = await chain.walletFor("fortel2-sepolia", {
      address: account.address,
      account: async () => account,
    });
    expect(accessHeaders(wallet)).toEqual({
      "CF-Access-Client-Id": "test-access-id",
      "CF-Access-Client-Secret": "test-access-secret",
    });
  });

  it("if either CF env is missing, write transport has no Access headers", async () => {
    vi.stubEnv("FORTEL2_SEPOLIA_RPC_URL", "http://127.0.0.1:9545");
    vi.stubEnv("CF_ACCESS_CLIENT_ID", "test-access-id");
    vi.stubEnv("CF_ACCESS_CLIENT_SECRET", "");
    const chain = await freshChain();
    expect(accessHeaders(chain.publicClientFor("fortel2-sepolia"))).toBeUndefined();
  });

  it("with both CF_ACCESS_* set, publicClientFor(\"base-sepolia\") has no Access headers", async () => {
    vi.stubEnv("CF_ACCESS_CLIENT_ID", "test-access-id");
    vi.stubEnv("CF_ACCESS_CLIENT_SECRET", "test-access-secret");
    const chain = await freshChain();
    expect(accessHeaders(chain.publicClientFor("base-sepolia"))).toBeUndefined();
  });
});
