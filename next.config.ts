import type { NextConfig } from "next";

const isProd = process.env.NODE_ENV === "production";

/**
 * Phase 23 production hardening — see
 * docs/production-readiness.md#security-headers. This app has no external
 * scripts, stylesheets, or fonts to allow for: no CDN script tag anywhere
 * in src/app, no Google Fonts `<link>` (see src/app/layout.tsx), and
 * PostHog (the one analytics vendor this codebase can call) is invoked
 * server-side only (src/server/analytics/providers/posthog.ts posts to
 * PostHog's HTTP capture API — no client-side script/pixel is ever
 * loaded), so a strict Content-Security-Policy costs nothing to adopt
 * here. `style-src` needs `'unsafe-inline'` because the design system
 * uses inline `style` attributes for dynamic values (chart colors,
 * per-row accents) — CSP's `style-src` covers style attributes as well as
 * `<style>` elements, and nonce-based styling would need per-request
 * middleware this app doesn't have. `script-src` does not need it: this
 * app has no inline `<script>` tags of its own, and Next.js's own
 * App Router hydration payload does not require `'unsafe-inline'` to run.
 * Development keeps `'unsafe-eval'`/`'unsafe-inline'` for script-src and
 * allows the HMR websocket — never relaxed in production.
 */
const csp = [
  "default-src 'self'",
  `script-src 'self'${isProd ? "" : " 'unsafe-eval' 'unsafe-inline'"}`,
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "font-src 'self'",
  `connect-src 'self'${isProd ? "" : " ws: wss:"}`,
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "object-src 'none'",
].join("; ");

const securityHeaders = [
  { key: "Content-Security-Policy", value: csp },
  { key: "X-Content-Type-Options", value: "nosniff" },
  // Belt-and-braces alongside frame-ancestors above — CSP is authoritative
  // in any browser that supports it, X-Frame-Options covers the rest.
  { key: "X-Frame-Options", value: "DENY" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  // Deny-by-default for browser features this app never uses; not an
  // exhaustive allowlist of every Permissions-Policy feature, just the
  // ones worth being explicit about.
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=(), interest-cohort=()" },
];

const nextConfig: NextConfig = {
  async headers() {
    return [
      {
        source: "/:path*",
        headers: securityHeaders,
      },
    ];
  },
};

export default nextConfig;
