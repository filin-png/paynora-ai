import { auth } from "./config";
import type { SessionUser } from "@/server/tenancy/types";

/**
 * Resolves the current request's authenticated user from the Auth.js
 * session, or null if there isn't one. This is the only place that reads
 * cookies/headers for identity — everything downstream (tenancy checks,
 * pages, actions) takes a plain SessionUser value, which keeps that code
 * testable without mocking Next.js request internals.
 */
export async function getSessionUser(): Promise<SessionUser | null> {
  const session = await auth();
  if (!session?.user?.id || !session.user.email) return null;
  return {
    id: session.user.id,
    email: session.user.email,
    name: session.user.name ?? null,
  };
}
