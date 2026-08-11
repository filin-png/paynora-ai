/**
 * A fully-prepared outgoing email — every field here is already validated
 * and safe to hand to a transport (see src/server/communications/send.ts,
 * the only caller). No provider ever receives raw user/customer input
 * directly; the communications domain builds this from a Communication
 * row that has already passed subject/body/recipient validation.
 */
export type EmailMessage = {
  to: string;
  from: string;
  subject: string;
  text: string;
  /**
   * Passed through to providers that support dedup on their side (most
   * transactional SMTP relays don't have a concept of this — see
   * docs/communications.md#delivery-semantics for why the real duplicate
   * protection is the DB-level compare-and-swap in the communications
   * domain, not this key).
   */
  idempotencyKey: string;
};

export type EmailSendResult = {
  provider: string;
  /** Provider-assigned id for this send, when the provider returns one (e.g. an SMTP message-id). */
  providerMessageId?: string;
};

/**
 * Implemented by every concrete email vendor/transport adapter
 * (src/server/email/providers/*.ts). A provider must throw
 * `EmailProviderRejectedError` when — and only when — it can be certain
 * the message was not accepted (e.g. the transport returned a definite
 * rejection response). Any other thrown error (network failure, an
 * unrecognized exception, a timeout raised by the gateway wrapper) is
 * treated as an *unknown* outcome, never as a confirmed failure — see
 * src/server/email/gateway.ts and docs/communications.md#unknown-outcomes.
 */
export interface EmailProvider {
  readonly name: string;
  send(message: EmailMessage): Promise<EmailSendResult>;
}
