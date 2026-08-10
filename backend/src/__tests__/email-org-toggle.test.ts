import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import type { Mock } from 'vitest';

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

vi.mock('../lib/comm-persist', () => ({
  persistTransactionalEmail: vi.fn().mockResolvedValue(undefined),
}));

// sendInvoiceEmail now attaches a rendered PDF — stub the renderer so this suite stays
// focused on the org-toggle gate, not pdfmake.
vi.mock('../lib/pdf', () => ({
  generateInvoicePdf: vi.fn().mockResolvedValue(Buffer.from('%PDF-1.4 fake')),
}));

import { prisma } from '../lib/prisma';
import { persistTransactionalEmail } from '../lib/comm-persist';

// setup.ts mocks '../lib/email' globally; pull the REAL module here.
let sendInvoiceEmail: typeof import('../lib/email')['sendInvoiceEmail'];
let sendClockOverrideDecisionEmail: typeof import('../lib/email')['sendClockOverrideDecisionEmail'];
let sendMfaCodeEmail: typeof import('../lib/email')['sendMfaCodeEmail'];
let sendUserInviteEmail: typeof import('../lib/email')['sendUserInviteEmail'];
let sendAutomationEmail: typeof import('../lib/email')['sendAutomationEmail'];

beforeAll(async () => {
  const real = await vi.importActual<typeof import('../lib/email')>('../lib/email');
  sendInvoiceEmail = real.sendInvoiceEmail;
  sendClockOverrideDecisionEmail = real.sendClockOverrideDecisionEmail;
  sendMfaCodeEmail = real.sendMfaCodeEmail;
  sendUserInviteEmail = real.sendUserInviteEmail;
  sendAutomationEmail = real.sendAutomationEmail;
});

beforeEach(() => {
  vi.clearAllMocks();
  resendSend.mockResolvedValue({ id: 'msg_1' });
  // renderInvoicePdfBuffer's own lookup, ahead of the stubbed generateInvoicePdf above —
  // individual tests below still control the organization.findUnique mock for the
  // email_sending_enabled check that runs after it.
  (prisma.invoice.findUnique as Mock).mockResolvedValue({ organization_id: ORG_ID, payments: [] });
});

const ORG_ID = '00000000-0000-0000-0000-000000000001';

