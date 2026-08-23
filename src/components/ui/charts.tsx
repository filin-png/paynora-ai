/**
 * Minimal, dependency-free SVG chart primitives for the dark financial
 * design system — no chart library added; these render only real,
 * already-computed numeric series passed in by the caller (see
 * docs/product-ui.md#real-data-only). Kept intentionally small: a line
 * trend, a donut, and an inline sparkline cover every chart on the
 * Overview page and are reusable on future screens.
 */
"use client";

import * as React from "react";

function toPath(points: { x: number; y: number }[]) {
  return points.map((p, i) => `${i === 0 ? "M" : "L"}${p.x.toFixed(2)},${p.y.toFixed(2)}`).join(" ");
}

export type TrendSeries = {
  label: string;
  color: string;
  values: number[];
};

/**
 * Multi-series line chart with a soft gradient fill under the first
 * series. `values` arrays must be the same length across all series
 * (one point per period, e.g. one per day).
 */
export function TrendChart({
  series,
  labels,
  height = 220,
  className,
}: {
  series: TrendSeries[];
  labels: string[];
  height?: number;
  className?: string;
}) {
  const width = 640;
  const padY = 16;
  const count = labels.length;
  const max = Math.max(1, ...series.flatMap((s) => s.values));
  const min = Math.min(0, ...series.flatMap((s) => s.values));
  const range = max - min || 1;

  const toPoints = (values: number[]) =>
    values.map((v, i) => ({
      x: count > 1 ? (i / (count - 1)) * width : width / 2,
      y: padY + (1 - (v - min) / range) * (height - padY * 2),
    }));

  const gridLines = [0, 0.25, 0.5, 0.75, 1];
  const primary = series[0];
  const primaryPoints = primary ? toPoints(primary.values) : [];
  const areaPath =
    primaryPoints.length > 0
      ? `${toPath(primaryPoints)} L${width},${height - padY} L0,${height - padY} Z`
      : "";
  const gradientId = React.useId();

  return (
    <div className={className}>
      <svg viewBox={`0 0 ${width} ${height}`} className="h-auto w-full overflow-visible" role="img" aria-hidden="true">
        <defs>
          <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={primary?.color ?? "var(--primary)"} stopOpacity="0.35" />
            <stop offset="100%" stopColor={primary?.color ?? "var(--primary)"} stopOpacity="0" />
          </linearGradient>
        </defs>

        {gridLines.map((g) => (
          <line
            key={g}
            x1={0}
            x2={width}
            y1={padY + g * (height - padY * 2)}
            y2={padY + g * (height - padY * 2)}
            stroke="var(--border)"
            strokeWidth={1}
          />
        ))}

        {areaPath ? <path d={areaPath} fill={`url(#${gradientId})`} /> : null}

        {series.map((s) => {
          const points = toPoints(s.values);
          return (
            <path
              key={s.label}
              d={toPath(points)}
              fill="none"
              stroke={s.color}
              strokeWidth={2.5}
              strokeLinecap="round"
              strokeLinejoin="round"
              style={{ filter: `drop-shadow(0 0 6px ${s.color}66)` }}
            />
          );
        })}

        {primaryPoints.length > 0 ? (
          <circle
            cx={primaryPoints[primaryPoints.length - 1]!.x}
            cy={primaryPoints[primaryPoints.length - 1]!.y}
            r={4}
            fill={primary!.color}
            stroke="var(--surface)"
            strokeWidth={2}
          />
        ) : null}
      </svg>
      <div className="mt-2 flex justify-between text-[11px] text-muted-foreground">
        <span>{labels[0]}</span>
        <span>{labels[labels.length - 1]}</span>
      </div>
    </div>
  );
}

export type DonutSegment = {
  label: string;
  value: number;
  color: string;
};

/** SVG donut built from stroke-dasharray arcs — no canvas, no library. */
export function DonutChart({
  segments,
  centerLabel,
  centerValue,
  size = 168,
}: {
  segments: DonutSegment[];
  centerLabel?: string;
  centerValue?: string;
  size?: number;
}) {
  const total = segments.reduce((sum, s) => sum + s.value, 0);
  const radius = 60;
  const circumference = 2 * Math.PI * radius;
  const strokeWidth = 18;
  let offset = 0;

  return (
    <div className="flex items-center gap-5">
      <svg
        viewBox="0 0 160 160"
        width={size}
        height={size}
        className="shrink-0 -rotate-90"
        role="img"
        aria-hidden="true"
      >
        <circle cx="80" cy="80" r={radius} fill="none" stroke="var(--border)" strokeWidth={strokeWidth} />
        {total > 0
          ? segments.map((segment) => {
              const fraction = segment.value / total;
              const dash = fraction * circumference;
              const circle = (
                <circle
                  key={segment.label}
                  cx="80"
                  cy="80"
                  r={radius}
                  fill="none"
                  stroke={segment.color}
                  strokeWidth={strokeWidth}
                  strokeDasharray={`${dash} ${circumference - dash}`}
                  strokeDashoffset={-offset}
                  strokeLinecap="butt"
                />
              );
              offset += dash;
              return circle;
            })
          : null}
      </svg>
      <div className="min-w-0">
        {centerValue ? <p className="text-lg font-semibold tabular-nums text-foreground">{centerValue}</p> : null}
        {centerLabel ? <p className="text-xs text-muted-foreground">{centerLabel}</p> : null}
        <ul className="mt-3 flex flex-col gap-1.5">
          {segments.map((segment) => (
            <li key={segment.label} className="flex items-center gap-2 text-xs text-muted">
              <span className="size-2 shrink-0 rounded-full" style={{ background: segment.color }} />
              <span className="truncate">{segment.label}</span>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

/** Tiny inline trend line for a MetricCard — no axes, no labels. */
export function Sparkline({
  values,
  color = "var(--primary)",
  width = 88,
  height = 28,
}: {
  values: number[];
  color?: string;
  width?: number;
  height?: number;
}) {
  if (values.length < 2) return null;
  const max = Math.max(...values);
  const min = Math.min(...values);
  const range = max - min || 1;
  const points = values.map((v, i) => ({
    x: (i / (values.length - 1)) * width,
    y: height - ((v - min) / range) * height,
  }));

  return (
    <svg viewBox={`0 0 ${width} ${height}`} width={width} height={height} aria-hidden="true">
      <path d={toPath(points)} fill="none" stroke={color} strokeWidth={1.75} strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
