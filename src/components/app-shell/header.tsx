import { ChevronDown, LogOut } from "lucide-react";

import { LocaleSwitcher } from "@/components/locale-switcher";
import { DropdownMenu, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator } from "@/components/ui/dropdown-menu";
import { en } from "@/lib/i18n/dictionaries/en";
import type { Dictionary } from "@/lib/i18n";
import type { Locale } from "@/lib/i18n/config";
import { MobileNav } from "./mobile-nav";

export function Header({
  orgSlug,
  orgName,
  userEmail,
  userName,
  signOutForm,
  locale = "en",
  dict = en,
}: {
  orgSlug: string;
  orgName: string;
  userEmail: string;
  userName: string | null;
  signOutForm: React.ReactNode;
  locale?: Locale;
  dict?: Dictionary;
}) {
  return (
    <header className="glass-surface flex h-16 shrink-0 items-center justify-between border-x-0 border-t-0 px-4 sm:px-6">
      <div className="flex items-center gap-3">
        <MobileNav orgSlug={orgSlug} orgName={orgName} dict={dict} />
        <span className="hidden text-sm font-medium text-muted lg:inline">{orgName}</span>
      </div>

      <div className="flex items-center gap-3">
        <LocaleSwitcher locale={locale} />
        <DropdownMenu
          trigger={
            <span className="flex items-center gap-2 rounded-lg px-2 py-1.5 text-sm text-foreground hover:bg-accent-soft">
              <span className="flex size-7 items-center justify-center rounded-full bg-accent-soft text-xs font-semibold text-primary">
                {(userName ?? userEmail).slice(0, 1).toUpperCase()}
              </span>
              <span className="hidden max-w-40 truncate sm:inline">{userName ?? userEmail}</span>
              <ChevronDown className="size-4 text-muted-foreground" />
            </span>
          }
        >
          <DropdownMenuLabel>{userEmail}</DropdownMenuLabel>
          <DropdownMenuSeparator />
          <DropdownMenuItem className="p-0">{signOutForm}</DropdownMenuItem>
        </DropdownMenu>
      </div>
    </header>
  );
}

export function SignOutButton() {
  return (
    <button
      type="submit"
      className="flex w-full items-center gap-2 rounded-md px-2.5 py-2 text-left text-sm text-foreground hover:bg-accent-soft"
    >
      <LogOut className="size-4" />
      Sign out
    </button>
  );
}
