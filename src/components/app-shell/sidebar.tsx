import Link from "next/link";

import { PaynoraLogo } from "@/components/brand/logo";
import { getNavItems } from "./nav-items";
import { NavLink } from "./nav-link";

export function Sidebar({
  orgSlug,
  orgName,
  role,
}: {
  orgSlug: string;
  orgName: string;
  role: string;
}) {
  const navItems = getNavItems(`/app/${orgSlug}`);

  return (
    <aside className="hidden w-64 shrink-0 flex-col bg-navy-900 lg:flex">
      <div className="flex h-16 items-center px-5">
        <Link href={`/app/${orgSlug}`}>
          <PaynoraLogo tone="dark" size={24} />
        </Link>
      </div>

      <div className="mx-3 mb-3 flex items-center gap-2.5 rounded-lg bg-white/5 px-3 py-2.5">
        <span className="flex size-8 shrink-0 items-center justify-center rounded-md bg-white/10 text-xs font-semibold text-white">
          {orgName.slice(0, 2).toUpperCase()}
        </span>
        <div className="min-w-0">
          <p className="truncate text-sm font-medium text-white">{orgName}</p>
          <p className="text-xs text-navy-muted">{role === "OWNER" ? "Owner" : "Member"}</p>
        </div>
      </div>

      <nav className="flex flex-1 flex-col gap-0.5 px-3">
        {navItems.map(({ icon: Icon, ...item }) => (
          <NavLink key={item.href} {...item} icon={<Icon className="size-[18px] shrink-0" />} />
        ))}
      </nav>

      <div className="p-3">
        <Link
          href="/app"
          className="flex items-center gap-2 rounded-lg px-3 py-2 text-xs text-navy-muted transition-colors hover:bg-white/5 hover:text-white"
        >
          Switch organization
        </Link>
      </div>
    </aside>
  );
}
