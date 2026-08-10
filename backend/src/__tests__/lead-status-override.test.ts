import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';
import app from '../app';
import { prisma } from '../lib/prisma';
import { mockAuthAs, authHeader, ALPHA_ORG_ID, ORG_B_ID } from './helpers';
import { clearPermissionCache } from '../lib/permissions/permissionCache';

/**
 * SRVW-111 (label-override shape, per Ran's 2026-08-05 scope call) - per-org display overrides
 * for the FIXED LeadStatus enum: rename, reorder, hide, default. Does NOT widen LeadStatus and
 * does NOT let an org add a new value - Servy's advertised lead vocabulary is untouched.
 *
 * At most one row per (org, status); at most 6 rows per org, total. Until any row exists, GET
 * falls back to the enum's own 6 values in declaration order with NEW as the implicit default -
 * there is no seed/backfill.
 */

const mockPrisma = prisma as unknown as {
  leadStatusOverride: {
    findMany: ReturnType<typeof vi.fn>;
    findFirst: ReturnType<typeof vi.fn>;
    create: ReturnType<typeof vi.fn>;
    update: ReturnType<typeof vi.fn>;
    upsert: ReturnType<typeof vi.fn>;
    updateMany: ReturnType<typeof vi.fn>;
  };
  $transaction: ReturnType<typeof vi.fn>;
};

function installTransactionPassthrough() {
  mockPrisma.$transaction.mockImplementation(async (arg: unknown) =>
    typeof arg === 'function'
      ? (arg as (tx: unknown) => Promise<unknown>)(mockPrisma)
      : Promise.all(arg as Promise<unknown>[]),
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  clearPermissionCache();
  installTransactionPassthrough();
  mockPrisma.leadStatusOverride.findMany.mockResolvedValue([]);
});

// ─── GET /api/lead-status-overrides ─────────────────────────────────────────

describe('GET /api/lead-status-overrides', () => {
  it('returns all 6 LeadStatus values in declaration order with NEW as the implicit default when the org has no rows', async () => {
    mockAuthAs('admin');

    const res = await request(app).get('/api/lead-status-overrides').set(authHeader('admin'));

    expect(res.status).toBe(200);
    expect(mockPrisma.leadStatusOverride.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ organization_id: ALPHA_ORG_ID }) }),
    );
    expect(res.body.lead_status_overrides).toEqual([
      { status: 'NEW', label: null, sort_order: 0, is_default: true, hidden: false },
      { status: 'CONTACTED', label: null, sort_order: 1, is_default: false, hidden: false },
      { status: 'ESTIMATED', label: null, sort_order: 2, is_default: false, hidden: false },
      { status: 'WON', label: null, sort_order: 3, is_default: false, hidden: false },
      { status: 'LOST', label: null, sort_order: 4, is_default: false, hidden: false },
      { status: 'CANCELLED', label: null, sort_order: 5, is_default: false, hidden: false },
    ]);
  });

  it('merges stored rows over the enum default, and the configured default wins over NEW', async () => {
    mockAuthAs('admin');
    mockPrisma.leadStatusOverride.findMany.mockResolvedValue([
      { status: 'WON', label: 'Closed Won', sort_order: 3, is_default: true, hidden: false },
      { status: 'CANCELLED', label: null, sort_order: 5, is_default: false, hidden: true },
    ]);

    const res = await request(app).get('/api/lead-status-overrides').set(authHeader('admin'));

    expect(res.status).toBe(200);
    const won = res.body.lead_status_overrides.find((s: { status: string }) => s.status === 'WON');
    expect(won).toEqual({ status: 'WON', label: 'Closed Won', sort_order: 3, is_default: true, hidden: false });
    const cancelled = res.body.lead_status_overrides.find((s: { status: string }) => s.status === 'CANCELLED');
    expect(cancelled).toEqual({ status: 'CANCELLED', label: null, sort_order: 5, is_default: false, hidden: true });
    // NEW is no longer the implicit default once a real row claims it.
    const neu = res.body.lead_status_overrides.find((s: { status: string }) => s.status === 'NEW');
    expect(neu.is_default).toBe(false);
  });

  it('is sorted by sort_order, not declaration order, once rows override it', async () => {
    mockAuthAs('admin');
    mockPrisma.leadStatusOverride.findMany.mockResolvedValue([
      { status: 'WON', label: null, sort_order: 0, is_default: true, hidden: false },
      { status: 'NEW', label: null, sort_order: 1, is_default: false, hidden: false },
    ]);

    const res = await request(app).get('/api/lead-status-overrides').set(authHeader('admin'));

    expect(res.body.lead_status_overrides[0].status).toBe('WON');
    expect(res.body.lead_status_overrides[1].status).toBe('NEW');
  });
});

