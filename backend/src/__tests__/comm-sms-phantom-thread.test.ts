// s1d (live QA 2026-07-21): sendMessage commits the MessageThread row BEFORE
// the CTM allowlist precheck, with no rollback — a 409 leaves the message
// unwritten but the brand-new, empty thread persists and surfaces on the
// next poll as a phantom conversation. A thread the send merely APPENDED to
// (already existed) must never be touched.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import app from '../app';
import { prisma } from '../lib/prisma';
import * as ctmClient from '../lib/ctm/client';
import { _resetCtmSmsDoubleFireGuard } from '../lib/ctm/sendSms';
import { clearTokenCache } from '../middleware/authenticate';
import { clearPermissionCache } from '../lib/permissions/permissionCache';
import { ALPHA_ORG_ID, mockAuthAs, authHeader, CUSTOMER_FIXTURE } from './helpers';

/* eslint-disable @typescript-eslint/no-explicit-any */
const p = prisma as any;
const client = ctmClient as any;

const ORG_ID = ALPHA_ORG_ID;
const NEW_THREAD_ID = 'a1b2c3d4-0000-0000-0000-0000000000aa';
const EXISTING_THREAD_ID = 'a1b2c3d4-0000-0000-0000-0000000000bb';

function mockConnectedOrg() {
  client.isCtmConfigured.mockReturnValue(true);
  p.organization.findUnique.mockResolvedValue({
    ctm_account_id: '500001',
    ctm_sms_ready: true,
    sms_sending_enabled: true,
    plan: 'PRO',
    trial_ends_at: null,
    feature_overrides: { phone: true },
  });
  p.phoneNumber.findFirst.mockResolvedValue({ ctm_number_id: 'TPN-A' });
  client.isOptedOut.mockResolvedValue(false);
  client.sendSms.mockResolvedValue({ id: 'MSG123' });
  p.message.update.mockResolvedValue({ id: 'msg-1' });
  p.auditLog.create.mockResolvedValue({});
}

beforeEach(() => {
  vi.clearAllMocks();
  _resetCtmSmsDoubleFireGuard();
  clearTokenCache();
  clearPermissionCache();
  client.isCtmConfigured.mockReturnValue(false);
  client.isOptedOut.mockResolvedValue(false);
  client.isOutboundAllowed.mockReturnValue(true);
  p.customer.findFirst.mockResolvedValue(null);
  p.lead.findFirst.mockResolvedValue(null);
  p.messageThread.findFirst.mockResolvedValue(null);
  p.timelineEvent.create.mockResolvedValue({});
});

describe('POST /api/communication/sms — 409 must not leave a phantom thread (s1d)', () => {
  it('customerId path: a brand-new thread is deleted when the allowlist gate 409s', async () => {
    mockAuthAs('dispatcher');
    mockConnectedOrg();
    client.isOutboundAllowed.mockReturnValue(false);
    p.customer.findFirst.mockResolvedValue({ id: CUSTOMER_FIXTURE.id, phone: '+16095551234' });
    p.messageThread.findFirst.mockResolvedValue(null); // no existing thread
    p.messageThread.create.mockResolvedValue({
      id: NEW_THREAD_ID, customer_id: CUSTOMER_FIXTURE.id, vendor_id: null, kind: null, title: null,
    });

    const res = await request(app)
      .post('/api/communication/sms')
      .set(authHeader('dispatcher'))
      .send({ customerId: CUSTOMER_FIXTURE.id, body: 'blocked text' });

    expect(res.status).toBe(409);
    expect(res.body.code).toBe('NOT_IN_TEST_ALLOWLIST');
    expect(p.messageThread.create).toHaveBeenCalledTimes(1);
    expect(p.messageThread.deleteMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          id: NEW_THREAD_ID,
          organization_id: ORG_ID,
          messages: { none: {} },
        }),
      }),
    );
    expect(p.message.create).not.toHaveBeenCalled();
  });

  it('guards the delete against a message that arrived concurrently before the 409 fired', async () => {
    // Message.thread is onDelete: Cascade, and findOrCreateSmsThreadByNumber
    // (the same keying this path uses) is ALSO the function the CTM webhook
    // ingest calls for inbound SMS — so a real inbound message can land in
    // this exact thread during the several DB round-trips (and, for some
    // gate reasons, a real CTM HTTP call) precheckCtmSms makes before this
    // 409 fires. The delete must be guarded so that message is never
    // cascaded away. `count: 0` below is what the real DB would return: the
    // `messages: { none: {} }` clause excludes a thread that is no longer
    // empty.
    mockAuthAs('dispatcher');
    mockConnectedOrg();
    client.isOutboundAllowed.mockReturnValue(false);
    p.customer.findFirst.mockResolvedValue({ id: CUSTOMER_FIXTURE.id, phone: '+16095551234' });
    p.messageThread.findFirst.mockResolvedValue(null);
    p.messageThread.create.mockResolvedValue({
      id: NEW_THREAD_ID, customer_id: CUSTOMER_FIXTURE.id, vendor_id: null, kind: null, title: null,
    });
    p.messageThread.deleteMany.mockResolvedValue({ count: 0 });

    const res = await request(app)
      .post('/api/communication/sms')
      .set(authHeader('dispatcher'))
      .send({ customerId: CUSTOMER_FIXTURE.id, body: 'blocked text' });

    expect(res.status).toBe(409);
    expect(p.messageThread.deleteMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          id: NEW_THREAD_ID,
          organization_id: ORG_ID,
          messages: { none: {} },
        }),
      }),
    );
  });

  it('customerId path: a PRE-EXISTING thread is never deleted on the same 409', async () => {
    mockAuthAs('dispatcher');
    mockConnectedOrg();
    client.isOutboundAllowed.mockReturnValue(false);
    p.customer.findFirst.mockResolvedValue({ id: CUSTOMER_FIXTURE.id, phone: '+16095551234' });
    p.messageThread.findFirst.mockResolvedValue({
      id: EXISTING_THREAD_ID, customer_id: CUSTOMER_FIXTURE.id, vendor_id: null, kind: null, title: null,
    });

    const res = await request(app)
      .post('/api/communication/sms')
      .set(authHeader('dispatcher'))
      .send({ customerId: CUSTOMER_FIXTURE.id, body: 'blocked text' });

    expect(res.status).toBe(409);
    expect(p.messageThread.create).not.toHaveBeenCalled();
    expect(p.messageThread.deleteMany).not.toHaveBeenCalled();
    expect(p.message.create).not.toHaveBeenCalled();
  });

  it('toNumber path: a brand-new title-keyed thread is deleted when the allowlist gate 409s', async () => {
    mockAuthAs('dispatcher');
    mockConnectedOrg();
    client.isOutboundAllowed.mockReturnValue(false);
    p.messageThread.findFirst.mockResolvedValue(null);
    p.messageThread.create.mockResolvedValue({
      id: NEW_THREAD_ID, customer_id: null, vendor_id: null, kind: null, title: '+12015550123',
    });

    const res = await request(app)
      .post('/api/communication/sms')
      .set(authHeader('dispatcher'))
      .send({ toNumber: '(201) 555-0123', body: 'blocked text' });

    expect(res.status).toBe(409);
    expect(p.messageThread.deleteMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          id: NEW_THREAD_ID,
          organization_id: ORG_ID,
          messages: { none: {} },
        }),
      }),
    );
    expect(p.message.create).not.toHaveBeenCalled();
  });
});
