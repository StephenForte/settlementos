// TokenizedMMF contract behavior, driven directly with viem against the base-local
// test node, plus the deployment wiring the treasury module reads (lib/chain).
//
// The behavior tests deploy a throwaway MMF so their index/share assertions cannot be
// disturbed by other suites; the wiring tests use the fixture's deployed fund and
// leave it at par with no shares outstanding.

import { describe, it, expect, beforeAll } from "vitest";
import type { Address, Abi } from "viem";
import {
  networkContracts,
  mmfAddress,
  publicClientFor,
  tokenBalance,
  MMF_ABI,
  MMF_INDEX_SCALE,
} from "@/lib/chain";
import { BASE_RPC, ACCOUNTS } from "../fixture";
import { clientsFor, artifact, MMF_YIELD_BUFFER } from "../helpers/deploy";

const SCALE = 10n ** 18n;
const PARK = 100_000n * 10n ** 6n; // 100,000 mockUSDC

let mmf: Address;
let usdc: Address;
let mmfAbi: Abi;
let erc20Abi: Abi;
let clients: ReturnType<typeof clientsFor>;

async function send(pk: `0x${string}`, address: Address, abi: Abi, functionName: string, args: unknown[]) {
  const wallet = clients.walletFor(pk);
  const hash = await wallet.writeContract({ address, abi, functionName, args });
  return clients.publicClient.waitForTransactionReceipt({ hash });
}

function read(address: Address, abi: Abi, functionName: string, args: unknown[] = []) {
  return clients.publicClient.readContract({ address, abi, functionName, args });
}

const usdcBalance = (owner: Address) => read(usdc, erc20Abi, "balanceOf", [owner]) as Promise<bigint>;
const sharesOf = (owner: Address) => read(mmf, mmfAbi, "sharesOf", [owner]) as Promise<bigint>;
const currentIndex = () => read(mmf, mmfAbi, "currentIndex") as Promise<bigint>;

beforeAll(async () => {
  clients = clientsFor(BASE_RPC, 31337);
  usdc = networkContracts("base-local").tokens.mockUSDC.address;
  erc20Abi = artifact("MockERC20").abi;

  const art = artifact("TokenizedMMF");
  mmfAbi = art.abi;
  const operator = clients.walletFor(ACCOUNTS.operator.privateKey);
  const hash = await operator.deployContract({ abi: art.abi, bytecode: art.bytecode, args: [usdc] });
  const receipt = await clients.publicClient.waitForTransactionReceipt({ hash });
  mmf = receipt.contractAddress as Address;

  // Treasury is the parking account: it must approve the fund to pull its asset.
  const MAX = 2n ** 256n - 1n;
  await send(ACCOUNTS.treasury.privateKey, usdc, erc20Abi, "approve", [mmf, MAX]);

  // Simulated yield is paid from a buffer, not conjured on accrual — fund it.
  // MockERC20.mint is permissionless by design (testnet faucet).
  await send(ACCOUNTS.operator.privateKey, usdc, erc20Abi, "mint", [mmf, 50_000n * 10n ** 6n]);
});

