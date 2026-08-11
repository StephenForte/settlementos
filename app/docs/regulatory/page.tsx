import Link from "next/link";
import { currentPrincipal } from "@/lib/session";
import { AuthRequired } from "@/components/auth-required";
import { Card } from "@/components/ui";
import {
  REGULATORY_DOCS_DIR,
  listRegulatoryDocs,
  regulatoryDocsAvailable,
} from "@/lib/regulatory-docs";
import { FrozenTemplateBanner } from "./frozen-banner";

export const dynamic = "force-dynamic";

export default async function RegulatoryDocsIndexPage() {
  // Any signed-in role may read — ENTITY tenants evaluating the platform are
  // the intended audience. Not tenant-scoped (these are not tenant data).
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
            <code className="font-mono text-xs">docs/regulatory/</code>). On a production host this
            usually means the deploy image omitted the directory — check file tracing / the release
            checkout rather than the route handlers.
          </p>
        </Card>
      </div>
    );
  }

  const docs = listRegulatoryDocs(REGULATORY_DOCS_DIR);

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-2xl font-semibold text-ink">Regulatory Docs</h1>
        <p className="mt-1 text-sm text-body">
          Track B frozen templates — technical architecture, regulatory design, legal
          classification questions, partner integration, corridor strategy, and pilot options.
        </p>
      </header>

      <FrozenTemplateBanner />

      <ul className="divide-y divide-mute rounded-md border border-mute bg-canvas-soft">
        {docs.map((doc) => (
          <li key={doc.slug}>
            <Link
              href={`/docs/regulatory/${doc.slug}`}
              className="block px-5 py-4 transition-colors hover:bg-canvas"
            >
              <span className="text-base font-semibold text-ink">{doc.title}</span>
              <span className="mt-1 block text-sm text-body">{doc.description}</span>
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}
