import { env } from "@/lib/env";
import type { AIProvider, AIRequest, AIResult } from "../types";
import { callOpenAiCompatibleChat } from "./openai-compatible-chat";

const MISTRAL_URL = "https://api.mistral.ai/v1/chat/completions";

/**
 * Real HTTP adapter — Mistral's La Plateforme `/chat/completions`
 * endpoint, also OpenAI-compatible. See openrouter.ts's doc comment for
 * the shared design rationale (lazy env read, fetch injection for tests);
 * everything there applies here identically.
 */
export function createMistralProvider(fetchImpl: typeof fetch = fetch): AIProvider {
  return {
    name: "mistral",
    async generateStructured<T>(request: AIRequest<T>): Promise<AIResult<T>> {
      if (!env.MISTRAL_API_KEY || !env.MISTRAL_MODEL) {
        throw new Error("MISTRAL_API_KEY and MISTRAL_MODEL must be configured to use AI_PROVIDER=mistral");
      }
      return callOpenAiCompatibleChat(
        { name: "mistral", baseUrl: MISTRAL_URL, apiKey: env.MISTRAL_API_KEY, model: env.MISTRAL_MODEL, fetchImpl },
        request,
      );
    },
  };
}

export const mistralProvider = createMistralProvider();
