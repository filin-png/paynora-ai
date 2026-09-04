import Link from "next/link";
import { ArrowLeft } from "lucide-react";

import { PaynoraLogo } from "@/components/brand/logo";
import { cn } from "@/lib/utils";
import { buttonVariants } from "@/components/ui/button";

const LEGAL_NAV = [
  { href: "/privacy-policy", label: "Privacy Policy" },
  { href: "/terms-of-service", label: "Terms of Service" },
  { href: "/data-retention", label: "Data Retention" },
  { href: "/subprocessors", label: "Subprocessors" },
];

/**
 * Shared chrome for the four public legal pages (Phase 17) — a minimal
 * header/footer, not the full marketing landing shell, since these are
 * reference documents someone lands on directly (from a footer link, an
 * email, a due-diligence request) rather than a marketing surface.
 */
export function LegalPageShell({ activeHref, children }: { activeHref: string; children: React.ReactNode }) {
  return (
    <div className="flex min-h-screen flex-col bg-background">
      <header className="border-b border-border">
        <div className="mx-auto flex w-full max-w-3xl items-center justify-between px-5 py-5 sm:px-6">
          <Link href="/" className="inline-flex items-center gap-2">
            <PaynoraLogo size={22} />
          </Link>
          <Link href="/" className={cn(buttonVariants({ variant: "outline", size: "sm" }))}>
            <ArrowLeft className="size-3.5" />
            Back to home
          </Link>
        </div>
      </header>

      <main className="mx-auto w-full max-w-3xl flex-1 px-5 py-10 sm:px-6">
        <nav className="mb-8 flex flex-wrap gap-2 border-b border-border pb-6 text-xs">
          {LEGAL_NAV.map((item) => (
            <Link
              key={item.href}
              href={item.href}
              className={cn(
                "rounded-full border px-3 py-1.5 font-medium transition-colors",
                item.href === activeHref
                  ? "border-primary/40 bg-accent-soft text-primary"
                  : "border-border text-muted hover:text-foreground",
              )}
            >
              {item.label}
            </Link>
          ))}
        </nav>
        <article className="legal-content">{children}</article>
      </main>

      <footer className="border-t border-border">
        <div className="mx-auto flex w-full max-w-3xl items-center justify-between px-5 py-6 text-xs text-muted sm:px-6">
          <span>© {new Date().getFullYear()} PAYNORA</span>
          <Link href="/" className="hover:text-foreground">
            paynora.ai
          </Link>
        </div>
      </footer>
    </div>
  );
}
