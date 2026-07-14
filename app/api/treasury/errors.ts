// Shared HTTP mapping for the treasury routes. lib/treasury throws only
// TreasuryError with a typed code, so the code -> status table lives here once
// and every route handler stays thin.

import { NextResponse } from "next/server";
import { TreasuryError, type TreasuryErrorCode } from "@/lib/treasury";

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

export function treasuryErrorResponse(e: unknown) {
  if (e instanceof TreasuryError) {
    return NextResponse.json({ error: e.message, code: e.code }, { status: STATUS[e.code] });
  }
  return NextResponse.json({ error: (e as Error).message }, { status: 500 });
}
