import { env, type Env } from "@/lib/env";
import { runAIGeneration } from "./gateway";
import { gigachatProvider } from "./providers/gigachat";
import { noneProvider } from "./providers/none";
import { mistralProvider } from "./providers/mistral";
import { openRouterProvider } from "./providers/openrouter";
import { yandexGptProvider } from "./providers/yandexgpt";
import type { AIProvider, AIRequest, AIResult } from "./types";

export type AiProviderName = Env["AI_PROVIDER"];

/** True when `AI_PROVIDER` selects anything other than "none". */
export function isAIEnabled(): boolean {
  return env.AI_PROVIDER !== "none";
}

/**
 * Resolves the `AIProvider` implementation for a given configured value.
 * Every real vendor adapter is registered here, and only here — this is
 * the one place that knows OpenRouter/Mistral/GigaChat/YandexGPT (or any
 * future provider) exist; nothing else in the codebase imports a provider
 * module directly. All four are real adapters as of the Russian AI
 * providers phase (`"yandex"` selects the YandexGPT adapter — see
 * docs/ai-integration-ru-providers.md for why the existing enum value name
 * was kept rather than renamed). See
 * docs/integration-architecture.md#ai-routing.
 */
export function resolveProviderByName(name: AiProviderName): AIProvider {
  switch (name) {
    case "none":
      return noneProvider;
    case "openrouter":
      return openRouterProvider;
    case "mistral":
      return mistralProvider;
    case "gigachat":
      return gigachatProvider;
    case "yandex":
      return yandexGptProvider;
  }
}

/**
 * At most two attempts, in a fixed order: `AI_PROVIDER` (primary), then
 * `AI_PROVIDER_FALLBACK` if configured — never a longer chain, never
 * retried past a confirmed success. This is what "optional fallback,
 * bounded, no infinite retries" means concretely — see
 * docs/integration-architecture.md#ai-routing.
 */
function routingOrder(): AiProviderName[] {
  const order: AiProviderName[] = [env.AI_PROVIDER];
  if (env.AI_PROVIDER_FALLBACK) order.push(env.AI_PROVIDER_FALLBACK);
  return order;
}

/**
 * The layer Operator/Communications code actually calls (domain → AI
 * Service → AI Gateway → AIProvider). Never throws: AI is optional input
 * to every caller, so any failure — disabled, misconfigured, provider
 * error, timeout, invalid output — is swallowed here and reported back as
 * `null`, letting the caller fall back to its deterministic-only path.
 * Callers that need the underlying error (tests) should call
 * `runAIGeneration` with an explicit provider directly instead.
 *
 * Routing: tries each configured provider in `routingOrder()` in turn,
 * stopping at the first confirmed success. A provider that's recognized
 * but unimplemented, misconfigured, timed out, errored, or returned
 * invalid output is logged and treated as "try the next one" — never
 * retried itself, never looped. If every attempt fails, returns `null`
 * exactly like AI being disabled — from the caller's perspective these
 * are indistinguishable, which is intentional: every caller already has a
 * deterministic fallback for "no AI result", so a routing failure degrades
 * the same way a disabled provider does.
 *
 * `options.order`/`options.resolve`/`options.enabled` are test-only
 * injection points — the same dependency-injection pattern already used
 * throughout this codebase (e.g. `runAutomationTick`'s `emailProvider`
 * override, `sendCommunication`'s `provider` option). Production callers
 * never pass them and get the real env-derived routing order and the real
 * vendor adapters — see service.test.ts, which exercises the actual
 * routing/fallback/bounded-attempts logic through these hooks without any
 * real network call or credential.
 */
export async function tryGenerateStructured<T>(
  request: AIRequest<T>,
  options: {
    enabled?: boolean;
    order?: AiProviderName[];
    resolve?: (name: AiProviderName) => AIProvider;
  } = {},
): Promise<AIResult<T> | null> {
  const enabled = options.enabled ?? isAIEnabled();
  if (!enabled) return null;

  const resolve = options.resolve ?? resolveProviderByName;
  for (const name of options.order ?? routingOrder()) {
    if (name === "none") continue;

    let provider: AIProvider;
    try {
      provider = resolve(name);
    } catch (error) {
      logAIFailure(name, error);
      continue;
    }

    try {
      // Telemetry for this call is recorded inside runAIGeneration itself
      // (src/server/ai/gateway.ts) — that's the real choke point regardless
      // of caller, so it isn't duplicated here.
      return await runAIGeneration(provider, request);
    } catch (error) {
      logAIFailure(name, error);
    }
  }

  return null;
}

/**
 * Structured, secret-free logging for AI failures — never logs `request`
 * (may embed customer data) or any credential. See
 * docs/operator-foundation.md#observability.
 */
function logAIFailure(provider: string, error: unknown): void {
  const name = error instanceof Error ? error.name : "UnknownError";
  const message = error instanceof Error ? error.message : String(error);
  console.warn(`[ai] generation failed provider=${provider}: ${name}: ${message}`);
}
