"use client";

import * as React from "react";
import Link from "next/link";
import { Menu, X } from "lucide-react";

import { PaynoraLogo } from "@/components/brand/logo";
import { en } from "@/lib/i18n/dictionaries/en";
import type { Dictionary } from "@/lib/i18n";
import { getNavItems } from "./nav-items";
import { NavLink } from "./nav-link";

export function MobileNav({
  orgSlug,
  orgName,
  dict = en,
}: {
  orgSlug: string;
  orgName: string;
  dict?: Dictionary;
}) {
  const [open, setOpen] = React.useState(false);
  const navItems = getNavItems(`/app/${orgSlug}`, dict.nav);

  React.useEffect(() => {
    if (!open) return;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = "";
    };
  }, [open]);

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-label={dict.common.openNavigation}
        aria-expanded={open}
        className="flex size-9 items-center justify-center rounded-md text-foreground lg:hidden"
      >
        <Menu className="size-5" />
      </button>

      {open ? (
        <div className="fixed inset-0 z-40 lg:hidden">
          <div className="absolute inset-0 bg-navy-950/70 backdrop-blur-sm" onClick={() => setOpen(false)} aria-hidden="true" />
          <div className="absolute inset-y-0 left-0 flex w-72 flex-col border-r border-white/[0.06] bg-navy-900 shadow-card-lg">
            <div className="flex h-16 items-center justify-between px-5">
              <PaynoraLogo tone="dark" size={24} />
              <button
                type="button"
                onClick={() => setOpen(false)}
                aria-label={dict.common.closeNavigation}
                className="flex size-9 items-center justify-center rounded-md text-white/80 hover:text-white"
              >
                <X className="size-5" />
              </button>
            </div>
            <div className="mx-3 mb-3 rounded-lg bg-white/5 px-3 py-2.5">
              <p className="truncate text-sm font-medium text-white">{orgName}</p>
            </div>
            <nav className="flex flex-1 flex-col gap-0.5 px-3">
              {navItems.map(({ icon: Icon, ...item }) => (
                <NavLink
                  key={item.href}
                  {...item}
                  icon={<Icon className="size-[18px] shrink-0" />}
                  onNavigate={() => setOpen(false)}
                />
              ))}
            </nav>
            <div className="p-3">
              <Link
                href="/app"
                onClick={() => setOpen(false)}
                className="flex items-center gap-2 rounded-lg px-3 py-2 text-xs text-navy-muted hover:bg-white/5 hover:text-white"
              >
                {dict.common.switchOrganization}
              </Link>
            </div>
          </div>
        </div>
      ) : null}
    </>
  );
}
