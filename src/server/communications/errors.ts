/**
 * Thrown for any Communications resource (Communication, DeliveryAttempt)
 * looked up by id that either doesn't exist or doesn't belong to the
 * calling organization — same enumeration-safety reasoning as
 * ArResourceNotFoundError (src/server/ar/errors.ts) and
 * OperatorResourceNotFoundError (src/server/operator/errors.ts).
 */
export class CommunicationResourceNotFoundError extends Error {
  constructor(resource: string) {
    super(`${resource} not found`);
    this.name = "CommunicationResourceNotFoundError";
  }
}

/** An edit/send/retry was attempted from a status that doesn't allow it — see docs/communications.md#state-machine. */
export class InvalidCommunicationTransitionError extends Error {
  constructor(from: string, message: string) {
    super(`Invalid communication operation from status ${from}: ${message}`);
    this.name = "InvalidCommunicationTransitionError";
  }
}

/**
 * No communication channel could be resolved for this customer — either
 * nothing is configured, or more than one destination is configured with
 * no explicit preference to break the tie. See
 * src/server/communications/channel.ts#resolveCommunicationDestination.
 * Never a silent fallback between channels — this is the explicit,
 * catchable "blocked" outcome the brief calls for.
 */
export class CommunicationChannelBlockedError extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = "CommunicationChannelBlockedError";
  }
}

/** The ActionProposal isn't eligible for a communication to be prepared from it yet (wrong type or status). */
export class InvalidActionProposalForCommunicationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidActionProposalForCommunicationError";
  }
}

/** Subject/body failed validation (length, header-injection characters, ...) — see docs/communications.md#email-security. */
export class CommunicationValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CommunicationValidationError";
  }
}
