/**
 * job-assign-notifications.test.ts
 *
 * TDD for Task 3.1: emit() hook wired into the job assign / setAssignees endpoints.
 *
 * Strategy:
 *   - vi.mock('../services/notifications/notificationService') captures emit calls.
 *   - Three scenarios on assign():
 *       1. addedIds.length > 0          → dispatch.job_assigned  (entity.assignee_ids = addedIds)
 *       2. removedIds.length > 0, !add  → dispatch.job_unassigned (entity.assignee_ids = removedIds)
 *       3. timeChanged && addedIds == 0 → dispatch.job_rescheduled (entity.assignee_ids = kept crew)
 *   - One scenario on setAssignees():
 *       4. addedIds.length > 0          → dispatch.job_assigned
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import request from 'supertest';
import app from '../app';
import { prisma } from '../lib/prisma';
import {
  TEST_USERS,
  TEST_ORG,
  mockAuthAs,
  authHeader,
  CUSTOMER_FIXTURE,
  LOCATION_FIXTURE,
  JOB_FIXTURE,
  ALPHA_ORG_ID,
} from './helpers';
import { DEFAULT_GRANTS } from '../lib/permissions/defaultGrants';
import { clearPermissionCache } from '../lib/permissions/permissionCache';
import { clearTokenCache } from '../middleware/authenticate';

// ─── Spy on the notification emit function ───────────────────────────────────

vi.mock('../services/notifications/notificationService', () => ({
  emit: vi.fn().mockResolvedValue(undefined),
}));

// Import AFTER mock is registered so we get the spy reference.
import { emit } from '../services/notifications/notificationService';
const mockEmit = emit as ReturnType<typeof vi.fn>;

// ─── Prisma typed surface ────────────────────────────────────────────────────

const mockPrisma = prisma as any;

// ─── Test fixtures ───────────────────────────────────────────────────────────

const TECH_USER = {
  ...TEST_USERS.technician,
  email: 'tech@test.com',
  first_name: 'Test',
  last_name: 'Tech',
};

const TECH2_ID = '00000000-0000-0000-0000-000000000099';
const TECH2_USER = {
  id: TECH2_ID,
  email: 'tech2@test.com',
  first_name: 'Tech',
  last_name: 'Two',
  role: 'TECHNICIAN' as const,
  is_active: true,
  organization_id: ALPHA_ORG_ID,
};

// A SCHEDULED job fixture for reschedule/removal tests.
const SCHEDULED_JOB_FIXTURE = {
  ...JOB_FIXTURE,
  status: 'SCHEDULED' as const,
  scheduled_start: new Date('2026-06-01T09:00:00Z'),
  scheduled_end: new Date('2026-06-01T11:00:00Z'),
  assignees: [{ user_id: TECH_USER.id }],
  customer_scheduled_email_sent_at: new Date('2026-06-01T00:00:00Z'),
};

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Wire the $transaction mock used by assign().
 * Returns tx spy handles so individual tests can assert on them.
 */
function wireAssignTx(updatedJob: any, currentCrew: { user_id: string }[] = []) {
  // Conflict queries default to "no conflict".
  mockPrisma.job.findMany.mockResolvedValue([]);
  mockPrisma.lead.findMany.mockResolvedValue([]);

  const txJobAssigneeFindMany = vi.fn().mockResolvedValue(currentCrew);
  const txJobAssigneeCreateMany = vi.fn().mockResolvedValue({ count: 0 });
  const txJobAssigneeDeleteMany = vi.fn().mockResolvedValue({ count: 0 });
  const txJobUpdate = vi.fn().mockResolvedValue(updatedJob);
  const txTimeline = vi.fn().mockResolvedValue({});
  const txPlanVisitUpdateMany = vi.fn().mockResolvedValue({ count: 1 });

  mockPrisma.$transaction.mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) =>
    fn({
      jobAssignee: {
        findMany: txJobAssigneeFindMany,
        createMany: txJobAssigneeCreateMany,
        deleteMany: txJobAssigneeDeleteMany,
      },
      job: { update: txJobUpdate },
      timelineEvent: { create: txTimeline },
      planVisit: { updateMany: txPlanVisitUpdateMany },
    }),
  );

  return { txJobAssigneeFindMany, txJobAssigneeCreateMany, txJobAssigneeDeleteMany, txJobUpdate, txTimeline };
}

