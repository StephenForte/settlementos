import { afterEach, describe, expect, it } from "vitest";
import { auditTestHooks, lockAuditChain } from "@/lib/audit";

afterEach(() => {
  delete auditTestHooks.skipChainLock;
  delete process.env.SETTLEMENTOS_SKIP_AUDIT_CHAIN_LOCK;
});

describe("audit chain lock escape hatch", () => {
  it("honours auditTestHooks.skipChainLock under vitest (no advisory lock call)", async () => {
    auditTestHooks.skipChainLock = true;
    const calls: unknown[] = [];
    const tx = {
      $executeRaw: (...args: unknown[]) => {
        calls.push(args);
        return Promise.resolve(0);
      },
    };
    await lockAuditChain(tx as never);
    expect(calls).toHaveLength(0);
  });

  it("takes the advisory lock when the hook is not armed", async () => {
    const calls: unknown[] = [];
    const tx = {
      $executeRaw: (...args: unknown[]) => {
        calls.push(args);
        return Promise.resolve(0);
      },
    };
    await lockAuditChain(tx as never);
    expect(calls).toHaveLength(1);
  });

  it("throws when SETTLEMENTOS_SKIP_AUDIT_CHAIN_LOCK is set — even under vitest", async () => {
    process.env.SETTLEMENTOS_SKIP_AUDIT_CHAIN_LOCK = "1";
    await expect(lockAuditChain({ $executeRaw: async () => 0 } as never)).rejects.toThrow(
      /SETTLEMENTOS_SKIP_AUDIT_CHAIN_LOCK is set/
    );
  });

  it("refuses to arm auditTestHooks outside the test runner", () => {
    const prev = process.env.VITEST;
    delete process.env.VITEST;
    try {
      expect(() => {
        auditTestHooks.skipChainLock = true;
      }).toThrow(
        /auditTestHooks are test-only and cannot be armed outside the test runner \(attempted to set "skipChainLock"\)/
      );
    } finally {
      if (prev !== undefined) process.env.VITEST = prev;
      else delete process.env.VITEST;
      delete auditTestHooks.skipChainLock;
    }
  });
});
