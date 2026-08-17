import { dispatchEmail } from "./gateway";
import { getSenderAddress, isEmailSendingEnabled, resolveEmailProvider } from "./service";
import type { EmailProvider } from "./types";

/**
 * Minimal application-level email capability for auth-type transactional
 * messages (password reset, organization invitations — see
 * src/server/auth/password-reset.ts, src/server/tenancy/invitations.ts).
 * Deliberately not modeled through the Communication/DeliveryAttempt domain
 * (src/server/communications/*): that domain is structurally tied to an
 * invoiceId/customerId/ActionProposal and exists to drive the AR reminder
 * lifecycle, not generic account email — reusing it here would force an
 * awkward fit rather than reuse. This module goes straight to the same
 * EmailProvider/dispatchEmail gateway Communication itself calls
 * (src/server/email/gateway.ts, src/server/email/service.ts), so it's still
 * "the existing email/provider abstraction," just without the AR-specific
 * state machine wrapped around it — there is nothing here to retry, claim,
 * or reconcile: a transactional auth email is fire-and-forget best-effort,
 * never a proposal a human approved.
 */
export type TransactionalEmailOptions = {
  /**
   * Test-only dependency injection point, mirroring
   * src/server/communications/send.ts's identical `provider` option.
   * Production callers always omit this and go through
   * `resolveEmailProvider()`, which enforces EMAIL_PROVIDER/
   * PAYNORA_EMAIL_FROM configuration.
   */
  provider?: EmailProvider;
};

export type TransactionalEmailMessage = {
  to: string;
  subject: string;
  text: string;
  /**
   * Must never be derived from a raw reset/invitation token — this value
   * is passed through to the SMTP provider as a literal header
   * (X-Paynora-Idempotency-Key, see providers/smtp.ts) and must never carry
   * a secret. Callers pass a stable, non-secret identifier instead (e.g. a
   * token *hash*, or the token row's id).
   */
  idempotencyKey: string;
};

/**
 * Sends one transactional email best-effort. When email sending is
 * disabled (`EMAIL_PROVIDER=none`, the default — see Section B/D of the
 * Phase 11.2 brief), this is a silent no-op rather than an error: the
 * calling domain flows (password reset, invitations) must behave exactly
 * the same, generically and safely, whether or not real SMTP is
 * configured. Any other dispatch failure (rejected, timeout, unknown
 * outcome) propagates to the caller, which is responsible for deciding
 * whether that should be visible to the end user — see the callers' own
 * doc comments for why neither one ever surfaces a delivery failure back
 * through its public API.
 */
export async function sendTransactionalEmail(
  message: TransactionalEmailMessage,
  options: TransactionalEmailOptions = {},
): Promise<void> {
  const provider = options.provider ?? (isEmailSendingEnabled() ? resolveEmailProvider() : null);
  if (!provider) return;
  const from = getSenderAddress();
  await dispatchEmail(provider, { ...message, from });
}
