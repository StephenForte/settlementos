// Payment execution orchestrator. Drives an APPROVED payment through:
// liquidity reservation → on-chain escrow (source network) → confirmation →
// FX/settlement → payout → SETTLED, with audit events at every step and
// refund-on-failure semantics.
//
// Cross-network routes add a simulated bridge leg: after source-chain
// settlement, the treasury pays out destination-asset tokens to the
// recipient's wallet ON the destination network (a real ERC-20 transfer on
// chain 2), giving the payment transaction hashes on both networks.

import "server-only";
import { randomUUID } from "node:crypto";
import type { Payment, Prisma } from "@prisma/client";
import { prisma } from "./db";
import { audit } from "./audit";
import { ApiError } from "./api-errors";
import { type PaymentStatus } from "./state";
import { transitionStatus } from "./transitions";
import { assetForCurrency, toBaseUnits } from "./assets";
import {
  accountsFor,
  ensureSenderAllowance,
  loadDeployments,
  onchainPaymentId,
  onchainPaymentState,
  operatorWrite,
  treasuryTokenTransfer,
  transactionOutcome,
  type OnchainPaymentState,
  type TransactionOutcome,
} from "./chain";
import { availableLiquidity, destinationUnits, type RouteOption } from "./routing";
import { recallForPayment, TreasuryError } from "./treasury";
import { walletOnNetwork } from "./wallets";
import { keccak256, toHex, type Address, type Hex } from "viem";

/**
 * Someone else is already executing this payment (or it left APPROVED before we
 * claimed it). A 409 via `caughtErrorResponse`, same as StaleTransitionError:
 * expected under concurrency, not a bug. The message names no internals and does
 * not distinguish the two causes.
 */
export class ExecutionLeaseError extends ApiError {
  constructor(readonly paymentId: string) {
    super("conflict", "payment is already being executed");
    this.name = "ExecutionLeaseError";
  }
}

type PaymentWithParties = Prisma.PaymentGetPayload<{
  include: { sender: { include: { wallets: true } }; recipient: { include: { wallets: true } } };
}>;

/** The test-only injection points (see `executorTestHooks` below for the contract). */
interface ExecutorTestHooks {
  /** Throws with the escrow held but not yet released — the refund path. */
  beforeSettlement?: () => void | Promise<void>;
  /** Throws in the payout leg, with the source chain already settled — the compensation path. */
  beforeDestinationPayout?: () => void | Promise<void>;
  /**
   * Throws after the destination payout tx is submitted and its hash persisted,
   * but before the receipt is awaited — the receipt-loss window where the
   * recipient may already hold tokens while the DB has no confirmation yet.
   */
  afterDestinationPayoutSubmitted?: () => void | Promise<void>;
  /**
   * Throws after the payout hash is known in memory but before the DB persist
   * of destinationTxHash — proves catch can still reconcile when the write fails.
   */
  beforeDestinationTxHashPersist?: () => void | Promise<void>;
  /**
   * Throws *after* the destination payout has already landed (recipient paid,
   * destinationTxHash written and receipt confirmed) but before the settlement
   * is recorded — the path that must complete forward, never compensate, or the
   * recipient keeps the payout while the treasury also refunds the sender.
   */
  afterDestinationPayout?: () => void | Promise<void>;
  /**
   * Throws *after* the ledger credit has been written (recipient paid on the
   * simulated fiat rail) but before the reservation is consumed / SETTLED — the
   * same-chain twin of afterDestinationPayout. Cross-chain routes usually set
   * destinationTxHash earlier; same-chain has only the ledger credit as proof
   * the recipient was paid, so this is the window that must complete forward.
   */
  afterLedgerCredit?: () => void | Promise<void>;
  /** Throws in the on-chain refund, stranding a held escrow at FAILED. */
  beforeRefund?: () => void | Promise<void>;
  /**
   * Throws inside the compensation transfer itself, stranding the payment in
   * COMPENSATION_PENDING — the state an operator repair exists to fix. Runs on the
   * repair's transfer too, so a test must clear it before repairing.
   */
  beforeCompensationTransfer?: () => void | Promise<void>;
  /**
   * Throws after the compensation transfer is submitted and its attempt hash
   * persisted, but before the receipt is awaited — the receipt-loss window where
   * the sender may already hold the make-good while the DB has no confirmation.
   */
  afterCompensationSubmitted?: () => void | Promise<void>;
  /**
   * Throws after the compensation hash is known in memory but before the DB
   * persist of compensationTxHash — proves recovery can still reconcile when
   * the write fails (T5-3 mirror on the compensation leg).
   */
  beforeCompensationTxHashPersist?: () => void | Promise<void>;
  /**
   * Force every escrow reconciliation read to come back null, as an RPC flap
   * would: the executor's catch path, stuckPayments(), and repairCompensation().
   * The catch path needs it for "settlement provably happened per the DB, but
   * the chain read failed"; the stuck/repair paths need it so a flaky RPC cannot
   * hide a stranded payment or authorize a treasury transfer on an unconfirmed
   * escrow.
   */
  escrowReadFails?: boolean;
  /**
   * Force destination payout reconciliation to a fixed outcome instead of reading
   * the chain — simulates an unreadable destination RPC or a reverted attempt.
   */
  destinationPayoutOutcome?: TransactionOutcome;
  /**
   * Force compensation-transfer reconciliation to a fixed outcome instead of
   * reading the source chain — simulates an unreadable RPC or a reverted attempt.
   */
  compensationPayoutOutcome?: TransactionOutcome;
}

