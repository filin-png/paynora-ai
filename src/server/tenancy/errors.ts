/** No authenticated user was provided. */
export class UnauthenticatedError extends Error {
  constructor() {
    super("Authentication required");
    this.name = "UnauthenticatedError";
  }
}

/**
 * Deliberately covers three distinct causes with one error: the
 * organization doesn't exist, the user isn't a member of it, or the user's
 * role doesn't satisfy the requirement. Returning the same outcome for all
 * three prevents an authenticated attacker from using response differences
 * to enumerate which organization slugs exist (see SECURITY.md).
 */
export class OrganizationAccessDeniedError extends Error {
  constructor() {
    super("Organization not found or access denied");
    this.name = "OrganizationAccessDeniedError";
  }
}