/**
 * Wire the $transaction mock used by setAssignees().
 * setAssignees() reads back the job at the end via tx.job.findUnique.
 */
function wireSetAssigneesTx(updatedJob: any, currentCrew: { user_id: string }[] = []) {
  const txJobAssigneeFindMany = vi.fn().mockResolvedValue(currentCrew);
  const txJobAssigneeCreateMany = vi.fn().mockResolvedValue({ count: 0 });
  const txJobAssigneeDeleteMany = vi.fn().mockResolvedValue({ count: 0 });
  const txJobFindUnique = vi.fn().mockResolvedValue(updatedJob);
  const txTimeline = vi.fn().mockResolvedValue({});

  mockPrisma.$transaction.mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) =>
    fn({
      jobAssignee: {
        findMany: txJobAssigneeFindMany,
        createMany: txJobAssigneeCreateMany,
        deleteMany: txJobAssigneeDeleteMany,
      },
      job: { findUnique: txJobFindUnique },
      timelineEvent: { create: txTimeline },
    }),
  );

  return { txJobAssigneeFindMany, txJobAssigneeCreateMany, txJobAssigneeDeleteMany, txJobFindUnique, txTimeline };
}

// ─── Lifecycle ───────────────────────────────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks();
  clearPermissionCache();

  // Deposit-gate default: no deposit invoice present.
  mockPrisma.invoice.findFirst.mockResolvedValue(null);

  // loadGrantsFor() used by the canDo middleware.
  mockPrisma.rolePermission.findMany.mockImplementation(
    (args: { where: { organization_id: string; role: string } }) =>
      Promise.resolve(DEFAULT_GRANTS.filter((g) => g.role === args.where.role)),
  );

  // mockAuthAs already sets up findUnique + userPermissionOverride defaults.
});

// ── Regression guard for #271 ────────────────────────────────────────────────
// Notification emits MUST fire post-commit, never inside a $transaction. Passing a
// tx client to emit() silently drops the notification in prod (filterByAccess reads
// on the global prisma connection while the caller's txn holds the row). Fail loudly
// if any emit in any test carries a tx.
afterEach(() => {
  for (const call of mockEmit.mock.calls) {
    expect(
      (call[0] as { tx?: unknown }).tx,
      `emit('${(call[0] as { verb?: string }).verb}') must be called post-commit, without a tx client (#271)`,
    ).toBeUndefined();
  }
});

// ─── POST /api/jobs/:id/assign → dispatch.job_assigned ──────────────────────

