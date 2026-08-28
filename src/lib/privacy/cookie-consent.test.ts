import { describe, expect, it } from "vitest";

import { isCookieConsentValue } from "./cookie-consent";

describe("isCookieConsentValue", () => {
  it("accepts the two real consent values", () => {
    expect(isCookieConsentValue("accepted")).toBe(true);
    expect(isCookieConsentValue("rejected")).toBe(true);
  });

  it("rejects an unset, missing, or malformed value", () => {
    expect(isCookieConsentValue(undefined)).toBe(false);
    expect(isCookieConsentValue(null)).toBe(false);
    expect(isCookieConsentValue("")).toBe(false);
    expect(isCookieConsentValue("maybe")).toBe(false);
  });

  it("rejects a value that isn't exactly one of the two allowed strings, including case variants and injected content", () => {
    expect(isCookieConsentValue("Accepted")).toBe(false);
    expect(isCookieConsentValue("accepted; Path=/; HttpOnly")).toBe(false);
    expect(isCookieConsentValue("<script>alert(1)</script>")).toBe(false);
  });
});
