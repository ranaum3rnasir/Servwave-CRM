import { useState } from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { RecordPaymentDialog } from '@/components/invoices/RecordPaymentDialog';

const createJobInvoice = vi.fn();
vi.mock('@/lib/api/jobs', async (orig) => ({
  ...(await orig<typeof import('@/lib/api/jobs')>()),
  createJobInvoice: (...a: unknown[]) => createJobInvoice(...a),
}));
const post = vi.fn();
vi.mock('@/lib/axios', () => ({ default: { post: (...a: unknown[]) => post(...a) } }));

const renderDialog = (props = {}) => {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <RecordPaymentDialog
        open onOpenChange={vi.fn()} invoiceId="inv-1" invoiceNumber="I00001"
        amountDue={900} onSuccess={vi.fn()} {...props}
      />
    </QueryClientProvider>,
  );
};

beforeEach(() => {
  createJobInvoice.mockReset().mockResolvedValue({ invoice: { id: 'inv-new', invoice_number: 'I00031' } });
  post.mockReset().mockResolvedValue({ data: {} });
});

describe('RecordPaymentDialog', () => {
  it('defaults the amount to the invoice balance', async () => {
    renderDialog();
    expect(await screen.findByLabelText(/amount/i)).toHaveValue(900);
  });

  it('offers every payment method the API accepts (R5b shared list)', async () => {
    renderDialog();
    // Radix Select only mounts its listbox once opened — open it before querying options.
    await userEvent.click(await screen.findByRole('combobox'));
    // getByText would throw here — "Credit Card" and "External Credit Card Processor" both
    // match /card/i. Query by option role and exact name instead.
    for (const label of [
      'Cash', 'Check', 'Credit Card', 'External Credit Card Processor',
      'Bank Transfer (ACH)', 'Zelle', 'Venmo', 'Cash App', 'Other',
    ]) {
      expect(await screen.findByRole('option', { name: label })).toBeInTheDocument();
    }
    // The processor behind card payments is never named to the user (Ran, 2026-08-04).
    expect(screen.queryByText(/stripe/i)).not.toBeInTheDocument();
  });

  // #843: the API still allows an overpayment and the UI still must not refuse it - the amount
  // input has no `max`. What changed is that the surplus is no longer SILENT: it has to be
  // acknowledged first, and then the full over-amount POSTs unchanged.
  it('accepts an amount above the balance once the overpayment is acknowledged', async () => {
    renderDialog();
    const input = await screen.findByLabelText(/amount/i);
    await userEvent.clear(input);
    await userEvent.type(input, '1200');
    await userEvent.click(screen.getByRole('checkbox'));
    await userEvent.click(screen.getByRole('button', { name: /record payment/i }));
    expect(post).toHaveBeenCalledWith('/api/invoices/inv-1/payments', expect.objectContaining({ amount: 1200 }));
  });

  it('blocks the submit until the overpayment is acknowledged, and never caps the input', async () => {
    renderDialog();
    const input = await screen.findByLabelText(/amount/i);
    await userEvent.clear(input);
    await userEvent.type(input, '1200');
    // The typed over-amount is kept verbatim - capping it would refuse a true statement about
    // money that changed hands.
    expect(input).toHaveValue(1200);
    expect(input).not.toHaveAttribute('max');
    expect(screen.getByRole('button', { name: /record payment/i })).toBeDisabled();
    expect(post).not.toHaveBeenCalled();
  });

  // The composite path creates the invoice FOR the typed amount, so amountDue is always 0 and an
  // overpayment is impossible. Gating it there would demand an acknowledgement of a nonsensical
  // "more than the $0.00 balance due" on every on-site urgent-workflow collection.
  it('never gates the no-invoice composite path behind an overpayment acknowledgement', async () => {
    renderDialog({ invoiceId: null, jobId: 'job-1', amountDue: 0 });
    const input = await screen.findByLabelText(/amount/i);
    await userEvent.clear(input);
    await userEvent.type(input, '600');

    expect(screen.queryByRole('checkbox')).not.toBeInTheDocument();
    expect(screen.queryByText(/overpayment of/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/Balance due:/)).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /record payment/i })).toBeEnabled();
  });

  it('with NO invoice, says plainly it will create one, then creates → sends → pays in order', async () => {
    renderDialog({ invoiceId: null, jobId: 'job-1', amountDue: 0 });
    expect(await screen.findByText(/will create an invoice/i)).toBeInTheDocument();

    const input = screen.getByLabelText(/amount/i);
    await userEvent.clear(input);
    await userEvent.type(input, '600');
    await userEvent.click(screen.getByRole('button', { name: /record payment/i }));

    expect(createJobInvoice).toHaveBeenCalledWith('job-1', expect.objectContaining({ amount: 600 }));
    // The send is what keeps the lifecycle bar truthful — without it sent_at stays null and the
    // Invoice Sent node offers to create a SECOND invoice on a job already invoiced and paid.
    expect(post).toHaveBeenCalledWith('/api/invoices/inv-new/send', expect.anything());
    expect(post).toHaveBeenCalledWith('/api/invoices/inv-new/payments', expect.objectContaining({ amount: 600 }));
  });

  it('names the created invoice when the payment call fails, so the user does not create a second', async () => {
    post.mockImplementation((url: string) => (url.endsWith('/payments')
      ? Promise.reject(new Error('boom'))
      : Promise.resolve({ data: {} })));
    renderDialog({ invoiceId: null, jobId: 'job-1', amountDue: 0 });
    const input = await screen.findByLabelText(/amount/i);
    await userEvent.clear(input);
    await userEvent.type(input, '600');
    await userEvent.click(screen.getByRole('button', { name: /record payment/i }));
    expect(await screen.findByText(/I00031 was created/i)).toBeInTheDocument();
  });

  it('withholds the composite path when the customer holds a paid deposit', async () => {
    renderDialog({ invoiceId: null, jobId: 'job-1', amountDue: 0, hasUnspentDeposit: true });
    expect(await screen.findByText(/deposit/i)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /record payment/i })).not.toBeInTheDocument();
  });

  it('closes the dialog after the composite (no-invoice) path succeeds, so a second click cannot double-bill', async () => {
    const onOpenChange = vi.fn();
    renderDialog({ invoiceId: null, jobId: 'job-1', amountDue: 0, onOpenChange });
    const input = await screen.findByLabelText(/amount/i);
    await userEvent.clear(input);
    await userEvent.type(input, '600');
    await userEvent.click(screen.getByRole('button', { name: /record payment/i }));

    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
  });

  // SRVW-55 — tip chips + custom, mirroring PublicInvoicePage.
  describe('tip (SRVW-55)', () => {
    it('shows the tip section unconditionally, for every payment method (D1)', async () => {
      renderDialog();
      expect(await screen.findByText(/add a tip\?/i)).toBeInTheDocument();

      await userEvent.click(screen.getByRole('combobox'));
      await userEvent.click(await screen.findByRole('option', { name: 'Bank Transfer (ACH)' }));
      expect(screen.getByText(/add a tip\?/i)).toBeInTheDocument();

      await userEvent.click(screen.getByRole('combobox'));
      await userEvent.click(await screen.findByRole('option', { name: 'Check' }));
      expect(screen.getByText(/add a tip\?/i)).toBeInTheDocument();
    });

    it('selecting 15% on a $200 amount posts tip_amount: 30', async () => {
      renderDialog({ amountDue: 200 });
      await screen.findByLabelText(/amount/i);
      await userEvent.click(screen.getByRole('radio', { name: /15%/ }));
      await userEvent.click(screen.getByRole('button', { name: /record payment/i }));

      expect(post).toHaveBeenCalledWith('/api/invoices/inv-1/payments', expect.objectContaining({ tip_amount: 30 }));
    });

    it('"Other" posts the typed dollars verbatim', async () => {
      renderDialog({ amountDue: 200 });
      await screen.findByLabelText(/amount/i);
      await userEvent.click(screen.getByRole('radio', { name: 'Other' }));
      const tipInput = await screen.findByLabelText(/tip amount/i);
      await userEvent.type(tipInput, '17.50');
      await userEvent.click(screen.getByRole('button', { name: /record payment/i }));

      expect(post).toHaveBeenCalledWith('/api/invoices/inv-1/payments', expect.objectContaining({ tip_amount: 17.5 }));
    });

    it('no selection posts no tip_amount key at all', async () => {
      renderDialog({ amountDue: 200 });
      await screen.findByLabelText(/amount/i);
      await userEvent.click(screen.getByRole('button', { name: /record payment/i }));

      const call = post.mock.calls.find(([url]) => url === '/api/invoices/inv-1/payments');
      // axios/JSON.stringify drop an undefined-valued key on the wire - assert the value, not
      // key presence, since `{ tip_amount: undefined }` still satisfies `toHaveProperty`.
      expect(call[1].tip_amount).toBeUndefined();
    });

    it('recomputes the tip when the amount changes after a chip is selected', async () => {
      // A high balance keeps the amount change below amountDue, so this test exercises only the
      // tip recompute - not the unrelated overpayment acknowledgement gate.
      renderDialog({ amountDue: 1000 });
      const input = await screen.findByLabelText(/amount/i);
      await userEvent.click(screen.getByRole('radio', { name: /15%/ }));
      await userEvent.clear(input);
      await userEvent.type(input, '400');
      await userEvent.click(screen.getByRole('button', { name: /record payment/i }));

      // 15% of the now-$400 amount is $60, not the $150 the chip showed at $1000.
      expect(post).toHaveBeenCalledWith('/api/invoices/inv-1/payments', expect.objectContaining({ tip_amount: 60 }));
    });

    it('a tip does not arm the overpayment gate', async () => {
      renderDialog({ amountDue: 200 });
      const input = await screen.findByLabelText(/amount/i);
      await userEvent.clear(input);
      await userEvent.type(input, '200');
      await userEvent.click(screen.getByRole('radio', { name: /20%/ }));

      expect(screen.queryByRole('checkbox')).not.toBeInTheDocument();
      expect(screen.queryByText(/overpayment of/i)).not.toBeInTheDocument();
      expect(screen.getByRole('button', { name: /record payment/i })).toBeEnabled();

      await userEvent.click(screen.getByRole('button', { name: /record payment/i }));
      expect(post).toHaveBeenCalledWith('/api/invoices/inv-1/payments', expect.objectContaining({ amount: 200, tip_amount: 40 }));
    });

    it('carries tip_amount through the composite path\'s third (payment) request', async () => {
      renderDialog({ invoiceId: null, jobId: 'job-1', amountDue: 0 });
      const input = await screen.findByLabelText(/amount/i);
      await userEvent.clear(input);
      await userEvent.type(input, '200');
      await userEvent.click(screen.getByRole('radio', { name: /10%/ }));
      await userEvent.click(screen.getByRole('button', { name: /record payment/i }));

      // Step 1 (create) must NOT be inflated by the tip - it is not part of the invoice.
      expect(createJobInvoice).toHaveBeenCalledWith('job-1', expect.objectContaining({ amount: 200 }));
      expect(post).toHaveBeenCalledWith('/api/invoices/inv-new/payments', expect.objectContaining({ amount: 200, tip_amount: 20 }));
    });

    it('clears the tip when the dialog is closed (Cancel) and reopened', async () => {
      const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
      const Wrapper = () => {
        const [open, setOpen] = useState(true);
        return (
          <QueryClientProvider client={qc}>
            <button onClick={() => setOpen(true)}>Reopen</button>
            <RecordPaymentDialog
              open={open} onOpenChange={setOpen} invoiceId="inv-1" invoiceNumber="I00001"
              amountDue={200} onSuccess={vi.fn()}
            />
          </QueryClientProvider>
        );
      };
      render(<Wrapper />);

      await userEvent.click(await screen.findByRole('radio', { name: /15%/ }));
      await userEvent.click(screen.getByRole('button', { name: /cancel/i }));
      await userEvent.click(screen.getByRole('button', { name: /reopen/i }));

      // Reopened on the same mounted instance - the 15% chip must no longer read as selected.
      expect(await screen.findByRole('radio', { name: /15%/ })).toHaveAttribute('aria-checked', 'false');
    });
  });
});