/**
 * Test-only injection points. The compensation saga only runs when the
 * destination leg fails *after* the source escrow was already released, which no
 * real input can provoke on a healthy fixture chain — so tests reach in here.
 *
 * Fail closed: these hooks divert real refund/repair/stuck money movement, so a
 * write from anywhere but the test runner (a stray import, a leftover assignment
 * in a long-lived process) must be impossible, not merely discouraged. The set
 * trap admits writes only under Vitest (which sets `process.env.VITEST`); a
 * production assignment throws instead of silently arming a hook. Reads are
 * untouched — outside a test every key is undefined and every `?.()` is a no-op.
 */
export const executorTestHooks: ExecutorTestHooks = new Proxy({} as ExecutorTestHooks, {
  set(target, key, value) {
    if (!process.env.VITEST) {
      throw new Error(
        `executorTestHooks are test-only and cannot be armed outside the test runner (attempted to set "${String(key)}")`
      );
    }
    return Reflect.set(target, key, value);
  },
});

// Every status change the executor makes is a compare-and-swap against the
// status it last observed, so a concurrent writer can never be overwritten:
// a lost race throws StaleTransitionError out of executePayment rather than
// corrupting the lifecycle. Keep the `payment = { ...payment, ...(await
// setStatus(...)) }` assignments — the local row *is* the CAS's expected value.
async function setStatus(
  payment: Payment,
  to: PaymentStatus,
  dbData: Partial<Payment> = {},
  auditDetail: Record<string, unknown> = {}
) {
  return transitionStatus(payment, to, { data: dbData, detail: auditDetail });
}

/** An entity's wallet on `networkId` — addresses differ per network. */
function walletOn(wallets: { network: string; address: string }[], networkId: string) {
  return walletOnNetwork(wallets, networkId)!;
}

async function resolveDestinationPayoutOutcome(
  networkId: string,
  txHash: Hex
): Promise<TransactionOutcome> {
  if (executorTestHooks.destinationPayoutOutcome !== undefined) {
    return executorTestHooks.destinationPayoutOutcome;
  }
  return transactionOutcome(networkId, txHash);
}

async function resolveCompensationOutcome(
  networkId: string,
  txHash: Hex
): Promise<TransactionOutcome> {
  if (executorTestHooks.compensationPayoutOutcome !== undefined) {
    return executorTestHooks.compensationPayoutOutcome;
  }
  return transactionOutcome(networkId, txHash);
}

/**
 * Read the destination chain for a persisted payout hash before deciding whether
 * the recipient was paid. Unknown means leave the payment non-terminal — never
 * auto-compensate and never auto-complete on unreadable evidence.
 */
async function reconcileDestinationPayout(
  payment: Payment,
  destNet: string,
  destAmount: string,
  reason: string
): Promise<Payment | null> {
  if (!payment.destinationTxHash) return null;

  const outcome = await resolveDestinationPayoutOutcome(
    destNet,
    payment.destinationTxHash as Hex
  );
  if (outcome === "confirmed") {
    return completeSettledPayout(payment, destAmount, reason, {
      evidence: "destination_tx_hash",
    });
  }
  if (outcome === "unknown") {
    await audit(
      "payment.destination_payout_unresolved",
      {
        network: destNet,
        txHash: payment.destinationTxHash,
        note: "destination receipt unreadable — operator action required",
      },
      payment.id
    );
    return payment;
  }
  // absent or reverted — fall through to source-side reconciliation.
  return null;
}

function selectedRoute(payment: Payment): RouteOption {
  if (!payment.quoteJson) throw new Error("Payment has no quote");
  const routes = JSON.parse(payment.quoteJson) as RouteOption[];
  const route = routes.find((r) => r.route_id === payment.selectedRouteId) ?? routes[0];
  if (!route) throw new Error("No route available on quote");
  return route;
}

/**
 * Execute an APPROVED payment end-to-end. Runs synchronously — the local
 * chains confirm in milliseconds. On on-chain failure after escrow, funds are
 * refunded on the source network.
 *
 * At most one attempt runs per payment: the execution lease is claimed here,
 * before anything reads a chain or moves a token, so a second concurrent execute
 * throws ExecutionLeaseError (→ 409) having touched no chain state at all.
 */
/**
 * Claim the payment's single execution lease at `fromStatus`, run `fn` under it,
 * and release the lease on the way out. Both money-moving entry points — a fresh
 * execute and an operator repair — go through here so the claim/release
 * choreography lives once, not in two copies that could drift.
 *
 * The claim, not any status check the caller did first, is what decides the race:
 * the CAS on (id, status = fromStatus, executionLeaseId: null) admits exactly one
 * winner; everyone else matches zero rows and throws ExecutionLeaseError having
 * touched no chain state. The finally is the backstop for throws that never reach
 * a lease-releasing transition (an unquoted payment, a wallet lookup that fails,
 * an RPC down mid-setup) — transitionStatus already frees the lease at
 * LEASE_RELEASE_STATES, so on the happy path it matches zero rows. Scoped to our
 * own leaseId so it can never free a later attempt's.
 */
async function withExecutionLease<T>(
  paymentId: string,
  fromStatus: PaymentStatus,
  fn: (leaseId: string) => Promise<T>
): Promise<T> {
  const leaseId = randomUUID();
  const { count } = await prisma.payment.updateMany({
    where: { id: paymentId, status: fromStatus, executionLeaseId: null },
    data: { executionLeaseId: leaseId, leasedAt: new Date() },
  });
  if (count === 0) throw new ExecutionLeaseError(paymentId);

  try {
    return await fn(leaseId);
  } finally {
    await prisma.payment
      .updateMany({
        where: { id: paymentId, executionLeaseId: leaseId },
        data: { executionLeaseId: null, leasedAt: null },
      })
      .catch(() => {});
  }
}

