// Render runs Node 26.12.1 or newer (the 2026-10-21 security floor).
// Local and CI stay on Node 22: .node-version and the CI workflow must not
// be swept along, and engines.node must accept both or `npm ci` on Render
// rejects the runtime the blueprint just selected.
//
// NODE_VERSION outranks .node-version on Render. The pin is an exact
// major.minor.patch so Render does not resolve a range to whatever "latest"
// is this week.

import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { ROOT } from "../fixture";

const FLOOR = [26, 12, 1] as const;
const LOCAL_PIN = "22.23.1";

type Semver = readonly [number, number, number];

function parseExact(raw: string): Semver {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(raw.trim());
  if (!match) throw new Error(`expected exact major.minor.patch, got ${raw}`);
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

function atLeast(version: Semver, floor: Semver): boolean {
  for (let i = 0; i < 3; i++) {
    if (version[i] > floor[i]) return true;
    if (version[i] < floor[i]) return false;
  }
  return true;
}

function satisfies(version: string, range: string): boolean {
  const parsed = parseExact(version);
  return range.split("||").some((alternative) => {
    const clause = alternative.trim();
    if (/^\d+\.\d+\.\d+$/.test(clause)) return clause === version;
    const floor = /^>=(\d+\.\d+\.\d+)$/.exec(clause);
    return floor !== null && atLeast(parsed, parseExact(floor[1]));
  });
}

function renderNodePin(yaml: string): string {
  const match = yaml.match(/- key: NODE_VERSION\r?\n\s+value: "([^"]+)"/);
  if (!match) throw new Error("render.yaml has no NODE_VERSION value");
  return match[1];
}

describe("Render Node pin", () => {
  const yaml = fs.readFileSync(path.join(ROOT, "render.yaml"), "utf8");
  const pin = renderNodePin(yaml);
  const runbook = fs.readFileSync(
    path.join(ROOT, "tasks/runbooks/render-deploy.md"),
    "utf8",
  );
  const agents = fs.readFileSync(path.join(ROOT, "AGENTS.md"), "utf8");
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8")) as {
    engines: { node: string };
  };
  const lock = JSON.parse(fs.readFileSync(path.join(ROOT, "package-lock.json"), "utf8")) as {
    packages: { "": { engines: { node: string } } };
  };

  it("pins an exact Render runtime at or above 26.12.1", () => {
    expect(atLeast(parseExact(pin), FLOOR)).toBe(true);
    expect(yaml).toContain(`value: "${pin}"`);
  });

  it("keeps the local pin on Node 22 and accepts both lines in engines", () => {
    expect(fs.readFileSync(path.join(ROOT, ".node-version"), "utf8").trim()).toBe(LOCAL_PIN);
    expect(pin).not.toBe(LOCAL_PIN);
    expect(satisfies(LOCAL_PIN, pkg.engines.node)).toBe(true);
    expect(satisfies(pin, pkg.engines.node)).toBe(true);
    expect(lock.packages[""].engines.node).toBe(pkg.engines.node);

    const ci = fs.readFileSync(path.join(ROOT, ".github/workflows/ci.yml"), "utf8");
    expect(ci).toMatch(/node-version:\s*22\s*$/m);
  });

  it("documents the same Render pin in the runbook and the engineering guide", () => {
    expect(runbook).toContain(`NODE_VERSION=${pin}`);
    expect(runbook).toContain(`v${pin}`);
    expect(runbook).toContain(`\`node -v\` is \`v${pin}\` or newer`);
    expect(runbook).toContain(LOCAL_PIN);
    expect(agents).toContain(`\`${pin}\``);
    expect(agents).toContain(`.node-version\` is \`${LOCAL_PIN}\``);
  });
});
