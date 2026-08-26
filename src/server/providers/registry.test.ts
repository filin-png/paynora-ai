import { describe, expect, it } from "vitest";

import { getProviderRegistrySnapshot, getProviderVendorBreakdown, getRecommendedVendors, resolveHealth } from "./registry";

describe("getProviderRegistrySnapshot", () => {
  it("reports the test environment's default configuration honestly", () => {
    const snapshot = getProviderRegistrySnapshot();

    expect(snapshot.deploymentProfile).toBe("LOCAL_TEST");
    expect(snapshot.entries).toHaveLength(7);

    const ai = snapshot.entries.find((e) => e.category === "ai")!;
    expect(ai.vendor).toBe("none");
    expect(ai.enabled).toBe(false);
    expect(ai.health).toBe("DISABLED");
    expect(ai.capabilities).toEqual([]);

    const billing = snapshot.entries.find((e) => e.category === "billing")!;
    expect(billing.vendor).toBe("none");
    expect(billing.implemented).toBe(true); // "none" itself is always a valid, working selection

    const wallet = snapshot.entries.find((e) => e.category === "wallet")!;
    expect(wallet.vendor).toBe("none");
    expect(wallet.enabled).toBe(false);
    expect(wallet.health).toBe("DISABLED");
  });

  it("never returns DEGRADED or DOWN — those are reserved for a future live health-check mechanism", () => {
    const snapshot = getProviderRegistrySnapshot();
    for (const e of snapshot.entries) {
      expect(["HEALTHY", "DISABLED", "UNKNOWN"]).toContain(e.health);
    }
  });
});

describe("resolveHealth", () => {
  it("is DISABLED for the none vendor regardless of the implemented flag", () => {
    expect(resolveHealth("none", true)).toBe("DISABLED");
    expect(resolveHealth("none", false)).toBe("DISABLED");
  });

  it("is UNKNOWN for a selected, recognized-but-unimplemented vendor (e.g. gigachat)", () => {
    expect(resolveHealth("gigachat", false)).toBe("UNKNOWN");
  });

  it("is HEALTHY for a selected vendor with a real adapter", () => {
    expect(resolveHealth("openrouter", true)).toBe("HEALTHY");
  });
});

describe("getProviderVendorBreakdown", () => {
  it("reports every known vendor as not configured in the test environment (no secrets set)", () => {
    const vendors = getProviderVendorBreakdown();
    const names = vendors.map((v) => v.vendor).sort();
    expect(names).toEqual(["anthropic", "mistral", "openrouter", "posthog", "smtp", "telegram"]);
    for (const vendor of vendors) {
      expect(vendor.configured).toBe(false);
      expect(vendor.active).toBe(false);
    }
  });

  it("never includes a secret value — only vendor/category/configured/implemented/active booleans", () => {
    const vendors = getProviderVendorBreakdown();
    for (const vendor of vendors) {
      const keys = Object.keys(vendor).sort();
      expect(keys).toEqual(["active", "category", "configured", "implemented", "vendor"]);
    }
  });
});

describe("getRecommendedVendors", () => {
  it("recommends yookassa and gigachat/yandex for RU, stripe and openrouter/mistral for GLOBAL", () => {
    expect(getRecommendedVendors("RU", "billing")).toContain("yookassa");
    expect(getRecommendedVendors("RU", "ai")).toContain("gigachat");
    expect(getRecommendedVendors("GLOBAL", "billing")).toContain("stripe");
    expect(getRecommendedVendors("GLOBAL", "ai")).toContain("openrouter");
  });

  it("recommends nothing but none for LOCAL_TEST", () => {
    expect(getRecommendedVendors("LOCAL_TEST", "ai")).toEqual(["none"]);
  });

  it("is purely descriptive — a category with no explicit recommendation returns an empty list, never throws", () => {
    expect(() => getRecommendedVendors("RU", "email")).not.toThrow();
  });
});
