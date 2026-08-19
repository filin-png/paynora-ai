import { prisma } from "@/server/db/client";
import { getOrganizationEntitlements } from "@/server/billing/entitlements";

export type OnboardingStepId =
  | "create_organization"
  | "add_first_customer"
  | "add_first_invoice"
  | "review_overview"
  | "review_action_center"
  | "configure_automation";

export type OnboardingStep = {
  id: OnboardingStepId;
  title: string;
  description: string;
  completed: boolean;
  locked: boolean;
  ctaHref: string;
  ctaLabel: string;
};

export type OnboardingState = {
  steps: OnboardingStep[];
  completedCount: number;
  totalSteps: number;
  /** True once every *achievable* step (i.e. not locked by plan) is complete — a locked step never blocks this. */
  isComplete: boolean;
};

/**
 * Derives first-run onboarding progress entirely from real domain data —
 * no separate "onboarding" table, no fake completion flags (Phase 11.4
 * brief, section 2). Every signal here is something the organization
 * already has for its own reasons (a customer exists, an invoice exists,
 * automation is on) — onboarding is a read model over that, not a
 * second source of truth that could drift from it.
 */
export async function getOnboardingState(organizationId: string, orgSlug: string): Promise<OnboardingState> {
  const base = `/app/${orgSlug}`;
  const [customerCount, invoiceCount, openInvoiceCount, proposalCount, organization, { entitlements }] =
    await Promise.all([
      prisma.customer.count({ where: { organizationId, archivedAt: null } }),
      prisma.invoice.count({ where: { organizationId } }),
      prisma.invoice.count({ where: { organizationId, status: "OPEN" } }),
      prisma.actionProposal.count({ where: { organizationId } }),
      prisma.organization.findUniqueOrThrow({ where: { id: organizationId }, select: { automationEnabled: true } }),
      getOrganizationEntitlements(organizationId),
    ]);

  const hasCustomer = customerCount > 0;
  const hasInvoice = invoiceCount > 0;
  const automationEntitled = entitlements.collectionsAutomationEnabled;

  const steps: OnboardingStep[] = [
    {
      id: "create_organization",
      title: "Create your organization",
      description: "Your workspace is set up and ready to use.",
      completed: true,
      locked: false,
      ctaHref: `${base}/settings`,
      ctaLabel: "View settings",
    },
    {
      id: "add_first_customer",
      title: "Add your first customer",
      description: "Add one manually, or import a CSV of your existing customers.",
      completed: hasCustomer,
      locked: false,
      ctaHref: hasCustomer ? `${base}/customers` : `${base}/customers/new`,
      ctaLabel: hasCustomer ? "View customers" : "Add a customer",
    },
    {
      id: "add_first_invoice",
      title: "Add your first invoice",
      description: "Record an invoice manually, or import a CSV of open invoices.",
      completed: hasInvoice,
      locked: !hasCustomer,
      ctaHref: hasInvoice ? `${base}/invoices` : hasCustomer ? `${base}/invoices/new` : `${base}/customers/new`,
      ctaLabel: hasInvoice ? "View invoices" : hasCustomer ? "Add an invoice" : "Add a customer first",
    },
    {
      id: "review_overview",
      title: "Review your receivables overview",
      description: "See what's outstanding, overdue, and current at a glance.",
      completed: openInvoiceCount > 0,
      locked: !hasInvoice,
      ctaHref: base,
      ctaLabel: "Go to Overview",
    },
    {
      id: "review_action_center",
      title: "Review an Action Center recommendation",
      description: "PAYNORA flags invoices that need follow-up — you decide, nothing sends on its own.",
      completed: proposalCount > 0,
      locked: !hasInvoice,
      ctaHref: `${base}/actions`,
      ctaLabel: "Open Action Center",
    },
    {
      id: "configure_automation",
      title: "Configure collections automation",
      description: automationEntitled
        ? "Set up a policy so overdue invoices get a consistent, approval-gated follow-up."
        : "Available on the Starter and Pro plans.",
      completed: organization.automationEnabled,
      locked: !automationEntitled,
      ctaHref: automationEntitled ? `${base}/automation` : `${base}/settings?tab=billing`,
      ctaLabel: automationEntitled ? "Configure automation" : "View plans",
    },
  ];

  const achievableSteps = steps.filter((step) => !step.locked || step.completed);
  const completedCount = steps.filter((step) => step.completed).length;

  return {
    steps,
    completedCount,
    totalSteps: steps.length,
    isComplete: achievableSteps.every((step) => step.completed),
  };
}
