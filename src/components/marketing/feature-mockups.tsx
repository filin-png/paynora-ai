import { CheckCheck, PenLine, X } from "lucide-react";

/**
 * Illustrative product mockups for the landing page's feature-spotlight
 * sections — deliberately generic sample data, styled with the same
 * visual language (Badge/Card tokens) as the real authenticated Action
 * Center and Dashboard so the promise matches the product, without being
 * a literal screenshot. See docs/product-ui.md#landing-redesign.
 */
export function ActionCenterMockup() {
  return (
    <div className="reveal-on-scroll rounded-2xl border border-border bg-surface p-4 shadow-card-md sm:p-5">
      <div className="flex items-center justify-between border-b border-border pb-3">
        <p className="text-xs font-medium text-muted-foreground">Pending your review</p>
        <span className="rounded-full bg-warning-soft px-2 py-0.5 text-[10px] font-medium text-warning">
          1 awaiting a decision
        </span>
      </div>
      <div className="mt-4 flex flex-col gap-3">
        <div className="rounded-xl border border-border bg-background p-4">
          <div className="flex items-center gap-2">
            <span className="rounded-full bg-warning-soft px-2 py-0.5 text-[10px] font-medium text-warning">
              Medium priority
            </span>
            <span className="text-xs font-medium text-foreground">Send a payment reminder</span>
          </div>
          <p className="mt-2 text-xs leading-5 text-muted">
            Invoice INV-0087 for Globex Logistics is 9 days overdue — $3,240.00 outstanding.
          </p>
          <div className="mt-3 flex gap-2">
            <span className="inline-flex items-center gap-1 rounded-md border border-border-strong px-2.5 py-1 text-[11px] font-medium text-muted">
              <X className="size-3" /> Dismiss
            </span>
            <span className="inline-flex items-center gap-1 rounded-md border border-border-strong px-2.5 py-1 text-[11px] font-medium text-muted">
              <PenLine className="size-3" /> Edit
            </span>
            <span className="inline-flex items-center gap-1 rounded-md bg-primary px-2.5 py-1 text-[11px] font-medium text-primary-foreground">
              <CheckCheck className="size-3" /> Approve
            </span>
          </div>
        </div>
        <div className="flex items-center justify-between rounded-xl border border-border bg-background px-4 py-3">
          <span className="text-xs text-muted">INV-0071 — Initech Consulting</span>
          <span className="rounded-full bg-success-soft px-2 py-0.5 text-[10px] font-medium text-success">
            Approved — review &amp; send
          </span>
        </div>
      </div>
    </div>
  );
}

const receivableBuckets = [
  { label: "Current", value: 62, tone: "bg-success" },
  { label: "1–30d", value: 21, tone: "bg-warning" },
  { label: "31–60d", value: 11, tone: "bg-warning" },
  { label: "60d+", value: 6, tone: "bg-danger" },
] as const;

export function DashboardMockup() {
  return (
    <div className="reveal-on-scroll rounded-2xl border border-border bg-surface p-4 shadow-card-md sm:p-5">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        {[
          { label: "Outstanding", value: "$186,420" },
          { label: "Overdue", value: "$46,110" },
          { label: "Open invoices", value: "34" },
          { label: "Recovered (30d)", value: "$84,200" },
        ].map((metric) => (
          <div key={metric.label} className="rounded-xl border border-border bg-background p-3">
            <p className="text-[10px] font-medium text-muted-foreground">{metric.label}</p>
            <p className="mt-1 font-[family-name:var(--font-landing-mono)] text-base font-medium text-foreground">
              {metric.value}
            </p>
          </div>
        ))}
      </div>
      <div className="mt-4 rounded-xl border border-border bg-background p-4">
        <p className="text-[11px] font-medium text-muted-foreground">Receivables by age</p>
        <div className="mt-3 flex h-3 w-full overflow-hidden rounded-full bg-muted/20">
          {receivableBuckets.map((bucket) => (
            <span key={bucket.label} className={bucket.tone} style={{ width: `${bucket.value}%` }} />
          ))}
        </div>
        <div className="mt-2.5 flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-muted">
          {receivableBuckets.map((bucket) => (
            <span key={bucket.label}>
              {bucket.label} · {bucket.value}%
            </span>
          ))}
        </div>
      </div>
    </div>
  );
}
