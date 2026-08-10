import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import type { Mock } from 'vitest';

const { resendSend } = vi.hoisted(() => ({ resendSend: vi.fn() }));

vi.mock('../config/env', () => ({
  env: {
    NODE_ENV: 'test',
    EMAIL_FROM: 'Alpha <noreply@test.com>',
    EMAIL_FROM_BUSINESS: 'no-reply@mail.test.com',
    RESEND_API_KEY: 're_test_key',
    FRONTEND_URL: 'http://localhost:5173',
  },
}));

vi.mock('resend', () => ({
  Resend: class {
    emails = { send: resendSend };
  },
}));

vi.mock('../lib/pdf', () => ({
  generateEstimatePdf: vi.fn().mockResolvedValue(Buffer.from('%PDF-1.4 fake')),
}));

import { prisma } from '../lib/prisma';
import { generateEstimatePdf } from '../lib/pdf';

let sendEstimateEmail: typeof import('../lib/email')['sendEstimateEmail'];
let sendEstimateWithDepositEmail: typeof import('../lib/email')['sendEstimateWithDepositEmail'];

beforeAll(async () => {
  const real = await vi.importActual<typeof import('../lib/email')>('../lib/email');
  sendEstimateEmail = real.sendEstimateEmail;
  sendEstimateWithDepositEmail = real.sendEstimateWithDepositEmail;
});

const ORG = { id: 'org-1', name: 'Acme', logo_url: null, brand_color: '#0C2D3A' };

const ESTIMATE_ROW = {
  estimate_number: 'E00001', status: 'SENT', created_at: new Date(), subtotal: 100, tax_rate: 0, tax_amount: 0,
  total_amount: 100, signature_data: null, signature_at: null, snapshot_terms: null, snapshot_notes: null,
  snapshot_payment_terms: null, organization_id: ORG.id,
  lead: {
    service_address_line1: null, service_address_line2: null, service_city: null, service_state: null, service_zip: null,
    customer: { first_name: 'Jane', last_name: 'Doe', company_name: null, email: 'jane@example.com', phone: null, service_locations: [] },
  },
  line_items: [],
};

beforeEach(() => {
  vi.clearAllMocks();
  (prisma.organization.findUnique as Mock).mockResolvedValue({ email_sending_enabled: true });
  (prisma.estimate.findUnique as Mock).mockResolvedValue(ESTIMATE_ROW);
  (prisma.organization.findFirst as Mock).mockResolvedValue({ ...ORG, estimate_template: 'alpha-classic' });
  (prisma.email.create as Mock).mockResolvedValue({});
});

const BASE_PARAMS = {
  estimateId: 'est-1', org: ORG, to: 'jane@example.com', customerName: 'Jane Doe',
  estimateNumber: 'E00001', total: '$100.00', publicUrl: 'https://x/y',
  record: { organizationId: ORG.id, customerId: 'cust-1', leadId: 'lead-1' },
};

describe('sendEstimateEmail — propagates the dispatch result', () => {
  it('returns {status:"sent"} and persists a transactional record on success', async () => {
    resendSend.mockResolvedValue({ data: { id: 're_1' }, error: null });
    const res = await sendEstimateEmail(BASE_PARAMS);
    expect(res).toEqual({ status: 'sent', providerMessageId: 're_1', fromAddress: 'no-reply@mail.test.com', fromName: null });
    expect(prisma.email.create).toHaveBeenCalledTimes(1);
    expect(prisma.email.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ to: 'jane@example.com' }),
    }));
  });

  it('returns {status:"failed", error} and does NOT persist a record when Resend rejects', async () => {
    resendSend.mockResolvedValue({ data: null, error: { message: 'domain not verified' } });
    const res = await sendEstimateEmail(BASE_PARAMS);
    expect(res).toEqual({ status: 'failed', error: 'domain not verified' });
    expect(prisma.email.create).not.toHaveBeenCalled();
  });

  it('returns {status:"skipped", reason:"org_disabled"} and never calls Resend', async () => {
    (prisma.organization.findUnique as Mock).mockResolvedValue({ email_sending_enabled: false });
    const res = await sendEstimateEmail(BASE_PARAMS);
    expect(res).toEqual({ status: 'skipped', reason: 'org_disabled' });
    expect(resendSend).not.toHaveBeenCalled();
    expect(prisma.email.create).not.toHaveBeenCalled();
  });

  it('returns {status:"failed", error} and does NOT persist a record when PDF rendering throws', async () => {
    (generateEstimatePdf as Mock).mockRejectedValueOnce(new Error('pdf render boom'));
    const res = await sendEstimateEmail(BASE_PARAMS);
    expect(res).toEqual({ status: 'failed', error: 'pdf render boom' });
    expect(prisma.email.create).not.toHaveBeenCalled();
  });

  // R6 (2026-07-22, independent-review fix) — renderEstimatePdfBuffer's select had its own
  // hand-rolled shape (same class of gap as getPdf/getPublicPdf) that never picked up the R6
  // anchor columns, so generateEstimatePdf would throw for a lead-less estimate. Locks the shape.
  it("renderEstimatePdfBuffer's select includes customer/service_location (the R6 anchor)", async () => {
    resendSend.mockResolvedValue({ data: { id: 're_3' }, error: null });
    await sendEstimateEmail(BASE_PARAMS);

    const sel = (prisma.estimate.findUnique as Mock).mock.calls[0]![0].select;
    expect(sel.customer).toBeTruthy();
    expect(sel.service_location).toBeTruthy();
  });
});

describe('sendEstimateWithDepositEmail — propagates the dispatch result', () => {
  it('returns {status:"sent"} and persists a transactional record on success', async () => {
    resendSend.mockResolvedValue({ data: { id: 're_2' }, error: null });
    const res = await sendEstimateWithDepositEmail({ ...BASE_PARAMS, depositAmount: '$50.00', depositPercentage: 50 });
    expect(res).toEqual({ status: 'sent', providerMessageId: 're_2', fromAddress: 'no-reply@mail.test.com', fromName: null });
    expect(prisma.email.create).toHaveBeenCalledTimes(1);
    expect(prisma.email.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ to: 'jane@example.com' }),
    }));
  });

  it('returns {status:"failed", error} and does NOT persist a record when Resend rejects', async () => {
    resendSend.mockResolvedValue({ data: null, error: { message: 'rate limited' } });
    const res = await sendEstimateWithDepositEmail({ ...BASE_PARAMS, depositAmount: '$50.00', depositPercentage: 50 });
    expect(res).toEqual({ status: 'failed', error: 'rate limited' });
    expect(prisma.email.create).not.toHaveBeenCalled();
  });

  it('returns {status:"failed", error} and does NOT persist a record when PDF rendering throws', async () => {
    (generateEstimatePdf as Mock).mockRejectedValueOnce(new Error('pdf render boom'));
    const res = await sendEstimateWithDepositEmail({ ...BASE_PARAMS, depositAmount: '$50.00', depositPercentage: 50 });
    expect(res).toEqual({ status: 'failed', error: 'pdf render boom' });
    expect(prisma.email.create).not.toHaveBeenCalled();
  });
});
