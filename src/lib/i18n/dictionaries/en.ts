/**
 * English strings — the source-of-truth key shape every other locale's
 * dictionary must match exactly (see dictionaries.test.ts's parity check).
 */
export const en = {
  common: {
    openNavigation: "Open navigation",
    closeNavigation: "Close navigation",
    switchOrganization: "Switch organization",
    signIn: "Sign in",
    getStarted: "Get started",
  },
  nav: {
    overview: "Overview",
    invoices: "Invoices",
    customers: "Customers",
    actionCenter: "Action Center",
    automation: "Automation",
    wallet: "Wallet",
    settings: "Settings",
  },
  landing: {
    badge: "AI-powered accounts receivable intelligence",
    heroTitlePrefix: "Know where your",
    heroTitleHighlight: "money",
    heroTitleSuffix: " is going.",
    heroSubtitle:
      "AI collection intelligence that helps B2B teams see what's outstanding, catch what's overdue, and know exactly what to do next — with a human approving every follow-up PAYNORA recommends, or automating it on your terms.",
  },
  settingsIntegrations: {
    ai: "AI generation",
    email: "Email",
    messaging: "Messaging",
    billing: "PAYNORA subscription billing",
    wallet: "Wallet / crypto payments",
    analytics: "Analytics",
    webSearch: "Web search",
  },
} as const;

/** Same key shape as `en`, but every leaf widened to `string` — a translated dictionary supplies its own text, not en's literal values. */
type Widen<T> = T extends string ? string : { [K in keyof T]: Widen<T[K]> };
export type Dictionary = Widen<typeof en>;
