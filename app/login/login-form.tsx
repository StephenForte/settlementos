"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Card } from "@/components/ui";

export function LoginForm() {
  const router = useRouter();
  const [key, setKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ api_key: key }),
      });
      if (!res.ok) {
        // Generic on purpose — the route does not say whether the key exists.
        setError("That API key was not accepted.");
        return;
      }
      setKey("");
      // The cookie is set; refresh so the server-rendered shell picks up the
      // new principal before we land on the dashboard.
      router.refresh();
      router.push("/");
    } catch {
      setError("Could not reach the server. Is the app running?");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card>
      <form onSubmit={submit} className="flex flex-col gap-4">
        <div>
          <label htmlFor="api-key" className="text-xs font-medium uppercase tracking-widest text-slate-500">
            API key
          </label>
          <input
            id="api-key"
            value={key}
            onChange={(e) => setKey(e.target.value)}
            type="password"
            autoComplete="off"
            spellCheck={false}
            placeholder="sos_…"
            className="mt-2 w-full rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 font-mono text-sm text-slate-100 focus:border-emerald-500 focus:outline-none disabled:opacity-50"
            disabled={busy}
          />
        </div>
        <button
          type="submit"
          disabled={busy || key.trim() === ""}
          className="rounded-lg bg-emerald-500 px-4 py-2 text-sm font-medium text-emerald-950 hover:bg-emerald-400 disabled:opacity-50"
        >
          {busy ? "Signing in…" : "Sign in"}
        </button>
        {error && (
          <p className="rounded-lg border border-rose-500/40 bg-rose-500/10 px-3 py-2 text-sm text-rose-300">
            {error}
          </p>
        )}
      </form>
    </Card>
  );
}
