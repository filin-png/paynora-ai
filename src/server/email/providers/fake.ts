import { EmailProviderRejectedError } from "../errors";
import type { EmailMessage, EmailProvider, EmailSendResult } from "../types";

/**
 * Deterministic, in-memory EmailProvider used only by tests. No network
 * call, no vendor SDK — this is what makes it possible to test success,
 * definite-rejection, and ambiguous/hanging (timeout) outcomes without a
 * real mail server, and what keeps CI free of any real email network
 * dependency. Not reachable from application code — `EMAIL_PROVIDER` only
 * ever resolves to `none` or `smtp` (src/server/email/service.ts).
 * Mirrors src/server/ai/providers/fake.ts.
 */
export function createFakeEmailProvider(
  behavior:
    | { kind: "success"; providerMessageId?: string }
    | { kind: "rejected"; message: string }
    | { kind: "error"; message: string }
    | { kind: "hang" },
  name = "fake",
): EmailProvider {
  return {
    name,
    async send(message: EmailMessage): Promise<EmailSendResult> {
      switch (behavior.kind) {
        case "success":
          return { provider: name, providerMessageId: behavior.providerMessageId ?? `fake-${message.idempotencyKey}` };
        case "rejected":
          throw new EmailProviderRejectedError(name, behavior.message);
        case "error":
          throw new Error(behavior.message);
        case "hang":
          return new Promise<EmailSendResult>(() => {
            // Deliberately never resolves — used to exercise gateway timeout handling.
          });
      }
    },
  };
}