export async function executePayment(paymentId: string): Promise<Payment> {
  const payment = await prisma.payment.findUniqueOrThrow({
    where: { id: paymentId },
    include: { sender: { include: { wallets: true } }, recipient: { include: { wallets: true } } },
  });

  if (payment.status !== "APPROVED") {
    throw new Error(`Payment must be APPROVED to execute (current: ${payment.status})`);
  }

  return withExecutionLease(paymentId, "APPROVED", (leaseId) =>
    runExecution({ ...payment, executionLeaseId: leaseId }, leaseId)
  );
}

async function runExecution(claimed: PaymentWithParties, leaseId: string): Promise<Payment> {
  let payment = claimed;
  const route = selectedRoute(payment);
  const sourceNet = route.source_network;
  const destNet = route.destination_network;
  const isCrossChain = sourceNet !== destNet;

  const dep = loadDeployments();
  const sourceAsset = assetForCurrency(payment.sourceCurrency);
  const destAsset = assetForCurrency(payment.destinationCurrency);
  const sourceToken = dep.networks[sourceNet].contracts.tokens[sourceAsset.symbol];
  const destAmount = route.estimated_destination_amount;

  const senderWallet = walletOn(payment.sender.wallets, sourceNet);
  const recipientWallet = walletOn(payment.recipient.wallets, destNet);
  if (!senderWallet || !recipientWallet) throw new Error("Sender and recipient must have registered wallets");

  // The route decides the actual destination network (fallback routes settle on source).
  if (payment.destinationNetwork !== destNet) {
    payment = {
      ...payment,
      ...(await prisma.payment.update({
        where: { id: payment.id },
        data: { destinationNetwork: destNet },
      })),
    };
  }

  // 0. Auto-recall: when free destination liquidity is short at *execute*
  //    time, redeem parked MMF positions T+0 before reserving. The quote's
  //    recall_required flag is a snapshot (RPC degrade freezes it false) —
  //    gate on the measured free balance, not the flag (AGENTS.md).
  //    recallForPayment is already a no-op when free covers; we still skip
  //    the call when free is enough so a healthy balance never touches the fund.
  {
    const liqBefore = await availableLiquidity(destAsset.symbol, destNet);
    const neededUnits = destinationUnits(destAmount, liqBefore.decimals);
    if (liqBefore.availableUnits < neededUnits) {
      try {
        // Emits a TREASURY_RECALLED per position plus one payment-linked
        // TREASURY_AUTO_RECALLED summarizing the redemption.
        await recallForPayment({
          networkId: destNet,
          asset: destAsset.symbol,
          amount: destAmount,
          paymentId: payment.id,
        });
      } catch (err) {
        // Nothing parked (or not enough) is not a step-0 failure — step 1
        // owns the insufficient-liquidity verdict. Other recall errors
        // (chain reverts mid-redeem) still fail the payment here with
        // nothing reserved or escrowed.
        if (!(err instanceof TreasuryError && err.code === "INSUFFICIENT_FREE_BALANCE")) {
          const failureReason = `Auto-recall of parked ${destAsset.symbol} on ${destNet} failed: ${
            err instanceof Error ? err.message : String(err)
          }`;
          await prisma.liquidityReservation
            .update({ where: { paymentId: payment.id }, data: { status: "RELEASED" } })
            .catch(() => {});
          await setStatus(payment, "FAILED", { failureReason });
          throw new Error(failureReason);
        }
      }
    }
  }

  // 1. Reserve destination-side liquidity on the destination network.
  const liq = await availableLiquidity(destAsset.symbol, destNet);
  // Both sides in the destination token's base units — the same unit
  // treasury.freeTreasuryBalance guards parking with, so a payment and a park
  // can never both be told the same liquidity is theirs.
  if (liq.availableUnits < destinationUnits(destAmount, liq.decimals)) {
    const failureReason = `Insufficient ${destAsset.symbol} liquidity on ${destNet}: need ${destAmount}, available ${liq.available}`;
    await setStatus(payment, "FAILED", { failureReason });
    throw new Error(failureReason);
  }
  // Lease and reservation are written together: re-asserting the lease inside the
  // same transaction is what makes a reservation impossible without it. The claim
  // is re-checked rather than assumed — between the claim and here the payment ran
  // an auto-recall and a chain read, and a reservation held by an attempt that no
  // longer owns the payment would silently withhold liquidity from everyone else.
  await prisma.$transaction(async (tx) => {
    const { count } = await tx.payment.updateMany({
      where: { id: payment.id, status: "APPROVED", executionLeaseId: leaseId },
      data: { leasedAt: new Date() },
    });
    if (count === 0) throw new ExecutionLeaseError(payment.id);
    await tx.liquidityReservation.upsert({
      where: { paymentId: payment.id },
      create: {
        paymentId: payment.id,
        asset: destAsset.symbol,
        network: destNet,
        amount: destAmount,
      },
      update: { asset: destAsset.symbol, network: destNet, amount: destAmount, status: "RESERVED" },
    });
  });
  payment = {
    ...payment,
    ...(await setStatus(payment, "LIQUIDITY_RESERVED", {}, {
      reservedAmount: destAmount,
      asset: destAsset.symbol,
      network: destNet,
    })),
  };

  const pid = onchainPaymentId(payment.id);
  const routeIdHash = keccak256(toHex(route.route_id));
  // Hoisted out of the try: the compensation path pays this exact amount back.
  const amountUnits = toBaseUnits(payment.amount, sourceToken.decimals);

  try {
    // 2. Allowance, then escrow. The sender approves this payment's amount and
    //    nothing more, so the escrow consumes the allowance back to zero — it
    //    holds no standing claim on the wallet between payments. Nothing is
    //    escrowed yet, so a failure here just fails the payment.
    const approvalTx = await ensureSenderAllowance(
      sourceNet,
      payment.sender.externalId,
      sourceAsset.symbol,
      amountUnits
    );
    if (approvalTx) {
      await audit(
        "payment.allowance_granted",
        {
          network: sourceNet,
          asset: sourceAsset.symbol,
          amount: payment.amount,
          amountUnits: amountUnits.toString(), // never a bigint — audit() JSON-stringifies
          spender: dep.networks[sourceNet].contracts.PaymentSettlement,
          txHash: approvalTx.hash,
        },
        payment.id
      );
    }

    const initTx = await operatorWrite(sourceNet, "initiatePayment", [
      pid,
      senderWallet.address,
      recipientWallet.address,
      sourceToken.address,
      amountUnits,
      payment.sourceCurrency,
      payment.destinationCurrency,
    ]);
    payment = {
      ...payment,
      ...(await setStatus(payment, "SUBMITTED_ONCHAIN", {
        txHash: initTx.hash,
        onchainPaymentId: pid,
      }, { network: sourceNet })),
    };

    // 3. Confirmation (receipt already awaited by operatorWrite).
    payment = {
      ...payment,
      ...(await setStatus(payment, "CONFIRMED_ONCHAIN", {}, {
        network: sourceNet,
        blockNumber: initTx.blockNumber.toString(),
        gasUsed: initTx.gasUsed.toString(),
      })),
    };

    // 4. FX conversion + source-chain settlement: release escrow to the treasury,
    //    recording the destination leg on the settlement contract.
    await executorTestHooks.beforeSettlement?.();
    const destTokenOnDest = dep.networks[destNet].contracts.tokens[destAsset.symbol];
    const settledUnits = toBaseUnits(destAmount, destTokenOnDest.decimals);
    const settleTx = await operatorWrite(sourceNet, "settlePayment", [
      pid,
      routeIdHash,
      accountsFor(sourceNet).treasury.address,
      settledUnits,
      destAsset.symbol,
    ]);
    payment = {
      ...payment,
      ...(await setStatus(payment, "FX_OR_SWAP_COMPLETED", {
        settleTxHash: settleTx.hash,
        fxRate: route.estimated_fx_rate,
        destinationAmount: destAmount,
      }, { network: sourceNet })),
    };

    // 5. Payout leg. Everything past this point runs with the source escrow
    //    already released, so a failure here compensates rather than refunds.
    payment = { ...payment, ...(await setStatus(payment, "PAYOUT_PENDING")) };
    await executorTestHooks.beforeDestinationPayout?.();

    if (isCrossChain) {
      // Simulated bridge: treasury releases destination-asset tokens to the
      // recipient's wallet on the destination network. Persist the attempt hash
      // before awaiting the receipt so a post-mine RPC drop can be reconciled.
      const bridgeTx = await treasuryTokenTransfer(
        destNet,
        destAsset.symbol,
        recipientWallet.address as Address,
        settledUnits
      );
      // Remember the attempt on the in-memory row *before* any further I/O so a
      // failed DB persist still lets the catch path reconcile (T5-3). Without
      // this, catch sees a null hash and compensates while the dest tx may mine.
      payment = { ...payment, destinationTxHash: bridgeTx.hash };
      await executorTestHooks.beforeDestinationTxHashPersist?.();
      payment = {
        ...payment,
        ...(await prisma.payment.update({
          where: { id: payment.id },
          data: { destinationTxHash: bridgeTx.hash },
        })),
      };
      await audit(
        "bridge.destination_payout_submitted",
        {
          network: destNet,
          asset: destAsset.symbol,
          amount: destAmount,
          to: recipientWallet.address,
          txHash: bridgeTx.hash,
        },
        payment.id
      );
      await executorTestHooks.afterDestinationPayoutSubmitted?.();
      await bridgeTx.confirm();
      await audit(
        "bridge.destination_payout",
        {
          network: destNet,
          asset: destAsset.symbol,
          amount: destAmount,
          to: recipientWallet.address,
          txHash: bridgeTx.hash,
        },
        payment.id
      );
    }

    await executorTestHooks.afterDestinationPayout?.();

    // Simulated fiat rail: credit the recipient's local-currency ledger.
    await prisma.ledgerCredit.create({
      data: {
        paymentId: payment.id,
        entityId: payment.recipientId,
        currency: payment.destinationCurrency,
        amount: destAmount,
      },
    });
    await audit(
      "payout.ledger_credit",
      { entityId: payment.recipientId, currency: payment.destinationCurrency, amount: destAmount },
      payment.id
    );
    await executorTestHooks.afterLedgerCredit?.();

    // 6. Consume the reservation and settle.
    await prisma.liquidityReservation.update({
      where: { paymentId: payment.id },
      data: { status: "CONSUMED" },
    });
    payment = { ...payment, ...(await setStatus(payment, "SETTLED")) };
    return payment;
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);

    // The recipient was already paid — simulated fiat ledger credit. Undoing now
    // would pay twice: treasury refunds the sender while the recipient keeps the
    // credit. Same-chain routes never set destinationTxHash — the ledger credit
    // alone is the proof the recipient was paid.
    const ledgerCredit = await prisma.ledgerCredit.findFirst({
      where: { paymentId: payment.id },
      select: { id: true },
    });
    if (ledgerCredit) {
      return await completeSettledPayout(payment, destAmount, reason, {
        evidence: "ledger_credit",
      });
    }

    // Cross-chain: a persisted hash is evidence of an ATTEMPT, not payment.
    // Reconcile the destination receipt before completing forward or compensating.
    const destReconciled = await reconcileDestinationPayout(payment, destNet, destAmount, reason);
    if (destReconciled) {
      if (destReconciled.status === "SETTLED") return destReconciled;
      // Unknown outcome — stay PAYOUT_PENDING; reservation stays RESERVED.
      return destReconciled;
    }

    await prisma.liquidityReservation
      .update({ where: { paymentId: payment.id }, data: { status: "RELEASED" } })
      .catch(() => {});

    // Reconcile before deciding what to undo: the DB records what this attempt
    // *tried*, the escrow records what actually landed, and they disagree exactly
    // when a step threw mid-flight. Refunding an already-released escrow reverts
    // ("not initiated"); marking a released one FAILED strands the sender's money.
    // A read that itself fails (RPC down) falls back to the DB's view.
    const escrow = executorTestHooks.escrowReadFails
      ? null
      : await onchainPaymentState(sourceNet, pid).catch(() => null);

    // Escrow already released to the treasury: nothing to refund, so make the
    // sender whole out of treasury instead. When the read fails, a post-settlement
    // status is decisive on its own — settlePayment lands before those transitions,
    // so reaching FX_OR_SWAP_COMPLETED/PAYOUT_PENDING proves the escrow released.
    // Without this, an unreadable escrow at those statuses fell through to FAILED,
    // from which compensation is unreachable and the sender's money is stranded.
    const settledOnChain =
      escrow === "SETTLED" ||
      (escrow === null && ["FX_OR_SWAP_COMPLETED", "PAYOUT_PENDING"].includes(payment.status));
    if (settledOnChain) {
      return await compensateSender(payment, { ...compensationContextFor(payment), reason });
    }

    // Funds still escrowed on the source network: refund on-chain.
    const escrowHeld =
      escrow === "INITIATED" ||
      (escrow === null && ["SUBMITTED_ONCHAIN", "CONFIRMED_ONCHAIN"].includes(payment.status));
    if (escrowHeld) {
      try {
        await executorTestHooks.beforeRefund?.();
        await operatorWrite(sourceNet, "failAndRefund", [pid, reason.slice(0, 200)]);
        await audit("payment.onchain_refund", { network: sourceNet, reason }, payment.id);
        payment = { ...payment, ...(await setStatus(payment, "FAILED", { failureReason: reason })) };
        return await setStatus(payment, "REFUNDED");
      } catch (refundErr) {
        await audit(
          "payment.refund_failed",
          { reason: refundErr instanceof Error ? refundErr.message : String(refundErr) },
          payment.id
        );
      }
    }
    // The refund leg may have landed FAILED before it threw; FAILED → FAILED is
    // not a legal move, and the payment is already where this path wants it.
    if (payment.status === "FAILED") return payment;
    return await setStatus(payment, "FAILED", { failureReason: reason });
  }
}

