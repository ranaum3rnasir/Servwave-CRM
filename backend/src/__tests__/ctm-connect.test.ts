import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

const mockEnv = vi.hoisted(() => ({
  env: {
    CTM_ACCESS_KEY: 'test-access-key' as string | undefined,
    CTM_SECRET_KEY: 'test-secret-key' as string | undefined,
    CTM_WEBHOOK_TOKEN: 'hook-token' as string | undefined,
    CTM_API_BASE: undefined as string | undefined,
    CTM_RECORDINGS_BUCKET: 'call-recordings',
    BACKEND_PUBLIC_URL: 'https://alpha-crm-test-env.onrender.com' as string | undefined,
  },
}));
vi.mock('../config/env', () => mockEnv);

import { prisma } from '../lib/prisma';
import * as ctmClient from '../lib/ctm/client';
import {
  connectCtm,
  checkCtmA2p,
  disconnectCtm,
  connectCtmSchema,
} from '../controllers/organization-ctm.controller';

/* eslint-disable @typescript-eslint/no-explicit-any */
const p = prisma as any;
const client = ctmClient as any;

function mockRes() {
  const res: any = {};
  res.status = vi.fn().mockReturnValue(res);
  res.json = vi.fn().mockReturnValue(res);
  return res;
}

const req = (body: Record<string, unknown> = {}) =>
  ({ body, user: { id: 'user-1', organization_id: 'org-1', email: 'admin@test.dev' } }) as any;

const WEBURL = (position: string) =>
  `https://alpha-crm-test-env.onrender.com/api/webhooks/ctm/${position}?token=hook-token`;

beforeEach(() => {
  vi.clearAllMocks();
  mockEnv.env.BACKEND_PUBLIC_URL = 'https://alpha-crm-test-env.onrender.com';
  mockEnv.env.CTM_WEBHOOK_TOKEN = 'hook-token';

  client.isCtmConfigured.mockReturnValue(true);
  client.listAccounts.mockResolvedValue([
    { id: 500001, name: 'Northwind Services' },
    { id: 500002, name: 'Servwave' },
  ]);
  client.listNumbers.mockResolvedValue([
    { id: 'TPN-A', number: '+12019037784', name: 'Main line' },
    { id: 'TPN-B', number: '+12017401509', name: 'Ported line' },
  ]);
  client.enableSms.mockResolvedValue('alreadyenabled');
  client.listWebhooks.mockResolvedValue([]);
  client.createWebhook.mockResolvedValue({ id: 1 });
  client.deleteWebhook.mockResolvedValue(undefined);
  client.getA2pStatus.mockResolvedValue({ a2p_campaigns: [{ name: 'contact Customer', status: 'Approved' }] });

  p.organization.update.mockResolvedValue({ id: 'org-1' });
  p.organization.findUnique.mockResolvedValue({ ctm_account_id: '500001' });
  p.phoneNumber.upsert.mockResolvedValue({ id: 'pn-1' });
  p.phoneNumber.updateMany.mockResolvedValue({ count: 0 });
  p.auditLog.create.mockResolvedValue({});
});

describe('connectCtmSchema', () => {
  it('requires exactly one of ctm_account_id / createNew', () => {
    expect(connectCtmSchema.safeParse({ ctm_account_id: '500001' }).success).toBe(true);
    expect(connectCtmSchema.safeParse({ createNew: true, name: 'New Org' }).success).toBe(true);
    expect(connectCtmSchema.safeParse({}).success).toBe(false);
    expect(connectCtmSchema.safeParse({ ctm_account_id: '1', createNew: true, name: 'x' }).success).toBe(false);
    expect(connectCtmSchema.safeParse({ createNew: true }).success).toBe(false);
  });
});

