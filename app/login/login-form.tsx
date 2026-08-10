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
          <label htmlFor="api-key" className="text-xs font-medium uppercase tracking-widest text-body">
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
            className="mt-2 w-full rounded-md border border-mute bg-canvas px-3 py-2 font-mono text-sm text-ink focus:border-primary focus:outline-none disabled:opacity-50"
            disabled={busy}
          />
        </div>
        <button
          type="submit"
          disabled={busy || key.trim() === ""}
          className="rounded-md bg-primary px-4 py-2 text-sm font-semibold text-ink hover:opacity-90 disabled:opacity-50"
        >
          {busy ? "Signing in…" : "Sign in"}
        </button>
        {error && (
          <p className="rounded-md border border-danger-border bg-danger-bg px-3 py-2 text-sm text-danger-fg">
            {error}
          </p>
        )}
      </form>
    </Card>
  );
}
