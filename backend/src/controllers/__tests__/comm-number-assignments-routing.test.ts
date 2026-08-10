// Master plan Task D2 — syncing inbound routing to CTM on number assignment.
// Assigning a number to a user (or making it the org default) should call the
// CONFIRMED-automatable half of lib/ctm/routing.ts (ensureVoicemailMenu +
// routeNumberToVoiceMenu) and hand back describeManualQueueScaffold's
// instructions for the unconfirmed half (Queue/Agent ring config). The CTM
// client (lib/ctm/client.ts) is globally mocked by setup.ts — this suite
// never hits the network, exactly like routing.test.ts.
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

const PN1 = '00000000-0000-0000-0000-0000000000e1';
const UID_A = '00000000-0000-0000-0000-0000000000ea';
const UID_B = '00000000-0000-0000-0000-0000000000eb';
const CTM_ACCOUNT_ID = '596375';

const numberRow = (over: Record<string, unknown> = {}) => ({
  id: PN1,
  e164: '+15555550212',
  label: null,
  ctm_number_id: 'TPN123',
  route_to: null,
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  clearTokenCache();
  clearPermissionCache();
  p.$transaction.mockImplementation((arg: any) =>
    typeof arg === 'function' ? arg(p) : Promise.all(arg),
  );
  p.auditLog.create.mockResolvedValue({});

  mockAuthAs('admin');

  // CTM connected + configured, the number is CTM-provisioned.
  client.isCtmConfigured.mockReturnValue(true);
  p.organization.findUnique.mockResolvedValue({ ctm_account_id: CTM_ACCOUNT_ID });
  p.phoneNumber.findFirst.mockResolvedValue(numberRow());
  p.phoneNumber.update.mockResolvedValue({});
  p.phoneNumber.updateMany.mockResolvedValue({ count: 0 });
  p.user.count.mockResolvedValue(1);
  p.user.findFirst.mockResolvedValue({ first_name: 'Ran', last_name: 'Nakamura' });
  p.userPhoneNumber.deleteMany.mockResolvedValue({ count: 0 });
  p.userPhoneNumber.createMany.mockResolvedValue({ count: 1 });

  client.createVoiceMenu.mockResolvedValue({ id: 'VOM1' });
  client.addReceivingToTracking.mockResolvedValue({});
});

