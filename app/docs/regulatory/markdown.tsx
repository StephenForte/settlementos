import type { ReactNode } from "react";
import Link from "next/link";

/**
 * Small server-side markdown → React renderer for the Track B memos.
 *
 * Why not a library: the CSP forbids external assets; we need raw-HTML off by
 * default; the memo grammar is a fixed subset (ATX headings, paragraphs, lists,
 * blockquotes, fenced code, tables, emphasis, links). A dependency would add a
 * transitive surface for a closed set of features we can cover in ~200 lines.
 *
 * No `dangerouslySetInnerHTML` and no tag-name interpolation from file content —
 * HTML in the source is rendered as text via React children escaping. Internal
 * `*.md` links rewrite to `/docs/regulatory/<slug>` when the basename is on
 * the allowlist passed in; other targets render as plain text (repo-only paths
 * like `../../AGENTS.md` are not in-app routes).
 */

type Props = {
  source: string;
  /** Lowercase slugs that exist in the pack — used to rewrite memo-to-memo links. */
  knownSlugs: ReadonlySet<string>;
};

function slugFromMdHref(href: string): string | null {
  // Accept "README.md", "./01-foo.md", "01-foo.md#section" — not ../ escapes.
  const bare = href.split("#")[0]?.trim() ?? "";
  if (!bare || bare.includes("://") || bare.startsWith("/") || bare.includes("..")) {
    return null;
  }
  const base = bare.replace(/^\.\//, "");
  if (!base.endsWith(".md") || base.includes("/")) return null;
  return base.slice(0, -".md".length).toLowerCase();
}

function renderInline(text: string, knownSlugs: ReadonlySet<string>, keyBase: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  const re =
    /(`+)([^`]+)\1|\[([^\]]+)\]\(([^)]+)\)|\*\*([^*]+)\*\*|\*([^*]+)\*|__([^_]+)__|_([^_]+)_/g;
  let last = 0;
  let m: RegExpExecArray | null;
  let i = 0;
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) {
      nodes.push(text.slice(last, m.index));
    }
    const k = `${keyBase}-${i++}`;
    if (m[2] !== undefined) {
      nodes.push(
        <code key={k} className="rounded bg-canvas px-1 py-0.5 font-mono text-[0.85em] text-ink">
          {m[2]}
        </code>,
      );
    } else if (m[3] !== undefined && m[4] !== undefined) {
      const label = m[3];
      const href = m[4];
      const mdSlug = slugFromMdHref(href);
      if (mdSlug && knownSlugs.has(mdSlug)) {
        nodes.push(
          <Link key={k} href={`/docs/regulatory/${mdSlug}`} className="text-primary hover:underline">
            {label}
          </Link>,
        );
      } else if (href.startsWith("http://") || href.startsWith("https://")) {
        nodes.push(
          <a key={k} href={href} className="text-primary hover:underline" rel="noopener noreferrer">
            {label}
          </a>,
        );
      } else {
        nodes.push(
          <span key={k} className="text-ink" title={href}>
            {label}
          </span>,
        );
      }
    } else if (m[5] !== undefined || m[7] !== undefined) {
      nodes.push(
        <strong key={k} className="font-semibold text-ink">
          {m[5] ?? m[7]}
        </strong>,
      );
    } else if (m[6] !== undefined || m[8] !== undefined) {
      nodes.push(
        <em key={k} className="italic">
          {m[6] ?? m[8]}
        </em>,
      );
    }
    last = m.index + m[0].length;
  }
  if (last < text.length) {
    nodes.push(text.slice(last));
  }
  return nodes;
}

function splitTableRow(line: string): string[] {
  const trimmed = line.trim().replace(/^\|/, "").replace(/\|$/, "");
  return trimmed.split("|").map((c) => c.trim());
}

function isTableSeparator(line: string): boolean {
  return /^\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)+\|?$/.test(line.trim());
}

