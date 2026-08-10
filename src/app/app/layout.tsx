import Link from "next/link";

import { signOut } from "@/server/auth/config";
import { requireUserForPage } from "@/server/tenancy/guards";

export default async function AppLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const user = await requireUserForPage();

  return (
    <div className="flex flex-1 flex-col">
      <header className="border-b border-border">
        <div className="mx-auto flex w-full max-w-5xl items-center justify-between px-6 py-4">
          <Link href="/app" className="text-lg font-semibold tracking-tight">
            PAYNORA<span className="text-primary"> AI</span>
          </Link>
          <div className="flex items-center gap-4 text-sm text-muted">
            <span>{user.email}</span>
            <form
              action={async () => {
                "use server";
                await signOut({ redirectTo: "/" });
              }}
            >
              <button type="submit" className="font-medium text-foreground hover:underline">
                Sign out
              </button>
            </form>
          </div>
        </div>
      </header>
      <main className="mx-auto w-full max-w-5xl flex-1 px-6 py-10">{children}</main>
    </div>
  );
}
