import { env } from "@/lib/env";
import { EmailConfigurationError, EmailDisabledError } from "./errors";
import { smtpEmailProvider } from "./providers/smtp";
import type { EmailProvider } from "./types";

/** True when `EMAIL_PROVIDER` selects anything other than "none". */
export function isEmailSendingEnabled(): boolean {
  return env.EMAIL_PROVIDER !== "none";
}

/**
 * Resolves the EmailProvider for the configured `EMAIL_PROVIDER` and
 * validates the sender address is set — this is the one place that knows
 * SMTP (or any future transport) exists; nothing else in the codebase
 * imports a provider module directly. Deliberately synchronous and
 * side-effect-free: it throws `EmailDisabledError`/`EmailConfigurationError`
 * *before* the communications domain claims a send attempt, so a
 * misconfigured deployment never enters `SENDING` — see
 * src/server/communications/send.ts and
 * docs/communications.md#sender-safety.
 */
export function resolveEmailProvider(): EmailProvider {
  const provider = env.EMAIL_PROVIDER;
  if (provider === "none") throw new EmailDisabledError();
  if (!env.PAYNORA_EMAIL_FROM) {
    throw new EmailConfigurationError('PAYNORA_EMAIL_FROM is not configured');
  }
  switch (provider) {
    case "smtp":
      return smtpEmailProvider;
  }
}

/** The sender address for every outgoing email — see docs/communications.md#sender-safety. */
export function getSenderAddress(): string {
  if (!env.PAYNORA_EMAIL_FROM) {
    throw new EmailConfigurationError('PAYNORA_EMAIL_FROM is not configured');
  }
  return env.PAYNORA_EMAIL_FROM;
}
