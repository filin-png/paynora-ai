import { archiveCustomer, createCustomer } from "@/server/ar/customers";
import { toDateOnlyString } from "@/server/ar/dates";
import { cancelInvoice, createInvoice } from "@/server/ar/invoices";
import { recordPayment } from "@/server/ar/payments";
import { prisma } from "@/server/db/client";

/**
 * Every demo customer's email lives under this fixed domain — the single
 * marker that makes demo data findable, idempotent, and safely removable
 * without a schema change (Phase 11.4 brief, section 4). Deliberately not a
 * new `isDemoData` column: this reuses `Customer.email`, a field that
 * already exists and is already indexed for lookups, and keeps demo status
 * a plain, auditable fact about the record rather than a hidden flag.
 */
const DEMO_EMAIL_DOMAIN = "demo.paynora.internal";

function demoEmail(local: string): string {
  return `${local}@${DEMO_EMAIL_DOMAIN}`;
}

export type DemoDataSeedResult =
  | { status: "already_seeded"; customerCount: number }
  | { status: "seeded"; customerCount: number; invoiceCount: number };

/**
 * Creates a small, realistic set of fictional B2B customers and invoices —
 * current, overdue, partially paid, and paid in full — entirely through the
 * same `createCustomer`/`createInvoice`/`recordPayment` domain functions the
 * manual UI forms use, so every plan-entitlement check, uniqueness
 * constraint, and activity-log entry those already enforce applies here too
 * (section 4: "do not weaken production domain invariants to support
 * seeding"). Idempotent: if this organization already has demo customers,
 * does nothing and reports that instead of creating duplicates.
 */
export async function seedDemoData(organizationId: string): Promise<DemoDataSeedResult> {
  const existing = await prisma.customer.count({
    where: { organizationId, email: { endsWith: `@${DEMO_EMAIL_DOMAIN}` } },
  });
  if (existing > 0) {
    return { status: "already_seeded", customerCount: existing };
  }

  const today = new Date();
  const offsetDate = (days: number): string => {
    const date = new Date(today);
    date.setUTCDate(date.getUTCDate() + days);
    return toDateOnlyString(date);
  };

  const customerSpecs = [
    { name: "Meridian Logistics LLC", email: demoEmail("ap.meridian-logistics"), companyName: "Meridian Logistics LLC" },
    { name: "Brightwell Manufacturing Co.", email: demoEmail("accounts.brightwell-mfg"), companyName: "Brightwell Manufacturing Co." },
    { name: "Solace Retail Group", email: demoEmail("billing.solace-retail"), companyName: "Solace Retail Group" },
    { name: "Northgate Consulting Partners", email: demoEmail("finance.northgate-consulting"), companyName: "Northgate Consulting Partners" },
  ];

  const customers = [];
  for (const spec of customerSpecs) {
    customers.push(
      await createCustomer(organizationId, { name: spec.name, email: spec.email, companyName: spec.companyName }),
    );
  }
  const [meridian, brightwell, solace, northgate] = customers;

  let invoiceSeq = 1;
  const nextNumber = () => `DEMO-${String(invoiceSeq++).padStart(4, "0")}`;
  let invoiceCount = 0;

  // Current: issued recently, not yet due.
  await createInvoice(organizationId, {
    customerId: meridian!.id,
    number: nextNumber(),
    currency: "USD",
    amountMinor: 480000n,
    issueDate: offsetDate(-5),
    dueDate: offsetDate(25),
  });
  invoiceCount++;

  // Due soon: within the "needs attention" lookahead window.
  await createInvoice(organizationId, {
    customerId: meridian!.id,
    number: nextNumber(),
    currency: "USD",
    amountMinor: 156000n,
    issueDate: offsetDate(-2),
    dueDate: offsetDate(5),
  });
  invoiceCount++;

  // Overdue, unpaid.
  await createInvoice(organizationId, {
    customerId: brightwell!.id,
    number: nextNumber(),
    currency: "USD",
    amountMinor: 925000n,
    issueDate: offsetDate(-50),
    dueDate: offsetDate(-20),
  });
  invoiceCount++;

  // Overdue, partially paid.
  const partiallyPaid = await createInvoice(organizationId, {
    customerId: solace!.id,
    number: nextNumber(),
    currency: "USD",
    amountMinor: 312500n,
    issueDate: offsetDate(-45),
    dueDate: offsetDate(-15),
  });
  invoiceCount++;
  await recordPayment(organizationId, partiallyPaid.id, { amountMinor: 150000n, paidAt: offsetDate(-10) });

  // Paid in full.
  const paidInFull = await createInvoice(organizationId, {
    customerId: northgate!.id,
    number: nextNumber(),
    currency: "USD",
    amountMinor: 680000n,
    issueDate: offsetDate(-40),
    dueDate: offsetDate(-10),
  });
  invoiceCount++;
  await recordPayment(organizationId, paidInFull.id, { amountMinor: 680000n, paidAt: offsetDate(-12) });

  return { status: "seeded", customerCount: customers.length, invoiceCount };
}

export type DemoDataClearResult = { status: "cleared"; customerCount: number } | { status: "nothing_to_clear" };

/**
 * Reverses `seedDemoData` using the same lever a real user has for their
 * own data — archiving customers (`archiveCustomer`) and cancelling their
 * still-open, unpaid invoices (`cancelInvoice`) — never a hard delete of
 * financial records. An invoice that already has a payment recorded is left
 * alone: cancelling it is already disallowed for any invoice
 * (`InvoiceHasPaymentsError`), demo or not, and a paid invoice is exactly
 * the kind of record this codebase never deletes. Scoped to this
 * organization's demo-marked customers only — never touches another
 * organization's data.
 */
export async function clearDemoData(organizationId: string): Promise<DemoDataClearResult> {
  const demoCustomers = await prisma.customer.findMany({
    where: { organizationId, email: { endsWith: `@${DEMO_EMAIL_DOMAIN}` }, archivedAt: null },
    select: { id: true },
  });
  if (demoCustomers.length === 0) return { status: "nothing_to_clear" };

  for (const customer of demoCustomers) {
    const openInvoices = await prisma.invoice.findMany({
      where: { organizationId, customerId: customer.id, status: "OPEN" },
      select: { id: true },
    });
    for (const invoice of openInvoices) {
      try {
        await cancelInvoice(organizationId, invoice.id);
      } catch {
        // Has recorded payments — a real financial record, left as history.
      }
    }
    await archiveCustomer(organizationId, customer.id);
  }

  return { status: "cleared", customerCount: demoCustomers.length };
}