/**
 * Finish a payment whose recipient was already paid (destinationTxHash and/or a
 * ledger credit) but whose post-payout bookkeeping threw. Compensation is off the
 * table — the money reached the recipient, and refunding the sender too would
 * pay twice out of treasury — so the remaining steps run forward, idempotently:
 * create the ledger credit if it did not land, consume the reservation, mark
 * SETTLED. If a step throws again the payment stays PAYOUT_PENDING (visible to
 * the repair view), never compensated.
 */
async function completeSettledPayout(
  payment: Payment,
  destAmount: string,
  reason: string,
  { evidence }: { evidence: "destination_tx_hash" | "ledger_credit" }
): Promise<Payment> {
  const existing = await prisma.ledgerCredit.findFirst({ where: { paymentId: payment.id } });
  if (!existing) {
    await prisma.ledgerCredit.create({
      data: {
        paymentId: payment.id,
        entityId: payment.recipientId,
        currency: payment.destinationCurrency,
        amount: destAmount,
      },
    });
    await audit(
      "payout.ledger_credit",
      { entityId: payment.recipientId, currency: payment.destinationCurrency, amount: destAmount },
      payment.id
    );
  }
  await prisma.liquidityReservation
    .update({ where: { paymentId: payment.id }, data: { status: "CONSUMED" } })
    .catch(() => {});
  await audit(
    "payment.settlement_recovered",
    {
      note: "recipient already paid; completed forward",
      // Which catch branch fired and the signal it fired on — greppable
      // recovery telemetry, so a post-incident read never has to re-derive
      // why a payment settled forward instead of compensating.
      branch: "forward_complete",
      evidence,
      // The hash the recovery was decided on. When the payout persist is what
      // failed, this event is the FIRST durable record of the destination tx —
      // bridge.destination_payout_submitted never ran.
      destinationTxHash: payment.destinationTxHash,
      recoveredFrom: reason.slice(0, 200),
    },
    payment.id
  );
  // The in-memory row can carry a payout hash the DB never received, because the
  // persist is exactly what failed on this path. Writing it alongside the terminal
  // status is the last chance to keep it: a SETTLED cross-chain row whose
  // destinationTxHash is null tells reconciliation and the payment detail that no
  // destination leg happened, when one did and the recipient holds the money.
  // Same-chain routes never set the hash, so this is a no-op for them.
  const carryHash = payment.destinationTxHash ? { destinationTxHash: payment.destinationTxHash } : {};
  return await setStatus(payment, "SETTLED", carryHash);
}

