import { env } from "@/lib/env";
import { noneAnalyticsProvider } from "./providers/none";
import { createPostHogAnalyticsProvider } from "./providers/posthog";
import type { AnalyticsProvider } from "./types";

/** Resolves the configured AnalyticsProvider — mirrors resolveEmailProvider/resolveMessagingProvider. */
export function resolveAnalyticsProvider(): AnalyticsProvider {
  if (env.ANALYTICS_PROVIDER === "posthog") {
    // env.ts's superRefine guarantees POSTHOG_API_KEY is set whenever this branch is reached.
    return createPostHogAnalyticsProvider(env.POSTHOG_API_KEY!, env.POSTHOG_HOST);
  }
  return noneAnalyticsProvider;
}
