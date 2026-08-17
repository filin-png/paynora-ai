"use server";

import { headers } from "next/headers";
import { AuthError } from "next-auth";
import { z } from "zod";

import { extractClientIp } from "@/server/auth/request-ip";
import { signIn } from "@/server/auth/config";
import { EmailAlreadyRegisteredError, registerUser } from "@/server/auth/users";
import { checkRateLimit } from "@/server/rate-limit/service";
import { SIGNUP_IP_POLICY } from "@/server/rate-limit/policies";

export type SignUpFormState = { error: string } | null;

const SIGNUP_IP_SCOPE = "auth:signup:ip";

function safeCallbackUrl(rawCallbackUrl: FormDataEntryValue | null): string {
  const value = typeof rawCallbackUrl === "string" ? rawCallbackUrl : "";
  // Only ever redirect to a relative, in-app path — never follow a
  // caller-supplied absolute URL (open-redirect prevention). Mirrors
  // src/app/sign-in/actions.ts's identical helper — used so a new user who
  // arrived via an invitation link ends up back on the accept-invitation
  // page after registering, instead of always landing on /app.
  return value.startsWith("/") && !value.startsWith("//") ? value : "/app";
}

export async function signUpAction(
  _prevState: SignUpFormState,
  formData: FormData,
): Promise<SignUpFormState> {
  const email = String(formData.get("email") ?? "");
  const password = String(formData.get("password") ?? "");
  const name = String(formData.get("name") ?? "");
  const redirectTo = safeCallbackUrl(formData.get("callbackUrl"));

  // Phase 9 (docs/audits/PAYNORA-AUDIT-V1-REMEDIATION.md P0-1/P2-1): bounds
  // automated mass account creation / enumeration-by-signup from one
  // source. Fails closed the same way authorize() does — an unexpected
  // error here blocks the signup rather than silently skipping the check.
  try {
    const ip = extractClientIp(await headers());
    const ipCheck = await checkRateLimit(SIGNUP_IP_SCOPE, ip, SIGNUP_IP_POLICY);
    if (!ipCheck.allowed) {
      return { error: "Too many sign-up attempts from this network. Please try again later." };
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[auth] sign-up rate limit check failed — failing closed: ${message}`);
    return { error: "Something went wrong. Please try again." };
  }

  try {
    await registerUser({ email, password, name: name || undefined });
  } catch (error) {
    if (error instanceof EmailAlreadyRegisteredError) {
      return { error: error.message };
    }
    if (error instanceof z.ZodError) {
      return { error: error.issues[0]?.message ?? "Invalid input." };
    }
    throw error;
  }

  try {
    await signIn("credentials", { email, password, redirectTo });
    return null;
  } catch (error) {
    if (error instanceof AuthError) {
      // Account was created but the automatic sign-in step failed — the
      // account itself is fine, so send them to sign in manually instead
      // of surfacing an opaque error on the form they just submitted.
      return { error: "Account created. Please sign in." };
    }
    throw error;
  }
}
