import type { WebSearchProvider, WebSearchRequest, WebSearchResult } from "../types";

/** Deterministic, in-memory WebSearchProvider used only by tests — mirrors src/server/ai/providers/fake.ts. */
export function createFakeWebSearchProvider(
  behavior: { kind: "success"; result: WebSearchResult } | { kind: "error"; message: string } | { kind: "hang" },
  name = "fake",
): WebSearchProvider {
  return {
    name,
    async search(_request: WebSearchRequest, options?: { signal?: AbortSignal }): Promise<WebSearchResult> {
      switch (behavior.kind) {
        case "success":
          return behavior.result;
        case "error":
          throw new Error(behavior.message);
        case "hang":
          return new Promise<WebSearchResult>((_resolve, reject) => {
            options?.signal?.addEventListener("abort", () => {
              reject(new DOMException("The operation was aborted.", "AbortError"));
            });
          });
      }
    },
  };
}
