import * as React from "react";

import { cn } from "@/ui-kit/lib/utils";

/**
 * Semantic table primitives. Real <table> elements, not divs with grid - a
 * screen reader announces "row 4 of 203, column Status" only if the markup
 * says so, and that navigation is most of how a data table is used non-visually.
 *
 * The horizontal scroll lives on a wrapper so the header row can stay sticky
 * while the body scrolls under it.
 */
const Table = React.forwardRef<
  HTMLDivElement,
  React.ComponentProps<"table"> & { containerClassName?: string }
>(function Table({ className, containerClassName, ...props }, ref) {
  return (
    <div
      ref={ref}
      data-slot="table-container"
      className={cn("relative w-full overflow-x-auto", containerClassName)}
    >
      <table
        data-slot="table"
        className={cn("w-full caption-bottom border-collapse text-[13px]", className)}
        {...props}
      />
    </div>
  );
});

function TableHeader({ className, ...props }: React.ComponentProps<"thead">) {
  return (
    <thead
      data-slot="table-header"
      className={cn("[&_tr]:border-b", className)}
      {...props}
    />
  );
}

function TableBody({ className, ...props }: React.ComponentProps<"tbody">) {
  return (
    <tbody
      data-slot="table-body"
      className={cn("[&_tr:last-child]:border-0", className)}
      {...props}
    />
  );
}

function TableFooter({ className, ...props }: React.ComponentProps<"tfoot">) {
  return (
    <tfoot
      data-slot="table-footer"
      className={cn("bg-muted/50 border-t font-medium [&>tr]:last:border-b-0", className)}
      {...props}
    />
  );
}

function TableRow({ className, ...props }: React.ComponentProps<"tr">) {
  return (
    <tr
      data-slot="table-row"
      className={cn(
        "border-b transition-colors",
        "hover:bg-muted data-[state=selected]:bg-selected",
        className,
      )}
      {...props}
    />
  );
}

function TableHead({ className, ...props }: React.ComponentProps<"th">) {
  return (
    <th
      data-slot="table-head"
      className={cn(
        "text-muted-foreground h-10 px-4 text-left align-middle text-[11.5px] font-semibold whitespace-nowrap",
        "[&:has([role=checkbox])]:pr-0 [&>[role=checkbox]]:translate-y-[2px]",
        className,
      )}
      {...props}
    />
  );
}

export interface TableCellProps extends React.ComponentProps<"td"> {
  /**
   * `none` drops the cell's inset so a full-bleed child - an empty state, a
   * nested grid - can reach the row edges. A prop rather than a `p-0` at the
   * call site: padding is appearance, and appearance belongs to the component.
   */
  padding?: "default" | "none";
}

function TableCell({ className, padding = "default", ...props }: TableCellProps) {
  return (
    <td
      data-slot="table-cell"
      className={cn(
        padding === "none" ? "p-0" : "px-4 py-2.5",
        "align-middle",
        "[&:has([role=checkbox])]:pr-0 [&>[role=checkbox]]:translate-y-[2px]",
        className,
      )}
      {...props}
    />
  );
}

function TableCaption({ className, ...props }: React.ComponentProps<"caption">) {
  return (
    <caption
      data-slot="table-caption"
      className={cn("text-muted-foreground mt-4 text-[12.5px]", className)}
      {...props}
    />
  );
}

export { Table, TableHeader, TableBody, TableFooter, TableHead, TableRow, TableCell, TableCaption };