interface CompensationContext {
  /** Why the destination leg failed — operator detail, scrubbed for tenants on read. */
  reason: string;
  network: string;
  tokenSymbol: string;
  /** Display amount (decimal string) for the audit trail. */
  amount: string;
  /** The same base units that were escrowed — the sender is made exactly whole. */
  amountUnits: bigint;
  sender: Address;
}

/**
 * What compensating this payment would cost and where it would go, derived from
 * the row alone — so the executor's own catch and a later operator repair can
 * never disagree about the amount. The network is the payment's source network,
 * which is also what every quoted route carries as `source_network` (lib/routing
 * reads it off this same column).
 */
function compensationContextFor(payment: PaymentWithParties): CompensationContext {
  const network = payment.sourceNetwork;
  const asset = assetForCurrency(payment.sourceCurrency);
  const token = loadDeployments().networks[network].contracts.tokens[asset.symbol];
  const senderWallet = walletOn(payment.sender.wallets, network);
  if (!senderWallet) throw new Error("Sender has no registered wallet");
  return {
    reason: payment.failureReason ?? "destination leg failed after settlement",
    network,
    tokenSymbol: asset.symbol,
    amount: payment.amount,
    amountUnits: toBaseUnits(payment.amount, token.decimals),
    sender: senderWallet.address as Address,
  };
}

