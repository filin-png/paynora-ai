import { Prisma, type OrganizationRole } from "@prisma/client";

import { env } from "@/lib/env";
import { normalizeEmail } from "@/server/auth/email";
import { generateToken, hashToken } from "@/server/auth/tokens";
import { assertCanCreateInvitation, assertWithinResourceLimit } from "@/server/billing/entitlements";
import { prisma } from "@/server/db/client";
import { sendTransactionalEmail, type TransactionalEmailOptions } from "@/server/email/transactional";
import { recordActivityEvent } from "@/server/ar/activity";
import { ORGANIZATION_INVITE_POLICY } from "@/server/rate-limit/policies";
import { RateLimitExceededError } from "@/server/rate-limit/errors";
import { checkRateLimit } from "@/server/rate-limit/service";
import { z } from "zod";
import type { SessionUser } from "./types";

const ORGANIZATION_INVITE_SCOPE = "tenancy:invitation:organization";
const UNIQUE_CONSTRAINT_VIOLATION = "P2002";

/** How long an issued invitation link stays usable. */
export const INVITATION_TOKEN_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

export const inviteMemberSchema = z.object({
  email: z.string().trim().email("Enter a valid email address"),
});

/**
 * Deliberately generic — covers "no such invitation," "already
 * accepted/revoked," and "expired" with one outcome, the same collapsing
 * pattern as OrganizationAccessDeniedError (src/server/tenancy/errors.ts)
 * and InvalidOrExpiredResetTokenError (src/server/auth/password-reset.ts).
 */
export class InvalidOrExpiredInvitationError extends Error {
  constructor() {
    super("This invitation link is invalid or has expired.");
    this.name = "InvalidOrExpiredInvitationError";
  }
}

/** Thrown by `revokeInvitation` for "no such PENDING invitation in this organization" — not found, wrong org, and already-resolved all collapse here. */
export class InvitationNotRevocableError extends Error {
  constructor() {
    super("This invitation can no longer be revoked.");
    this.name = "InvitationNotRevocableError";
  }
}

export class DuplicatePendingInvitationError extends Error {
  constructor() {
    super("There is already a pending invitation for this email address.");
    this.name = "DuplicatePendingInvitationError";
  }
}

export class AlreadyOrganizationMemberError extends Error {
  constructor() {
    super("This person is already a member of the organization.");
    this.name = "AlreadyOrganizationMemberError";
  }
}

/**
 * Creates a pending invitation and emails it (best-effort — see
 * sendTransactionalEmail's doc comment). Callers must have already
 * authorized the inviter as OWNER of `organizationId` — this function
 * itself does not re-check role, exactly like updateOrganizationName in
 * organizations.ts; that's the Server Action layer's job
 * (requireOrganizationRoleForPage(orgSlug, "OWNER")).
 *
 * Duplicate-pending-invite protection is enforced at the database level
 * (see the partial unique index on organization_invitations in the Phase
 * 11.2 migration, matching the CollectionPolicy "one default per org"
 * precedent) and surfaced here as DuplicatePendingInvitationError, the
 * same check-via-constraint-violation pattern registerUser already uses
 * for duplicate emails.
 */
