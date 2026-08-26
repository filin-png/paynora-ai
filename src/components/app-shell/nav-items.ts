import {
  Building2,
  LayoutDashboard,
  Receipt,
  Settings,
  Sparkles,
  Users,
  WalletIcon,
  Zap,
} from "lucide-react";

import { en } from "@/lib/i18n/dictionaries/en";
import type { Dictionary } from "@/lib/i18n";

/** The single source of truth for primary navigation — sidebar (desktop) and drawer (mobile) both render from this. `nav` defaults to English so every existing call site keeps working unchanged; pass a translated dictionary's `nav` to localize. */
export function getNavItems(base: string, nav: Dictionary["nav"] = en.nav) {
  return [
    { href: base, label: nav.overview, icon: LayoutDashboard, exact: true },
    { href: `${base}/invoices`, label: nav.invoices, icon: Receipt },
    { href: `${base}/customers`, label: nav.customers, icon: Users },
    { href: `${base}/actions`, label: nav.actionCenter, icon: Sparkles },
    { href: `${base}/automation`, label: nav.automation, icon: Zap },
    { href: `${base}/wallet`, label: nav.wallet, icon: WalletIcon },
    { href: `${base}/settings`, label: nav.settings, icon: Settings },
  ];
}

export const ORG_SWITCH_ICON = Building2;
