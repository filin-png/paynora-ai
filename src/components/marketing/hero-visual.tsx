import { ArrowUpRight, Clock3, Sparkles } from "lucide-react";

/**
 * Illustrative marketing composition — deliberately generic sample values,
 * not real user data (public, unauthenticated landing page only). One
 * base "Outstanding Receivables" layer plus four floating satellite
 * cards (invoice, suggested action, cash recovered, collection timeline)
 * — the product's actual mental model, not a dashboard screenshot. Pure
 * CSS 3D transforms/gradients/keyframes, no canvas/WebGL/animation
 * library. See docs/product-ui.md#landing-redesign.
 */
export function HeroVisual() {
  return (
    <div className="relative mx-auto w-full max-w-md lg:mx-0 lg:max-w-none" aria-hidden="true">
      {/* Ambient glow field behind the composition */}
      <div
        className="absolute -inset-x-10 -inset-y-16 -z-10 opacity-70 motion-safe:animate-[paynora-ambient-drift_14s_ease-in-out_infinite]"
        style={{
          background:
            "radial-gradient(closest-side, rgba(106,99,224,0.35), transparent 70%)",
        }}
      />
      {/* Fine grid, fades toward the edges */}
      <div
        className="absolute -inset-6 -z-10 rounded-[2rem] opacity-[0.15]"
        style={{
          backgroundImage:
            "linear-gradient(rgba(255,255,255,0.5) 1px, transparent 1px), linear-gradient(90deg, rgba(255,255,255,0.5) 1px, transparent 1px)",
          backgroundSize: "28px 28px",
          maskImage: "radial-gradient(closest-side, black 55%, transparent 100%)",
          WebkitMaskImage: "radial-gradient(closest-side, black 55%, transparent 100%)",
        }}
      />

      {/* Mobile/tablet: flat stacked composition, no perspective, no clipping */}
      <div className="relative flex flex-col gap-3 lg:hidden">
        <OutstandingCard />
        <div className="grid grid-cols-2 gap-3">
          <InvoiceCard compact />
          <ActionCard compact />
        </div>
      </div>

      {/* Desktop: layered depth composition */}
      <div className="relative hidden h-[26rem] [perspective:1600px] lg:block">
        <div className="absolute inset-0 [transform-style:preserve-3d] [transform:rotateY(-8deg)_rotateX(5deg)]">
          <div className="absolute left-1/2 top-1/2 w-72 -translate-x-1/2 -translate-y-1/2 [transform:translateZ(0px)]">
            <OutstandingCard />
          </div>

          <div
            className="absolute left-0 top-2 w-60 [transform:translateZ(90px)] motion-safe:animate-[paynora-float_9s_ease-in-out_infinite]"
          >
            <InvoiceCard />
          </div>

          <div
            className="absolute right-[-1rem] top-10 w-56 [transform:translateZ(130px)] motion-safe:animate-[paynora-float-slow_11s_ease-in-out_infinite]"
            style={{ animationDelay: "-3s" }}
          >
            <ActionCard />
          </div>

          <div
            className="absolute bottom-2 left-6 w-52 [transform:translateZ(70px)] motion-safe:animate-[paynora-float_10s_ease-in-out_infinite]"
            style={{ animationDelay: "-5s" }}
          >
            <CashRecoveredCard />
          </div>

          <div
            className="absolute bottom-[-0.5rem] right-6 w-48 [transform:translateZ(150px)] motion-safe:animate-[paynora-float-slow_8s_ease-in-out_infinite]"
            style={{ animationDelay: "-1.5s" }}
          >
            <TimelineChip />
          </div>
        </div>
      </div>
    </div>
  );
}

function OutstandingCard() {
  return (
    <div className="rounded-2xl border border-white/10 bg-navy-800/95 p-5 shadow-card-lg backdrop-blur">
      <p className="text-xs font-medium text-navy-muted">Outstanding receivables</p>
      <p className="mt-2 font-[family-name:var(--font-landing-mono)] text-3xl font-medium tracking-tight text-white">
        $186,420
      </p>
      <p className="mt-1 text-xs text-navy-muted">Across 34 open invoices · 2 currencies</p>
      <div className="mt-4 h-1.5 w-full overflow-hidden rounded-full bg-white/10">
        <div className="h-full w-3/4 rounded-full bg-primary-hover" />
      </div>
      <div className="mt-2 flex items-center justify-between text-[11px] text-navy-muted">
        <span>On track</span>
        <span>$46,110 overdue</span>
      </div>
    </div>
  );
}

function InvoiceCard({ compact = false }: { compact?: boolean }) {
  return (
    <div className={"rounded-xl border border-white/10 bg-navy-700/90 p-4 shadow-card-lg backdrop-blur" + (compact ? "" : "")}>
      <div className="flex items-center justify-between">
        <span className="font-[family-name:var(--font-landing-mono)] text-[11px] text-navy-muted">INV-1048</span>
        <span className="rounded-full bg-danger-soft px-2 py-0.5 text-[10px] font-medium text-danger">Overdue 12d</span>
      </div>
      <p className="mt-2.5 font-[family-name:var(--font-landing-mono)] text-lg font-medium text-white">$12,450.00</p>
      <p className="mt-1 text-[11px] text-navy-muted">Acme Manufacturing Ltd</p>
    </div>
  );
}

function ActionCard({ compact = false }: { compact?: boolean }) {
  return (
    <div className={"rounded-xl border border-white/10 bg-navy-700/90 p-4 shadow-card-lg backdrop-blur" + (compact ? "" : "")}>
      <div className="flex items-center gap-1.5">
        <Sparkles className="size-3.5 text-primary-hover" />
        <span className="text-[11px] font-medium text-white">Suggested action</span>
      </div>
      <p className="mt-2 text-[11px] leading-5 text-navy-muted">
        Send a firm reminder — 3rd follow-up, 12 days overdue.
      </p>
      <div className="mt-3 flex gap-1.5">
        <span className="rounded-md bg-primary px-2 py-1 text-[10px] font-medium text-white">Approve</span>
        <span className="rounded-md border border-white/15 px-2 py-1 text-[10px] font-medium text-navy-muted">Edit</span>
      </div>
    </div>
  );
}

function CashRecoveredCard() {
  return (
    <div className="rounded-xl border border-white/10 bg-navy-800/90 p-4 shadow-card-lg backdrop-blur">
      <div className="flex items-center gap-1.5 text-navy-muted">
        <ArrowUpRight className="size-3.5 text-success" />
        <span className="text-[11px] font-medium">Recovered this month</span>
      </div>
      <p className="mt-2 font-[family-name:var(--font-landing-mono)] text-xl font-medium text-white">$84,200</p>
      <div className="mt-2 flex h-6 items-end gap-1">
        {[40, 65, 50, 80, 60, 95, 70].map((h, i) => (
          <span key={i} className="w-2 rounded-sm bg-success/70" style={{ height: `${h}%` }} />
        ))}
      </div>
    </div>
  );
}

function TimelineChip() {
  return (
    <div className="flex items-center gap-2 rounded-full border border-white/10 bg-navy-900/95 px-3.5 py-2 shadow-card-lg backdrop-blur">
      <Clock3 className="size-3.5 text-primary-hover" />
      <span className="text-[11px] font-medium text-white">Step 2 of 4</span>
      <span className="text-[11px] text-navy-muted">· follow-up sent</span>
    </div>
  );
}
