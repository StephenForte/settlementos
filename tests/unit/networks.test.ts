import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  DEFAULT_FORTEL2_EXPLORER_URL,
  LIVE_NETWORK_IDS,
  NETWORKS,
  networkInfo,
  explorerTxUrl,
  explorerAddressUrl,
  settlementRailCaption,
} from "@/lib/networks";

const TX = "0xdbf963150f5c1c90e3a007cc474c3fd42255fd3d019e3d71a6d821528fe258c5";

describe("network registry", () => {
  it("contains the two local sims and the real testnets", () => {
    expect(networkInfo("base-local").chainId).toBe(31337);
    expect(networkInfo("polygon-local").chainId).toBe(31338);
    expect(networkInfo("base-sepolia")).toMatchObject({ chainId: 84532, live: true });
    expect(networkInfo("polygon-amoy")).toMatchObject({ chainId: 80002, live: true, nativeSymbol: "POL" });
  });

  it("contains ForteL2 (external rail, run outside this repo)", () => {
    expect(networkInfo("fortel2-sepolia")).toMatchObject({ chainId: 852, live: true });
    expect(networkInfo("fortel2-local").chainId).toBe(901);
    expect(NETWORKS["fortel2-local"].live).toBeUndefined();
  });

  it("lists exactly the real external networks as live", () => {
    expect(LIVE_NETWORK_IDS.sort()).toEqual(["base-sepolia", "fortel2-sepolia", "polygon-amoy"]);
  });

  it("local networks declare what they simulate; live ones do not", () => {
    expect(NETWORKS["base-local"].simulates).toBe("Base Sepolia");
    expect(NETWORKS["polygon-local"].simulates).toBe("Polygon Amoy");
    expect(NETWORKS["fortel2-local"].simulates).toBe("ForteL2 Sepolia");
    expect(NETWORKS["base-sepolia"].simulates).toBeUndefined();
    expect(NETWORKS["fortel2-sepolia"].simulates).toBeUndefined();
  });

  it("throws on unknown network ids (fails closed — no fallback network)", () => {
    expect(() => networkInfo("arbitrum-one")).toThrow(/Unknown network/);
    expect(() => networkInfo("fortel2")).toThrow(/Unknown network/);
  });
});

describe("ForteL2 env resolution", () => {
  // The registry reads env at import time, so these tests stub env and
  // re-import a fresh copy rather than asserting on the fixture-pinned module.
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  async function freshNetworks() {
    vi.resetModules();
    return await import("@/lib/networks");
  }

  it("defaults to the Mac sequencer loopback from the rail interface", async () => {
    vi.stubEnv("FORTEL2_SEPOLIA_RPC_URL", "");
    vi.stubEnv("FORTEL2_SEPOLIA_READ_RPC_URL", "");
    vi.stubEnv("FORTEL2_LOCAL_RPC_URL", "");
    const { NETWORKS: fresh } = await freshNetworks();
    expect(fresh["fortel2-sepolia"].rpcUrl).toBe("http://127.0.0.1:9545");
    expect(fresh["fortel2-sepolia"].readRpcUrl).toBeUndefined();
    expect(fresh["fortel2-local"].rpcUrl).toBe("http://127.0.0.1:9545");
  });

  it("read replica env populates readRpcUrl without touching the write RPC", async () => {
    vi.stubEnv("FORTEL2_SEPOLIA_RPC_URL", "http://127.0.0.1:9545");
    vi.stubEnv("FORTEL2_SEPOLIA_READ_RPC_URL", "https://replica.example.test");
    const { NETWORKS: fresh } = await freshNetworks();
    expect(fresh["fortel2-sepolia"].rpcUrl).toBe("http://127.0.0.1:9545");
    expect(fresh["fortel2-sepolia"].readRpcUrl).toBe("https://replica.example.test");
  });
});

describe("settlementRailCaption", () => {
  it("names the deployed rails (Render: Base Sepolia alone)", () => {
    expect(settlementRailCaption(["Base Sepolia"])).toBe(
      "Cross-border B2B stablecoin settlement · Base Sepolia"
    );
  });

  it("joins multiple deployed rails", () => {
    expect(settlementRailCaption(["Base (local)", "Polygon Amoy (local)"])).toBe(
      "Cross-border B2B stablecoin settlement · Base (local), Polygon Amoy (local)"
    );
  });

  it("says so when nothing is deployed", () => {
    expect(settlementRailCaption([])).toBe(
      "Cross-border B2B stablecoin settlement · no deployed rails"
    );
  });
});

