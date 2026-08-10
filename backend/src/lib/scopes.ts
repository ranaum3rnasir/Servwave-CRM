/**
 * Shared scope-of-work helpers. Job.scopes and Invoice.scopes (schema.prisma) are both a raw
 * JSONB column storing an array of flat-priced, non-line-item blocks — narrative scope-of-work
 * text with an optional flat price, distinct from a quantity-priced InvoiceLineItem/job line.
 *
 * GOTCHA every consumer must guard: a JSONB column reads back as `null`, not `[]`, when no
 * scope has ever been added (Prisma doesn't materialize an empty array for an unset Json? column)
 * — always route a raw column read through asScopeArray() rather than assuming it's an array.
 */
import type { Request } from 'express';
import type { ScopeForTotals } from './invoice-totals';
import { canSeePricing } from './permissions/enforce';

export interface ScopeOfWork {
  id: string;
  title: string;
  body: string;
  flat_price: number | null;
  is_taxable: boolean;
  internal_cost: number | null;
}

/** Guards the JSONB-reads-as-null-when-empty gotcha: always returns an array. */
export function asScopeArray(raw: unknown): ScopeOfWork[] {
  return Array.isArray(raw) ? (raw as ScopeOfWork[]) : [];
}

/** Maps stored scopes to the calculator's flat-priced-block shape (invoice-totals.ts). */
export function toScopeForTotals(scopes: ScopeOfWork[]): ScopeForTotals[] {
  return scopes.map((s) => ({ flat_price: s.flat_price, is_taxable: s.is_taxable }));
}

/** A copy of each scope with internal_cost (margin data) omitted — for low-privilege responses. */
export function stripScopeCost(scopes: ScopeOfWork[]): Omit<ScopeOfWork, 'internal_cost'>[] {
  return scopes.map(({ internal_cost: _internalCost, ...rest }) => rest);
}

/**
 * A copy of each scope with BOTH cost and sell price omitted — for a requester who cannot
 * `read Invoice` (D13, Spec A). Distinct from stripScopeCost, which drops cost only and is
 * called UNCONDITIONALLY by invoice-lines.controller.ts and estimate.controller.ts; widening
 * that function would hide flat_price from every user including admins.
 */
export function stripScopeMoney(
  scopes: ScopeOfWork[],
): Omit<ScopeOfWork, 'internal_cost' | 'flat_price'>[] {
  return scopes.map(({ internal_cost: _internalCost, flat_price: _flatPrice, ...rest }) => rest);
}

/**
 * Cost/margin strip shared by Invoice and Estimate detail-shaped responses - internal_cost
 * (scope margin), unit_cost/markup_percent (line margin) and the labor_hours/overhead_mode/
 * overhead_value cost model (D2/D8). Strips the KEY, absent rather than null, mirroring
 * stripLinePricing.
 *
 * SRVW-140 - one policy for both entities: `stripInvoiceCost` (invoice.controller.ts) and
 * `stripEstimateCost` (estimate.controller.ts) were a token-for-token clone of this body, which
 * meant a future field added to the cost model - or a change from key-delete to null - could land
 * in one copy and silently leak from the other. Both are now thin aliases of this function.
 */
export function stripDocumentCost<T extends { scopes?: unknown; line_items?: Array<Record<string, unknown>> }>(
  doc: T,
  req: Request,
): T {
  if (canSeePricing(req)) return doc;
  const out: Record<string, unknown> = {
    ...doc,
    scopes: stripScopeCost(asScopeArray(doc.scopes)),
    // Defensive `?? []`: every real detail-shaped response always carries line_items, but a
    // caller whose select or fixture omits it should simply have nothing to strip rather than 500.
    line_items: (doc.line_items ?? []).map((line) => {
      const l = { ...line };
      delete l.unit_cost;
      delete l.markup_percent;
      return l;
    }),
  };
  delete out.labor_hours;
  delete out.overhead_mode;
  delete out.overhead_value;
  return out as T;
}
