import { EmailProviderRejectedError, EmailProviderUnknownError, EmailTimeoutError } from "./errors";
import type { EmailMessage, EmailProvider, EmailSendResult } from "./types";

const DEFAULT_TIMEOUT_MS = 15_000;

/**
 * The Email Gateway: the one place a provider's `send` is actually
 * invoked. Enforces a timeout and normalizes every failure into one of
 * three outcomes the caller must handle explicitly by catching the
 * specific error type:
 *
 * - resolves: the provider confirmed acceptance.
 * - throws `EmailProviderRejectedError`: the provider is certain the
 *   message was not accepted — safe to record as a definite failure.
 * - throws anything else (normalized to `EmailTimeoutError` or
 *   `EmailProviderUnknownError`): the outcome is not known — never treat
 *   this as a confirmed failure or a confirmed success.
 *
 * See docs/communications.md#unknown-outcomes.
 */
export async function dispatchEmail(
  provider: EmailProvider,
  message: EmailMessage,
  options: { timeoutMs?: number } = {},
): Promise<EmailSendResult> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  try {
    return await withTimeout(provider.send(message), provider.name, timeoutMs);
  } catch (error) {
    if (error instanceof EmailTimeoutError || error instanceof EmailProviderRejectedError) {
      throw error;
    }
    const detail = error instanceof Error ? error.message : String(error);
    throw new EmailProviderUnknownError(provider.name, detail);
  }
}

function withTimeout<T>(promise: Promise<T>, providerName: string, timeoutMs: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new EmailTimeoutError(providerName, timeoutMs)), timeoutMs);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}
