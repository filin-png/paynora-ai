"use server";

import { AuthError } from "next-auth";

import { signIn } from "@/server/auth/config";

export type SignInFormState = { error: string } | null;

function safeCallbackUrl(rawCallbackUrl: FormDataEntryValue | null): string {
  const value = typeof rawCallbackUrl === "string" ? rawCallbackUrl : "";
  // Only ever redirect to a relative, in-app path — never follow a
  // caller-supplied absolute URL (open-redirect prevention).
  return value.startsWith("/") && !value.startsWith("//") ? value : "/app";
}

export async function signInAction(
  _prevState: SignInFormState,
  formData: FormData,
): Promise<SignInFormState> {
  const email = String(formData.get("email") ?? "");
  const password = String(formData.get("password") ?? "");
  const redirectTo = safeCallbackUrl(formData.get("callbackUrl"));

  try {
    await signIn("credentials", { email, password, redirectTo });
    return null;
  } catch (error) {
    if (error instanceof AuthError) {
      // Deliberately generic: never reveal whether the email exists.
      return { error: "Invalid email or password." };
    }
    throw error;
  }
}
