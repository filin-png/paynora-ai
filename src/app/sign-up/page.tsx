import { AuthLayout } from "@/components/auth/auth-layout";
import { SignUpForm } from "./sign-up-form";

function safeCallbackUrl(rawCallbackUrl: string | string[] | undefined): string {
  const value = Array.isArray(rawCallbackUrl) ? rawCallbackUrl[0] : rawCallbackUrl;
  return value && value.startsWith("/") && !value.startsWith("//") ? value : "/app";
}

export default async function SignUpPage({
  searchParams,
}: {
  searchParams: Promise<{ callbackUrl?: string | string[] }>;
}) {
  const { callbackUrl } = await searchParams;

  return (
    <AuthLayout>
      <SignUpForm callbackUrl={safeCallbackUrl(callbackUrl)} />
    </AuthLayout>
  );
}
