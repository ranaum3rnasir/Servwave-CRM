import { describe, it, expect, beforeEach, vi } from 'vitest';
import { prisma } from '../../../lib/prisma';
import { runAutomationTick } from '../cron';

vi.mock('../enrollment', () => ({
  createEnrollment: vi.fn().mockResolvedValue({ id: 'enr-x' }),
  advanceEnrollment: vi.fn().mockResolvedValue(undefined),
}));
import { createEnrollment, advanceEnrollment } from '../enrollment';

const mockPrisma = prisma as any;
const mockCreateEnrollment = createEnrollment as ReturnType<typeof vi.fn>;
const mockAdvanceEnrollment = advanceEnrollment as ReturnType<typeof vi.fn>;

const ORG = '00000000-0000-0000-0000-000000000001';
const NOW = new Date('2026-07-14T15:00:00.000Z');
const HOUR = 60 * 60 * 1000;
const MINUTE = 60 * 1000;

function timedWorkflow(trigger: string, offsetMinutes: number, overrides: Record<string, unknown> = {}) {
  return {
    id: `wf-${trigger}`,
    name: trigger,
    status: 'PUBLISHED',
    is_enabled: true,
    trigger_type: trigger,
    trigger_config: { offset_minutes: offsetMinutes },
    published_version_id: 'ver-1',
    organization_id: ORG,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockPrisma.workflow = {
    findMany: vi.fn().mockResolvedValue([]),
  };
  mockPrisma.workflowEnrollment = {
    findMany: vi.fn().mockResolvedValue([]),
    findUnique: vi.fn().mockResolvedValue(null),
    updateMany: vi.fn().mockResolvedValue({ count: 1 }),
  };
  mockPrisma.workflowStepRun = {
    findMany: vi.fn().mockResolvedValue([]),
    findUnique: vi.fn().mockResolvedValue(null),
  };
  mockPrisma.job.findMany.mockResolvedValue([]);
  mockPrisma.invoice.findMany.mockResolvedValue([]);
  mockPrisma.estimate.findMany.mockResolvedValue([]);
  mockCreateEnrollment.mockResolvedValue({ id: 'enr-x' });
  mockAdvanceEnrollment.mockResolvedValue(undefined);
});

