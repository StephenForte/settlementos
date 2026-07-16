import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import Link from "next/link";
import { PrincipalBadge } from "./principal-badge";
import { currentPrincipal } from "@/lib/session";
import "./globals.css";

const geistSans = Geist({ variable: "--font-geist-sans", subsets: ["latin"] });
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
    <html lang="en" className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}>
      <body className="min-h-screen bg-slate-950 text-slate-100">
        <div className="flex min-h-screen">
          <aside className="flex w-60 shrink-0 flex-col gap-8 border-r border-slate-800 bg-slate-900/60 p-5">
            <div>
              <Link href="/" className="block">
                <span className="text-lg font-semibold tracking-tight text-white">
                  Settlement<span className="text-emerald-400">OS</span>
                </span>
              </Link>
              <p className="mt-1 text-[11px] leading-snug text-slate-500">
                EVM stablecoin settlement infrastructure
              </p>
            </div>
            <nav className="flex flex-col gap-1 text-sm">
              {NAV.map((item) => (
                <Link
                  key={item.href}
                  href={item.href}
                  className="rounded-md px-3 py-2 text-slate-300 transition-colors hover:bg-slate-800 hover:text-white"
                >
                  {item.label}
                </Link>
              ))}
            </nav>
            <div className="mt-auto flex flex-col gap-3">
              <PrincipalBadge label={principal?.label ?? null} role={principal?.role ?? null} />
              <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 p-3 text-[11px] leading-snug text-amber-300">
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