describe('connectCtm', () => {
  it('503s when CTM keys are not configured', async () => {
    client.isCtmConfigured.mockReturnValue(false);
    const res = mockRes();
    await connectCtm(req({ ctm_account_id: '500001' }), res);
    expect(res.status).toHaveBeenCalledWith(503);
  });

  it('422s an account id that is not under the ServWave agency', async () => {
    const res = mockRes();
    await connectCtm(req({ ctm_account_id: '999999' }), res);
    expect(res.status).toHaveBeenCalledWith(422);
    expect(p.organization.update).not.toHaveBeenCalled();
  });

  it('connects: stores the account id, imports BOTH numbers, provisions the four live hooks, flips sms_ready', async () => {
    const res = mockRes();
    await connectCtm(req({ ctm_account_id: '500001' }), res);

    expect(p.organization.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'org-1' }, data: { ctm_account_id: '500001' } }),
    );
    expect(p.phoneNumber.upsert).toHaveBeenCalledTimes(2);
    const upsert = p.phoneNumber.upsert.mock.calls[0][0];
    expect(upsert.where).toEqual({
      organization_id_e164: { organization_id: 'org-1', e164: '+12019037784' },
    });
    expect(upsert.create.ctm_number_id).toBe('TPN-A');
    expect(upsert.create.sms_enabled).toBe(true);

    // `outbound_text` is deliberately NOT provisioned: measured live 2026-08-01,
    // it was registered on both connected CTM accounts and fired zero times in
    // 21 days, while `status_change` carried every outbound text instead.
    // Provisioning it advertised coverage that does not exist.
    expect(client.createWebhook).toHaveBeenCalledTimes(4);
    const positions = client.createWebhook.mock.calls.map((c: any[]) => c[1].position).sort();
    expect(positions).toEqual(['end', 'inbound_text', 'start', 'status_change']);
    expect(positions).not.toContain('outbound_text');
    // Token travels in the query string (log-redaction contract) + Basic creds set.
    expect(client.createWebhook.mock.calls[0][1].weburl).toContain('?token=hook-token');
    expect(client.createWebhook.mock.calls[0][1].username).toBe('servwave');

    expect(p.organization.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: { ctm_sms_ready: true } }),
    );

    const body = res.json.mock.calls[0][0];
    expect(body.connected).toBe(true);
    expect(body.numbers_imported).toBe(2);
    expect(body.sms_ready).toBe(true);
    expect(body.webhooks_provisioned).toHaveLength(4);
  });

  it('sends CTM the position it validates (`start`) while keeping our `starts` route path', async () => {
    const res = mockRes();
    await connectCtm(req({ ctm_account_id: '500001' }), res);

    const startCall = client.createWebhook.mock.calls.find(
      (c: any[]) => String(c[1].weburl).includes('/ctm/starts?'),
    );
    expect(startCall).toBeDefined();
    // Probed live against account 500001 on 2026-08-05: CTM 406s `starts` with
    // {"position":["is not included in the list"]}. `start` is accepted.
    expect(startCall![1].position).toBe('start');
    // The path is OURS and must not follow the position - ctm-webhook.controller
    // dispatches on `starts` and 404s anything it does not know.
    expect(startCall![1].weburl).toBe(WEBURL('starts'));
  });

  it('is idempotent: existing hooks are not re-created on a second connect', async () => {
    client.listWebhooks.mockResolvedValue(
      ['starts', 'end', 'inbound_text', 'status_change'].map((pos, i) => ({
        id: i + 1,
        weburl: WEBURL(pos),
      })),
    );
    const res = mockRes();
    await connectCtm(req({ ctm_account_id: '500001' }), res);
    expect(client.createWebhook).not.toHaveBeenCalled();
    expect(res.json.mock.calls[0][0].webhooks_provisioned).toHaveLength(4);
  });

  it('409s a claim-jack (account already connected to another org)', async () => {
    p.organization.update.mockRejectedValueOnce({ code: 'P2002' });
    const res = mockRes();
    await connectCtm(req({ ctm_account_id: '500001' }), res);
    expect(res.status).toHaveBeenCalledWith(409);
    expect(p.phoneNumber.upsert).not.toHaveBeenCalled();
  });

  it('connects without provisioning when BACKEND_PUBLIC_URL is unset (warning, not failure)', async () => {
    mockEnv.env.BACKEND_PUBLIC_URL = undefined;
    const res = mockRes();
    await connectCtm(req({ ctm_account_id: '500001' }), res);
    expect(client.createWebhook).not.toHaveBeenCalled();
    const body = res.json.mock.calls[0][0];
    expect(body.connected).toBe(true);
    expect(body.warnings.join(' ')).toMatch(/NOT provisioned/i);
  });

  it('surfaces enable_sms failure per number instead of failing the connect', async () => {
    client.enableSms.mockResolvedValueOnce('failure').mockResolvedValueOnce('alreadyenabled');
    const res = mockRes();
    await connectCtm(req({ ctm_account_id: '500001' }), res);
    const body = res.json.mock.calls[0][0];
    expect(body.connected).toBe(true);
    expect(body.warnings.join(' ')).toMatch(/SMS not enabled \(failure\)/);
    expect(p.phoneNumber.upsert.mock.calls[0][0].create.sms_enabled).toBe(false);
  });
});

