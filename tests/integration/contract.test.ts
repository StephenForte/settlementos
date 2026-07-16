// PaymentSettlement contract behavior, driven directly with viem against the
// base-local test node. Covers the escrow invariants the app relies on.

import { describe, it, expect, beforeAll } from "vitest";
import { keccak256, toHex, type Address, type Abi } from "viem";
import { networkContracts } from "@/lib/chain";
import { BASE_RPC, ACCOUNTS } from "../fixture";
import { clientsFor, artifact } from "../helpers/deploy";

const AMOUNT = 1_000n * 10n ** 6n; // 1,000 mockUSDC

let settlement: Address;
let usdc: Address;
let settlementAbi: Abi;
let erc20Abi: Abi;
let clients: ReturnType<typeof clientsFor>;

function pid(label: string) {
  return keccak256(toHex(`contract-test-${label}-${Date.now()}`));
}

/** Exactly what the executor does before escrowing: the sender approves this
 *  payment's amount and no more. No wallet holds a standing allowance. */
async function approveAmount(amount: bigint = AMOUNT) {
  const acme = clients.walletFor(ACCOUNTS.acme.privateKey);
  const hash = await acme.writeContract({
    address: usdc,
    abi: erc20Abi,
    functionName: "approve",
    args: [settlement, amount],
  });
  await clients.publicClient.waitForTransactionReceipt({ hash });
}

async function initiate(paymentId: `0x${string}`, from: `0x${string}` = ACCOUNTS.operator.privateKey) {
  await approveAmount();
  const wallet = clients.walletFor(from);
  const hash = await wallet.writeContract({
    address: settlement,
    abi: settlementAbi,
    functionName: "initiatePayment",
    args: [paymentId, ACCOUNTS.acme.address, ACCOUNTS.tokyo.address, usdc, AMOUNT, "USD", "JPY"],
  });
  return clients.publicClient.waitForTransactionReceipt({ hash });
}

async function balanceOf(owner: Address): Promise<bigint> {
  return (await clients.publicClient.readContract({
    address: usdc,
    abi: erc20Abi,
    functionName: "balanceOf",
    args: [owner],
  })) as bigint;
}

beforeAll(() => {
  const contracts = networkContracts("base-local");
  settlement = contracts.PaymentSettlement;
  usdc = contracts.tokens.mockUSDC.address;
  settlementAbi = artifact("PaymentSettlement").abi;
  erc20Abi = artifact("MockERC20").abi;
  clients = clientsFor(BASE_RPC, 31337);
});

describe("PaymentSettlement escrow", () => {
  it("rejects initiation from a non-operator", async () => {
    await expect(initiate(pid("nonop"), ACCOUNTS.acme.privateKey)).rejects.toThrow(/not operator/);
  });

  it("rejects unapproved assets", async () => {
    const rogueToken = await (async () => {
      const art = artifact("MockERC20");
      const wallet = clients.walletFor(ACCOUNTS.operator.privateKey);
      const hash = await wallet.deployContract({ abi: art.abi, bytecode: art.bytecode, args: ["Rogue", "RGE", 6] });
      const receipt = await clients.publicClient.waitForTransactionReceipt({ hash });
      return receipt.contractAddress as Address;
    })();

    const wallet = clients.walletFor(ACCOUNTS.operator.privateKey);
    await expect(
      wallet.writeContract({
        address: settlement,
        abi: settlementAbi,
        functionName: "initiatePayment",
        args: [pid("rogue"), ACCOUNTS.acme.address, ACCOUNTS.tokyo.address, rogueToken, AMOUNT, "USD", "JPY"],
      })
    ).rejects.toThrow(/asset not approved/);
  });

  // The point of the exact allowance: the escrow's reach into a sender's wallet
  // is capped at what that one payment approved, whatever the wallet holds.
  it("cannot escrow more than the sender approved", async () => {
    await approveAmount(AMOUNT - 1n);
    const operator = clients.walletFor(ACCOUNTS.operator.privateKey);
    await expect(
      operator.writeContract({
        address: settlement,
        abi: settlementAbi,
        functionName: "initiatePayment",
        args: [pid("overpull"), ACCOUNTS.acme.address, ACCOUNTS.tokyo.address, usdc, AMOUNT, "USD", "JPY"],
      })
    ).rejects.toThrow(/insufficient allowance/);
  });

  it("payment IDs are idempotent — double initiation reverts", async () => {
    const id = pid("double");
    await initiate(id);
    await expect(initiate(id)).rejects.toThrow(/payment exists/);
  });

  it("escrows on initiate and releases to the target on settle", async () => {
    const id = pid("settle");
    const senderBefore = await balanceOf(ACCOUNTS.acme.address);
    const escrowBefore = await balanceOf(settlement);
    const treasuryBefore = await balanceOf(ACCOUNTS.treasury.address);

    await initiate(id);
    expect((await balanceOf(ACCOUNTS.acme.address)) - senderBefore).toBe(-AMOUNT);
    expect((await balanceOf(settlement)) - escrowBefore).toBe(AMOUNT);

    const operator = clients.walletFor(ACCOUNTS.operator.privateKey);
    const hash = await operator.writeContract({
      address: settlement,
      abi: settlementAbi,
      functionName: "settlePayment",
      args: [id, keccak256(toHex("route")), ACCOUNTS.treasury.address, 157_000n, "mockJPY"],
    });
    await clients.publicClient.waitForTransactionReceipt({ hash });

    expect((await balanceOf(ACCOUNTS.treasury.address)) - treasuryBefore).toBe(AMOUNT);
    expect(await balanceOf(settlement)).toBe(escrowBefore); // escrow fully drained

    // Settling twice must revert — funds can only be released once.
    await expect(
      operator.writeContract({
        address: settlement,
        abi: settlementAbi,
        functionName: "settlePayment",
        args: [id, keccak256(toHex("route")), ACCOUNTS.treasury.address, 157_000n, "mockJPY"],
      })
    ).rejects.toThrow(/not initiated/);
  });

  it("failAndRefund returns escrowed funds to the sender in full", async () => {
    const id = pid("refund");
    const senderBefore = await balanceOf(ACCOUNTS.acme.address);

    await initiate(id);
    expect(await balanceOf(ACCOUNTS.acme.address)).toBe(senderBefore - AMOUNT);

    const operator = clients.walletFor(ACCOUNTS.operator.privateKey);
    const hash = await operator.writeContract({
      address: settlement,
      abi: settlementAbi,
      functionName: "failAndRefund",
      args: [id, "test-induced failure"],
    });
    await clients.publicClient.waitForTransactionReceipt({ hash });

    expect(await balanceOf(ACCOUNTS.acme.address)).toBe(senderBefore); // made whole
  });

  it("cancelPayment refunds the sender before settlement", async () => {
    const id = pid("cancel");
    const senderBefore = await balanceOf(ACCOUNTS.acme.address);
    await initiate(id);

    const operator = clients.walletFor(ACCOUNTS.operator.privateKey);
    const hash = await operator.writeContract({
      address: settlement,
      abi: settlementAbi,
      functionName: "cancelPayment",
      args: [id],
    });
    await clients.publicClient.waitForTransactionReceipt({ hash });

    expect(await balanceOf(ACCOUNTS.acme.address)).toBe(senderBefore);
  });
});
