import { randomBytes } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { audit } from "@/lib/audit";
import {
  ADMIN_CREDENTIAL_ID,
  hashPassword,
  verifyPassword,
} from "@/lib/admin-auth";
import {
  actorOf,
  caughtErrorResponse,
  invalidRequest,
  requireRole,
  unauthorized,
} from "../../guard";
import { beginWrite } from "../../limits";

/** Matches `SALT_BYTES` in lib/admin-auth.ts — a fresh salt per write. */
const SALT_BYTES = 16;

function misconfigured(): NextResponse {
  return NextResponse.json(
    { error_code: "internal", message: "admin session is not configured" },
    { status: 500 }
  );
}

/**
 * Change the operator password. The /admin layout does not cover this route —
 * a cookie of any role can hit it with curl — so the OPERATOR guard lives here.
 *
 * Re-authenticates with the current password before writing. A stolen sos_key
 * cookie is not enough to take over the account permanently (AD4: the cookie
 * itself stays valid; this check is what stops the password from moving).
 *
 * Never logs either password. Never trims either password — spaces are
 * legitimate characters (A1's trailing-space round-trip).
 */
export async function POST(req: NextRequest) {
  const principal = await requireRole(req, "OPERATOR");
  if (principal instanceof NextResponse) return principal;

  const gate = await beginWrite(req, principal);
  if (gate instanceof NextResponse) return gate;

  try {
    const body = (gate.body ?? {}) as {
      current_password?: unknown;
      new_password?: unknown;
    };
    // Do not trim — leading/trailing spaces are part of the secret.
    const currentPassword = typeof body.current_password === "string" ? body.current_password : "";
    const newPassword = typeof body.new_password === "string" ? body.new_password : "";

    if (newPassword === "") {
      return invalidRequest("new_password is required");
    }

    const cred = await prisma.adminCredential.findUnique({
      where: { id: ADMIN_CREDENTIAL_ID },
    });
    if (!cred) {
      console.error("[api] POST /api/admin/password no AdminCredential row");
      return misconfigured();
    }

    const currentOk = await verifyPassword(currentPassword, cred.passwordHash, cred.salt);
    if (!currentOk) {
      return unauthorized();
    }

    const salt = randomBytes(SALT_BYTES);
    const passwordHash = (await hashPassword(newPassword, salt)).toString("hex");

    await prisma.$transaction(async (tx) => {
      await tx.adminCredential.update({
        where: { id: ADMIN_CREDENTIAL_ID },
        data: {
          passwordHash,
          salt: salt.toString("hex"),
        },
      });
      await audit("admin.password_changed", { id: ADMIN_CREDENTIAL_ID }, undefined, actorOf(principal), tx);
    });

    return NextResponse.json({ ok: true });
  } catch (e) {
    return caughtErrorResponse(e, "internal", "POST /api/admin/password");
  }
}
