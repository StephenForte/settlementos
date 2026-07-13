import { describe, it, expect } from "vitest";
import { LIVE_NETWORK_IDS, NETWORKS, networkInfo, explorerTxUrl, explorerAddressUrl } from "@/lib/networks";

const TX = "0xdbf963150f5c1c90e3a007cc474c3fd42255fd3d019e3d71a6d821528fe258c5";

describe("network registry", () => {
  it("contains the two local sims and the real testnets", () => {
    expect(networkInfo("base-local").chainId).toBe(31337);
    expect(networkInfo("polygon-local").chainId).toBe(31338);
    expect(networkInfo("base-sepolia")).toMatchObject({ chainId: 84532, live: true });
    expect(networkInfo("polygon-amoy")).toMatchObject({ chainId: 80002, live: true, nativeSymbol: "POL" });
  });

  it("lists exactly the real testnets as live", () => {
    expect(LIVE_NETWORK_IDS.sort()).toEqual(["base-sepolia", "polygon-amoy"]);
  });

  it("local networks declare what they simulate; live ones do not", () => {
    expect(NETWORKS["base-local"].simulates).toBe("Base Sepolia");
    expect(NETWORKS["polygon-local"].simulates).toBe("Polygon Amoy");
    expect(NETWORKS["base-sepolia"].simulates).toBeUndefined();
    expect(NETWORKS["polygon-amoy"].simulates).toBeUndefined();
  });

  it("throws on unknown network ids", () => {
    expect(() => networkInfo("arbitrum-one")).toThrow(/Unknown network/);
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

  it("returns null for missing hashes or unknown networks (no throw in render paths)", () => {
    expect(explorerTxUrl("base-sepolia", null)).toBeNull();
    expect(explorerTxUrl("base-sepolia", undefined)).toBeNull();
    expect(explorerTxUrl("nonexistent", TX)).toBeNull();
  });
});
