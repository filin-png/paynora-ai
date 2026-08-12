import { z } from "zod";

import { AUTH_ACCOUNT_POLICY, AUTH_IP_POLICY } from "@/server/rate-limit/policies";
import { checkRateLimit, resetRateLimit } from "@/server/rate-limit/service";
import { prisma } from "@/server/db/client";
import { normalizeEmail } from "./email";
import { DUMMY_PASSWORD_HASH, verifyPassword } from "./password";

export const credentialsSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

export const AUTH_SIGNIN_IP_SCOPE = "auth:signin:ip";
export const AUTH_SIGNIN_ACCOUNT_SCOPE = "auth:signin:account";

export type AuthenticatedUser = { id: string; email: string; name: string | null };

/**
 * The real authentication chokepoint — extracted out of
 * `src/server/auth/config.ts`'s inline `authorize` callback purely so it
 * has a directly testable surface (NextAuth's `authorize` is an anonymous
 * function embedded in a `NextAuth({...})` config object, not something
 * you can unit-test through the framework without spinning up the whole
 * HTTP stack). Behavior is identical either way — `config.ts` just calls
 * this with the request's extracted IP.
 *
 * Rate-limited on two independent dimensions before any password check —
 * see docs/audits/PAYNORA-AUDIT-V1-REMEDIATION.md P0-1 for the full
 * design writeup:
 * - `AUTH_SIGNIN_IP_SCOPE` (by client IP): broad protection against one
 *   source hammering many accounts.
 * - `AUTH_SIGNIN_ACCOUNT_SCOPE` (by normalized email): protects one
 *   specific account regardless of source IP. Reset on a confirmed
 *   success so a normal user who mistyped a few times is never
 *   penalized afterward.
 *
 * Fails closed: an unexpected error while checking either limit blocks
 * the attempt (returns `null`, the same generic "auth failed" outcome as
 * a wrong password) rather than silently skipping the check.
 */
export async function authenticateCredentials(
  rawCredentials: unknown,
  ip: string,
): Promise<AuthenticatedUser | null> {
  const parsed = credentialsSchema.safeParse(rawCredentials);
  if (!parsed.success) return null;

  const email = normalizeEmail(parsed.data.email);

  let ipCheck: Awaited<ReturnType<typeof checkRateLimit>>;
  let accountCheck: Awaited<ReturnType<typeof checkRateLimit>>;
  try {
    [ipCheck, accountCheck] = await Promise.all([
      checkRateLimit(AUTH_SIGNIN_IP_SCOPE, ip, AUTH_IP_POLICY),
      checkRateLimit(AUTH_SIGNIN_ACCOUNT_SCOPE, email, AUTH_ACCOUNT_POLICY),
    ]);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[auth] rate limit check failed — failing closed (login blocked): ${message}`);
    return null;
  }
  if (!ipCheck.allowed || !accountCheck.allowed) {
    // Deliberately indistinguishable from a wrong password — never reveal
    // that a limit was hit, let alone which dimension.
    return null;
  }

  const user = await prisma.user.findUnique({ where: { email } });

  // Always run a bcrypt compare, even for an unknown email, so a failed
  // login takes the same time either way (see password.ts).
  const passwordValid = await verifyPassword(parsed.data.password, user?.passwordHash ?? DUMMY_PASSWORD_HASH);
  if (!user || !passwordValid) return null;

  await resetRateLimit(AUTH_SIGNIN_ACCOUNT_SCOPE, email, AUTH_ACCOUNT_POLICY).catch(() => {
    // Never let a reset failure turn a successful login into a failed one.
  });

  return { id: user.id, email: user.email, name: user.name };
}