describe("explorer URL helpers", () => {
  it("builds Basescan links for networks with an explorer", () => {
    expect(explorerTxUrl("base-sepolia", TX)).toBe(`https://sepolia.basescan.org/tx/${TX}`);
    expect(explorerAddressUrl("base-sepolia", "0x9d8b8b7c476ab02306046f3da719d380fa0456aa")).toBe(
      "https://sepolia.basescan.org/address/0x9d8b8b7c476ab02306046f3da719d380fa0456aa"
    );
  });

  it("builds Amoy Polygonscan links", () => {
    expect(explorerTxUrl("polygon-amoy", TX)).toBe(`https://amoy.polygonscan.com/tx/${TX}`);
    expect(explorerAddressUrl("polygon-amoy", "0x9d8b8b7c476ab02306046f3da719d380fa0456aa")).toBe(
      "https://amoy.polygonscan.com/address/0x9d8b8b7c476ab02306046f3da719d380fa0456aa"
    );
  });

  it("returns null for local networks (no public explorer)", () => {
    expect(explorerTxUrl("base-local", TX)).toBeNull();
    expect(explorerAddressUrl("polygon-local", "0x0")).toBeNull();
  });

  it("returns null for ForteL2 when the explorer env is pinned empty", () => {
    expect(explorerTxUrl("fortel2-sepolia", TX)).toBeNull();
    expect(explorerAddressUrl("fortel2-sepolia", "0x9d8b8b7c476ab02306046f3da719d380fa0456aa")).toBeNull();
    expect(explorerTxUrl("fortel2-local", TX)).toBeNull();
  });

  it("returns null for missing hashes or unknown networks (no throw in render paths)", () => {
    expect(explorerTxUrl("base-sepolia", null)).toBeNull();
    expect(explorerTxUrl("base-sepolia", undefined)).toBeNull();
    expect(explorerTxUrl("nonexistent", TX)).toBeNull();
  });

  it("fixture pins NEXT_PUBLIC_FORTEL2_EXPLORER_URL off", () => {
    expect(process.env.NEXT_PUBLIC_FORTEL2_EXPLORER_URL).toBe("");
  });

  describe("ForteL2 explorer when NEXT_PUBLIC_FORTEL2_EXPLORER_URL is set", () => {
    const BASE = "https://settlementos-explorer-ihgo.onrender.com";
    const CANONICAL = `${BASE}/fortel2-sepolia/tx/${TX}`;
    let previous: string | undefined;

    beforeEach(() => {
      previous = process.env.NEXT_PUBLIC_FORTEL2_EXPLORER_URL;
      process.env.NEXT_PUBLIC_FORTEL2_EXPLORER_URL = BASE;
    });

    afterEach(() => {
      if (previous === undefined) {
        delete process.env.NEXT_PUBLIC_FORTEL2_EXPLORER_URL;
      } else {
        process.env.NEXT_PUBLIC_FORTEL2_EXPLORER_URL = previous;
      }
    });

    it("defaults to the live explorer when the env var is unset", () => {
      delete process.env.NEXT_PUBLIC_FORTEL2_EXPLORER_URL;
      expect(explorerTxUrl("fortel2-sepolia", TX)).toBe(
        `${DEFAULT_FORTEL2_EXPLORER_URL}/fortel2-sepolia/tx/${TX}`
      );
    });

    it("builds the canonical ForteL2 explorer URL", () => {
      expect(explorerTxUrl("fortel2-sepolia", TX)).toBe(CANONICAL);
    });

    it("strips a trailing slash from the configured base", () => {
      process.env.NEXT_PUBLIC_FORTEL2_EXPLORER_URL = `${BASE}/`;
      expect(explorerTxUrl("fortel2-sepolia", TX)).toBe(CANONICAL);
    });

    it("still returns null for fortel2-local", () => {
      expect(explorerTxUrl("fortel2-local", TX)).toBeNull();
    });

    it("leaves explorerAddressUrl null (explorerUrl stays unset)", () => {
      expect(
        explorerAddressUrl("fortel2-sepolia", "0x9d8b8b7c476ab02306046f3da719d380fa0456aa")
      ).toBeNull();
    });

    it("still builds Basescan links for base-sepolia", () => {
      expect(explorerTxUrl("base-sepolia", TX)).toBe(`https://sepolia.basescan.org/tx/${TX}`);
    });

    it("returns null for a missing hash", () => {
      expect(explorerTxUrl("fortel2-sepolia", null)).toBeNull();
      expect(explorerTxUrl("fortel2-sepolia", undefined)).toBeNull();
    });
  });
});
