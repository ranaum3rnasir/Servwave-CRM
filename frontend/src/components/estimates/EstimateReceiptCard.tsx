/**
 * EstimateReceiptCard — the Estimate workspace's thin wrapper around the shared `<ReceiptCard>`
 * (v12 unified line-items, plan §3 "FIX/CONSOLIDATE Card A" + §4 Estimate). Card B is the
 * separate, staff-only `<InternalCostsCard>` (shared with Job/Invoice), rendered as its own
 * sibling by the page — mirrors `InvoiceReceiptCard.tsx`'s split exactly.
 *
 * Replaces the "Totals" third of the old three-way `InfoPanel.tsx` split. Every headline figure
 * is SERVER-AUTHORITATIVE (estimate.subtotal/tax_amount/total_amount/discount_amount — the
 * granular line/scope endpoints already recompute + persist these, per `lib/api/estimates.ts`'s
 * own header comment), so this wrapper does NOT re-derive totals client-side the way the old
 * `InfoPanel`'s `computeTotals()` did. The one exception is the "Line items"/"Scope of work"
 * breakdown rows, derived from `estimate.line_items`/`estimate.scopes` — mirrors
 * `InvoiceReceiptCard.tsx`'s identical `netOf`-based derivation.
 *
 * DEPOSIT (the Estimate-only extension `<ReceiptCard variant="estimate">` was built for): mirrors
 * the old `InfoPanel`'s pre-send/post-send split —
 *   - Pre-send: `deposit_type`/`deposit_value` are a live, editable override — including the
 *     %/$ mode toggle (review fix M1/B8), matching the old `SetDepositDialog`'s percent/fixed-
 *     amount toggle and the Ran-approved DDR §3 ("Deposit due now — editable %/$"). Toggling the
 *     mode re-commits the currently-displayed number under the new unit (no auto-conversion),
 *     same behavior the old dialog had.
 *   - Post-send: the real charged numbers are frozen in `send_config.deposit_amount`/
 *     `deposit_percentage` — display-only from there on (§G), matching the old card's identical
 *     `depositSent` gate.
 * Backend note (B8): `send()`/`recordEstimatePayment()` still need to read the estimate's own
 * `deposit_type`/`deposit_value` (PRD §13.7) instead of org defaults — this wrapper's job is only
 * to genuinely PERSIST the chosen type/value so that backend rewire has real data to read; it does
 * not itself change what gets charged.
 *
 * DISCOUNT: `<ReceiptCard>`'s Discount row also carries the %/$ mode toggle (review fix M1),
 * matching the old `DiscountDialog`'s percent-vs-amount toggle and the DDR's "Discount (editable
 * ✎)" spec — discount edits from this card persist as either `PERCENTAGE` or `FIXED_AMOUNT`
 * (`estimate.discount_type`), not hardcoded to one. TAX RATE reuses `<ReceiptCard>`'s own built-in
 * jurisdiction `<Select>` (identical UI/behavior to the old `InfoPanel`'s tax-rate dropdown).
 * All three call the SAME whole-document `updateEstimate()` PATCH the old card used — discount/tax/
 * deposit are Estimate-row fields, not line/scope rows, so they were never part of the granular
 * line-items migration (that only replaced `line_items`/`scopes` editing).
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ReceiptCard } from '@/components/jobs/items/ReceiptCard';
import { toNum, netOf } from '@/components/jobs/items/money';
import { round2 } from '@/lib/deposit';
import { fetchStateTaxRates } from '@/lib/api/invoices';
import { updateEstimate, type EstimateLineItem, type Scope } from '@/lib/api/estimates';
import { toast } from '@/components/ui/use-toast';
import { extractApiError } from '@/lib/utils';

export interface EstimateReceiptCardEstimate {
  id: string;
  /** Attach FK - when set, this estimate is attached to a job and tax is fixed by the job's service location (read-only). */
  job_id?: string | null;
  subtotal: number | string | null | undefined;
  discount_amount?: number | string | null;
  /** Discount mode — drives the Discount row's $/% toggle (review fix M1). Null/undefined → FIXED_AMOUNT (existing default). */
  discount_type?: 'PERCENTAGE' | 'FIXED_AMOUNT' | null;
  /** Raw discount value in discount_type's own unit (percent number or dollar amount). */
  discount_value?: number | string | null;
  discount_name?: string | null;
  /** Sales-tax rate as a FRACTION (e.g. 0.0663 for 6.63%). */
  tax_rate: number | string | null | undefined;
  tax_amount: number | string | null | undefined;
  total_amount?: number | string | null;
  deposit_type?: 'PERCENTAGE' | 'FIXED' | null;
  deposit_value?: number | string | null;
  send_config?: {
    deposit_percentage?: number | string | null;
    deposit_amount?: number | string | null;
  } | null;
  line_items?: EstimateLineItem[];
  scopes?: Scope[];
  /**
   * #985 - the state the backend derived tax_rate from, so the tax select can name the right
   * jurisdiction when several share the rate. Mirrors `deriveTaxRateFromLead`'s own precedence:
   * the direct service location first, then the lead's denormalized service_state.
   * Both are already on estimateDetailSelect - no API change needed.
   */
  service_location?: { state?: string | null } | null;
  lead?: { service_state?: string | null } | null;
}

