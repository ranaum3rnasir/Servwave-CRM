"use client";

import * as React from "react";
import { ArrowDown, ArrowUp } from "lucide-react";

import { cn } from "@/ui-kit/lib/utils";
import { Badge } from "@/ui-kit/components/ui/badge";
import { Skeleton } from "@/ui-kit/components/ui/skeleton";

export interface StatCardProps extends Omit<React.ComponentProps<"button">, "value"> {
  label: string;
  value: React.ReactNode;
  /** Change since the last period. `direction` drives the arrow and tint. */
  delta?: { value: string; direction?: "up" | "down" | "flat" };
  /** Renders a 3px semantic rail on the left edge. */
  tone?: "brand" | "green" | "blue" | "amber" | "red" | "purple";
  /** Pressed state - set when the card is acting as an active filter. */
  active?: boolean;
  loading?: boolean;
}

const railTones = {
  brand: "before:bg-brand",
  green: "before:bg-status-green",
  blue: "before:bg-status-blue",
  amber: "before:bg-status-amber",
  red: "before:bg-status-red",
  purple: "before:bg-status-purple",
};

const deltaVariant = { up: "softGreen", down: "softRed", flat: "softNeutral" } as const;

/**
 * KPI tile.
 *
 * The value leads at roughly twice the label's size - a stat card exists to be
 * read in under a second, and that only works when the number is visually
 * first. If the row is too tall, tighten the padding; never level the sizes.
 *
 * Deliberately no icon tile. A briefcase glyph beside "Open jobs" carries no
 * information and costs 36px on every card; when a metric needs colour coding,
 * the `tone` rail does the same job in 3px.
 *
 * Renders as a <button> so it can act as a filter - which is also the only
 * honest reason to give it a hover lift.
 */
function StatCard({
  className, label, value, delta, tone, active, loading, ...props
}: StatCardProps) {
  if (loading) {
    return (
      <div className="bg-kit-card flex flex-col gap-2.5 rounded-lg border p-3.5 shadow-sm">
        <Skeleton className="h-3 w-24" />
        <div className="flex items-center justify-between gap-2">
          <Skeleton className="h-6 w-16" />
          <Skeleton className="h-5 w-14 rounded-full" />
        </div>
      </div>
    );
  }

  const interactive = Boolean(props.onClick);
  // Polymorphic host: `button` when clickable, `div` otherwise. The union of
  // both prop sets is not inferable, so the tag is widened to ElementType.
  const Comp = (interactive ? "button" : "div") as React.ElementType;

  return (
    <Comp
      data-slot="stat-card"
      type={interactive ? "button" : undefined}
      aria-pressed={interactive ? active : undefined}
      className={cn(
        "bg-kit-card relative flex flex-col gap-2.5 overflow-hidden rounded-lg border p-3.5 text-left shadow-sm",
        "transition-[transform,box-shadow,border-color,background-color] duration-200",
        tone && "before:absolute before:inset-y-0 before:left-0 before:w-[3px] before:content-['']",
        tone && railTones[tone],
        interactive && "cursor-pointer hover:border-brand hover:-translate-y-0.5 hover:shadow-md active:translate-y-0",
        interactive && "focus-visible:border-brand focus-visible:ring-[3px] focus-visible:ring-ring/25 focus-visible:outline-none",
        active && "border-brand bg-brand-subtle",
        className,
      )}
      {...props}
    >
      <span className="text-muted-foreground text-[12.5px] font-semibold">{label}</span>
      <span className="flex items-center justify-between gap-2">
        <span className="text-2xl leading-none font-bold tracking-[-0.035em] tabular-nums">{value}</span>
        {delta && (
          <Badge variant={deltaVariant[delta.direction ?? "flat"]} size="pill">
            {delta.direction === "up" && <ArrowUp className="size-3 stroke-[2.5]" />}
            {delta.direction === "down" && <ArrowDown className="size-3 stroke-[2.5]" />}
            {delta.value}
          </Badge>
        )}
      </span>
    </Comp>
  );
}

function StatCardGroup({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="stat-card-group"
      className={cn("grid gap-3 sm:grid-cols-2 xl:grid-cols-4", className)}
      {...props}
    />
  );
}

export { StatCard, StatCardGroup };
