import { afterEach, describe, expect, it, vi } from "vitest";
import { nativeBalance, publicClientFor, readClientFor } from "@/lib/chain";

const ADDR = "0x1111111111111111111111111111111111111111" as const;

describe("nativeBalance", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("reads getBalance on the write client by default, like tokenBalance", async () => {
    const spy = vi.spyOn(publicClientFor("base-local"), "getBalance").mockResolvedValue(42n);
    await expect(nativeBalance("base-local", ADDR)).resolves.toBe(42n);
    expect(spy).toHaveBeenCalledWith({ address: ADDR });
  });

  it("reads getBalance on the read client when viaReadRpc is set", async () => {
    const spy = vi.spyOn(readClientFor("base-local"), "getBalance").mockResolvedValue(7n);
    await expect(nativeBalance("base-local", ADDR, { viaReadRpc: true })).resolves.toBe(7n);
    expect(spy).toHaveBeenCalledWith({ address: ADDR });
  });
});
