// Exact per-payment allowances: an entity wallet grants the escrow only what the
// payment in flight needs, and the escrow consumes it back to zero. Asserted on
// chain (the token's own allowance mapping), not from audit rows.

import { describe, it, expect } from "vitest";
import type { Address } from "viem";
import { prisma } from "@/lib/db";
import { executePayment } from "@/lib/executor";
import {
  accountsFor,
  ensureSenderAllowance,
  networkContracts,
  tokenAllowance,
  ERC20_ABI,
  publicClientFor,
  walletFor,
} from "@/lib/chain";
import { signerFor } from "@/lib/signers";
import { toBaseUnits } from "@/lib/assets";
import { createApprovedPayment } from "../helpers/payments";

const NET = "base-local";
const AMOUNT = "1000.00";

const settlement = () => networkContracts(NET).PaymentSettlement;
const usdc = () => networkContracts(NET).tokens.mockUSDC.address;
const acme = () => accountsFor(NET).entityWallets.ent_acme_us;

const escrowAllowance = () => tokenAllowance(NET, usdc(), acme().address, settlement());

/** Set ACME's allowance directly, so a test starts from a known grant. */
async function setAllowance(amount: bigint) {
  const wallet = await walletFor(NET, signerFor(acme(), "acme test wallet"));
  const hash = await wallet.writeContract({
    address: usdc(),
    abi: ERC20_ABI,
    functionName: "approve",
    args: [settlement(), amount],
  });
  await publicClientFor(NET).waitForTransactionReceipt({ hash });
}

describe("exact per-payment allowances", () => {
  it("settles from a zero prior allowance and consumes the grant back to zero", async () => {
    await setAllowance(0n);
    expect(await escrowAllowance()).toBe(0n);

    const payment = await createApprovedPayment({ amount: AMOUNT });
    const settled = await executePayment(payment.id);
    expect(settled.status).toBe("SETTLED");

    // initiatePayment pulled exactly what was approved: nothing is left standing.
    expect(await escrowAllowance()).toBe(0n);

    const approval = await prisma.auditEvent.findFirst({
      where: { paymentId: payment.id, action: "payment.allowance_granted" },
    });
    expect(approval).not.toBeNull();
    expect(JSON.parse(approval!.detail)).toMatchObject({
      network: NET,
      asset: "mockUSDC",
      amount: AMOUNT,
      amountUnits: toBaseUnits(AMOUNT, 6).toString(),
      spender: settlement(),
    });
  });

  it("approves the payment's amount and no more", async () => {
    await setAllowance(0n);
    const amountUnits = toBaseUnits(AMOUNT, 6);

    const tx = await ensureSenderAllowance(NET, "ent_acme_us", "mockUSDC", amountUnits);

    expect(tx).not.toBeNull();
    expect(await escrowAllowance()).toBe(amountUnits);
    await setAllowance(0n);
  });

  it("short-circuits when the standing allowance already covers the amount", async () => {
    // A network deployed before this story: its wallets still hold MAX approvals.
    const MAX = 2n ** 256n - 1n;
    await setAllowance(MAX);

    const tx = await ensureSenderAllowance(NET, "ent_acme_us", "mockUSDC", toBaseUnits(AMOUNT, 6));

    expect(tx).toBeNull(); // no approval tx at all
    expect(await escrowAllowance()).toBe(MAX);

    // ...and the payment still settles against it (MockERC20 leaves MAX undecremented).
    const payment = await createApprovedPayment({ amount: AMOUNT });
    expect((await executePayment(payment.id)).status).toBe("SETTLED");
    expect(await escrowAllowance()).toBe(MAX);
    await setAllowance(0n);
  });

  it("tops an insufficient allowance up to exactly the amount, never adding to it", async () => {
    const amountUnits = toBaseUnits(AMOUNT, 6);
    await setAllowance(amountUnits - 1n); // one unit short — a real approve must run

    await ensureSenderAllowance(NET, "ent_acme_us", "mockUSDC", amountUnits);

    // approve() SETS the allowance, so the short grant is replaced, not summed.
    expect(await escrowAllowance()).toBe(amountUnits);
    await setAllowance(0n);
  });

  it("rejects a sender with no configured wallet on the network", async () => {
    await expect(
      ensureSenderAllowance(NET, "ent_nobody", "mockUSDC", 1n)
    ).rejects.toThrow(/No wallet configured/);
  });
});

describe("allowance is scoped to one payment", () => {
  it("leaves no allowance a second payment could ride on", async () => {
    await setAllowance(0n);

    const first = await createApprovedPayment({ amount: AMOUNT });
    await executePayment(first.id);
    expect(await escrowAllowance()).toBe(0n);

    // The second payment must grant its own — the first's is spent, and this is
    // the point of the story: a wallet is never left drainable between payments.
    const second = await createApprovedPayment({ amount: AMOUNT });
    const settled = await executePayment(second.id);
    expect(settled.status).toBe("SETTLED");

    const grants = await prisma.auditEvent.count({
      where: { paymentId: second.id, action: "payment.allowance_granted" },
    });
    expect(grants).toBe(1);
    expect(await escrowAllowance()).toBe(0n);
  });
});

// The escrow's spender address is the settlement contract, and nothing else may
// pull the sender's tokens: an allowance to any other address stays zero.
describe("allowance blast radius", () => {
  it("grants nothing to the treasury or the MMF", async () => {
    await setAllowance(0n);
    const payment = await createApprovedPayment({ amount: AMOUNT });
    await executePayment(payment.id);

    const others: Address[] = [accountsFor(NET).treasury.address];
    const mmf = networkContracts(NET).TokenizedMMF;
    if (mmf) others.push(mmf);

    for (const spender of others) {
      expect(await tokenAllowance(NET, usdc(), acme().address, spender)).toBe(0n);
    }
  });
});
