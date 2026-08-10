"use client";

import * as React from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { DayPicker } from "react-day-picker";

import { cn } from "@/ui-kit/lib/utils";
import { buttonVariants } from "@/ui-kit/components/ui/button";

/**
 * react-day-picker, restyled to our tokens.
 *
 * Not hand-rolled because a correct month grid is more work than it looks:
 * locale-aware week starts, DST-safe day arithmetic, range selection, disabled
 * ranges, and full arrow-key navigation across month boundaries.
 */
function Calendar({
  className,
  classNames,
  showOutsideDays = true,
  ...props
}: React.ComponentProps<typeof DayPicker>) {
  return (
    <DayPicker
      data-slot="calendar"
      showOutsideDays={showOutsideDays}
      className={cn("p-3", className)}
      classNames={{
        months: "flex flex-col sm:flex-row gap-4",
        month: "flex flex-col gap-3",
        month_caption: "flex justify-center items-center h-8 relative",
        caption_label: "text-[13.5px] font-bold tracking-tight",
        nav: "flex items-center gap-1 absolute inset-x-0 top-0 h-8 justify-between px-0",
        button_previous: cn(
          buttonVariants({ variant: "ghost", size: "icon-sm" }),
          "text-muted-foreground hover:text-foreground",
        ),
        button_next: cn(
          buttonVariants({ variant: "ghost", size: "icon-sm" }),
          "text-muted-foreground hover:text-foreground",
        ),
        month_grid: "w-full border-collapse",
        weekdays: "flex",
        weekday: "text-subtle-foreground w-9 text-[11px] font-semibold uppercase tracking-wide",
        week: "flex w-full mt-1.5",
        day: cn(
          "relative size-9 p-0 text-center",
          // Range fills bleed to the cell edges so selected weeks read as one bar.
          "[&:has([aria-selected])]:bg-brand-subtle",
          "[&:has(>.day-range-start)]:rounded-l-md [&:has(>.day-range-end)]:rounded-r-md",
          "first:[&:has([aria-selected])]:rounded-l-md last:[&:has([aria-selected])]:rounded-r-md",
        ),
        day_button: cn(
          "size-9 rounded-md text-[13px] font-medium transition-colors cursor-pointer",
          "hover:bg-muted focus-visible:ring-[3px] focus-visible:ring-ring/25 focus-visible:outline-none",
        ),
        selected:
          "[&>button]:bg-brand [&>button]:text-brand-foreground [&>button]:hover:bg-brand [&>button]:font-bold",
        range_start: "day-range-start",
        range_end: "day-range-end",
        range_middle: "[&>button]:bg-transparent [&>button]:text-foreground",
        // A ring, not a fill - today should be findable without looking selected.
        today: "[&>button]:ring-1 [&>button]:ring-brand [&>button]:font-bold",
        outside: "[&>button]:text-subtle-foreground [&>button]:opacity-50",
        disabled: "[&>button]:text-subtle-foreground [&>button]:opacity-40 [&>button]:cursor-not-allowed",
        hidden: "invisible",
        ...classNames,
      }}
      components={{
        Chevron: ({ orientation, ...rest }) =>
          orientation === "left"
            ? <ChevronLeft className="size-4" {...rest} />
            : <ChevronRight className="size-4" {...rest} />,
      }}
      {...props}
    />
  );
}

export { Calendar };
