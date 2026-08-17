"use server";

import { z } from "zod";

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

  try {
    await resetPassword(token, password);
  } catch (error) {
    if (error instanceof InvalidOrExpiredResetTokenError) {
      return { message: error.message, tone: "danger" };
    }
    if (error instanceof z.ZodError) {
      return { message: error.issues[0]?.message ?? "Invalid password.", tone: "danger" };
    }
    throw error;
  }

  return {
    message: "Your password has been reset. You can now sign in with your new password.",
    tone: "success",
  };
}
