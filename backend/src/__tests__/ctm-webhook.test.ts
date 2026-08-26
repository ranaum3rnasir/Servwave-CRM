import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';

// Mutable env double — the handler reads env.* at call time.
const mockEnv = vi.hoisted(() => ({
  env: {
    CTM_WEBHOOK_TOKEN: 'hook-token' as string | undefined,
    CTM_SECRET_KEY: 'test-secret-key' as string | undefined,
    CTM_WEBHOOK_SIGNING_SECRET: 'test-signing-secret' as string | undefined,
    CTM_ACCESS_KEY: 'test-access-key' as string | undefined,
    CTM_API_BASE: undefined as string | undefined,
    CTM_RECORDINGS_BUCKET: 'call-recordings',
  },
}));
vi.mock('../config/env', () => mockEnv);

import crypto from 'crypto';
import webhookRoutes from '../routes/webhook.routes';
import { prisma } from '../lib/prisma';

const app = express();
app.use('/api/webhooks', webhookRoutes);

/* eslint-disable @typescript-eslint/no-explicit-any */
const p = prisma as any;

const CALL_END_PAYLOAD = {
  sid: 'CA0001',
  id: 12345,
  account_id: 596375,
  caller_number: '+12015551234',
  tracking_number: '+12019037784',
  direction: 'inbound',
  dial_status: 'answered',
  duration: 62,
  talk_time: 48,
  unix_time: 1_752_000_000,
  agent: { id: 9, name: 'Emanuel', email: 'emanuel@example.com' },
  audio: 'https://app.calltrackingmetrics.com/recordings/RE123',
  tag_list: ['sales'],
};

function post(position: string, payload: unknown, token = 'hook-token') {
  const qs = token === null ? '' : `?token=${token}`;
  return request(app)
    .post(`/api/webhooks/ctm/${position}${qs}`)
    .set('Content-Type', 'application/json')
    .send(JSON.stringify(payload));
}

beforeEach(() => {
  vi.clearAllMocks();
  mockEnv.env.CTM_WEBHOOK_TOKEN = 'hook-token';
  mockEnv.env.CTM_SECRET_KEY = 'test-secret-key';
  mockEnv.env.CTM_WEBHOOK_SIGNING_SECRET = 'test-signing-secret';

  // Default happy-path mocks.
  p.ctmEvent.findUnique.mockResolvedValue(null);
  p.ctmEvent.create.mockResolvedValue({ id: 'evt-1' });
  p.organization.findFirst.mockResolvedValue({ id: 'org-1' });
  p.callSession.findFirst.mockResolvedValue(null);
  p.callSession.upsert.mockResolvedValue({ id: 'cs-1' });
  p.user.findFirst.mockResolvedValue(null);
  p.customer.findFirst.mockResolvedValue(null);
  p.lead.findFirst.mockResolvedValue(null);
  p.vendor.findFirst.mockResolvedValue(null);
  p.vendorContact.findFirst.mockResolvedValue(null);
  p.messageThread.findFirst.mockResolvedValue(null);
  p.messageThread.create.mockResolvedValue({ id: 'th-1' });
  p.messageThread.update.mockResolvedValue({ id: 'th-1' });
  p.message.findFirst.mockResolvedValue(null);
  p.message.findMany.mockResolvedValue([]);
  p.message.create.mockResolvedValue({ id: 'msg-1', thread_id: 'th-1' });
  p.message.update.mockResolvedValue({ id: 'msg-1', thread_id: 'th-1' });
  p.notification.findFirst.mockResolvedValue(null);
  // Interactive $transaction executes its callback against the same mock.
  p.$transaction.mockImplementation(async (arg: any) =>
    typeof arg === 'function' ? arg(p) : Promise.all(arg),
  );
});

