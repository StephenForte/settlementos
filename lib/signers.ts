// The one place a signing key becomes a viem account.
//
// Every runtime write — operator escrow calls, treasury transfers, an entity's
// per-payment approval — resolves its signer here, so custody is a single seam
// rather than a habit spread across lib/chain.ts. Today that seam holds hot keys
// (LocalKeySigner: inline for generated dust wallets, `privateKeyEnv` -> .env for
// funded ones). Moving to a KMS/HSM means implementing one interface, not
// touching a caller: see KmsSigner below.
//
// Deploy-time credentials are deliberately NOT in scope here. scripts/*.mjs read
// DEPLOYER_PRIVATE_KEY straight from the environment and never import this
// module (they cannot — see the server-only import); this layer is the runtime
// half. See AGENTS.md "Key custody".

import "server-only";
import { privateKeyToAccount } from "viem/accounts";
import type { Account, Address, Hex } from "viem";

/** An account role. Either the key is stored inline (local dev chains, generated
 *  testnet wallets holding faucet dust) or referenced via an env var (funded keys).
 *  `kmsKeyId` names a key this process never holds — see KmsSigner. */
export interface AccountRef {
  address: Address;
  privateKey?: Hex;
  privateKeyEnv?: string;
  kmsKeyId?: string;
}

/**
 * A signing identity. `address` is known without touching key material (it comes
 * off the deployment record), so a caller can check balances and allowances
 * before deciding to sign anything; `account()` is what actually authorizes a
 * write, and is async because a remote signer has to go fetch something.
 */
export interface Signer {
  readonly address: Address;
  account(): Promise<Account>;
}

/** A hot key held in this process: the only custody model the demo has. */
export class LocalKeySigner implements Signer {
  constructor(
    readonly address: Address,
    private readonly ref: AccountRef,
    private readonly role: string
  ) {}

  async account(): Promise<Account> {
    return privateKeyToAccount(resolveKey(this.ref, this.role));
  }
}

/**
 * The extension point, deliberately unimplemented. A real deployment keeps the
 * operator/treasury keys in a KMS or HSM and signs by RPC, so key material never
 * enters this process — the implementation would build a viem account with
 * `toAccount({ address, signTransaction, signMessage, signTypedData })` whose
 * signers call the KMS, and nothing above this file would change.
 */
export class KmsSigner implements Signer {
  constructor(
    readonly address: Address,
    private readonly keyId: string,
    private readonly role: string
  ) {}

  async account(): Promise<Account> {
    throw new Error(
      `KMS signer not configured for ${this.role} (${this.address}, key ${this.keyId}). ` +
        "lib/signers.ts KmsSigner is a stub — implement it, or point this account at a local key."
    );
  }
}

/** Resolve an account's signing key (inline or from the env var it references). */
export function resolveKey(ref: AccountRef, role: string): Hex {
  const key = ref.privateKey ?? (ref.privateKeyEnv ? process.env[ref.privateKeyEnv] : undefined);
  if (!key || !key.startsWith("0x")) {
    throw new Error(
      `Missing private key for ${role} (${ref.address}). ${
        ref.privateKeyEnv ? `Set ${ref.privateKeyEnv} in .env` : "Re-run the deploy script"
      }`
    );
  }
  return key as Hex;
}

/**
 * The signer for an account role. Custody is chosen per account by what the
 * deployment record carries, so a single role (say a live network's treasury)
 * can move to a KMS while the local dev chains keep their mnemonic keys.
 */
export function signerFor(ref: AccountRef, role: string): Signer {
  if (ref.kmsKeyId) return new KmsSigner(ref.address, ref.kmsKeyId, role);
  return new LocalKeySigner(ref.address, ref, role);
}
