"use client";

import * as React from "react";
import {
  flexRender,
  getCoreRowModel,
  getFacetedRowModel,
  getFacetedUniqueValues,
  getFilteredRowModel,
  getPaginationRowModel,
  getSortedRowModel,
  useReactTable,
  type ColumnDef,
  type ColumnFiltersState,
  type RowSelectionState,
  type SortingState,
  type RowData,
  type Table as TanstackTable,
  type VisibilityState,
} from "@tanstack/react-table";

import { cn } from "@/ui-kit/lib/utils";
import { Skeleton } from "@/ui-kit/components/ui/skeleton";

// Merges with the app's existing ColumnMeta augmentation in
// components/data/data-table.tsx, which already supplies `fixed`. The kit adds
// `label` so the column-visibility menu can show "Scheduled" and not
// "scheduledAt".
declare module "@tanstack/react-table" {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  interface ColumnMeta<TData extends RowData, TValue> {
    label?: string;
  }
}
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/ui-kit/components/ui/table";
import { DataTablePagination } from "./dataTablePagination";

export interface DataTableProps<TData, TValue> {
  /**
   * Column widths are authoritative. Leftover container width is taken up by a
   * trailing spacer cell, not by a neighbouring column - see the note on
   * `spacer` below for why that distinction matters.
   */
  columns: ColumnDef<TData, TValue>[];
  data: TData[];
  /** Stable row identity - required for selection to survive sorting or paging. */
  getRowId?: (row: TData, index: number) => string;
  isLoading?: boolean;
  /** Rendered in place of the body when there are no rows. */
  empty?: React.ReactNode;
  /** Receives the table instance so a parent can render toolbars and bulk bars. */
  children?: (table: TanstackTable<TData>) => React.ReactNode;
  onRowClick?: (row: TData) => void;
  initialPageSize?: number;
  className?: string;
}

/**
 * TanStack Table, wired up.
 *
 * TanStack is headless - it owns sorting, filtering, selection, visibility and
 * pagination state; every pixel is ours. That split is the reason not to
 * hand-roll: the moment a table needs "sort by column, filter, select across
 * pages, then hide a column", ad-hoc useState turns into a small state machine
 * with bugs at every intersection.
 *
 * Note `getRowId`. Without it, selection is keyed by row index, so sorting the
 * table silently reassigns every checkbox to a different record.
 *
 *   <DataTable columns={columns} data={jobs} getRowId={(job) => job.id}>
 *     {(table) => <DataTableToolbar table={table} … />}
 *   </DataTable>
 */
