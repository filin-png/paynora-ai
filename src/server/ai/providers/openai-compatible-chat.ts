import type { AIRequest, AIResult } from "../types";

/**
 * Shared wire-level logic for the two vendors currently implemented that
 * both speak an OpenAI-compatible `/chat/completions` contract —
 * OpenRouter and Mistral. This is *not* an `AIProvider` itself; each
 * vendor's own adapter (openrouter.ts, mistral.ts) wraps this with its
 * base URL, model, and API key. Shared here because it's the same real
 * wire contract for both today, not because of speculative future reuse —
 * see docs/integration-architecture.md#ai-routing.
 *
 * Validation of the response against the caller's schema happens
 * centrally in src/server/ai/gateway.ts, never here — this function only
 * does what's needed to get a best-effort parsed JSON value back, exactly
 * like the fake test provider's `data: behavior.data as T` cast.
 */
export type OpenAiCompatibleChatConfig = {
  /** The provider name reported on the result — must match `AIProvider.name`. */
  name: string;
  baseUrl: string;
  apiKey: string;
  model: string;
  /** Test-only injection point — production callers omit this and get the real global `fetch`. */
  fetchImpl?: typeof fetch;
};

export async function callOpenAiCompatibleChat<T>(
  config: OpenAiCompatibleChatConfig,
  request: AIRequest<T>,
  options: { signal?: AbortSignal } = {},
): Promise<AIResult<T>> {
  const fetchImpl = config.fetchImpl ?? fetch;

  const response = await fetchImpl(config.baseUrl, {
    method: "POST",
    signal: options.signal,
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${config.apiKey}`,
    },
    body: JSON.stringify({
      model: config.model,
      response_format: { type: "json_object" },
      messages: [
        {
          role: "system",
          content: `${request.system}\n\nRespond with a single JSON object only — no prose, no markdown code fences.`,
        },
        // `input` is business data, never concatenated into the system
        // instruction — see src/server/ai/types.ts and
        // docs/ai-architecture.md#prompt-injection. It goes in the user
        // message, structurally separated, exactly as every existing
        // AIRequest caller already assumes of any AIProvider.
        { role: "user", content: JSON.stringify(request.input) },
      ],
      ...(request.maxOutputTokens ? { max_tokens: request.maxOutputTokens } : {}),
    }),
  });

  if (!response.ok) {
    // Never include the raw response body (could echo request content or
    // an error message from the vendor we don't control) or any request
    // header (would include the Authorization bearer) — only the status
    // code, which cannot leak a secret. See docs/integration-architecture.md
    // #secrets. The status is classified for observability only — every
    // classification here is caught identically by
    // src/server/ai/service.ts's routing (any AIProviderError is
    // fallback-eligible; see docs/ai-architecture.md#retry-policy for why
    // there is no "retry the same provider" case for this codebase's
    // bounded, different-vendor fallback model).
    const classification =
      response.status === 401 || response.status === 403
        ? "authentication failed"
        : response.status === 429
          ? "rate limited"
          : response.status >= 500
            ? "provider error"
            : "request rejected";
    throw new Error(`${config.name} request failed with HTTP ${response.status} (${classification})`);
  }

  let payload: { choices?: { message?: { content?: string } }[]; usage?: { prompt_tokens?: number; completion_tokens?: number } };
  try {
    payload = await response.json();
  } catch {
    throw new Error(`${config.name} response was not valid JSON`);
  }

  const content = payload.choices?.[0]?.message?.content;
  if (typeof content !== "string") {
    throw new Error(`${config.name} response did not include message content`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    throw new Error(`${config.name} response content was not valid JSON`);
  }

  return {
    data: parsed as T,
    provider: config.name,
    usage: payload.usage
      ? { promptTokens: payload.usage.prompt_tokens, completionTokens: payload.usage.completion_tokens }
      : undefined,
  };
}
