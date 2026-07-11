// Chainalysis sanctions oracle — real sanctioned-address detection via the
// free public smart contract (no API key, "does not require a customer
// relationship with Chainalysis"). Docs: https://go.chainalysis.com/chainalysis-oracle-docs.html
//   isSanctioned(address) → bool, read over any public RPC for the chain the
//   oracle is deployed on. 0x40C5…C8fb covers Ethereum, Polygon, BNB,
//   Avalanche, Optimism, Arbitrum, Fantom, Celo, Blast; Base mainnet uses
//   0x3A91A31cB3dC49b4db9Ce721F50a9D076c8D739B (set CHAINALYSIS_ORACLE_ADDRESS).
// Screening is keyed on the address string, so which chain we read from is
// independent of the payment's network — sanctions designations are per
// address, not per chain.

import { createPublicClient, http, isAddress, parseAbi, type Address } from "viem";
import { providerResult, type ProviderResult } from "./types";
import { failSafe, providerTimeoutMs } from "./http";

export const PROVIDER_NAME = "chainalysis_oracle";
export const DEFAULT_ORACLE_ADDRESS = "0x40C57923924B5c5c5455c48D93317139ADDaC8fb";

const ORACLE_ABI = parseAbi(["function isSanctioned(address addr) view returns (bool)"]);

export async function chainalysisOracleScreen(walletAddress: string): Promise<ProviderResult> {
  const rpcUrl = process.env.CHAINALYSIS_ORACLE_RPC_URL;
  if (!rpcUrl) return failSafe(PROVIDER_NAME, "CHAINALYSIS_ORACLE_RPC_URL not configured");
  // Lowercase before validating: EVM addresses are case-insensitive, and a
  // stored address with broken EIP-55 casing must still be screenable.
  const address = walletAddress.toLowerCase();
  if (!isAddress(address)) return failSafe(PROVIDER_NAME, `not a valid EVM address: ${walletAddress}`);

  // `||` not `??`: an empty-string env var means "unset", not "empty address".
  const oracle = (process.env.CHAINALYSIS_ORACLE_ADDRESS || DEFAULT_ORACLE_ADDRESS) as Address;
  try {
    const client = createPublicClient({
      transport: http(rpcUrl, { timeout: providerTimeoutMs(), retryCount: 1 }),
    });
    const [sanctioned, blockNumber] = await Promise.all([
      client.readContract({
        address: oracle,
        abi: ORACLE_ABI,
        functionName: "isSanctioned",
        args: [address],
      }),
      // Evidence only — a failed block-number read must not sink a successful screen.
      client.getBlockNumber().catch(() => null),
    ]);

    // No rpcUrl in the evidence: provider RPC URLs often embed access keys.
    const raw = {
      oracle,
      checked_address: address,
      is_sanctioned: sanctioned,
      block_number: blockNumber === null ? null : blockNumber.toString(),
    };
    if (sanctioned) return providerResult(PROVIDER_NAME, "FAIL", 100, ["wallet_sanctioned"], raw);
    return providerResult(PROVIDER_NAME, "PASS", 0, [], raw);
  } catch (err) {
    return failSafe(PROVIDER_NAME, err);
  }
}
