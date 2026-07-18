import { describe, it, expect } from "vitest";
import { walletOnNetwork } from "@/lib/wallets";

describe("walletOnNetwork", () => {
  const wallets = [
    { network: "base-local", address: "0xbase" },
    { network: "polygon-local", address: "0xpoly" },
  ];

  it("prefers the wallet on the requested network", () => {
    expect(walletOnNetwork(wallets, "polygon-local")?.address).toBe("0xpoly");
  });

  it("falls back to the first wallet when the network is missing", () => {
    expect(walletOnNetwork(wallets, "base-sepolia")?.address).toBe("0xbase");
  });

  it("returns undefined for an empty wallet list", () => {
    expect(walletOnNetwork([], "base-local")).toBeUndefined();
  });
});
