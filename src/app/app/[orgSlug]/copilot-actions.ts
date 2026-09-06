"use server";

import { isFeatureNotEntitledMessage } from "@/server/billing/entitlements";
import { answerCopilotQuestion, type CopilotQuestionType } from "@/server/copilot/service";
import { isResourceNotFoundError } from "@/lib/not-found";
import { requireOrganizationMembershipForPage } from "@/server/tenancy/guards";

/**
 * Phase 22 — the one Server Action every Copilot surface (Overview,
 * Invoice detail, Customer detail, Action Center) calls. `organizationId`
 * is always re-derived server-side from `orgSlug` via
 * `requireOrganizationMembershipForPage` — never trusted from the client
 * — the same tenant-isolation discipline every other Server Action in
 * this app follows. `question` is one of the small fixed
 * `CopilotQuestionType` set (never free text), so there is no
 * user-authored string that reaches this function at all, let alone an
 * AI prompt.
 */
export type CopilotAskResult =
  | { status: "ok"; deterministicAnswer: string; aiAnswer?: string; aiGenerated: boolean }
  | { status: "not_entitled" }
  | { status: "not_found" }
  | { status: "error" };

export async function askCopilotAction(
  orgSlug: string,
  question: CopilotQuestionType,
  targetId?: string,
): Promise<CopilotAskResult> {
  const context = await requireOrganizationMembershipForPage(orgSlug);
  try {
    const answer = await answerCopilotQuestion(context.organization.id, question, targetId);
    return { status: "ok", ...answer };
  } catch (error) {
    if (isResourceNotFoundError(error)) return { status: "not_found" };
    const message = error instanceof Error ? error.message : String(error);
    if (isFeatureNotEntitledMessage(message)) return { status: "not_entitled" };
    // Never echo a raw exception message to the client — see
    // SECURITY.md's error-normalization discipline. The only messages
    // this function ever forwards are the two recognized, safe,
    // user-facing ones checked above.
    console.error(`[copilot] askCopilotAction failed for org via ${orgSlug}: ${message}`);
    return { status: "error" };
  }
}
