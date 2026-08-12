import { Inter, JetBrains_Mono, Space_Grotesk } from "next/font/google";

/**
 * Landing-page-only typography. Self-hosted via next/font (zero external
 * requests, zero layout shift, no new npm dependency). Deliberately NOT
 * applied in the root layout — the authenticated app keeps its existing
 * system-font stack (src/app/layout.tsx). These are consumed as CSS
 * variables (`.variable`) directly on the landing page's own JSX tree so
 * the effect is scoped to `/` only. See docs/product-ui.md#landing-redesign.
 */
export const displayFont = Space_Grotesk({
  subsets: ["latin"],
  weight: ["500", "600", "700"],
  variable: "--font-landing-display",
  display: "swap",
});

export const bodyFont = Inter({
  subsets: ["latin"],
  weight: ["400", "500", "600"],
  variable: "--font-landing-body",
  display: "swap",
});

export const monoFont = JetBrains_Mono({
  subsets: ["latin"],
  weight: ["400", "500"],
  variable: "--font-landing-mono",
  display: "swap",
});
