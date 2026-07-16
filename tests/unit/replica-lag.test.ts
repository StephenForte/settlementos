// retryOnReplicaLag (lib/chain): bounded retry for writes that transiently
// revert when a load-balanced public RPC gas-estimates against a replica that
// hasn't seen the previous block yet (observed live on Base Sepolia: settle
// reverted "not initiated" seconds after the escrow tx confirmed).

import { describe, it, expect, vi } from "vitest";
import { retryOnReplicaLag } from "@/lib/chain";

const isNotInitiated = (message: string) => message.includes("not initiated");

describe("retryOnReplicaLag", () => {
  it("returns immediately on first success", async () => {
    const fn = vi.fn().mockResolvedValue("0xhash");
    await expect(retryOnReplicaLag(fn, isNotInitiated)).resolves.toBe("0xhash");
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("retries transient reverts until the replica catches up", async () => {
    const fn = vi
      .fn()
      .mockRejectedValueOnce(new Error("execution reverted: not initiated"))
      .mockRejectedValueOnce(new Error("execution reverted: not initiated"))
      .mockResolvedValue("0xhash");
    await expect(retryOnReplicaLag(fn, isNotInitiated, { delayMs: 1 })).resolves.toBe("0xhash");
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it("rethrows non-transient errors without retrying", async () => {
    const fn = vi.fn().mockRejectedValue(new Error("insufficient funds for gas"));
    await expect(retryOnReplicaLag(fn, isNotInitiated, { delayMs: 1 })).rejects.toThrow(
      /insufficient funds/
    );
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("gives up after the retry budget and surfaces the original error", async () => {
    const fn = vi.fn().mockRejectedValue(new Error("execution reverted: not initiated"));
    await expect(
      retryOnReplicaLag(fn, isNotInitiated, { retries: 3, delayMs: 1 })
    ).rejects.toThrow(/not initiated/);
    expect(fn).toHaveBeenCalledTimes(4); // initial attempt + 3 retries
  });
});
