import type { Metadata } from "next";
import { Inter, Geist_Mono } from "next/font/google";
import Link from "next/link";
import { PrincipalBadge } from "./principal-badge";
import { currentPrincipal } from "@/lib/session";
import "./globals.css";

const inter = Inter({ variable: "--font-inter", subsets: ["latin"] });
const geistMono = Geist_Mono({ variable: "--font-geist-mono", subsets: ["latin"] });

export const metadata: Metadata = {
  title: "SettlementOS",
  description: "EVM stablecoin settlement infrastructure — testnet demo",
};

const NAV = [
  { href: "/", label: "Dashboard" },
  { href: "/payments", label: "Payments" },
  { href: "/payments/new", label: "New Payment" },
  { href: "/entities", label: "Entities" },
  { href: "/liquidity", label: "Liquidity & Treasury" },
  { href: "/compliance", label: "Compliance Queue" },
];

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const principal = await currentPrincipal();

  return (
    <html lang="en" className={`${inter.variable} ${geistMono.variable} h-full antialiased`}>
      <body className="min-h-screen bg-canvas font-sans text-ink">
        <div className="flex min-h-screen">
          <aside className="flex w-60 shrink-0 flex-col gap-8 border-r border-mute bg-canvas-soft p-5">
            <div>
              <Link href="/" className="block">
                <span className="text-lg font-semibold tracking-tight text-ink">
                  Settlement<span className="text-primary">OS</span>
                </span>
              </Link>
              <p className="mt-1 text-[11px] leading-snug text-body">
                EVM stablecoin settlement infrastructure
              </p>
            </div>
            <nav className="flex flex-col gap-1 text-sm">
              {NAV.map((item) => (
                <Link
                  key={item.href}
                  href={item.href}
                  className="rounded-md px-3 py-2 text-ink transition-colors hover:bg-canvas hover:text-primary"
                >
                  {item.label}
                </Link>
              ))}
            </nav>
            <div className="mt-auto flex flex-col gap-3">
              <PrincipalBadge label={principal?.label ?? null} role={principal?.role ?? null} />
              <div className="rounded-md border border-warning-border bg-warning-bg p-3 text-[11px] leading-snug font-medium text-warning-fg">
                Testnet demo. Mock assets, simulated FX and payout. No real funds.
              </div>
            </div>
          </aside>
          <main className="flex-1 overflow-x-hidden p-8">{children}</main>
        </div>
      </body>
    </html>
  );
}
