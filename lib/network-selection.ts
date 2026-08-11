/**
 * Reconcile a payment form's source/destination network ids against the
 * networks that actually have deployments. Pure — no DOM, no fetch — so the
 * node vitest suite can prove the invariant the create-payment form violated
 * on the first Render deploy (select showed Base Sepolia while React state
 * still held base-local).
 */

export type NetworkSelection = {
  source: string;
  destination: string;
};

/**
 * Return a selection whose members are always in `available` when that list
 * is non-empty. A still-valid current pick is preserved; only invalid legs
 * fall back to the first available id. An empty `available` leaves `current`
 * untouched (do not blank the form before the fetch resolves, or on total
 * outage).
 */
export function reconcileNetworkSelection(
  current: NetworkSelection,
  available: readonly string[]
): NetworkSelection {
  if (available.length === 0) {
    return { source: current.source, destination: current.destination };
  }
  const ids = new Set(available);
  const fallback = available[0]!;
  return {
    source: ids.has(current.source) ? current.source : fallback,
    destination: ids.has(current.destination) ? current.destination : fallback,
  };
}
