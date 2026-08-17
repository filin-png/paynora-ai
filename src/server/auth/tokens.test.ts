import { describe, expect, it } from "vitest";

import { generateToken, hashToken } from "./tokens";

describe("token generation", () => {
  it("produces a raw token and a matching digest", () => {
    const { raw, hash } = generateToken();
    expect(raw.length).toBeGreaterThan(20);
    expect(hash).toBe(hashToken(raw));
  });

  it("the digest is not the raw token itself", () => {
    const { raw, hash } = generateToken();
    expect(hash).not.toBe(raw);
  });

  it("produces a different raw token every time", () => {
    const a = generateToken();
    const b = generateToken();
    expect(a.raw).not.toBe(b.raw);
  });

  it("hashing is deterministic", () => {
    const { raw } = generateToken();
    expect(hashToken(raw)).toBe(hashToken(raw));
  });
});