export async function createInvitation(
  organizationId: string,
  invitedByUserId: string,
  rawEmail: string,
  role: OrganizationRole,
  options: TransactionalEmailOptions = {},
): Promise<void> {
  const { email } = inviteMemberSchema.parse({ email: rawEmail });
  const normalizedEmail = normalizeEmail(email);

  let inviteLimit: Awaited<ReturnType<typeof checkRateLimit>>;
  try {
    inviteLimit = await checkRateLimit(ORGANIZATION_INVITE_SCOPE, organizationId, ORGANIZATION_INVITE_POLICY);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[tenancy] invitation rate limit check failed — failing closed: ${message}`);
    throw new RateLimitExceededError(
      new Date(Date.now() + ORGANIZATION_INVITE_POLICY.windowMs),
      "Something went wrong. Please try again.",
    );
  }
  if (!inviteLimit.allowed) {
    throw new RateLimitExceededError(
      inviteLimit.resetAt,
      "This organization has reached its hourly limit for sending invitations. Please try again later.",
    );
  }

  const existingUser = await prisma.user.findUnique({ where: { email: normalizedEmail }, select: { id: true } });
  if (existingUser) {
    const existingMembership = await prisma.organizationMember.findUnique({
      where: { userId_organizationId: { userId: existingUser.id, organizationId } },
    });
    if (existingMembership) throw new AlreadyOrganizationMemberError();
  }

  const { raw, hash } = generateToken();

  let organization: { name: string };
  try {
    organization = await prisma.$transaction(async (tx) => {
      await assertCanCreateInvitation(tx, organizationId);

      const org = await tx.organization.findUniqueOrThrow({
        where: { id: organizationId },
        select: { name: true },
      });
      await tx.organizationInvitation.create({
        data: {
          organizationId,
          email: normalizedEmail,
          role,
          tokenHash: hash,
          expiresAt: new Date(Date.now() + INVITATION_TOKEN_TTL_MS),
          invitedByUserId,
        },
      });
      await recordActivityEvent(tx, {
        organizationId,
        type: "MEMBER_INVITED",
        summary: `An invitation was sent to join as ${role === "OWNER" ? "an owner" : "a member"}`,
        metadata: { role },
      });
      return org;
    });
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === UNIQUE_CONSTRAINT_VIOLATION) {
      throw new DuplicatePendingInvitationError();
    }
    throw error;
  }

  const acceptUrl = `${env.APP_BASE_URL}/invitations/accept?token=${raw}`;
  try {
    await sendTransactionalEmail(
      {
        to: normalizedEmail,
        subject: `You've been invited to join ${organization.name} on PAYNORA`,
        text: [
          `You've been invited to join ${organization.name} on PAYNORA as ${role === "OWNER" ? "an owner" : "a member"}.`,
          "",
          acceptUrl,
          "",
          "This link expires in 7 days and can only be used once.",
          "If you weren't expecting this invitation, you can safely ignore this email.",
        ].join("\n"),
        // Never the raw token — see TransactionalEmailMessage's doc comment.
        idempotencyKey: `org-invite:${hash}`,
      },
      options,
    );
  } catch (error) {
    // Best-effort, exactly like requestPasswordReset: the invitation row
    // already exists and remains usable regardless of whether this send
    // confirmed delivery. Never logs the token or message body.
    const message = error instanceof Error ? error.name : "unknown error";
    console.warn(`[tenancy] invitation email dispatch did not confirm delivery: ${message}`);
  }
}

export type InvitationPreview = { organizationName: string; role: OrganizationRole; email: string };

/**
 * Read-only lookup for the accept-invitation page — lets it show which
 * organization/role a token maps to before the visitor is necessarily
 * signed in, without mutating anything (accepting is a distinct, explicit
 * step — see acceptInvitation). Not a new information disclosure: only
 * someone holding the unguessable raw token (the one from the emailed
 * link) can ever reach this, and the email itself already contains the
 * organization name. Returns null for anything not currently acceptable
 * (no such token, already resolved, expired) — deliberately without
 * distinguishing which, for the same reason InvalidOrExpiredInvitationError
 * collapses those cases.
 */
export async function previewInvitation(rawToken: string, now: Date = new Date()): Promise<InvitationPreview | null> {
  const tokenHash = hashToken(rawToken);
  const invitation = await prisma.organizationInvitation.findUnique({
    where: { tokenHash },
    include: { organization: { select: { name: true } } },
  });
  if (!invitation || invitation.status !== "PENDING" || invitation.expiresAt < now) return null;
  return { organizationName: invitation.organization.name, role: invitation.role, email: invitation.email };
}

export async function listPendingInvitations(organizationId: string) {
  return prisma.organizationInvitation.findMany({
    where: { organizationId, status: "PENDING" },
    orderBy: { createdAt: "desc" },
    select: { id: true, email: true, role: true, expiresAt: true, createdAt: true },
  });
}

/**
 * OWNER-only revocation, scoped to `organizationId` — a caller from a
 * different organization (or targeting a non-existent/already-resolved
 * invitation) gets the same InvitationNotRevocableError either way,
 * exactly like OrganizationAccessDeniedError. Compare-and-swap
 * (PENDING -> REVOKED) so a concurrent accept and a concurrent revoke of
 * the same invitation can never both win — see
 * src/server/communications/send.ts's claim step for the identical
 * pattern.
 */
export async function revokeInvitation(organizationId: string, invitationId: string): Promise<void> {
  await prisma.$transaction(async (tx) => {
    const claim = await tx.organizationInvitation.updateMany({
      where: { id: invitationId, organizationId, status: "PENDING" },
      data: { status: "REVOKED" },
    });
    if (claim.count !== 1) throw new InvitationNotRevocableError();

    await recordActivityEvent(tx, {
      organizationId,
      type: "MEMBER_INVITATION_REVOKED",
      summary: "A pending member invitation was revoked",
    });
  });
}

