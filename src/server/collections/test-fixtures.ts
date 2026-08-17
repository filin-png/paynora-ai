import { createCustomer } from "@/server/ar/customers";
import { createInvoice } from "@/server/ar/invoices";
import { majorToMinor } from "@/server/ar/money";
import { createTestOrganization } from "@/server/ar/test-fixtures";
import { setOrganizationPlan } from "@/server/billing/subscription";
import { prisma } from "@/server/db/client";
import {
  createCollectionPolicy,
  setCollectionPolicyEnabled,
  setDefaultCollectionPolicy,
  setOrganizationAutomationEnabled,
} from "./policy";
import { DEFAULT_POLICY_TEMPLATE } from "./policy-schema";

/**
 * A fully wired, automation-ready organization: default policy created,
 * enabled, set as default, and the organization-level kill switch flipped
 * on — everything an engine test needs so it can focus on the scenario
 * under test rather than re-deriving this setup every time.
 *
 * Phase 11.3: new organizations default to FREE, which does not entitle
 * Collections Automation — upgraded to STARTER here so every existing
 * automation test (engine.test.ts, ingestion's automation-acceptance test,
 * etc.) keeps testing automation behavior itself, not plan gating. Tests
 * that specifically exercise the FREE-tier restriction call
 * setOrganizationPlan back down explicitly — see policy.test.ts and
 * engine.test.ts's own entitlement tests.
 */
export async function createAutomationReadyOrg(namePrefix = "Automation") {
  const { organization, user } = await createTestOrganization(namePrefix);
  await setOrganizationPlan(organization.id, "STARTER");
  const customer = await createCustomer(organization.id, { name: "Acme Co", email: "billing@acme.example" });
  const created = await createCollectionPolicy(organization.id, {
    name: DEFAULT_POLICY_TEMPLATE.name,
    steps: DEFAULT_POLICY_TEMPLATE.steps,
  });
  await setDefaultCollectionPolicy(organization.id, created.id);
  await setCollectionPolicyEnabled(organization.id, created.id, true);
  await setOrganizationAutomationEnabled(organization.id, true);
  const policy = await prisma.collectionPolicy.findUniqueOrThrow({ where: { id: created.id } });
  return { organization, user, customer, policy };
}

export async function createTestInvoice(
  organizationId: string,
  customerId: string,
  dueDate: string,
  amountMajor = 500,
) {
  return createInvoice(organizationId, {
    customerId,
    number: `INV-${Math.random().toString(36).slice(2, 8)}`,
    currency: "USD",
    amountMinor: majorToMinor(amountMajor),
    issueDate: dueDate,
    dueDate,
  });
}