function DataTable<TData, TValue>({
  columns, data, getRowId, isLoading, empty, children, onRowClick,
  initialPageSize = 25, className,
}: DataTableProps<TData, TValue>) {
  const [sorting, setSorting] = React.useState<SortingState>([]);
  const [columnFilters, setColumnFilters] = React.useState<ColumnFiltersState>([]);
  const [columnVisibility, setColumnVisibility] = React.useState<VisibilityState>({});
  const [rowSelection, setRowSelection] = React.useState<RowSelectionState>({});
  const [columnSizing, setColumnSizing] = React.useState({});

  const table = useReactTable({
    data,
    columns,
    getRowId,
    state: { sorting, columnFilters, columnVisibility, rowSelection, columnSizing },
    initialState: { pagination: { pageIndex: 0, pageSize: initialPageSize } },
    enableRowSelection: true,
    enableColumnResizing: true,
    columnResizeMode: "onChange",
    onColumnSizingChange: setColumnSizing,
    onSortingChange: setSorting,
    onColumnFiltersChange: setColumnFilters,
    onColumnVisibilityChange: setColumnVisibility,
    onRowSelectionChange: setRowSelection,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
    getFilteredRowModel: getFilteredRowModel(),
    getPaginationRowModel: getPaginationRowModel(),
    getFacetedRowModel: getFacetedRowModel(),
    getFacetedUniqueValues: getFacetedUniqueValues(),
  });

  const visibleColumns = table.getVisibleLeafColumns().length;
  const rows = table.getRowModel().rows;

  /**
   * The table always fills its container, and no column becomes a dead strip.
   *
   * Leftover width is shared across the flexible columns in proportion to their
   * current size. The two obvious shortcuts are both wrong: parking the surplus
   * in the last column just relocates the gap, and a trailing spacer makes the
   * gap official.
   *
   * During a resize, only columns to the *right* of the grip take the change.
   * Nothing left of the handle moves, so the boundary tracks the cursor
   * one-to-one; spreading the change across all columns would drag the handle
   * away from the pointer. Freeze the rendered widths on pointerdown before
   * doing this - `columnSizing` holds base sizes, and starting from those makes
   * every column jump as the surplus is recomputed from the wrong baseline.
   *
   * Mark fixed-purpose columns (selection checkbox, row actions) with
   * `meta.fixed` so they keep their size.
   */
  const containerRef = React.useRef<HTMLDivElement>(null);
  const [available, setAvailable] = React.useState(0);
  React.useEffect(() => {
    const node = containerRef.current;
    if (!node) return;
    const observer = new ResizeObserver(([entry]) => {
      if (entry) setAvailable(entry.contentRect.width);
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, []);
  const layout = React.useMemo(() => {
    const columns = table.getVisibleLeafColumns();
    const width: Record<string, number> = {};
    columns.forEach((column) => { width[column.id] = column.getSize(); });

    // `width` is populated for every visible column directly above, so these
    // lookups are always present; the helper exists to satisfy
    // noUncheckedIndexedAccess without widening the arithmetic to `undefined`.
    const at = (id: string) => width[id] ?? 0;

    const total = columns.reduce((sum, column) => sum + at(column.id), 0);
    const extra = (available || total) - total;
    if (!available || extra === 0) return width;

    const pool = columns.filter((column) => !(column.columnDef.meta as { fixed?: boolean })?.fixed);
    if (!pool.length) return width;

    if (extra > 0) {
      const poolTotal = pool.reduce((sum, column) => sum + at(column.id), 0);
      pool.forEach((column) => {
        width[column.id] = Math.round(at(column.id) + extra * (at(column.id) / poolTotal));
      });
    } else {
      let deficit = -extra;
      for (const column of pool) {
        if (deficit <= 0) break;
        // TanStack's own default minSize is 20; the kit asserted this non-null,
        // which yielded NaN for any column that never set one.
        const give = Math.min(deficit, at(column.id) - (column.columnDef.minSize ?? 20));
        if (give > 0) { width[column.id] = at(column.id) - give; deficit -= give; }
      }
    }
    // Rounding drift lands on the last flexible column so the sum stays exact.
    const drift = (available || total) - columns.reduce((sum, column) => sum + at(column.id), 0);
    const lastFlexible = pool[pool.length - 1];
    if (drift !== 0 && lastFlexible) width[lastFlexible.id] = at(lastFlexible.id) + drift;
    return width;
  }, [table, available, columnSizing, columnVisibility]);

  const gridWidth = Object.values(layout).reduce((sum, w) => sum + w, 0);

  return (
    <div className={cn("bg-kit-card overflow-hidden rounded-lg border shadow-sm", className)}>
      {children?.(table)}

      <Table containerClassName="w-full" ref={containerRef}>
        <TableHeader>
          {table.getHeaderGroups().map((headerGroup) => (
            <TableRow key={headerGroup.id} className="hover:bg-transparent">
              {headerGroup.headers.map((header) => (
                <TableHead key={header.id} style={{ width: layout[header.column.id] }}>
                  {header.isPlaceholder ? null : flexRender(header.column.columnDef.header, header.getContext())}
                </TableHead>
              ))}
            </TableRow>
          ))}
        </TableHeader>

        <TableBody>
          {isLoading ? (
            // Skeleton rows mirror the real column count, so the layout never
            // jumps when data lands.
            Array.from({ length: 6 }).map((_, rowIndex) => (
              <TableRow key={rowIndex} className="hover:bg-transparent">
                {Array.from({ length: visibleColumns }).map((_, colIndex) => (
                  <TableCell key={colIndex}>
                    <Skeleton className={cn("h-3", colIndex === 0 ? "w-4" : colIndex === 1 ? "w-14" : "w-24")} />
                  </TableCell>
                ))}
              </TableRow>
            ))
          ) : rows.length === 0 ? (
            <TableRow className="hover:bg-transparent">
              <TableCell colSpan={visibleColumns} padding="none">{empty}</TableCell>
            </TableRow>
          ) : (
            rows.map((row) => (
              <TableRow
                key={row.id}
                data-state={row.getIsSelected() ? "selected" : undefined}
                onClick={onRowClick ? () => onRowClick(row.original) : undefined}
                className={cn(onRowClick && "cursor-pointer")}
              >
                {row.getVisibleCells().map((cell) => (
                  <TableCell key={cell.id}>
                    {flexRender(cell.column.columnDef.cell, cell.getContext())}
                  </TableCell>
                ))}
              </TableRow>
            ))
          )}
        </TableBody>
      </Table>

      <DataTablePagination table={table} />
    </div>
  );
}

export { DataTable };
export type { ColumnDef, TanstackTable };
