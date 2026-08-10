import { useMemo } from 'react';
import {
  totalOnHand,
  isLowStock,
  inventoryValue,
  type Item,
} from '@/lib/api/inventory';
import type { Filters } from '@/components/inventory/FiltersPopover';

export interface InventoryFiltersArgs {
  allItems: Item[];
  search: string;
  activeLoc: string;
  filters: Filters;
}

export interface UseInventoryStatsReturn {
  totalSkus: number;
  lowStock: number;
  backorder: number;
  value: number;
}

/**
 * The InventoryPage `filteredItems` memo, lifted verbatim. The `.filter()` chain
 * order (kind → search → activeLoc presence → trade → kind → vendor → category →
 * flags → stockStates) and the dependency array are unchanged so the rendered
 * table is identical regardless of whether `allItems` comes from mock or live data.
 */
export function useInventoryFilters({ allItems, search, activeLoc, filters }: InventoryFiltersArgs): {
  filteredItems: Item[];
} {
  const filteredItems = useMemo(() => {
    const q = search.trim().toLowerCase();
    return allItems
      .filter((i) => i.kind === "material" || i.kind === "labor" || i.kind === "service")
      .filter((i) => {
        if (!q) return true;
        return (
          i.sku.toLowerCase().includes(q) ||
          i.name.toLowerCase().includes(q) ||
          i.category.toLowerCase().includes(q) ||
          i.vendor.toLowerCase().includes(q) ||
          (i.mpn || "").toLowerCase().includes(q) ||
          (i.modelNumber || "").toLowerCase().includes(q) ||
          (i.upc || "").toLowerCase().includes(q)
        );
      })
      .filter((i) => {
        if (activeLoc === "all") return true;
        const s = i.stock.find((s) => s.locationId === activeLoc);
        if (!s) return false;
        // If a stock-state filter is active that includes "below min" or "zero",
        // include items whose stock row exists at this location even at 0 on-hand —
        // those are the most critical low/out-of-stock cases.
        if (
          filters.stockStates.includes("low_stock") ||
          filters.stockStates.includes("out_of_stock")
        ) {
          return true;
        }
        // Otherwise: only items actually present (on-hand > 0).
        return s.onHand > 0;
      })
      // Trade filter
      .filter(
        (i) => filters.trades.length === 0 || filters.trades.includes(i.trade),
      )
      // Item kind filter
      .filter(
        (i) => filters.kinds.length === 0 || filters.kinds.includes(i.kind),
      )
      // Vendor filter
      .filter(
        (i) =>
          filters.vendors.length === 0 || filters.vendors.includes(i.vendor),
      )
      // Category filter — driven by the new CategorySelector pill in the
      // "Showing" row (rev 2026-05-26). Matches against Item.category by name.
      .filter(
        (i) =>
          filters.categories.length === 0 || filters.categories.includes(i.category),
      )
      // Flag filter (item must have ALL selected flags)
      .filter((i) => {
        if (filters.flags.length === 0) return true;
        if (filters.flags.includes("serialized") && !i.serialized) return false;
        if (filters.flags.includes("hazmat") && !i.hazmat) return false;
        return true;
      })
      // Stock state filter — scoped to the active location when one is set,
      // otherwise to the cross-location totals.
      .filter((i) => {
        if (filters.stockStates.length === 0) return true;
        if (i.kind !== "material") return false;

        if (activeLoc !== "all") {
          const s = i.stock.find((x) => x.locationId === activeLoc);
          if (!s) return false;
          const onHand = s.onHand;
          const isLow = s.min != null && s.min > 0 && s.onHand < s.min;
          return filters.stockStates.some((state) => {
            if (state === "in_stock")
              return onHand > 0 && !isLow && i.status !== "on_backorder";
            if (state === "low_stock") return isLow;
            if (state === "out_of_stock") return onHand === 0;
            if (state === "backorder") return i.status === "on_backorder";
            return false;
          });
        }

        const onHand = totalOnHand(i);
        const low = isLowStock(i);
        return filters.stockStates.some((s) => {
          if (s === "in_stock") return onHand > 0 && !low && i.status !== "on_backorder";
          if (s === "low_stock") return low && onHand > 0;
          if (s === "out_of_stock") return onHand === 0;
          if (s === "backorder") return i.status === "on_backorder";
          return false;
        });
      });
  }, [allItems, search, activeLoc, filters]);

  return { filteredItems };
}

/**
 * The InventoryPage `stats` memo, lifted verbatim. Computed only over `material`
 * items; dependency array `[allItems]` unchanged.
 */
export function useInventoryStats(allItems: Item[]): UseInventoryStatsReturn {
  const stats = useMemo(() => {
    const materialItems = allItems.filter((i) => i.kind === "material");
    const totalSkus = materialItems.length;
    const lowStock = materialItems.filter(isLowStock).length;
    const backorder = materialItems.filter(
      (i) => i.status === "on_backorder",
    ).length;
    const value = materialItems.reduce((sum, i) => sum + inventoryValue(i), 0);
    return { totalSkus, lowStock, backorder, value };
  }, [allItems]);

  return stats;
}
