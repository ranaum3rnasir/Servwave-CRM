/**
 * deposit - the shared deposit resolution + %/amount conversion model.
 *
 * `resolveDeposit` is a deliberate line-for-line MIRROR of the backend's `resolveDepositAmount`
 * (`backend/src/controllers/estimate.controller.ts`, PRD §13.7 / finding B8). Frontend can't import
 * backend code, so this is a manually-kept-in-sync duplicate, not a re-export - the same pattern
 * `constants/estimateStatus.ts` documents. **If the backend helper changes, change this one too**,
 * and vice versa: the backend one decides what the customer is actually charged, so any divergence
 * shows the user one deposit and bills another.
 *
 * That divergence was real before this file existed: `SendEstimateDialog` computed its preview from
 * the ORG defaults alone, ignoring the estimate's own `deposit_type`/`deposit_value` override (the
 * one the Receipt Card writes), which `resolveDepositAmount` prefers. An estimate overridden to 70%
 * under a 50% org default previewed half of what the send would charge.
 *
 * The percentage/amount converters below are the other half: any surface that shows a deposit as
 * BOTH a % and a dollar figure has to keep the two describing the same deposit, because both get
 * posted (`record-payment` sends `amount` and `deposit_percentage` in one body).
 */

/** Rounds to cents. The only rounding a dollar figure ever gets - floats are not money. */
export function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/** The dollar deposit for a percentage of a total. */
export function amountFromPercent(total: number, percent: number): number {
  if (!(total > 0)) return 0;
  return round2((total * percent) / 100);
}

/**
 * The percentage a dollar deposit represents of a total. A zero/negative total has no percentage.
 *
 * Rounded to 2dp because this value is SHOWN IN AN INPUT the user reads: carrying the full
 * quotient renders $500 of $106.63 as "468.9112" and $40 as "37.5129", which reads like a bug even
 * though it is arithmetically exact. Two decimals is a real trade, not a free one - $333.33 of
 * $1000 becomes 33.33%, which converts back to $333.30. That penny only materialises if the user
 * then edits the PERCENTAGE box (their typed dollar amount is never rewritten underneath them), and
 * the dollar amount is what is actually charged - the backend's own comment calls
 * `deposit_percentage` descriptive only. Legibility wins over a hidden digit nobody can act on.
 */
export function percentFromAmount(total: number, amount: number): number {
  if (!(total > 0)) return 0;
  return round2((amount / total) * 100);
}

export type DepositType = 'PERCENTAGE' | 'FIXED';

export interface DepositEstimateFields {
  deposit_type?: DepositType | null;
  deposit_value?: number | string | null;
  total_amount: number | string | null | undefined;
}

export interface DepositOrgFields {
  deposit_default_type?: DepositType | null;
  deposit_default_percentage?: number | string | null;
  deposit_default_fixed_amount?: number | string | null;
}

export interface ResolvedDeposit {
  type: DepositType;
  /** Dollars. FIXED is capped at the total - you cannot ask for a deposit larger than the job. */
  amount: number;
  /** The EFFECTIVE percentage, always derived from `amount`, including in FIXED mode. */
  percent: number;
}

/**
 * Resolves the deposit to charge for an estimate. Prefers the estimate's own
 * `deposit_type`/`deposit_value` override and falls back to the org's `deposit_default_*` columns
 * only when the estimate has NEITHER set - both must be present for the override to count, matching
 * the backend's `hasOverride` check exactly.
 */
export function resolveDeposit(
  estimate: DepositEstimateFields,
  org: DepositOrgFields | null | undefined,
): ResolvedDeposit {
  const total = Number(estimate.total_amount ?? 0) || 0;
  const hasOverride = estimate.deposit_type != null && estimate.deposit_value != null;

  const type: DepositType = hasOverride
    ? (estimate.deposit_type as DepositType)
    : (org?.deposit_default_type ?? 'PERCENTAGE');

  const rawValue = hasOverride
    ? Number(estimate.deposit_value)
    : type === 'FIXED'
      ? Number(org?.deposit_default_fixed_amount ?? 0)
      : Number(org?.deposit_default_percentage ?? 50);

  const value = Number.isNaN(rawValue) ? 0 : rawValue;
  const rawAmount = type === 'FIXED' ? Math.min(value, total) : (total * value) / 100;

  // The percentage is derived from the UNROUNDED amount, exactly as the backend does. Deriving it
  // from the rounded one instead would report a 70% deposit on $106.63 as 69.9991% - the rounding
  // to cents ($74.6410 -> $74.64) is a display concern that must not leak back into the rate.
  return { type, amount: round2(rawAmount), percent: percentFromAmount(total, rawAmount) };
}