describe('CTM webhook auth (fail closed)', () => {
  it('401s EVERY request when CTM_WEBHOOK_TOKEN is unset (fail closed, unlike originVerify)', async () => {
    mockEnv.env.CTM_WEBHOOK_TOKEN = undefined;
    const res = await post('end', CALL_END_PAYLOAD);
    expect(res.status).toBe(401);
    expect(p.ctmEvent.create).not.toHaveBeenCalled();
    expect(p.callSession.upsert).not.toHaveBeenCalled();
  });

  it('401s on a wrong token', async () => {
    const res = await post('end', CALL_END_PAYLOAD, 'wrong-token');
    expect(res.status).toBe(401);
    expect(p.callSession.upsert).not.toHaveBeenCalled();
  });

  it('401s on a missing token', async () => {
    const res = await request(app)
      .post('/api/webhooks/ctm/end')
      .set('Content-Type', 'application/json')
      .send(JSON.stringify(CALL_END_PAYLOAD));
    expect(res.status).toBe(401);
  });

  it('404s an unknown position even with a valid token', async () => {
    const res = await post('made_up_position', CALL_END_PAYLOAD);
    expect(res.status).toBe(404);
    expect(p.ctmEvent.create).not.toHaveBeenCalled();
  });

  it('rejects a wrong X-CTM-Signature when the signing secret is configured', async () => {
    const res = await request(app)
      .post('/api/webhooks/ctm/end?token=hook-token')
      .set('Content-Type', 'application/json')
      .set('X-CTM-Signature', 'bogus')
      .set('X-CTM-Time', '1752000000')
      .send(JSON.stringify(CALL_END_PAYLOAD));
    expect(res.status).toBe(401);
  });

  it('accepts a correct X-CTM-Signature (HMAC-SHA1 over time + raw body, dedicated signing secret)', async () => {
    const rawBody = JSON.stringify(CALL_END_PAYLOAD);
    const time = '1752000000';
    const sig = crypto.createHmac('sha1', 'test-signing-secret').update(time + rawBody).digest('base64');
    const res = await request(app)
      .post('/api/webhooks/ctm/end?token=hook-token')
      .set('Content-Type', 'application/json')
      .set('X-CTM-Signature', sig)
      .set('X-CTM-Time', time)
      .send(rawBody);
    expect(res.status).toBe(200);
  });

  // Regression: the signature gate must NOT reuse CTM_SECRET_KEY (the outbound
  // API secret). CTM signs sub-account webhooks with a different secret, so with
  // the API secret set but no dedicated signing secret, a signed webhook must
  // still pass on the token alone — reusing the API secret 401'd every real
  // Alpha Doors (596375) webhook on 2026-07-13.
  it('does NOT verify the signature against CTM_SECRET_KEY — signed webhook passes when signing secret is unset', async () => {
    mockEnv.env.CTM_WEBHOOK_SIGNING_SECRET = undefined; // API secret stays set
    const rawBody = JSON.stringify(CALL_END_PAYLOAD);
    const time = '1752000000';
    // A signature CTM computed with ITS secret — one we cannot reproduce.
    const foreignSig = crypto.createHmac('sha1', 'ctm-side-secret').update(time + rawBody).digest('base64');
    const res = await request(app)
      .post('/api/webhooks/ctm/end?token=hook-token')
      .set('Content-Type', 'application/json')
      .set('X-CTM-Signature', foreignSig)
      .set('X-CTM-Time', time)
      .send(rawBody);
    expect(res.status).toBe(200);
  });
});

