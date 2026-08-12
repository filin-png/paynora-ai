import type { BadgeProps } from "@/components/ui/badge";
import { prisma } from "@/server/db/client";
import { getCollectionStatusForInvoice, type CollectionStatusView } from "@/server/collections/sequences";

export type CollectionsBadgeView = { label: string; tone: NonNullable<BadgeProps["tone"]> } | null;

/**
 * Human-readable collections-status mapping shared by the invoice list and
 * detail pages — deliberately the same five words the automation brief
 * calls for (Active/Paused/Blocked/Completed/Stopped), never an internal
 * enum name (`blocked_uncertain`, `AUTO_SEND`, ...). See
 * docs/product-ui.md#copy.
 */
export function getCollectionsBadgeView(status: CollectionStatusView): CollectionsBadgeView {
  switch (status.kind) {
    case "not_enrolled":
      return null;
    case "completed":
      return { label: "Completed", tone: "success" };
    case "stopped":
      return { label: "Stopped", tone: "neutral" };
    case "paused":
      return { label: "Paused", tone: "neutral" };
    case "blocked_uncertain":
      return { label: "Blocked", tone: "warning" };
    case "active":
      return { label: "Active", tone: "success" };
  }
}

export async function getCollectionsBadgeForInvoice(
  organizationId: string,
  invoiceId: string,
): Promise<CollectionsBadgeView> {
  const status = await getCollectionStatusForInvoice(organizationId, invoiceId);
  return getCollectionsBadgeView(status);
}

/**
 * A list-view-friendly variant: two organization-wide queries instead of
 * two-to-four per invoice — `getCollectionStatusForInvoice` is precise but
 * was designed for a single invoice detail page, and calling it once per
 * row would be an N+1 query pattern on a page that can list many invoices.
 * This intentionally skips the step-count detail `active` carries (the
 * list badge never shows it), which is exactly what makes the lighter
 * query possible.
 */
export async function getCollectionsBadgesForInvoices(
  organizationId: string,
  invoiceIds: string[],
): Promise<Map<string, CollectionsBadgeView>> {
  if (invoiceIds.length === 0) return new Map();

  const [sequences, blockingCommunications] = await Promise.all([
    prisma.collectionSequence.findMany({
      where: { organizationId, invoiceId: { in: invoiceIds } },
    }),
    prisma.communication.findMany({
      where: { organizationId, invoiceId: { in: invoiceIds }, status: { in: ["SENDING", "UNCERTAIN"] } },
      select: { invoiceId: true },
    }),
  ]);
  const blockedInvoiceIds = new Set(blockingCommunications.map((c) => c.invoiceId));

  const result = new Map<string, CollectionsBadgeView>();
  for (const sequence of sequences) {
    if (sequence.status === "COMPLETED") {
      result.set(sequence.invoiceId, { label: "Completed", tone: "success" });
    } else if (sequence.status === "STOPPED") {
      result.set(sequence.invoiceId, { label: "Stopped", tone: "neutral" });
    } else if (sequence.status === "PAUSED") {
      result.set(sequence.invoiceId, { label: "Paused", tone: "neutral" });
    } else if (blockedInvoiceIds.has(sequence.invoiceId)) {
      result.set(sequence.invoiceId, { label: "Blocked", tone: "warning" });
    } else {
      result.set(sequence.invoiceId, { label: "Active", tone: "success" });
    }
  }
  return result;
}
