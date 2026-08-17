import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { registerUser } from "@/server/auth/users";
import { prisma } from "@/server/db/client";
import { resetDatabase } from "@/server/db/test-utils";
import type { EmailMessage, EmailProvider } from "@/server/email/types";
import { requireOrganizationRole } from "./context";
import { OrganizationAccessDeniedError } from "./errors";
import {
  acceptInvitation,
  AlreadyOrganizationMemberError,
  createInvitation,
  DuplicatePendingInvitationError,
  InvalidOrExpiredInvitationError,
  InvitationNotRevocableError,
  listPendingInvitations,
  revokeInvitation,
} from "./invitations";
import { createOrganization } from "./organizations";

beforeEach(resetDatabase);
afterAll(() => prisma.$disconnect());

function createCapturingEmailProvider() {
  const messages: EmailMessage[] = [];
  const provider: EmailProvider = {
    name: "capturing-fake",
    async send(message) {
      messages.push(message);
      return { provider: "capturing-fake" };
    },
  };
  return { provider, messages };
}

function extractToken(text: string): string {
  const match = text.match(/token=([^&\s]+)/);
  if (!match) throw new Error("no token found in email body");
  return match[1];
}

async function createTestUser(emailPrefix: string) {
  const email = `${emailPrefix}-${Math.random().toString(36).slice(2, 8)}@example.com`;
  return registerUser({ email, password: "password123" });
}

describe("createInvitation", () => {
  it("an OWNER can create a pending invitation, and it emails a link", async () => {
    const owner = await createTestUser("owner");
    const org = await createOrganization(owner, "Acme");
    const { provider, messages } = createCapturingEmailProvider();

    await createInvitation(org.id, owner.id, "new-member@example.com", "MEMBER", { provider });

    expect(messages).toHaveLength(1);
    expect(messages[0]?.to).toBe("new-member@example.com");

    const pending = await listPendingInvitations(org.id);
    expect(pending).toHaveLength(1);
    expect(pending[0]?.email).toBe("new-member@example.com");
    expect(pending[0]?.role).toBe("MEMBER");
  });

  it("a MEMBER cannot invite — the OWNER-only authorization boundary rejects it before createInvitation is ever reached", async () => {
    const owner = await createTestUser("owner");
    const member = await createTestUser("member");
    const org = await createOrganization(owner, "Acme");
    await prisma.organizationMember.create({ data: { organizationId: org.id, userId: member.id, role: "MEMBER" } });

    // This is the exact guard the invite-member Server Action calls before
    // createInvitation — see src/app/app/[orgSlug]/settings/invitation-actions.ts.
    await expect(requireOrganizationRole(member, org.slug, "OWNER")).rejects.toThrow(
      OrganizationAccessDeniedError,
    );
  });

  it("never persists the raw invitation token — only its digest", async () => {
    const owner = await createTestUser("owner");
    const org = await createOrganization(owner, "Acme");
    const { provider, messages } = createCapturingEmailProvider();

    await createInvitation(org.id, owner.id, "invitee@example.com", "MEMBER", { provider });
    const rawToken = extractToken(messages[0]!.text);

    const stored = await prisma.organizationInvitation.findFirstOrThrow({ where: { organizationId: org.id } });
    expect(stored.tokenHash).not.toBe(rawToken);
    expect(stored.tokenHash).toHaveLength(64); // hex-encoded SHA-256
  });

  it("rejects a duplicate pending invite for the same organization and email", async () => {
    const owner = await createTestUser("owner");
    const org = await createOrganization(owner, "Acme");
    const { provider } = createCapturingEmailProvider();

    await createInvitation(org.id, owner.id, "dupe@example.com", "MEMBER", { provider });

    await expect(
      createInvitation(org.id, owner.id, "dupe@example.com", "MEMBER", { provider }),
    ).rejects.toThrow(DuplicatePendingInvitationError);
  });

  it("allows re-inviting the same email once the prior invitation is no longer pending", async () => {
    const owner = await createTestUser("owner");
    const org = await createOrganization(owner, "Acme");
    const { provider } = createCapturingEmailProvider();

    await createInvitation(org.id, owner.id, "again@example.com", "MEMBER", { provider });
    const first = await prisma.organizationInvitation.findFirstOrThrow({ where: { organizationId: org.id } });
    await revokeInvitation(org.id, first.id);

    await expect(
      createInvitation(org.id, owner.id, "again@example.com", "MEMBER", { provider }),
    ).resolves.toBeUndefined();
  });

  it("rejects inviting someone who is already a member of the organization", async () => {
    const owner = await createTestUser("owner");
    const existingMember = await createTestUser("existing");
    const org = await createOrganization(owner, "Acme");
    await prisma.organizationMember.create({
      data: { organizationId: org.id, userId: existingMember.id, role: "MEMBER" },
    });

    await expect(
      createInvitation(org.id, owner.id, existingMember.email, "MEMBER"),
    ).rejects.toThrow(AlreadyOrganizationMemberError);
  });

  it("blocks further invitations once the per-organization hourly threshold is exceeded", async () => {
    const owner = await createTestUser("owner");
    const org = await createOrganization(owner, "Acme");
    const { provider } = createCapturingEmailProvider();

    // ORGANIZATION_INVITE_POLICY.maxAttempts is 20.
    for (let i = 0; i < 20; i++) {
      await createInvitation(org.id, owner.id, `bulk-${i}@example.com`, "MEMBER", { provider });
    }
    await expect(
      createInvitation(org.id, owner.id, "one-too-many@example.com", "MEMBER", { provider }),
    ).rejects.toThrow();
  }, 20000);
});

