"use client";

import * as React from "react";
import type { Table } from "@tanstack/react-table";
import { ChevronLeft, ChevronRight, ChevronsLeft, ChevronsRight } from "lucide-react";

import { Button } from "@/ui-kit/components/ui/button";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/ui-kit/components/ui/select";

export interface DataTablePaginationProps<TData> {
  table: Table<TData>;
  pageSizeOptions?: number[];
}

/**
 * Footer: selection count, page size, page controls.
 *
 * The left slot swaps to "N of M selected" while rows are checked - the count
 * belongs where the user is already looking, not in a separate banner.
 */
function DataTablePagination<TData>({
  table,
  pageSizeOptions = [25, 50, 100],
}: DataTablePaginationProps<TData>) {
  const selected = table.getFilteredSelectedRowModel().rows.length;
  // `getRowCount()` rather than the filtered row model: under server-side
  // paging the filtered model only holds the page in hand, so the readout
  // would say "of 25" on a 4,000-row list. It falls back to the same filtered
  // count when the table pages itself, so the client path is unchanged.
  const total = table.getRowCount();
  const { pageIndex, pageSize } = table.getState().pagination;
  const pageCount = table.getPageCount();

  return (
    <div className="flex flex-wrap items-center gap-3 border-t px-4 py-3">
      <div className="text-muted-foreground text-[12.5px]">
        {selected > 0 ? (
          <><span className="text-foreground font-bold">{selected}</span> of {total} selected</>
        ) : (
          <>Showing <span className="text-foreground font-bold">
            {total === 0 ? 0 : pageIndex * pageSize + 1}-{Math.min((pageIndex + 1) * pageSize, total)}
          </span> of <span className="text-foreground font-bold">{total}</span></>
        )}
      </div>

      <div className="ms-auto flex flex-wrap items-center gap-3">
        <div className="flex items-center gap-2">
          <span className="text-muted-foreground hidden text-[12.5px] font-medium sm:inline">Rows</span>
          <Select
            value={String(pageSize)}
            onValueChange={(value) => table.setPageSize(Number(value))}
          >
            <SelectTrigger size="sm" className="w-[4.5rem]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {pageSizeOptions.map((size) => (
                <SelectItem key={size} value={String(size)}>{size}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <span className="text-muted-foreground text-[12.5px] font-medium">
          Page {pageCount === 0 ? 0 : pageIndex + 1} of {pageCount}
        </span>

        <div className="flex items-center gap-1.5">
          <Button variant="outline" size="icon-sm" className="hidden sm:inline-flex"
            onClick={() => table.setPageIndex(0)} disabled={!table.getCanPreviousPage()}>
            <ChevronsLeft /><span className="sr-only">First page</span>
          </Button>
          <Button variant="outline" size="icon-sm"
            onClick={() => table.previousPage()} disabled={!table.getCanPreviousPage()}>
            <ChevronLeft /><span className="sr-only">Previous page</span>
          </Button>
          <Button variant="outline" size="icon-sm"
            onClick={() => table.nextPage()} disabled={!table.getCanNextPage()}>
            <ChevronRight /><span className="sr-only">Next page</span>
          </Button>
          <Button variant="outline" size="icon-sm" className="hidden sm:inline-flex"
            onClick={() => table.setPageIndex(pageCount - 1)} disabled={!table.getCanNextPage()}>
            <ChevronsRight /><span className="sr-only">Last page</span>
          </Button>
        </div>
      </div>
    </div>
  );
}

export { DataTablePagination };