describe('CTM webhook ingestion flow', () => {
  it('ingests an inbound answered call at end (row upserted on ctm_call_id, org-scoped)', async () => {
    const res = await post('end', CALL_END_PAYLOAD);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ received: true });
    expect(p.callSession.upsert).toHaveBeenCalledTimes(1);
    const call = p.callSession.upsert.mock.calls[0][0];
    expect(call.where).toEqual({ ctm_call_id: 'CA0001' });
    expect(call.create.organization_id).toBe('org-1');
    expect(call.create.direction).toBe('in');
    expect(call.create.status).toBe('completed');
    expect(call.create.has_recording).toBe(true);
    expect(call.create.ctm_call_id).toBe('CA0001');
  });

  it('maps no-answer to missed', async () => {
    await post('end', { ...CALL_END_PAYLOAD, sid: 'CA0002', dial_status: 'no-answer', audio: undefined });
    const call = p.callSession.upsert.mock.calls[0][0];
    expect(call.create.status).toBe('missed');
  });

  it('stores BOTH clocks: talk_time as duration_sec, duration as connected_sec', async () => {
    // The payload carries duration 62 / talk_time 48. They are different
    // quantities and both are needed: the Calls list shows the conversation,
    // the plan allowance meters the connected time CTM actually invoices.
    // Collapsing them to one field under-counted billed minutes by 13.6%.
    await post('end', CALL_END_PAYLOAD);
    const call = p.callSession.upsert.mock.calls[0][0];
    expect(call.create.duration_sec).toBe(48);
    expect(call.create.connected_sec).toBe(62);
    expect(call.update.connected_sec).toBe(62);
  });

  it('records the connected clock for a call that rang and was never answered', async () => {
    // CTM billed 26 of 26 such calls in the live account. talk_time is 0, so
    // the allowance would see nothing at all without the connected clock.
    await post('end', {
      ...CALL_END_PAYLOAD,
      sid: 'CA0003',
      dial_status: 'no-answer',
      talk_time: 0,
      duration: 32,
      audio: undefined,
    });
    const call = p.callSession.upsert.mock.calls[0][0];
    expect(call.create.status).toBe('missed');
    expect(call.create.duration_sec).toBe(0);
    expect(call.create.connected_sec).toBe(32);
  });

  it('replays are idempotent: pre-recorded event → 200 duplicate, no ingest', async () => {
    p.ctmEvent.findUnique.mockResolvedValue({ id: 'evt-existing' });
    const res = await post('end', CALL_END_PAYLOAD);
    expect(res.status).toBe(200);
    expect(res.body.duplicate).toBe(true);
    expect(p.callSession.upsert).not.toHaveBeenCalled();
  });

  it('concurrent duplicate (P2002 on claim) → 200 duplicate, no 500', async () => {
    p.ctmEvent.create.mockRejectedValueOnce({ code: 'P2002' });
    const res = await post('end', CALL_END_PAYLOAD);
    expect(res.status).toBe(200);
    expect(res.body.duplicate).toBe(true);
  });

  it('unknown CTM account → 200, event recorded, NO side effects', async () => {
    p.organization.findFirst.mockResolvedValue(null);
    const res = await post('end', CALL_END_PAYLOAD);
    expect(res.status).toBe(200);
    expect(p.ctmEvent.create).toHaveBeenCalledTimes(1);
    expect(p.callSession.upsert).not.toHaveBeenCalled();
  });

  it('starts (inbound ring) creates a ringing row and never clobbers on update', async () => {
    await post('starts', { ...CALL_END_PAYLOAD, sid: 'CA0003', dial_status: undefined, audio: undefined });
    const call = p.callSession.upsert.mock.calls[0][0];
    expect(call.create.status).toBe('ringing');
    // A late/duplicate `starts` must not downgrade an ended call: update clause is empty.
    expect(call.update).toEqual({});
  });

  it('start_outbound is tolerated as an alias of starts', async () => {
    const res = await post('start_outbound', { ...CALL_END_PAYLOAD, sid: 'CA0004', direction: 'outbound' });
    expect(res.status).toBe(200);
    expect(p.callSession.upsert).toHaveBeenCalled();
  });

  it('DB failure during ingest → 500 (CTM retry + backfill re-deliver)', async () => {
    p.callSession.upsert.mockRejectedValue(new Error('db down'));
    const res = await post('end', CALL_END_PAYLOAD);
    expect(res.status).toBe(500);
  });

  it('a sid already stored for ANOTHER org is warned + skipped — never upserted cross-org', async () => {
    p.callSession.findFirst.mockResolvedValue({ organization_id: 'org-OTHER' });
    const res = await post('end', CALL_END_PAYLOAD);
    expect(res.status).toBe(200);
    expect(p.callSession.upsert).not.toHaveBeenCalled();
  });

  it('rejects unparseable bodies with 400', async () => {
    const res = await request(app)
      .post('/api/webhooks/ctm/end?token=hook-token')
      .set('Content-Type', 'application/json')
      .send('this is not json');
    expect(res.status).toBe(400);
  });
});

