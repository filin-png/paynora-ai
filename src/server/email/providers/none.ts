import { EmailDisabledError } from "../errors";
import type { EmailMessage, EmailProvider, EmailSendResult } from "../types";

/**
 * The default provider when EMAIL_PROVIDER=none (src/lib/env.ts). Every
 * call fails the same documented way, so "no provider configured" is a
 * real, testable object rather than a null check scattered across
 * callers — mirrors src/server/ai/providers/none.ts.
 */
export const noneEmailProvider: EmailProvider = {
  name: "none",
  send(_message: EmailMessage): Promise<EmailSendResult> {
    throw new EmailDisabledError();
  },
};