/**
 * Compensating action for a destination leg that failed *after* the source escrow
 * was released. `failAndRefund` is not available here — the escrow row is SETTLED
 * and its balance has already moved to the treasury — so the treasury sends the
 * source amount straight back to the sender's wallet on the source network.
 */
async function compensateSender(payment: Payment, ctx: CompensationContext): Promise<Payment> {
  const compensating = await transitionStatus(payment, "COMPENSATION_PENDING", {
    data: { failureReason: ctx.reason },
    detail: {
      network: ctx.network,
      asset: ctx.tokenSymbol,
      amount: ctx.amount,
      escrowState: "SETTLED",
    },
  });
  return runCompensationTransfer(compensating, ctx);
}

/**
 * Mark COMPENSATED from a *confirmed* compensation receipt. The hash is evidence
 * of an attempt until this transition — never treat a non-null compensationTxHash
 * alone as proof the sender was repaid (a reverted attempt would strand them).
 */
async function completeCompensationFromConfirmed(
  compensating: Payment,
  ctx: CompensationContext
): Promise<Payment> {
  const txHash = compensating.compensationTxHash!;
  await audit(
    "payment.compensation_recovered",
    {
      network: ctx.network,
      asset: ctx.tokenSymbol,
      amount: ctx.amount,
      amountUnits: ctx.amountUnits.toString(),
      to: ctx.sender,
      txHash,
      evidence: "compensation_tx_hash",
      note: "prior compensation attempt confirmed — marking COMPENSATED without re-transfer",
    },
    compensating.id
  );
  return transitionStatus(compensating, "COMPENSATED", {
    data: { compensationTxHash: txHash },
    detail: { network: ctx.network, txHash, evidence: "compensation_tx_hash" },
  });
}

/**
 * The transfer half of the saga, entered with the payment already in
 * COMPENSATION_PENDING — by the executor's catch, or by an operator repair of an
 * attempt whose transfer failed.
 *
 * A failed transfer leaves the payment in COMPENSATION_PENDING rather than FAILED:
 * the sender's funds are genuinely still missing, and that is the state a repair
 * re-enters. Nothing retries automatically — compensation moves real money, so the
 * decision to send it again is an operator's.
 *
 * compensationTxHash is the *attempt* hash (persisted before confirm), mirroring
 * destinationTxHash on the bridge leg. Reconcile any prior attempt before
 * broadcasting another transfer: confirmed → COMPENSATED with no re-send;
 * unknown → refuse; reverted/absent → a fresh transfer is correct.
 */
async function runCompensationTransfer(compensating: Payment, ctx: CompensationContext): Promise<Payment> {
  // Reconcile a prior attempt before any new broadcast. Unknown throws (not
  // swallowed) so repair surfaces a 409 rather than a silent no-op failure.
  if (compensating.compensationTxHash) {
    const prior = await resolveCompensationOutcome(
      ctx.network,
      compensating.compensationTxHash as Hex
    );
    if (prior === "confirmed") {
      return completeCompensationFromConfirmed(compensating, ctx);
    }
    if (prior === "unknown") {
      await audit(
        "payment.compensation_unresolved",
        {
          network: ctx.network,
          txHash: compensating.compensationTxHash,
          note: "compensation receipt unreadable — operator action required",
        },
        compensating.id
      );
      throw new ApiError(
        "conflict",
        "compensation outcome unresolved — cannot transfer safely"
      );
    }
    // reverted or absent — fall through to a fresh transfer.
  }

  try {
    await executorTestHooks.beforeCompensationTransfer?.();
    const submitted = await treasuryTokenTransfer(
      ctx.network,
      ctx.tokenSymbol,
      ctx.sender,
      ctx.amountUnits
    );
    // Remember the attempt on the in-memory row *before* any further I/O so a
    // failed DB persist still lets this catch (or a later repair, once persisted
    // best-effort below) reconcile — T5-3 mirror on the compensation leg.
    compensating = { ...compensating, compensationTxHash: submitted.hash };
    await executorTestHooks.beforeCompensationTxHashPersist?.();
    compensating = {
      ...compensating,
      ...(await prisma.payment.update({
        where: { id: compensating.id },
        data: { compensationTxHash: submitted.hash },
      })),
    };
    await audit(
      "payment.compensation_submitted",
      {
        network: ctx.network,
        asset: ctx.tokenSymbol,
        amount: ctx.amount,
        amountUnits: ctx.amountUnits.toString(),
        to: ctx.sender,
        txHash: submitted.hash,
      },
      compensating.id
    );
    await executorTestHooks.afterCompensationSubmitted?.();
    await submitted.confirm();
    await audit(
      "payment.compensation_transfer",
      {
        network: ctx.network,
        asset: ctx.tokenSymbol,
        amount: ctx.amount,
        amountUnits: ctx.amountUnits.toString(), // never a bigint — audit() JSON-stringifies
        to: ctx.sender,
        txHash: submitted.hash,
      },
      compensating.id
    );
    return await transitionStatus(compensating, "COMPENSATED", {
      data: { compensationTxHash: submitted.hash },
      detail: { network: ctx.network, txHash: submitted.hash },
    });
  } catch (err) {
    // Same-process recovery: the transfer may have mined even though confirm
    // (or the hash persist) threw. Reconcile before giving up — but never treat
    // unknown as repaid, and never mark COMPENSATED on a reverted attempt.
    if (compensating.compensationTxHash) {
      const row = await prisma.payment.findUnique({
        where: { id: compensating.id },
        select: { compensationTxHash: true },
      });
      if (!row?.compensationTxHash) {
        // Persist was what failed — best-effort write so a later repair can see it.
        await prisma.payment
          .update({
            where: { id: compensating.id },
            data: { compensationTxHash: compensating.compensationTxHash },
          })
          .catch(() => {});
      }
      const outcome = await resolveCompensationOutcome(
        ctx.network,
        compensating.compensationTxHash as Hex
      );
      if (outcome === "confirmed") {
        return completeCompensationFromConfirmed(compensating, ctx);
      }
    }

    await audit(
      "payment.compensation_failed",
      {
        network: ctx.network,
        asset: ctx.tokenSymbol,
        amount: ctx.amount,
        reason: err instanceof Error ? err.message : String(err),
        ...(compensating.compensationTxHash
          ? { txHash: compensating.compensationTxHash }
          : {}),
      },
      compensating.id
    );
    return compensating;
  }
}

