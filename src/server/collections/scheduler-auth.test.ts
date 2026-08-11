import { describe, expect, it } from "vitest";

import { verifyCronSecret } from "./scheduler-auth";

const SECRET = "a-real-secret-value-12345";

describe("verifyCronSecret", () => {
  it("accepts a correctly formatted Bearer header matching the secret", () => {
    expect(verifyCronSecret(`Bearer ${SECRET}`, SECRET)).toBe(true);
  });

  it("rejects a missing header", () => {
    expect(verifyCronSecret(null, SECRET)).toBe(false);
  });

  it("rejects a header without the Bearer prefix", () => {
    expect(verifyCronSecret(SECRET, SECRET)).toBe(false);
  });

  it("rejects a wrong secret", () => {
    expect(verifyCronSecret(`Bearer wrong-secret`, SECRET)).toBe(false);
  });

  it("rejects a secret that's a prefix of the real one", () => {
    expect(verifyCronSecret(`Bearer ${SECRET.slice(0, 5)}`, SECRET)).toBe(false);
  });

  it("rejects any header when no secret is configured for the deployment", () => {
    expect(verifyCronSecret(`Bearer anything`, undefined)).toBe(false);
  });

  it("rejects an empty Bearer token", () => {
    expect(verifyCronSecret(`Bearer `, SECRET)).toBe(false);
  });
});
