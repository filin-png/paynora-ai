import type { AnalyticsEvent, AnalyticsProvider } from "../types";

/** Default when ANALYTICS_PROVIDER=none — a real, harmless no-op, mirrors every other domain's none.ts. */
export const noneAnalyticsProvider: AnalyticsProvider = {
  name: "none",
  async capture(_event: AnalyticsEvent): Promise<void> {
    // Intentionally does nothing.
  },
};
