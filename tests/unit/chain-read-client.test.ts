// The read/write RPC split (F1): a network with a declared read replica serves
// balance/display reads from it, while writes — and every read that gates a
// write — stay on the sequencer RPC. lib/networks reads env at import time, so
// each test stubs env and re-imports fresh copies of networks + chain.

import { describe, it, expect, afterEach, vi } from "vitest";

describe("readClientFor", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  async function freshChain() {
    vi.resetModules();
    return await import("@/lib/chain");
  }

  it("without a read RPC, read and write clients are the same object", async () => {
    vi.stubEnv("FORTEL2_SEPOLIA_READ_RPC_URL", "");
    const chain = await freshChain();
    expect(chain.readClientFor("fortel2-sepolia")).toBe(chain.publicClientFor("fortel2-sepolia"));
    // Networks that never declare one behave identically.
    expect(chain.readClientFor("base-sepolia")).toBe(chain.publicClientFor("base-sepolia"));
  });

  it("with a read RPC, reads go to the replica and writes stay on the sequencer", async () => {
    vi.stubEnv("FORTEL2_SEPOLIA_RPC_URL", "http://127.0.0.1:9545");
    vi.stubEnv("FORTEL2_SEPOLIA_READ_RPC_URL", "http://127.0.0.1:9601");
    const chain = await freshChain();
    const read = chain.readClientFor("fortel2-sepolia");
    const write = chain.publicClientFor("fortel2-sepolia");
    expect(read).not.toBe(write);
    expect(read.transport.url).toBe("http://127.0.0.1:9601");
    expect(write.transport.url).toBe("http://127.0.0.1:9545");
  });

  it("fails closed on unknown networks rather than falling back", async () => {
    const chain = await freshChain();
    expect(() => chain.readClientFor("fortel2")).toThrow(/Unknown network/);
    expect(() => chain.publicClientFor("fortel2")).toThrow(/Unknown network/);
  });
});
