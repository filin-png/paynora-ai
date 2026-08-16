# Stage 3 — Screenshots

## PAYNORA AI — captured successfully

The app was run live in this environment (local PostgreSQL 16, `npm run dev`), a real account/organization was created through the actual sign-up flow, and realistic demo data (3 customers, 3 invoices with varied currencies/due dates) was entered through the app's own UI — no database seeding, no fabricated visuals. `AI_PROVIDER` was left at its safe default (`none`); the Action Center screenshot shows the product's real deterministic fallback drafting path (the same code path real AI-drafted proposals flow through), triggered via the app's own "Run automation tick" / "Check for new actions" buttons.

9 screenshots, 1440×900, no browser chrome, no errors, no secrets/credentials visible:

- `01-dashboard.png` — Overview
- `02-invoices-list.png` — Invoices
- `03-invoice-detail.png` — Invoice detail + payment recording
- `04-customers-list.png` — Customers
- `05-automation.png` / `05b-automation-configured.png` — Automation settings
- `06-settings.png` — Org settings
- `07-actions.png` — Action Center (populated, AI proposal queue) — **primary AI proof shot**
- `08-landing.png` — Marketing landing page
- `09-signin.png` — Sign-in

## NEXORA AI — could not be captured

**Exact blocker:** Nexora's own `INSTALL.md` states plainly that the app cannot authenticate a user without a real Supabase project — there is no local/offline auth path, no seed script, and no docker-compose for a local database (unlike Paynora, which ships a self-contained local Postgres path). Provisioning a real Supabase project requires external account creation and would mean generating credentials in this environment, which is out of scope for an unattended audit session and was not authorized.

The AI features themselves *do* have a safe no-key fallback (`AI_PROVIDER` unset → deterministic mock), but that's irrelevant here — the blocker is authentication, which gates every screen behind Supabase, not the AI layer.

**What was done instead:** no screenshots were fabricated. Stage 2 selected 4 representative screens based on verified source code and the project's own documented design system (`mobile/docs/nexora-quantum-glass.md`, which specifies exact hex palette, materials, and typography). Stage 6 generates these as AI video scenes explicitly as stylized recreations of the real design language — never presented as, or mixed in with, captured screenshots.

**If you want real Nexora screenshots later:** spin up a free Supabase project, run the 3 SQL files under `supabase/migrations/` (or the CLI), fill `.env.local` per `INSTALL.md` §6, then `npm run dev` — the same Playwright approach used for Paynora would work identically once auth is available.
