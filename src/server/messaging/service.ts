import { env } from "@/lib/env";
import { MessagingDisabledError } from "./errors";
import { telegramMessagingProvider } from "./providers/telegram";
import type { MessagingProvider } from "./types";

/** True when `MESSAGING_PROVIDER` selects anything other than "none". */
export function isMessagingEnabled(): boolean {
  return env.MESSAGING_PROVIDER !== "none";
}

/**
 * Resolves the MessagingProvider for the configured `MESSAGING_PROVIDER` —
 * mirrors src/server/email/service.ts's `resolveEmailProvider` exactly.
 * This is the one place that knows Telegram (or any future messaging
 * vendor) exists; nothing else in the codebase imports a provider module
 * directly.
 */
export function resolveMessagingProvider(): MessagingProvider {
  const provider = env.MESSAGING_PROVIDER;
  if (provider === "none") throw new MessagingDisabledError();
  switch (provider) {
    case "telegram":
      return telegramMessagingProvider;
  }
}
