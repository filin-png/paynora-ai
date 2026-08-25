/**
 * Every domain's "resource not found" error (ArResourceNotFoundError,
 * OperatorResourceNotFoundError, CollectionsResourceNotFoundError,
 * CommunicationResourceNotFoundError) shares the same enumeration-safe
 * design: a cross-tenant id fails identically to a nonexistent one. None
 * of them were previously converted into a real Next.js 404 anywhere —
 * an invalid invoice/customer/proposal id crashed into the generic error
 * boundary instead of `not-found.tsx`. This is the one place that knows
 * the full set of "not found" error class names, so every detail page
 * can call `notFound()` consistently instead of re-deriving the list.
 */
const RESOURCE_NOT_FOUND_ERROR_NAMES = new Set([
  "ArResourceNotFoundError",
  "OperatorResourceNotFoundError",
  "CollectionsResourceNotFoundError",
  "CommunicationResourceNotFoundError",
  "WalletResourceNotFoundError",
]);

export function isResourceNotFoundError(error: unknown): boolean {
  return error instanceof Error && RESOURCE_NOT_FOUND_ERROR_NAMES.has(error.name);
}
