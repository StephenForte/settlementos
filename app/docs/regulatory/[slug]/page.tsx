import Link from "next/link";
import { notFound } from "next/navigation";
import { currentPrincipal } from "@/lib/session";
import { AuthRequired } from "@/components/auth-required";
import { Card } from "@/components/ui";
import {
  REGULATORY_DOCS_DIR,
  listMarkdownFilenames,
  readRegulatoryDoc,
  regulatoryDocsAvailable,
  resolveRegulatoryDoc,
  slugFromFilename,
} from "@/lib/regulatory-docs";
import { FrozenTemplateBanner } from "../frozen-banner";
import { renderMarkdown } from "../markdown";

export const dynamic = "force-dynamic";

type Props = { params: Promise<{ slug: string }> };

export default async function RegulatoryDocPage({ params }: Props) {
  const principal = await currentPrincipal();
  if (!principal) {
    return <AuthRequired message="Sign in to view the regulatory document pack." />;
  }

  if (!regulatoryDocsAvailable(REGULATORY_DOCS_DIR)) {
    return (
      <div className="space-y-6">
        <header>
          <h1 className="text-2xl font-semibold text-ink">Regulatory Docs</h1>
        </header>
        <FrozenTemplateBanner />
        <Card title="Documents unavailable">
          <p className="text-sm text-body">
            The Track B regulatory memo pack could not be loaded from disk (
            <code className="font-mono text-xs">docs/regulatory/</code>).
          </p>
        </Card>
      </div>
    );
  }

  const { slug } = await params;
  const resolved = resolveRegulatoryDoc(REGULATORY_DOCS_DIR, slug);
  if (!resolved.ok) {
    notFound();
  }

  const source = readRegulatoryDoc(REGULATORY_DOCS_DIR, resolved.slug);
  if (source === null) {
    notFound();
  }

  const knownSlugs = new Set(listMarkdownFilenames(REGULATORY_DOCS_DIR).map(slugFromFilename));

  return (
    <div className="space-y-6">
      <p className="text-xs font-medium uppercase tracking-widest text-body">
        <Link href="/docs/regulatory" className="text-primary hover:underline">
          Regulatory Docs
        </Link>
      </p>

      <FrozenTemplateBanner />

      <article className="rounded-md border border-mute bg-canvas-soft p-6">
        {renderMarkdown({ source, knownSlugs })}
      </article>
    </div>
  );
}