describe('CTM inbound SMS ingestion', () => {
  const SMS_PAYLOAD = {
    message_id: 'MSG0001',
    account_id: 596375,
    caller_number: '+12015551234',
    tracking_number: '+12019037784',
    direction: 'msg_inbound',
    message_body: 'Hi, is my door fixed?',
    unix_time: 1_752_000_100,
  };

  it('creates thread + message + unread increment for a new inbound text', async () => {
    const res = await post('inbound_text', SMS_PAYLOAD);
    expect(res.status).toBe(200);
    expect(p.messageThread.create).toHaveBeenCalledTimes(1);
    const msg = p.message.create.mock.calls[0][0];
    expect(msg.data.ctm_sms_id).toBe('MSG0001');
    expect(msg.data.direction).toBe('in');
    expect(msg.data.body).toBe('Hi, is my door fixed?');
    expect(msg.data.organization_id).toBe('org-1');
    expect(p.messageThread.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: { unread: { increment: 1 } } }),
    );
  });

  it('duplicate message sid updates status only (no second row, no body clobber) — sid lookup is org-scoped', async () => {
    p.message.findFirst.mockResolvedValue({ id: 'msg-1', thread_id: 'th-1' });
    await post('inbound_text', { ...SMS_PAYLOAD });
    expect(p.message.create).not.toHaveBeenCalled();
    expect(p.message.update).toHaveBeenCalledTimes(1);
    expect(p.message.update.mock.calls[0][0].data).toEqual({ status: 'received' });
    // Cross-org: the sid lookup must never resolve another org's message.
    expect(p.message.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ ctm_sms_id: 'MSG0001', organization_id: 'org-1' }),
      }),
    );
  });

  it('unmatched threads key by the E.164-normalized number — bare vs +1 spellings share one thread', async () => {
    // First text arrives with the bare 10-digit spelling…
    await post('inbound_text', { ...SMS_PAYLOAD, caller_number: '2015551234', caller_number_complete: undefined });
    expect(p.messageThread.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ title: '+12015551234' }),
      }),
    );
    const created = p.messageThread.create.mock.calls[0][0];
    expect(created.data.title).toBe('+12015551234');
  });

  it('sms_error_code marks the message failed', async () => {
    await post('outbound_text', { ...SMS_PAYLOAD, message_id: 'MSG0002', direction: 'msg_outbound', sms_error_code: '30007' });
    const msg = p.message.create.mock.calls[0][0];
    expect(msg.data.status).toBe('failed');
  });

  it('status_change updates a stored message to delivered', async () => {
    p.message.findFirst.mockResolvedValue({ id: 'msg-1' });
    const res = await post('sms_status', { ...SMS_PAYLOAD, status: 'delivered' });
    expect(res.status).toBe(200);
    expect(p.message.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: { status: 'delivered' } }),
    );
  });
});

