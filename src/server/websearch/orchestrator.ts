import { tryGenerateStructured } from "@/server/ai/service";
import type { AIRequest, AIResult } from "@/server/ai/types";
import { checkAiGenerationQuota } from "@/server/billing/entitlements";
import { buildWebSearchDecisionRequest, type WebSearchDecision } from "./decision";
import { tryWebSearch, type WebSearchOverride } from "./gateway";
import type { WebSearchResult } from "./types";

export type WebSearchOrchestratorOverride = WebSearchOverride & {
  /** Test-only injection point — mirrors every other AI/WebSearch override in this codebase. Production callers never pass this. */
  decide?: (request: AIRequest<WebSearchDecision>) => Promise<AIResult<WebSearchDecision> | null>;
};

/**
 * The "AI decides if fresh info needed" step from the phase brief's
 * Web Intelligence architecture diagram — never throws, mirrors
 * tryWebSearch's/tryGenerateStructured's contract exactly. Skips the
 * (paid) search call entirely whenever the decision can't be made or
 * doesn't call for it, which is the cost-conscious default this codebase
 * uses everywhere a paid step follows an AI judgment call: no AI result
 * -> no search, same as every other "AI is optional input" caller. Never
 * fabricates a search-backed answer without an actual search: if the
 * model decides search is needed but the search itself fails/is
 * disabled/is rate-limited, this returns null rather than downgrading to
 * a possibly-stale directAnswer that was never generated.
 */
export async function decideAndSearch(
  organizationId: string,
  query: string,
  options: { maxUses?: number; allowedDomains?: string[] } = {},
  override: WebSearchOrchestratorOverride = {},
): Promise<WebSearchResult | null> {
  if (!(await checkAiGenerationQuota(organizationId))) return null;

  const decide = override.decide ?? ((request: AIRequest<WebSearchDecision>) => tryGenerateStructured(request));
  const decision = await decide(buildWebSearchDecisionRequest(query));
  if (!decision) return null;

  if (!decision.data.needsSearch) {
    if (!decision.data.directAnswer) return null;
    return { answer: decision.data.directAnswer, citations: [], searchesUsed: 0 };
  }

  return tryWebSearch(organizationId, query, options, override);
}
