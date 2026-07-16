import { NextResponse } from "next/server";
import { API_KEY_COOKIE } from "@/lib/auth";

/** Drop the session cookie. Always 200 — signing out while anonymous is a no-op. */
export async function POST() {
  const res = NextResponse.json({ signed_out: true });
  res.cookies.delete(API_KEY_COOKIE);
  return res;
}