// ─── PATCH /api/lead-status-overrides/:status ───────────────────────────────

describe('PATCH /api/lead-status-overrides/:status', () => {
  it('400s an invalid status param', async () => {
    mockAuthAs('admin');

    const res = await request(app)
      .patch('/api/lead-status-overrides/NOT_A_STATUS')
      .set(authHeader('admin'))
      .send({ label: 'Whatever' });

    expect(res.status).toBe(400);
  });

  it('upserts a new row scoped to the caller org when none exists yet, defaulting sort_order to the status’s own declaration index', async () => {
    mockAuthAs('admin');
    mockPrisma.leadStatusOverride.upsert.mockResolvedValue({
      status: 'WON', label: 'Closed Won', sort_order: 3, is_default: false, hidden: false,
    });

    const res = await request(app)
      .patch('/api/lead-status-overrides/WON')
      .set(authHeader('admin'))
      .send({ label: 'Closed Won' });

    expect(res.status).toBe(200);
    const call = mockPrisma.leadStatusOverride.upsert.mock.calls[0][0];
    expect(call.where).toMatchObject({ organization_id_status: { organization_id: ALPHA_ORG_ID, status: 'WON' } });
    expect(call.create).toMatchObject({ organization_id: ALPHA_ORG_ID, status: 'WON', label: 'Closed Won', sort_order: 3 });
    expect(call.update).toEqual({ label: 'Closed Won' });
  });

  it('label: null clears the override back to the enum default', async () => {
    mockAuthAs('admin');
    mockPrisma.leadStatusOverride.upsert.mockResolvedValue({
      status: 'WON', label: null, sort_order: 3, is_default: false, hidden: false,
    });

    const res = await request(app)
      .patch('/api/lead-status-overrides/WON')
      .set(authHeader('admin'))
      .send({ label: null });

    expect(res.status).toBe(200);
    expect(mockPrisma.leadStatusOverride.upsert.mock.calls[0][0].update).toEqual({ label: null });
  });

  it('never touches another org’s row (organization_id in both the upsert key and the create payload)', async () => {
    mockAuthAs('orgB_admin');
    mockPrisma.leadStatusOverride.upsert.mockResolvedValue({
      status: 'WON', label: 'Closed Won', sort_order: 3, is_default: false, hidden: false,
    });

    await request(app)
      .patch('/api/lead-status-overrides/WON')
      .set(authHeader('orgB_admin'))
      .send({ label: 'Closed Won' });

    const call = mockPrisma.leadStatusOverride.upsert.mock.calls[0][0];
    expect(call.where.organization_id_status.organization_id).toBe(ORG_B_ID);
    expect(call.create.organization_id).toBe(ORG_B_ID);
  });

  it('400s hiding the currently-effective default status', async () => {
    mockAuthAs('admin');
    // No rows yet -> NEW is the implicit default.
    mockPrisma.leadStatusOverride.findMany.mockResolvedValue([]);

    const res = await request(app)
      .patch('/api/lead-status-overrides/NEW')
      .set(authHeader('admin'))
      .send({ hidden: true });

    expect(res.status).toBe(400);
    expect(mockPrisma.leadStatusOverride.upsert).not.toHaveBeenCalled();
  });

  it('allows hiding a non-default status', async () => {
    mockAuthAs('admin');
    mockPrisma.leadStatusOverride.findMany.mockResolvedValue([]);
    mockPrisma.leadStatusOverride.upsert.mockResolvedValue({
      status: 'CANCELLED', label: null, sort_order: 5, is_default: false, hidden: true,
    });

    const res = await request(app)
      .patch('/api/lead-status-overrides/CANCELLED')
      .set(authHeader('admin'))
      .send({ hidden: true });

    expect(res.status).toBe(200);
  });
});

