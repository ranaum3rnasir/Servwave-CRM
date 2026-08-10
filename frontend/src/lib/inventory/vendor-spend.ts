// Vendor-spend rollups for the Vendors page.
// Joins PO lines to catalog items by SKU and aggregates extension cost
// (qtyOrdered × item.unitCost) per vendor across YTD / this-month / all-time.
// Per PRD §7.6 vendor spend tracking.

import type { Item, Vendor, PurchaseOrder } from "@/lib/api/inventory";
import { formatCurrencyWhole } from "@/lib/utils";

export type VendorSpend = {
  vendorName: string;
  allTime: number;
  ytd: number;
  thisMonth: number;
  lastMonth: number;
  momDelta: number;        // thisMonth - lastMonth (signed)
  momDeltaPct: number;     // thisMonth / lastMonth - 1; 0 if lastMonth==0
  poCount: number;         // all-time
  ytdPoCount: number;
  avgPoSize: number;       // all-time avg
  lastOrderedAt: string | null;
  topItemSku: string | null;   // most-ordered SKU by extension cost
  topItemName: string | null;
};

function poTotal(po: PurchaseOrder, itemsByKey: Map<string, Item>): number {
  return po.lines.reduce((sum, l) => {
    const item = itemsByKey.get(l.itemSku);
    const unitCost = item?.unitCost ?? 0;
    return sum + l.qtyOrdered * unitCost;
  }, 0);
}

function buildItemIndex(items: Item[]): Map<string, Item> {
  const map = new Map<string, Item>();
  for (const i of items) map.set(i.sku, i);
  return map;
}

export function computeVendorSpend(
  vendorName: string,
  pos: PurchaseOrder[],
  items: Item[],
  now: Date = new Date(),
): VendorSpend {
  const itemIndex = buildItemIndex(items);
  const vendorPOs = pos.filter((p) => p.vendor === vendorName);

  const year = now.getFullYear();
  const month = now.getMonth();
  const lastMonthDate = new Date(now);
  lastMonthDate.setMonth(month - 1);
  const lastMonth = lastMonthDate.getMonth();
  const lastMonthYear = lastMonthDate.getFullYear();

  let allTime = 0;
  let ytd = 0;
  let thisMonth = 0;
  let lastMonthSpend = 0;
  let ytdPoCount = 0;
  let lastOrderedAt: string | null = null;
  const itemExtensions = new Map<string, { ext: number; name: string }>();

  for (const po of vendorPOs) {
    const total = poTotal(po, itemIndex);
    allTime += total;
    const orderedDate = new Date(po.orderedAt);
    if (orderedDate.getFullYear() === year) {
      ytd += total;
      ytdPoCount += 1;
      if (orderedDate.getMonth() === month) thisMonth += total;
    }
    if (
      orderedDate.getFullYear() === lastMonthYear &&
      orderedDate.getMonth() === lastMonth
    ) {
      lastMonthSpend += total;
    }
    if (!lastOrderedAt || orderedDate > new Date(lastOrderedAt)) {
      lastOrderedAt = po.orderedAt;
    }
    for (const l of po.lines) {
      const item = itemIndex.get(l.itemSku);
      const ext = l.qtyOrdered * (item?.unitCost ?? 0);
      const prev = itemExtensions.get(l.itemSku);
      itemExtensions.set(l.itemSku, {
        ext: (prev?.ext ?? 0) + ext,
        name: l.itemName,
      });
    }
  }

  let topItemSku: string | null = null;
  let topItemName: string | null = null;
  let topExt = 0;
  for (const [sku, { ext, name }] of itemExtensions) {
    if (ext > topExt) {
      topExt = ext;
      topItemSku = sku;
      topItemName = name;
    }
  }

  const momDelta = thisMonth - lastMonthSpend;
  const momDeltaPct = lastMonthSpend > 0 ? thisMonth / lastMonthSpend - 1 : 0;
  const poCount = vendorPOs.length;
  const avgPoSize = poCount > 0 ? allTime / poCount : 0;

  return {
    vendorName,
    allTime,
    ytd,
    thisMonth,
    lastMonth: lastMonthSpend,
    momDelta,
    momDeltaPct,
    poCount,
    ytdPoCount,
    avgPoSize,
    lastOrderedAt,
    topItemSku,
    topItemName,
  };
}

export type VendorSpendIndex = Map<string, VendorSpend>;

export function computeAllVendorSpend(
  vendors: Vendor[],
  pos: PurchaseOrder[],
  items: Item[],
  now: Date = new Date(),
): VendorSpendIndex {
  const map: VendorSpendIndex = new Map();
  for (const v of vendors) {
    map.set(v.name, computeVendorSpend(v.name, pos, items, now));
  }
  return map;
}

export function totalSpendYTD(index: VendorSpendIndex): number {
  let sum = 0;
  for (const s of index.values()) sum += s.ytd;
  return sum;
}

export function totalSpendAllTime(index: VendorSpendIndex): number {
  let sum = 0;
  for (const s of index.values()) sum += s.allTime;
  return sum;
}

export function topVendorByYTD(index: VendorSpendIndex): VendorSpend | null {
  let top: VendorSpend | null = null;
  for (const s of index.values()) {
    if (!top || s.ytd > top.ytd) top = s;
  }
  return top;
}

export function vendorShareOfYTD(spend: VendorSpend, index: VendorSpendIndex): number {
  const total = totalSpendYTD(index);
  if (total <= 0) return 0;
  return spend.ytd / total;
}

export function recentPOs(
  vendorName: string,
  pos: PurchaseOrder[],
  n: number = 5,
): PurchaseOrder[] {
  return [...pos]
    .filter((p) => p.vendor === vendorName)
    .sort(
      (a, b) =>
        new Date(b.orderedAt).getTime() - new Date(a.orderedAt).getTime(),
    )
    .slice(0, n);
}

export function poExtension(po: PurchaseOrder, items: Item[]): number {
  return poTotal(po, buildItemIndex(items));
}

// Design rule: money renders as full comma-grouped numbers — no k/M
// abbreviations. Both helpers delegate to the app-wide formatter.
export function fmtMoney(n: number): string {
  return formatCurrencyWhole(n);
}

export function fmtMoneyFull(n: number): string {
  return formatCurrencyWhole(n);
}

export function fmtPct(n: number, digits: number = 1): string {
  return `${(n * 100).toFixed(digits)}%`;
}

export function fmtRelativeDate(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  const diffMs = Date.now() - d.getTime();
  const days = Math.floor(diffMs / (1000 * 60 * 60 * 24));
  if (days <= 0) return "today";
  if (days === 1) return "yesterday";
  if (days < 7) return `${days}d ago`;
  if (days < 30) return `${Math.floor(days / 7)}w ago`;
  if (days < 365) return `${Math.floor(days / 30)}mo ago`;
  return `${Math.floor(days / 365)}y ago`;
}
