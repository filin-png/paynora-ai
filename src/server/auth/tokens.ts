import { createHash, randomBytes } from "node:crypto";

/**
 * Shared token primitive for password reset and organization invitations
 * (src/server/auth/password-reset.ts, src/server/tenancy/invitations.ts).
 * The raw token is what goes in the emailed link/form field and is never
 * persisted anywhere — only `hash` (its SHA-256 digest) is stored, mirroring
 * the "never store the secret itself" principle User.passwordHash already
 * follows. 32 bytes (256 bits) of `crypto.randomBytes` is unguessable by
 * brute force, so a plain SHA-256 digest — not a slow password hash like
 * bcrypt — is the right, standard choice for a high-entropy random token
 * (unlike a user-chosen password, there's nothing to protect against a
 * dictionary attack).
 */
const TOKEN_BYTES = 32;

export type GeneratedToken = {
  /** The token to embed in a link/form and hand to the requester — never persisted. */
  raw: string;
  /** SHA-256 digest of `raw` — this is what gets stored and looked up. */
  hash: string;
};

export function generateToken(): GeneratedToken {
  const raw = randomBytes(TOKEN_BYTES).toString("base64url");
  return { raw, hash: hashToken(raw) };
}

export function hashToken(rawToken: string): string {
  return createHash("sha256").update(rawToken).digest("hex");
}
