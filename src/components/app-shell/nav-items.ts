import {
  Building2,
  LayoutDashboard,
  Receipt,
  Settings,
  Sparkles,
  Users,
  Zap,
} from "lucide-react";

/** The single source of truth for primary navigation — sidebar (desktop) and drawer (mobile) both render from this. */
export function getNavItems(base: string) {
  return [
    { href: base, label: "Overview", icon: LayoutDashboard, exact: true },
    { href: `${base}/invoices`, label: "Invoices", icon: Receipt },
    { href: `${base}/customers`, label: "Customers", icon: Users },
    { href: `${base}/actions`, label: "Action Center", icon: Sparkles },
    { href: `${base}/automation`, label: "Automation", icon: Zap },
    { href: `${base}/settings`, label: "Settings", icon: Settings },
  ];
}

export const ORG_SWITCH_ICON = Building2;
