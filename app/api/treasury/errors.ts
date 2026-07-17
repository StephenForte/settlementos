// Shared HTTP mapping for the treasury routes. lib/treasury throws only
// TreasuryError with a typed code, so the code -> status table lives here once
// and every route handler stays thin.
//
// A TreasuryError's message is domain text the route means to say (guardrails,
// balances), so it is passed through. Anything else thrown is unknown territory
// and goes through the catch-path helper, which logs it and answers generically.

import { NextResponse } from "next/server";
import { apiError, type ApiErrorCode } from "@/lib/api-errors";
import { TreasuryError, type TreasuryErrorCode } from "@/lib/treasury";
import { caughtErrorResponse } from "../guard";

const STATUS: Record<TreasuryErrorCode, number> = {
  NO_FUND: 400,
  UNSUPPORTED_ASSET: 400,
  INVALID_AMOUNT: 400,
  INVALID_RATE: 400,
  INSUFFICIENT_FREE_BALANCE: 409,
  NOT_ELIGIBLE: 403, // institutional-only guardrail: not cleared, or not opted in
  POSITION_NOT_FOUND: 404,
  POSITION_NOT_ACTIVE: 409,
};

/** The stable client-facing code each treasury failure reports as. */
const API_CODE: Record<TreasuryErrorCode, ApiErrorCode> = {
  NO_FUND: "invalid_request",
  UNSUPPORTED_ASSET: "invalid_request",
  INVALID_AMOUNT: "invalid_request",
  INVALID_RATE: "invalid_request",
  INSUFFICIENT_FREE_BALANCE: "conflict",
  NOT_ELIGIBLE: "forbidden",
  POSITION_NOT_FOUND: "not_found",
  POSITION_NOT_ACTIVE: "conflict",
};

export function treasuryErrorResponse(e: unknown) {
  if (e instanceof TreasuryError) {
    // `code` (the treasury vocabulary) rides alongside `error_code` (the stable
    // API one) so the UI can keep branching on the specific guardrail.
    const { body } = apiError(API_CODE[e.code], e.message);
    return NextResponse.json({ ...body, code: e.code }, { status: STATUS[e.code] });
  }
  return caughtErrorResponse(e, "internal", "treasury");
}
