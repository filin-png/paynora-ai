import { randomUUID } from "node:crypto";

import { env } from "@/lib/env";
import type { AIProvider, AIRequest, AIResult } from "../types";
import { callOpenAiCompatibleChat } from "./openai-compatible-chat";

const OAUTH_URL = "https://ngw.devices.sberbank.ru:9443/api/v2/oauth";
const CHAT_URL = "https://api.giga.chat/v1/chat/completions";

/**
 * GigaChat's documented token lifetime is 30 minutes. This adapter tracks
 * expiry itself from the moment it receives a token, rather than trusting
 * the response's own `expires_at` field — public documentation and SDKs
 * disagree on whether that field is a Unix timestamp in seconds or
 * milliseconds, and getting that wrong in either direction either discards
 * a still-valid token constantly or uses one past its real expiry. A fixed,
 * conservative internally-tracked TTL is correct regardless of that
 * ambiguity — see docs/ai-integration-ru-providers.md#gigachat.
 */
const TOKEN_LIFETIME_MS = 30 * 60 * 1000;
const TOKEN_REFRESH_SAFETY_MARGIN_MS = 5 * 60 * 1000;

type CachedToken = { accessToken: string; expiresAtMs: number };

function classifyHttpFailure(status: number): string {
  if (status === 401 || status === 403) return "authentication failed";
  if (status === 429) return "rate limited";
  if (status >= 500) return "provider error";
  return "request rejected";
}

/**
 * Real HTTP adapter — GigaChat (Sber). Unlike Mistral/OpenRouter,
 * authentication is a two-step OAuth exchange, not a single static bearer
 * token: `GIGACHAT_API_KEY` (the "Authorization key" from the GigaChat
 * personal cabinet — already a base64-encoded client_id:client_secret
 * pair) is exchanged for a short-lived access token via
 * `POST /api/v2/oauth`, and *that* token is what authenticates the actual
 * `/chat/completions` call — reusing the same shared OpenAI-compatible
 * wire helper Mistral/OpenRouter use, since GigaChat's completions
 * endpoint is genuinely OpenAI-compatible for this codebase's purposes
 * (JSON mode via `response_format: {type: "json_object"}`, `max_tokens`,
 * the same `choices[0].message.content`/`usage` response shape). See
 * docs/ai-integration-ru-providers.md#gigachat for verification against
 * Sber's official documentation.
 *
 * The access token is cached per provider instance (a closure variable,
 * not module-level) — the same scoping every test-injectable adapter in
 * this codebase uses for its own state, which is what keeps two
 * `createGigaChatProvider(fetchImpl)` calls in two different tests fully
 * isolated from each other while still letting the real, singleton
 * `gigachatProvider` reuse one token across many calls in production
 * instead of re-authenticating on every request.
 *
 * `fetchImpl` is a test-only injection point — see gigachat.test.ts, which
 * verifies both the OAuth exchange and the completions call entirely with
 * a mocked `fetch`, never a real network call or credential.
 */
export function createGigaChatProvider(fetchImpl: typeof fetch = fetch): AIProvider {
  let cachedToken: CachedToken | null = null;

  async function getAccessToken(signal: AbortSignal | undefined): Promise<string> {
    const now = Date.now();
    if (cachedToken && cachedToken.expiresAtMs > now) {
      return cachedToken.accessToken;
    }

    if (!env.GIGACHAT_API_KEY) {
      throw new Error("GIGACHAT_API_KEY must be configured to use AI_PROVIDER=gigachat");
    }

    // Never include the Authorization header value (the API key) or the
    // raw response body in a thrown error — only the status code, which
    // cannot leak a secret. See openai-compatible-chat.ts for the
    // identical discipline applied to the completions call below.
    let response: Response;
    try {
      response = await fetchImpl(OAUTH_URL, {
        method: "POST",
        signal,
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          accept: "application/json",
          RqUID: randomUUID(),
          authorization: `Basic ${env.GIGACHAT_API_KEY}`,
        },
        body: `scope=${encodeURIComponent(env.GIGACHAT_SCOPE)}`,
      });
    } catch {
      throw new Error("gigachat oauth request failed: network error");
    }

    if (!response.ok) {
      throw new Error(`gigachat oauth request failed with HTTP ${response.status} (${classifyHttpFailure(response.status)})`);
    }

    let payload: { access_token?: string };
    try {
      payload = await response.json();
    } catch {
      throw new Error("gigachat oauth response was not valid JSON");
    }
    if (typeof payload.access_token !== "string" || payload.access_token.length === 0) {
      throw new Error("gigachat oauth response did not include an access_token");
    }

    cachedToken = {
      accessToken: payload.access_token,
      expiresAtMs: now + TOKEN_LIFETIME_MS - TOKEN_REFRESH_SAFETY_MARGIN_MS,
    };
    return cachedToken.accessToken;
  }

  return {
    name: "gigachat",
    async generateStructured<T>(
      request: AIRequest<T>,
      options?: { signal?: AbortSignal },
    ): Promise<AIResult<T>> {
      if (!env.GIGACHAT_API_KEY || !env.GIGACHAT_MODEL) {
        throw new Error("GIGACHAT_API_KEY and GIGACHAT_MODEL must be configured to use AI_PROVIDER=gigachat");
      }

      const accessToken = await getAccessToken(options?.signal);
      return callOpenAiCompatibleChat(
        { name: "gigachat", baseUrl: CHAT_URL, apiKey: accessToken, model: env.GIGACHAT_MODEL, fetchImpl },
        request,
        { signal: options?.signal },
      );
    },
  };
}

export const gigachatProvider = createGigaChatProvider();
