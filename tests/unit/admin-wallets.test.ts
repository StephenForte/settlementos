import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const PLANTED_PRIVATE_KEY = `0x${"ab".repeat(32)}`;
const TREASURY_BASE = "0x1111111111111111111111111111111111111111";
const TREASURY_POLY = "0x2222222222222222222222222222222222222222";
const ACME_BASE = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const ACME_POLY = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const USDC = "0xcccccccccccccccccccccccccccccccccccccccc";
const JPY = "0xdddddddddddddddddddddddddddddddddddddddd";
const SGD = "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";
const JPY_AMOUNT = 3_915_077n;

vi.mock("@/lib/chain", () => ({
  isChainReady: vi.fn(() => true),
  loadDeployments: vi.fn(),
  accountsFor: vi.fn(),
  tokenBalance: vi.fn(),
  nativeBalance: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  prisma: {
    entity: {
      findMany: vi.fn(),
    },
  },
}));

import { accountsFor, isChainReady, loadDeployments, nativeBalance, tokenBalance } from "@/lib/chain";
import { prisma } from "@/lib/db";
import { copyAddressProps } from "@/app/admin/wallets/props";
import {
  addressOnNetwork,
  clientPropsForWallets,
  loadAdminWallets,
} from "@/app/admin/wallets/wallets-data";
import AdminWalletsPage from "@/app/admin/wallets/page";

const HEX64 = /[0-9a-fA-F]{64}/;

/** Required leak guard: no `privateKey` key and no 64-hex key material. */
function assertNoKeyMaterial(value: unknown): void {
  const json = typeof value === "string" ? value : JSON.stringify(value);
  if (json.includes("privateKey")) {
    throw new Error("leak guard: serialized value contains privateKey");
  }
  if (HEX64.test(json)) {
    throw new Error("leak guard: serialized value contains a 64-hex-character string");
  }
}

function networkContracts() {
  return {
    PaymentSettlement: "0x9999999999999999999999999999999999999999" as const,
    tokens: {
      mockUSDC: { address: USDC as `0x${string}`, decimals: 6 },
      mockJPY: { address: JPY as `0x${string}`, decimals: 0 },
      mockSGD: { address: SGD as `0x${string}`, decimals: 6 },
    },
  };
}

function stubDeployments() {
  vi.mocked(isChainReady).mockReturnValue(true);
  vi.mocked(loadDeployments).mockReturnValue({
    networks: {
      "base-local": {
        chainId: 31337,
        rpcUrl: "http://127.0.0.1:8545",
        contracts: networkContracts(),
      },
      "polygon-local": {
        chainId: 31338,
        rpcUrl: "http://127.0.0.1:8546",
        contracts: networkContracts(),
      },
    },
  });
  vi.mocked(accountsFor).mockImplementation((networkId: string) => ({
    operator: { address: "0x0101010101010101010101010101010101010101" as `0x${string}` },
    treasury: {
      address: (networkId === "polygon-local" ? TREASURY_POLY : TREASURY_BASE) as `0x${string}`,
      // Planted on purpose: the page must select `.address` and drop this.
      privateKey: PLANTED_PRIVATE_KEY as `0x${string}`,
    },
    entityWallets: {
      "acme-us": {
        address: ACME_BASE as `0x${string}`,
        privateKey: PLANTED_PRIVATE_KEY as `0x${string}`,
      },
    },
  }));
  vi.mocked(nativeBalance).mockResolvedValue(500_000_000_000_000_000n);
  vi.mocked(tokenBalance).mockImplementation(async (_networkId, token) => {
    if (token.toLowerCase() === JPY.toLowerCase()) return JPY_AMOUNT;
    if (token.toLowerCase() === USDC.toLowerCase()) return 1_500_000n;
    return 0n;
  });
}

beforeEach(() => {
  vi.mocked(isChainReady).mockReset();
  vi.mocked(loadDeployments).mockReset();
  vi.mocked(accountsFor).mockReset();
  vi.mocked(tokenBalance).mockReset();
  vi.mocked(nativeBalance).mockReset();
  vi.mocked(prisma.entity.findMany).mockReset();
  stubDeployments();
  vi.mocked(prisma.entity.findMany).mockResolvedValue([
    {
      id: "ent_acme",
      name: "ACME US Inc",
      wallets: [
        { network: "base-local", address: ACME_BASE },
        { network: "polygon-local", address: ACME_POLY },
      ],
    },
  ] as never);
});

