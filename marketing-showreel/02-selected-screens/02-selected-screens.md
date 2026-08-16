# Stage 2 — Selected Portfolio Material

## PAYNORA AI — 5 screens (all captured as real screenshots, see `03-screenshots/paynora/`)

| # | Screen | File | Why selected |
|---|---|---|---|
| 1 | Marketing landing hero | `08-landing.png` | Dark, glassmorphism-adjacent hero with floating stat cards (invoice card, receivables total, "suggested action" panel) — this single frame already sells "AI-assisted SaaS" visually and matches the showreel's aesthetic almost without alteration. |
| 2 | Action Center (AI proposal queue, populated) | `07-actions.png` | The single strongest proof screen in either project: real, prioritized, AI-drafted payment-reminder proposals with tone/priority tags and an explicit human-approval step. This is the concrete evidence of "AI integrated into a real business workflow," not a chatbot demo. |
| 3 | Overview dashboard | `01-dashboard.png` | Clean multi-currency receivables metrics, progress bars, "needs attention" — reads instantly as a serious B2B SaaS product to a non-technical viewer. |
| 4 | Invoice detail with payment recording | `03-invoice-detail.png` | Shows the financial core of the product (the part with the row-locking/CAS engineering behind it) in a simple, legible UI — overdue badge, payment form, payment history. |
| 5 | Sign-in split screen | `09-signin.png` | High production-value auth screen (dark panel with live metric + feature bullets) — useful as a fast opening or closing beat, and it's the kind of detail-level polish that signals craft. |

Not selected but available if needed: invoices list (`02-invoices-list.png`), customers list (`04-customers-list.png`), automation settings (`05-automation.png`, `05b-automation-configured.png`) — solid but redundant with the 5 above for a 30–40s cut.

## NEXORA AI — 4 concept scenes (no real screenshots — see Stage 3 for why)

Selected from verified code/feature inventory and the project's own documented design system (`mobile/docs/nexora-quantum-glass.md`), not fabricated:

| # | Concept screen | Why selected | Verified basis |
|---|---|---|---|
| 1 | AI Advisor chat | The clearest "AI product" surface — a conversational interface backed by a real multi-provider LLM integration (OpenRouter / Mistral / Gemini) with safety/cost handling. | `lib/ai/services/advisor.ts`, `backend/src/services/ai/completion.ts` |
| 2 | Executive dashboard | Shows range beyond Paynora's AR focus — a data-dense financial-overview screen, demonstrating the developer can build analytics-heavy UI, not just forms/tables. | `components/dashboard/executive/`, `app/(workspace)/dashboard/page.tsx` |
| 3 | AI Investment Report (multi-section) | Demonstrates structured AI output generation — a 12-section generated report, not a single chat reply — a harder, more "product" use of AI. | `lib/investment-reports/` |
| 4 | Mobile "Quantum Glass" home/portfolio screen | The native mobile app, in the project's own bespoke design language (warm-black base, bronze = device/wealth, violet = AI-presence, tabular numeric readouts) — proves mobile capability with a genuinely distinctive visual identity, not a stock template. | `mobile/src/app/(tabs)/home.tsx`, `mobile/docs/nexora-quantum-glass.md` |

These four are rendered in Stage 6 as AI-generated stylized recreations using the project's real, documented palette and materials — explicitly labeled as such, never presented as captured screenshots.
