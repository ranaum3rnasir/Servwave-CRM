import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';
import app from '../app';
import { prisma } from '../lib/prisma';
import { mockAuthAs, authHeader, JOB_FIXTURE } from './helpers';
import { clearPermissionCache } from '../lib/permissions/permissionCache';

const mockPrisma = prisma as unknown as {
  job: { findUnique: ReturnType<typeof vi.fn>; update: ReturnType<typeof vi.fn> };
  timelineEvent: { create: ReturnType<typeof vi.fn> };
  planVisit: { updateMany: ReturnType<typeof vi.fn> };
  $transaction: ReturnType<typeof vi.fn>;
};

beforeEach(() => {
  vi.clearAllMocks();
  clearPermissionCache();
  mockPrisma.$transaction.mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) => fn(mockPrisma));
  mockPrisma.job.update.mockResolvedValue({ ...JOB_FIXTURE });
});

const completedJob = {
  ...JOB_FIXTURE,
  status: 'COMPLETED',
  completed_at: new Date('2026-03-05'),
  started_at: new Date('2026-03-05'),
  on_site_at: new Date('2026-03-05'),
  scheduled_start: new Date('2026-03-05'),
  assignees: [],
  invoices: [],
  source_plan_id: null,
};

describe('backward moves clear later timestamps', () => {
  it('On Site on a completed job clears started_at and completed_at', async () => {
    mockAuthAs('admin');
    mockPrisma.job.findUnique.mockResolvedValue(completedJob);

    const res = await request(app)
      .post(`/api/jobs/${JOB_FIXTURE.id}/arrive`)
      .set(authHeader('admin'));

    expect(res.status).toBe(200);
    const data = mockPrisma.job.update.mock.calls[0]![0].data;
    expect(data.status).toBe('ON_SITE');
    expect(data.on_site_at).toBeInstanceOf(Date);
    expect(data.started_at).toBeNull();
    expect(data.completed_at).toBeNull();
  });

  it('Start on a completed job clears completed_at but not on_site_at', async () => {
    mockAuthAs('admin');
    mockPrisma.job.findUnique.mockResolvedValue(completedJob);

    await request(app).post(`/api/jobs/${JOB_FIXTURE.id}/start`).set(authHeader('admin'));

    const data = mockPrisma.job.update.mock.calls[0]![0].data;
    expect(data.completed_at).toBeNull();
    expect(data).not.toHaveProperty('on_site_at');
  });

  it('NEVER clears scheduled_start on any backward move', async () => {
    mockAuthAs('admin');
    mockPrisma.job.findUnique.mockResolvedValue(completedJob);

    await request(app).post(`/api/jobs/${JOB_FIXTURE.id}/arrive`).set(authHeader('admin'));

    const data = mockPrisma.job.update.mock.calls[0]![0].data;
    expect(data).not.toHaveProperty('scheduled_start');
    expect(data).not.toHaveProperty('scheduled_end');
  });

  it('un-cancels a cancelled job moved to any milestone', async () => {
    mockAuthAs('admin');
    mockPrisma.job.findUnique.mockResolvedValue({
      ...completedJob, status: 'CANCELLED', cancelled_at: new Date(), cancelled_reason: 'Customer away',
    });

    await request(app).post(`/api/jobs/${JOB_FIXTURE.id}/arrive`).set(authHeader('admin'));

    const data = mockPrisma.job.update.mock.calls[0]![0].data;
    expect(data.cancelled_at).toBeNull();
    expect(data.cancelled_reason).toBeNull();
  });

  it('reverts the linked PlanVisit when completion is cleared', async () => {
    mockAuthAs('admin');
    mockPrisma.job.findUnique.mockResolvedValue({ ...completedJob, source_plan_id: 'plan-1' });

    await request(app).post(`/api/jobs/${JOB_FIXTURE.id}/arrive`).set(authHeader('admin'));

    // complete() cascades the visit to COMPLETED; without this the visit stays consumed and
    // servicePlans/derive.ts keeps visits_remaining decremented forever.
    expect(mockPrisma.planVisit.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: { status: 'SCHEDULED', completed_at: null } }),
    );
  });

  it('does not touch PlanVisit for a job with no source plan', async () => {
    mockAuthAs('admin');
    mockPrisma.job.findUnique.mockResolvedValue(completedJob);

    await request(app).post(`/api/jobs/${JOB_FIXTURE.id}/arrive`).set(authHeader('admin'));

    expect(mockPrisma.planVisit.updateMany).not.toHaveBeenCalled();
  });

  it('writes a timeline event BEFORE clearing, so the audit trail has no holes', async () => {
    mockAuthAs('admin');
    mockPrisma.job.findUnique.mockResolvedValue(completedJob);

    await request(app).post(`/api/jobs/${JOB_FIXTURE.id}/arrive`).set(authHeader('admin'));

    expect(mockPrisma.timelineEvent.create).toHaveBeenCalled();
    const timelineCallOrder = mockPrisma.timelineEvent.create.mock.invocationCallOrder[0];
    const updateCallOrder = mockPrisma.job.update.mock.invocationCallOrder[0];
    expect(timelineCallOrder).toBeLessThan(updateCallOrder);
  });

  it('preserves the signature and completion notes when re-completing with an empty body', async () => {
    mockAuthAs('admin');
    mockPrisma.job.findUnique.mockResolvedValue({
      ...completedJob, signature_data: 'data:image/png;base64,AAA', completion_notes: 'Replaced compressor',
    });

    await request(app).post(`/api/jobs/${JOB_FIXTURE.id}/complete`).set(authHeader('admin')).send({});

    const data = mockPrisma.job.update.mock.calls[0]![0].data;
    expect(data.signature_data).toBeUndefined();   // undefined = leave the stored value alone
    expect(data.completion_notes).toBeUndefined();
  });
});
