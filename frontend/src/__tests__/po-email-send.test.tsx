// Inventory P2 §6 (§3.8) — POEmailDialog real send:
//   • To prefills from the vendor record; suggestions come from vendor
//     contacts WITH an email; the old fieldos.io / vendor-domain synthesis is
//     gone from the DOM entirely.
//   • Send posts POST /api/inventory/purchase-orders/:id/send with
//     {to, cc?, subject, message}.
//   • Org email toggle: `email_sending_enabled === false` disables Send with
//     the inline notice; an unreadable org (undefined) must NOT disable — the
//     server 409 is the authority, surfaced as a sticky destructive toast with
//     the dialog left open.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithProviders } from './helpers';
import { POEmailDialog } from '@/components/inventory/POEmailDialog';
import api from '@/lib/axios';
import type { PurchaseOrder } from '@/lib/api/inventory';

const hoisted = vi.hoisted(() => ({
  toast: vi.fn(),
  // Mutable org — tests flip the sending toggle / readability.
  org: { id: 'org-1', name: 'ServWave', email_sending_enabled: true } as
    | { id: string; name: string; email_sending_enabled: boolean }
    | undefined,
}));

vi.mock('@/components/ui/use-toast', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/components/ui/use-toast')>();
  return { ...actual, toast: hoisted.toast };
});

vi.mock('@/lib/api/inventory', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api/inventory')>();
  const vendors = [
    {
      id: 'vnd-adi',
      name: 'ADI / Anixter',
      category: 'Security',
      paymentTerms: 'Net 30',
      leadTimeDays: 3,
      transmitMethod: 'email',
      status: 'active',
      contactPersonName: 'Marcus Patel',
      contactEmail: 'ny-orders@adiglobal.com',
      additionalContacts: [
        { id: 'vc-1', name: 'Renee Holcomb', email: 'ap@adiglobal.com', role: 'Accounts Payable' },
        { id: 'vc-2', name: 'After Hours', phone: '(800) 555-7711', role: 'Dispatch' }, // NO email → excluded
      ],
    },
  ];
  return {
    ...actual, // useSendPO stays REAL — the axios spy asserts the wire call
    useVendors: () => ({ data: vendors, isLoading: false, isError: false }),
  };
});

vi.mock('@/lib/api/organization', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api/organization')>();
  return {
    ...actual,
    useOrganization: () => ({ data: hoisted.org, isLoading: false, isError: false }),
  };
});

const PO: PurchaseOrder = {
  id: 'po-draft-1',
  poNumber: 'P00007',
  vendor: 'ADI / Anixter',
  status: 'draft',
  orderedAt: '2026-05-23T00:00:00Z',
  lines: [{ itemSku: 'SKU-001', itemName: 'Strike', uom: 'EA', qtyOrdered: 4, qtyReceived: 0 }],
};

let postSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  vi.clearAllMocks();
  hoisted.org = { id: 'org-1', name: 'ServWave', email_sending_enabled: true };
  postSpy = vi.spyOn(api, 'post').mockResolvedValue({
    data: { purchaseOrder: { ...PO, status: 'sent' }, email: { id: 'em-1' } },
  });
});

describe('POEmailDialog — real vendor send (P2 §6)', () => {
  it('prefills To from vendor.contactEmail, suggests email-bearing contacts only, no synthesized mailboxes', () => {
    renderWithProviders(
      <POEmailDialog open onClose={vi.fn()} po={PO} onSent={vi.fn()} />,
    );

    // To chip = the vendor's primary contact email.
    expect(screen.getByText('ny-orders@adiglobal.com')).toBeInTheDocument();
    // Suggestions: primary + the email-bearing extra contact; the email-less
    // after-hours contact is absent.
    expect(
      screen.getByRole('button', { name: /Marcus Patel \(Primary\)/ }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: /Renee Holcomb \(Accounts Payable\)/ }),
    ).toBeInTheDocument();
    expect(screen.queryByText(/After Hours/)).not.toBeInTheDocument();
    // The prototype's fabricated addresses are gone from the DOM.
    expect(document.body.textContent).not.toMatch(/fieldos\.io/);
    expect(document.body.textContent).not.toMatch(/sales@adi/);
  });

  it('Send posts /purchase-orders/:id/send with {to, cc, subject, message} and fires onSent', async () => {
    const onSent = vi.fn();
    const onClose = vi.fn();
    renderWithProviders(<POEmailDialog open onClose={onClose} po={PO} onSent={onSent} />);

    // Add a CC via the suggestions? CC goes through its own chip input.
    await userEvent.click(screen.getByRole('button', { name: /send email/i }));

    await waitFor(() =>
      expect(postSpy).toHaveBeenCalledWith('/api/inventory/purchase-orders/po-draft-1/send', {
        to: ['ny-orders@adiglobal.com'],
        subject: 'Purchase Order P00007',
        message: expect.stringContaining('purchase order P00007'),
      }),
    );
    expect(onSent).toHaveBeenCalledWith(
      expect.objectContaining({ to: ['ny-orders@adiglobal.com'] }),
    );
    expect(onClose).toHaveBeenCalled();
  });

  it('org toggle off disables Send with the inline notice', () => {
    hoisted.org = { id: 'org-1', name: 'ServWave', email_sending_enabled: false };
    renderWithProviders(<POEmailDialog open onClose={vi.fn()} po={PO} onSent={vi.fn()} />);

    expect(screen.getByRole('button', { name: /send email/i })).toBeDisabled();
    expect(
      screen.getByText(/Email sending is turned off for your organization/),
    ).toBeInTheDocument();
  });

  it('an unreadable org (undefined) leaves Send enabled — the server is the authority', () => {
    hoisted.org = undefined;
    renderWithProviders(<POEmailDialog open onClose={vi.fn()} po={PO} onSent={vi.fn()} />);
    expect(screen.getByRole('button', { name: /send email/i })).toBeEnabled();
  });

  it('a server 409 surfaces as a sticky destructive toast and the dialog stays open', async () => {
    postSpy.mockRejectedValue({
      response: {
        status: 409,
        data: { error: 'Email sending is disabled for your organization. The purchase order was not sent.' },
      },
    });
    const onSent = vi.fn();
    const onClose = vi.fn();
    renderWithProviders(<POEmailDialog open onClose={onClose} po={PO} onSent={onSent} />);

    await userEvent.click(screen.getByRole('button', { name: /send email/i }));

    await waitFor(() =>
      expect(hoisted.toast).toHaveBeenCalledWith(
        expect.objectContaining({
          variant: 'destructive',
          duration: Infinity,
          description: expect.stringContaining('Email sending is disabled'),
        }),
      ),
    );
    expect(onSent).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
    // Dialog still mounted with the form intact.
    expect(screen.getByText(/Email PO · P00007/)).toBeInTheDocument();
  });
});
