/**
 * FormField adoption - inventory dialog raw <label> triage batch.
 *
 * Two sites in this batch had a label sitting ABOVE a single sibling
 * input/textarea with NO htmlFor/id wiring at all (POEmailDialog's Subject +
 * Message, SignatureField's typed-name input) - the exact shape FormField
 * exists to fix. Everywhere else in this batch either wraps its control
 * (checkbox rows, file-drop zones, the local `Field({ label, children })`
 * helper) or is a compound control outside this batch's fit criteria, and was
 * deliberately left alone (see the inline comments at those sites).
 *
 * This file pins the id-wiring contract per CLAUDE.md's TDD rule: a "renders
 * without crashing" test would not catch a regression where the label and
 * control drift apart, or where the wrap silently breaks the field's own
 * value/onChange.
 *
 * The POEmailDialog preamble below (mocks, PO fixture, postSpy) is copied
 * verbatim from po-email-send.test.tsx rather than hand-rolled, so this file
 * renders the dialog through the exact harness that file already proves
 * works, instead of a subtly different one.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithProviders } from './helpers';
import { POEmailDialog } from '@/components/inventory/POEmailDialog';
import { SignatureField } from '@/components/inventory/SignatureField';
import api from '@/lib/axios';
import type { PurchaseOrder } from '@/lib/api/inventory';

const hoisted = vi.hoisted(() => ({
  toast: vi.fn(),
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
        { id: 'vc-2', name: 'After Hours', phone: '(800) 555-7711', role: 'Dispatch' },
      ],
    },
  ];
  return {
    ...actual,
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

beforeEach(() => {
  vi.clearAllMocks();
  hoisted.org = { id: 'org-1', name: 'ServWave', email_sending_enabled: true };
  vi.spyOn(api, 'post').mockResolvedValue({
    data: { purchaseOrder: { ...PO, status: 'sent' }, email: { id: 'em-1' } },
  });
});

describe('POEmailDialog - Subject/Message FormField adoption', () => {
  it('wires one generated id from the Subject label to the subject input, reachable by label', () => {
    renderWithProviders(<POEmailDialog open onClose={vi.fn()} po={PO} onSent={vi.fn()} />);
    const label = screen.getByText('Subject');
    const input = screen.getByLabelText('Subject');

    expect(label.tagName).toBe('LABEL');
    expect(input.id).toBeTruthy();
    expect(label.getAttribute('for')).toBe(input.id);
  });

  it('wires one generated id from the Message label to the message textarea, reachable by label', () => {
    renderWithProviders(<POEmailDialog open onClose={vi.fn()} po={PO} onSent={vi.fn()} />);
    const label = screen.getByText('Message');
    const textarea = screen.getByLabelText('Message');

    expect(label.tagName).toBe('LABEL');
    expect(textarea.id).toBeTruthy();
    expect(label.getAttribute('for')).toBe(textarea.id);
  });

  it('Subject and Message still drive their own value/onChange after the wrap', async () => {
    const user = userEvent.setup();
    renderWithProviders(<POEmailDialog open onClose={vi.fn()} po={PO} onSent={vi.fn()} />);

    const subject = screen.getByLabelText('Subject') as HTMLInputElement;
    await user.clear(subject);
    await user.type(subject, 'Updated subject line');
    expect(subject).toHaveValue('Updated subject line');

    const message = screen.getByLabelText('Message') as HTMLTextAreaElement;
    await user.type(message, ' extra note');
    expect(message.value).toContain('extra note');
  });
});

describe('SignatureField - typed-name FormField adoption', () => {
  it('wires one generated id from the "Type your full name to sign" label to the input', () => {
    renderWithProviders(<SignatureField role="Tech Pickup Sign-out" onSign={vi.fn()} />);
    const label = screen.getByText('Type your full name to sign');
    const input = screen.getByLabelText('Type your full name to sign');

    expect(label.tagName).toBe('LABEL');
    expect(input.id).toBeTruthy();
    expect(label.getAttribute('for')).toBe(input.id);
  });

  it('still drives the live cursive preview by value/onChange after the wrap', async () => {
    const user = userEvent.setup();
    renderWithProviders(<SignatureField role="Tech Pickup Sign-out" onSign={vi.fn()} />);

    const input = screen.getByLabelText('Type your full name to sign');
    await user.type(input, 'Jane Contractor');
    expect(input).toHaveValue('Jane Contractor');
    expect(screen.getByText('Jane Contractor')).toBeInTheDocument();
  });
});
