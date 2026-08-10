"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";

/** Plain props from the server layout — never copy these into state, or the badge
 *  goes stale after a sign-in (see AGENTS.md on the server-parent/client-child pattern). */
export interface PrincipalBadgeProps {
  label: string | null;
  role: string | null;
}

export function PrincipalBadge({ label, role }: PrincipalBadgeProps) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);

  if (!label || !role) {
    return (
      <Link
        href="/login"
        className="block rounded-md border border-mute bg-canvas px-3 py-2 text-xs text-body transition-colors hover:border-ink hover:text-ink"
      >
        Not signed in — <span className="text-primary">sign in</span>
      </Link>
    );
  }

  async function signOut() {
    setBusy(true);
    try {
      await fetch("/api/auth/logout", { method: "POST" });
      router.refresh();
      router.push("/login");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="rounded-md border border-mute bg-canvas p-3">
      <p className="truncate text-xs font-medium text-ink" title={label}>
        {label}
      </p>
      <p className="mt-0.5 text-[11px] uppercase tracking-widest text-body">{role}</p>
      <button
        onClick={signOut}
        disabled={busy}
        className="mt-2 text-[11px] text-body underline underline-offset-2 transition-colors hover:text-ink disabled:opacity-50"
      >
        {busy ? "Signing out…" : "Sign out"}
      </button>
    </div>
  );
}
