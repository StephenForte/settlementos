// Compliance gate, per PRD section 20/21 + Phase 6. Every check returns the
// standard ProviderResult shape. Two checks can run against real vendor
// services when their env config is set (see lib/providers/):
//   - SANCTIONS       → OpenSanctions match API      (OPENSANCTIONS_API_KEY)
//   - WALLET_RISK_*   → Chainalysis sanctions oracle (CHAINALYSIS_ORACLE_RPC_URL)
// Without keys the deterministic mocks run, so demos are repeatable offline:
//   - KYB/KYC: driven by entity kybStatus
//   - Sanctions: fails if an entity name contains "sanctioned" (demo hook)
//   - Wallet risk: driven by wallet.riskScore (>70 fail, >40 review)
//   - Transaction risk: USD-equivalent > $250k → manual review, > $1M → fail
//   - Corridor risk: corridor must be approved for both entities
// Real-provider errors fail safe to MANUAL_REVIEW (never fail-open), and the
// verbatim vendor response is persisted on ComplianceCheck as audit evidence.

import type { Entity, Wallet } from "@prisma/client";
import { prisma } from "./db";
import { usdEquivalent, corridorCode } from "./fx";
import { providerResult, type ComplianceStatus, type ProviderResult } from "./providers/types";
import { openSanctionsScreen } from "./providers/opensanctions";
import { chainalysisOracleScreen } from "./providers/chainalysis";

export type { ComplianceStatus, ProviderResult };

export const TX_REVIEW_THRESHOLD_USD = 250_000;
export const TX_FAIL_THRESHOLD_USD = 1_000_000;
export const WALLET_REVIEW_SCORE = 40;
export const WALLET_FAIL_SCORE = 70;

const result = providerResult;

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

export function walletRiskProvider(wallet: Wallet): ProviderResult {
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

// --- Env-driven provider dispatch (Phase 6) -------------------------------
// Keys are read at call time so tests (and a dev toggling .env) see changes
// without a module reload.

export function openSanctionsEnabled(): boolean {
  return Boolean(process.env.OPENSANCTIONS_API_KEY);
}

export function chainalysisOracleEnabled(): boolean {
  return Boolean(process.env.CHAINALYSIS_ORACLE_RPC_URL);
}

/** SANCTIONS check: OpenSanctions when configured, demo-hook mock otherwise. */
export async function sanctionsCheck(sender: Entity, recipient: Entity): Promise<ProviderResult> {
  if (!openSanctionsEnabled()) return sanctionsProvider(sender, recipient);
  return openSanctionsScreen([
    { kind: "sender", name: sender.name, country: sender.country },
    { kind: "recipient", name: recipient.name, country: recipient.country },
  ]);
}

/**
 * WALLET_RISK check. Registration and allowlisting are platform policy and
 * apply on both paths; the risk screening itself is the Chainalysis sanctions
 * oracle when configured, riskScore mock otherwise.
 */
export async function walletRiskCheck(wallet: Wallet | null): Promise<ProviderResult> {
  if (!wallet) return result("platform_policy", "MANUAL_REVIEW", 60, ["wallet_not_registered"]);
  if (!wallet.allowlisted)
    return result("platform_policy", "MANUAL_REVIEW", 55, ["wallet_not_allowlisted"]);
  if (!chainalysisOracleEnabled()) return walletRiskProvider(wallet);
  return chainalysisOracleScreen(wallet.address);
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

  const [sanctions, senderWalletRisk, recipientWalletRisk] = await Promise.all([
    sanctionsCheck(payment.sender, payment.recipient),
    walletRiskCheck(senderWallet),
    walletRiskCheck(recipientWallet),
  ]);

  const checks: { checkType: string; result: ProviderResult }[] = [
    { checkType: "KYB_SENDER", result: kybProvider(payment.sender, "sender") },
    { checkType: "KYC_RECIPIENT", result: kybProvider(payment.recipient, "recipient") },
    { checkType: "SANCTIONS", result: sanctions },
    { checkType: "WALLET_RISK_SENDER", result: senderWalletRisk },
    { checkType: "WALLET_RISK_RECIPIENT", result: recipientWalletRisk },
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
      rawResponse: c.result.raw === undefined ? null : JSON.stringify(c.result.raw),
    })),
  });

  const anyFail = checks.some((c) => c.result.status === "FAIL");
  const anyReview = checks.some((c) => c.result.status === "MANUAL_REVIEW");
  const overall = anyFail ? "REJECTED" : anyReview ? "MANUAL_REVIEW" : "APPROVED";

  return { overall, checks };
}
