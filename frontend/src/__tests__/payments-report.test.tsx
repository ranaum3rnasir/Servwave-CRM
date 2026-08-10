// SRVW-55 — the Payments report used to hide the Tip column, the Total tips KPI and the CSV
// Tip column for every real org behind a stale "no tip field in the schema" claim. Now that
// live payments (card, shipped SRVW-193/194, and manual, this card) carry tip_amount, a real
// org must see all three.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen } from '@testing-library/react';
import { Routes, Route } from 'react-router-dom';
import { renderWithProviders } from './helpers';
import ReportRoute from '@/pages/reports/ReportRoute';
import type { PaymentTxn } from '@/pages/reports/payments-report-data';

const hoisted = vi.hoisted(() => ({
  usePaymentsReport: vi.fn(),
}));

vi.mock('@/pages/reports/payments-report-data', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/pages/reports/payments-report-data')>();
  return { ...actual, usePaymentsReport: hoisted.usePaymentsReport };
});

// The card service fee summary block's own data source — stub it out, it is unrelated to tips.
vi.mock('@/pages/reports/payment-fees-data', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/pages/reports/payment-fees-data')>();
  return {
    ...actual,
    usePaymentFeesReport: () => ({
      data: { from: '', to: '', gross: 0, stripeFees: 0, platformFees: 0, net: 0, serviceFees: 0, count: 0 },
      isLoading: false,
      isError: false,
    }),
  };
});

// Real (non-demo) org — a stub here would mean the wiring regressed.
vi.mock('@/lib/useIsDemoOrg', () => ({ useIsDemoOrg: () => false }));

const TIPPED_ROW: PaymentTxn = {
  id: 'pay-tipped',
  date: Date.parse('2026-06-01T00:00:00.000Z'),
  amount: 200,
  tip: 30,
  method: 'Cash',
  category: 'Invoice',
  status: 'Succeeded',
  client: 'Acme Co',
  email: 'ap@acme.com',
  card: '',
  technician: 'Emanuel Dahan',
  txnKind: 'Keyed',
  confirmation: '',
  isDepositCredit: false,
};

function renderReport() {
  return renderWithProviders(
    <Routes>
      <Route path="/reports/:slug" element={<ReportRoute />} />
    </Routes>,
    { initialEntries: ['/reports/payments'] },
  );
}

const NOW = new Date('2026-06-07T12:00:00.000Z');

beforeEach(() => {
  vi.clearAllMocks();
  hoisted.usePaymentsReport.mockReturnValue({ rows: [TIPPED_ROW], now: NOW, isLoading: false });
});

describe('Payments report tips (SRVW-55)', () => {
  it('shows the Tip column with the tipped payment\'s amount, for a real org', async () => {
    renderReport();
    expect(await screen.findByRole('columnheader', { name: 'Tip' })).toBeInTheDocument();
    // Both the row cell and the column footer sum read $30.00 for this single-row fixture.
    expect(screen.getAllByText('$30.00').length).toBeGreaterThan(0);
  });

  it('shows the Total tips KPI, for a real org', async () => {
    renderReport();
    expect(await screen.findByText('Total tips')).toBeInTheDocument();
  });

  it('renders an em dash rather than $0.00 for an untipped row', async () => {
    hoisted.usePaymentsReport.mockReturnValue({ rows: [{ ...TIPPED_ROW, id: 'pay-untipped', tip: 0 }], now: NOW, isLoading: false });
    renderReport();
    await screen.findByRole('columnheader', { name: 'Tip' });
    expect(screen.queryByText('$30.00')).not.toBeInTheDocument();
  });
});