export function renderMarkdown({ source, knownSlugs }: Props): ReactNode {
  const lines = source.replace(/\r\n/g, "\n").split("\n");
  const blocks: ReactNode[] = [];
  let i = 0;
  let b = 0;

  while (i < lines.length) {
    const line = lines[i];

    if (line.trim() === "") {
      i++;
      continue;
    }

    if (line.startsWith("```")) {
      i++;
      const body: string[] = [];
      while (i < lines.length && !lines[i].startsWith("```")) {
        body.push(lines[i]);
        i++;
      }
      if (i < lines.length) i++;
      blocks.push(
        <pre
          key={`b-${b++}`}
          className="overflow-x-auto rounded-md border border-mute bg-canvas p-4 font-mono text-xs text-ink"
        >
          <code>{body.join("\n")}</code>
        </pre>,
      );
      continue;
    }

    const heading = /^(#{1,4})\s+(.+)$/.exec(line);
    if (heading) {
      const level = heading[1].length;
      const content = renderInline(heading[2], knownSlugs, `h-${b}`);
      const className =
        level === 1
          ? "text-2xl font-semibold text-ink"
          : level === 2
            ? "mt-8 text-lg font-semibold text-ink"
            : level === 3
              ? "mt-6 text-base font-semibold text-ink"
              : "mt-4 text-sm font-semibold text-ink";
      const key = `b-${b++}`;
      if (level === 1) blocks.push(<h1 key={key} className={className}>{content}</h1>);
      else if (level === 2) blocks.push(<h2 key={key} className={className}>{content}</h2>);
      else if (level === 3) blocks.push(<h3 key={key} className={className}>{content}</h3>);
      else blocks.push(<h4 key={key} className={className}>{content}</h4>);
      i++;
      continue;
    }

    if (/^(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
      blocks.push(<hr key={`b-${b++}`} className="my-6 border-mute" />);
      i++;
      continue;
    }

    if (line.trim().startsWith("|") && i + 1 < lines.length && isTableSeparator(lines[i + 1])) {
      const header = splitTableRow(line);
      i += 2;
      const rows: string[][] = [];
      while (i < lines.length && lines[i].trim().startsWith("|")) {
        rows.push(splitTableRow(lines[i]));
        i++;
      }
      const tableKey = b++;
      blocks.push(
        <div key={`b-${tableKey}`} className="my-4 overflow-x-auto">
          <table className="w-full border-collapse text-left text-sm">
            <thead>
              <tr className="border-b border-mute">
                {header.map((cell, ci) => (
                  <th key={ci} className="px-3 py-2 font-semibold text-ink">
                    {renderInline(cell, knownSlugs, `th-${tableKey}-${ci}`)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((row, ri) => (
                <tr key={ri} className="border-b border-mute/60">
                  {row.map((cell, ci) => (
                    <td key={ci} className="px-3 py-2 align-top text-body">
                      {renderInline(cell, knownSlugs, `td-${tableKey}-${ri}-${ci}`)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>,
      );
      continue;
    }

    if (line.startsWith(">")) {
      const quoteLines: string[] = [];
      while (i < lines.length && lines[i].startsWith(">")) {
        quoteLines.push(lines[i].replace(/^>\s?/, ""));
        i++;
      }
      // Soft-wrapped emphasis in the frozen memos spans physical lines
      // (`**illustrative` / `scaffolding**`) — join into paragraphs on blank lines.
      const paragraphs: string[] = [];
      let buf: string[] = [];
      for (const ql of quoteLines) {
        if (ql.trim() === "") {
          if (buf.length) {
            paragraphs.push(buf.join(" "));
            buf = [];
          }
        } else {
          buf.push(ql.trim());
        }
      }
      if (buf.length) paragraphs.push(buf.join(" "));
      const qKey = b++;
      blocks.push(
        <blockquote
          key={`b-${qKey}`}
          className="border-l-4 border-warning-border bg-warning-bg/40 px-4 py-3 text-sm leading-relaxed text-warning-fg"
        >
          {paragraphs.map((para, qi) => (
            <p key={qi} className={qi > 0 ? "mt-2" : undefined}>
              {renderInline(para, knownSlugs, `q-${qKey}-${qi}`)}
            </p>
          ))}
        </blockquote>,
      );
      continue;
    }

    if (/^[-*]\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^[-*]\s+/.test(lines[i])) {
        let item = lines[i].replace(/^[-*]\s+/, "");
        i++;
        while (i < lines.length && /^\s{2,}\S/.test(lines[i])) {
          item += " " + lines[i].trim();
          i++;
        }
        items.push(item);
      }
      const ulKey = b++;
      blocks.push(
        <ul key={`b-${ulKey}`} className="my-3 list-disc space-y-2 pl-6 text-sm text-body">
          {items.map((item, ii) => (
            <li key={ii}>{renderInline(item, knownSlugs, `ul-${ulKey}-${ii}`)}</li>
          ))}
        </ul>,
      );
      continue;
    }

    if (/^\d+\.\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^\d+\.\s+/.test(lines[i])) {
        let item = lines[i].replace(/^\d+\.\s+/, "");
        i++;
        while (i < lines.length && /^\s{2,}\S/.test(lines[i])) {
          item += " " + lines[i].trim();
          i++;
        }
        items.push(item);
      }
      const olKey = b++;
      blocks.push(
        <ol key={`b-${olKey}`} className="my-3 list-decimal space-y-2 pl-6 text-sm text-body">
          {items.map((item, ii) => (
            <li key={ii}>{renderInline(item, knownSlugs, `ol-${olKey}-${ii}`)}</li>
          ))}
        </ol>,
      );
      continue;
    }

    const para: string[] = [];
    while (
      i < lines.length &&
      lines[i].trim() !== "" &&
      !lines[i].startsWith("#") &&
      !lines[i].startsWith(">") &&
      !lines[i].startsWith("```") &&
      !lines[i].trim().startsWith("|") &&
      !/^[-*]\s+/.test(lines[i]) &&
      !/^\d+\.\s+/.test(lines[i]) &&
      !/^(-{3,}|\*{3,}|_{3,})\s*$/.test(lines[i])
    ) {
      para.push(lines[i].trim());
      i++;
    }
    const pKey = b++;
    blocks.push(
      <p key={`b-${pKey}`} className="my-3 text-sm leading-relaxed text-body">
        {renderInline(para.join(" "), knownSlugs, `p-${pKey}`)}
      </p>,
    );
  }

  return <div className="regulatory-md max-w-3xl">{blocks}</div>;
}
