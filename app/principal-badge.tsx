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
        className="block rounded-lg border border-slate-700 bg-slate-900/60 px-3 py-2 text-xs text-slate-400 transition-colors hover:border-slate-600 hover:text-slate-200"
      >
        Not signed in — <span className="text-emerald-400">sign in</span>
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
    <div className="rounded-lg border border-slate-700 bg-slate-900/60 p-3">
      <p className="truncate text-xs font-medium text-slate-200" title={label}>
        {label}
      </p>
      <p className="mt-0.5 text-[11px] uppercase tracking-widest text-slate-500">{role}</p>
      <button
        onClick={signOut}
        disabled={busy}
        className="mt-2 text-[11px] text-slate-400 underline underline-offset-2 transition-colors hover:text-slate-200 disabled:opacity-50"
      >
        {busy ? "Signing out…" : "Sign out"}
      </button>
    </div>
  );
}
