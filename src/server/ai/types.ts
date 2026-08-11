import type { z } from "zod";

/**
 * A structured AI request. `system` carries only fixed, operator-authored
 * instructions — never business data. `input` carries the (already
 * deterministically prepared) business data as a plain JSON-serializable
 * value, never concatenated into `system`. This split is what keeps
 * customer/invoice free text from ever being interpreted as an
 * instruction — see docs/ai-architecture.md#prompt-injection and
 * src/server/operator/ai-context.ts, which is the only place that builds
 * one of these for a real feature.
 */
export type AIRequest<T> = {
  /** Fixed, operator-authored instructions. Never contains business data. */
  system: string;
  /** Structured business data, treated as data by every provider — never as instructions. */
  input: unknown;
  /** Validates and types the provider's response. Output that fails this is rejected, never used. */
  schema: z.ZodType<T>;
  /** Provider-specific hint; safe to ignore. */
  maxOutputTokens?: number;
};

export type AIUsage = {
  promptTokens?: number;
  completionTokens?: number;
};

export type AIResult<T> = {
  data: T;
  provider: string;
  usage?: AIUsage;
};

/**
 * Implemented by every concrete AI vendor adapter. Deliberately one
 * generic method rather than one per feature (generateReminder,
 * classifyReply, ...): every feature's input/output shape is described by
 * its own Zod schema and passed in, so adding a new AI-assisted feature
 * never requires touching a provider adapter or this interface — only a
 * new schema + prompt at the call site. See docs/ai-architecture.md.
 */
export interface AIProvider {
  readonly name: string;
  generateStructured<T>(request: AIRequest<T>): Promise<AIResult<T>>;
}
