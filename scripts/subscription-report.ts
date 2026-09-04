#!/usr/bin/env tsx
/**
 * PAYNORA subscription/plan report — a founder-only, read-only CLI
 * listing every organization's plan and subscription state (Phase 17).
 * See docs/exit-readiness.md's "Financial exports available" checklist
 * item.
 *
 * This is deliberately NOT the same thing as an organization's own AR
 * data export (src/server/ar/export.ts, Settings -> General): this
 * report is about PAYNORA's *own* business (which orgs are on which
 * plan), not about any one organization's customers/invoices. There is
 * no in-app "PAYNORA staff" role in this codebase to gate a web page
 * behind, so — like the existing live-smoke-test.ts — this stays a
 * manual, dev-only CLI rather than inventing an admin-authorization
 * system this phase wasn't asked to build.
 *
 * Deliberately does NOT compute or print a revenue/MRR figure: the plan
 * catalog (src/server/billing/plans.ts) has no price field at all — its
 * own doc comment says why ("no RUB/USD prices are required yet, do not
 * make arbitrary pricing decisions", Phase 11.3 brief). Inventing a price
 * here to produce a dollar figure would be fabricating a number this
 * codebase has explicitly refused to guess. Once real pricing and a real
 * BillingProvider both exist, this report's next revision can sum a real
 * figure from real data — until then, a plan/status roster is the whole
 * honest answer.
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

  if (process.argv.includes("--csv")) {
    const Papa = (await import("papaparse")).default;
    console.log(Papa.unparse(rows));
  } else {
    console.table(rows);
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
