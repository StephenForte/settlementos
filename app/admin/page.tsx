import Link from "next/link";
import { Card } from "@/components/ui";

const LINKS = [
  { href: "/admin/password", label: "Change password", note: "Update the operator password (requires the current one)." },
  { href: "/admin/coins", label: "Mock coins", note: "Treasury and token balances per network." },
  { href: "/admin/wallets", label: "Wallets", note: "Entity and treasury addresses per network." },
];

export default function AdminIndexPage() {
  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-2xl font-semibold text-ink">Admin</h1>
        <p className="mt-1 text-sm text-body">
          Operator tools. One login grants full access.
        </p>
      </header>

      <div className="grid gap-4 md:grid-cols-3">
        {LINKS.map((item) => (
          <Card key={item.href} title={item.label}>
            <p className="mb-4 text-sm text-body">{item.note}</p>
            <Link href={item.href} className="text-sm text-primary hover:underline">
              Open →
            </Link>
          </Card>
        ))}
      </div>
    </div>
  );
}
