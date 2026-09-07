import { env } from "@/lib/env";
import type { AIProvider, AIRequest, AIResult } from "../types";

const YANDEXGPT_URL = "https://llm.api.cloud.yandex.net/foundationModels/v1/completion";

/**
 * Yandex Cloud's Foundation Models completion API — a genuinely different
 * wire contract from the OpenAI-compatible shape Mistral/OpenRouter/
 * GigaChat share (`role`/`text` messages rather than `role`/`content`, a
 * `result.alternatives[].message` response envelope, and int64 fields —
 * `maxTokens`, token-usage counts — serialized as JSON strings rather than
 * numbers, a Yandex Cloud API convention, not a bug in this adapter). Not
 * built on `openai-compatible-chat.ts` because it isn't the same contract
 * — see that file's own doc comment on why sharing is based on a genuinely
 * identical wire shape, not speculative reuse.
 *
 * Auth: `YANDEXGPT_API_KEY`, sent as `Authorization: Api-Key <key>` — the
 * static, non-expiring credential Yandex Cloud's own documentation offers
 * as the simpler alternative to a short-lived IAM token, appropriate here
 * since every other provider in this codebase authenticates the same way
 * (a single long-lived server-side secret, never a client-facing token
 * exchange). `YANDEXGPT_FOLDER_ID` identifies the Yandex Cloud folder the
 * model call bills against and is embedded in `modelUri`
 * (`gpt://<folder>/<model>`) — see docs/ai-integration-ru-providers.md
 * #yandexgpt for the verification this was built against.
 *
 * `fetchImpl` is a test-only injection point — see yandexgpt.test.ts, which
 * verifies request shape, response parsing, and error handling entirely
 * against a mocked `fetch`, never a real network call or credential.
 */
type YandexGptCompletionResponse = {
  result?: {
    alternatives?: { message?: { role?: string; text?: string } }[];
    usage?: { inputTextTokens?: string; completionTokens?: string; totalTokens?: string };
  };
};

function classifyHttpFailure(status: number): string {
  if (status === 401 || status === 403) return "authentication failed";
  if (status === 429) return "rate limited";
  if (status >= 500) return "provider error";
  return "request rejected";
}

export function createYandexGptProvider(fetchImpl: typeof fetch = fetch): AIProvider {
  return {
    name: "yandex",
    async generateStructured<T>(
      request: AIRequest<T>,
      options?: { signal?: AbortSignal },
    ): Promise<AIResult<T>> {
      if (!env.YANDEXGPT_API_KEY || !env.YANDEXGPT_MODEL || !env.YANDEXGPT_FOLDER_ID) {
        throw new Error(
          "YANDEXGPT_API_KEY, YANDEXGPT_MODEL, and YANDEXGPT_FOLDER_ID must be configured to use AI_PROVIDER=yandex",
        );
      }

      // Never include the Authorization header value (the API key) or the
      // raw response body in a thrown error — only the status code, which
      // cannot leak a secret. Mirrors openai-compatible-chat.ts's identical
      // discipline for the other three adapters.
      let response: Response;
      try {
        response = await fetchImpl(YANDEXGPT_URL, {
          method: "POST",
          signal: options?.signal,
          headers: {
            "content-type": "application/json",
            authorization: `Api-Key ${env.YANDEXGPT_API_KEY}`,
            "x-folder-id": env.YANDEXGPT_FOLDER_ID,
          },
          body: JSON.stringify({
            modelUri: `gpt://${env.YANDEXGPT_FOLDER_ID}/${env.YANDEXGPT_MODEL}`,
            completionOptions: {
              stream: false,
              ...(request.maxOutputTokens ? { maxTokens: String(request.maxOutputTokens) } : {}),
            },
            messages: [
              {
                role: "system",
                text: `${request.system}\n\nRespond with a single JSON object only — no prose, no markdown code fences.`,
              },
              // `input` is business data, never concatenated into the
              // system instruction — see src/server/ai/types.ts and
              // docs/ai-architecture.md#prompt-injection.
              { role: "user", text: JSON.stringify(request.input) },
            ],
          }),
        });
      } catch {
        throw new Error("yandexgpt request failed: network error");
      }

      if (!response.ok) {
        throw new Error(`yandexgpt request failed with HTTP ${response.status} (${classifyHttpFailure(response.status)})`);
      }

      let payload: YandexGptCompletionResponse;
      try {
        payload = await response.json();
      } catch {
        throw new Error("yandexgpt response was not valid JSON");
      }

      const text = payload.result?.alternatives?.[0]?.message?.text;
      if (typeof text !== "string") {
        throw new Error("yandexgpt response did not include message text");
      }

      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch {
        throw new Error("yandexgpt response content was not valid JSON");
      }

      const usage = payload.result?.usage;
      return {
        data: parsed as T,
        provider: "yandex",
        usage: usage
          ? {
              promptTokens: usage.inputTextTokens !== undefined ? Number(usage.inputTextTokens) : undefined,
              completionTokens: usage.completionTokens !== undefined ? Number(usage.completionTokens) : undefined,
            }
          : undefined,
      };
    },
  };
}

export const yandexGptProvider = createYandexGptProvider();