describe("TokenizedMMF", () => {
  it("starts at par with no shares outstanding", async () => {
    expect(await currentIndex()).toBe(SCALE);
    // Contract reads come back checksummed; deployments.json stores lowercase.
    expect(String(await read(mmf, mmfAbi, "asset")).toLowerCase()).toBe(usdc.toLowerCase());
  });

  it("round-trips subscribe → redeem at par with no value leaked", async () => {
    const treasuryBefore = await usdcBalance(ACCOUNTS.treasury.address);
    const sharesBefore = await sharesOf(ACCOUNTS.treasury.address);

    await send(ACCOUNTS.operator.privateKey, mmf, mmfAbi, "subscribe", [ACCOUNTS.treasury.address, PARK]);

    // At par the share unit and the asset base unit are 1:1.
    const minted = (await sharesOf(ACCOUNTS.treasury.address)) - sharesBefore;
    expect(minted).toBe(PARK);
    expect(await usdcBalance(ACCOUNTS.treasury.address)).toBe(treasuryBefore - PARK);

    await send(ACCOUNTS.operator.privateKey, mmf, mmfAbi, "redeem", [ACCOUNTS.treasury.address, minted]);

    expect(await usdcBalance(ACCOUNTS.treasury.address)).toBe(treasuryBefore); // principal whole
    expect(await sharesOf(ACCOUNTS.treasury.address)).toBe(sharesBefore);
  });

  it("redeem after accrual returns more asset than was parked", async () => {
    const treasuryBefore = await usdcBalance(ACCOUNTS.treasury.address);
    const sharesBefore = await sharesOf(ACCOUNTS.treasury.address);

    await send(ACCOUNTS.operator.privateKey, mmf, mmfAbi, "subscribe", [ACCOUNTS.treasury.address, PARK]);
    const minted = (await sharesOf(ACCOUNTS.treasury.address)) - sharesBefore;

    // +1% on the index: a parked 100,000 should redeem for 101,000.
    const nextIndex = ((await currentIndex()) * 101n) / 100n;
    await send(ACCOUNTS.operator.privateKey, mmf, mmfAbi, "accrue", [nextIndex]);
    expect(await currentIndex()).toBe(nextIndex);

    const valued = (await read(mmf, mmfAbi, "assetValueOf", [ACCOUNTS.treasury.address])) as bigint;
    await send(ACCOUNTS.operator.privateKey, mmf, mmfAbi, "redeem", [ACCOUNTS.treasury.address, minted]);

    const returned = (await usdcBalance(ACCOUNTS.treasury.address)) - (treasuryBefore - PARK);
    expect(returned).toBeGreaterThan(PARK);
    expect(returned).toBe((minted * nextIndex) / SCALE);
    expect(valued).toBeGreaterThanOrEqual(returned); // view agrees with what redeem paid
  });

  it("the index is monotonic — accruing downward reverts", async () => {
    const below = (await currentIndex()) - 1n;
    await expect(
      send(ACCOUNTS.operator.privateKey, mmf, mmfAbi, "accrue", [below])
    ).rejects.toThrow(/index must not decrease/);
  });

  it("rejects subscribe, redeem, and accrue from a non-operator", async () => {
    await expect(
      send(ACCOUNTS.acme.privateKey, mmf, mmfAbi, "subscribe", [ACCOUNTS.acme.address, PARK])
    ).rejects.toThrow(/not operator/);

    await expect(
      send(ACCOUNTS.acme.privateKey, mmf, mmfAbi, "redeem", [ACCOUNTS.treasury.address, 1n])
    ).rejects.toThrow(/not operator/);

    await expect(
      send(ACCOUNTS.acme.privateKey, mmf, mmfAbi, "accrue", [await currentIndex()])
    ).rejects.toThrow(/not operator/);
  });

  it("cannot redeem more shares than are held", async () => {
    const held = await sharesOf(ACCOUNTS.treasury.address);
    await expect(
      send(ACCOUNTS.operator.privateKey, mmf, mmfAbi, "redeem", [ACCOUNTS.treasury.address, held + 1n])
    ).rejects.toThrow(/insufficient shares/);
  });

  it("keeps parked funds segregated from the payment escrow", async () => {
    const settlement = networkContracts("base-local").PaymentSettlement;
    const escrowBefore = await usdcBalance(settlement);

    await send(ACCOUNTS.operator.privateKey, mmf, mmfAbi, "subscribe", [ACCOUNTS.treasury.address, PARK]);

    // Parked asset lands in the fund, and the escrow contract is untouched by it.
    const value = (await read(mmf, mmfAbi, "assetValueOf", [ACCOUNTS.treasury.address])) as bigint;
    expect(await usdcBalance(mmf)).toBeGreaterThanOrEqual(value);
    expect(await usdcBalance(settlement)).toBe(escrowBefore);

    await send(ACCOUNTS.operator.privateKey, mmf, mmfAbi, "redeem", [
      ACCOUNTS.treasury.address,
      await sharesOf(ACCOUNTS.treasury.address),
    ]);
    expect(await usdcBalance(settlement)).toBe(escrowBefore);
  });
});

// The fund the app actually talks to: deployed by the fixture (mirroring npm run setup)
// and resolved through lib/chain rather than a locally-held address.
describe("TokenizedMMF deployment wiring", () => {
  it("resolves a fund address on every local network, and undefined where none is deployed", () => {
    for (const networkId of ["base-local", "polygon-local"]) {
      expect(mmfAddress(networkId)).toMatch(/^0x[0-9a-fA-F]{40}$/);
      expect(mmfAddress(networkId)).toBe(networkContracts(networkId).TokenizedMMF);
    }
    // Real testnets have no fund deployed, and an unknown id is not an error either:
    // "no MMF here" is a normal state the treasury UI/API degrades to.
    expect(mmfAddress("base-sepolia")).toBeUndefined();
    expect(mmfAddress("not-a-network")).toBeUndefined();
  });

  it("is backed by the network's mockUSDC, at par, with a funded yield buffer", async () => {
    for (const networkId of ["base-local", "polygon-local"]) {
      const fund = mmfAddress(networkId)!;
      const usdcOnNet = networkContracts(networkId).tokens.mockUSDC.address;
      const client = publicClientFor(networkId);
      const call = (functionName: "asset" | "currentIndex" | "yieldBuffer") =>
        client.readContract({ address: fund, abi: MMF_ABI, functionName }) as Promise<unknown>;

      expect(String(await call("asset")).toLowerCase()).toBe(usdcOnNet.toLowerCase());
      expect(await call("currentIndex")).toBe(MMF_INDEX_SCALE);
      expect(await call("yieldBuffer")).toBe(MMF_YIELD_BUFFER);
      expect(await tokenBalance(networkId, usdcOnNet, fund)).toBe(MMF_YIELD_BUFFER);
    }
  });

  it("accepts a subscribe from the treasury — the fixture's approval is in place", async () => {
    const fund = mmfAddress("base-local")!;
    const usdcOnNet = networkContracts("base-local").tokens.mockUSDC.address;
    const treasuryBefore = await tokenBalance("base-local", usdcOnNet, ACCOUNTS.treasury.address);

    await send(ACCOUNTS.operator.privateKey, fund, MMF_ABI as unknown as Abi, "subscribe", [
      ACCOUNTS.treasury.address,
      PARK,
    ]);
    const shares = (await clients.publicClient.readContract({
      address: fund,
      abi: MMF_ABI,
      functionName: "sharesOf",
      args: [ACCOUNTS.treasury.address],
    })) as bigint;
    expect(shares).toBe(PARK); // at par, 1 share per asset base unit

    // Leave the shared fixture fund as we found it: par, no shares outstanding.
    await send(ACCOUNTS.operator.privateKey, fund, MMF_ABI as unknown as Abi, "redeem", [
      ACCOUNTS.treasury.address,
      shares,
    ]);
    expect(await tokenBalance("base-local", usdcOnNet, ACCOUNTS.treasury.address)).toBe(treasuryBefore);
  });
});
