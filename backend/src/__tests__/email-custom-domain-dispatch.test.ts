import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import type { Mock } from 'vitest';

// Email slice 10 (guided domain verification) — dispatchEmail must prefer a
// verified OrganizationDomain's own address as the From, falling back to the
// shared EMAIL_FROM_BUSINESS whenever there is no row, the row isn't
// status=verified, or the lookup itself fails for any reason. Mirrors
// email-dispatch.test.ts's setup (real dispatchEmail via importActual, a real
// Resend-shaped double, real env).

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

import { prisma } from '../lib/prisma';
import { logger } from '../lib/logger';

let dispatchEmail: typeof import('../lib/email')['__dispatchEmailForTest'];

beforeAll(async () => {
  const real = await vi.importActual<typeof import('../lib/email')>('../lib/email');
  dispatchEmail = real.__dispatchEmailForTest;
});

const PAYLOAD = { to: 'customer@example.com', subject: 's', text: 't' } as any;
const ORG_ID = 'org-1';

beforeEach(() => {
  vi.clearAllMocks();
  (prisma.organization.findUnique as Mock).mockResolvedValue({ email_sending_enabled: true, name: 'Acme Plumbing' });
  resendSend.mockResolvedValue({ data: { id: 're_1' }, error: null });
});

describe('dispatchEmail — custom domain preference', () => {
  it('uses the shared business domain when the org has no OrganizationDomain row', async () => {
    (prisma.organizationDomain.findUnique as Mock).mockResolvedValue(null);

    const res = await dispatchEmail(ORG_ID, PAYLOAD);

    expect(resendSend.mock.calls[0]![0].from).toBe('"Acme Plumbing" <acmeplumbing@mail.test.com>');
    expect(res).toMatchObject({ status: 'sent', fromAddress: 'acmeplumbing@mail.test.com' });
  });

  it('uses the org own verified domain as the From address when status is verified', async () => {
    (prisma.organizationDomain.findUnique as Mock).mockResolvedValue({
      domain_name: 'acmeplumbing.com',
      status: 'verified',
      verified_at: new Date('2026-08-01T00:00:00Z'),
    });

    const res = await dispatchEmail(ORG_ID, PAYLOAD);

    expect(resendSend.mock.calls[0]![0].from).toBe('"Acme Plumbing" <no-reply@acmeplumbing.com>');
    expect(res).toMatchObject({ status: 'sent', fromAddress: 'no-reply@acmeplumbing.com' });
  });

  it('falls back to the shared domain when the row exists but is not yet verified (pending)', async () => {
    (prisma.organizationDomain.findUnique as Mock).mockResolvedValue({
      domain_name: 'acmeplumbing.com',
      status: 'pending',
      verified_at: null,
    });

    const res = await dispatchEmail(ORG_ID, PAYLOAD);

    expect(resendSend.mock.calls[0]![0].from).toBe('"Acme Plumbing" <acmeplumbing@mail.test.com>');
    expect(res).toMatchObject({ fromAddress: 'acmeplumbing@mail.test.com' });
  });

  it('falls back to the shared domain when a PREVIOUSLY-verified domain is no longer verified, and logs it', async () => {
    (prisma.organizationDomain.findUnique as Mock).mockResolvedValue({
      domain_name: 'acmeplumbing.com',
      status: 'failed',
      verified_at: new Date('2026-07-01T00:00:00Z'),
    });

    const res = await dispatchEmail(ORG_ID, PAYLOAD);

    expect(resendSend.mock.calls[0]![0].from).toBe('"Acme Plumbing" <acmeplumbing@mail.test.com>');
    expect(res).toMatchObject({ fromAddress: 'acmeplumbing@mail.test.com' });
    // OBSERVABLE — the fallback must never be a silent swap noone notices.
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('acmeplumbing.com'));
  });

  it('does NOT log a fallback for a domain that was never verified in the first place', async () => {
    (prisma.organizationDomain.findUnique as Mock).mockResolvedValue({
      domain_name: 'acmeplumbing.com',
      status: 'pending',
      verified_at: null,
    });

    await dispatchEmail(ORG_ID, PAYLOAD);

    expect(logger.warn).not.toHaveBeenCalledWith(expect.stringContaining('acmeplumbing.com'));
  });

  it('falls back to the shared domain (never a hard failure) when the domain lookup itself throws', async () => {
    (prisma.organizationDomain.findUnique as Mock).mockRejectedValue(new Error('connection reset'));

    const res = await dispatchEmail(ORG_ID, PAYLOAD);

    expect(resendSend.mock.calls[0]![0].from).toBe('"Acme Plumbing" <acmeplumbing@mail.test.com>');
    expect(res).toMatchObject({ status: 'sent', fromAddress: 'acmeplumbing@mail.test.com' });
  });
});
