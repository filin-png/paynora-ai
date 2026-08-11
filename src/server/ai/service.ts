import { env } from "@/lib/env";
import { AIProviderError } from "./errors";
import { runAIGeneration } from "./gateway";
import { noneProvider } from "./providers/none";
import type { AIProvider, AIRequest, AIResult } from "./types";

/** True when `AI_PROVIDER` selects anything other than "none". */
export function isAIEnabled(): boolean {
  return env.AI_PROVIDER !== "none";
}

/**
 * Resolves the AIProvider implementation for the configured
 * `AI_PROVIDER`. Every real vendor adapter is registered here, and only
 * here — this is the one place that knows GigaChat (or any future
 * provider) exists; nothing else in the codebase imports a provider
 * module directly. No adapter is implemented yet (Phase 3 is the
 * foundation, not the GigaChat integration — see docs/ai-architecture.md),
 * so every configured value currently resolves to a clear, typed error
 * rather than silently falling back to "none".
 */
function resolveProvider(): AIProvider {
  switch (env.AI_PROVIDER) {
    case "none":
      return noneProvider;
    case "gigachat":
      throw new AIProviderError(
        "gigachat",
        "not implemented yet — Phase 3 built the AI Gateway foundation only, see docs/ai-architecture.md",
      );
  }
}

/**
 * The layer Operator code actually calls (Operator → AI Service → AI
 * Gateway → AIProvider). Never throws: AI is optional input to the
 * Operator pipeline, so any failure — disabled, misconfigured, provider
 * error, timeout, invalid output — is swallowed here and reported back as
 * `null`, letting the caller fall back to its deterministic-only path.
 * Callers that need the underlying error (tests) should call
 * `runAIGeneration` with an explicit provider directly instead.
 */
export async function tryGenerateStructured<T>(
  request: AIRequest<T>,
): Promise<AIResult<T> | null> {
  if (!isAIEnabled()) return null;

  let provider: AIProvider;
  try {
    provider = resolveProvider();
  } catch {
    return null;
  }
  if (provider === noneProvider) return null;

  try {
    return await runAIGeneration(provider, request);
  } catch (error) {
    logAIFailure(error);
    return null;
  }
}

/**
 * Structured, secret-free logging for AI failures — never logs `request`
 * (may embed customer data) or any credential. See
 * docs/operator-foundation.md#observability.
 */
function logAIFailure(error: unknown): void {
  const name = error instanceof Error ? error.name : "UnknownError";
  const message = error instanceof Error ? error.message : String(error);
  console.warn(`[ai] generation failed: ${name}: ${message}`);
}
