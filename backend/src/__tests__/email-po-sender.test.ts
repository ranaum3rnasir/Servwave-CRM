import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import type { Mock } from 'vitest';

// P2 item 6c: the REAL PO email renderer/sender (setup.ts mocks ../lib/email for
// controller tests; here we pull the actual module — email-org-toggle pattern).

// Capture fn must exist before the hoisted vi.mock factory references it.
const { resendSend } = vi.hoisted(() => ({ resendSend: vi.fn() }));

// Override the global env mock (setup.ts) so the email module initializes a
// real Resend client instead of short-circuiting on a missing key.
vi.mock('../config/env', () => ({
  env: {
    NODE_ENV: 'test',
    EMAIL_FROM: 'Alpha <noreply@test.com>',
    RESEND_API_KEY: 're_test_key',
    FRONTEND_URL: 'http://localhost:5173',
  },
}));

vi.mock('resend', () => ({
  Resend: class {
    emails = { send: resendSend };
  },
}));

import { prisma } from '../lib/prisma';

let sendPurchaseOrderEmail: typeof import('../lib/email')['sendPurchaseOrderEmail'];

beforeAll(async () => {
  const real = await vi.importActual<typeof import('../lib/email')>('../lib/email');
  sendPurchaseOrderEmail = real.sendPurchaseOrderEmail;
});

beforeEach(() => {
  vi.clearAllMocks();
  resendSend.mockResolvedValue({ id: 'msg_1' });
  (prisma.organization.findUnique as Mock).mockResolvedValue({ email_sending_enabled: true });
});

const ORG_ID = '00000000-0000-0000-0000-000000000001';
const ORG = { id: ORG_ID, name: 'Northwind Services', logo_url: null, brand_color: '#0C2D3A' };

const BASE_PARAMS = {
  organizationId: ORG_ID,
  org: ORG,
  to: 'orders@acme.com',
  poNumber: 'PO-1001',
  vendorName: 'Acme Supply',
  lines: [
    { sku: 'LOCK-100', name: 'Deadbolt Lock', uom: 'EA', qtyOrdered: 5, unitCost: 20 },
    { sku: '', name: 'Misc bracket', uom: 'EA', qtyOrdered: 2, unitCost: null },
  ],
  total: 100,
  currency: 'USD',
};

describe('sendPurchaseOrderEmail (P2 item 6c)', () => {
  it('renders the line table + total and returns the transmitted content on success', async () => {
    const result = await sendPurchaseOrderEmail({ ...BASE_PARAMS });

    expect(result.status).toBe('sent');
    expect(result.subject).toBe('Purchase Order PO-1001 from Northwind Services');

    expect(resendSend).toHaveBeenCalledTimes(1);
    const payload = resendSend.mock.calls[0][0];
    expect(payload.to).toBe('orders@acme.com');
    expect(payload.subject).toBe('Purchase Order PO-1001 from Northwind Services');
    expect(payload.text).toContain('PO-1001');
    // Line table content: sku, name, qty, unit cost, extended, and the total row.
    expect(payload.html).toContain('LOCK-100');
    expect(payload.html).toContain('Deadbolt Lock');
    expect(payload.html).toContain('$20.00');
    expect(payload.html).toContain('$100.00');
    // The returned html is the exact transmitted body (persisted to InventoryEmail).
    expect(result.html).toBe(payload.html);
  });

  it('escapes hostile vendor/item strings (B-06 output encoding)', async () => {
    await sendPurchaseOrderEmail({
      ...BASE_PARAMS,
      vendorName: '<script>alert(1)</script>',
      lines: [{ sku: 'X<img>', name: '<b>Bad</b> item', uom: 'EA', qtyOrdered: 1, unitCost: null }],
    });

    const html = resendSend.mock.calls[0][0].html as string;
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('&lt;script&gt;');
    expect(html).not.toContain('<b>Bad</b>');
    expect(html).toContain('&lt;b&gt;Bad&lt;/b&gt;');
  });

  it('formats money from the org currency code, not a hardcoded $ (#126)', async () => {
    await sendPurchaseOrderEmail({ ...BASE_PARAMS, currency: 'CAD' });
    const html = resendSend.mock.calls[0][0].html as string;
    expect(html).toContain('CA$20.00');
    expect(html).toContain('CA$100.00');
  });

  it('includes the custom message block when a message is provided', async () => {
    await sendPurchaseOrderEmail({ ...BASE_PARAMS, message: 'Please deliver to the side dock.' });
    const html = resendSend.mock.calls[0][0].html as string;
    expect(html).toContain('Please deliver to the side dock.');
  });

  it('uses a caller-supplied subject verbatim, falling back to the default when absent (D1)', async () => {
    await sendPurchaseOrderEmail({ ...BASE_PARAMS, subject: 'Custom PO subject' });
    expect(resendSend.mock.calls[0][0].subject).toBe('Custom PO subject');
    expect((await sendPurchaseOrderEmail({ ...BASE_PARAMS })).subject).toBe(
      'Purchase Order PO-1001 from Northwind Services',
    );
  });

  it('short-circuits on the org email_sending_enabled toggle (no provider call)', async () => {
    (prisma.organization.findUnique as Mock).mockResolvedValue({ email_sending_enabled: false });

    const result = await sendPurchaseOrderEmail({ ...BASE_PARAMS });

    expect(resendSend).not.toHaveBeenCalled();
    expect(result.status).toBe('skipped');
    expect((result as any).reason).toBe('org_disabled');
  });

  it('maps a provider rejection to failed', async () => {
    resendSend.mockResolvedValue({ error: { message: 'domain not verified' } });
    const result = await sendPurchaseOrderEmail({ ...BASE_PARAMS });
    expect(result.status).toBe('failed');
  });
});
