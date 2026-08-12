import { cn } from "@/lib/utils";

/**
 * The PAYNORA mark — an original geometric mark (three ascending bars plus
 * a rising trend line), not a copy of any third-party logo. Built as
 * inline SVG so it scales cleanly from a 16px favicon to a large landing
 * hero without a raster asset. See docs/product-ui.md#brand.
 */
export function PaynoraMark({ className, size = 28 }: { className?: string; size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 32 32"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      className={className}
      role="img"
      aria-label="PAYNORA"
    >
      <rect width="32" height="32" rx="8" fill="var(--navy-900)" />
      <rect x="8" y="18" width="3.4" height="7" rx="1.4" fill="var(--navy-muted)" />
      <rect x="14.3" y="13" width="3.4" height="12" rx="1.4" fill="#c7cdea" />
      <rect x="20.6" y="8" width="3.4" height="17" rx="1.4" fill="#ffffff" />
      <path
        d="M8 15.5L14.5 10.5L20.5 12.5L25 6.5"
        stroke="var(--primary-hover, #6a63e0)"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <circle cx="25" cy="6.5" r="1.9" fill="var(--primary-hover, #6a63e0)" />
    </svg>
  );
}

/**
 * Full wordmark — mark + "PAYNORA" text. Used in the sidebar header, auth
 * pages, and landing nav. `tone="light"` (default) renders dark text for
 * light surfaces; `tone="dark"` renders light text for navy/dark surfaces
 * (landing hero, sidebar).
 */
export function PaynoraLogo({
  className,
  tone = "light",
  size = 28,
}: {
  className?: string;
  tone?: "light" | "dark";
  size?: number;
}) {
  return (
    <span className={cn("inline-flex items-center gap-2.5", className)}>
      <PaynoraMark size={size} />
      <span
        className={cn(
          "text-[1.05rem] font-semibold tracking-tight",
          tone === "dark" ? "text-white" : "text-foreground",
        )}
      >
        PAYNORA
      </span>
    </span>
  );
}
