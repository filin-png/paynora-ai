import { describe, expect, it } from "vitest";

import { MessagingDisabledError } from "./errors";
import { isMessagingEnabled, resolveMessagingProvider } from "./service";

describe("messaging service (MESSAGING_PROVIDER=none, the test/CI default)", () => {
  it("reports messaging as disabled", () => {
    expect(isMessagingEnabled()).toBe(false);
  });

  it("resolveMessagingProvider throws MessagingDisabledError rather than returning a provider", () => {
    expect(() => resolveMessagingProvider()).toThrow(MessagingDisabledError);
  });
});