describe('runAutomationTick — scanTimeTriggers', () => {
  it('does nothing when no timed workflows are enabled', async () => {
    await runAutomationTick(NOW);
    expect(mockPrisma.job.findMany).not.toHaveBeenCalled();
    expect(mockPrisma.invoice.findMany).not.toHaveBeenCalled();
    expect(mockCreateEnrollment).not.toHaveBeenCalled();
  });

  it('scan where-clause requires PUBLISHED + enabled + a published version + a timed trigger', async () => {
    await runAutomationTick(NOW);
    const q = mockPrisma.workflow.findMany.mock.calls[0][0];
    expect(q.where).toEqual({
      is_enabled: true,
      status: 'PUBLISHED',
      published_version_id: { not: null },
      trigger_type: { in: ['BEFORE_JOB_START', 'AFTER_JOB_COMPLETED', 'INVOICE_OVERDUE', 'ESTIMATE_FOLLOW_UP'] },
    });
  });

  it('BEFORE_JOB_START: scans scheduled jobs inside [now, now+offset], org-scoped, and enrolls each candidate', async () => {
    const start = new Date(NOW.getTime() + 2 * HOUR);
    mockPrisma.workflow.findMany.mockResolvedValueOnce([timedWorkflow('BEFORE_JOB_START', 24 * 60)]);
    mockPrisma.job.findMany.mockResolvedValueOnce([
      { id: 'job-1', job_number: 'J00042', scheduled_start: start },
    ]);

    await runAutomationTick(NOW);

    const q = mockPrisma.job.findMany.mock.calls[0][0];
    expect(q.where.organization_id).toBe(ORG);
    // Spec B1 (B-6): widened past SCHEDULED alone so en-route/on-site jobs still enrol --
    // terminalStaleReason's ON_SITE/IN_PROGRESS check is what stops the reminder once work has
    // actually started.
    expect(q.where.status).toEqual({ in: ['SCHEDULED', 'EN_ROUTE', 'ON_SITE', 'IN_PROGRESS'] });
    expect(q.where.scheduled_start.gte.getTime()).toBe(NOW.getTime());
    expect(q.where.scheduled_start.lte.getTime()).toBe(NOW.getTime() + 24 * HOUR);

    expect(mockCreateEnrollment).toHaveBeenCalledTimes(1);
    const arg = mockCreateEnrollment.mock.calls[0][0];
    expect(arg.workflow).toEqual({
      id: 'wf-BEFORE_JOB_START',
      published_version_id: 'ver-1',
      trigger_type: 'BEFORE_JOB_START',
      organization_id: ORG,
    });
    expect(arg.entity).toEqual({ type: 'job', id: 'job-1', label: 'J00042' });
    expect(arg.occurrenceKey).toBe(start.toISOString());
    expect(arg.now).toBe(NOW);
  });

  it('BEFORE_JOB_START: createEnrollment resolving null (dedupe collision) does not throw or stop the loop for other candidates', async () => {
    mockPrisma.workflow.findMany.mockResolvedValueOnce([timedWorkflow('BEFORE_JOB_START', 24 * 60)]);
    mockPrisma.job.findMany.mockResolvedValueOnce([
      { id: 'job-1', job_number: 'J1', scheduled_start: new Date(NOW.getTime() + HOUR) },
      { id: 'job-2', job_number: 'J2', scheduled_start: new Date(NOW.getTime() + 2 * HOUR) },
    ]);
    mockCreateEnrollment.mockResolvedValueOnce(null).mockResolvedValueOnce({ id: 'enr-2' });

    await expect(runAutomationTick(NOW)).resolves.toBeUndefined();
    expect(mockCreateEnrollment).toHaveBeenCalledTimes(2);
  });

  it('AFTER_JOB_COMPLETED: bounded lookback window (grace 48h) — never retroactive; occurrence = completed_at ISO', async () => {
    const completedAt = new Date(NOW.getTime() - 10 * HOUR);
    mockPrisma.workflow.findMany.mockResolvedValueOnce([timedWorkflow('AFTER_JOB_COMPLETED', 24 * 60)]);
    mockPrisma.job.findMany.mockResolvedValueOnce([
      { id: 'job-1', job_number: 'J00042', completed_at: completedAt },
    ]);
    await runAutomationTick(NOW);
    const q = mockPrisma.job.findMany.mock.calls[0][0];
    expect(q.where.status).toBe('COMPLETED');
    // completed_at ∈ [now − offset − 48h, now − offset]
    expect(q.where.completed_at.lte.getTime()).toBe(NOW.getTime() - 24 * HOUR);
    expect(q.where.completed_at.gte.getTime()).toBe(NOW.getTime() - 24 * HOUR - 48 * HOUR);
    const arg = mockCreateEnrollment.mock.calls[0][0];
    expect(arg.occurrenceKey).toBe(completedAt.toISOString());
  });

  it('INVOICE_OVERDUE: scans unpaid invoices with due_date past offset (7d grace), amount_due > 0', async () => {
    mockPrisma.workflow.findMany.mockResolvedValueOnce([timedWorkflow('INVOICE_OVERDUE', 3 * 24 * 60)]);
    mockPrisma.invoice.findMany.mockResolvedValueOnce([
      { id: 'inv-1', invoice_number: 'I00073', due_date: new Date(NOW.getTime() - 4 * 24 * HOUR) },
    ]);
    await runAutomationTick(NOW);
    const q = mockPrisma.invoice.findMany.mock.calls[0][0];
    expect(q.where.status).toEqual({ in: ['SENT', 'PARTIAL'] });
    expect(q.where.amount_due).toEqual({ gt: 0 }); // never dun a zero-balance invoice
    expect(q.where.due_date.lte.getTime()).toBe(NOW.getTime() - 3 * 24 * HOUR);
    expect(q.where.due_date.gte.getTime()).toBe(NOW.getTime() - 3 * 24 * HOUR - 7 * 24 * HOUR);
    const arg = mockCreateEnrollment.mock.calls[0][0];
    expect(arg.entity).toEqual({ type: 'invoice', id: 'inv-1', label: 'I00073' });
    expect(arg.occurrenceKey).toBeUndefined();
  });

  it('ESTIMATE_FOLLOW_UP: scans still-unanswered estimates by sent_at (7d grace)', async () => {
    mockPrisma.workflow.findMany.mockResolvedValueOnce([timedWorkflow('ESTIMATE_FOLLOW_UP', 3 * 24 * 60)]);
    mockPrisma.estimate.findMany.mockResolvedValueOnce([
      { id: 'est-1', estimate_number: 'E00108', sent_at: new Date(NOW.getTime() - 4 * 24 * HOUR) },
    ]);
    await runAutomationTick(NOW);
    const q = mockPrisma.estimate.findMany.mock.calls[0][0];
    // SENT only — PENDING means the customer already answered (approved + signed, D6), so
    // chasing it for a decision would tell someone who said yes that we never heard back.
    expect(q.where.status).toBe('SENT');
    expect(q.where.sent_at.lte.getTime()).toBe(NOW.getTime() - 3 * 24 * HOUR);
    expect(q.where.sent_at.gte.getTime()).toBe(NOW.getTime() - 3 * 24 * HOUR - 7 * 24 * HOUR);
    const arg = mockCreateEnrollment.mock.calls[0][0];
    expect(arg.entity).toEqual({ type: 'estimate', id: 'est-1', label: 'E00108' });
  });

  it('a timed workflow with a missing/invalid offset_minutes is skipped with logger.warn, no candidate query', async () => {
    mockPrisma.workflow.findMany.mockResolvedValueOnce([
      timedWorkflow('BEFORE_JOB_START', 0, { trigger_config: null }),
    ]);
    await runAutomationTick(NOW);
    expect(mockPrisma.job.findMany).not.toHaveBeenCalled();
    expect(mockCreateEnrollment).not.toHaveBeenCalled();
  });
});