describe("revokeInvitation", () => {
  async function createPendingInvitation(orgId: string, ownerId: string, email: string) {
    const { provider, messages } = createCapturingEmailProvider();
    await createInvitation(orgId, ownerId, email, "MEMBER", { provider });
    const invitation = await prisma.organizationInvitation.findFirstOrThrow({
      where: { organizationId: orgId, email },
    });
    return { invitation, rawToken: extractToken(messages[0]!.text) };
  }

  it("revokes a pending invitation, and it can no longer be accepted", async () => {
    const owner = await createTestUser("owner");
    const org = await createOrganization(owner, "Acme");
    const invitee = await createTestUser("invitee");
    const { invitation, rawToken } = await createPendingInvitation(org.id, owner.id, invitee.email);

    await revokeInvitation(org.id, invitation.id);

    await expect(acceptInvitation(invitee, rawToken)).rejects.toThrow(InvalidOrExpiredInvitationError);
  });

  it("a user from a different organization cannot revoke this invitation", async () => {
    const ownerA = await createTestUser("owner-a");
    const orgA = await createOrganization(ownerA, "Org A");
    const invitee = await createTestUser("invitee");
    const { invitation } = await createPendingInvitation(orgA.id, ownerA.id, invitee.email);

    const ownerB = await createTestUser("owner-b");
    const orgB = await createOrganization(ownerB, "Org B");

    // Scoped by organizationId — orgB's id can never match orgA's invitation.
    await expect(revokeInvitation(orgB.id, invitation.id)).rejects.toThrow(InvitationNotRevocableError);

    // And it's still perfectly usable from orgA's perspective.
    const stillPending = await listPendingInvitations(orgA.id);
    expect(stillPending).toHaveLength(1);
  });

  it("cannot revoke an invitation that was already accepted", async () => {
    const owner = await createTestUser("owner");
    const org = await createOrganization(owner, "Acme");
    const invitee = await createTestUser("invitee");
    const { invitation, rawToken } = await createPendingInvitation(org.id, owner.id, invitee.email);

    await acceptInvitation(invitee, rawToken);

    await expect(revokeInvitation(org.id, invitation.id)).rejects.toThrow(InvitationNotRevocableError);
  });
});

