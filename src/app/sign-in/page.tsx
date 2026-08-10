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
    <div className="flex flex-1 items-center justify-center px-6 py-16">
      <SignInForm callbackUrl={safeCallbackUrl(callbackUrl)} />
    </div>
  );
}