// ---------------------------------------------------------------------------
// Operator repair. Both entry points below exist because an execution attempt can
// end with the sender's money neither delivered nor returned — a compensation
// transfer that itself failed, or a refund leg that never landed. Nothing polls
// for these, so an operator has to be able to see and finish them by hand.
// ---------------------------------------------------------------------------

export interface StuckPayment {
  payment: PaymentWithParties;
  /** Live escrow state on the source network. Null when the RPC read failed. */
  escrowState: OnchainPaymentState | null;
}

/**
 * Payments an operator may still owe an action: the compensation transfers that
 * failed, plus the FAILED attempts whose escrow was never resolved on-chain.
 *
 * The DB cannot answer this alone — a FAILED payment is only really finished if
 * its escrow came back — so each candidate is checked against its source chain.
 * A read that fails degrades to `escrowState: null` and the payment is *kept* in
 * the list: unknown is not the same as fine, and a flaky RPC must not make a
 * stranded payment disappear from the one view that would surface it.
 */
export async function stuckPayments(): Promise<StuckPayment[]> {
  const candidates = await prisma.payment.findMany({
    where: {
      OR: [
        { status: "COMPENSATION_PENDING" },
        // Any PAYOUT_PENDING: escrow is already released at this status, so the
        // sender's funds are at risk whether or not destinationTxHash landed
        // (process death between the status write and the hash persist left
        // hash-less rows invisible — T5-4). Keep visible until resolved.
        { status: "PAYOUT_PENDING" },
        // A FAILED payment attempted escrow iff it has a reservation row: the
        // reservation is created immediately before initiatePayment, and the
        // earlier failures (rejected quote, insufficient liquidity, failed
        // auto-recall) stop before it. onchainPaymentId is NOT the signal — a
        // receipt that timed out leaves the escrow held with that column still
        // null, and keying off it hid exactly that stranded payment. The escrow's
        // deterministic id is recomputed from payment.id below regardless.
        { status: "FAILED", reservation: { isNot: null } },
      ],
    },
    include: { sender: { include: { wallets: true } }, recipient: { include: { wallets: true } } },
    orderBy: { createdAt: "desc" },
  });

  const rows = await Promise.all(
    candidates.map(async (payment) => ({
      payment,
      escrowState: executorTestHooks.escrowReadFails
        ? null
        : await onchainPaymentState(payment.sourceNetwork, onchainPaymentId(payment.id)).catch(
            () => null
          ),
    }))
  );

  // Keep only the payments actually holding funds. INITIATED/SETTLED = money is
  // somewhere it does not belong; null = the read failed, and unknown is not the
  // same as fine, so keep it. NONE (a reservation that never escrowed — the tx
  // reverted before mining) and REFUNDED (the sender already has it back, only the
  // REFUNDED transition missing) are done. COMPENSATION_PENDING is always kept —
  // the sender is owed a transfer regardless of escrow state. PAYOUT_PENDING is
  // always kept — destination may be unresolved, or the attempt hash never
  // persisted after the escrow released.
  return rows.filter(
    (r) =>
      r.payment.status === "COMPENSATION_PENDING" ||
      r.payment.status === "PAYOUT_PENDING" ||
      r.escrowState === "INITIATED" ||
      r.escrowState === "SETTLED" ||
      r.escrowState === null
  );
}

/**
 * Re-run the compensation transfer for a payment stuck in COMPENSATION_PENDING.
 *
 * Idempotent in the sense that matters for something that moves money: a payment
 * already COMPENSATED is returned untouched rather than paid twice, and the lease
 * makes two concurrent repairs impossible. The escrow is re-read first for the
 * same reason the executor reads it — only a *released* escrow may be repaid from
 * treasury, and the DB status alone is not evidence of that.
 */
