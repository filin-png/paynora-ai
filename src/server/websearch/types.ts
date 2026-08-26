/**
 * WebSearchProvider — deliberately separate from AiProvider
 * (src/server/ai/types.ts). AI generation and live web search are
 * different capabilities with different cost profiles, different failure
 * modes, and (per the phase brief) different trust boundaries — retrieved
 * web content is untrusted input that must never be treated as PAYNORA's
 * own instructions. See docs/production-integrations.md#web-intelligence.
 */
export type WebSearchCitation = {
  title: string;
  url: string;
  /** Domain the citation is from, derived from `url` — never fabricated. */
  domain: string;
  citedText?: string;
};

export type WebSearchResult = {
  /** Claude's synthesized answer, with citations already attributed inline where the provider supports it. */
  answer: string;
  citations: WebSearchCitation[];
  /** How many real searches this call actually performed — never estimated, always the provider's own reported count. */
  searchesUsed: number;
};

export type WebSearchRequest = {
  query: string;
  /** Hard cap on searches for this one call — see docs/production-integrations.md#cost-control. */
  maxUses: number;
  allowedDomains?: string[];
  blockedDomains?: string[];
};

export interface WebSearchProvider {
  readonly name: string;
  search(request: WebSearchRequest, options?: { signal?: AbortSignal }): Promise<WebSearchResult>;
}
