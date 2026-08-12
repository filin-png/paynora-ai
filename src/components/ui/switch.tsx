import { cn } from "@/lib/utils";

/**
 * A purely presentational toggle track/thumb — not a form control. Every
 * "switch" in this app is a `<button type="submit">` whose Server Action
 * already has the next state bound in at render time (see
 * `setAutomationEnabledAction.bind(null, orgSlug, !current)` in the
 * automation page), the same pattern used throughout Phase 5. Wrap this in
 * that button and pass `aria-pressed={checked}` on the button itself —
 * that is the real accessibility contract, not an `<input>` here, which
 * would misrepresent how the action actually submits (there is no
 * checked/unchecked form field being read; the button IS the action).
 */
export function Switch({ checked, className }: { checked: boolean; className?: string }) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        "relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors",
        checked ? "bg-primary" : "bg-border-strong",
        className,
      )}
    >
      <span
        className={cn(
          "inline-block size-4.5 translate-x-1 rounded-full bg-white shadow-card-sm transition-transform",
          checked && "translate-x-[1.375rem]",
        )}
      />
    </span>
  );
}