describe('POST /api/jobs/:id/assign — notification hooks', () => {
  it('emits dispatch.job_assigned with the added tech id when crew member is added', async () => {
    mockAuthAs('admin');
    mockPrisma.job.findUnique.mockResolvedValue(JOB_FIXTURE); // UNASSIGNED, no current assignees

    // mockAuthAs wires user.findUnique for TEST_USERS by id.
    // TECH_USER.id === TEST_USERS.technician.id → already handled.
    wireAssignTx({ ...JOB_FIXTURE, status: 'SCHEDULED' });

    const res = await request(app)
      .post(`/api/jobs/${JOB_FIXTURE.id}/assign`)
      .set(authHeader('admin'))
      .send({
        assignee_ids: [TECH_USER.id],
        scheduled_start: '2026-08-01T09:00:00Z',
        scheduled_end: '2026-08-01T11:00:00Z',
      });

    expect(res.status).toBe(200);

    // emit should have been called at least once with job_assigned.
    const assignedCall = mockEmit.mock.calls.find(
      (c: any[]) => c[0].verb === 'dispatch.job_assigned',
    );
    expect(assignedCall).toBeDefined();
    const assignedArgs = assignedCall![0];
    expect(assignedArgs.entity.assignee_ids).toContain(TECH_USER.id);
    expect(assignedArgs.object.type).toBe('JOB');
    expect(assignedArgs.object.id).toBe(JOB_FIXTURE.id);
    expect(assignedArgs.object.label).toBe(JOB_FIXTURE.job_number);
    expect(assignedArgs.organizationId).toBe(ALPHA_ORG_ID);
    expect(assignedArgs.actorId).toBe(TEST_USERS.admin.id);
  });

  it('emits dispatch.job_unassigned with the removed tech id when a crew member is removed', async () => {
    // Existing crew = [TECH_USER, TECH2_USER]; new crew = [TECH_USER] → TECH2 is removed.
    mockAuthAs('admin');
    const fixture = {
      ...SCHEDULED_JOB_FIXTURE,
      assignees: [{ user_id: TECH_USER.id }, { user_id: TECH2_ID }],
    };
    mockPrisma.job.findUnique.mockResolvedValue(fixture);

    // user.findUnique must resolve TECH2 too.
    mockPrisma.user.findUnique.mockImplementation((args: { where: { id: string } }) => {
      if (args.where.id === TECH2_ID) return Promise.resolve({ ...TECH2_USER, organization: TEST_ORG });
      const match = Object.values(TEST_USERS).find((u) => u.id === args.where.id);
      return Promise.resolve(match ? { ...match, organization: TEST_ORG } : null);
    });

    wireAssignTx({ ...fixture, assignees: [{ user_id: TECH_USER.id }] });

    const res = await request(app)
      .post(`/api/jobs/${JOB_FIXTURE.id}/assign`)
      .set(authHeader('admin'))
      .send({
        // Keep TECH_USER, drop TECH2.
        assignee_ids: [TECH_USER.id],
        scheduled_start: '2026-06-01T09:00:00Z', // same time → timeChanged=false
        scheduled_end: '2026-06-01T11:00:00Z',
      });

    expect(res.status).toBe(200);

    const unassignedCall = mockEmit.mock.calls.find(
      (c: any[]) => c[0].verb === 'dispatch.job_unassigned',
    );
    expect(unassignedCall).toBeDefined();
    const unassignedArgs = unassignedCall![0];
    expect(unassignedArgs.entity.assignee_ids).toContain(TECH2_ID);
    expect(unassignedArgs.object.id).toBe(JOB_FIXTURE.id);
  });

  it('emits dispatch.job_rescheduled to current (kept) assignees when only the time changes', async () => {
    // Existing crew = [TECH_USER]; new crew = [TECH_USER] (no add/remove); time changes.
    mockAuthAs('admin');
    mockPrisma.job.findUnique.mockResolvedValue(SCHEDULED_JOB_FIXTURE);
    wireAssignTx({ ...SCHEDULED_JOB_FIXTURE, scheduled_start: new Date('2026-09-01T09:00:00Z') });

    const res = await request(app)
      .post(`/api/jobs/${JOB_FIXTURE.id}/assign`)
      .set(authHeader('admin'))
      .send({
        assignee_ids: [TECH_USER.id],
        scheduled_start: '2026-09-01T09:00:00Z', // new time → timeChanged=true
        scheduled_end: '2026-09-01T11:00:00Z',
      });

    expect(res.status).toBe(200);

    const rescheduledCall = mockEmit.mock.calls.find(
      (c: any[]) => c[0].verb === 'dispatch.job_rescheduled',
    );
    expect(rescheduledCall).toBeDefined();
    const rescheduledArgs = rescheduledCall![0];
    // addedIds is empty → recipients are the kept (current) crew.
    expect(rescheduledArgs.entity.assignee_ids).toContain(TECH_USER.id);
    expect(rescheduledArgs.object.id).toBe(JOB_FIXTURE.id);
    expect(rescheduledArgs.data).toHaveProperty('scheduled_start');
    expect(rescheduledArgs.actorId).toBe(TEST_USERS.admin.id);
  });

  it('does NOT emit dispatch.job_rescheduled when techs are added (assign, not reschedule)', async () => {
    // Adding a tech to a SCHEDULED job → job_assigned, but NOT job_rescheduled.
    mockAuthAs('admin');
    mockPrisma.job.findUnique.mockResolvedValue(SCHEDULED_JOB_FIXTURE); // already has TECH_USER
    mockPrisma.user.findUnique.mockImplementation((args: { where: { id: string } }) => {
      if (args.where.id === TECH2_ID) return Promise.resolve({ ...TECH2_USER, organization: TEST_ORG });
      const match = Object.values(TEST_USERS).find((u) => u.id === args.where.id);
      return Promise.resolve(match ? { ...match, organization: TEST_ORG } : null);
    });
    wireAssignTx({ ...SCHEDULED_JOB_FIXTURE, assignees: [{ user_id: TECH_USER.id }, { user_id: TECH2_ID }] });

    const res = await request(app)
      .post(`/api/jobs/${JOB_FIXTURE.id}/assign`)
      .set(authHeader('admin'))
      .send({
        assignee_ids: [TECH_USER.id, TECH2_ID],
        scheduled_start: '2026-06-01T09:00:00Z', // same time
        scheduled_end: '2026-06-01T11:00:00Z',
      });

    expect(res.status).toBe(200);
    const rescheduledCall = mockEmit.mock.calls.find(
      (c: any[]) => c[0].verb === 'dispatch.job_rescheduled',
    );
    expect(rescheduledCall).toBeUndefined();
  });
});

