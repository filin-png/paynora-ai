/**
 * Temporary — deliberately throws, to confirm the Sentry wiring in
 * src/instrumentation.ts actually reaches production. Deleted in the
 * follow-up commit right after the resulting event is confirmed in
 * Sentry. Not a real endpoint: nothing else in this app calls it or
 * links to it.
 */
export async function GET(): Promise<never> {
  throw new Error("PAYNORA Sentry smoke test — expected, safe to resolve/ignore in Sentry.");
}
