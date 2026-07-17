// Per-network RPC degradation on GET /api/balances: one unreachable endpoint
// must not 500 the whole response. tokenBalance is stubbed for one network so
// the route's try/catch path is exercised without killing a fixture chain.

import { describe, it, expect, vi, afterEach } from "vitest";
import { NextRequest } from "next/server";
import { API_KEY_HEADER } from "@/lib/auth";
import { API_KEYS } from "../fixture";
import * as chain from "@/lib/chain";

vi.mock("@/lib/chain", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/chain")>();
  return {
    ...actual,
    tokenBalance: vi.fn(actual.tokenBalance),
  };
});

import { GET as balancesGET } from "@/app/api/balances/route";

afterEach(() => {
  vi.mocked(chain.tokenBalance).mockReset();
  vi.mocked(chain.tokenBalance).mockImplementation(async (...args) => {
    const actual = await vi.importActual<typeof import("@/lib/chain")>("@/lib/chain");
    return actual.tokenBalance(...args);
  });
});

describe("GET /api/balances RPC degradation", () => {
  it("returns 200 with an error slot for the flaky network and balances for the rest", async () => {
    vi.mocked(chain.tokenBalance).mockImplementation(async (networkId, token, owner) => {
      if (networkId === "polygon-local") throw new Error("ECONNREFUSED");
      const actual = await vi.importActual<typeof import("@/lib/chain")>("@/lib/chain");
      return actual.tokenBalance(networkId, token, owner);
    });

    const res = await balancesGET(
      new NextRequest("http://test.local/api/balances", {
        headers: { [API_KEY_HEADER]: API_KEYS.operator },
      })
    );
    expect(res.status).toBe(200);
    const body = await res.json();

    expect(body.networks["polygon-local"]).toMatchObject({
      balances: [],
      error: expect.stringMatching(/polygon-local/),
    });
    expect(body.networks["base-local"].balances.length).toBeGreaterThan(0);
    expect(body.networks["base-local"].error).toBeUndefined();
  });
});
