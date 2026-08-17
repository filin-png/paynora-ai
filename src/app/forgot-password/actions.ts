"use server";

import { headers } from "next/headers";

import { extractClientIp } from "@/server/auth/request-ip";
import { requestPasswordReset } from "@/server/auth/password-reset";

export type ForgotPasswordFormState = { message: string; tone: "success" | "danger" } | null;

const GENERIC_MESSAGE =
  "If an account exists for that email, we've sent a link to reset the password. It expires in 1 hour.";

export async function forgotPasswordAction(
  _prevState: ForgotPasswordFormState,
  formData: FormData,
): Promise<ForgotPasswordFormState> {
  const email = String(formData.get("email") ?? "");
  if (!email.trim()) {
    return { message: "Enter your email address.", tone: "danger" };
  }

  const ip = extractClientIp(await headers());
  const outcome = await requestPasswordReset(email, ip);

  if (outcome === "rate_limited") {
    // Deliberately does not reveal whether the rate limit tripped on the
    // IP or account dimension, or why — same generic-failure principle as
    // sign-in. Doesn't reveal account existence either: the check happens
    // before any existence lookup, keyed only on the submitted email
    // string, so this message appears identically whether or not the
    // email belongs to a real account.
    return { message: "Too many requests. Please try again later.", tone: "danger" };
  }

  return { message: GENERIC_MESSAGE, tone: "success" };
}
