import { describe, it, expect } from "vitest";
import { prisma } from "@/lib/db";
import { runComplianceChecks } from "@/lib/compliance";
import { createDraftPayment } from "../helpers/payments";

function statusOf(checks: { checkType: string; result: { status: string } }[], type: string) {
  return checks.find((c) => c.checkType === type)?.result.status;
}
function reasonsOf(checks: { checkType: string; result: { reason_codes: string[] } }[], type: string) {
  return checks.find((c) => c.checkType === type)?.result.reason_codes ?? [];
}

// Test entities created here stay in the disposable fixture DB (FK'd rows make
// cleanup noisy and the whole DB is rebuilt every run anyway).

describe("compliance gate", () => {
  it("approves the happy path with all 7 checks passing and persisted", async () => {
    const payment = await createDraftPayment(); // ACME → Tokyo, $100k USD→JPY
    const outcome = await runComplianceChecks(payment.id);

    expect(outcome.overall).toBe("APPROVED");
    expect(outcome.checks).toHaveLength(7);
    expect(outcome.checks.every((c) => c.result.status === "PASS")).toBe(true);

    const persisted = await prisma.complianceCheck.findMany({ where: { paymentId: payment.id } });
    expect(persisted).toHaveLength(7);
  });

  it("routes the Osaka demo case to manual review for three independent reasons", async () => {
    const payment = await createDraftPayment({
      recipientExternalId: "ent_osaka_parts",
      amount: "300000.00",
    });
    const outcome = await runComplianceChecks(payment.id);

    expect(outcome.overall).toBe("MANUAL_REVIEW");
    expect(reasonsOf(outcome.checks, "KYC_RECIPIENT")).toContain("recipient_kyb_pending");
    expect(reasonsOf(outcome.checks, "WALLET_RISK_RECIPIENT")).toContain("wallet_not_allowlisted");
    expect(reasonsOf(outcome.checks, "TX_RISK")).toContain("amount_exceeds_review_threshold");
  });

  it("respects the $250k review threshold boundary", async () => {
    const under = await createDraftPayment({ amount: "250000.00" });
    expect((await runComplianceChecks(under.id)).overall).toBe("APPROVED");

    const over = await createDraftPayment({ amount: "250000.01" });
    const outcome = await runComplianceChecks(over.id);
    expect(outcome.overall).toBe("MANUAL_REVIEW");
    expect(statusOf(outcome.checks, "TX_RISK")).toBe("MANUAL_REVIEW");
  });

  it("rejects outright above the $1M hard limit", async () => {
    const payment = await createDraftPayment({ amount: "1500000.00" });
    const outcome = await runComplianceChecks(payment.id);

    expect(outcome.overall).toBe("REJECTED");
    expect(reasonsOf(outcome.checks, "TX_RISK")).toContain("amount_exceeds_hard_limit");
  });

  it("evaluates the threshold on USD-equivalent, not raw amount", async () => {
    // 50M JPY ≈ $318k — above the $250k review threshold despite the big number
    // being JPY. Tokyo → ACME uses the approved JPY-USD corridor.
    const payment = await createDraftPayment({
      senderExternalId: "ent_tokyo_supplier",
      recipientExternalId: "ent_acme_us",
      amount: "50000000",
      sourceCurrency: "JPY",
      destinationCurrency: "USD",
    });
    const outcome = await runComplianceChecks(payment.id);
    expect(statusOf(outcome.checks, "TX_RISK")).toBe("MANUAL_REVIEW");
  });

  it("flags corridors not pre-approved for both entities", async () => {
    // ACME has USD-SGD, but Tokyo does not — corridor must be approved for BOTH.
    const payment = await createDraftPayment({
      destinationCurrency: "SGD",
    });
    const outcome = await runComplianceChecks(payment.id);

    expect(outcome.overall).toBe("MANUAL_REVIEW");
    expect(reasonsOf(outcome.checks, "CORRIDOR_RISK")).toContain("corridor_not_pre_approved");
  });

  it("fails high-risk wallets (score > 70) and rejects the payment", async () => {
    await prisma.entity.create({
      data: {
        externalId: "ent_test_highrisk",
        name: "High Risk Trading Ltd",
        country: "JP",
        role: "RECIPIENT",
        kybStatus: "PASSED",
        approvedCorridors: JSON.stringify(["USD-JPY"]),
        wallets: {
          create: {
            address: "0x00000000000000000000000000000000deadbeef",
            network: "base-local",
            allowlisted: true,
            riskScore: 85,
          },
        },
      },
    });

    const payment = await createDraftPayment({ recipientExternalId: "ent_test_highrisk" });
    const outcome = await runComplianceChecks(payment.id);

    expect(outcome.overall).toBe("REJECTED");
    expect(statusOf(outcome.checks, "WALLET_RISK_RECIPIENT")).toBe("FAIL");
    expect(reasonsOf(outcome.checks, "WALLET_RISK_RECIPIENT")).toContain("wallet_high_risk");
  });

  it("sends elevated-risk wallets (41–70) to manual review", async () => {
    await prisma.entity.create({
      data: {
        externalId: "ent_test_elevated",
        name: "Elevated Risk Co",
        country: "SG",
        role: "RECIPIENT",
        kybStatus: "PASSED",
        approvedCorridors: JSON.stringify(["USD-JPY"]),
        wallets: {
          create: {
            address: "0x00000000000000000000000000000000cafebabe",
            network: "base-local",
            allowlisted: true,
            riskScore: 45,
          },
        },
      },
    });

    const payment = await createDraftPayment({ recipientExternalId: "ent_test_elevated" });
    const outcome = await runComplianceChecks(payment.id);

    expect(outcome.overall).toBe("MANUAL_REVIEW");
    expect(reasonsOf(outcome.checks, "WALLET_RISK_RECIPIENT")).toContain("wallet_elevated_risk");
  });

  it("blocks entities matching the sanctions demo hook", async () => {
    await prisma.entity.create({
      data: {
        externalId: "ent_test_sanctioned",
        name: "Sanctioned Holdings LLC",
        country: "JP",
        role: "RECIPIENT",
        kybStatus: "PASSED",
        approvedCorridors: JSON.stringify(["USD-JPY"]),
        wallets: {
          create: {
            address: "0x00000000000000000000000000000000feedface",
            network: "base-local",
            allowlisted: true,
            riskScore: 5,
          },
        },
      },
    });

    const payment = await createDraftPayment({ recipientExternalId: "ent_test_sanctioned" });
    const outcome = await runComplianceChecks(payment.id);

    expect(outcome.overall).toBe("REJECTED");
    expect(statusOf(outcome.checks, "SANCTIONS")).toBe("FAIL");
  });

  it("screens the wallet on the payment's network (per-network wallets)", async () => {
    // Same entity, clean wallet on base-local but risky wallet on polygon-local:
    // the destination-network wallet must be the one screened.
    await prisma.entity.create({
      data: {
        externalId: "ent_test_pernetwork",
        name: "Per Network Wallets Inc",
        country: "SG",
        role: "RECIPIENT",
        kybStatus: "PASSED",
        approvedCorridors: JSON.stringify(["USD-JPY", "USD-SGD"]),
        wallets: {
          create: [
            {
              address: "0x0000000000000000000000000000000000000c1e",
              network: "base-local",
              allowlisted: true,
              riskScore: 5,
            },
            {
              address: "0x0000000000000000000000000000000000000bad",
              network: "polygon-local",
              allowlisted: true,
              riskScore: 85,
            },
          ],
        },
      },
    });

    const clean = await runComplianceChecks(
      (await createDraftPayment({ recipientExternalId: "ent_test_pernetwork" })).id
    );
    expect(statusOf(clean.checks, "WALLET_RISK_RECIPIENT")).toBe("PASS");

    const risky = await runComplianceChecks(
      (
        await createDraftPayment({
          recipientExternalId: "ent_test_pernetwork",
          destinationNetwork: "polygon-local",
        })
      ).id
    );
    expect(statusOf(risky.checks, "WALLET_RISK_RECIPIENT")).toBe("FAIL");
  });
});
