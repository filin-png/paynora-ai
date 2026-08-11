import type { DeterministicInvoiceContext } from "@/server/ar/reminder-context";

export const MAX_SUBJECT_LENGTH = 200;
export const MAX_BODY_LENGTH = 10_000;

/**
 * Everything the deterministic template (and the AI prompt, see
 * ai-context.ts) needs: the shared invoice facts plus the sending
 * organization's name, which isn't part of `DeterministicInvoiceContext`
 * because Operator's insight generation (src/server/operator/insights.ts)
 * doesn't need it.
 */
export type ReminderEmailContext = DeterministicInvoiceContext & { organizationName: string };

export type ReminderEmailContent = { subject: string; body: string };

/**
 * The always-available fallback — used whenever AI is disabled,
 * unconfigured, or fails validation/times out (src/server/ai/service.ts
 * never throws, so this is reached by a plain `null` check, not a catch
 * block). Every fact here is read directly from the deterministic
 * context, never invented.
 */
export function buildDeterministicReminderEmail(context: ReminderEmailContext): ReminderEmailContent {
  const subject = `Payment reminder — invoice ${context.invoiceNumber}`;
  const dayWord = context.daysOverdue === 1 ? "day" : "days";
  const body = `Hello,

This is a reminder that invoice ${context.invoiceNumber} has an outstanding balance of ${context.outstandingAmount}.

It was due on ${context.dueDate} (${context.daysOverdue} ${dayWord} ago).

If you have already made this payment, please disregard this message.

Thank you,
${context.organizationName}`;
  return { subject, body };
}
