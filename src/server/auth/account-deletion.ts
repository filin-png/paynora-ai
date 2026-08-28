import { randomBytes } from "node:crypto";

import { prisma } from "@/server/db/client";
import { hashPassword } from "./password";

/**
 * Real account deletion foundation (Phase 15A, Settings -> Privacy) — see
 * docs/privacy-policy.md#17-data-deletion and docs/data-retention.md for
 * the full reasoning. Deliberately **anonymizes in place, never deletes
 * the `User` row**: every foreign key that references this user's id
 * (OrganizationMember, ActionProposal.decidedByUserId,
 * CollectionPolicy.autoSendEnabledByUserId, ...) stays valid — nothing is
 * ever orphaned, and organization-owned financial data (which lives on
 * `organizationId`, never `userId`) is completely untouched.
 *
 * The account becomes permanently unusable: `email` is overwritten with
 * an unguessable, unique placeholder (so the real email is freed up and
 * the account can never be found or signed into again), and
 * `passwordHash` is replaced with a hash of random bytes nobody — not
 * even PAYNORA — ever knows, so the pre-deletion password can never
 * authenticate again either.
 */
export async function anonymizeUserAccount(userId: string): Promise<void> {
  const anonymizedEmail = `deleted-${userId}-${randomBytes(8).toString("hex")}@deleted.paynora.invalid`;
  const unusablePasswordHash = await hashPassword(randomBytes(32).toString("hex"));

  await prisma.user.update({
    where: { id: userId },
    data: { email: anonymizedEmail, name: null, passwordHash: unusablePasswordHash },
  });
}

export type AccountDeletionWarning = {
  /** Organizations where this user is the only OWNER — deleting leaves the organization with no administrator, regardless of how many non-owner members remain. */
  soleOwnerOfOrganizations: { id: string; name: string }[];
};

/**
 * Informational only — never blocks `anonymizeUserAccount`. Whether to
 * proceed despite being a sole owner is the user's own choice; see this
 * module's doc comment and docs/privacy-policy.md#17-data-deletion for
 * why this is a warning, not a hard block.
 */
export async function getAccountDeletionWarnings(userId: string): Promise<AccountDeletionWarning> {
  const ownedMemberships = await prisma.organizationMember.findMany({
    where: { userId, role: "OWNER" },
    include: {
      organization: {
        select: {
          id: true,
          name: true,
          members: { where: { role: "OWNER" }, select: { userId: true } },
        },
      },
    },
  });

  const soleOwnerOfOrganizations = ownedMemberships
    .filter((membership) => membership.organization.members.every((owner) => owner.userId === userId))
    .map((membership) => ({ id: membership.organization.id, name: membership.organization.name }));

  return { soleOwnerOfOrganizations };
}
