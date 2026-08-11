/**
 * Thrown for any Operator resource (BusinessEvent, OperatorInsight,
 * ActionProposal) looked up by id that either doesn't exist or doesn't
 * belong to the calling organization — same enumeration-safety reasoning
 * as ArResourceNotFoundError (src/server/ar/errors.ts) and
 * OrganizationAccessDeniedError (src/server/tenancy/errors.ts).
 */
export class OperatorResourceNotFoundError extends Error {
  constructor(resource: string) {
    super(`${resource} not found`);
    this.name = "OperatorResourceNotFoundError";
  }
}

/**
 * Thrown when an approval/dismissal is attempted from a status other than
 * PENDING (and isn't a same-state idempotent no-op) — e.g. dismissing an
 * already-approved proposal. Approving/dismissing is a one-way door by
 * design; see src/server/operator/approval.ts.
 */
export class InvalidActionProposalTransitionError extends Error {
  constructor(from: string, to: string) {
    super(`Cannot move an action proposal from ${from} to ${to}`);
    this.name = "InvalidActionProposalTransitionError";
  }
}
