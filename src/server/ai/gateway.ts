import { z } from "zod";

import { recordProviderTelemetry } from "@/server/providers/telemetry";
import { AIProviderError, AITimeoutError, AIValidationError } from "./errors";
import type { AIProvider, AIRequest, AIResult } from "./types";

const DEFAULT_TIMEOUT_MS = 10_000;

/**
 * The AI Gateway: the one place a provider's `generateStructured` is
 * actually invoked. Enforces a timeout, validates the response against the
 * request's schema before handing it back — a provider can return
 * anything, but nothing leaves this function that hasn't been checked —
 * and records structured, secret-free telemetry for every call regardless
 * of caller (src/server/ai/service.ts is production's only caller today,
 * but this is the real choke point: see
 * docs/integration-architecture.md#observability). Callers pass the
 * provider explicitly, which keeps this function trivially testable with a
 * fake provider and keeps provider selection out of the gateway itself.
 */
export async function runAIGeneration<T>(
  provider: AIProvider,
  request: AIRequest<T>,
  options: { timeoutMs?: number } = {},
): Promise<AIResult<T>> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const startedAt = Date.now();

  let raw: AIResult<T>;
  try {
    raw = await withTimeout(provider.generateStructured(request), provider.name, timeoutMs);
  } catch (error) {
    if (error instanceof AITimeoutError) {
      recordProviderTelemetry({
        category: "ai",
        provider: provider.name,
        operation: "generateStructured",
        result: "timeout",
        durationMs: Date.now() - startedAt,
        errorCode: error.name,
      });
      throw error;
    }
    const message = error instanceof Error ? error.message : String(error);
    const wrapped = new AIProviderError(provider.name, message);
    recordProviderTelemetry({
      category: "ai",
      provider: provider.name,
      operation: "generateStructured",
      result: "failure",
      durationMs: Date.now() - startedAt,
      errorCode: wrapped.name,
    });
    throw wrapped;
  }

  const parsed = request.schema.safeParse(raw.data);
  if (!parsed.success) {
    const validationError = new AIValidationError(provider.name, z.prettifyError(parsed.error));
    recordProviderTelemetry({
      category: "ai",
      provider: provider.name,
      operation: "generateStructured",
      result: "failure",
      durationMs: Date.now() - startedAt,
      errorCode: validationError.name,
    });
    throw validationError;
  }

  recordProviderTelemetry({
    category: "ai",
    provider: provider.name,
    operation: "generateStructured",
    result: "success",
    durationMs: Date.now() - startedAt,
  });
  return { data: parsed.data, provider: raw.provider, usage: raw.usage };
}

function withTimeout<T>(promise: Promise<T>, providerName: string, timeoutMs: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new AITimeoutError(providerName, timeoutMs)), timeoutMs);
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
