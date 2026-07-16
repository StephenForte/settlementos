// The custody seam: which Signer an account ref resolves to, and what each one
// does when asked to sign. Pure — no chain, no DB.

import { describe, it, expect, afterEach } from "vitest";
import type { Address, Hex } from "viem";
import { signerFor, resolveKey, LocalKeySigner, KmsSigner } from "@/lib/signers";

// Hardhat dev-mnemonic account #0 — a published test key, never a real one.
const KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80" as Hex;
const ADDR = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266" as Address;
const OTHER = "0x0000000000000000000000000000000000000dead" as Address;

const ENV_VAR = "SETTLEMENTOS_TEST_SIGNER_KEY";
afterEach(() => {
  delete process.env[ENV_VAR];
});

describe("signerFor", () => {
  it("gives an inline key a LocalKeySigner that builds the matching account", async () => {
    const signer = signerFor({ address: ADDR, privateKey: KEY }, "test");
    expect(signer).toBeInstanceOf(LocalKeySigner);
    expect(signer.address).toBe(ADDR);
    expect((await signer.account()).address).toBe(ADDR);
  });

  it("reads a key from the env var the ref names, at signing time not construction", async () => {
    const signer = signerFor({ address: ADDR, privateKeyEnv: ENV_VAR }, "test");
    // Constructing must not touch the environment — the key can arrive later.
    process.env[ENV_VAR] = KEY;
    expect((await signer.account()).address).toBe(ADDR);
  });

  it("routes a kmsKeyId ref to the KmsSigner stub, which refuses to sign", async () => {
    const signer = signerFor({ address: OTHER, kmsKeyId: "alias/operator" }, "base-sepolia operator");
    expect(signer).toBeInstanceOf(KmsSigner);
    // The address is known without key material, so callers can still read balances.
    expect(signer.address).toBe(OTHER);
    await expect(signer.account()).rejects.toThrow(/not configured/);
  });

  it("prefers KMS over an inline key when a ref carries both", () => {
    // Belt and braces: a ref migrated to KMS must not silently keep hot-signing.
    expect(signerFor({ address: ADDR, privateKey: KEY, kmsKeyId: "alias/x" }, "test")).toBeInstanceOf(
      KmsSigner
    );
  });
});

describe("resolveKey", () => {
  it("names the env var to set when a referenced key is missing", () => {
    expect(() => resolveKey({ address: ADDR, privateKeyEnv: ENV_VAR }, "operator")).toThrow(
      new RegExp(`operator.*Set ${ENV_VAR} in .env`, "s")
    );
  });

  it("points at the deploy script when an inline key is missing", () => {
    expect(() => resolveKey({ address: ADDR }, "treasury")).toThrow(/Re-run the deploy script/);
  });

  it("rejects a non-hex key rather than handing it to viem", () => {
    process.env[ENV_VAR] = "not-a-key";
    expect(() => resolveKey({ address: ADDR, privateKeyEnv: ENV_VAR }, "operator")).toThrow(
      /Missing private key/
    );
  });
});