describe('checkCtmA2p', () => {
  it('flips ctm_sms_ready from the live A2P status', async () => {
    const res = mockRes();
    await checkCtmA2p(req(), res);
    expect(p.organization.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: { ctm_sms_ready: true } }),
    );
    expect(res.json).toHaveBeenCalledWith({ sms_ready: true });
  });

  it('409s when the org is not connected', async () => {
    p.organization.findUnique.mockResolvedValue({ ctm_account_id: null });
    const res = mockRes();
    await checkCtmA2p(req(), res);
    expect(res.status).toHaveBeenCalledWith(409);
  });
});

describe('disconnectCtm', () => {
  it('deletes ONLY our-host webhooks and nulls the account column', async () => {
    client.listWebhooks.mockResolvedValue([
      { id: 1, weburl: WEBURL('end') },
      { id: 2, weburl: 'https://some-other-integration.example.com/hook' },
    ]);
    const res = mockRes();
    await disconnectCtm(req(), res);
    expect(client.deleteWebhook).toHaveBeenCalledTimes(1);
    expect(client.deleteWebhook).toHaveBeenCalledWith('500001', '1');
    expect(p.organization.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: { ctm_account_id: null, ctm_sms_ready: false } }),
    );
    expect(res.json).toHaveBeenCalledWith({ connected: false });
  });

  it("deactivates the org's CTM-sourced numbers so send/call TPN resolution (status:'active') skips them", async () => {
    const res = mockRes();
    await disconnectCtm(req(), res);

    expect(p.phoneNumber.updateMany).toHaveBeenCalledWith({
      where: { organization_id: 'org-1', source: 'ctm' },
      data: { status: 'inactive' },
    });
    expect(res.json).toHaveBeenCalledWith({ connected: false });
  });

  it('a re-connect reactivates previously imported numbers (importNumbers upsert sets active)', async () => {
    const res = mockRes();
    await connectCtm(req({ ctm_account_id: '500001' }), res);

    // BOTH the create and the update arm of the import upsert force status active.
    const upsert = p.phoneNumber.upsert.mock.calls[0][0];
    expect(upsert.create.status).toBe('active');
    expect(upsert.update.status).toBe('active');
  });
});

describe('route gating (ADMIN idiom)', () => {
  it("gates all three CTM org routes with canDo('update','Organization')", () => {
    const src = readFileSync(join(__dirname, '../routes/organization.routes.ts'), 'utf8');
    for (const path of ['/connect-ctm', '/connect-ctm/check-a2p', '/disconnect-ctm']) {
      const line = src.split('\n').find((l) => l.includes(`'${path}'`));
      expect(line, `route ${path} missing`).toBeTruthy();
      expect(line).toContain("canDo('update', 'Organization')");
    }
  });
});
/* eslint-enable @typescript-eslint/no-explicit-any */
