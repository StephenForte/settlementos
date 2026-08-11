// Single overlay resolver (lib/overlay-paths.mjs) — the shared half used by
// lib/chain.ts and scripts/seed-demo.mjs. Matrix covers CHAIN_DIR set/unset,
// overlay in chain dir / secret mount / neither, and cwd ≠ repo root.

import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  resolveChainDir,
  resolveLiveOverlayPath,
  resolveSecretOverlayDir,
} from "@/lib/overlay-paths.mjs";

const BASE = "base-sepolia";

afterEach(() => {
  delete process.env.SETTLEMENTOS_CHAIN_DIR;
  delete process.env.SETTLEMENTOS_SECRET_OVERLAY_DIR;
});

function writeOverlay(dir: string, networkId = BASE) {
  const p = path.join(dir, `deployments.${networkId}.json`);
  fs.writeFileSync(p, JSON.stringify({ networks: { [networkId]: { chainId: 1 } } }));
  return p;
}

describe("lib/overlay-paths.mjs", () => {
  it("defaults CHAIN_DIR to <cwd>/chain when SETTLEMENTOS_CHAIN_DIR is unset", () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "sos-cwd-"));
    expect(resolveChainDir({ cwd, env: {} })).toBe(path.join(cwd, "chain"));
  });

  it("honours SETTLEMENTOS_CHAIN_DIR when set", () => {
    const dir = "/tmp/explicit-chain-dir";
    expect(resolveChainDir({ cwd: "/somewhere/else", env: { SETTLEMENTOS_CHAIN_DIR: dir } })).toBe(
      dir
    );
  });

  it("defaults secret mount to /etc/secrets", () => {
    expect(resolveSecretOverlayDir({ env: {} })).toBe(path.join(path.sep, "etc", "secrets"));
  });

  it("resolves overlay from CHAIN_DIR when present", () => {
    const chainDir = fs.mkdtempSync(path.join(os.tmpdir(), "sos-chain-"));
    const secretsDir = fs.mkdtempSync(path.join(os.tmpdir(), "sos-secrets-"));
    const written = writeOverlay(chainDir);
    const resolved = resolveLiveOverlayPath(BASE, {
      chainDir,
      secretDir: secretsDir,
    });
    expect(resolved).toBe(path.resolve(written));
  });

  it("falls back to secret mount when CHAIN_DIR has no overlay", () => {
    const chainDir = fs.mkdtempSync(path.join(os.tmpdir(), "sos-chain-"));
    const secretsDir = fs.mkdtempSync(path.join(os.tmpdir(), "sos-secrets-"));
    const written = writeOverlay(secretsDir);
    const resolved = resolveLiveOverlayPath(BASE, {
      chainDir,
      secretDir: secretsDir,
    });
    expect(resolved).toBe(path.resolve(written));
  });

  it("returns null when neither location has the overlay", () => {
    const chainDir = fs.mkdtempSync(path.join(os.tmpdir(), "sos-chain-"));
    const secretsDir = fs.mkdtempSync(path.join(os.tmpdir(), "sos-secrets-"));
    expect(
      resolveLiveOverlayPath(BASE, {
        chainDir,
        secretDir: secretsDir,
      })
    ).toBeNull();
  });

  it("prefers CHAIN_DIR over the secret mount when both exist", () => {
    const chainDir = fs.mkdtempSync(path.join(os.tmpdir(), "sos-chain-"));
    const secretsDir = fs.mkdtempSync(path.join(os.tmpdir(), "sos-secrets-"));
    const preferred = writeOverlay(chainDir);
    writeOverlay(secretsDir);
    expect(
      resolveLiveOverlayPath(BASE, {
        chainDir,
        secretDir: secretsDir,
      })
    ).toBe(path.resolve(preferred));
  });

  it("uses cwd for the default chain dir even when cwd ≠ a sibling 'repo root'", () => {
    // Documents the app/seed contract: resolution is process.cwd()-relative,
    // not the script file's directory. A stale worktree with a different cwd
    // is the failure mode this single implementation closes.
    const otherRoot = fs.mkdtempSync(path.join(os.tmpdir(), "sos-repo-"));
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "sos-cwd-"));
    const chainUnderCwd = path.join(cwd, "chain");
    fs.mkdirSync(chainUnderCwd);
    const written = writeOverlay(chainUnderCwd);
    // Overlay also under "repo" — must NOT win when cwd points elsewhere.
    const chainUnderRepo = path.join(otherRoot, "chain");
    fs.mkdirSync(chainUnderRepo);
    writeOverlay(chainUnderRepo);

    const resolved = resolveLiveOverlayPath(BASE, {
      cwd,
      env: {},
      secretDir: fs.mkdtempSync(path.join(os.tmpdir(), "sos-secrets-")),
    });
    expect(resolved).toBe(path.resolve(written));
  });
});
