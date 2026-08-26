import { checkRateLimit } from "@/server/rate-limit/service";
import { webSearchPolicy } from "@/server/rate-limit/policies";
import { isWebSearchEnabled, resolveWebSearchProvider } from "./service";
import type { WebSearchProvider, WebSearchResult } from "./types";

/** Hard ceiling regardless of what a caller asks for — see docs/production-integrations.md#cost-control. Never a per-request unlimited value. */
export const MAX_SEARCHES_PER_CALL = 10;
const DEFAULT_MAX_SEARCHES = 5;

export type WebSearchOverride = { enabled?: boolean; resolve?: () => WebSearchProvider };

/**
 * The safe entry point every caller should use — mirrors
 * src/server/ai/service.ts#tryGenerateStructured's contract exactly:
 * never throws, returns `null` on any failure (disabled, rate-limited,
 * provider error, timeout), so a caller always has a deterministic
 * fallback path. Checked before any network call: rate limit (cost
 * control, section 3/24 of the phase brief) and whether the feature is
 * enabled at all.
 */
export async function tryWebSearch(
  organizationId: string,
  query: string,
  options: { maxUses?: number; allowedDomains?: string[] } = {},
  override: WebSearchOverride = {},
): Promise<WebSearchResult | null> {
  const enabled = override.enabled ?? isWebSearchEnabled();
  if (!enabled) return null;

  const limit = await checkRateLimit("web-search", organizationId, webSearchPolicy());
  if (!limit.allowed) return null;

  const maxUses = Math.min(options.maxUses ?? DEFAULT_MAX_SEARCHES, MAX_SEARCHES_PER_CALL);

  try {
    const provider = override.resolve ? override.resolve() : resolveWebSearchProvider();
    return await provider.search({ query, maxUses, allowedDomains: options.allowedDomains });
  } catch {
    return null;
  }
}
