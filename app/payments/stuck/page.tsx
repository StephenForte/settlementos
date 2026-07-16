import Link from "next/link";
import { formatAmount } from "@/lib/assets";
import { explorerTxUrl } from "@/lib/networks";
import { stuckPayments } from "@/lib/executor";
import { currentPrincipal } from "@/lib/session";
import { Card } from "@/components/ui";
import { RepairList, type StuckPaymentView } from "./repair-list";

export const dynamic = "force-dynamic";

export default async function StuckPaymentsPage() {
  // Unlike the other pages, this one shows unscrubbed operator detail and drives a
  // treasury-funded transfer, so it checks the principal rather than rendering for
  // whoever asks. The API route enforces the same rule independently.
  const principal = await currentPrincipal();
  if (principal?.role !== "OPERATOR") {
    return (
      <Card title="Needs Attention">
        <p className="text-sm text-slate-400">
          Operator access required.{" "}
          <Link href="/login" className="text-emerald-400 hover:underline">
            Sign in
          </Link>{" "}
          with an operator key to view stuck payments.
        </p>
      </Card>
    );
  }

  // Degrades on its own per payment (escrowState: null), but a chain that is not
  // deployed at all throws — an empty list beats a 500 on the repair view.
  const stuck = await stuckPayments().catch(() => []);
  const payments: StuckPaymentView[] = stuck.map(({ payment, escrowState }) => ({
    id: payment.id,
    status: payment.status,
    senderName: payment.sender.name,
    recipientName: payment.recipient.name,
    amount: formatAmount(payment.amount, payment.sourceCurrency),
    sourceCurrency: payment.sourceCurrency,
    sourceNetwork: payment.sourceNetwork,
    escrowState,
    failureReason: payment.failureReason,
    settleTxHash: payment.settleTxHash,
    settleTxUrl: explorerTxUrl(payment.sourceNetwork, payment.settleTxHash),
    createdAt: payment.createdAt.toISOString(),
  }));

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-2xl font-semibold text-white">Needs Attention</h1>
        <p className="mt-1 text-sm text-slate-400">
          Payments whose funds are neither delivered nor returned — a compensation transfer that
          failed, or an escrow that was never resolved on-chain. Escrow state is read live from the
          source network.
        </p>
      </header>
      <Card>
        <RepairList payments={payments} />
      </Card>
      <Link href="/payments" className="text-sm text-slate-400 underline-offset-4 hover:text-white hover:underline">
        ← All payments
      </Link>
    </div>
  );
}
