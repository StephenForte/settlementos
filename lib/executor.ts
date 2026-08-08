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
import { recallForPayment } from "./treasury";
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

  // 0. Auto-recall: the route only cleared because liquidity is parked in the
  //    MMF, so redeem it T+0 before reserving anything against it.
  if (route.recall_required) {
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
      const failureReason = `Auto-recall of parked ${destAsset.symbol} on ${destNet} failed: ${
        err instanceof Error ? err.message : String(err)
      }`;
      // Nothing is reserved or escrowed yet, but a stale reservation from an
      // earlier attempt must not survive a failed payment.
      await prisma.liquidityReservation
        .update({ where: { paymentId: payment.id }, data: { status: "RELEASED" } })
        .catch(() => {});
      await setStatus(payment, "FAILED", { failureReason });
      throw new Error(failureReason);
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
 * The transfer half of the saga, entered with the payment already in
 * COMPENSATION_PENDING — by the executor's catch, or by an operator repair of an
 * attempt whose transfer failed.
 *
 * A failed transfer leaves the payment in COMPENSATION_PENDING rather than FAILED:
 * the sender's funds are genuinely still missing, and that is the state a repair
 * re-enters. Nothing retries automatically — compensation moves real money, so the
 * decision to send it again is an operator's.
 */
async function runCompensationTransfer(compensating: Payment, ctx: CompensationContext): Promise<Payment> {
  try {
    await executorTestHooks.beforeCompensationTransfer?.();
    const submitted = await treasuryTokenTransfer(ctx.network, ctx.tokenSymbol, ctx.sender, ctx.amountUnits);
    const tx = await submitted.confirm();
    await audit(
      "payment.compensation_transfer",
      {
        network: ctx.network,
        asset: ctx.tokenSymbol,
        amount: ctx.amount,
        amountUnits: ctx.amountUnits.toString(), // never a bigint — audit() JSON-stringifies
        to: ctx.sender,
        txHash: tx.hash,
      },
      compensating.id
    );
    return await transitionStatus(compensating, "COMPENSATED", {
      data: { compensationTxHash: tx.hash },
      detail: { network: ctx.network, txHash: tx.hash },
    });
  } catch (err) {
    await audit(
      "payment.compensation_failed",
      {
        network: ctx.network,
        asset: ctx.tokenSymbol,
        amount: ctx.amount,
        reason: err instanceof Error ? err.message : String(err),
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
