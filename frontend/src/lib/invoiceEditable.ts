/**
 * Invoice edit-lock policy (P2) — frontend mirror of backend `lib/invoice-editable.ts`.
 * An invoice stays editable until it is settled: DRAFT, SENT, and PARTIAL are editable (a partial
 * payment does NOT lock it); PAID / VOIDED / REFUNDED / PARTIALLY_REFUNDED / DISPUTED are read-only.
 */
export const LOCKED_INVOICE_STATUSES = [
  'PAID',
  'VOIDED',
  'REFUNDED',
  'PARTIALLY_REFUNDED',
  'DISPUTED',
] as const;

export function isInvoiceEditable(status: string): boolean {
  return !(LOCKED_INVOICE_STATUSES as readonly string[]).includes(status);
}