describe('runAutomationTick — scanDateAnchorTriggers', () => {
  function dateAnchoredWorkflow(
    trigger: string,
    anchor: string,
    direction: 'before' | 'after',
    offsetMinutes: number,
    overrides: Record<string, unknown> = {},
  ) {
    return {
      id: `wf-${trigger}`,
      name: trigger,
      status: 'PUBLISHED',
      is_enabled: true,
      trigger_type: trigger,
      trigger_config: { anchor, direction, offset_minutes: offsetMinutes },
      published_version_id: 'ver-1',
      organization_id: ORG,
      legacy_rule_id: null,
      ...overrides,
    };
  }

  it('scan where-clause requires PUBLISHED + enabled + a published version + a date-anchored trigger', async () => {
    await runAutomationTick(NOW);
    // scanDateAnchorTriggers issues the SECOND workflow.findMany call of a tick
    // (scanTimeTriggers issues the first — see the "immediately after
    // scanTimeTriggers" ordering in runAutomationTick).
    const q = mockPrisma.workflow.findMany.mock.calls[1][0];
    expect(q.where).toEqual({
      is_enabled: true,
      status: 'PUBLISHED',
      published_version_id: { not: null },
      trigger_type: {
        in: ['JOB_DATE_ANCHORED', 'LEAD_DATE_ANCHORED', 'INVOICE_DATE_ANCHORED', 'ESTIMATE_DATE_ANCHORED'],
      },
    });
  });

  it('enrolls an invoice whose due date is one day out for a "1 day before" workflow', async () => {
    const due = new Date(NOW.getTime() + 21 * HOUR); // inside [now, now+24h]
    mockPrisma.workflow.findMany
      .mockResolvedValueOnce([]) // scanTimeTriggers: nothing timed
      .mockResolvedValueOnce([dateAnchoredWorkflow('INVOICE_DATE_ANCHORED', 'invoice.due_date', 'before', 24 * 60)]);
    mockPrisma.invoice.findMany.mockResolvedValueOnce([
      { id: 'inv-1', invoice_number: 'I00001', due_date: due },
    ]);

    await runAutomationTick(NOW);

    const q = mockPrisma.invoice.findMany.mock.calls[0][0];
    expect(q.where.organization_id).toBe(ORG);
    expect(q.where.due_date.gte.getTime()).toBe(NOW.getTime());
    expect(q.where.due_date.lte.getTime()).toBe(NOW.getTime() + 24 * HOUR);

    expect(mockCreateEnrollment).toHaveBeenCalledTimes(1);
    const arg = mockCreateEnrollment.mock.calls[0][0];
    expect(arg.workflow).toEqual({
      id: 'wf-INVOICE_DATE_ANCHORED',
      published_version_id: 'ver-1',
      trigger_type: 'INVOICE_DATE_ANCHORED',
      organization_id: ORG,
      legacy_rule_id: null,
    });
    expect(arg.entity).toEqual({ type: 'invoice', id: 'inv-1', label: 'I00001' });
    expect(arg.occurrenceKey).toBe(due.toISOString());
    expect(arg.now).toBe(NOW);
  });

  it('does not enroll an invoice whose due date has already passed — the window excludes it', async () => {
    const due = new Date(NOW.getTime() - 24 * HOUR); // a day in the past
    mockPrisma.workflow.findMany
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([dateAnchoredWorkflow('INVOICE_DATE_ANCHORED', 'invoice.due_date', 'before', 24 * 60)]);
    // A real DB query would exclude this row (due_date is below the window
    // floor) — assert on the where-bounds, not the mock's return, so the test
    // proves the window math rather than just trusting a hand-set mock.
    mockPrisma.invoice.findMany.mockResolvedValueOnce([]);

    await runAutomationTick(NOW);

    const q = mockPrisma.invoice.findMany.mock.calls[0][0];
    expect(q.where.due_date.gte.getTime()).toBe(NOW.getTime());
    expect(q.where.due_date.lte.getTime()).toBe(NOW.getTime() + 24 * HOUR);
    expect(due.getTime()).toBeLessThan(q.where.due_date.gte.getTime());

    expect(mockCreateEnrollment).not.toHaveBeenCalled();
  });

  it('a date-anchored workflow with a malformed trigger_config is skipped with logger.warn, no candidate query', async () => {
    mockPrisma.workflow.findMany
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        dateAnchoredWorkflow('INVOICE_DATE_ANCHORED', 'invoice.due_date', 'before', 24 * 60, {
          trigger_config: { anchor: 'invoice.due_date' }, // missing direction + offset_minutes
        }),
      ]);
    await runAutomationTick(NOW);
    expect(mockPrisma.invoice.findMany).not.toHaveBeenCalled();
    expect(mockCreateEnrollment).not.toHaveBeenCalled();
  });

  it('one workflow whose candidate query throws does not stop the scan for other date-anchored workflows', async () => {
    mockPrisma.workflow.findMany
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        dateAnchoredWorkflow('INVOICE_DATE_ANCHORED', 'invoice.due_date', 'before', 24 * 60),
        dateAnchoredWorkflow('ESTIMATE_DATE_ANCHORED', 'estimate.valid_until', 'before', 24 * 60),
      ]);
    mockPrisma.invoice.findMany.mockRejectedValueOnce(new Error('db boom'));
    mockPrisma.estimate.findMany.mockResolvedValueOnce([
      { id: 'est-1', estimate_number: 'E00001', valid_until: new Date(NOW.getTime() + 12 * HOUR) },
    ]);

    await expect(runAutomationTick(NOW)).resolves.toBeUndefined();
    expect(mockCreateEnrollment).toHaveBeenCalledTimes(1);
    expect(mockCreateEnrollment.mock.calls[0][0].entity).toEqual({ type: 'estimate', id: 'est-1', label: 'E00001' });
  });
});

