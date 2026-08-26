import { env } from "@/lib/env";
import { WebSearchDisabledError, WebSearchProviderNotImplementedError } from "./errors";
import { createAnthropicWebSearchProvider } from "./providers/anthropic";
import type { WebSearchProvider } from "./types";

export function isWebSearchEnabled(): boolean {
  return env.WEB_SEARCH_PROVIDER !== "none";
}

/**
 * Resolves the configured WebSearchProvider — mirrors
 * src/server/wallet/service.ts#resolveWalletProvider. "yandex" is
 * recognized but not implemented in this phase (see
 * docs/production-integrations.md#web-intelligence).
 */
export function resolveWebSearchProvider(): WebSearchProvider {
  if (env.WEB_SEARCH_PROVIDER === "none") throw new WebSearchDisabledError();
  if (env.WEB_SEARCH_PROVIDER === "anthropic") {
    // env.ts's superRefine guarantees this is set whenever this branch is reached.
    return createAnthropicWebSearchProvider(env.ANTHROPIC_API_KEY!, env.ANTHROPIC_MODEL);
  }
  throw new WebSearchProviderNotImplementedError(env.WEB_SEARCH_PROVIDER);
}
