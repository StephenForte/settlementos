// Shared live-network overlay path resolution for lib/chain.ts and
// scripts/seed-demo.mjs. Framework-free: no server-only, no Prisma, no Next —
// the same spirit as lib/networks.ts being the client-safe half of chain.
//
// Resolution order: SETTLEMENTOS_CHAIN_DIR (default <cwd>/chain), then
// SETTLEMENTOS_SECRET_OVERLAY_DIR (default /etc/secrets) for Render Secret Files.

import fs from "node:fs";
import path from "node:path";

/**
 * @param {{ cwd?: string, env?: Record<string, string | undefined> }} [opts]
 * @returns {string}
 */
export function resolveChainDir(opts = {}) {
  const cwd = opts.cwd ?? process.cwd();
  const env = opts.env ?? process.env;
  return env.SETTLEMENTOS_CHAIN_DIR || path.join(cwd, "chain");
}

/**
 * @param {{ env?: Record<string, string | undefined> }} [opts]
 * @returns {string}
 */
export function resolveSecretOverlayDir(opts = {}) {
  const env = opts.env ?? process.env;
  return env.SETTLEMENTOS_SECRET_OVERLAY_DIR || path.join(path.sep, "etc", "secrets");
}

/**
 * Absolute path to deployments.<networkId>.json, or null if absent from both
 * candidate directories.
 *
 * @param {string} networkId
 * @param {{
 *   cwd?: string,
 *   env?: Record<string, string | undefined>,
 *   chainDir?: string,
 *   secretDir?: string,
 *   existsSync?: (p: string) => boolean,
 * }} [opts]
 * @returns {string | null}
 */
export function resolveLiveOverlayPath(networkId, opts = {}) {
  const chainDir = opts.chainDir ?? resolveChainDir(opts);
  const secretDir = opts.secretDir ?? resolveSecretOverlayDir(opts);
  const exists = opts.existsSync ?? ((p) => fs.existsSync(p));
  const candidates = [path.join(chainDir, `deployments.${networkId}.json`)];
  if (path.resolve(chainDir) !== path.resolve(secretDir)) {
    candidates.push(path.join(secretDir, `deployments.${networkId}.json`));
  }
  for (const p of candidates) {
    if (exists(p)) return path.resolve(p);
  }
  return null;
}
