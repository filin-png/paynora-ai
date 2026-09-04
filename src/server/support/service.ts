import { env } from "@/lib/env";
import { recordActivityEvent } from "@/server/ar/activity";
import { prisma } from "@/server/db/client";
import { sendTransactionalEmail, type TransactionalEmailOptions } from "@/server/email/transactional";

/**
 * Phase 17 — a minimal, honest support-request mechanism: a member
 * submits a message, it's persisted (the durable record — never lost even
 * if the email step below fails or is unconfigured), audited via the same
 * ActivityEvent trail every other tenant action already uses, and, if
 * SUPPORT_NOTIFICATION_EMAIL is configured, a best-effort notification
 * email goes out — same fire-and-forget pattern as password-reset/
 * invitation emails (src/server/email/transactional.ts).
 *
 * There is no ticket-status workflow and no admin UI to triage these:
 * this codebase has no "PAYNORA staff" role distinct from an
 * organization's own members to gate such a UI behind. Until one exists,
 * a submitted request is read the same way scripts/subscription-report.ts
 * reads other founder-only data — a direct, manual lookup — or via the
 * notification email when configured. Building a fake triage dashboard
 * with no real workflow behind it would be exactly the kind of
 * appearance-of-completeness this codebase avoids.
 */
const MAX_MESSAGE_LENGTH = 4000;

export type SubmitSupportRequestInput = {
  message: string;
};

export async function submitSupportRequest(
  organizationId: string,
  userId: string,
  input: SubmitSupportRequestInput,
  emailOptions: TransactionalEmailOptions = {},
) {
  const message = input.message.trim();
  if (message.length === 0) {
    throw new Error("Support request message cannot be empty");
  }
  if (message.length > MAX_MESSAGE_LENGTH) {
    throw new Error(`Support request message must be ${MAX_MESSAGE_LENGTH} characters or fewer`);
  }

  const [request, user, organization] = await Promise.all([
    prisma.supportRequest.create({ data: { organizationId, userId, message } }),
    prisma.user.findUniqueOrThrow({ where: { id: userId }, select: { email: true, name: true } }),
    prisma.organization.findUniqueOrThrow({ where: { id: organizationId }, select: { name: true } }),
  ]);

  await recordActivityEvent(prisma, {
    organizationId,
    type: "SUPPORT_REQUEST_SUBMITTED",
    summary: `${user.name ?? user.email} submitted a support request`,
  });

  if (env.SUPPORT_NOTIFICATION_EMAIL) {
    try {
      await sendTransactionalEmail(
        {
          to: env.SUPPORT_NOTIFICATION_EMAIL,
          subject: `[PAYNORA support] ${organization.name}`,
          text: [
            `Organization: ${organization.name} (${organizationId})`,
            `From: ${user.name ?? "(no name on file)"} <${user.email}>`,
            "",
            message,
          ].join("\n"),
          idempotencyKey: `support-request:${request.id}`,
        },
        emailOptions,
      );
    } catch (error) {
      // Best-effort, exactly like every other transactional-email caller
      // in this codebase — the request row above is the real, durable
      // record; a notification-email failure must never make a member's
      // submitted request look like it failed to send.
      const name = error instanceof Error ? error.name : "unknown error";
      console.warn(`[support] notification email dispatch did not confirm delivery: ${name}`);
    }
  }

  return request;
}
