"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

import { cn } from "@/lib/utils";

/**
 * Takes an already-rendered `icon` element, not the icon component
 * itself. A Server Component (Sidebar) can't pass a Lucide icon
 * *component reference* as a prop into this Client Component — only
 * serializable data or already-rendered elements can cross that boundary
 * (React rejects a bare function/component reference with "Only plain
 * objects can be passed..."). Rendering `<Icon />` at the call site and
 * passing the resulting element down sidesteps that entirely, and works
 * identically whether the caller is a Server Component (Sidebar) or a
 * Client Component (MobileNav).
 */
export function NavLink({
  href,
  label,
  icon,
  exact,
  onNavigate,
}: {
  href: string;
  label: string;
  icon: React.ReactNode;
  exact?: boolean;
  onNavigate?: () => void;
}) {
  const pathname = usePathname();
  const active = exact ? pathname === href : pathname === href || pathname.startsWith(`${href}/`);

  return (
    <Link
      href={href}
      onClick={onNavigate}
      aria-current={active ? "page" : undefined}
      className={cn(
        "relative flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium transition-all duration-150",
        active
          ? "border border-primary/25 bg-primary/15 text-white shadow-[0_0_0_1px_rgb(255_255_255/0.03)_inset,0_0_24px_-6px_var(--glow-primary)]"
          : "border border-transparent text-navy-muted hover:bg-white/5 hover:text-white",
      )}
    >
      {active ? (
        <span
          aria-hidden="true"
          className="absolute top-1.5 bottom-1.5 left-0 w-[3px] rounded-full bg-[linear-gradient(180deg,var(--primary-hover),var(--secondary))]"
        />
      ) : null}
      {icon}
      {label}
    </Link>
  );
}
