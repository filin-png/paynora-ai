import { MessagingProviderRejectedError } from "../errors";
import type { MessagingMessage, MessagingProvider, MessagingSendResult } from "../types";

/**
 * Deterministic, in-memory MessagingProvider used only by tests. No
 * network call, no vendor SDK — mirrors
 * src/server/email/providers/fake.ts. Not reachable from application code —
 * `MESSAGING_PROVIDER` only ever resolves to `none` or `telegram`
 * (src/server/messaging/service.ts).
 */
export function createFakeMessagingProvider(
  behavior:
    | { kind: "success"; providerMessageId?: string }
    | { kind: "rejected"; message: string }
    | { kind: "error"; message: string }
    | { kind: "hang" },
  name = "fake",
): MessagingProvider {
  return {
    name,
    async send(message: MessagingMessage): Promise<MessagingSendResult> {
      switch (behavior.kind) {
        case "success":
          return { provider: name, providerMessageId: behavior.providerMessageId ?? `fake-${message.idempotencyKey}` };
        case "rejected":
          throw new MessagingProviderRejectedError(name, behavior.message);
        case "error":
          throw new Error(behavior.message);
        case "hang":
          return new Promise<MessagingSendResult>(() => {
            // Deliberately never resolves — used to exercise gateway timeout handling.
          });
      }
    },
  };
}
