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

/** The customer has no email address on file — cannot draft or send a reminder. */
export class MissingCustomerEmailError extends Error {
  constructor() {
    super("Customer has no email address on file");
    this.name = "MissingCustomerEmailError";
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
