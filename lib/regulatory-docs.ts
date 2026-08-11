import fs from "node:fs";
import path from "node:path";

/**
 * Track B regulatory memo pack — path resolution and listing.
 *
 * Slug → file is an **allowlist** built from `docs/regulatory/*.md` at request
 * time. Path traversal strings never become a read target: they are absent from
 * the allowlist, and a resolved absolute path must still sit under the docs
 * directory. Both layers are load-bearing (see AGENTS / the viewer dispatch).
 */

export const REGULATORY_DOCS_DIR = path.join(process.cwd(), "docs", "regulatory");

export type ResolveOk = {
  ok: true;
  slug: string;
  filename: string;
  absolutePath: string;
};

export type ResolveMiss = { ok: false; reason: "not_found" };

export type ResolveResult = ResolveOk | ResolveMiss;

export type RegulatoryDocMeta = {
  slug: string;
  filename: string;
  title: string;
  description: string;
};

/** Basename without `.md`, lowercased — the only slug grammar we accept. */
export function slugFromFilename(filename: string): string {
  if (!filename.endsWith(".md")) {
    throw new Error(`not a markdown filename: ${filename}`);
  }
  return filename.slice(0, -".md".length).toLowerCase();
}

/**
 * Enumerate `*.md` files in `dir` (non-recursive). Missing / unreadable dir → [].
 * A newly added `.md` appears here with no code change.
 */
export function listMarkdownFilenames(dir: string): string[] {
  let entries: string[];
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return [];
  }
  return entries.filter((name) => name.endsWith(".md") && !name.startsWith(".")).sort((a, b) => {
    // README first, then lexical (01-… before 06-…).
    if (a.toLowerCase() === "readme.md") return -1;
    if (b.toLowerCase() === "readme.md") return 1;
    return a.localeCompare(b);
  });
}

/** slug (lowercase) → filename as it appears on disk. */
export function buildAllowlist(filenames: string[]): Map<string, string> {
  const map = new Map<string, string>();
  for (const filename of filenames) {
    map.set(slugFromFilename(filename), filename);
  }
  return map;
}

/**
 * Reject anything that is not a bare slug before we even touch the allowlist.
 * Next may hand us a decoded `../../.env`; encoded forms still show up in tests.
 */
export function isPlausibleSlug(slug: string): boolean {
  if (typeof slug !== "string" || slug.length === 0 || slug.length > 200) return false;
  if (slug.includes("\0")) return false;
  // No path separators, no schemes, no absolute paths — allowlist keys are bare.
  if (/[\\/]/.test(slug)) return false;
  if (slug.includes(":") || slug.startsWith(".")) return false;
  // Encoded separators / dots that would decode into traversal.
  if (/%2f|%5c|%2e/i.test(slug)) return false;
  // Only the characters our filenames actually use (alnum, hyphen, underscore).
  if (!/^[a-z0-9][a-z0-9_-]*$/i.test(slug)) return false;
  return true;
}

/**
 * Layer 2: resolved absolute path must sit inside `dir` (string-prefix check on
 * `path.resolve` results — not a substitute for the allowlist).
 */
export function isInsideDocsDir(dir: string, absolutePath: string): boolean {
  const root = path.resolve(dir);
  const candidate = path.resolve(absolutePath);
  const rootPrefix = root.endsWith(path.sep) ? root : root + path.sep;
  return candidate === root || candidate.startsWith(rootPrefix);
}

/**
 * Resolve a URL slug to an absolute file path under `dir`, or `not_found`.
 *
 * Layer 1: slug must be in the allowlist built from `*.md` in `dir`.
 * Layer 2: `path.resolve(dir, filename)` must remain inside `path.resolve(dir)`.
 *
 * Never opens a file for a rejected slug — callers read only after `ok: true`.
 */
export function resolveRegulatoryDoc(dir: string, slug: string): ResolveResult {
  if (!isPlausibleSlug(slug)) {
    return { ok: false, reason: "not_found" };
  }

  const allowlist = buildAllowlist(listMarkdownFilenames(dir));
  const filename = allowlist.get(slug.toLowerCase());
  if (!filename) {
    return { ok: false, reason: "not_found" };
  }

  const absolutePath = path.resolve(dir, filename);
  if (!isInsideDocsDir(dir, absolutePath)) {
    return { ok: false, reason: "not_found" };
  }
  // Filename came from readdir; still refuse anything that is not a regular file.
  try {
    if (!fs.statSync(absolutePath).isFile()) {
      return { ok: false, reason: "not_found" };
    }
  } catch {
    return { ok: false, reason: "not_found" };
  }

  return {
    ok: true,
    slug: slug.toLowerCase(),
    filename,
    absolutePath,
  };
}

