"use client";

import { useState } from "react";
import type { CopyAddressProps } from "./props";

export function CopyAddress({ address }: CopyAddressProps) {
  const [copied, setCopied] = useState(false);

  async function onCopy() {
    await navigator.clipboard.writeText(address);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1500);
  }

  return (
    <button
      type="button"
      onClick={onCopy}
      className="rounded-md border border-mute px-2 py-0.5 text-[11px] font-medium text-ink-mid hover:border-primary hover:text-ink"
    >
      {copied ? "Copied" : "Copy"}
    </button>
  );
}
