import Link from "next/link";
import { CheckCircle2 } from "lucide-react";

import { PaynoraLogo } from "@/components/brand/logo";

const valueProps = [
  "Live, accurate accounts receivable — no spreadsheets",
  "AI-assisted, human-approved collection reminders",
  "Automated follow-up you can turn on when you're ready",
];

/**
 * The shared premium auth shell — a navy visual panel (value proposition +
 * depth) beside a clean form panel. Collapses to form-only on mobile; see
 * docs/product-ui.md#auth for the responsive behavior.
 */
export function AuthLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="grid min-h-screen lg:grid-cols-[minmax(0,1fr)_minmax(0,1.05fr)]">
      <div className="relative hidden flex-col justify-between overflow-hidden bg-navy-950 px-12 py-10 lg:flex">
        <div
          aria-hidden="true"
          className="absolute inset-0 bg-[radial-gradient(ellipse_70%_50%_at_20%_0%,rgba(106,99,224,0.28),transparent)]"
        />
        <Link href="/" className="relative">
          <PaynoraLogo tone="dark" size={26} />
        </Link>

        <div className="relative flex flex-col gap-8">
          <div className="[perspective:1200px]">
            <div className="w-full max-w-sm rounded-xl border border-white/10 bg-navy-800/90 p-5 shadow-card-lg [transform:rotateY(6deg)_rotateX(2deg)]">
              <div className="flex items-center justify-between">
                <span className="text-xs font-medium text-navy-muted">Outstanding</span>
                <span className="rounded-full bg-warning-soft px-2 py-0.5 text-[10px] font-medium text-warning">
                  3 overdue
                </span>
              </div>
              <p className="mt-3 text-3xl font-semibold text-white">$46,820.00</p>
              <div className="mt-4 h-1.5 w-full overflow-hidden rounded-full bg-white/10">
                <div className="h-full w-2/3 rounded-full bg-primary-hover" />
              </div>
            </div>
          </div>

          <ul className="flex flex-col gap-3">
            {valueProps.map((item) => (
              <li key={item} className="flex items-start gap-2.5 text-sm text-navy-muted">
                <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-primary-hover" />
                {item}
              </li>
            ))}
          </ul>
        </div>

        <p className="relative text-xs text-navy-muted/80">
          Financial data, treated seriously — server-side authorization on every action.
        </p>
      </div>

      <div className="flex flex-1 flex-col items-center justify-center bg-background px-5 py-16 sm:px-6">
        <Link href="/" className="mb-10 lg:hidden">
          <PaynoraLogo size={24} />
        </Link>
        <div className="w-full max-w-sm">{children}</div>
      </div>
    </div>
  );
}
