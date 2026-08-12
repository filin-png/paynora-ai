import { AuthLayout } from "@/components/auth/auth-layout";
import { SignInForm } from "./sign-in-form";

function safeCallbackUrl(rawCallbackUrl: string | string[] | undefined): string {
  const value = Array.isArray(rawCallbackUrl) ? rawCallbackUrl[0] : rawCallbackUrl;
  return value && value.startsWith("/") && !value.startsWith("//") ? value : "/app";
}

export default async function SignInPage({
  searchParams,
}: {
  searchParams: Promise<{ callbackUrl?: string | string[] }>;
}) {
  const { callbackUrl } = await searchParams;

  return (
    <AuthLayout>
      <SignInForm callbackUrl={safeCallbackUrl(callbackUrl)} />
    </AuthLayout>
  );
}