/**
 * Creates the membership row only if it doesn't already exist, and only
 * then checks the member-seat entitlement (section 6 C, section 8
 * concurrency) — an already-existing membership is a no-op regardless of
 * current usage, so a legitimate idempotent replay (see acceptInvitation's
 * doc comment) can never be incorrectly blocked by a quota that's since
 * been reached by other activity. `assertWithinResourceLimit` locks the
 * Organization row for the remainder of this transaction, so two
 * concurrent acceptances for *different* invitations into the same
 * organization serialize correctly here even though each has its own
 * invitation-level CAS.
 */
async function ensureMembershipWithinQuota(
  tx: Prisma.TransactionClient,
  organizationId: string,
  userId: string,
  role: OrganizationRole,
): Promise<void> {
  const existing = await tx.organizationMember.findUnique({
    where: { userId_organizationId: { userId, organizationId } },
  });
  if (existing) return;

  await assertWithinResourceLimit(tx, organizationId, "members");
  await tx.organizationMember.create({ data: { userId, organizationId, role } });
}

export type AcceptInvitationResult = { organizationSlug: string };

/**
 * Accepts an invitation on behalf of an already-authenticated `user` —
 * callers (the accept-invitation Server Action) are responsible for
 * getting the user signed in or registered first; this function only ever
 * turns a valid token into a membership, never creates an account itself
 * (see the Phase 11.2 brief: "Do not create insecure accounts
 * automatically").
 *
 * Binds the token to the exact invited email address: the signed-in
 * user's own email must match `invitation.email`, not merely "some
 * authenticated user presented this token." This is a deliberate,
 * stricter reading of "possession and valid acceptance of the invitation
 * token is required" — it closes the gap where a forwarded/leaked link
 * could be accepted by whichever account happens to be signed in, rather
 * than only by the person who actually controls the invited address.
 * Since User.email is unique, at most one account can ever satisfy this
 * check for a given invitation.
 *
 * Idempotent and race-safe: the PENDING -> ACCEPTED transition is a
 * compare-and-swap, so of any number of concurrent acceptance attempts
 * for the same token, exactly one performs the transition. Every other
 * concurrent (or later, resubmitted) call — including a genuine
 * double-submit by the same user — re-reads the now-ACCEPTED invitation,
 * confirms it was this exact user (guaranteed by the email binding
 * above), and treats it as a successful no-op via `upsert` rather than
 * erroring, so a duplicate OrganizationMember row is never created and a
 * legitimate retry never sees a confusing failure.
 */
export async function acceptInvitation(
  user: SessionUser,
  rawToken: string,
  now: Date = new Date(),
): Promise<AcceptInvitationResult> {
  const tokenHash = hashToken(rawToken);
  const invitation = await prisma.organizationInvitation.findUnique({
    where: { tokenHash },
    include: { organization: { select: { slug: true } } },
  });
  if (!invitation) throw new InvalidOrExpiredInvitationError();
  if (normalizeEmail(user.email) !== invitation.email) throw new InvalidOrExpiredInvitationError();

  const organizationSlug = invitation.organization.slug;

  await prisma.$transaction(async (tx) => {
    const claim = await tx.organizationInvitation.updateMany({
      where: { id: invitation.id, status: "PENDING", expiresAt: { gt: now } },
      data: { status: "ACCEPTED", acceptedAt: now, acceptedByUserId: user.id },
    });

    if (claim.count === 1) {
      await ensureMembershipWithinQuota(tx, invitation.organizationId, user.id, invitation.role);
      await recordActivityEvent(tx, {
        organizationId: invitation.organizationId,
        type: "MEMBER_JOINED",
        summary: "A new member joined the organization",
        metadata: { role: invitation.role },
      });
      return;
    }

    // Lost the claim — see the doc comment above for why re-reading and
    // treating an already-ACCEPTED invitation as an idempotent success is
    // safe here specifically (the email binding makes it airtight).
    const current = await tx.organizationInvitation.findUniqueOrThrow({ where: { id: invitation.id } });
    if (current.status !== "ACCEPTED") throw new InvalidOrExpiredInvitationError();

    await ensureMembershipWithinQuota(tx, invitation.organizationId, user.id, invitation.role);
  });

  return { organizationSlug };
}
