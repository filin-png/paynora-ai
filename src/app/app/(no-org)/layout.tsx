import Link from "next/link";

import { PaynoraLogo } from "@/components/brand/logo";
import { DropdownMenu, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator } from "@/components/ui/dropdown-menu";
import { ChevronDown } from "lucide-react";
import { signOut } from "@/server/auth/config";
import { requireUserForPage } from "@/server/tenancy/guards";
import { SignOutButton } from "@/components/app-shell/header";

/**
 * Shell for pages before an organization is selected (`/app`,
 * `/app/organizations/new`) — no sidebar, since there's no org context
 * yet to scope navigation to.
 *
 * Lives in the `(no-org)` route group deliberately: Next.js applies every
 * ancestor layout to every route under it, so if this were plain
 * `src/app/app/layout.tsx` it would *also* wrap `/app/[orgSlug]/*` —
 * squeezing the sidebar shell into this file's narrow centered `max-w-lg`
 * box and stacking two headers. The route group keeps `/app` and
 * `/app/organizations/new` on this branch while `/app/[orgSlug]/layout.tsx`
 * (the sidebar/header shell) stays a sibling, entirely unaffected by this
 * one. URLs are unchanged — a route group segment never appears in the
 * path.
 */
export default async function AppLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const user = await requireUserForPage();

  return (
    <div className="flex min-h-screen flex-col bg-background">
      <header className="flex h-16 shrink-0 items-center justify-between border-b border-border bg-surface px-4 sm:px-6">
        <Link href="/app">
          <PaynoraLogo size={24} />
        </Link>
        <DropdownMenu
          trigger={
            <span className="flex items-center gap-2 rounded-lg px-2 py-1.5 text-sm text-foreground hover:bg-accent-soft">
              <span className="flex size-7 items-center justify-center rounded-full bg-accent-soft text-xs font-semibold text-primary">
                {(user.name ?? user.email).slice(0, 1).toUpperCase()}
              </span>
              <span className="hidden max-w-40 truncate sm:inline">{user.name ?? user.email}</span>
              <ChevronDown className="size-4 text-muted-foreground" />
            </span>
          }
        >
          <DropdownMenuLabel>{user.email}</DropdownMenuLabel>
          <DropdownMenuSeparator />
          <DropdownMenuItem className="p-0">
            <form
              action={async () => {
                "use server";
                await signOut({ redirectTo: "/" });
              }}
            >
              <SignOutButton />
            </form>
          </DropdownMenuItem>
        </DropdownMenu>
      </header>
      <main className="flex flex-1 items-center justify-center px-4 py-12 sm:px-6">
        <div className="w-full max-w-lg">{children}</div>
      </main>
    </div>
  );
}