describe('runAutomationTick — advanceDueEnrollments', () => {
  it('advances due ACTIVE enrollments oldest-first, bounded batch of 50', async () => {
    mockPrisma.workflowEnrollment.findMany.mockResolvedValueOnce([{ id: 'e1' }, { id: 'e2' }]);
    await runAutomationTick(NOW);
    const q = mockPrisma.workflowEnrollment.findMany.mock.calls[0][0];
    expect(q.where).toEqual({ status: 'ACTIVE', resume_at: { lte: NOW } });
    expect(q.orderBy).toEqual({ resume_at: 'asc' });
    expect(q.take).toBe(50);
    expect(q.select).toEqual({ id: true });
    expect(mockAdvanceEnrollment).toHaveBeenCalledTimes(2);
    expect(mockAdvanceEnrollment).toHaveBeenNthCalledWith(1, 'e1', NOW);
    expect(mockAdvanceEnrollment).toHaveBeenNthCalledWith(2, 'e2', NOW);
  });

  it('one failing advanceEnrollment call does not stop the batch', async () => {
    mockPrisma.workflowEnrollment.findMany.mockResolvedValueOnce([{ id: 'e1' }, { id: 'e2' }]);
    mockAdvanceEnrollment.mockRejectedValueOnce(new Error('boom'));
    await expect(runAutomationTick(NOW)).resolves.toBeUndefined();
    expect(mockAdvanceEnrollment).toHaveBeenCalledTimes(2);
  });
});

