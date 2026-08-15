import { currentPrincipal } from "@/lib/session";
import { AuthRequired } from "@/components/auth-required";

export const dynamic = "force-dynamic";

/**
 * Operator-only shell. Server components read Prisma directly (no Request),
 * so the gate lives here — there is no shared route guard. Every /admin
 * page inherits this; A2–A4 mount under it.
 */
export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  const principal = await currentPrincipal();
  if (!principal || principal.role !== "OPERATOR") {
    return <AuthRequired message="Operator access is required to view admin." />;
  }

  return <div className="space-y-6">{children}</div>;
}
