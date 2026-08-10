import { describe, expect, it } from "vitest";
import { generateUniqueOrganizationSlug, slugify } from "./slug";

describe("slugify", () => {
  it("lowercases and hyphenates", () => {
    expect(slugify("Acme Agency")).toBe("acme-agency");
  });

  it("strips non-alphanumeric characters", () => {
    expect(slugify("Acme & Co., Ltd.")).toBe("acme-co-ltd");
  });

  it("trims leading/trailing hyphens", () => {
    expect(slugify("  -Acme-  ")).toBe("acme");
  });
});

describe("generateUniqueOrganizationSlug", () => {
  it("returns the base slug when it's available", async () => {
    const slug = await generateUniqueOrganizationSlug("Acme Agency", async () => false);
    expect(slug).toBe("acme-agency");
  });

  it("appends a suffix when the base slug is taken", async () => {
    const slug = await generateUniqueOrganizationSlug("Acme Agency", async (candidate) => candidate === "acme-agency");
    expect(slug).toMatch(/^acme-agency-[a-z0-9]+$/);
  });

  it("falls back to a generic base for a name with no alphanumeric characters", async () => {
    const slug = await generateUniqueOrganizationSlug("&&&", async () => false);
    expect(slug).toBe("organization");
  });
});