describe('runAutomationTick — recoverWedgedEnrollments (crash recovery)', () => {
  // The sweep phase issues the SECOND workflowEnrollment.findMany of a tick
  // (the first is the advance phase).
  function sweepQueryArgs() {
    return mockPrisma.workflowEnrollment.findMany.mock.calls[1][0];
  }
  /** Make the SWEEP phase (second findMany) return these stuck enrollments. */
  function stuck(enrollments: Array<{ id: string; step_cursor: number }>) {
    mockPrisma.workflowEnrollment.findMany
      .mockResolvedValueOnce([]) // advance phase
      .mockResolvedValueOnce(enrollments); // sweep phase
  }

  it('selects ACTIVE enrollments overdue past the 30-minute grace, bounded batch of 50', async () => {
    await runAutomationTick(NOW);
    const q = sweepQueryArgs();
    expect(q.where.status).toBe('ACTIVE');
    expect(q.where.resume_at.lte.getTime()).toBe(NOW.getTime() - 30 * MINUTE);
    expect(q.take).toBe(50);
  });

  it('no claim row at the cursor = backlog, not a wedge — nothing is touched', async () => {
    stuck([{ id: 'enr-1', step_cursor: 2 }]);
    mockPrisma.workflowStepRun.findUnique.mockResolvedValueOnce(null);
    await runAutomationTick(NOW);
    expect(mockPrisma.workflowStepRun.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { enrollment_id_step_index: { enrollment_id: 'enr-1', step_index: 2 } } }),
    );
    expect(mockPrisma.workflowEnrollment.updateMany).not.toHaveBeenCalled();
  });

  it('FAILED claim (unknowable outcome) -> enrollment closed FAILED, never retried', async () => {
    stuck([{ id: 'enr-1', step_cursor: 2 }]);
    mockPrisma.workflowStepRun.findUnique.mockResolvedValueOnce({ status: 'FAILED', step_type: 'SEND_EMAIL', executed_at: NOW });
    await runAutomationTick(NOW);
    expect(mockPrisma.workflowEnrollment.updateMany).toHaveBeenCalledWith({
      where: { id: 'enr-1', status: 'ACTIVE', step_cursor: 2 },
      data: {
        status: 'FAILED',
        finished_at: NOW,
        finished_reason: 'A system interruption stopped this automation mid-step',
      },
    });
  });

  it('STOPPED claim (finish write was lost) -> enrollment closed STOPPED', async () => {
    stuck([{ id: 'enr-1', step_cursor: 1 }]);
    mockPrisma.workflowStepRun.findUnique.mockResolvedValueOnce({ status: 'STOPPED', step_type: 'STOP_IF', executed_at: NOW });
    await runAutomationTick(NOW);
    expect(mockPrisma.workflowEnrollment.updateMany).toHaveBeenCalledWith({
      where: { id: 'enr-1', status: 'ACTIVE', step_cursor: 1 },
      data: {
        status: 'STOPPED',
        finished_at: NOW,
        finished_reason: 'Stopped mid-flow during a system interruption',
      },
    });
  });

  it('SENT claim (crash landed after the send, before the CAS) -> the lost CAS is finished and the flow resumes', async () => {
    stuck([{ id: 'enr-1', step_cursor: 0 }]);
    mockPrisma.workflowStepRun.findUnique.mockResolvedValueOnce({ status: 'SENT', step_type: 'SEND_TEXT', executed_at: NOW });
    await runAutomationTick(NOW);
    expect(mockPrisma.workflowEnrollment.updateMany).toHaveBeenCalledWith({
      where: { id: 'enr-1', status: 'ACTIVE', step_cursor: 0 },
      data: { step_cursor: 1, resume_at: NOW },
    });
  });

  it('recovered WAIT resumes at claim-time + configured duration — the author\'s delay is preserved', async () => {
    const claimedAt = new Date(NOW.getTime() - 45 * MINUTE);
    stuck([{ id: 'enr-1', step_cursor: 1 }]);
    mockPrisma.workflowStepRun.findUnique.mockResolvedValueOnce({ status: 'CONTINUED', step_type: 'WAIT', executed_at: claimedAt });
    mockPrisma.workflowEnrollment.findUnique.mockResolvedValueOnce({
      version: { definition: { steps: [{ position: 0, config: {} }, { position: 1, config: { duration_minutes: 1440 } }] } },
    });
    await runAutomationTick(NOW);
    expect(mockPrisma.workflowEnrollment.updateMany).toHaveBeenCalledWith({
      where: { id: 'enr-1', status: 'ACTIVE', step_cursor: 1 },
      data: { step_cursor: 2, resume_at: new Date(claimedAt.getTime() + 1440 * MINUTE) },
    });
  });

  it('multiple wedges recover independently — one failure does not stop the others', async () => {
    stuck([
      { id: 'enr-1', step_cursor: 0 },
      { id: 'enr-2', step_cursor: 1 },
    ]);
    mockPrisma.workflowStepRun.findUnique
      .mockRejectedValueOnce(new Error('db boom'))
      .mockResolvedValueOnce({ status: 'FAILED', step_type: 'SEND_EMAIL', executed_at: NOW });
    await expect(runAutomationTick(NOW)).resolves.toBeUndefined();
    expect(mockPrisma.workflowEnrollment.updateMany).toHaveBeenCalledTimes(1);
  });
});

