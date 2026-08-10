/**
 * money — tiny shared numeric helpers for the Card A / totals stack (v12 review fix L6).
 *
 * `toNum`/`netOf` were duplicated byte-identically across TotalsFooter/LineItemsTable/
 * LineItemRow/ReceiptCard/InternalCostsCard/AddLineDialog/InvoiceReceiptCard/EstimateReceiptCard.
 * Extracted here so there is one implementation to read and change. Pure functions, no imports,
 * no behavior change from any of the copies they replace.
 */

/** Parses a possibly-string/null/undefined numeric field. Invalid input → 0. */
export function toNum(v: string | number | null | undefined): number {
  if (v == null) return 0;
  const n = typeof v === 'string' ? parseFloat(v) : v;
  return Number.isNaN(n) ? 0 : n;
}

/** The minimal line shape `netOf` needs — structurally satisfied by InvoiceLineItem/EstimateLineItem. */
export interface NetOfLine {
  line_total: string | number | null | undefined;
  discount_amount: string | number | null | undefined;
}

/** Net-of-line-discount revenue for one line (line_total − discount_amount, floored at 0). */
export function netOf(line: NetOfLine): number {
  return Math.max(0, toNum(line.line_total) - toNum(line.discount_amount));
}
