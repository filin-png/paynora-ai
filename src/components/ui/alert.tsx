import { AlertTriangle, CheckCircle2, Info, OctagonAlert } from "lucide-react";
import { cva, type VariantProps } from "class-variance-authority";

import { cn } from "@/lib/utils";

const alertVariants = cva("flex gap-3 rounded-lg border p-4 text-sm", {
  variants: {
    tone: {
      neutral: "border-border bg-surface text-foreground",
      info: "border-transparent bg-accent-soft text-primary",
      success: "border-transparent bg-success-soft text-success",
      warning: "border-transparent bg-warning-soft text-warning",
      danger: "border-transparent bg-danger-soft text-danger",
    },
  },
  defaultVariants: { tone: "neutral" },
});

const ICONS = { neutral: Info, info: Info, success: CheckCircle2, warning: AlertTriangle, danger: OctagonAlert };

export type AlertProps = React.HTMLAttributes<HTMLDivElement> &
  VariantProps<typeof alertVariants> & { title?: string };

export function Alert({ tone = "neutral", title, className, children, ...props }: AlertProps) {
  const Icon = ICONS[tone ?? "neutral"];
  return (
    <div role={tone === "danger" || tone === "warning" ? "alert" : undefined} className={cn(alertVariants({ tone }), className)} {...props}>
      <Icon className="mt-0.5 size-4 shrink-0" />
      <div className="flex flex-col gap-1">
        {title ? <p className="font-medium">{title}</p> : null}
        <div>{children}</div>
      </div>
    </div>
  );
}
