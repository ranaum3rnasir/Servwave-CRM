import { describe, it, expect } from 'vitest';
import { buildArAging, daysLateFor, computeDso, DSO_WINDOW_DAYS, NET_TERMS_DAYS, type ArInvoiceRow } from "../services/ar-aging-report";

const NOW = new Date('2026-06-19T12:00:00.000Z');

function row(over: Partial<ArInvoiceRow>): ArInvoiceRow {
  return {
    invoiceNumber: 'I00001',
    amountDue: 100,
    dueDate: null,
    sentAt: null,
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    customerId: 'cust-1',
    customerName: 'Acme Co',
    segment: 'Commercial',
    ...over,
  };
}

describe('daysLateFor', () => {
  it('uses due_date when present', () => {
    // due 10 days before now → 10 days late
    const r = row({ dueDate: new Date('2026-06-09T00:00:00.000Z') });
    expect(daysLateFor(r, NOW)).toBe(10);
  });

  it('is negative (not yet due) for a future due date → frontend buckets as current', () => {
    const r = row({ dueDate: new Date('2026-06-29T00:00:00.000Z') });
    expect(daysLateFor(r, NOW)).toBe(-10);
  });

  it('falls back to sent_at + net terms when no due_date', () => {
    // sent 40 days ago, +30 net terms → due 10 days ago → 10 late
    const r = row({ sentAt: new Date('2026-05-10T00:00:00.000Z'), dueDate: null });
    expect(daysLateFor(r, NOW)).toBe(40 - NET_TERMS_DAYS);
  });

  it('falls back to created_at + net terms when no due_date or sent_at', () => {
    const r = row({ createdAt: new Date('2026-05-10T00:00:00.000Z'), sentAt: null, dueDate: null });
    expect(daysLateFor(r, NOW)).toBe(40 - NET_TERMS_DAYS);
  });
});

describe('buildArAging', () => {
  it('groups invoices by customer into accounts', () => {
    const rows = [
      row({ invoiceNumber: 'I1', customerId: 'a', customerName: 'A', amountDue: 100 }),
      row({ invoiceNumber: 'I2', customerId: 'a', customerName: 'A', amountDue: 200 }),
      row({ invoiceNumber: 'I3', customerId: 'b', customerName: 'B', amountDue: 50 }),
    ];
    const accounts = buildArAging(rows, NOW);
    expect(accounts).toHaveLength(2);
    expect(accounts.find((x) => x.id === 'a')?.invoices).toHaveLength(2);
    expect(accounts.find((x) => x.id === 'b')?.invoices).toHaveLength(1);
  });

  it('carries segment as the account type', () => {
    const accounts = buildArAging([row({ segment: 'Residential' })], NOW);
    expect(accounts[0]?.type).toBe('Residential');
  });

  it('sorts accounts by total balance descending, invoices within too', () => {
    const rows = [
      row({ invoiceNumber: 'I1', customerId: 'small', customerName: 'Small', amountDue: 100 }),
      row({ invoiceNumber: 'I2', customerId: 'big', customerName: 'Big', amountDue: 300 }),
      row({ invoiceNumber: 'I3', customerId: 'big', customerName: 'Big', amountDue: 900 }),
    ];
    const accounts = buildArAging(rows, NOW);
    expect(accounts.map((a) => a.id)).toEqual(['big', 'small']);
    expect(accounts[0]?.invoices.map((i) => i.number)).toEqual(['I3', 'I2']); // 900 before 300
  });

  it('drops non-outstanding invoices defensively (amountDue <= 0)', () => {
    const accounts = buildArAging([row({ amountDue: 0 }), row({ invoiceNumber: 'I9', amountDue: 5 })], NOW);
    expect(accounts).toHaveLength(1);
    expect(accounts[0]?.invoices).toHaveLength(1);
  });

  it('omits location when absent, includes it when present', () => {
    const accounts = buildArAging(
      [
        row({ invoiceNumber: 'I1', customerId: 'a', location: null }),
        row({ invoiceNumber: 'I2', customerId: 'a', location: 'Maple Tower', amountDue: 999 }),
      ],
      NOW,
    );
    const invs = accounts[0]!.invoices;
    expect(invs.find((i) => i.number === 'I2')?.location).toBe('Maple Tower');
    expect(invs.find((i) => i.number === 'I1')).not.toHaveProperty('location');
  });
});

describe('buildArAging location passthrough', () => {
  const base = {
    invoiceNumber: 'I00100', amountDue: 500,
    dueDate: new Date('2026-04-01'), sentAt: null, createdAt: new Date('2026-03-01'),
    customerId: 'c1', customerName: 'Smith, John', segment: 'Residential' as const,
  };

  it('carries a location through to the invoice row', () => {
    const [acct] = buildArAging([{ ...base, location: '218 Wallis Rd, Rye, NH 03870' }], new Date('2026-05-01'));
    expect(acct!.invoices[0]!.location).toBe('218 Wallis Rd, Rye, NH 03870');
  });

  it('omits location when the invoice has no job-linked address', () => {
    const [acct] = buildArAging([{ ...base, location: null }], new Date('2026-05-01'));
    expect(acct!.invoices[0]!.location).toBeUndefined();
  });
});

describe('computeDso', () => {
  it('uses a 90-day window by default', () => {
    expect(DSO_WINDOW_DAYS).toBe(90);
  });

  it('returns (AR / sales) * window days, rounded', () => {
    expect(computeDso(100_000, 400_000)).toBe(23); // 22.5 → 23
  });

  it('returns the full window when AR equals sales', () => {
    expect(computeDso(50_000, 50_000)).toBe(90);
  });

  it('returns null when there are no sales in the window', () => {
    expect(computeDso(100_000, 0)).toBeNull();
  });

  it('returns null rather than a negative for nonsensical sales', () => {
    expect(computeDso(100_000, -5)).toBeNull();
  });

  it('returns 0 when nothing is outstanding', () => {
    expect(computeDso(0, 400_000)).toBe(0);
  });

  it('honours a custom window', () => {
    expect(computeDso(100_000, 400_000, 30)).toBe(8);
  });

  // Regression lock on the real numbers from the B&G cutover clone.
  it('reproduces the verified B&G figure', () => {
    expect(computeDso(276_854, 972_833)).toBe(26);
  });
});