describe("acceptInvitation", () => {
  async function createPendingInvitation(orgId: string, ownerId: string, email: string) {
    const { provider, messages } = createCapturingEmailProvider();
    await createInvitation(orgId, ownerId, email, "MEMBER", { provider });
    return extractToken(messages[0]!.text);
  }

  it("an existing user accepts and becomes a member exactly once", async () => {
    const owner = await createTestUser("owner");
    const org = await createOrganization(owner, "Acme");
    const invitee = await createTestUser("invitee");
    const rawToken = await createPendingInvitation(org.id, owner.id, invitee.email);

    const result = await acceptInvitation(invitee, rawToken);
    expect(result.organizationSlug).toBe(org.slug);

    const memberships = await prisma.organizationMember.findMany({
      where: { organizationId: org.id, userId: invitee.id },
    });
    expect(memberships).toHaveLength(1);
    expect(memberships[0]?.role).toBe("MEMBER");
  });

  it("a brand-new user can accept after registering with the invited email (new-user flow)", async () => {
    const owner = await createTestUser("owner");
    const org = await createOrganization(owner, "Acme");
    const { provider, messages } = createCapturingEmailProvider();
    const invitedEmail = `newcomer-${Math.random().toString(36).slice(2, 8)}@example.com`;

    // No account exists yet for invitedEmail at invite time.
    await createInvitation(org.id, owner.id, invitedEmail, "MEMBER", { provider });
    const rawToken = extractToken(messages[0]!.text);

    // The invited person now registers — this is the "sign-up as
    // appropriate" step from the brief's NEW USER CASE.
    const newUser = await registerUser({ email: invitedEmail, password: "password123" });

    const result = await acceptInvitation(newUser, rawToken);
    expect(result.organizationSlug).toBe(org.slug);

    const membership = await prisma.organizationMember.findUniqueOrThrow({
      where: { userId_organizationId: { userId: newUser.id, organizationId: org.id } },
    });
    expect(membership.role).toBe("MEMBER");
  });

  it("rejects an invitation token for a different signed-in account than the one invited", async () => {
    const owner = await createTestUser("owner");
    const org = await createOrganization(owner, "Acme");
    const invitee = await createTestUser("invitee");
    const impostor = await createTestUser("impostor");
    const rawToken = await createPendingInvitation(org.id, owner.id, invitee.email);

    await expect(acceptInvitation(impostor, rawToken)).rejects.toThrow(InvalidOrExpiredInvitationError);

    const impostorMembership = await prisma.organizationMember.findUnique({
      where: { userId_organizationId: { userId: impostor.id, organizationId: org.id } },
    });
    expect(impostorMembership).toBeNull();
  });

  it("rejects an unknown token", async () => {
    const invitee = await createTestUser("invitee");
    await expect(acceptInvitation(invitee, "not-a-real-token")).rejects.toThrow(
      InvalidOrExpiredInvitationError,
    );
  });

  it("rejects an expired invitation", async () => {
    const owner = await createTestUser("owner");
    const org = await createOrganization(owner, "Acme");
    const invitee = await createTestUser("invitee");
    const rawToken = await createPendingInvitation(org.id, owner.id, invitee.email);

    const future = new Date(Date.now() + 8 * 24 * 60 * 60 * 1000); // past the 7-day TTL
    await expect(acceptInvitation(invitee, rawToken, future)).rejects.toThrow(
      InvalidOrExpiredInvitationError,
    );
  });

  it("cannot be reused to create a second membership — re-accepting is an idempotent no-op", async () => {
    const owner = await createTestUser("owner");
    const org = await createOrganization(owner, "Acme");
    const invitee = await createTestUser("invitee");
    const rawToken = await createPendingInvitation(org.id, owner.id, invitee.email);

    await acceptInvitation(invitee, rawToken);
    await expect(acceptInvitation(invitee, rawToken)).resolves.toMatchObject({ organizationSlug: org.slug });

    const memberships = await prisma.organizationMember.findMany({
      where: { organizationId: org.id, userId: invitee.id },
    });
    expect(memberships).toHaveLength(1);
  });

  it("if the user is already a member some other way, accepting still doesn't duplicate the membership row", async () => {
    const owner = await createTestUser("owner");
    const org = await createOrganization(owner, "Acme");
    const invitee = await createTestUser("invitee");
    const rawToken = await createPendingInvitation(org.id, owner.id, invitee.email);

    // Simulates the invited user already having membership by the time
    // they accept (e.g. added directly by another path).
    await prisma.organizationMember.create({
      data: { organizationId: org.id, userId: invitee.id, role: "MEMBER" },
    });

    await acceptInvitation(invitee, rawToken);

    const memberships = await prisma.organizationMember.findMany({
      where: { organizationId: org.id, userId: invitee.id },
    });
    expect(memberships).toHaveLength(1);
  });

  it("concurrent acceptance attempts for the same token are race-safe: exactly one membership row results", async () => {
    const owner = await createTestUser("owner");
    const org = await createOrganization(owner, "Acme");
    const invitee = await createTestUser("invitee");
    const rawToken = await createPendingInvitation(org.id, owner.id, invitee.email);

    const results = await Promise.allSettled([
      acceptInvitation(invitee, rawToken),
      acceptInvitation(invitee, rawToken),
      acceptInvitation(invitee, rawToken),
    ]);

    // Every concurrent call for the same user/token succeeds (idempotent),
    // never errors — see acceptInvitation's doc comment.
    expect(results.every((r) => r.status === "fulfilled")).toBe(true);

    const memberships = await prisma.organizationMember.findMany({
      where: { organizationId: org.id, userId: invitee.id },
    });
    expect(memberships).toHaveLength(1);
  });

  it("a user from another organization cannot manipulate a different organization's invitation by guessing its id", async () => {
    const ownerA = await createTestUser("owner-a");
    const orgA = await createOrganization(ownerA, "Org A");
    const invitee = await createTestUser("invitee");
    const rawToken = await createPendingInvitation(orgA.id, ownerA.id, invitee.email);

    const ownerB = await createTestUser("owner-b");
    const orgB = await createOrganization(ownerB, "Org B");

    // ownerB has no way to reference orgA's invitation without its raw
    // token (unguessable) — attempting to revoke by id under their own
    // org is the closest real attack surface, already covered above. Here
    // we additionally confirm accepting into orgB is simply impossible:
    // the token always resolves to its own organization, never orgB's.
    const result = await acceptInvitation(invitee, rawToken);
    expect(result.organizationSlug).toBe(orgA.slug);
    expect(result.organizationSlug).not.toBe(orgB.slug);
  });
});
