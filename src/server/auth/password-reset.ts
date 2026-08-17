import { env } from "@/lib/env";
import { prisma } from "@/server/db/client";
import { sendTransactionalEmail, type TransactionalEmailOptions } from "@/server/email/transactional";
import {
  PASSWORD_RESET_REQUEST_ACCOUNT_POLICY,
  PASSWORD_RESET_REQUEST_IP_POLICY,
} from "@/server/rate-limit/policies";
import { checkRateLimit } from "@/server/rate-limit/service";
import { normalizeEmail } from "./email";
import { hashPassword, passwordSchema } from "./password";
import { generateToken, hashToken } from "./tokens";

const PASSWORD_RESET_IP_SCOPE = "auth:password-reset:ip";
const PASSWORD_RESET_ACCOUNT_SCOPE = "auth:password-reset:account";

/** How long an issued reset link stays usable. */
export const PASSWORD_RESET_TOKEN_TTL_MS = 60 * 60 * 1000; // 1 hour

export type PasswordResetRequestOutcome = "requested" | "rate_limited";

/**
 * Thrown by `resetPassword` for every "cannot use this token" case —
 * doesn't exist, already consumed, or expired — deliberately collapsed
 * into one generic outcome (see OrganizationAccessDeniedError's identical
 * design in src/server/tenancy/errors.ts) so a caller can never learn
 * *why* a token failed, only that it did.
 */
export class InvalidOrExpiredResetTokenError extends Error {
  constructor() {
    super("This password reset link is invalid or has expired.");
    this.name = "InvalidOrExpiredResetTokenError";
  }
}

/**
 * Starts a password reset: if `email` belongs to a real account, issues a
 * fresh single-use token and emails a reset link; if not, does nothing —
 * either way the caller gets back the same `"requested"` outcome (unless
 * rate-limited) and must show the identical generic message to the user.
 * Never reveals which case occurred, in its return value or in any thrown
 * error.
 *
 * Enumeration safety here is necessarily partial, not absolute — worth
 * documenting rather than overclaiming. The rate-limit check and the
 * public return value are fully symmetric between "account exists" and
 * "account doesn't exist." What is *not* fully symmetric is wall-clock
 * timing: issuing a token requires a real database write (a
 * PasswordResetToken row references `userId` via a foreign key, so one
 * cannot be written for an email with no matching user), and, once real
 * SMTP is configured, a real outbound network call. Matching that exactly
 * would mean writing throwaway rows with no valid user to reference, which
 * this schema deliberately does not support (see PasswordResetToken's own
 * doc comment) — the same trade-off the codebase already accepts
 * elsewhere (e.g. authenticateCredentials's DUMMY_PASSWORD_HASH masks the
 * bcrypt-compare cost specifically, not every downstream cost of a real
 * login). This is the "as reasonably possible within the current
 * architecture" scope the brief itself calls for, not a gap introduced
 * carelessly.
 */
export async function requestPasswordReset(
  rawEmail: string,
  ip: string,
  options: TransactionalEmailOptions = {},
): Promise<PasswordResetRequestOutcome> {
  const email = normalizeEmail(rawEmail);

  let ipCheck: Awaited<ReturnType<typeof checkRateLimit>>;
  let accountCheck: Awaited<ReturnType<typeof checkRateLimit>>;
  try {
    [ipCheck, accountCheck] = await Promise.all([
      checkRateLimit(PASSWORD_RESET_IP_SCOPE, ip, PASSWORD_RESET_REQUEST_IP_POLICY),
      checkRateLimit(PASSWORD_RESET_ACCOUNT_SCOPE, email, PASSWORD_RESET_REQUEST_ACCOUNT_POLICY),
    ]);
  } catch (error) {
    // Fail closed, same as authenticateCredentials — an unexpected rate
    // limiter error blocks the request rather than silently allowing it.
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[auth] password reset rate limit check failed — failing closed: ${message}`);
    return "rate_limited";
  }
  if (!ipCheck.allowed || !accountCheck.allowed) return "rate_limited";

  const user = await prisma.user.findUnique({ where: { email } });
  if (!user) return "requested";

  const { raw, hash } = generateToken();
  await prisma.$transaction([
    // Supersede any still-usable tokens from earlier requests — at most one
    // active reset link per user at a time. Deleted outright rather than
    // marked consumed: "superseded" and "used" are different facts, and
    // this table has no reader that needs to tell them apart.
    prisma.passwordResetToken.deleteMany({ where: { userId: user.id, consumedAt: null } }),
    prisma.passwordResetToken.create({
      data: {
        userId: user.id,
        tokenHash: hash,
        expiresAt: new Date(Date.now() + PASSWORD_RESET_TOKEN_TTL_MS),
      },
    }),
  ]);

  const resetUrl = `${env.APP_BASE_URL}/reset-password?token=${raw}`;
  try {
    await sendTransactionalEmail(
      {
        to: user.email,
        subject: "Reset your PAYNORA password",
        text: [
          "We received a request to reset your PAYNORA password.",
          "",
          resetUrl,
          "",
          "This link expires in 1 hour and can only be used once.",
          "If you didn't request this, you can safely ignore this email — your password will not be changed.",
        ].join("\n"),
        // Never the raw token — see TransactionalEmailMessage's doc comment.
        idempotencyKey: `password-reset:${hash}`,
      },
      options,
    );
  } catch (error) {
    // A failed/disabled/unknown-outcome send must never fail the request or
    // reveal anything — the token row already exists and remains usable if
    // the operator fixes email delivery and the user retries, or if the
    // link reaches them some other way. Never logs the token or message body.
    const message = error instanceof Error ? error.name : "unknown error";
    console.warn(`[auth] password reset email dispatch did not confirm delivery: ${message}`);
  }

  return "requested";
}

export const resetPasswordSchema = passwordSchema;

/**
 * Consumes a reset token and sets a new password. Atomic and race-safe: the
 * token is claimed (consumedAt: null -> now) via a compare-and-swap
 * `updateMany`, exactly like every other claim-then-act transition in this
 * codebase (see src/server/communications/send.ts's claim step) — only one
 * of any number of concurrent callers holding the same token can win, and
 * expiry is checked as part of the same atomic condition rather than in a
 * separate read beforehand, closing the gap where a token could expire
 * between an initial check and the write.
 */
export async function resetPassword(
  rawToken: string,
  newPassword: string,
  now: Date = new Date(),
): Promise<void> {
  passwordSchema.parse(newPassword);
  const tokenHash = hashToken(rawToken);

  const resetToken = await prisma.passwordResetToken.findUnique({ where: { tokenHash } });
  if (!resetToken) throw new InvalidOrExpiredResetTokenError();

  const passwordHash = await hashPassword(newPassword);

  await prisma.$transaction(async (tx) => {
    const claim = await tx.passwordResetToken.updateMany({
      where: { id: resetToken.id, consumedAt: null, expiresAt: { gt: now } },
      data: { consumedAt: now },
    });
    if (claim.count !== 1) throw new InvalidOrExpiredResetTokenError();

    await tx.user.update({ where: { id: resetToken.userId }, data: { passwordHash } });
  });
}
