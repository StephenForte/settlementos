"use client";

import { useState } from "react";
import { Card } from "@/components/ui";

export function LoginForm() {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [key, setKey] = useState("");
  const [busy, setBusy] = useState<"password" | "key" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showKey, setShowKey] = useState(false);

  async function submitPassword(e: React.FormEvent) {
    e.preventDefault();
    setBusy("password");
    setError(null);
    try {
      const res = await fetch("/api/auth/session", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username, password }),
      });
      if (!res.ok) {
        setError(res.status === 401 ? "That username or password was not accepted." : "Could not sign in. Check server configuration.");
        return;
      }
      setUsername("");
      setPassword("");
      window.location.assign("/");
    } catch {
      setError("Could not reach the server. Is the app running?");
    } finally {
      setBusy(null);
    }
  }

  async function submitKey(e: React.FormEvent) {
    e.preventDefault();
    setBusy("key");
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
      // Cookie changed under the root layout's currentPrincipal() — a client
      // navigation can serve a pre-cookie RSC payload for "/", leaving the
      // shell anonymous. Full document load is the only reliable refresh.
      window.location.assign("/");
    } catch {
      setError("Could not reach the server. Is the app running?");
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <Card>
        <form onSubmit={submitPassword} className="flex flex-col gap-4">
          <div>
            <label htmlFor="admin-username" className="text-xs font-medium uppercase tracking-widest text-body">
              Username
            </label>
            <input
              id="admin-username"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              type="text"
              autoComplete="username"
              spellCheck={false}
              className="mt-2 w-full rounded-md border border-mute bg-canvas px-3 py-2 text-sm text-ink focus:border-primary focus:outline-none disabled:opacity-50"
              disabled={busy !== null}
            />
          </div>
          <div>
            <label htmlFor="admin-password" className="text-xs font-medium uppercase tracking-widest text-body">
              Password
            </label>
            <input
              id="admin-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              type="password"
              autoComplete="current-password"
              className="mt-2 w-full rounded-md border border-mute bg-canvas px-3 py-2 text-sm text-ink focus:border-primary focus:outline-none disabled:opacity-50"
              disabled={busy !== null}
            />
          </div>
          <button
            type="submit"
            disabled={busy !== null || username.trim() === "" || password === ""}
            className="rounded-md bg-primary px-4 py-2 text-sm font-semibold text-ink hover:opacity-90 disabled:opacity-50"
          >
            {busy === "password" ? "Signing in…" : "Sign in"}
          </button>
        </form>
      </Card>

      <button
        type="button"
        onClick={() => setShowKey((v) => !v)}
        className="self-start text-xs text-body hover:text-ink hover:underline"
      >
        {showKey ? "Hide API-key sign-in" : "Sign in with an API key"}
      </button>

      {showKey && (
        <Card title="API key">
          <form onSubmit={submitKey} className="flex flex-col gap-4">
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
                disabled={busy !== null}
              />
            </div>
            <button
              type="submit"
              disabled={busy !== null || key.trim() === ""}
              className="rounded-md bg-primary px-4 py-2 text-sm font-semibold text-ink hover:opacity-90 disabled:opacity-50"
            >
              {busy === "key" ? "Signing in…" : "Sign in with API key"}
            </button>
          </form>
        </Card>
      )}

      {error && (
        <p className="rounded-md border border-danger-border bg-danger-bg px-3 py-2 text-sm text-danger-fg">
          {error}
        </p>
      )}
    </div>
  );
}
