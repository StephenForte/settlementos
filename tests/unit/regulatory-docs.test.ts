import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  REGULATORY_DOCS_DIR,
  isInsideDocsDir,
  listMarkdownFilenames,
  listRegulatoryDocs,
  readRegulatoryDoc,
  resolveRegulatoryDoc,
  slugFromFilename,
} from "@/lib/regulatory-docs";

const tmpDirs: string[] = [];

function makePack(files: Record<string, string>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sos-regdocs-"));
  tmpDirs.push(dir);
  for (const [name, body] of Object.entries(files)) {
    fs.writeFileSync(path.join(dir, name), body, "utf8");
  }
  return dir;
}

afterEach(() => {
  while (tmpDirs.length) {
    const dir = tmpDirs.pop()!;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("regulatory docs slug / path resolution", () => {
  it("maps a real pack slug to the expected file under docs/regulatory", () => {
    const resolved = resolveRegulatoryDoc(REGULATORY_DOCS_DIR, "01-technical-architecture");
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    expect(resolved.filename).toBe("01-technical-architecture.md");
    expect(resolved.absolutePath).toBe(
      path.join(path.resolve(REGULATORY_DOCS_DIR), "01-technical-architecture.md"),
    );
    expect(isInsideDocsDir(REGULATORY_DOCS_DIR, resolved.absolutePath)).toBe(true);
  });

  it("resolves readme case-insensitively to README.md", () => {
    const resolved = resolveRegulatoryDoc(REGULATORY_DOCS_DIR, "README");
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    expect(resolved.filename).toBe("README.md");
  });

  it("reads memo content only after allowlisted resolution", () => {
    const body = readRegulatoryDoc(REGULATORY_DOCS_DIR, "03-legal-classification");
    expect(body).toMatch(/STATUS: FROZEN TEMPLATE \(2026-08-10\)/);
    expect(body).toMatch(/Legal Classification Memo/);
  });

  it("lists every .md in the real pack without a hardcoded inventory", () => {
    const names = listMarkdownFilenames(REGULATORY_DOCS_DIR);
    expect(names).toContain("README.md");
    expect(names).toContain("01-technical-architecture.md");
    expect(names).toContain("06-pilot-options.md");
    expect(names.every((n) => n.endsWith(".md"))).toBe(true);

    const index = listRegulatoryDocs(REGULATORY_DOCS_DIR);
    expect(index.map((d) => d.slug)).toEqual(names.map(slugFromFilename));
    expect(index.find((d) => d.slug === "01-technical-architecture")?.description).toMatch(
      /system does/i,
    );
  });

  it("includes a newly added .md in the index with no code change", () => {
    const dir = makePack({
      "README.md": "# Pack\n\n| # | Document | Role in the pack |\n|---|---|---|\n",
      "01-technical-architecture.md": "# Technical architecture\n\nWhat the system does.\n",
    });
    expect(listMarkdownFilenames(dir)).toEqual(["README.md", "01-technical-architecture.md"]);

    fs.writeFileSync(
      path.join(dir, "99-new-memo.md"),
      "# Brand new memo\n\nAppears without a code change.\n",
      "utf8",
    );

    const names = listMarkdownFilenames(dir);
    expect(names).toContain("99-new-memo.md");
    const index = listRegulatoryDocs(dir);
    expect(index.some((d) => d.slug === "99-new-memo" && d.title === "Brand new memo")).toBe(true);
    expect(resolveRegulatoryDoc(dir, "99-new-memo").ok).toBe(true);
  });

  it("404s a slug with no matching file", () => {
    expect(resolveRegulatoryDoc(REGULATORY_DOCS_DIR, "no-such-memo").ok).toBe(false);
    expect(readRegulatoryDoc(REGULATORY_DOCS_DIR, "no-such-memo")).toBeNull();
  });

  /**
   * Crown jewels: a buggy `join(dir, slug)` would open these. Layer 1 (allowlist
   * + plausible-slug grammar) must reject every attack string; layer 2
   * (`isInsideDocsDir`) independently refuses the absolute paths themselves.
   */
  it("refuses path traversal and out-of-tree targets (never a read of .env or overlays)", () => {
    const attacks = [
      "..",
      "../..",
      "../../.env",
      "..%2f..%2f.env",
      "%2e%2e/%2e%2e/.env",
      ".env",
      "/etc/passwd",
      path.resolve(".env"),
      "chain/deployments.base-sepolia.json",
      "../chain/deployments.base-sepolia.json",
      "..%2fchain%2fdeployments.base-sepolia.json",
      "deployments.base-sepolia.json",
    ];

    const envPath = path.resolve(process.cwd(), ".env");
    const overlayPath = path.resolve(process.cwd(), "chain", "deployments.base-sepolia.json");

    // Layer 2 alone: even if a caller handed us these absolute paths, they are
    // outside docs/regulatory.
    expect(isInsideDocsDir(REGULATORY_DOCS_DIR, envPath)).toBe(false);
    expect(isInsideDocsDir(REGULATORY_DOCS_DIR, overlayPath)).toBe(false);
    expect(
      isInsideDocsDir(
        REGULATORY_DOCS_DIR,
        path.resolve(REGULATORY_DOCS_DIR, "..", "..", ".env"),
      ),
    ).toBe(false);

    for (const slug of attacks) {
      const resolved = resolveRegulatoryDoc(REGULATORY_DOCS_DIR, slug);
      expect(resolved.ok, `expected not_found for slug ${JSON.stringify(slug)}`).toBe(false);
      expect(readRegulatoryDoc(REGULATORY_DOCS_DIR, slug)).toBeNull();
    }
  });
});