describe('runAutomationTick — tick guard + phase isolation', () => {
  it('skips overlapping ticks: a second tick while the first is in-flight is a no-op', async () => {
    let releaseScan: () => void = () => {};
    mockPrisma.workflow.findMany.mockImplementationOnce(
      () => new Promise((resolve) => { releaseScan = () => resolve([]); }),
    );
    const first = runAutomationTick(NOW);
    await runAutomationTick(NOW);
    expect(mockPrisma.workflowEnrollment.findMany).not.toHaveBeenCalled();
    releaseScan();
    await first;
    mockPrisma.workflowEnrollment.findMany.mockClear();
    mockPrisma.workflow.findMany.mockResolvedValueOnce([]);
    await runAutomationTick(NOW);
    // one tick = advance phase + sweep phase, each with one enrollment query
    expect(mockPrisma.workflowEnrollment.findMany).toHaveBeenCalledTimes(2);
  });

  it('a scan failure does not prevent the advance phase or the sweep phase from running', async () => {
    mockPrisma.workflow.findMany.mockRejectedValueOnce(new Error('scan boom'));
    mockPrisma.workflowEnrollment.findMany.mockResolvedValueOnce([{ id: 'e1' }]); // advance phase
    await expect(runAutomationTick(NOW)).resolves.toBeUndefined();
    expect(mockAdvanceEnrollment).toHaveBeenCalledWith('e1', NOW);
    expect(mockPrisma.workflowEnrollment.findMany).toHaveBeenCalledTimes(2); // sweep phase still ran
  });

  it('an advance-phase failure does not prevent the sweep phase from running', async () => {
    mockPrisma.workflowEnrollment.findMany.mockRejectedValueOnce(new Error('advance boom'));
    await expect(runAutomationTick(NOW)).resolves.toBeUndefined();
    expect(mockPrisma.workflowEnrollment.findMany).toHaveBeenCalledTimes(2); // sweep phase still queried
  });

  it('a date-anchor scan failure does not prevent the advance phase or the sweep phase from running', async () => {
    mockPrisma.workflow.findMany
      .mockResolvedValueOnce([]) // scanTimeTriggers: nothing timed
      .mockRejectedValueOnce(new Error('date-anchor scan boom')); // scanDateAnchorTriggers
    mockPrisma.workflowEnrollment.findMany.mockResolvedValueOnce([{ id: 'e1' }]); // advance phase
    await expect(runAutomationTick(NOW)).resolves.toBeUndefined();
    expect(mockAdvanceEnrollment).toHaveBeenCalledWith('e1', NOW);
    expect(mockPrisma.workflowEnrollment.findMany).toHaveBeenCalledTimes(2); // sweep phase still ran
  });
});
