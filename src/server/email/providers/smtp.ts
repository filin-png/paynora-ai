import nodemailer, { type Transporter } from "nodemailer";

import { env } from "@/lib/env";
import { EmailConfigurationError, EmailProviderRejectedError } from "../errors";
import type { EmailMessage, EmailProvider, EmailSendResult } from "../types";

type NodemailerSendError = Error & { responseCode?: number; code?: string };

/**
 * Only the failure modes we can be certain mean "not accepted": a 5xx SMTP
 * response (permanent rejection — bad mailbox, policy rejection, ...) or a
 * client-side envelope/message validation error from nodemailer itself
 * (malformed address, refused before anything was even sent). A 4xx
 * (transient) response or any connection-level error is deliberately
 * *not* treated as definite — see docs/communications.md#unknown-outcomes.
 */
function isDefiniteRejection(error: NodemailerSendError): boolean {
  if (typeof error.responseCode === "number" && error.responseCode >= 500 && error.responseCode < 600) {
    return true;
  }
  return error.code === "EENVELOPE" || error.code === "EMESSAGE";
}

let cachedTransporter: Transporter | null = null;

function getTransporter(): Transporter {
  if (cachedTransporter) return cachedTransporter;
  if (!env.SMTP_HOST || !env.SMTP_PORT || !env.SMTP_USER || !env.SMTP_PASSWORD) {
    throw new EmailConfigurationError(
      'EMAIL_PROVIDER="smtp" requires SMTP_HOST, SMTP_PORT, SMTP_USER, and SMTP_PASSWORD to be set',
    );
  }
  cachedTransporter = nodemailer.createTransport({
    host: env.SMTP_HOST,
    port: env.SMTP_PORT,
    secure: env.SMTP_SECURE,
    auth: { user: env.SMTP_USER, pass: env.SMTP_PASSWORD },
    // SMTP is a socket protocol, not a fetch()-based one — there is no
    // AbortSignal to forward the way the AI/Messaging HTTP adapters take
    // one (see src/server/ai/gateway.ts's doc comment for that pattern).
    // The gateway's own timeout race (src/server/email/gateway.ts) still
    // makes sendCommunication move on, but without these, the underlying
    // TCP socket nodemailer opened would keep trying indefinitely in the
    // background. These bound every phase of an SMTP attempt at the
    // transport level so a stuck connection/greeting/DATA phase actually
    // gets torn down, not just abandoned by the caller.
    connectionTimeout: 15_000,
    greetingTimeout: 15_000,
    socketTimeout: 15_000,
  });
  return cachedTransporter;
}

/**
 * Works with any SMTP relay — a self-hosted server, a Russia-accessible
 * provider, or a foreign one. SMTP itself is the swappable boundary here,
 * not a vendor SDK: switching providers is a configuration change (new
 * SMTP_HOST/credentials), never a code change — see
 * docs/communications.md#provider-abstraction for why this was chosen
 * over a vendor-specific REST API. Never exercised in tests or CI; see
 * src/server/email/providers/fake.ts for the deterministic test double.
 */
export const smtpEmailProvider: EmailProvider = {
  name: "smtp",
  async send(message: EmailMessage): Promise<EmailSendResult> {
    const transporter = getTransporter();
    try {
      const info = await transporter.sendMail({
        to: message.to,
        from: message.from,
        subject: message.subject,
        text: message.text,
        headers: { "X-Paynora-Idempotency-Key": message.idempotencyKey },
      });
      return { provider: "smtp", providerMessageId: String(info.messageId) };
    } catch (error) {
      const smtpError = error as NodemailerSendError;
      if (isDefiniteRejection(smtpError)) {
        throw new EmailProviderRejectedError("smtp", smtpError.message);
      }
      throw error;
    }
  },
};
