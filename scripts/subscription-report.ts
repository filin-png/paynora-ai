#!/usr/bin/env tsx
/**
 * PAYNORA subscription/plan report — a founder-only, read-only CLI
 * listing every organization's plan and subscription state (Phase 17),
 * plus recent billing-webhook payment history (Phase 18, once a real
 * BillingProvider adapter exists and starts writing to
 * SubscriptionPayment — see src/server/billing/webhook-events.ts). See
 * docs/exit-readiness.md's "Financial exports available" checklist item.
 *
 * This is deliberately NOT the same thing as an organization's own AR
 * data export (src/server/ar/export.ts, Settings -> General): this
 * report is about PAYNORA's *own* business (which orgs are on which
 * plan, what they've actually paid PAYNORA), not about any one
 * organization's customers/invoices. There is no in-app "PAYNORA staff"
 * role in this codebase to gate a web page behind, so — like the
 * existing live-smoke-test.ts — this stays a manual, dev-only CLI rather
 * than inventing an admin-authorization system this phase wasn't asked
 * to build.
 *
 * Deliberately does NOT compute or print a revenue/MRR figure: the plan
 * catalog (src/server/billing/plans.ts) has no price field at all — its
 * own doc comment says why ("no RUB/USD prices are required yet, do not
 * make arbitrary pricing decisions", Phase 11.3 brief), and no real
 * BillingProvider adapter exists yet to populate SubscriptionPayment
 * with real amounts either. Inventing a figure here would be fabricating
 * a number this codebase has explicitly refused to guess. The payment
 * table below prints whatever SubscriptionPayment rows actually exist
 * (real webhook deliveries only) — it will simply be empty until both a
 * real adapter and real pricing exist. Once they do, this report's next
 * revision can sum a real figure from real data.
 *
 * Usage: npm run report:subscriptions [-- --csv]
 * For a clean CSV file (no npm's own script-echo banner mixed into
 * stdout): npm run --silent report:subscriptions -- --csv > report.csv
 */
import { config as loadEnv } from "dotenv";

// `quiet: true` suppresses dotenv's own startup tip banner, which
// otherwise prints to stdout and would corrupt piped --csv output (e.g.
// `npm run --silent report:subscriptions -- --csv > report.csv`).
loadEnv({ path: ".env.local", quiet: true });
loadEnv({ quiet: true });

async function main() {
  const { prisma } = await import("@/server/db/client");
  const { minorToMajorString } = await import("@/server/ar/money");

  const organizations = await prisma.organization.findMany({
    select: {
      name: true,
      slug: true,
      createdAt: true,
      subscription: { select: { plan: true, status: true } },
    },
    orderBy: { createdAt: "asc" },
  });

  const rows = organizations.map((org) => ({
    organization: org.name,
    slug: org.slug,
    plan: org.subscription?.plan ?? "FREE",
    status: org.subscription?.status ?? "ACTIVE",
    created_at: org.createdAt.toISOString().slice(0, 10),
  }));

  const planCounts = new Map<string, number>();
  for (const row of rows) {
    planCounts.set(row.plan, (planCounts.get(row.plan) ?? 0) + 1);
  }

  const isCsv = process.argv.includes("--csv");

  if (isCsv) {
    const Papa = (await import("papaparse")).default;
    console.log(Papa.unparse(rows));
  } else {
    console.table(rows);
  }

  // Payment history: real SubscriptionPayment rows only — one per
  // uniquely-processed billing webhook delivery (see
  // src/server/billing/webhook-events.ts). Empty until a real adapter
  // exists and an organization has actually been billed. Omitted from
  // --csv output so the plan roster above stays a clean, single-table
  // pipe target; run without --csv to see this section.
  if (!isCsv) {
    const payments = await prisma.subscriptionPayment.findMany({
      select: {
        organization: { select: { name: true, slug: true } },
        provider: true,
        status: true,
        amountMinor: true,
        currency: true,
        receivedAt: true,
      },
      orderBy: { receivedAt: "desc" },
      take: 50,
    });

    const paymentRows = payments.map((p) => ({
      organization: p.organization.name,
      slug: p.organization.slug,
      provider: p.provider,
      status: p.status,
      amount: p.amountMinor !== null ? minorToMajorString(p.amountMinor) : "—",
      currency: p.currency ?? "—",
      received_at: p.receivedAt.toISOString(),
    }));

    console.error(`\n[report] Recent subscription payments (most recent ${paymentRows.length}, real webhook deliveries only):`);
    if (paymentRows.length > 0) {
      console.table(paymentRows);
    } else {
      console.error("  none yet — no real BillingProvider adapter is connected (see docs/provider-strategy.md#billingprovider).");
    }
  }

  const planSummary = Array.from(planCounts.entries())
    .map(([plan, count]) => `${plan}: ${count}`)
    .join(", ");
  console.error(
    `\n[report] ${rows.length} organization(s) — ${planSummary || "none"}. ` +
      "No revenue/MRR figure is computed: no real pricing or BillingProvider is " +
      "connected yet (see docs/commercial-readiness.md and docs/exit-readiness.md).",
  );
  await prisma.$disconnect();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
