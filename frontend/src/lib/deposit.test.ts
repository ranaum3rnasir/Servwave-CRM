import { describe, it, expect } from 'vitest';
import { resolveDeposit, amountFromPercent, percentFromAmount, round2 } from './deposit';

const ORG = {
  deposit_default_type: 'PERCENTAGE' as const,
  deposit_default_percentage: 50,
  deposit_default_fixed_amount: 0,
};

describe('resolveDeposit', () => {
  it('prefers the estimate override over the org default', () => {
    // The regression this file exists for: SendEstimateDialog used to read org defaults only, so
    // this estimate previewed $53.32 (50%) and the send charged $74.64 (70%).
    const d = resolveDeposit(
      { deposit_type: 'PERCENTAGE', deposit_value: 70, total_amount: '106.63' },
      ORG,
    );
    expect(d.type).toBe('PERCENTAGE');
    expect(d.amount).toBe(74.64);
    expect(d.percent).toBe(70);
  });

  it('falls back to the org default when the estimate has no override', () => {
    const d = resolveDeposit({ total_amount: 1000 }, ORG);
    expect(d.amount).toBe(500);
    expect(d.percent).toBe(50);
  });

  it('needs BOTH override fields - a type with no value still falls back to the org default', () => {
    const d = resolveDeposit(
      { deposit_type: 'FIXED', deposit_value: null, total_amount: 1000 },
      ORG,
    );
    // hasOverride is false, so the ORG's type wins too, not the estimate's dangling FIXED.
    expect(d.type).toBe('PERCENTAGE');
    expect(d.amount).toBe(500);
  });

  it('caps a FIXED deposit at the estimate total', () => {
    const d = resolveDeposit(
      { deposit_type: 'FIXED', deposit_value: 900, total_amount: 400 },
      ORG,
    );
    expect(d.amount).toBe(400);
    expect(d.percent).toBe(100);
  });

  it('reports an effective percentage for a FIXED deposit', () => {
    const d = resolveDeposit(
      { deposit_type: 'FIXED', deposit_value: 250, total_amount: 1000 },
      ORG,
    );
    expect(d.type).toBe('FIXED');
    expect(d.amount).toBe(250);
    expect(d.percent).toBe(25);
  });

  it('defaults to 50% when the org row has no deposit columns at all', () => {
    const d = resolveDeposit({ total_amount: 200 }, null);
    expect(d.amount).toBe(100);
  });

  it('honours an org default of 0% rather than treating it as unset', () => {
    // Backend uses `?? 50`, not `|| 50` - a deliberate 0% org default must survive.
    const d = resolveDeposit(
      { total_amount: 1000 },
      { ...ORG, deposit_default_percentage: 0 },
    );
    expect(d.amount).toBe(0);
  });

  it('never produces NaN on a zero or missing total', () => {
    expect(resolveDeposit({ total_amount: 0 }, ORG)).toEqual({ type: 'PERCENTAGE', amount: 0, percent: 0 });
    expect(resolveDeposit({ total_amount: null }, ORG).amount).toBe(0);
    expect(resolveDeposit({ total_amount: 'not a number' }, ORG).amount).toBe(0);
  });
});

describe('percent/amount conversion', () => {
  it('rounds the derived amount to cents', () => {
    // 106.63 * 0.7 = 74.64095555550224 in float - the raw value that reached the input and the
    // POST body before this helper existed.
    expect(amountFromPercent(106.63, 70)).toBe(74.64);
  });

  it('keeps the derived percentage legible rather than exact', () => {
    // 40 / 106.63 * 100 = 37.512895... - shown as 37.51, not 37.5129, because this lands in an
    // input the user reads.
    expect(percentFromAmount(106.63, 40)).toBe(37.51);
    expect(percentFromAmount(106.63, 500)).toBe(468.91);
  });

  it('round-trips a typed dollar amount back to itself', () => {
    const pct = percentFromAmount(106.63, 40);
    expect(amountFromPercent(106.63, pct)).toBe(40);
  });

  it('returns 0 rather than Infinity/NaN when the total is 0', () => {
    expect(percentFromAmount(0, 50)).toBe(0);
    expect(amountFromPercent(0, 50)).toBe(0);
  });

  it('round2 handles float noise in both directions', () => {
    expect(round2(74.64095555550224)).toBe(74.64);
    expect(round2(0.1 + 0.2)).toBe(0.3);
  });
});
