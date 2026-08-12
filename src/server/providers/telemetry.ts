import type { ProviderCategory } from "./types";

/**
 * The one shape every provider gateway (AI, Email, Messaging — and any
 * future category) reports through. Deliberately narrow: everything here
 * is safe to log, safe to forward to a future Sentry/PostHog integration,
 * and safe to persist. See docs/integration-architecture.md#observability
 * for the full list of what must never appear in one of these — API keys,
 * passwords, email bodies, invoice contents, authorization headers, raw
 * webhook payloads. Nothing in this codebase enforces that at the type
 * level (a `string` field can't refuse to contain a secret); it is
 * enforced by discipline at every call site, the same way
 * `ActivityEvent.metadata` already is elsewhere in this codebase.
 */
export type ProviderTelemetryEvent = {
  category: ProviderCategory;
  provider: string;
  operation: string;
  result: "success" | "failure" | "timeout";
  durationMs: number;
  errorCode?: string;
  requestId?: string;
  organizationId?: string;
};

/**
 * Structured, secret-free logging boundary — the single choke point a
 * future real observability vendor (Sentry, PostHog, ...) would be wired
 * in behind, without touching any of the provider gateways that call this.
 * Today it only writes one structured line via `console.info`/`console.error`
 * (the same logging primitive `src/server/collections/engine.ts` and
 * `src/server/operator/pipeline.ts` already use) — see
 * docs/integration-architecture.md#observability for why a real vendor
 * integration is documented as planned, not implemented, in Phase 6.
 */
export function recordProviderTelemetry(event: ProviderTelemetryEvent): void {
  const line = `[provider] category=${event.category} provider=${event.provider} operation=${event.operation} result=${event.result} durationMs=${event.durationMs}${event.errorCode ? ` errorCode=${event.errorCode}` : ""}${event.requestId ? ` requestId=${event.requestId}` : ""}${event.organizationId ? ` organizationId=${event.organizationId}` : ""}`;
  if (event.result === "success") {
    console.info(line);
  } else {
    console.error(line);
  }
}