export function readRegulatoryDoc(dir: string, slug: string): string | null {
  const resolved = resolveRegulatoryDoc(dir, slug);
  if (!resolved.ok) return null;
  try {
    return fs.readFileSync(resolved.absolutePath, "utf8");
  } catch {
    return null;
  }
}

/** True when the pack directory exists and contains at least one `.md`. */
export function regulatoryDocsAvailable(dir: string = REGULATORY_DOCS_DIR): boolean {
  return listMarkdownFilenames(dir).length > 0;
}

function stripInlineMarkdown(text: string): string {
  return text
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/[*_`]+/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function titleFromMarkdown(source: string, fallback: string): string {
  const m = source.match(/^#\s+(.+)$/m);
  return m ? stripInlineMarkdown(m[1]) : fallback;
}

/**
 * One-line description: prefer the README table's "Role in the pack" cell when
 * this file is listed there; otherwise the first non-status prose paragraph.
 */
/** Role cell from the README pack table for `filename`, or null. No RegExp(filename). */
function roleFromReadmeTable(readmeSource: string, filename: string): string | null {
  // | 01 | [Technical architecture](01-technical-architecture.md) | What the system does… |
  const needle = `](${filename})`;
  for (const line of readmeSource.split(/\r?\n/)) {
    if (!line.trimStart().startsWith("|") || !line.includes(needle)) continue;
    const cells = line
      .trim()
      .replace(/^\|/, "")
      .replace(/\|$/, "")
      .split("|")
      .map((c) => c.trim());
    // # | Document | Role in the pack
    if (cells.length >= 3 && cells[1]?.includes(needle)) {
      return cells[2] || null;
    }
  }
  return null;
}

function descriptionFromMarkdown(filename: string, source: string, readmeSource: string | null): string {
  if (readmeSource) {
    const role = roleFromReadmeTable(readmeSource, filename);
    if (role) {
      return stripInlineMarkdown(role);
    }
  }

  if (filename.toLowerCase() === "readme.md") {
    return "Frozen Track B scaffolding pack for banks and licensed partners evaluating SettlementOS.";
  }

  const lines = source.split(/\r?\n/);
  let inStatusQuote = false;
  const para: string[] = [];
  for (const line of lines) {
    if (line.startsWith(">")) {
      inStatusQuote = true;
      continue;
    }
    if (inStatusQuote && line.trim() === "") {
      inStatusQuote = false;
      continue;
    }
    if (inStatusQuote) continue;
    if (/^#/.test(line) || /^---/.test(line) || /^\|/.test(line) || /^```/.test(line)) {
      if (para.length) break;
      continue;
    }
    if (line.trim() === "") {
      if (para.length) break;
      continue;
    }
    // Skip metadata bold-keys ("**Audience:** …").
    if (/^\*\*[^*]+:\*\*/.test(line)) continue;
    para.push(line.trim());
  }
  const text = stripInlineMarkdown(para.join(" "));
  if (!text) return "Regulatory memo (frozen template).";
  return text.length > 160 ? `${text.slice(0, 157)}…` : text;
}

/**
 * Index rows for every `.md` in `dir`. Empty when the directory is missing —
 * callers render a clear "unavailable" state rather than throwing.
 */
export function listRegulatoryDocs(dir: string = REGULATORY_DOCS_DIR): RegulatoryDocMeta[] {
  const filenames = listMarkdownFilenames(dir);
  if (filenames.length === 0) return [];

  let readmeSource: string | null = null;
  const readmeName = filenames.find((f) => f.toLowerCase() === "readme.md");
  if (readmeName) {
    try {
      readmeSource = fs.readFileSync(path.join(dir, readmeName), "utf8");
    } catch {
      readmeSource = null;
    }
  }

  return filenames.map((filename) => {
    const slug = slugFromFilename(filename);
    let source = "";
    try {
      source = fs.readFileSync(path.join(dir, filename), "utf8");
    } catch {
      source = "";
    }
    return {
      slug,
      filename,
      title: titleFromMarkdown(source, filename),
      description: descriptionFromMarkdown(filename, source, readmeSource),
    };
  });
}
