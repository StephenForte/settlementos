import Link from "next/link";
import { Card } from "@/components/ui";

/**
 * The sign-in wall a server component renders when the current principal may not
 * see a page. Server components read the DB directly, so — unlike the API routes,
 * which scope every query by principal — each page must gate itself; this is the
 * shared surface for that. Mirrors the inline check the stuck-payments page has
 * carried since it shipped.
 */
export function AuthRequired({ message }: { message: string }) {
  return (
    <Card title="Sign in required">
      <p className="text-sm text-slate-400">
        {message}{" "}
        <Link href="/login" className="text-emerald-400 hover:underline">
          Sign in
        </Link>
        .
      </p>
    </Card>
  );
}
