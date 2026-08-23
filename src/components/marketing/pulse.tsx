import { cn } from "@/lib/utils";

/**
 * "The Pulse" — PAYNORA's signature live-data motif (see
 * docs/product-ui.md#design-system). `PulseDot` replaces a generic
 * `animate-pulse` dot with a felt ring pulse; `PulseLine` is the
 * heartbeat-style trace used behind the landing hero. Both reuse the
 * `paynora-pulse-*` keyframes in globals.css — one signature, defined once.
 */
export function PulseDot({ className }: { className?: string }) {
  return (
    <span className={cn("relative inline-flex size-2.5 shrink-0", className)} aria-hidden="true">
      <span className="absolute inset-0.5 rounded-full bg-success" />
      <span className="absolute inset-0 rounded-full border-[1.5px] border-success motion-safe:animate-[paynora-pulse-ring_1.8s_cubic-bezier(.4,0,.3,1)_infinite]" />
    </span>
  );
}

const PULSE_TRACE =
  "M0,70 L140,70 L165,70 L180,20 L200,120 L220,70 L400,70 L425,70 L440,20 L460,120 L480,70 L800,70";

export function PulseLine({ className }: { className?: string }) {
  return (
    <div className={cn("pointer-events-none absolute overflow-hidden", className)} aria-hidden="true">
      <svg viewBox="0 0 800 140" preserveAspectRatio="none" className="absolute top-1/2 left-0 h-full w-[200%] -translate-y-1/2">
        <defs>
          <linearGradient id="paynora-pulse-grad" x1="0" y1="0" x2="1" y2="0">
            <stop offset="0%" stopColor="var(--primary)" stopOpacity="0" />
            <stop offset="45%" stopColor="var(--primary-hover)" stopOpacity="0.9" />
            <stop offset="55%" stopColor="var(--accent-cyan)" stopOpacity="0.9" />
            <stop offset="100%" stopColor="var(--secondary)" stopOpacity="0" />
          </linearGradient>
        </defs>
        <path
          d={PULSE_TRACE}
          fill="none"
          stroke="url(#paynora-pulse-grad)"
          strokeWidth="1.6"
          strokeLinecap="round"
          strokeLinejoin="round"
          className="motion-safe:animate-[paynora-pulse-travel_6s_linear_infinite]"
          style={{ filter: "drop-shadow(0 0 10px rgba(139,92,246,0.55))" }}
        />
        <path
          d={PULSE_TRACE}
          fill="none"
          stroke="url(#paynora-pulse-grad)"
          strokeWidth="1.6"
          strokeLinecap="round"
          strokeLinejoin="round"
          transform="translate(800,0)"
          className="motion-safe:animate-[paynora-pulse-travel_6s_linear_infinite]"
          style={{ filter: "drop-shadow(0 0 10px rgba(139,92,246,0.55))" }}
        />
      </svg>
    </div>
  );
}