// ─── POST /api/lead-status-overrides/:status/default ────────────────────────

describe('POST /api/lead-status-overrides/:status/default', () => {
  it('clears is_default on every other org row, then upserts the target true, in one transaction', async () => {
    mockAuthAs('admin');
    mockPrisma.leadStatusOverride.upsert.mockResolvedValue({
      status: 'WON', label: null, sort_order: 3, is_default: true, hidden: false,
    });

    const res = await request(app).post('/api/lead-status-overrides/WON/default').set(authHeader('admin'));

    expect(res.status).toBe(200);
    expect(mockPrisma.leadStatusOverride.updateMany).toHaveBeenCalledWith({
      where: { organization_id: ALPHA_ORG_ID, NOT: { status: 'WON' } },
      data: { is_default: false },
    });
    const upsertCall = mockPrisma.leadStatusOverride.upsert.mock.calls[0][0];
    expect(upsertCall.where).toMatchObject({ organization_id_status: { organization_id: ALPHA_ORG_ID, status: 'WON' } });
    expect(upsertCall.update).toEqual({ is_default: true });
    expect(mockPrisma.$transaction).toHaveBeenCalled();
  });

  it('400s setting a hidden status as the default', async () => {
    mockAuthAs('admin');
    mockPrisma.leadStatusOverride.findMany.mockResolvedValue([
      { status: 'CANCELLED', label: null, sort_order: 5, is_default: false, hidden: true },
    ]);

    const res = await request(app).post('/api/lead-status-overrides/CANCELLED/default').set(authHeader('admin'));

    expect(res.status).toBe(400);
    expect(mockPrisma.leadStatusOverride.upsert).not.toHaveBeenCalled();
  });
});

// ─── POST /api/lead-status-overrides/reorder ────────────────────────────────

describe('POST /api/lead-status-overrides/reorder', () => {
  const ALL_SIX = ['NEW', 'CONTACTED', 'ESTIMATED', 'WON', 'LOST', 'CANCELLED'];

  it('400s when the ordered list is not exactly all 6 LeadStatus values (missing one)', async () => {
    mockAuthAs('admin');

    const res = await request(app)
      .post('/api/lead-status-overrides/reorder')
      .set(authHeader('admin'))
      .send({ ordered_statuses: ALL_SIX.slice(0, 5) });

    expect(res.status).toBe(400);
    expect(mockPrisma.$transaction).not.toHaveBeenCalled();
  });

  it('400s on a duplicate entry', async () => {
    mockAuthAs('admin');

    const res = await request(app)
      .post('/api/lead-status-overrides/reorder')
      .set(authHeader('admin'))
      .send({ ordered_statuses: ['NEW', 'NEW', 'ESTIMATED', 'WON', 'LOST', 'CANCELLED'] });

    expect(res.status).toBe(400);
  });

  it('writes sort_order by array index for all 6, each upsert scoped to the org', async () => {
    mockAuthAs('admin');
    const reordered = ['WON', 'NEW', 'CONTACTED', 'ESTIMATED', 'LOST', 'CANCELLED'];
    mockPrisma.leadStatusOverride.upsert.mockResolvedValue({});

    const res = await request(app)
      .post('/api/lead-status-overrides/reorder')
      .set(authHeader('admin'))
      .send({ ordered_statuses: reordered });

    expect(res.status).toBe(204);
    expect(mockPrisma.leadStatusOverride.upsert).toHaveBeenCalledTimes(6);
    const wonCall = mockPrisma.leadStatusOverride.upsert.mock.calls.find(
      (c) => c[0].where.organization_id_status.status === 'WON',
    )![0];
    expect(wonCall.where.organization_id_status.organization_id).toBe(ALPHA_ORG_ID);
    expect(wonCall.update).toEqual({ sort_order: 0 });
    expect(wonCall.create).toMatchObject({ organization_id: ALPHA_ORG_ID, status: 'WON', sort_order: 0 });
    expect(mockPrisma.$transaction).toHaveBeenCalled();
  });
});
