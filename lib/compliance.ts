// Mock compliance providers, per PRD section 20/21. Each provider returns the
// standard { status, score, reason_codes, provider, timestamp } shape. Rules are
// deterministic so demos are repeatable:
//   - KYB/KYC: driven by entity kybStatus
//   - Sanctions: fails if an entity name contains "sanctioned" (demo hook)
//   - Wallet risk: driven by wallet.riskScore (>70 fail, >40 review)
//   - Transaction risk: USD-equivalent > $250k → manual review, > $1M → fail
//   - Corridor risk: corridor must be approved for both entities

import type { Entity, Wallet } from "@prisma/client";
import { prisma } from "./db";
import { usdEquivalent, corridorCode } from "./fx";

export type ComplianceStatus = "PASS" | "FAIL" | "MANUAL_REVIEW" | "EXEMPT_TESTNET";

export interface ProviderResult {
  status: ComplianceStatus;
  score: number;
  reason_codes: string[];
  provider: string;
  timestamp: string;
}

export const TX_REVIEW_THRESHOLD_USD = 250_000;
export const TX_FAIL_THRESHOLD_USD = 1_000_000;
export const WALLET_REVIEW_SCORE = 40;
export const WALLET_FAIL_SCORE = 70;

function result(
  provider: string,
  status: ComplianceStatus,
  score: number,
  reasons: string[] = []
): ProviderResult {
  return { status, score, reason_codes: reasons, provider, timestamp: new Date().toISOString() };
}

export function kybProvider(entity: Entity, kind: "sender" | "recipient"): ProviderResult {
  if (entity.kybStatus === "PASSED") return result("mock_kyb", "PASS", 5);
  if (entity.kybStatus === "PENDING")
    return result("mock_kyb", "MANUAL_REVIEW", 50, [`${kind}_kyb_pending`]);
  return result("mock_kyb", "FAIL", 95, [`${kind}_kyb_failed`]);
}

export function sanctionsProvider(sender: Entity, recipient: Entity): ProviderResult {
  const hit = [sender, recipient].find((e) => e.name.toLowerCase().includes("sanctioned"));
  if (hit) return result("mock_sanctions", "FAIL", 100, ["sanctions_list_match"]);
  return result("mock_sanctions", "PASS", 0);
}

export function walletRiskProvider(wallet: Wallet | null): ProviderResult {
  if (!wallet) return result("mock_wallet_risk", "MANUAL_REVIEW", 60, ["wallet_not_registered"]);
  if (!wallet.allowlisted)
    return result("mock_wallet_risk", "MANUAL_REVIEW", 55, ["wallet_not_allowlisted"]);
  if (wallet.riskScore > WALLET_FAIL_SCORE)
    return result("mock_wallet_risk", "FAIL", wallet.riskScore, ["wallet_high_risk"]);
  if (wallet.riskScore > WALLET_REVIEW_SCORE)
    return result("mock_wallet_risk", "MANUAL_REVIEW", wallet.riskScore, ["wallet_elevated_risk"]);
  return result("mock_wallet_risk", "PASS", wallet.riskScore);
}

export function transactionRiskProvider(amount: number, sourceCurrency: string): ProviderResult {
  const usd = usdEquivalent(amount, sourceCurrency);
  if (usd > TX_FAIL_THRESHOLD_USD)
    return result("mock_tx_monitoring", "FAIL", 90, ["amount_exceeds_hard_limit"]);
  if (usd > TX_REVIEW_THRESHOLD_USD)
    return result("mock_tx_monitoring", "MANUAL_REVIEW", 65, ["amount_exceeds_review_threshold"]);
  return result("mock_tx_monitoring", "PASS", Math.min(30, Math.round(usd / 10_000)));
}

export function corridorRiskProvider(
  sender: Entity,
  recipient: Entity,
  source: string,
  dest: string
): ProviderResult {
  const corridor = corridorCode(source, dest);
  const senderOk = source === dest || (JSON.parse(sender.approvedCorridors) as string[]).includes(corridor);
  const recipientOk =
    source === dest || (JSON.parse(recipient.approvedCorridors) as string[]).includes(corridor);
  if (!senderOk || !recipientOk)
    return result("mock_corridor_risk", "MANUAL_REVIEW", 60, ["corridor_not_pre_approved"]);
  return result("mock_corridor_risk", "PASS", 10);
}

export interface ComplianceOutcome {
  overall: "APPROVED" | "MANUAL_REVIEW" | "REJECTED";
  checks: { checkType: string; result: ProviderResult }[];
}

/** Run the full compliance gate for a payment and persist each check. */
export async function runComplianceChecks(paymentId: string): Promise<ComplianceOutcome> {
  const payment = await prisma.payment.findUniqueOrThrow({
    where: { id: paymentId },
    include: { sender: { include: { wallets: true } }, recipient: { include: { wallets: true } } },
  });

  // Screen the wallet actually used on each leg's network (entities can have
  // different addresses per network on real testnets).
  const walletOn = (wallets: Wallet[], network: string) =>
    wallets.find((w) => w.network === network) ?? wallets[0] ?? null;
  const senderWallet = walletOn(payment.sender.wallets, payment.sourceNetwork);
  const recipientWallet = walletOn(payment.recipient.wallets, payment.destinationNetwork);
  const amount = Number(payment.amount);

  const checks: { checkType: string; result: ProviderResult }[] = [
    { checkType: "KYB_SENDER", result: kybProvider(payment.sender, "sender") },
    { checkType: "KYC_RECIPIENT", result: kybProvider(payment.recipient, "recipient") },
    { checkType: "SANCTIONS", result: sanctionsProvider(payment.sender, payment.recipient) },
    { checkType: "WALLET_RISK_SENDER", result: walletRiskProvider(senderWallet) },
    { checkType: "WALLET_RISK_RECIPIENT", result: walletRiskProvider(recipientWallet) },
    {
      checkType: "TX_RISK",
      result: transactionRiskProvider(amount, payment.sourceCurrency),
    },
    {
      checkType: "CORRIDOR_RISK",
      result: corridorRiskProvider(
        payment.sender,
        payment.recipient,
        payment.sourceCurrency,
        payment.destinationCurrency
      ),
    },
  ];

  await prisma.complianceCheck.createMany({
    data: checks.map((c) => ({
      paymentId,
      provider: c.result.provider,
      checkType: c.checkType,
      status: c.result.status,
      score: c.result.score,
      reasonCodes: JSON.stringify(c.result.reason_codes),
    })),
  });

  const anyFail = checks.some((c) => c.result.status === "FAIL");
  const anyReview = checks.some((c) => c.result.status === "MANUAL_REVIEW");
  const overall = anyFail ? "REJECTED" : anyReview ? "MANUAL_REVIEW" : "APPROVED";

  return { overall, checks };
}
