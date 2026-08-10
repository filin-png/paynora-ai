"use server";

import { AuthError } from "next-auth";
import { z } from "zod";

import { signIn } from "@/server/auth/config";
import { EmailAlreadyRegisteredError, registerUser } from "@/server/auth/users";

export type SignUpFormState = { error: string } | null;

export async function signUpAction(
  _prevState: SignUpFormState,
  formData: FormData,
): Promise<SignUpFormState> {
  const email = String(formData.get("email") ?? "");
  const password = String(formData.get("password") ?? "");
  const name = String(formData.get("name") ?? "");

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
    await signIn("credentials", { email, password, redirectTo: "/app" });
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