export interface EstimateReceiptCardProps {
  estimate: EstimateReceiptCardEstimate;
  /** §A1/A3 lock policy from the page (locked/terminal/not-yet-editable) — same gate the old InfoPanel's `canEdit` used. */
  canEditNow: boolean;
}

/** Quick-select presets for the deposit box — always includes whatever the estimate is actually set to, so the <Select> never shows a value with no matching option. */
const DEPOSIT_PRESETS = [0, 10, 20, 25, 33, 50, 75, 100];

export function EstimateReceiptCard({ estimate, canEditNow }: EstimateReceiptCardProps) {
  const queryClient = useQueryClient();

  const { data: taxRates = [] } = useQuery({
    queryKey: ['state-tax-rates'],
    queryFn: fetchStateTaxRates,
  });

  const saveMutation = useMutation({
    mutationFn: (body: Record<string, unknown>) => updateEstimate(estimate.id, body),
    onSuccess: (res) => {
      // SRVW-103 - merge, never replace: the response has no `tags` key (see
      // EstimateLineItemsEditor's docblock for the full contract).
      if (res?.estimate) {
        queryClient.setQueryData<Record<string, unknown>>(['estimate', estimate.id], (old) => ({
          ...(old ?? {}),
          ...(res.estimate as Record<string, unknown>),
        }));
      }
    },
    onError: (err: unknown) =>
      toast({ title: 'Could not save', description: extractApiError(err, 'Your change was not saved.'), variant: 'destructive' }),
  });

  const lineItemsSubtotal = estimate.line_items?.reduce((sum, l) => sum + netOf(l), 0);
  const scopeSubtotal = estimate.scopes
    ?.filter((s) => s.flat_price != null)
    .reduce((sum, s) => sum + toNum(s.flat_price), 0);

  // Discount — %/$ mode toggle (review fix M1). Null/undefined discount_type defaults to
  // FIXED_AMOUNT, matching the pre-fix hardcoded behavior for estimates that never set one.
  const discountMode: 'PERCENTAGE' | 'FIXED_AMOUNT' = estimate.discount_type === 'PERCENTAGE' ? 'PERCENTAGE' : 'FIXED_AMOUNT';
  // discount_value is the raw number in discountMode's own unit; fall back to the computed
  // discount_amount for estimates saved before discount_value existed.
  const discountRawValue = estimate.discount_value != null ? toNum(estimate.discount_value) : toNum(estimate.discount_amount);

  // Deposit — pre-send it's a live editable override (deposit_type/deposit_value, %/$ toggle —
  // review fix M1/B8); post-send the real numbers are frozen in send_config (mirrors the old
  // InfoPanel's identical split; frozen figures are always shown percent-style, matching send_config's
  // own shape — deposit_percentage/deposit_amount, no mode flag).
  const depositSent = Boolean(estimate.send_config);
  const totalNum = toNum(estimate.total_amount);
  const preSendDepositMode: 'PERCENTAGE' | 'FIXED' = estimate.deposit_type === 'FIXED' ? 'FIXED' : 'PERCENTAGE';
  const preSendRawValue = toNum(estimate.deposit_value);

  const depositPct = depositSent
    ? Math.round(toNum(estimate.send_config?.deposit_percentage))
    : preSendDepositMode === 'PERCENTAGE'
      ? Math.round(preSendRawValue)
      : totalNum > 0
        ? Math.round((preSendRawValue / totalNum) * 100)
        : 0;
  // FIXED mode reads deposit_value directly (not back-derived through the rounded implied
  // percent, which used to lose cents — e.g. $333.33 on a $1,000 total used to round-trip
  // through 33% → $330.00 before this fix).
  const depositDueAmount = depositSent
    ? toNum(estimate.send_config?.deposit_amount)
    : preSendDepositMode === 'FIXED'
      ? round2(preSendRawValue)
      : round2(totalNum * (depositPct / 100));
  const balanceOnCompletion = Math.max(0, round2(totalNum - depositDueAmount));
  const depositPercentOptions = DEPOSIT_PRESETS.includes(depositPct)
    ? DEPOSIT_PRESETS
    : [...DEPOSIT_PRESETS, depositPct].sort((a, b) => a - b);

  // Deposit editing is only available pre-send — once sent, the charged amount is frozen (§G),
  // same gate the old card used (`depositSent`), ANDed with the page's own lock/terminal policy.
  // Frozen (post-send) figures always display percent-style, matching send_config's own shape.
  const depositEditable = canEditNow && !depositSent;
  const displayDepositMode: 'PERCENTAGE' | 'FIXED' = depositSent ? 'PERCENTAGE' : preSendDepositMode;

  // E3 (job-owns-tax-discount) retired the job-anchored tax lock: a job-anchored estimate is a
  // quote, the job is the work, and they may legitimately differ. One flag for BOTH tax props
  // below: `taxRates` without `onTaxRateChange` renders an inert jurisdiction select, so the two
  // must never drift apart.
  const taxEditable = canEditNow;

  return (
    <ReceiptCard
      variant="estimate"
      lineItemsSubtotal={lineItemsSubtotal}
      scopeSubtotal={scopeSubtotal}
      subtotal={toNum(estimate.subtotal)}
      discountAmount={estimate.discount_amount}
      discountMode={discountMode}
      discountRawValue={discountRawValue}
      taxRate={estimate.tax_rate}
      taxAmount={estimate.tax_amount}
      total={toNum(estimate.total_amount)}
      depositDuePercent={depositPct}
      depositDueAmount={depositDueAmount}
      balanceOnCompletion={balanceOnCompletion}
      depositPercentOptions={depositPercentOptions}
      depositMode={displayDepositMode}
      onDepositPercentChange={
        depositEditable ? (pct) => saveMutation.mutate({ deposit_type: 'PERCENTAGE', deposit_value: pct }) : undefined
      }
      onDepositModeChange={
        depositEditable
          ? (mode) => saveMutation.mutate({ deposit_type: mode, deposit_value: preSendRawValue })
          : undefined
      }
      onDepositFixedValueChange={
        depositEditable ? (amount) => saveMutation.mutate({ deposit_type: 'FIXED', deposit_value: amount }) : undefined
      }
      onDiscountChange={
        canEditNow
          ? (amount, mode) =>
              saveMutation.mutate({
                discount_type: mode ?? 'FIXED_AMOUNT',
                discount_value: amount,
                discount_name: estimate.discount_name || 'Discount',
              })
          : undefined
      }
      onTaxRateChange={taxEditable ? (rate) => saveMutation.mutate({ tax_rate: rate }) : undefined}
      taxRates={taxEditable ? taxRates : undefined}
      taxStateCode={estimate.service_location?.state ?? estimate.lead?.service_state ?? null}
    />
  );
}
