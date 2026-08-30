import type { AnalyticsEvent, AnalyticsProvider } from "../types";

const CAPTURE_TIMEOUT_MS = 5_000;

/**
 * Real PostHog adapter — a plain HTTP POST to PostHog's Capture API
 * (https://posthog.com/docs/api/capture), no vendor SDK needed. `apiHost`
 * defaults to PostHog's US cloud but is configurable to
 * `https://eu.i.posthog.com` for EU-hosted deployments — see
 * docs/production-integrations.md#european-access.
 *
 * Never throws: analytics is inherently best-effort, and a vendor outage
 * must never surface as an error to whatever real user action triggered
 * the event. A failed capture is swallowed here, after a bounded timeout
 * (AbortController, mirrors src/server/ai/gateway.ts's discipline) so a
 * slow/unreachable vendor can never hang the caller.
 *
 * Privacy minimization (Phase 15A, see docs/privacy-data-inventory.md#analytics):
 * this call is always made server-side, from PAYNORA's own backend — the
 * connecting IP PostHog's Capture API would otherwise see and geolocate
 * is PAYNORA's own hosting infrastructure, never an end customer's real
 * IP (no browser SDK is ever loaded, so no request originates from a
 * customer's device). `$geoip_disable: true` is set explicitly anyway,
 * so PostHog never attempts geolocation from that connecting IP at all —
 * belt-and-suspenders, not a fix for an actual leak.
 */
export function createPostHogAnalyticsProvider(apiKey: string, apiHost = "https://us.i.posthog.com"): AnalyticsProvider {
  return {
    name: "posthog",
    async capture(event: AnalyticsEvent): Promise<void> {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), CAPTURE_TIMEOUT_MS);
      try {
        await fetch(`${apiHost}/capture/`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            api_key: apiKey,
            event: event.name,
            distinct_id: event.userId ?? event.organizationId ?? "system",
            properties: {
              ...event.properties,
              organization_id: event.organizationId,
              $process_person_profile: Boolean(event.userId),
              $geoip_disable: true,
            },
            timestamp: new Date().toISOString(),
          }),
          signal: controller.signal,
        });
      } catch {
        // Swallowed by design — see the module doc comment above.
      } finally {
        clearTimeout(timeout);
      }
    },
  };
}
