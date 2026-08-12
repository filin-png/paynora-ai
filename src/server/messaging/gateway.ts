import { recordProviderTelemetry } from "@/server/providers/telemetry";
import {
  MessagingProviderRejectedError,
  MessagingProviderUnknownError,
  MessagingTimeoutError,
} from "./errors";
import type { MessagingMessage, MessagingProvider, MessagingSendResult } from "./types";

const DEFAULT_TIMEOUT_MS = 15_000;

/**
 * The Messaging Gateway: the one place a provider's `send` is actually
 * invoked — mirrors src/server/email/gateway.ts exactly, including its
 * telemetry recording (never the message body or recipient, only
 * provider/operation/result/duration/errorCode — see
 * docs/integration-architecture.md#observability). Enforces a timeout and
 * normalizes every failure into one of three outcomes the caller must
 * handle explicitly by catching the specific error type:
 *
 * - resolves: the provider confirmed acceptance.
 * - throws `MessagingProviderRejectedError`: the provider is certain the
 *   message was not accepted — safe to record as a definite failure.
 * - throws anything else (normalized to `MessagingTimeoutError` or
 *   `MessagingProviderUnknownError`): the outcome is not known — never
 *   treat this as a confirmed failure or a confirmed success.
 *
 * See docs/integration-architecture.md#messaging.
 */
export async function dispatchMessage(
  provider: MessagingProvider,
  message: MessagingMessage,
  options: { timeoutMs?: number } = {},
): Promise<MessagingSendResult> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const startedAt = Date.now();

  try {
    const result = await withTimeout(provider.send(message), provider.name, timeoutMs);
    recordProviderTelemetry({
      category: "messaging",
      provider: provider.name,
      operation: "send",
      result: "success",
      durationMs: Date.now() - startedAt,
    });
    return result;
  } catch (error) {
    if (error instanceof MessagingTimeoutError) {
      recordProviderTelemetry({
        category: "messaging",
        provider: provider.name,
        operation: "send",
        result: "timeout",
        durationMs: Date.now() - startedAt,
        errorCode: error.name,
      });
      throw error;
    }
    if (error instanceof MessagingProviderRejectedError) {
      recordProviderTelemetry({
        category: "messaging",
        provider: provider.name,
        operation: "send",
        result: "failure",
        durationMs: Date.now() - startedAt,
        errorCode: error.name,
      });
      throw error;
    }
    const detail = error instanceof Error ? error.message : String(error);
    const wrapped = new MessagingProviderUnknownError(provider.name, detail);
    recordProviderTelemetry({
      category: "messaging",
      provider: provider.name,
      operation: "send",
      result: "failure",
      durationMs: Date.now() - startedAt,
      errorCode: wrapped.name,
    });
    throw wrapped;
  }
}

function withTimeout<T>(promise: Promise<T>, providerName: string, timeoutMs: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new MessagingTimeoutError(providerName, timeoutMs)), timeoutMs);
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
