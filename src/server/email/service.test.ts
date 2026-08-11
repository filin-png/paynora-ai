import { describe, expect, it } from "vitest";

import { EmailDisabledError } from "./errors";
import { isEmailSendingEnabled, resolveEmailProvider } from "./service";

describe("email service (EMAIL_PROVIDER=none, the test/CI default)", () => {
  it("reports email sending as disabled", () => {
    expect(isEmailSendingEnabled()).toBe(false);
  });

  it("resolveEmailProvider throws EmailDisabledError rather than returning a provider", () => {
    expect(() => resolveEmailProvider()).toThrow(EmailDisabledError);
  });
});
