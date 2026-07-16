import type { NextConfig } from "next";

const isDev = process.env.NODE_ENV === "development";

/**
 * Content-Security-Policy.
 *
 * Everything loads from this origin: the app has no CDN, no analytics, no
 * embedded third party. `frame-ancestors 'none'` (with X-Frame-Options as the
 * belt to its braces) is what keeps a settlement UI out of an attacker's
 * iframe, where a stolen click becomes a payment.
 *
 * Two deliberate relaxations, documented rather than papered over:
 *
 *  - `style-src 'unsafe-inline'`: Tailwind ships a stylesheet, but Next injects
 *    inline <style> during dev and for critical CSS. Styles are not a script
 *    sink here, so this is the cheap one.
 *  - `script-src 'unsafe-inline'`: Next's App Router bootstraps hydration with
 *    inline <script> tags. Removing this needs a per-request nonce threaded
 *    from middleware into the CSP header — worth doing before a real public
 *    deployment, and the reason this line carries a comment instead of a
 *    pretence. `unsafe-eval` is dev-only (react-refresh) and never shipped.
 */
const csp = [
  "default-src 'self'",
  `script-src 'self' 'unsafe-inline'${isDev ? " 'unsafe-eval'" : ""}`,
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "font-src 'self' data:",
  // The explorer links the UI renders are plain anchors, not fetches: the
  // browser only ever talks to this origin (dev also needs the HMR websocket).
  `connect-src 'self'${isDev ? " ws: wss:" : ""}`,
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join("; ");

const securityHeaders = [
  { key: "Content-Security-Policy", value: csp },
  // A response typed text/csv (the reconciliation export) must never be sniffed
  // into something the browser will execute.
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "X-Frame-Options", value: "DENY" },
  // Payment ids live in the path, so never leak a full URL cross-origin.
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  // Nothing here needs a camera, a microphone, or geolocation.
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=(), payment=(), usb=()" },
];

const nextConfig: NextConfig = {
  async headers() {
    return [{ source: "/:path*", headers: securityHeaders }];
  },
};

export default nextConfig;
