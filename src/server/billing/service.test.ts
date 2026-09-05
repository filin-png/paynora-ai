import { describe, expect, it } from "vitest";

import { BillingDisabledError, BillingProviderNotConfiguredError, BillingProviderNotImplementedError } from "./errors";
import { isBillingEnabled, resolveBillingProvider } from "./service";

describe("billing service (BILLING_PROVIDER=none, the test/CI default)", () => {
  it("reports billing as disabled", () => {
    expect(isBillingEnabled()).toBe(false);
  });

  it("resolveBillingProvider throws BillingDisabledError rather than returning a provider", () => {
    expect(() => resolveBillingProvider()).toThrow(BillingDisabledError);
  });
});

describe("resolveBillingProvider — recognized-but-unimplemented vendors", () => {
  it("throws a clear, typed error for stripe", () => {
    expect(() => resolveBillingProvider("stripe")).toThrow(BillingProviderNotImplementedError);
    expect(() => resolveBillingProvider("stripe")).toThrow(/not implemented/);
  });

  it("throws BillingDisabledError when explicitly passed none", () => {
    expect(() => resolveBillingProvider("none")).toThrow(BillingDisabledError);
  });
});

describe("resolveBillingProvider — yookassa (Phase 20: real adapter, but this test env has no credentials)", () => {
  it("throws BillingProviderNotConfiguredError — distinct from 'not implemented', since a real adapter now exists", () => {
    expect(() => resolveBillingProvider("yookassa")).toThrow(BillingProviderNotConfiguredError);
  });
});
