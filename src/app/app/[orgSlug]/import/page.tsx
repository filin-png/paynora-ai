import Link from "next/link";
import { ArrowLeft } from "lucide-react";

import { Card } from "@/components/ui/card";
import { PageHeader, SectionHeader } from "@/components/ui/page-header";
import { Tabs } from "@/components/ui/tabs";
import { CUSTOMER_CSV_HEADERS, CUSTOMER_CSV_REQUIRED_HEADERS } from "@/server/ingestion/csv/customers";
import { INVOICE_CSV_HEADERS } from "@/server/ingestion/csv/invoices";
import { MAX_IMPORT_FILE_SIZE_BYTES, MAX_IMPORT_ROWS } from "@/server/ingestion/limits";
import { requireOrganizationMembershipForPage } from "@/server/tenancy/guards";
import { importCustomersAction, importInvoicesAction } from "./actions";
import { ImportForm } from "./import-form";

type ImportType = "customers" | "invoices";

export default async function ImportPage({
  params,
  searchParams,
}: {
  params: Promise<{ orgSlug: string }>;
  searchParams: Promise<{ type?: string }>;
}) {
  const { orgSlug } = await params;
  const { type: rawType } = await searchParams;
  const type: ImportType = rawType === "invoices" ? "invoices" : "customers";
  await requireOrganizationMembershipForPage(orgSlug);

  const boundImportCustomers = importCustomersAction.bind(null, orgSlug);
  const boundImportInvoices = importInvoicesAction.bind(null, orgSlug);
  const backHref = type === "invoices" ? `/app/${orgSlug}/invoices` : `/app/${orgSlug}/customers`;

  return (
    <div className="flex max-w-3xl flex-col gap-6">
      <div>
        <Link
          href={backHref}
          className="inline-flex items-center gap-1.5 text-xs font-medium text-muted hover:text-foreground"
        >
          <ArrowLeft className="size-3.5" />
          {type === "invoices" ? "Invoices" : "Customers"}
        </Link>
        <PageHeader
          className="mt-3"
          title="Import from CSV"
          description="Bulk-import customers or invoices instead of entering them one at a time."
        />
      </div>

      <Tabs
        items={[
          { href: `/app/${orgSlug}/import?type=customers`, label: "Customers", active: type === "customers" },
          { href: `/app/${orgSlug}/import?type=invoices`, label: "Invoices", active: type === "invoices" },
        ]}
      />

      {type === "customers" ? (
        <>
          <Card className="flex flex-col gap-2 p-5">
            <SectionHeader title="Expected CSV format" />
            <p className="text-sm text-muted">
              A UTF-8 CSV with a header row. Required columns:{" "}
              <code className="rounded bg-accent-soft px-1.5 py-0.5 text-xs">
                {CUSTOMER_CSV_REQUIRED_HEADERS.join(", ")}
              </code>
              . Optional columns:{" "}
              <code className="rounded bg-accent-soft px-1.5 py-0.5 text-xs">
                {CUSTOMER_CSV_HEADERS.filter((h) => !(CUSTOMER_CSV_REQUIRED_HEADERS as readonly string[]).includes(h)).join(", ")}
              </code>
              .
            </p>
            <p className="text-sm text-muted">
              Every row needs a valid, non-empty email — it&rsquo;s how a re-imported file recognizes a customer it
              already created and avoids making a duplicate. A customer already in this organization with the same
              email is skipped, never overwritten.
            </p>
            <p className="text-xs text-muted-foreground">
              Up to {MAX_IMPORT_ROWS.toLocaleString()} rows, {Math.floor(MAX_IMPORT_FILE_SIZE_BYTES / (1024 * 1024))}{" "}
              MB per file.
            </p>
          </Card>
          <ImportForm action={boundImportCustomers} submitLabel="Import customers" />
        </>
      ) : (
        <>
          <Card className="flex flex-col gap-2 p-5">
            <SectionHeader title="Expected CSV format" />
            <p className="text-sm text-muted">
              A UTF-8 CSV with a header row. Required columns:{" "}
              <code className="rounded bg-accent-soft px-1.5 py-0.5 text-xs">{INVOICE_CSV_HEADERS.join(", ")}</code>.
            </p>
            <p className="text-sm text-muted">
              <code className="rounded bg-accent-soft px-1.5 py-0.5 text-xs">customerEmail</code> must match an
              existing customer&rsquo;s email exactly (case-insensitive) — import customers first if they
              don&rsquo;t exist yet. <code className="rounded bg-accent-soft px-1.5 py-0.5 text-xs">amount</code> is a
              plain decimal like <code className="rounded bg-accent-soft px-1.5 py-0.5 text-xs">1500.00</code> (at
              most 2 decimal places, no currency symbol). Dates are{" "}
              <code className="rounded bg-accent-soft px-1.5 py-0.5 text-xs">YYYY-MM-DD</code>.
            </p>
            <p className="text-sm text-muted">
              An invoice number that already exists in this organization with identical data is skipped (safe to
              import the same file twice). If it exists with different data, that row fails — existing invoices are
              never overwritten by an import.
            </p>
            <p className="text-xs text-muted-foreground">
              Up to {MAX_IMPORT_ROWS.toLocaleString()} rows, {Math.floor(MAX_IMPORT_FILE_SIZE_BYTES / (1024 * 1024))}{" "}
              MB per file.
            </p>
          </Card>
          <ImportForm action={boundImportInvoices} submitLabel="Import invoices" />
        </>
      )}
    </div>
  );
}
