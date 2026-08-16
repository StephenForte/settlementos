"use client";

import { useState } from "react";

/** Copy control for a contract address. The address stays a prop — never copied into state. */
export function CopyAddress({ address }: { address: string }) {
  const [copied, setCopied] = useState(false);

  async function onCopy() {
    try {
      await navigator.clipboard.writeText(address);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      setCopied(false);
    }
  }

  return (
    <button
      type="button"
      onClick={onCopy}
      className="rounded border border-mute px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-body hover:border-primary hover:text-ink"
      aria-label={`Copy ${address}`}
    >
      {copied ? "Copied" : "Copy"}
    </button>
  );
}