// ─── POST /api/jobs/:id/assignees → dispatch.job_assigned ───────────────────

describe('POST /api/jobs/:id/assignees (setAssignees) — notification hook', () => {
  it('emits dispatch.job_assigned when a crew member is added via the crew-only endpoint', async () => {
    mockAuthAs('admin');
    mockPrisma.job.findUnique.mockResolvedValue(JOB_FIXTURE); // no current assignees
    wireSetAssigneesTx({ ...JOB_FIXTURE, assignees: [{ user_id: TECH_USER.id }] });

    const res = await request(app)
      .post(`/api/jobs/${JOB_FIXTURE.id}/assignees`)
      .set(authHeader('admin'))
      .send({ assignee_ids: [TECH_USER.id] });

    expect(res.status).toBe(200);

    const assignedCall = mockEmit.mock.calls.find(
      (c: any[]) => c[0].verb === 'dispatch.job_assigned',
    );
    expect(assignedCall).toBeDefined();
    const assignedArgs = assignedCall![0];
    expect(assignedArgs.entity.assignee_ids).toContain(TECH_USER.id);
    expect(assignedArgs.object.id).toBe(JOB_FIXTURE.id);
    expect(assignedArgs.object.label).toBe(JOB_FIXTURE.job_number);
  });

  it('emits dispatch.job_unassigned when a crew member is removed via the crew-only endpoint', async () => {
    mockAuthAs('admin');
    const fixture = {
      ...JOB_FIXTURE,
      status: 'SCHEDULED',
      assignees: [{ user_id: TECH_USER.id }],
      customer: JOB_FIXTURE.customer,
      service_location: JOB_FIXTURE.service_location,
      scope_notes: null,
      scheduled_start: new Date('2026-06-01T09:00:00Z'),
    };
    mockPrisma.job.findUnique.mockResolvedValue(fixture);
    wireSetAssigneesTx({ ...fixture, assignees: [] });

    const res = await request(app)
      .post(`/api/jobs/${JOB_FIXTURE.id}/assignees`)
      .set(authHeader('admin'))
      .send({ assignee_ids: [] }); // remove all

    expect(res.status).toBe(200);

    const unassignedCall = mockEmit.mock.calls.find(
      (c: any[]) => c[0].verb === 'dispatch.job_unassigned',
    );
    expect(unassignedCall).toBeDefined();
    const unassignedArgs = unassignedCall![0];
    expect(unassignedArgs.entity.assignee_ids).toContain(TECH_USER.id);
  });
});
