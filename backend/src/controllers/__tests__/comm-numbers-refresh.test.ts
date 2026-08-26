// POST /numbers/refresh - make the numbers list a mirror, not a snapshot.
//
// Numbers were imported ONCE, when the org connected, and never again. The
// live sub-account holds four numbers and ServWave shows two of them: a number
// bought in the vendor's own dashboard and a number ServWave bought but failed
// to save are both invisible, and the second is invisible while still billing.
// Every row also has a null `type`, so a toll-free number renders as "Local".
//
// Shapes below are the live 2026-08-12 response, not invented: `route_to` is
// `{type:'receiving_number', dial:[{number}]}` when a number simply forwards,
// `{type:'call_queue', dial:{...}}` when it does not, and `dial: []` when the
// number rings nowhere at all.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import app from '../../app';
import { prisma } from '../../lib/prisma';
import * as ctmClient from '../../lib/ctm/client';
import { clearTokenCache } from '../../middleware/authenticate';
import { clearPermissionCache } from '../../lib/permissions/permissionCache';
import { mockAuthAs, authHeader } from '../../__tests__/helpers';

/* eslint-disable @typescript-eslint/no-explicit-any */
const p = prisma as any;
const client = ctmClient as any;

const CTM_ACCOUNT_ID = '597911';

const FORWARDING = {
  id: 'TPN-forwarding',
  number: '+16097191235',
  formatted: '(609) 719-1235',
  name: null,
  type: 'local',
  status: 'active',
  sms_enabled: true,
  route_to: {
    type: 'receiving_number',
    multi: true,
    mode: 'simultaneous',
    dial: [{ filter_id: 3906455, number: '+15555550199', name: null }],
  },
};

const TOLL_FREE_UNROUTED = {
  id: 'TPN-tollfree',
  number: '+18555334801',
  formatted: '(855) 533-4801',
  name: 'call flow ',
  type: 'tollfree',
  status: 'active',
  sms_enabled: true,
  route_to: { type: 'receiving_number', multi: true, mode: 'simultaneous', dial: [] },
};

const QUEUE_ROUTED = {
  id: 'TPN-queue',
  number: '+12394884861',
  formatted: '(239) 488-4861',
  name: '',
  type: 'local',
  status: 'active',
  sms_enabled: true,
  route_to: { type: 'call_queue', dial: { id: 'CQU1', name: 'Simultaneous|Receiving Number Queue' } },
};

const STOPPED = {
  id: 'TPN-stopped',
  number: '+16095968565',
  formatted: '(609) 596-8565',
  name: null,
  type: 'local',
  status: 'stopped',
  sms_enabled: false,
  route_to: { type: 'receiving_number', multi: true, mode: 'simultaneous', dial: [] },
};

function storedRow(over: Record<string, unknown> = {}) {
  return {
    id: 'pn-1',
    e164: '+16097191235',
    formatted: '(609) 719-1235',
    label: null,
    source: 'ctm',
    type: 'local',
    sms_enabled: true,
    ctm_number_id: 'TPN-forwarding',
    call_flow_id: null,
    route_to: { forward_to: '+15555550199' },
    status: 'active',
    created_at: new Date('2026-08-06T02:46:37.507Z'),
    ...over,
  };
}

const refresh = () =>
  request(app).post('/api/communication/numbers/refresh').set(authHeader('admin')).send({});

/** The upsert call for a given E.164. */
const upsertFor = (e164: string) =>
  p.phoneNumber.upsert.mock.calls.map((c: any[]) => c[0]).find((a: any) => a.create.e164 === e164);

beforeEach(() => {
  vi.clearAllMocks();
  clearTokenCache();
  clearPermissionCache();
  p.auditLog.create.mockResolvedValue({});
  mockAuthAs('admin');

  client.isCtmConfigured.mockReturnValue(true);
  p.organization.findUnique.mockResolvedValue({ ctm_account_id: CTM_ACCOUNT_ID });
  client.listNumbers.mockResolvedValue([FORWARDING, TOLL_FREE_UNROUTED, QUEUE_ROUTED, STOPPED]);
  p.phoneNumber.upsert.mockImplementation((args: any) =>
    Promise.resolve(storedRow({ ...args.create })),
  );
  p.phoneNumber.findMany.mockResolvedValue([storedRow()]);
});

describe('POST /api/communication/numbers/refresh', () => {
  it('brings across every number the account holds, not just the ones already known', async () => {
    const res = await refresh();

    expect(res.status).toBe(200);
    expect(p.phoneNumber.upsert).toHaveBeenCalledTimes(4);
    expect(res.body.synced).toBe(4);
  });

  it('carries the number type through so a toll-free number stops reading as Local', async () => {
    await refresh();

    expect(upsertFor('+18555334801').create.type).toBe('tollfree');
    expect(upsertFor('+18555334801').update.type).toBe('tollfree');
  });

  it('records where a forwarding number actually rings', async () => {
    await refresh();

    expect(upsertFor('+16097191235').update.route_to).toEqual({ forward_to: '+15555550199' });
  });

  it('does not flatten a queue-routed number into a forward it is not', async () => {
    await refresh();

    expect(upsertFor('+12394884861').update.route_to).toBeUndefined();
  });

  it('leaves a number that rings nowhere with no destination, rather than a stale one', async () => {
    // dial: [] is the live shape for a number nobody ever routed. Reporting a
    // destination here is exactly the lie the "Not routed" badge exists to stop.
    await refresh();

    expect(upsertFor('+18555334801').create.route_to).toBeUndefined();
  });

  it('mirrors a stopped number as paused instead of dropping it', async () => {
    await refresh();

    expect(upsertFor('+16095968565').create.status).toBe('paused');
  });

  it('does not overwrite the texting flag on a number already on file', async () => {
    // sms_enabled is owned by the enablement call on buy/connect; a read-only
    // mirror must not silently turn texting off.
    await refresh();

    expect(upsertFor('+16097191235').update.sms_enabled).toBeUndefined();
    expect(upsertFor('+16097191235').create.sms_enabled).toBe(true);
  });

  it('returns the refreshed list so the table can render server truth', async () => {
    const res = await refresh();

    expect(res.body.numbers).toHaveLength(1);
    expect(res.body.numbers[0]).toMatchObject({ e164: '+16097191235', forward_to: '+15555550199' });
  });

  it('409s when the org is not connected, without calling the phone system', async () => {
    p.organization.findUnique.mockResolvedValue({ ctm_account_id: null });

    const res = await refresh();

    expect(res.status).toBe(409);
    expect(client.listNumbers).not.toHaveBeenCalled();
  });

  it('502s rather than reporting an empty account when the phone system fails', async () => {
    client.listNumbers.mockRejectedValue(new ctmClient.CtmApiError(500, 'boom'));

    const res = await refresh();

    expect(res.status).toBe(502);
    expect(p.phoneNumber.upsert).not.toHaveBeenCalled();
  });

  it('is refused to a non-admin - it is org plumbing', async () => {
    mockAuthAs('technician');

    const res = await request(app)
      .post('/api/communication/numbers/refresh')
      .set(authHeader('technician'))
      .send({});

    expect(res.status).toBe(403);
    expect(client.listNumbers).not.toHaveBeenCalled();
  });
});
