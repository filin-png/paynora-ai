import { env } from "@/lib/env";
import { MessagingConfigurationError, MessagingProviderRejectedError } from "../errors";
import type { MessagingMessage, MessagingProvider, MessagingSendResult } from "../types";

/**
 * Telegram's Bot API responses are always HTTP 200 with `{ok: false, ...}`
 * on failure, but can occasionally surface a non-2xx status from
 * infrastructure in front of the API — this type covers both shapes.
 */
type TelegramSendMessageResponse = {
  ok: boolean;
  result?: { message_id: number };
  error_code?: number;
  description?: string;
};

/**
 * Error codes Telegram uses to report a confirmed, non-retryable rejection
 * of a specific message — the chat doesn't exist, or the bot has been
 * blocked/kicked. Anything else (rate limiting, a 5xx, a network failure)
 * is left as an unknown outcome — see docs/integration-architecture.md
 * #messaging.
 */
const DEFINITE_REJECTION_CODES = new Set([400, 403]);

/**
 * Real HTTP adapter — the Telegram Bot API's `sendMessage` method
 * (https://core.telegram.org/bots/api#sendmessage), a simple, stable,
 * publicly documented REST contract with bot-token-in-URL auth. Reads
 * `TELEGRAM_BOT_TOKEN` lazily at call time (same pattern as the SMTP
 * adapter's `getTransporter()` and the OpenRouter/Mistral adapters), so
 * this module can be imported safely even when unconfigured.
 *
 * `fetchImpl` is a test-only injection point — see telegram.test.ts, which
 * verifies request shape, response parsing, and error handling entirely
 * with a mocked `fetch`, never a real network call or bot token.
 *
 * No domain code calls this yet — see src/server/messaging/types.ts.
 */
export function createTelegramProvider(fetchImpl: typeof fetch = fetch): MessagingProvider {
  return {
    name: "telegram",
    async send(message: MessagingMessage): Promise<MessagingSendResult> {
      if (!env.TELEGRAM_BOT_TOKEN) {
        throw new MessagingConfigurationError(
          "TELEGRAM_BOT_TOKEN must be configured to use MESSAGING_PROVIDER=telegram",
        );
      }

      const response = await fetchImpl(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ chat_id: message.to, text: message.text }),
      });

      // Never include the request URL (embeds the bot token as a path
      // segment) or the raw response body verbatim in a thrown error — only
      // the fields we've deliberately extracted below. See
      // docs/integration-architecture.md#secrets.
      let payload: TelegramSendMessageResponse;
      try {
        payload = await response.json();
      } catch {
        throw new Error(`telegram response was not valid JSON (HTTP ${response.status})`);
      }

      if (!payload.ok) {
        const description = payload.description ?? "no description";
        if (payload.error_code !== undefined && DEFINITE_REJECTION_CODES.has(payload.error_code)) {
          throw new MessagingProviderRejectedError("telegram", description);
        }
        throw new Error(`telegram request failed: error_code=${payload.error_code ?? "unknown"} ${description}`);
      }

      if (!response.ok || !payload.result) {
        throw new Error(`telegram response did not include a result (HTTP ${response.status})`);
      }

      return { provider: "telegram", providerMessageId: String(payload.result.message_id) };
    },
  };
}

export const telegramMessagingProvider = createTelegramProvider();
