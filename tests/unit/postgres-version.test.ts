// Local Homebrew, CI, and Render settlementos-db stay on the same Postgres
// major. The pin moved 16 → 18 together on 2026-10-27. A lone host on 16
// reintroduces the skew the pin exists to prevent.

import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { ROOT } from "../fixture";

const MAJOR = "18";

describe("Postgres major pin", () => {
  const agents = fs.readFileSync(path.join(ROOT, "AGENTS.md"), "utf8");
  const runbook = fs.readFileSync(path.join(ROOT, "tasks/runbooks/render-deploy.md"), "utf8");
  const ci = fs.readFileSync(path.join(ROOT, ".github/workflows/ci.yml"), "utf8");

  it("pins CI, the engineering guide, and the Render runbook to Postgres 18", () => {
    expect(ci).toMatch(new RegExp(`image:\\s*postgres:${MAJOR}\\s*$`, "m"));
    expect(ci).not.toMatch(/image:\s*postgres:16\b/);
    expect(agents).toContain(`postgresql@${MAJOR}`);
    expect(agents).toContain(`postgres:${MAJOR}`);
    expect(agents).not.toMatch(/postgresql@16|postgres:16|Postgres 16/);
    expect(runbook).toContain(`postgres:${MAJOR}`);
    expect(runbook).toContain(`postgresql@${MAJOR}`);
    expect(runbook).not.toMatch(/postgresql@16|postgres:16/);
  });
});
