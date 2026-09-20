"use server";

import { AuthError } from "next-auth";
import { z } from "zod";

import { signIn } from "@/server/auth/config";
import { InvalidOrExpiredResetTokenError, resetPassword } from "@/server/auth/password-reset";

export type ResetPasswordFormState = { message: string; tone: "success" | "danger" } | null;

export async function resetPasswordAction(
  _prevState: ResetPasswordFormState,
  formData: FormData,
): Promise<ResetPasswordFormState> {
  const token = String(formData.get("token") ?? "");
  const password = String(formData.get("password") ?? "");

  if (!token) {
    return { message: "This password reset link is invalid or has expired.", tone: "danger" };
  }

  let email: string;
  try {
    email = await resetPassword(token, password);
  } catch (error) {
    if (error instanceof InvalidOrExpiredResetTokenError) {
      return { message: error.message, tone: "danger" };
    }
    if (error instanceof z.ZodError) {
      return { message: error.issues[0]?.message ?? "Invalid password.", tone: "danger" };
    }
    throw error;
  }

  try {
    await signIn("credentials", { email, password, redirectTo: "/app" });
    return null;
  } catch (error) {
    if (error instanceof AuthError) {
      // Password was reset either way — only the automatic sign-in step
      // failed, so send them to sign in manually instead of surfacing an
      // opaque error for a reset that actually succeeded.
      return {
        message: "Your password has been reset. You can now sign in with your new password.",
        tone: "success",
      };
    }
    throw error;
  }
}
