/**
 * An entity's wallet on a given network. Addresses differ per network on real
 * testnets; when the exact network is missing, fall back to the first wallet
 * (the local-demo default) rather than inventing an address.
 */
export function walletOnNetwork<T extends { network: string }>(
  wallets: T[],
  networkId: string
): T | undefined {
  return wallets.find((w) => w.network === networkId) ?? wallets[0];
}
