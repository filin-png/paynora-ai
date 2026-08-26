/**
 * Sandbox integration test — makes a REAL network call to a REAL PostHog
 * project using REAL credentials. Deliberately separate from
 * posthog.test.ts (mocked `fetch`, always runs, no credentials needed).
 *
 * Opt-in only: skipped unless RUN_EXTERNAL_INTEGRATION_TESTS=true, so
 * `npm run test` and CI never require a PostHog account. To run it
 * locally against your own (ideally a dedicated test/sandbox) PostHog
 * project:
 *
 *   RUN_EXTERNAL_INTEGRATION_TESTS=true POSTHOG_API_KEY=phc_xxx npm run test -- posthog.sandbox
 *
 * See docs/production-integrations.md#test-layers.
 */
import { describe, expect, it } from "vitest";

const RUN = process.env.RUN_EXTERNAL_INTEGRATION_TESTS === "true";
const apiKey = process.env.POSTHOG_API_KEY;
const apiHost = process.env.POSTHOG_HOST ?? "https://us.i.posthog.com";

describe.skipIf(!RUN)("PostHog sandbox (real network, opt-in)", () => {
  it("authenticates and accepts a real capture request", async () => {
    if (!apiKey) {
      throw new Error("POSTHOG_API_KEY must be set when RUN_EXTERNAL_INTEGRATION_TESTS=true for this test to run.");
    }

    // A direct fetch against the same Capture API endpoint the real
    // adapter (posthog.ts) uses — checked here, rather than through
    // capture() itself, because capture() deliberately never throws or
    // surfaces the response (analytics must never break a caller on a
    // vendor failure), which would make a black-box call to it useless
    // for proving real connectivity actually works.
    const response = await fetch(`${apiHost}/capture/`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        api_key: apiKey,
        event: "phase14_sandbox_test_event",
        distinct_id: "phase14-sandbox-test",
        properties: { $process_person_profile: false, source: "paynora-sandbox-test" },
        timestamp: new Date().toISOString(),
      }),
    });

    expect(response.ok).toBe(true);
  });
});
