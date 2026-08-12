import { MessagingDisabledError } from "../errors";
import type { MessagingMessage, MessagingProvider, MessagingSendResult } from "../types";

/**
 * The default provider when MESSAGING_PROVIDER=none (src/lib/env.ts). Every
 * call fails the same documented way, so "no provider configured" is a
 * real, testable object rather than a null check scattered across callers —
 * mirrors src/server/email/providers/none.ts.
 */
export const noneMessagingProvider: MessagingProvider = {
  name: "none",
  send(_message: MessagingMessage, _options?: { signal?: AbortSignal }): Promise<MessagingSendResult> {
    throw new MessagingDisabledError();
  },
};
