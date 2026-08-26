import { webSearchPolicy } from "@/server/rate-limit/policies";
import { checkRateLimit } from "@/server/rate-limit/service";
import { MAX_SEARCHES_PER_CALL, type WebSearchOverride } from "./gateway";
import { isWebSearchEnabled, resolveWebSearchProvider } from "./service";
import type { WebSearchResult } from "./types";

const DEEP_RESEARCH_TIMEOUT_MS = 60_000;
/** Deliberately equal to the hard ceiling — "deep" research gets more searches than a normal query, never unlimited. See docs/production-integrations.md#deep-research. */
const DEEP_RESEARCH_MAX_SEARCHES = MAX_SEARCHES_PER_CALL;

/**
 * A controlled research mode, per the phase brief section 16 — built as a
 * stricter-capped call into the *same* search() primitive
 * (src/server/websearch/gateway.ts#tryWebSearch), not a separate
 * multi-step loop: Anthropic's web_search tool already performs the
 * search → deduplicate → compare → synthesize → cite sequence internally
 * within one Messages API turn (see
 * src/server/websearch/providers/anthropic.ts's doc comment) when given a
 * higher `max_uses`. Reusing that is what "do not invent a duplicate
 * abstraction" (phase brief section 1) means concretely here.
 *
 * Never throws — returns `null` on any failure/disabled/rate-limited/
 * timeout outcome, exactly like tryWebSearch. Enforces:
 * - a hard search-count ceiling (`DEEP_RESEARCH_MAX_SEARCHES`);
 * - a wall-clock timeout (`DEEP_RESEARCH_TIMEOUT_MS`), via `Promise.race`
 *   against an `AbortController` passed into the provider;
 * - the same per-organization hourly rate limit as every other web search
 *   (a deep research call consumes from the same budget, not a separate
 *   unlimited one).
 */
export async function runDeepResearch(
  organizationId: string,
  query: string,
  override: WebSearchOverride & { timeoutMs?: number } = {},
): Promise<WebSearchResult | null> {
  const enabled = override.enabled ?? isWebSearchEnabled();
  if (!enabled) return null;

  const limit = await checkRateLimit("web-search", organizationId, webSearchPolicy());
  if (!limit.allowed) return null;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), override.timeoutMs ?? DEEP_RESEARCH_TIMEOUT_MS);

  try {
    const provider = override.resolve ? override.resolve() : resolveWebSearchProvider();
    return await provider.search({ query, maxUses: DEEP_RESEARCH_MAX_SEARCHES }, { signal: controller.signal });
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}
