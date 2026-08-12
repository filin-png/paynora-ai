"use client";

import * as React from "react";
import { X } from "lucide-react";

import { cn } from "@/lib/utils";

/**
 * A minimal, dependency-free modal built on the native `<dialog>` element
 * — it already gives us focus trapping, Escape-to-close, and a backdrop
 * for free, so there's no need for a modal library. See
 * docs/product-ui.md#design-system.
 *
 * Closing is handled natively wherever possible: the header's close
 * button and any in-content "Cancel" control should be a
 * `<button formMethod="dialog">` (or live inside a `<form method="dialog">`)
 * rather than JS calling `.close()` — that's what lets `children` stay a
 * plain `ReactNode` instead of a function that captures a ref, which is
 * unsafe to invoke during render (see react-hooks/refs).
 */
export function Dialog({
  trigger,
  title,
  description,
  children,
  className,
}: {
  trigger: React.ReactNode;
  title: string;
  description?: string;
  children: React.ReactNode;
  className?: string;
}) {
  const ref = React.useRef<HTMLDialogElement>(null);

  return (
    <>
      <span onClick={() => ref.current?.showModal()} className="contents">
        {trigger}
      </span>
      <dialog
        ref={ref}
        aria-labelledby="dialog-title"
        className={cn(
          "m-auto w-full max-w-sm rounded-xl border border-border bg-surface p-0 shadow-card-lg backdrop:bg-navy-950/50",
          className,
        )}
        onClick={(event) => {
          if (event.target === ref.current) ref.current?.close();
        }}
      >
        <form method="dialog">
          <div className="flex items-start justify-between gap-4 p-5">
            <div>
              <h2 id="dialog-title" className="text-sm font-semibold text-foreground">
                {title}
              </h2>
              {description ? <p className="mt-1 text-sm text-muted">{description}</p> : null}
            </div>
            <button
              type="submit"
              aria-label="Close"
              className="flex size-8 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-accent-soft hover:text-foreground"
            >
              <X className="size-4" />
            </button>
          </div>
        </form>
        <div className="px-5 pb-5">{children}</div>
      </dialog>
    </>
  );
}

/** A "Cancel" button that closes the nearest `<dialog>` without JS — safe to place anywhere inside `children`. */
export function DialogCancelButton({ className, children = "Cancel", ...props }: React.ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <form method="dialog" className="contents">
      <button type="submit" className={className} {...props}>
        {children}
      </button>
    </form>
  );
}
