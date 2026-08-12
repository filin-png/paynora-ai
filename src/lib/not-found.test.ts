import { describe, expect, it } from "vitest";

import { isResourceNotFoundError } from "./not-found";

class ArResourceNotFoundError extends Error {
  constructor() {
    super("Invoice not found");
    this.name = "ArResourceNotFoundError";
  }
}

class OperatorResourceNotFoundError extends Error {
  constructor() {
    super("Action proposal not found");
    this.name = "OperatorResourceNotFoundError";
  }
}

describe("isResourceNotFoundError", () => {
  it("recognizes every domain's resource-not-found error by name", () => {
    expect(isResourceNotFoundError(new ArResourceNotFoundError())).toBe(true);
    expect(isResourceNotFoundError(new OperatorResourceNotFoundError())).toBe(true);
  });

  it("does not misclassify an unrelated error", () => {
    expect(isResourceNotFoundError(new Error("boom"))).toBe(false);
    expect(isResourceNotFoundError(new TypeError("boom"))).toBe(false);
  });

  it("does not misclassify a non-Error value", () => {
    expect(isResourceNotFoundError("ArResourceNotFoundError")).toBe(false);
    expect(isResourceNotFoundError(null)).toBe(false);
    expect(isResourceNotFoundError(undefined)).toBe(false);
    expect(isResourceNotFoundError({ name: "ArResourceNotFoundError" })).toBe(false);
  });
});
