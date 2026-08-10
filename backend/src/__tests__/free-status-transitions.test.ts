import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';
import { JobStatus } from '@prisma/client';
import app from '../app';
import { prisma } from '../lib/prisma';
import { mockAuthAs, authHeader, JOB_FIXTURE } from './helpers';
import { clearPermissionCache } from '../lib/permissions/permissionCache';

const mockPrisma = prisma as unknown as {
  job: {
    findUnique: ReturnType<typeof vi.fn>;
    findMany: ReturnType<typeof vi.fn>;
    update: ReturnType<typeof vi.fn>;
    delete: ReturnType<typeof vi.fn>;
  };
  timelineEvent: { create: ReturnType<typeof vi.fn> };
  planVisit: { updateMany: ReturnType<typeof vi.fn> };
  jobAssignee: { createMany: ReturnType<typeof vi.fn>; deleteMany: ReturnType<typeof vi.fn> };
  $transaction: ReturnType<typeof vi.fn>;
};

const ALL_STATUSES = Object.values(JobStatus);

// Every status ACTION and the payload it needs. Ordering is no longer a precondition for any
// of them, so each must accept a job in every one of the seven statuses.
// B-11: the originally-shown matrix omitted assign (the Scheduled node's only endpoint) and
// reopen (two guards removed) — both added below alongside the POST actions.
const ACTIONS: { path: string; body?: object }[] = [
  { path: 'assign', body: { assignee_ids: [] } },
  { path: 'arrive' },
  { path: 'start' },
  { path: 'complete', body: { completion_notes: 'done' } },
  { path: 'cancel', body: { cancelled_reason: 'customer cancelled' } },
  { path: 'en-route' },
  { path: 'unassign' },
  { path: 'reopen' },
];

beforeEach(() => {
  vi.clearAllMocks();
  clearPermissionCache();
  mockPrisma.$transaction.mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) => fn(mockPrisma));
  mockPrisma.job.update.mockResolvedValue({ ...JOB_FIXTURE });
  // cancel/delete's Inventory P1 stock-sync return-check reads this unconditionally.
  (mockPrisma as unknown as { jobLineItem: { findMany: ReturnType<typeof vi.fn> } }).jobLineItem.findMany.mockResolvedValue([]);
  // SRVW-87 - the SCHEDULED rows of the /status matrix route into assign()'s conflict check.
  // Defensive: the matrix fixture has an empty crew, so detectCrewConflicts early-returns before
  // reaching findMany - but setup.ts leaves job.findMany with no default, so this stops a future
  // crewed fixture from silently 500ing (which `!== 400` would happily pass).
  mockPrisma.job.findMany.mockResolvedValue([]);
});

describe('free status transitions — every action accepts every status', () => {
  for (const action of ACTIONS) {
    for (const status of ALL_STATUSES) {
      it(`POST /${action.path} accepts a ${status} job`, async () => {
        mockAuthAs('admin');
        mockPrisma.job.findUnique.mockResolvedValue({
          ...JOB_FIXTURE, status, assignees: [], invoices: [], source_plan_id: null,
        });

        const res = await request(app)
          .post(`/api/jobs/${JOB_FIXTURE.id}/${action.path}`)
          .set(authHeader('admin'))
          .send(action.body ?? {});

        // The point of the test: never a 400. A 4xx here means an ordering guard came back.
        expect(res.status).not.toBe(400);
      });
    }
  }

  // B-11: PATCH update and DELETE use a different HTTP method and hit /:id directly, so they
  // don't fit the POST /:id/:action shape above — same "never 400 by status" assertion.
  for (const status of ALL_STATUSES) {
    it(`PATCH / accepts a ${status} job`, async () => {
      mockAuthAs('admin');
      mockPrisma.job.findUnique.mockResolvedValue({
        ...JOB_FIXTURE, status, assignees: [], invoices: [], source_plan_id: null,
      });

      const res = await request(app)
        .patch(`/api/jobs/${JOB_FIXTURE.id}`)
        .set(authHeader('admin'))
        .send({});

      expect(res.status).not.toBe(400);
    });

    it(`DELETE / accepts a ${status} job with no invoices`, async () => {
      mockAuthAs('admin');
      mockPrisma.job.findUnique.mockResolvedValue({
        ...JOB_FIXTURE, status, assignees: [], invoices: [], source_plan_id: null,
      });
      mockPrisma.job.delete.mockResolvedValue({ ...JOB_FIXTURE, status });

      const res = await request(app)
        .delete(`/api/jobs/${JOB_FIXTURE.id}`)
        .set(authHeader('admin'));

      expect(res.status).not.toBe(400);
    });
  }

  // SRVW-87 - the single set-status door adds no ordering guard either: every TARGET status is
  // reachable from every SOURCE status. Note what this matrix canNOT tell you - it only asserts
  // `!== 400`, so an un-completion would pass silently. The two cases that matter (a bare
  // status=SCHEDULED on a COMPLETED job 400s; an explicit window rewinds milestones) are pinned
  // by their own assertions in jobs.test.ts, deliberately not here.
  for (const target of ALL_STATUSES) {
    for (const source of ALL_STATUSES) {
      it(`POST /status accepts target ${target} from a ${source} job`, async () => {
        mockAuthAs('admin');
        mockPrisma.job.findUnique.mockResolvedValue({
          ...JOB_FIXTURE, status: source, assignees: [], invoices: [], source_plan_id: null,
        });

        const res = await request(app)
          .post(`/api/jobs/${JOB_FIXTURE.id}/status`)
          .set(authHeader('admin'))
          .send({
            status: target,
            // The explicit window satisfies the SCHEDULED branch's requirement; the verb schemas
            // that do not declare these fields strip them.
            scheduled_start: '2026-09-01T09:00:00.000Z',
            scheduled_end: '2026-09-01T11:00:00.000Z',
            completion_notes: 'done',
            cancelled_reason: 'test',
          });

        expect(res.status).not.toBe(400);
      });
    }
  }
});

describe('integrity guards survive — these are NOT ordering constraints', () => {
  it('still refuses to delete a job that has a non-voided invoice', async () => {
    mockAuthAs('admin');
    mockPrisma.job.findUnique.mockResolvedValue({
      ...JOB_FIXTURE, status: 'UNASSIGNED', invoices: [{ status: 'SENT' }],
    });

    const res = await request(app)
      .delete(`/api/jobs/${JOB_FIXTURE.id}`)
      .set(authHeader('admin'));

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/invoice/i);
  });

  it('still refuses to invoice a service-plan visit job', async () => {
    mockAuthAs('admin');
    mockPrisma.job.findUnique.mockResolvedValue({
      ...JOB_FIXTURE, status: 'COMPLETED', source_plan_id: 'plan-1', invoices: [],
    });

    const res = await request(app)
      .post(`/api/jobs/${JOB_FIXTURE.id}/invoices`)
      .set(authHeader('admin'))
      .send({ amount: 100 });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/service plan/i);
  });
});
