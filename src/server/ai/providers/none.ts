import { AIDisabledError } from "../errors";
import type { AIProvider, AIRequest, AIResult } from "../types";

/**
 * The default provider when AI_PROVIDER=none (src/lib/env.ts). Exists so
 * "no provider configured" is a real, testable object rather than a null
 * check scattered across callers — every call always fails the same
 * documented way.
 */
export const noneProvider: AIProvider = {
  name: "none",
  generateStructured<T>(_request: AIRequest<T>): Promise<AIResult<T>> {
    throw new AIDisabledError();
  },
};