describe('CTM SMS thread find/create parity (one thread per counterpart)', () => {
  const SMS_PAYLOAD = {
    message_id: 'MSG1001',
    account_id: 596375,
    caller_number: '+12015551234',
    tracking_number: '+12019037784',
    direction: 'msg_inbound',
    message_body: 'First message',
    unix_time: 1_752_000_100,
  };

  it('vendor-matched inbound twice → ONE thread (find keys by vendor_id, mirroring create)', async () => {
    p.vendor.findFirst.mockResolvedValue({ id: 'vendor-1', name: 'Acme Supply' });

    // First text: no thread yet → created with vendor_id + title null.
    await post('inbound_text', SMS_PAYLOAD);
    expect(p.messageThread.create).toHaveBeenCalledTimes(1);
    const created = p.messageThread.create.mock.calls[0][0];
    expect(created.data.vendor_id).toBe('vendor-1');
    expect(created.data.customer_id).toBeNull();
    expect(created.data.title).toBeNull();
    // The FIND must mirror the CREATE: keyed on vendor_id, not on title.
    expect(p.messageThread.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ organization_id: 'org-1', channel: 'sms', vendor_id: 'vendor-1' }),
      }),
    );

    // Second text: the vendor-keyed find now hits → NO second thread.
    p.messageThread.findFirst.mockResolvedValue({ id: 'th-1' });
    await post('inbound_text', { ...SMS_PAYLOAD, message_id: 'MSG1002', message_body: 'Second message' });
    expect(p.messageThread.create).toHaveBeenCalledTimes(1);
  });

  it('linking parity: a lead match lands customer_id + lead_id on the created thread', async () => {
    p.lead.findFirst.mockResolvedValue({ id: 'lead-1', lead_number: 'L00007', customer_id: 'cust-9' });

    await post('inbound_text', { ...SMS_PAYLOAD, message_id: 'MSG1003' });

    const created = p.messageThread.create.mock.calls[0][0];
    expect(created.data.customer_id).toBe('cust-9');
    expect(created.data.lead_id).toBe('lead-1');
    expect(created.data.vendor_id).toBeNull();
    expect(created.data.title).toBeNull();
    // Lead matches carry customerId → the customer arm keys the find.
    expect(p.messageThread.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ customer_id: 'cust-9' }),
      }),
    );
  });

  // Full job-parity ruling (2026-07-22): getLeadCommunications now filters
  // strictly on Message.lead_id, so an inbound reply that only lands lead_id
  // on the THREAD (not the message) would silently vanish from the lead's
  // Communication tab. This is the message-level mirror of the thread test
  // above.
  it('linking parity: a lead match also lands lead_id on the created MESSAGE itself, not just the thread', async () => {
    p.lead.findFirst.mockResolvedValue({ id: 'lead-1', lead_number: 'L00007', customer_id: 'cust-9' });

    await post('inbound_text', { ...SMS_PAYLOAD, message_id: 'MSG1005' });

    const msg = p.message.create.mock.calls[0][0];
    expect(msg.data.lead_id).toBe('lead-1');
  });

  it('linking parity: a customer match lands customer_id on the created thread', async () => {
    p.customer.findFirst.mockResolvedValue({
      id: 'cust-1', first_name: 'Pat', last_name: 'Lee', company_name: null,
    });

    await post('inbound_text', { ...SMS_PAYLOAD, message_id: 'MSG1004' });

    const created = p.messageThread.create.mock.calls[0][0];
    expect(created.data.customer_id).toBe('cust-1');
    expect(created.data.title).toBeNull();
    expect(p.messageThread.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ customer_id: 'cust-1' }),
      }),
    );
  });
});

describe('CTM outbound SMS reconciliation (webhook side)', () => {
  const OUT_PAYLOAD = {
    message_id: 'MSG2001',
    account_id: 596375,
    caller_number: '+12019037784',
    called_number: '+12015551234',
    direction: 'msg_outbound',
    message_body: 'Your technician is on the way',
    unix_time: 1_752_000_200,
  };

  it('stamps the sid onto a sid-less local outbound row (same thread+body, ts ±60s) instead of duplicating', async () => {
    p.messageThread.findFirst.mockResolvedValue({ id: 'th-1' });
    // 1st findFirst: sid lookup → miss. 2nd: shell reconcile → hit.
    p.message.findFirst
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ id: 'shell-1' });

    const res = await post('outbound_text', OUT_PAYLOAD);
    expect(res.status).toBe(200);

    expect(p.message.create).not.toHaveBeenCalled();
    expect(p.message.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'shell-1' },
        data: { ctm_sms_id: 'MSG2001', status: 'sent' },
      }),
    );
    // The shell query matches on org+thread+direction+body with a bounded ts window.
    const shellWhere = p.message.findFirst.mock.calls[1][0].where;
    expect(shellWhere).toMatchObject({
      organization_id: 'org-1',
      thread_id: 'th-1',
      direction: 'out',
      ctm_sms_id: null,
      body: 'Your technician is on the way',
    });
    expect(shellWhere.ts.gte).toEqual(new Date((1_752_000_200 - 60) * 1000));
    expect(shellWhere.ts.lte).toEqual(new Date((1_752_000_200 + 60) * 1000));
  });

  it('creates a fresh outbound row when no sid-less shell matches', async () => {
    p.messageThread.findFirst.mockResolvedValue({ id: 'th-1' });
    p.message.findFirst.mockResolvedValue(null);

    await post('outbound_text', { ...OUT_PAYLOAD, message_id: 'MSG2002' });

    expect(p.message.create).toHaveBeenCalledTimes(1);
    expect(p.message.create.mock.calls[0][0].data.ctm_sms_id).toBe('MSG2002');
    // Outbound never bumps unread.
    expect(p.messageThread.update).not.toHaveBeenCalled();
  });
});
/* eslint-enable @typescript-eslint/no-explicit-any */

