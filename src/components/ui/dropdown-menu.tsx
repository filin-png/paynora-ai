"use client";

import * as React from "react";

import { cn } from "@/lib/utils";

/**
 * A small, dependency-free dropdown menu (used for the header account
 * menu). Closes on outside click and Escape; each item is a real button
 * or link so keyboard/screen-reader users get standard semantics for
 * free — no ARIA menu role reimplementation, which is easy to get wrong.
 *
 * Deliberately does *not* close on an inner click: an item like "Sign
 * out" is a real `<form action={serverAction}>` — synchronously removing
 * it from the DOM in the same click handler that submits it risks
 * cancelling the pending Server Action transition. A link item navigates
 * away on its own (unmounting everything); a same-page action item is
 * expected to close the menu itself if that matters.
 */
export function DropdownMenu({
  trigger,
  children,
  align = "end",
}: {
  trigger: React.ReactNode;
  children: React.ReactNode;
  align?: "start" | "end";
}) {
  const [open, setOpen] = React.useState(false);
  const ref = React.useRef<HTMLDivElement>(null);

  React.useEffect(() => {
    if (!open) return;
    function onPointerDown(event: MouseEvent) {
      if (ref.current && !ref.current.contains(event.target as Node)) setOpen(false);
    }
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") setOpen(false);
    }
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  return (
    <div ref={ref} className="relative">
      <button type="button" onClick={() => setOpen((v) => !v)} aria-haspopup="menu" aria-expanded={open} className="contents">
        {trigger}
      </button>
      {open ? (
        <div
          role="menu"
          className={cn(
            "absolute top-full z-20 mt-2 min-w-48 rounded-lg border border-border bg-surface p-1.5 shadow-card-lg",
            align === "end" ? "right-0" : "left-0",
          )}
        >
          {children}
        </div>
      ) : null}
    </div>
  );
}

export function DropdownMenuItem({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      role="menuitem"
      className={cn(
        "flex cursor-pointer items-center gap-2 rounded-md px-2.5 py-2 text-sm text-foreground hover:bg-accent-soft",
        className,
      )}
      {...props}
    />
  );
}

export function DropdownMenuLabel({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("px-2.5 py-1.5 text-xs text-muted", className)} {...props} />;
}

export function DropdownMenuSeparator() {
  return <div className="my-1 h-px bg-border" role="separator" />;
}
