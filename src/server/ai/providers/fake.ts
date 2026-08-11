import type { AIProvider, AIRequest, AIResult } from "../types";

/**
 * Deterministic, in-memory AIProvider used only by tests (see
 * src/server/ai/gateway.test.ts and src/server/operator/*.test.ts). No
 * network call, no vendor SDK — this is what makes it possible to test
 * timeout, invalid-output, and provider-failure handling without a real
 * AI account, and what keeps CI free of any real AI network dependency.
 * Not reachable from application code — `AI_PROVIDER` only ever resolves
 * to `none` or a real vendor adapter (src/server/ai/service.ts).
 */
export function createFakeProvider(
  behavior:
    | { kind: "success"; data: unknown; usage?: AIResult<unknown>["usage"] }
    | { kind: "invalid"; data: unknown }
    | { kind: "error"; message: string }
    | { kind: "hang" },
  name = "fake",
): AIProvider {
  return {
    name,
    async generateStructured<T>(_request: AIRequest<T>): Promise<AIResult<T>> {
      switch (behavior.kind) {
        case "success":
          return { data: behavior.data as T, provider: name, usage: behavior.usage };
        case "invalid":
          return { data: behavior.data as T, provider: name };
        case "error":
          throw new Error(behavior.message);
        case "hang":
          return new Promise<AIResult<T>>(() => {
            // Deliberately never resolves — used to exercise gateway timeout handling.
          });
      }
    },
  };
}
