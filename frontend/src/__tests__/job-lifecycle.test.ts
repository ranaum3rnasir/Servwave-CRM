import { computeLifecycle, isPaidOff } from '@/lib/jobs/lifecycle';

it('marks earlier stages reached when a later timestamp exists (monotonic)', () => {
  const stages = computeLifecycle(
    { created_at: '2026-05-01T00:00:00Z', scheduled_start: '2026-05-10T14:00:00Z', on_site_at: '2026-05-10T14:05:00Z', completed_at: null, status: 'ON_SITE', cancelled_at: null },
    { final_invoice: null },
  );
  const by = Object.fromEntries(stages.map((s) => [s.key, s]));
  expect(by.created.reached).toBe(true);
  expect(by.scheduled.reached).toBe(true);
  expect(by.on_site.reached).toBe(true);
  expect(by.on_site.current).toBe(true);     // latest reached = current
  expect(by.completed.reached).toBe(false);
});

it('lights invoice_sent and payment_received from the final invoice', () => {
  const stages = computeLifecycle(
    { created_at: 'x', completed_at: 'y', status: 'COMPLETED', cancelled_at: null },
    { final_invoice: { sent_at: '2026-05-11T00:00:00Z', paid_at: '2026-05-12T00:00:00Z', status: 'PAID', amount_due: '0' } },
  );
  const by = Object.fromEntries(stages.map((s) => [s.key, s]));
  expect(by.invoice_sent.reached).toBe(true);
  expect(by.payment_received.reached).toBe(true);
});

it('does NOT light payment_received when the invoice is sent but unpaid', () => {
  const stages = computeLifecycle(
    { created_at: 'x', completed_at: 'y', status: 'COMPLETED', cancelled_at: null },
    { final_invoice: { sent_at: '2026-05-11T00:00:00Z', paid_at: null, status: 'SENT', amount_due: '500' } },
  );
  const by = Object.fromEntries(stages.map((s) => [s.key, s]));
  expect(by.invoice_sent.reached).toBe(true);
  expect(by.payment_received.reached).toBe(false);
  expect(by.invoice_sent.current).toBe(true);
});

it('freezes the bar and reports cancellation (no current node)', () => {
  const stages = computeLifecycle({ created_at: 'x', scheduled_start: 'y', status: 'CANCELLED', cancelled_at: 'z' }, { final_invoice: null });
  expect(stages.some((s) => s.current)).toBe(false);
});

// isPaidOff (final-review fix): standalone export so JobDetailPage's payment_received
// interactivity gate can reuse the SAME signal computeLifecycle uses, without re-deriving the
// hasTotals/fallback logic or paying for the whole stage pipeline.
describe('isPaidOff', () => {
  it('is false when a balance remains under the aggregate totals', () => {
    expect(isPaidOff({ final_invoice: null, total_invoiced: 1000, total_paid: 600 })).toBe(false);
  });

  it('is true once total_paid meets total_invoiced', () => {
    expect(isPaidOff({ final_invoice: null, total_invoiced: 1000, total_paid: 1000 })).toBe(true);
  });

  it('is true on an overpayment', () => {
    expect(isPaidOff({ final_invoice: null, total_invoiced: 1000, total_paid: 1100 })).toBe(true);
  });

  it('is false for an uninvoiced job (the 0 >= 0 trap)', () => {
    expect(isPaidOff({ final_invoice: null, total_invoiced: 0, total_paid: 0 })).toBe(false);
  });

  it('falls back to final_invoice.status when the totals are stripped (price-blind requester)', () => {
    expect(isPaidOff({ final_invoice: { status: 'PAID' } })).toBe(true);
    expect(isPaidOff({ final_invoice: { status: 'SENT', amount_due: '500' } })).toBe(false);
    expect(isPaidOff({ final_invoice: { status: 'SENT', amount_due: '0' } })).toBe(true);
  });

  it('is false with no financials at all', () => {
    expect(isPaidOff(undefined)).toBe(false);
    expect(isPaidOff(null)).toBe(false);
  });
});
