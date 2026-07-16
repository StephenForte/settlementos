import { describe, it, expect } from "vitest";
import {
  canTransition,
  assertTransition,
  TERMINAL_STATES,
  CANCELLABLE_STATES,
  PAYMENT_STATES,
  type PaymentStatus,
} from "@/lib/state";

describe("payment state machine", () => {
  it("allows the full happy-path lifecycle in order", () => {
    const happyPath: PaymentStatus[] = [
      "DRAFT",
      "QUOTED",
      "COMPLIANCE_PENDING",
      "APPROVED",
      "LIQUIDITY_RESERVED",
      "SUBMITTED_ONCHAIN",
      "CONFIRMED_ONCHAIN",
      "FX_OR_SWAP_COMPLETED",
      "PAYOUT_PENDING",
      "SETTLED",
    ];
    for (let i = 0; i < happyPath.length - 1; i++) {
      expect(canTransition(happyPath[i], happyPath[i + 1]), `${happyPath[i]} → ${happyPath[i + 1]}`).toBe(true);
    }
  });

  it("allows the manual-review detour and rejection", () => {
    expect(canTransition("COMPLIANCE_PENDING", "MANUAL_REVIEW")).toBe(true);
    expect(canTransition("MANUAL_REVIEW", "APPROVED")).toBe(true);
    expect(canTransition("MANUAL_REVIEW", "REJECTED")).toBe(true);
  });

  it("allows refund only after funds may have moved", () => {
    expect(canTransition("CONFIRMED_ONCHAIN", "REFUNDED")).toBe(true);
    expect(canTransition("FAILED", "REFUNDED")).toBe(true);
    expect(canTransition("DRAFT", "REFUNDED")).toBe(false);
    expect(canTransition("QUOTED", "REFUNDED")).toBe(false);
  });

  it("rejects skipping lifecycle steps", () => {
    expect(canTransition("DRAFT", "SETTLED")).toBe(false);
    expect(canTransition("QUOTED", "SUBMITTED_ONCHAIN")).toBe(false);
    expect(canTransition("APPROVED", "SETTLED")).toBe(false);
    expect(canTransition("SUBMITTED_ONCHAIN", "SETTLED")).toBe(false);
  });

  it("rejects moving backwards", () => {
    expect(canTransition("SETTLED", "DRAFT")).toBe(false);
    expect(canTransition("APPROVED", "QUOTED")).toBe(false);
    expect(canTransition("CONFIRMED_ONCHAIN", "SUBMITTED_ONCHAIN")).toBe(false);
  });

  it("terminal states have no exits", () => {
    for (const terminal of TERMINAL_STATES) {
      for (const to of PAYMENT_STATES) {
        expect(canTransition(terminal, to), `${terminal} → ${to}`).toBe(false);
      }
    }
  });

  it("FAILED is not terminal — it can still be refunded", () => {
    expect(TERMINAL_STATES).not.toContain("FAILED");
    expect(canTransition("FAILED", "REFUNDED")).toBe(true);
  });

  it("compensates instead of refunding once the escrow may be released", () => {
    // A released escrow cannot be refunded, so the failure exit becomes
    // COMPENSATION_PENDING → COMPENSATED. It starts anywhere settlement may
    // already have landed — including CONFIRMED_ONCHAIN, where the settle tx can
    // be in flight while the DB has not heard back yet.
    for (const from of ["CONFIRMED_ONCHAIN", "FX_OR_SWAP_COMPLETED", "PAYOUT_PENDING"] as const) {
      expect(canTransition(from, "COMPENSATION_PENDING"), `${from} → COMPENSATION_PENDING`).toBe(true);
    }
    expect(canTransition("COMPENSATION_PENDING", "COMPENSATED")).toBe(true);

    // Before the escrow exists there is nothing to compensate — those failures refund.
    for (const from of ["DRAFT", "APPROVED", "LIQUIDITY_RESERVED", "SUBMITTED_ONCHAIN"] as const) {
      expect(canTransition(from, "COMPENSATION_PENDING"), `${from} → COMPENSATION_PENDING`).toBe(false);
    }
    // No shortcut past the pending state, and no falling back to a refund once
    // compensation has started.
    expect(canTransition("PAYOUT_PENDING", "COMPENSATED")).toBe(false);
    expect(canTransition("COMPENSATION_PENDING", "REFUNDED")).toBe(false);
    expect(canTransition("COMPENSATION_PENDING", "FAILED")).toBe(false);
  });

  it("COMPENSATED is terminal", () => {
    expect(TERMINAL_STATES).toContain("COMPENSATED");
    expect(TERMINAL_STATES).not.toContain("COMPENSATION_PENDING");
  });

  it("cancellation is only possible before execution", () => {
    for (const s of CANCELLABLE_STATES) {
      expect(canTransition(s, "CANCELLED"), `${s} → CANCELLED`).toBe(true);
    }
    expect(canTransition("SUBMITTED_ONCHAIN", "CANCELLED")).toBe(false);
    expect(canTransition("SETTLED", "CANCELLED")).toBe(false);
  });

  it("assertTransition throws a descriptive error on illegal moves", () => {
    expect(() => assertTransition("DRAFT", "SETTLED")).toThrow(/Invalid payment state transition: DRAFT → SETTLED/);
    expect(() => assertTransition("DRAFT", "QUOTED")).not.toThrow();
  });

  it("re-quoting a quoted payment is allowed", () => {
    expect(canTransition("QUOTED", "QUOTED")).toBe(true);
  });
});
