import type { AnalyticsEvent, AnalyticsProvider } from "../types";

/** Deterministic, in-memory AnalyticsProvider used only by tests — mirrors src/server/ai/providers/fake.ts. Never reachable from application code. */
export function createFakeAnalyticsProvider(): AnalyticsProvider & { events: AnalyticsEvent[] } {
  const events: AnalyticsEvent[] = [];
  return {
    name: "fake",
    events,
    async capture(event: AnalyticsEvent): Promise<void> {
      events.push(event);
    },
  };
}
