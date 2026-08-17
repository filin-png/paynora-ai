# Account Recovery & Organization Invitations (Phase 11.2)

Password reset and organization member invitations, both built on a shared
token primitive and the existing `EmailProvider` abstraction — no new email
architecture, no real SMTP credentials required to exercise either flow.

## Shared token primitive

`src/server/auth/tokens.ts#generateToken` produces a 32-byte
(`crypto.randomBytes`) raw token plus its SHA-256 digest. Only the digest is
ever persisted (`PasswordResetToken.tokenHash`,
`OrganizationInvitation.tokenHash`, both `@unique`) — the raw token exists
only in the emailed link and, transiently, in the request that consumes it.
Never logged.

## Password reset

`src/server/auth/password-reset.ts`:

- `requestPasswordReset(email, ip)` — rate-limited (IP and per-account,
  `src/server/rate-limit/policies.ts`'s `PASSWORD_RESET_REQUEST_*_POLICY`),
  and returns the same `"requested"` outcome whether or not the email
  belongs to a real account. A newer request deletes any still-usable older
  token for that user (at most one active reset link per user).
- `resetPassword(token, newPassword)` — single-use and expiring
  (`PASSWORD_RESET_TOKEN_TTL_MS`, 1 hour), consumed via an atomic
  compare-and-swap (`consumedAt: null -> now`, gated on `expiresAt`) so a
  reused or expired token fails safely and concurrent submissions can't both
  succeed. Reuses `passwordSchema` (`src/server/auth/password.ts`) — the
  same rule registration uses — and the existing bcrypt hashing.

UI: `/forgot-password`, `/reset-password`, and a "Forgot password?" link on
`/sign-in`.

## Organization invitations

`src/server/tenancy/invitations.ts`:

- `createInvitation(organizationId, invitedByUserId, email, role)` —
  OWNER-only (enforced by the calling Server Action via
  `requireOrganizationRoleForPage`, not by this function itself, matching
  every other tenancy domain function). A partial unique index
  (`organization_invitations_one_pending_per_org_email`, `WHERE status =
  'PENDING'`) backs "no duplicate pending invite for the same
  organization/email" at the database level.
- `acceptInvitation(user, token)` — binds the token to the exact invited
  email address (the signed-in user's email must match), so a
  forwarded/leaked link is only usable by whoever controls that address.
  Idempotent and race-safe: the `PENDING -> ACCEPTED` transition is a
  compare-and-swap; a losing concurrent call re-reads the now-`ACCEPTED`
  invitation and treats it as a successful no-op rather than erroring or
  creating a duplicate `OrganizationMember` row.
- `revokeInvitation(organizationId, invitationId)` — OWNER-only, scoped to
  the organization; a cross-tenant or already-resolved invitation is
  rejected with the same generic error either way.

New-user case: an invitation link works before the recipient has an
account — `/invitations/accept` shows sign-in/sign-up options carrying a
`callbackUrl` back to itself; membership is only ever created after
authenticated acceptance, never automatically at sign-up.

UI: `/invitations/accept`, plus an invite form, pending-invitations list,
and revoke action in Organization Settings → Members.

## Email delivery

Both flows call `src/server/email/transactional.ts#sendTransactionalEmail`
directly against the existing `EmailProvider`/`dispatchEmail` gateway —
not the AR-specific `Communication`/`DeliveryAttempt` domain, which is
structurally tied to an invoice/customer. A failed or disabled
(`EMAIL_PROVIDER=none`) send is best-effort: the underlying token row still
exists and remains usable, and neither flow's public behavior changes based
on whether the email actually went out.

## Activity/audit

Membership changes are recorded as tenant-scoped `ActivityEvent`s
(`MEMBER_INVITED`, `MEMBER_INVITATION_REVOKED`, `MEMBER_JOINED`).
Password-reset events are not recorded there — `PasswordResetToken` has no
`organizationId` (a user can belong to zero or many organizations), so it
doesn't fit that tenant-scoped audit trail.
