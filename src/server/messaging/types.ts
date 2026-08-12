/**
 * A fully-prepared outgoing message — mirrors src/server/email/types.ts's
 * EmailMessage exactly, on purpose: Messaging is a separate channel from
 * Email (a different vendor category, a different recipient identifier
 * shape), but the safety shape — pre-validated content, an idempotency key,
 * a normalized provider result — is the same contract this codebase already
 * trusts. See docs/integration-architecture.md#messaging.
 *
 * Phase 6 ships this boundary and a real Telegram adapter with no domain
 * call site wired in yet — nothing in this codebase constructs a
 * MessagingMessage or calls dispatchMessage today. That is deliberate: see
 * docs/provider-strategy.md's "don't implement a provider adapter before
 * the phase that needs it" rule. A future phase that adds operator
 * notifications or interactive Telegram actions (approve/reject/pause) is
 * what will actually call this.
 */
export type MessagingMessage = {
  /** Provider-specific recipient identifier — for Telegram, a numeric chat id or an "@channelusername". */
  to: string;
  text: string;
  /** Passed through for providers that support dedup on their side; the durable dedup boundary is DB-level, not this key. */
  idempotencyKey: string;
};

export type MessagingSendResult = {
  provider: string;
  /** Provider-assigned id for this send, when the provider returns one (e.g. Telegram's message_id). */
  providerMessageId?: string;
};

/**
 * Implemented by every concrete messaging vendor adapter
 * (src/server/messaging/providers/*.ts). A provider must throw
 * `MessagingProviderRejectedError` when — and only when — it can be
 * certain the message was not accepted (e.g. the vendor API responded with
 * an unambiguous "chat not found" / "bot was blocked" / "invalid
 * credentials" error). Any other thrown error (network failure, an
 * unrecognized exception, a timeout raised by the gateway wrapper) is
 * treated as an *unknown* outcome, never as a confirmed failure — see
 * src/server/messaging/gateway.ts and docs/integration-architecture.md
 * #messaging, which mirrors docs/communications.md#unknown-outcomes.
 */
export interface MessagingProvider {
  readonly name: string;
  /**
   * `options.signal`, when provided, is a real `AbortSignal` the gateway
   * aborts on timeout (src/server/messaging/gateway.ts) — an adapter that
   * makes an HTTP call must forward it to `fetch` so a timed-out request
   * is actually cancelled, not just abandoned. See
   * docs/integration-architecture.md#messaging.
   */
  send(message: MessagingMessage, options?: { signal?: AbortSignal }): Promise<MessagingSendResult>;
}
