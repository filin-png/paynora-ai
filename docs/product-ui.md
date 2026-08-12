# Product UI (Phase 7)

**Status: implemented.** This document describes what Phase 7 actually
built: a complete visual and interaction redesign of every existing
screen, plus a small reusable design system underneath them. Phase 7 is
deliberately **UI-only** — no Prisma schema changed, and every screen
still reads and writes through the exact same Phase 1–6 server functions
(`listInvoicesWithFinancials`, `getOrganizationArSummary`,
`getActionProposal`, `getProviderRegistrySnapshot`, and so on). Where a
page needed a new read, it's a new thin query function next to the
existing ones (`getCustomerReceivablesSummaries` in
`src/server/ar/summary.ts`, `getCollectionsBadgesForInvoices` in
`src/app/app/[orgSlug]/collections-badge.ts`), never a rewrite of
domain logic.

## Design system

`src/app/globals.css` defines the token palette as CSS custom properties,
mapped into Tailwind v4 via `@theme inline`. The palette is deliberately
restrained — this is a financial control system, not a marketing site:

- **Neutral surfaces** (`--background`, `--surface`, `--foreground`,
  `--muted`, `--muted-foreground`, `--border`) — soft off-white, never
  stark white-on-white.
- **Navy** (`--navy-950`…`--navy-600`) — reserved for the sidebar, header,
  and auth/landing depth. Never used for body content.
- **One accent** (`--primary`, an indigo) — every primary action and focus
  ring, and nothing else. There is no second "brand" color competing with
  it.
- **Semantic color, reserved for real meaning** — `--success` (paid,
  completed), `--warning` (uncertain, paused, blocked), `--danger`
  (overdue, destructive, failed). These never appear as decoration; a
  green badge always means something is actually paid or completed.

Both a light palette (`:root`) and a dark palette
(`@media (prefers-color-scheme: dark)`) are defined; there is no manual
theme toggle, matching the OS preference the way the rest of the app
already assumed before Phase 7. `@media (prefers-reduced-motion: reduce)`
collapses all animation/transition durations globally — one rule, not a
per-component flag.

`src/components/brand/logo.tsx` is an original mark (`PaynoraMark`: a
rounded navy square with three ascending bars and a trend dot) and
wordmark (`PaynoraLogo`) — no third-party icon or stock asset. `app/
icon.svg` mirrors it for the browser favicon.

### Components (`src/components/ui/`)

A single reusable set, each with variants driven by `class-variance-
authority` and no per-page reimplementation:

`button` · `input` · `textarea` · `select` · `switch` · `label` · `badge`
· `card` · `metric-card` · `table` · `empty-state` · `alert` · `dialog` ·
`dropdown-menu` · `tabs` · `skeleton` · `tooltip` · `status-indicator` ·
`page-header` (also exports `SectionHeader`).

Two deliberate implementation choices worth calling out:

- **`dialog.tsx` wraps the native `<dialog>` element** (`showModal()`,
  `<form method="dialog">` for a JS-free close button) instead of adding a
  headless-UI-style dependency. It already gives correct focus trapping,
  `Esc`-to-close, and top-layer stacking for free, and the app doesn't
  need more than that. `DialogCancelButton` is exported for the common
  "cancel closes without submitting" case.