describe('Org-level email_sending_enabled toggle', () => {
  it('skips the send when the org has email sending disabled', async () => {
    (prisma.organization.findUnique as Mock).mockResolvedValue({ email_sending_enabled: false });

    await sendInvoiceEmail({
      invoiceId: 'inv-1',
      organizationId: ORG_ID,
      to: 'cust@example.com',
      customerName: 'Cust',
      invoiceNumber: 'I00001',
      total: 100,
      amountDue: 100,
      dueDate: '2026-08-01',
      publicUrl: 'https://app.example/i/tok',
    });

    expect(resendSend).not.toHaveBeenCalled();
  });

  it('sends normally when the org has email sending enabled', async () => {
    (prisma.organization.findUnique as Mock).mockResolvedValue({ email_sending_enabled: true });

    await sendInvoiceEmail({
      invoiceId: 'inv-1',
      organizationId: ORG_ID,
      to: 'cust@example.com',
      customerName: 'Cust',
      invoiceNumber: 'I00001',
      total: 100,
      amountDue: 100,
      dueDate: '2026-08-01',
      publicUrl: 'https://app.example/i/tok',
    });

    expect(resendSend).toHaveBeenCalledTimes(1);
  });

  it('fails open (sends) when the org lookup returns nothing — legacy/unmocked rows default to enabled', async () => {
    // First call is renderInvoicePdfBuffer's own org lookup (needs a truthy row to render at
    // all); the SECOND call is dispatchEmail's email_sending_enabled check — the one actually
    // under test here — which sees the "nothing found" row this test is named for.
    (prisma.organization.findUnique as Mock)
      .mockResolvedValueOnce({ estimate_template: 'alpha-classic' })
      .mockResolvedValueOnce(undefined);

    await sendInvoiceEmail({
      invoiceId: 'inv-1',
      organizationId: ORG_ID,
      to: 'cust@example.com',
      customerName: 'Cust',
      invoiceNumber: 'I00001',
      total: 100,
      amountDue: 100,
      dueDate: '2026-08-01',
      publicUrl: 'https://app.example/i/tok',
    });

    expect(resendSend).toHaveBeenCalledTimes(1);
  });

  it('respects the toggle for senders that take org branding (org.id), not just a bare organizationId', async () => {
    (prisma.organization.findUnique as Mock).mockResolvedValue({ email_sending_enabled: false });

    await sendClockOverrideDecisionEmail({
      org: { id: ORG_ID, name: 'Acme', logo_url: null, brand_color: '#0C2D3A' },
      to: 'tech@example.com',
      technicianName: 'Tech',
      decision: 'approved',
      decidedByName: 'Boss',
    });

    expect(resendSend).not.toHaveBeenCalled();
  });

  it('does NOT gate sendMfaCodeEmail — auth-critical, always sends regardless of the org toggle', async () => {
    (prisma.organization.findUnique as Mock).mockResolvedValue({ email_sending_enabled: false });

    await sendMfaCodeEmail({ to: 'user@example.com', code: '123456' });

    expect(resendSend).toHaveBeenCalledTimes(1);
  });

  // The Automation Center is the one sender an org is most likely to want to
  // kill in a hurry — it fires unattended, on a poller, to customers. It must
  // sit behind the same brake as every hand-triggered business email. (#906)
  it('gates sendAutomationEmail — the kill switch stops Automation Center sends', async () => {
    (prisma.organization.findUnique as Mock).mockResolvedValue({ email_sending_enabled: false });

    await sendAutomationEmail({
      organizationId: ORG_ID,
      to: 'customer@example.com',
      subject: 'Your appointment is tomorrow',
      text: 'See you then.',
      html: '<p>See you then.</p>',
    });

    expect(resendSend).not.toHaveBeenCalled();
  });

  it('sends automation email normally when the org has email sending enabled', async () => {
    (prisma.organization.findUnique as Mock).mockResolvedValue({ email_sending_enabled: true });

    await sendAutomationEmail({
      organizationId: ORG_ID,
      to: 'customer@example.com',
      subject: 'Your appointment is tomorrow',
      text: 'See you then.',
      html: '<p>See you then.</p>',
    });

    expect(resendSend).toHaveBeenCalledTimes(1);
  });

  // A skipped send that still mirrors into the Communication tab would show the
  // office a message the customer never got.
  it('does not mirror a killed automation email into the Communication tab', async () => {
    (prisma.organization.findUnique as Mock).mockResolvedValue({ email_sending_enabled: false });

    await sendAutomationEmail({
      organizationId: ORG_ID,
      to: 'customer@example.com',
      subject: 'Your appointment is tomorrow',
      text: 'See you then.',
      html: '<p>See you then.</p>',
      record: { organizationId: ORG_ID, customerId: null, jobId: null, jobLabel: null },
    });

    expect(persistTransactionalEmail).not.toHaveBeenCalled();
  });

  it('does NOT gate sendUserInviteEmail — auth-critical, always sends regardless of the org toggle', async () => {
    (prisma.organization.findUnique as Mock)
      // First call inside sendUserInviteEmail itself (branding lookup)
      .mockResolvedValueOnce({ name: 'Acme', logo_url: null, brand_color: '#0C2D3A' });

    await sendUserInviteEmail({
      to: 'user@example.com',
      firstName: 'Jane',
      inviteUrl: 'https://app.example/invite/abc',
      organizationId: ORG_ID,
    });

    expect(resendSend).toHaveBeenCalledTimes(1);
  });
});
