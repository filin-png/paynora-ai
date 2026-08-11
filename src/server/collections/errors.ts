/**
 * Thrown for any collections resource (CollectionPolicy, CollectionSequence,
 * CollectionStepExecution) looked up by id that either doesn't exist or
 * doesn't belong to the calling organization — same enumeration-safety
 * reasoning as ArResourceNotFoundError/OperatorResourceNotFoundError.
 */
export class CollectionsResourceNotFoundError extends Error {
  constructor(resource: string) {
    super(`${resource} not found`);
    this.name = "CollectionsResourceNotFoundError";
  }
}

/** Thrown when a sequence action (pause/resume/stop) is attempted from a status that doesn't allow it. */
export class InvalidSequenceTransitionError extends Error {
  constructor(from: string, action: string) {
    super(`Cannot ${action} a collection sequence in status ${from}`);
    this.name = "InvalidSequenceTransitionError";
  }
}
