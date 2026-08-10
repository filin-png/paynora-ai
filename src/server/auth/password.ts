import bcrypt from "bcryptjs";

/**
 * bcryptjs is a pure-JS implementation: no native build step, so it installs
 * identically everywhere (a direct requirement for this project — see
 * docs/provider-strategy.md on portability). Argon2id is the newer OWASP
 * first choice, but its common Node bindings are native modules; bcrypt
 * remains an OWASP-acceptable algorithm and avoids that risk. Revisit if a
 * pure-JS Argon2 implementation becomes the better trade-off.
 */
const SALT_ROUNDS = 12;

export function hashPassword(plainTextPassword: string): Promise<string> {
  return bcrypt.hash(plainTextPassword, SALT_ROUNDS);
}

export function verifyPassword(
  plainTextPassword: string,
  passwordHash: string,
): Promise<boolean> {
  return bcrypt.compare(plainTextPassword, passwordHash);
}

/**
 * A precomputed hash with no corresponding real password. Compared against
 * when no user is found for a login attempt, so authorize() always pays the
 * cost of a bcrypt compare — otherwise "unknown email" would return faster
 * than "wrong password" and leak which emails have accounts via timing.
 */
export const DUMMY_PASSWORD_HASH = bcrypt.hashSync(
  "no-account-has-this-password",
  SALT_ROUNDS,
);
