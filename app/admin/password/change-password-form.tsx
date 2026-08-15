"use client";

import { useState } from "react";
import { Card } from "@/components/ui";

export function ChangePasswordForm() {
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setDone(false);

    // Compare as typed — do not trim. Spaces are legitimate password characters.
    if (newPassword !== confirmPassword) {
      setError("New password and confirmation do not match.");
      return;
    }

    setBusy(true);
    try {
      const res = await fetch("/api/admin/password", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          current_password: currentPassword,
          new_password: newPassword,
        }),
      });
      if (!res.ok) {
        if (res.status === 401) {
          setError("Current password was not accepted.");
        } else if (res.status === 400) {
          setError("New password is required.");
        } else {
          setError("Could not change the password. Check server configuration.");
        }
        return;
      }
      setCurrentPassword("");
      setNewPassword("");
      setConfirmPassword("");
      setDone(true);
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
          <label htmlFor="current-password" className="text-xs font-medium uppercase tracking-widest text-body">
            Current password
          </label>
          <input
            id="current-password"
            value={currentPassword}
            onChange={(e) => setCurrentPassword(e.target.value)}
            type="password"
            autoComplete="current-password"
            className="mt-2 w-full rounded-md border border-mute bg-canvas px-3 py-2 text-sm text-ink focus:border-primary focus:outline-none disabled:opacity-50"
            disabled={busy}
          />
        </div>
        <div>
          <label htmlFor="new-password" className="text-xs font-medium uppercase tracking-widest text-body">
            New password
          </label>
          <input
            id="new-password"
            value={newPassword}
            onChange={(e) => setNewPassword(e.target.value)}
            type="password"
            autoComplete="new-password"
            className="mt-2 w-full rounded-md border border-mute bg-canvas px-3 py-2 text-sm text-ink focus:border-primary focus:outline-none disabled:opacity-50"
            disabled={busy}
          />
        </div>
        <div>
          <label htmlFor="confirm-password" className="text-xs font-medium uppercase tracking-widest text-body">
            Confirm new password
          </label>
          <input
            id="confirm-password"
            value={confirmPassword}
            onChange={(e) => setConfirmPassword(e.target.value)}
            type="password"
            autoComplete="new-password"
            className="mt-2 w-full rounded-md border border-mute bg-canvas px-3 py-2 text-sm text-ink focus:border-primary focus:outline-none disabled:opacity-50"
            disabled={busy}
          />
        </div>
        <p className="text-xs text-body">
          Existing sessions stay signed in. The new password is required only for
          the next sign-in.
        </p>
        <button
          type="submit"
          disabled={busy || currentPassword === "" || newPassword === ""}
          className="rounded-md bg-primary px-4 py-2 text-sm font-semibold text-ink hover:opacity-90 disabled:opacity-50"
        >
          {busy ? "Saving…" : "Change password"}
        </button>
      </form>
      {error && (
        <p className="mt-4 rounded-md border border-danger-border bg-danger-bg px-3 py-2 text-sm text-danger-fg">
          {error}
        </p>
      )}
      {done && (
        <p className="mt-4 rounded-md border border-mute bg-canvas px-3 py-2 text-sm text-body">
          Password updated. Existing sessions stay signed in.
        </p>
      )}
    </Card>
  );
}