describe('PUT /api/communication/numbers/:id/assignments — inbound routing sync', () => {
  it('assigning a single user creates the voicemail menu and routes the number to it', async () => {
    const res = await request(app)
      .put(`/api/communication/numbers/${PN1}/assignments`)
      .set(authHeader('admin'))
      .send({ user_ids: [UID_A] });

    expect(res.status).toBe(200);
    expect(client.createVoiceMenu).toHaveBeenCalledWith(
      CTM_ACCOUNT_ID,
      expect.objectContaining({ name: expect.stringContaining('Art Nakamura') }),
    );
    expect(client.addReceivingToTracking).toHaveBeenCalledWith(CTM_ACCOUNT_ID, 'TPN123', {
      virtual_phone_number: { dial_route: 'voice_menu', voice_menu_id: 'VOM1' },
    });
    expect(p.phoneNumber.update).toHaveBeenCalledWith({
      where: { id: PN1 },
      data: {
        route_to: { voice_menu_id: 'VOM1', voice_menu_name: expect.stringContaining('Art Nakamura') },
      },
    });
  });

  it('response includes the manual-scaffold instructions with the real voice-menu id/name and number', async () => {
    const res = await request(app)
      .put(`/api/communication/numbers/${PN1}/assignments`)
      .set(authHeader('admin'))
      .send({ user_ids: [UID_A] });

    expect(res.body.routing).toMatchObject({ synced: true, voice_menu_id: 'VOM1' });
    const scaffold = res.body.routing.manual_scaffold;
    const joined = [scaffold.title, scaffold.summary, ...scaffold.steps].join(' ');
    expect(joined).toContain('VOM1');
    expect(joined).toContain('Art Nakamura');
    expect(joined).toContain('(555) 555-0212');
  });

  it('unassigning (empty user_ids) makes NO CTM calls and reports routing:null', async () => {
    const res = await request(app)
      .put(`/api/communication/numbers/${PN1}/assignments`)
      .set(authHeader('admin'))
      .send({ user_ids: [] });

    expect(res.status).toBe(200);
    expect(client.createVoiceMenu).not.toHaveBeenCalled();
    expect(client.addReceivingToTracking).not.toHaveBeenCalled();
    expect(res.body.routing).toBeNull();
  });

  it('reuses an already-known voice menu id instead of creating a new one (idempotent)', async () => {
    p.phoneNumber.findFirst.mockResolvedValue(
      numberRow({ route_to: { voice_menu_id: 'VOM-OLD', voice_menu_name: 'Old Name' } }),
    );

    const res = await request(app)
      .put(`/api/communication/numbers/${PN1}/assignments`)
      .set(authHeader('admin'))
      .send({ user_ids: [UID_A] });

    expect(res.status).toBe(200);
    expect(client.createVoiceMenu).not.toHaveBeenCalled();
    expect(client.addReceivingToTracking).toHaveBeenCalledWith(CTM_ACCOUNT_ID, 'TPN123', {
      virtual_phone_number: { dial_route: 'voice_menu', voice_menu_id: 'VOM-OLD' },
    });
  });

  it('CTM not configured: the assignment still succeeds; routing reports synced:false with a reason', async () => {
    client.isCtmConfigured.mockReturnValue(false);

    const res = await request(app)
      .put(`/api/communication/numbers/${PN1}/assignments`)
      .set(authHeader('admin'))
      .send({ user_ids: [UID_A] });

    expect(res.status).toBe(200);
    expect(client.createVoiceMenu).not.toHaveBeenCalled();
    expect(res.body.routing).toEqual({ synced: false, reason: expect.any(String) });
    expect(p.userPhoneNumber.createMany).toHaveBeenCalled();
  });

  it('a bring-your-own number (no ctm_number_id) skips the CTM sync', async () => {
    p.phoneNumber.findFirst.mockResolvedValue(numberRow({ ctm_number_id: null }));

    const res = await request(app)
      .put(`/api/communication/numbers/${PN1}/assignments`)
      .set(authHeader('admin'))
      .send({ user_ids: [UID_A] });

    expect(res.status).toBe(200);
    expect(client.createVoiceMenu).not.toHaveBeenCalled();
    expect(res.body.routing).toEqual({ synced: false, reason: expect.any(String) });
  });

  it('a CTM API failure never fails the assignment write — degrades to synced:false', async () => {
    client.addReceivingToTracking.mockRejectedValue(new Error('CTM API error 500: boom'));

    const res = await request(app)
      .put(`/api/communication/numbers/${PN1}/assignments`)
      .set(authHeader('admin'))
      .send({ user_ids: [UID_A] });

    expect(res.status).toBe(200);
    expect(res.body.routing).toEqual({ synced: false, reason: expect.any(String) });
    expect(p.userPhoneNumber.createMany).toHaveBeenCalled();
  });

  it('a shared/team assignment (>1 user) still syncs the voicemail routing, with generic instructions', async () => {
    p.user.count.mockResolvedValue(2);

    const res = await request(app)
      .put(`/api/communication/numbers/${PN1}/assignments`)
      .set(authHeader('admin'))
      .send({ user_ids: [UID_A, UID_B] });

    expect(res.status).toBe(200);
    expect(client.createVoiceMenu).toHaveBeenCalled();
    // No single agent to name — the per-name lookup never fires for >1 user.
    expect(p.user.findFirst).not.toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ id: UID_A }) }),
    );
    expect(res.body.routing.manual_scaffold.steps.join(' ')).toMatch(/this user/i);
  });
});

describe('PUT /api/communication/numbers/:id/org-default — inbound routing sync', () => {
  it('setting the org default syncs the voicemail routing and returns manual-scaffold instructions', async () => {
    const res = await request(app)
      .put(`/api/communication/numbers/${PN1}/org-default`)
      .set(authHeader('admin'))
      .send({});

    expect(res.status).toBe(200);
    expect(client.createVoiceMenu).toHaveBeenCalled();
    expect(client.addReceivingToTracking).toHaveBeenCalledWith(CTM_ACCOUNT_ID, 'TPN123', {
      virtual_phone_number: { dial_route: 'voice_menu', voice_menu_id: 'VOM1' },
    });
    expect(res.body.routing.synced).toBe(true);
    expect(res.body.routing.manual_scaffold.steps.join(' ')).toContain('VOM1');
  });

  it('unsetting the org default makes NO CTM calls and reports routing:null', async () => {
    const res = await request(app)
      .put(`/api/communication/numbers/${PN1}/org-default`)
      .set(authHeader('admin'))
      .send({ is_org_default: false });

    expect(res.status).toBe(200);
    expect(client.createVoiceMenu).not.toHaveBeenCalled();
    expect(client.addReceivingToTracking).not.toHaveBeenCalled();
    expect(res.body.routing).toBeNull();
  });
});
