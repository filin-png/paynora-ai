import { NextResponse } from "next/server";

import { getSessionUser } from "@/server/auth/session";
import { exportCustomersCsv, exportInvoicesCsv, exportPaymentsCsv } from "@/server/ar/export";
import { OrganizationAccessDeniedError, UnauthenticatedError } from "@/server/tenancy/errors";
import { requireOrganizationRole } from "@/server/tenancy/context";

/**
 * Data portability (Phase 17): export this organization's own customers,
 * invoices, or payments as CSV — see src/server/ar/export.ts for exactly
 * why this is a distinct, tenant-scoped concern from
 * src/app/api/account/export/route.ts's personal-account export.
 *
 * OWNER-only: not because a regular member can't already see this exact
 * data (they can, through the Invoices/Customers pages), but to match
 * where this button lives in the UI (Settings -> General, already
 * OWNER-gated for every other organization-wide bulk action — sample
 * data seeding, renaming) rather than introduce a bulk-export
 * permission the rest of Settings doesn't otherwise have.
 */
const ENTITY_EXPORTERS = {
  customers: exportCustomersCsv,
  invoices: exportInvoicesCsv,
  payments: exportPaymentsCsv,
} as const;

type Entity = keyof typeof ENTITY_EXPORTERS;

function isEntity(value: string): value is Entity {
  return value in ENTITY_EXPORTERS;
}

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ orgSlug: string; entity: string }> },
): Promise<Response> {
  const { orgSlug, entity } = await params;

  if (!isEntity(entity)) {
    return NextResponse.json({ error: "Unknown export type" }, { status: 404 });
  }

  try {
    const user = await getSessionUser();
    const context = await requireOrganizationRole(user, orgSlug, "OWNER");

    const csv = await ENTITY_EXPORTERS[entity](context.organization.id);

    return new NextResponse(csv, {
      status: 200,
      headers: {
        "content-type": "text/csv; charset=utf-8",
        "content-disposition": `attachment; filename="paynora-${orgSlug}-${entity}.csv"`,
      },
    });
  } catch (error) {
    if (error instanceof UnauthenticatedError) {
      return NextResponse.json({ error: "Not signed in" }, { status: 401 });
    }
    if (error instanceof OrganizationAccessDeniedError) {
      return NextResponse.json({ error: "Organization not found or access denied" }, { status: 404 });
    }
    throw error;
  }
}