// ─────────────────────────────────────────────────────────────────────────────
// `status_change` is the REAL outbound-text carrier.
//
// Measured live 2026-08-01 against staging Supabase + the CTM API: the
// `outbound_text` hook is provisioned on both connected accounts (ids 274748 /
// 274595, `disabled: false`, no conditions) and has fired ZERO times in 21
// days, while all 12 stored `status_change` events are `direction:
// msg_outbound` carrying a full text activity - `message_id`, `message_body`,
// caller/contact numbers and a sent|delivered status. `message_id` is the clean
// discriminator: present on 18/18 text events, absent on all 36 call events.
//
// So a text-shaped `status_change` must run the SAME ingest as `outbound_text`
// (create / shell-reconcile / status), not the lean status-delta path that
// requires a row already keyed by ctm_sms_id - with 42 of 58 message rows
// holding no sid, that path could never reach them.
// ─────────────────────────────────────────────────────────────────────────────
describe('CTM status_change carries outbound texts (the outbound_text hook never fires)', () => {
  const STATUS_CHANGE_TEXT = {
    sid: '1056366839',
    message_id: 'MSGA9B07EC712F11C71FF8D9CB2DB3A28D80EBAA4A638C1559085F6E896A61189CC',
    account_id: 596375,
    caller_number: '+15555550199',
    contact_number: '+15555550199',
    called_number: '+12015551234',
    direction: 'msg_outbound',
    call_status: 'sent',
    dial_status: 'sent',
    status: 'sent',
    message_body: 'Hi Ran, this is a live test text from ServWave',
    unix_time: 1_752_000_300,
  };

  it('ingests a text-shaped status_change as a full outbound message, not a status delta', async () => {
    p.messageThread.findFirst.mockResolvedValue({ id: 'th-1' });
    p.message.findFirst.mockResolvedValue(null);

    const res = await post('status_change', STATUS_CHANGE_TEXT);
    expect(res.status).toBe(200);

    expect(p.message.create).toHaveBeenCalledTimes(1);
    const msg = p.message.create.mock.calls[0][0];
    expect(msg.data.ctm_sms_id).toBe(STATUS_CHANGE_TEXT.message_id);
    expect(msg.data.direction).toBe('out');
    expect(msg.data.body).toBe('Hi Ran, this is a live test text from ServWave');
    expect(msg.data.status).toBe('sent');
  });

  it('reconciles the sid onto a sid-less local row - the only way a POST-response-less send gets confirmed', async () => {
    p.messageThread.findFirst.mockResolvedValue({ id: 'th-1' });
    // 1st findFirst: sid lookup → miss. 2nd: shell reconcile → hit.
    p.message.findFirst
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ id: 'shell-1' });

    await post('status_change', { ...STATUS_CHANGE_TEXT, status: 'delivered', call_status: 'delivered' });

    expect(p.message.create).not.toHaveBeenCalled();
    expect(p.message.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'shell-1' },
        data: { ctm_sms_id: STATUS_CHANGE_TEXT.message_id, status: 'delivered' },
      }),
    );
  });

  it('promotes an already-stored row to delivered (carrier confirmation)', async () => {
    p.message.findFirst.mockResolvedValue({ id: 'msg-1', thread_id: 'th-1' });

    await post('status_change', { ...STATUS_CHANGE_TEXT, status: 'delivered', call_status: 'delivered' });

    expect(p.message.create).not.toHaveBeenCalled();
    expect(p.message.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: { status: 'delivered' } }),
    );
  });

  it('an sms_error_code on a status_change marks the row failed, never sent', async () => {
    p.message.findFirst.mockResolvedValue({ id: 'msg-1', thread_id: 'th-1' });

    await post('status_change', { ...STATUS_CHANGE_TEXT, sms_error_code: '30007' });

    expect(p.message.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: { status: 'failed' } }),
    );
  });

  it('a CALL status_change (no message_id) never reaches the SMS ingest path', async () => {
    const res = await post('status_change', { ...CALL_END_PAYLOAD, dial_status: 'answered' });
    expect(res.status).toBe(200);
    expect(p.message.create).not.toHaveBeenCalled();
    expect(p.messageThread.create).not.toHaveBeenCalled();
  });
});
