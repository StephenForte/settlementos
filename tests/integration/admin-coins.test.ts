// /admin/coins — read-only mock-token inspect view over GET /api/balances reads
// plus deployment metadata. Layout already OPERATOR-gates; this file renders
// the page itself.

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as chain from "@/lib/chain";
import { formatAmount, fromBaseUnits } from "@/lib/assets";
import { explorerAddressUrl } from "@/lib/networks";

vi.mock("@/lib/chain", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/chain")>();
  return {
    ...actual,
    isChainReady: vi.fn(actual.isChainReady),
    loadDeployments: vi.fn(actual.loadDeployments),
    networkContracts: vi.fn(actual.networkContracts),
    tokenBalance: vi.fn(actual.tokenBalance),
    accountsFor: vi.fn(actual.accountsFor),
  };
});

import AdminCoinsPage, { CoinsView, type CoinsPageData } from "@/app/admin/coins/page";

const FORTE = "fortel2-sepolia";
const FORTE_TOKENS = {
  mockUSDC: { address: "0x3333333333333333333333333333333333333333" as const, decimals: 6 },
  mockJPY: { address: "0x4444444444444444444444444444444444444444" as const, decimals: 0 },
  mockSGD: { address: "0x5555555555555555555555555555555555555555" as const, decimals: 6 },
};

async function renderCoinsPage() {
  return renderToStaticMarkup(await AdminCoinsPage());
}

afterEach(async () => {
  const actual = await vi.importActual<typeof import("@/lib/chain")>("@/lib/chain");
  vi.mocked(chain.isChainReady).mockReset();
  vi.mocked(chain.loadDeployments).mockReset();
  vi.mocked(chain.networkContracts).mockReset();
  vi.mocked(chain.tokenBalance).mockReset();
  vi.mocked(chain.accountsFor).mockReset();
  vi.mocked(chain.isChainReady).mockImplementation(actual.isChainReady);
  vi.mocked(chain.loadDeployments).mockImplementation(actual.loadDeployments);
  vi.mocked(chain.networkContracts).mockImplementation(actual.networkContracts);
  vi.mocked(chain.tokenBalance).mockImplementation(actual.tokenBalance);
  vi.mocked(chain.accountsFor).mockImplementation(actual.accountsFor);
});

describe("/admin/coins", () => {
  it("renders every token in the deployments fixture with its address and decimals", async () => {
    const dep = chain.loadDeployments();
    expect(Object.keys(dep.networks).length).toBeGreaterThan(0);

    const html = await renderCoinsPage();
    expect(html).toContain("Mock coins");

    for (const [networkId, net] of Object.entries(dep.networks)) {
      expect(html).toContain(networkId);
      for (const token of Object.values(net.contracts.tokens)) {
        expect(html).toContain(token.address);
        expect(html).toContain(`decimals ${token.decimals}`);
      }
    }
  });

  it("formats a mockJPY amount with 0 decimals", async () => {
    const jpyRaw = 15_668_160n;
    const expected = formatAmount(fromBaseUnits(jpyRaw, 0), "JPY");
    expect(expected).toBe("15,668,160");

    vi.mocked(chain.tokenBalance).mockImplementation(async (networkId, tokenAddr, owner, opts) => {
      const tokens = chain.networkContracts(networkId).tokens;
      if (tokenAddr.toLowerCase() === tokens.mockJPY.address.toLowerCase()) {
        return jpyRaw;
      }
      const actual = await vi.importActual<typeof import("@/lib/chain")>("@/lib/chain");
      return actual.tokenBalance(networkId, tokenAddr, owner, opts);
    });

    const html = await renderCoinsPage();
    expect(html).toContain("15,668,160");
    expect(html).not.toContain("15,668,160.00");
    expect(html).not.toContain("15.668160");
  });

  it("shows a per-network RPC error inline and still renders the other networks", async () => {
    vi.mocked(chain.tokenBalance).mockImplementation(async (networkId, token, owner, opts) => {
      if (networkId === "polygon-local") throw new Error("ECONNREFUSED");
      const actual = await vi.importActual<typeof import("@/lib/chain")>("@/lib/chain");
      return actual.tokenBalance(networkId, token, owner, opts);
    });

    const html = await renderCoinsPage();
    const dep = chain.loadDeployments();

    expect(html).toContain("RPC unreachable for polygon-local");
    expect(html).toContain("base-local");
    expect(html).not.toContain("RPC unreachable for base-local");

    for (const token of Object.values(dep.networks["polygon-local"].contracts.tokens)) {
      expect(html).toContain(token.address);
    }
    for (const token of Object.values(dep.networks["base-local"].contracts.tokens)) {
      expect(html).toContain(token.address);
    }
    expect(html).toContain("Settlement Treasury");
  });

  it("renders fortel2-sepolia rows without an explorer link and without crashing", async () => {
    expect(explorerAddressUrl(FORTE, FORTE_TOKENS.mockUSDC.address)).toBeNull();

    const data: CoinsPageData = {
      networks: [
        {
          networkId: FORTE,
          label: "ForteL2 Sepolia",
          chainId: 852,
          tokens: Object.entries(FORTE_TOKENS).map(([symbol, token]) => ({
            symbol,
            name: symbol,
            currency: symbol === "mockJPY" ? "JPY" : symbol === "mockSGD" ? "SGD" : "USD",
            address: token.address,
            decimals: token.decimals,
            explorerUrl: explorerAddressUrl(FORTE, token.address),
            holders: [
              {
                label: "Settlement Treasury",
                kind: "treasury",
                address: "0x6666666666666666666666666666666666666666",
                amount: symbol === "mockJPY" ? "42" : "1",
                formatted: symbol === "mockJPY" ? formatAmount("42", "JPY") : formatAmount("1", "USD"),
              },
            ],
          })),
        },
      ],
    };

    const html = renderToStaticMarkup(createElement(CoinsView, { data }));
    expect(html).toContain(FORTE);
    for (const token of Object.values(FORTE_TOKENS)) {
      expect(html).toContain(token.address);
      expect(html).toContain(`decimals ${token.decimals}`);
      expect(html).not.toMatch(new RegExp(`href="[^"]*${token.address}`, "i"));
    }
    expect(html).not.toContain("sepolia.basescan.org");
    expect(html).not.toContain("amoy.polygonscan.com");
    expect(html).toContain("42");
  });

  it("surfaces the balances chain-unavailable message when chains are down", async () => {
    vi.mocked(chain.isChainReady).mockReturnValue(false);
    const html = await renderCoinsPage();
    expect(html).toContain(
      "Chains not set up. Run: npm run chain, npm run chain:polygon, then npm run setup"
    );
    expect(html).not.toContain("base-local");
  });
});