- **`switch.tsx` is presentational only** — it renders the visual on/off
  track but never owns a click handler or a real HTML `<input
  type="checkbox">`. Every real use of it (organization automation
  master switch) wraps it in a `<form action={serverAction}>` and a
  labeled `<button type="submit">`, so the actual state change always
  goes through a real Server Action and the accessible name comes from
  the button, not the decorative switch (see
  [Accessibility](#accessibility)).

`lucide-react` is the one new dependency this phase adds, used
exclusively for icons — no icon is hand-drawn SVG except the PAYNORA mark
itself.

## App shell

`src/components/app-shell/` provides the authenticated layout: a fixed
navy sidebar with the nav items (`nav-items.ts`) on desktop, collapsing to
a header + slide-out drawer (`mobile-nav.tsx`) below the `lg` breakpoint,
plus a `header.tsx` with the organization name and user menu. `nav-
link.tsx` takes its icon as a pre-rendered `React.ReactNode`, not a
component reference — Server Components (`Sidebar`, `MobileNav`) render
the `lucide-react` icon themselves before handing it to the Client
Component, since a function reference cannot cross the server/client
boundary as a prop.

### Route structure

```
/                                     landing (marketing)
/sign-in, /sign-up                    auth (split-panel layout)
/app                                  no-org landing (route group, own layout)
/app/organizations/new                create first organization
/app/[orgSlug]                        dashboard (sidebar shell)
/app/[orgSlug]/invoices[...]          list, detail, new
/app/[orgSlug]/customers[...]         list, detail, edit, new
/app/[orgSlug]/actions[...]           Action Center list + review
/app/[orgSlug]/automation             collections policy + sequences
/app/[orgSlug]/settings               General/Members/Integrations/Billing/Security
```

`/app` and `/app/organizations/new` live under the `(no-org)` route group
(`src/app/app/(no-org)/`) specifically so they get their own minimal
layout instead of inheriting `/app/[orgSlug]`'s sidebar shell — in Next.js
every ancestor layout applies to every descendant route, so without the
group, `/app` would have incorrectly nested inside the org sidebar shell
meant only for pages that have an organization to render a sidebar for.
Route groups don't add a URL segment, so this is invisible to users and
required no link changes.

Every org-scoped route has a real `loading.tsx` (skeleton, not a spinner),
`not-found.tsx` (async, resolves `params` for the "back to
`orgSlug`" link), and `error.tsx` (a Client Component, per Next.js's
requirement for error boundaries). Root-level `src/app/not-found.tsx` and
`src/app/error.tsx` cover everything above the org boundary. Pages that
`await` a lookup that can legitimately not exist (an invoice, customer, or
proposal by ID) catch the domain's not-found error class and call
`notFound()` — see `src/lib/not-found.ts#isResourceNotFoundError`, which
recognizes `ArResourceNotFoundError`, `OperatorResourceNotFoundError`,
`CollectionsResourceNotFoundError`, and `CommunicationResourceNotFoundError`
by name so a real Next.js 404 renders instead of the generic error
boundary.

## Dashboard, Invoices, Customers

The dashboard (`/app/[orgSlug]`) is built entirely from existing Phase
2 aggregates (`getOrganizationArSummary`, `getInvoicesRequiringAttention`,
`listRecentPayments`) plus one new one, `getCustomerReceivablesSummaries`
(`src/server/ar/summary.ts`) — a single batched query grouped by customer
in memory, added specifically to avoid an N+1 query per row on the
customer list page. Every number on the dashboard is real: no
placeholder KPI, no synthetic trend line, no invented percentage.

The invoices list shows a human-readable collection status per row
(Active/Paused/Blocked/Completed/Stopped, or nothing for never-enrolled)
via `getCollectionsBadgesForInvoices` — a batched version of the existing
per-invoice `getCollectionsBadgeForInvoice`, added so the list page issues
one query instead of one per invoice.

## Action Center

Reframed around the actual workflow: an `ActionProposal` is detected,
recommended, and — once a human approves it from the list — reviewed
before it's ever sent. `/app/[orgSlug]/actions/[proposalId]` now
distinguishes three states explicitly instead of assuming the happy path:
not yet approved (nothing to review), approved but the customer has no
email on file (a warning `Alert` with a direct link to fix the customer
record, rather than letting the page crash — this previously threw an
uncaught `MissingCustomerEmailError` from `src/server/communications/
draft.ts`), and approved with a preparable/prepared reminder. The resend-while-uncertain confirmation was upgraded from
`window.confirm` to the shared `Dialog` component, consistent with the
rest of the app.

## Automation

`/app/[orgSlug]/automation` makes the collections policy, its steps, and
each invoice's live sequence state legible without reading source code:
step tone, wait days, and channel are shown in plain language, and the
`AUTO_SEND` opt-in is visually flagged as the risky, OWNER-only setting it
is (warning-toned, with the actual consequence spelled out) rather than a
neutral toggle indistinguishable from any other setting.

## Settings

Restructured into tabs — General, Members, Integrations, Billing,
Security — matching what other B2B SaaS products call these areas, so
nothing has to be relabeled later just to sound less internal. Integrations
renders the real Phase 6 `getProviderRegistrySnapshot()` (provider,
category, configured/disabled, deployment profile) instead of a mocked
list; Billing states plainly that subscription billing isn't built yet
(Phase 10) instead of showing a fake plan/invoice UI.

## Accessibility

Verified with `@axe-core/playwright` across all ten primary
authenticated/marketing pages plus representative empty/loading/error
states. Two real violations were found and fixed:

- **Color contrast**: light-mode `--muted-foreground` (`#6b7386` against
  the `#f6f7f9` background) measured 4.43:1, just under WCAG AA's 4.5:1
  for normal text. Darkened to `#5a6278` (~5.57:1). Dark mode was already
  compliant and untouched.
- **Unlabeled control**: the automation page's master on/off switch was a
  `<button>` whose only visible content was the presentational `Switch`
  (`aria-hidden`), so it had zero accessible name — a critical-impact
  violation. Fixed with a dynamic `aria-label` ("Enable/Disable collections
  automation") plus `aria-pressed`, reflecting the actual toggle state.

Re-running the full scan after both fixes found zero violations. Every
interactive element in the design system is reachable and operable by
keyboard (native `<button>`/`<a>`/`<dialog>`/`<select>` semantics
throughout — no custom-widget reimplementation of something the platform
already provides correctly).

## Responsive approach

Verified by direct viewport testing at 390px (mobile), 768px (tablet),
1024px (small desktop), and 1440px (desktop) — zero horizontal overflow
at any breakpoint. The sidebar collapses to a header + drawer below `lg`;
forms and metric grids collapse from multi-column to single-column;
**tables scroll horizontally inside their own `overflow-x-auto` container
rather than converting to a stacked card layout on mobile** — an accepted
tradeoff (see [Known limitations](#known-limitations)), not an oversight.

## Real data vs. marketing illustration

Everything behind authentication renders only real data returned by a
server function — there is no mock KPI, no fabricated customer name, no
placeholder invoice anywhere in `/app/**`. The landing page (`/`, signed
out) is the one place allowed to use obviously illustrative
marketing visuals (e.g. a stylized dashboard preview), and nothing on it
is presented as a real customer's data or a real integration status that
isn't true today — see the honest, non-overclaiming integration-readiness
section on the landing page, which lists what's implemented today
(AI/Email/Messaging provider boundaries) rather than implying a catalog of
live third-party connections.

## Known limitations

- **Tables don't convert to stacked cards on narrow screens** — they
  scroll horizontally in a contained region instead. Acceptable for a
  first premium pass; a true responsive-table (card) conversion is a
  candidate for later, targeted commercial feedback rather than a Phase 7
  blocker.
- **No manual light/dark toggle** — the app follows
  `prefers-color-scheme` only, consistent with how the rest of the product
  already behaved before this phase.
- **Settings → Billing is intentionally inert** — it states plainly that
  PAYNORA's own subscription billing isn't implemented yet (that's Phase
  8's `BillingProvider` SDK work), rather than shipping a UI that implies
  billing works today.
