import { z } from "zod";

import { AIProviderError, AITimeoutError, AIValidationError } from "./errors";
import type { AIProvider, AIRequest, AIResult } from "./types";

const DEFAULT_TIMEOUT_MS = 10_000;

/**
 * The AI Gateway: the one place a provider's `generateStructured` is
 * actually invoked. Enforces a timeout and validates the response against
 * the request's schema before handing it back — a provider can return
 * anything, but nothing leaves this function that hasn't been checked.
 * Callers pass the provider explicitly (see
 * src/server/ai/service.ts for the layer that resolves *which* provider
 * from configuration) — that keeps this function trivially testable with a
 * fake provider and keeps provider selection out of the gateway itself.
 */
export async function runAIGeneration<T>(
  provider: AIProvider,
  request: AIRequest<T>,
  options: { timeoutMs?: number } = {},
): Promise<AIResult<T>> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  let raw: AIResult<T>;
  try {
    raw = await withTimeout(provider.generateStructured(request), provider.name, timeoutMs);
  } catch (error) {
    if (error instanceof AITimeoutError) throw error;
    const message = error instanceof Error ? error.message : String(error);
    throw new AIProviderError(provider.name, message);
  }

  const parsed = request.schema.safeParse(raw.data);
  if (!parsed.success) {
    throw new AIValidationError(provider.name, z.prettifyError(parsed.error));
  }

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
