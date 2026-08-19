import { describe, expect, it } from "vitest";

import { EntitlementLimitExceededError } from "@/server/billing/entitlements";
import { isEntitlementLimitMessage } from "./upgrade-hint";

describe("isEntitlementLimitMessage", () => {
  it("recognizes the exact message EntitlementLimitExceededError produces at FREE-plan limits", () => {
    const error = new EntitlementLimitExceededError("customers", 25, 25);
    expect(isEntitlementLimitMessage(error.message)).toBe(true);
  });

  it("does not misfire on unrelated error messages", () => {
    expect(isEntitlementLimitMessage("Invalid email address.")).toBe(false);
    expect(isEntitlementLimitMessage("An invoice with this number already exists")).toBe(false);
  });
});