async function renderWallets(): Promise<string> {
  return renderToStaticMarkup(await AdminWalletsPage());
}

function sectionHtml(html: string, networkId: string): string {
  const start = html.indexOf(`data-network="${networkId}"`);
  expect(start).toBeGreaterThanOrEqual(0);
  const next = html.indexOf("data-network=", start + 1);
  return next === -1 ? html.slice(start) : html.slice(start, next);
}

describe("addressOnNetwork", () => {
  it("omits an entity that has no wallet row on the requested network", () => {
    const wallets = [{ network: "polygon-local", address: ACME_POLY }];
    expect(addressOnNetwork(wallets, "base-local")).toBeUndefined();
    expect(addressOnNetwork(wallets, "polygon-local")).toBe(ACME_POLY);
  });
});

describe("/admin/wallets", () => {
  it("does not render another network's address when a wallet row is missing", async () => {
    vi.mocked(prisma.entity.findMany).mockResolvedValue([
      {
        id: "ent_acme",
        name: "ACME US Inc",
        wallets: [{ network: "polygon-local", address: ACME_POLY }],
      },
    ] as never);

    const html = await renderWallets();
    const base = sectionHtml(html, "base-local");
    const polygon = sectionHtml(html, "polygon-local");

    expect(base).not.toContain(ACME_POLY);
    expect(base).toContain("No wallet on this network");
    expect(polygon).toContain(ACME_POLY);
    expect(polygon).not.toContain("No wallet on this network");
  });

  it("formats mockJPY with 0 decimals as the exact fromBaseUnits string", async () => {
    const html = await renderWallets();
    expect(html).toMatch(/data-token="mockJPY">3915077</);
    expect(html).not.toContain("3915077.00");
    expect(html).not.toContain("3,915,077");
  });

  it("degrades a failed balance read inline and still renders other networks", async () => {
    vi.mocked(nativeBalance).mockImplementation(async (networkId) => {
      if (networkId === "polygon-local") throw new Error("ECONNREFUSED");
      return 1_000_000_000_000_000_000n;
    });

    const html = await renderWallets();
    const base = sectionHtml(html, "base-local");
    const polygon = sectionHtml(html, "polygon-local");

    expect(polygon).toContain("RPC unreachable for polygon-local");
    expect(polygon).toContain(TREASURY_POLY);
    expect(base).not.toContain("RPC unreachable");
    expect(base).toContain(TREASURY_BASE);
    expect(base).toMatch(/data-token="mockJPY">3915077</);
  });

  it("leak guard: client props and rendered output contain no key material", async () => {
    const data = await loadAdminWallets();
    expect(data.ready).toBe(true);
    if (!data.ready) return;

    const clientProps = data.networks.flatMap((n) => clientPropsForWallets(n.wallets));
    expect(clientProps.length).toBeGreaterThan(0);
    for (const props of clientProps) {
      expect(Object.keys(props)).toEqual(["address"]);
      assertNoKeyMaterial(props);
    }
    assertNoKeyMaterial(clientProps);
    assertNoKeyMaterial(data);

    const html = await renderWallets();
    assertNoKeyMaterial(html);
    expect(html).not.toContain(PLANTED_PRIVATE_KEY);
    expect(html).toContain(TREASURY_BASE);
  });

  it("surfaces the chain-unavailable hint when deployments are missing", async () => {
    vi.mocked(isChainReady).mockReturnValue(false);
    const html = await renderWallets();
    expect(html).toContain("Chains not set up. Run: npm run chain, npm run chain:polygon, then npm run setup");
    expect(html).not.toContain(TREASURY_BASE);
  });

  it("leak guard fails if a private key is deliberately planted", () => {
    expect(() =>
      assertNoKeyMaterial({
        address: TREASURY_BASE,
        privateKey: PLANTED_PRIVATE_KEY,
      })
    ).toThrow(/privateKey/);

    expect(() => assertNoKeyMaterial({ leftover: "ab".repeat(32) })).toThrow(/64-hex/);

    // The page's own client-prop builder stays clean even given a key-bearing record.
    const planted = {
      address: TREASURY_BASE,
      privateKey: PLANTED_PRIVATE_KEY,
    };
    assertNoKeyMaterial(copyAddressProps(planted.address));
  });
});
