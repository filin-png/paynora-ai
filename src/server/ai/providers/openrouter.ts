import { env } from "@/lib/env";
import type { AIProvider, AIRequest, AIResult } from "../types";
import { callOpenAiCompatibleChat } from "./openai-compatible-chat";

const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";

/**
 * Real HTTP adapter — OpenRouter's `/chat/completions` endpoint, an
 * OpenAI-compatible aggregator over many underlying models. Reads
 * `OPENROUTER_API_KEY`/`OPENROUTER_MODEL` lazily at call time (same
 * pattern as the SMTP adapter's `getTransporter()`), so this module can be
 * imported safely even when neither is configured — `AI_PROVIDER` must
 * still be explicitly set to `"openrouter"` to ever reach this code (see
 * src/server/ai/service.ts), and src/lib/env.ts's cross-field validation
 * already refuses to boot with that selected and no key/model configured.
 * `fetchImpl` is a test-only injection point — see openrouter.test.ts,
 * which verifies request shape, response parsing, and error handling
 * entirely with a mocked `fetch`, never a real network call.
 */
export function createOpenRouterProvider(fetchImpl: typeof fetch = fetch): AIProvider {
  return {
    name: "openrouter",
    async generateStructured<T>(
      request: AIRequest<T>,
      options?: { signal?: AbortSignal },
    ): Promise<AIResult<T>> {
      if (!env.OPENROUTER_API_KEY || !env.OPENROUTER_MODEL) {
        throw new Error("OPENROUTER_API_KEY and OPENROUTER_MODEL must be configured to use AI_PROVIDER=openrouter");
      }
      return callOpenAiCompatibleChat(
        { name: "openrouter", baseUrl: OPENROUTER_URL, apiKey: env.OPENROUTER_API_KEY, model: env.OPENROUTER_MODEL, fetchImpl },
        request,
        { signal: options?.signal },
      );
    },
  };
}

export const openRouterProvider = createOpenRouterProvider();