export async function repairCompensation(paymentId: string): Promise<Payment> {
  const payment = await prisma.payment.findUniqueOrThrow({
    where: { id: paymentId },
    include: { sender: { include: { wallets: true } }, recipient: { include: { wallets: true } } },
  });

  if (payment.status === "COMPENSATED") return payment;
  if (payment.status !== "COMPENSATION_PENDING") {
    throw new ApiError("conflict", `payment cannot be repaired from status ${payment.status}`);
  }

  // The same lease the executor claims — the CAS, not the check above, decides the
  // race between two operators clicking Repair at once.
  return withExecutionLease(paymentId, "COMPENSATION_PENDING", async (leaseId) => {
    const ctx = compensationContextFor(payment);

    // A compensation repair must not pay the sender if the destination payout
    // already landed — complete forward instead of double-paying treasury.
    if (payment.destinationTxHash) {
      const outcome = await resolveDestinationPayoutOutcome(
        payment.destinationNetwork,
        payment.destinationTxHash as Hex
      );
      if (outcome === "confirmed") {
        throw new ApiError(
          "conflict",
          "destination payout already confirmed — compensation refused"
        );
      }
      if (outcome === "unknown") {
        throw new ApiError(
          "conflict",
          "destination payout outcome unresolved — cannot compensate safely"
        );
      }
    }

    const escrow = executorTestHooks.escrowReadFails
      ? null
      : await onchainPaymentState(ctx.network, onchainPaymentId(payment.id)).catch(() => null);
    // Stopping on an unreadable escrow costs nothing: the transfer would run on
    // that same unreachable network anyway.
    if (escrow === null) {
      throw new ApiError("conflict", "source network unreachable — escrow state could not be confirmed");
    }
    if (escrow !== "SETTLED") {
      throw new ApiError("conflict", "source escrow was not released — this payment is not owed compensation");
    }
    return runCompensationTransfer({ ...payment, executionLeaseId: leaseId }, ctx);
  });
}

/**
 * Operator re-reconcile (R1): re-read chain evidence for an unresolved payment and
 * advance only on conclusive outcomes. Never broadcasts a transaction — confirmed
 * destination → complete forward; reverted destination → COMPENSATION_PENDING for
 * a later /repair; confirmed compensation → COMPENSATED; unknown → unchanged.
 */
export type PaymentReconcileAction =
  | "completed_forward"
  | "awaiting_compensation"
  | "marked_compensated"
  | "unchanged";

export interface PaymentReconcileResult {
  payment: Payment;
  outcome: TransactionOutcome;
  action: PaymentReconcileAction;
}

export async function reconcileUnresolvedPayment(
  paymentId: string
): Promise<PaymentReconcileResult> {
  const payment = await prisma.payment.findUniqueOrThrow({
    where: { id: paymentId },
    include: { sender: { include: { wallets: true } }, recipient: { include: { wallets: true } } },
  });

  if (payment.status === "SETTLED") {
    return { payment, outcome: "confirmed", action: "unchanged" };
  }
  if (payment.status === "COMPENSATED") {
    return { payment, outcome: "confirmed", action: "unchanged" };
  }

  if (payment.status === "PAYOUT_PENDING") {
    if (!payment.destinationTxHash) {
      throw new ApiError("conflict", "no destination payout attempt to reconcile");
    }
    return withExecutionLease(paymentId, "PAYOUT_PENDING", async (leaseId) => {
      const leased = { ...payment, executionLeaseId: leaseId };
      const outcome = await resolveDestinationPayoutOutcome(
        payment.destinationNetwork,
        payment.destinationTxHash as Hex
      );
      if (outcome === "confirmed") {
        const destAmount =
          payment.destinationAmount ?? selectedRoute(payment).estimated_destination_amount;
        const completed = await completeSettledPayout(leased, destAmount, "operator reconcile", {
          evidence: "destination_tx_hash",
        });
        return { payment: completed, outcome, action: "completed_forward" as const };
      }
      if (outcome === "reverted" || outcome === "absent") {
        // Enter the compensation *state* only — never transfer here. Repair is
        // the tool that moves treasury funds once the operator chooses to.
        await prisma.liquidityReservation
          .update({ where: { paymentId: payment.id }, data: { status: "RELEASED" } })
          .catch(() => {});
        const pending = await transitionStatus(leased, "COMPENSATION_PENDING", {
          data: {
            failureReason: `destination payout ${outcome} — awaiting compensation`,
          },
          detail: {
            network: payment.destinationNetwork,
            txHash: payment.destinationTxHash,
            evidence: `destination_tx_${outcome}`,
            note: "operator reconcile — no compensation transfer sent; use repair",
          },
        });
        return { payment: pending, outcome, action: "awaiting_compensation" as const };
      }
      await audit(
        "payment.destination_payout_unresolved",
        {
          network: payment.destinationNetwork,
          txHash: payment.destinationTxHash,
          note: "operator reconcile — destination receipt still unreadable",
        },
        payment.id
      );
      return { payment: leased, outcome: "unknown", action: "unchanged" as const };
    });
  }

  if (payment.status === "COMPENSATION_PENDING") {
    if (!payment.compensationTxHash) {
      throw new ApiError(
        "conflict",
        "no compensation attempt to reconcile — use repair to send a transfer"
      );
    }
    return withExecutionLease(paymentId, "COMPENSATION_PENDING", async (leaseId) => {
      const leased = { ...payment, executionLeaseId: leaseId };
      const ctx = compensationContextFor(payment);
      const outcome = await resolveCompensationOutcome(
        ctx.network,
        payment.compensationTxHash as Hex
      );
      if (outcome === "confirmed") {
        const completed = await completeCompensationFromConfirmed(leased, ctx);
        return { payment: completed, outcome, action: "marked_compensated" as const };
      }
      if (outcome === "unknown") {
        await audit(
          "payment.compensation_unresolved",
          {
            network: ctx.network,
            txHash: payment.compensationTxHash,
            note: "operator reconcile — compensation receipt still unreadable",
          },
          payment.id
        );
        return { payment: leased, outcome: "unknown", action: "unchanged" as const };
      }
      // reverted/absent — eligible for a fresh repair; do not broadcast here.
      await audit(
        "payment.compensation_attempt_not_confirmed",
        {
          network: ctx.network,
          txHash: payment.compensationTxHash,
          outcome,
          note: "operator reconcile — prior attempt not confirmed; use repair to re-send",
        },
        payment.id
      );
      return { payment: leased, outcome, action: "unchanged" as const };
    });
  }

  throw new ApiError("conflict", `payment cannot be reconciled from status ${payment.status}`);
}
