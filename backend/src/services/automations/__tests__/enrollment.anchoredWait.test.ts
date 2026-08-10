import { describe, it, expect, beforeEach, vi } from 'vitest';
import { prisma } from '../../../lib/prisma';
import { advanceEnrollment } from '../enrollment';

// Mirror enrollment.test.ts: stub the executor so a stray send is observable
// (none of these scenarios should ever dispatch).
vi.mock('../executors', () => ({
  executeAction: vi.fn().mockResolvedValue({ status: 'SENT', recipientSummary: 'x@y.com', detail: 'ok' }),
}));
import { executeAction } from '../executors';

const mockPrisma = prisma as any;
const mockExecute = executeAction as ReturnType<typeof vi.fn>;

const ORG = '00000000-0000-0000-0000-000000000001';
const JOB_ID = 'b0000000-0000-0000-0000-000000000001';
const WF_ID = 'f0000000-0000-0000-0000-000000000001';
const VER_ID = 'a0000000-0000-0000-0000-000000000002';
const ENR_ID = 'e0000000-0000-0000-0000-000000000003';
const NOW = new Date('2026-07-14T15:00:00.000Z'); // 11:00 America/New_York — inside business hours

const ORG_ROW = {
  name: 'Blue Ridge Plumbing',
  phone: '(555) 204-7788',
  timezone: 'America/New_York',
  currency: 'USD',
  logo_url: null,
  brand_color: '#0C2D3A',
};

// Base job row (SCHEDULED so JOB_SCHEDULED staleness never stops it). Each
// scenario overrides scheduled_start — the anchor the engine reads live.
const jobRow = (scheduledStart: Date | null) => ({
  id: JOB_ID,
  job_number: 'J00042',
  status: 'SCHEDULED',
  scheduled_start: scheduledStart,
  job_type: 'HVAC Service',
  completed_at: null,
  customer: {
    id: 'c0000000-0000-0000-0000-000000000001',
    first_name: 'Sarah',
    last_name: 'Mitchell',
    email: 'sarah@example.com',
    phone: '+15551234567',
  },
  service_location: { address_line1: '18 Maple Ave', address_line2: null, city: 'Richmond', state: 'VA', zip: '23220' },
  assignees: [{ user: { id: 'tech-1', email: 'mike@org.com', first_name: 'Mike', last_name: 'Torres' } }],
});

// An anchored WAIT step: parks until job.scheduled_start ± offset, read live.
const anchoredWaitStep = (
  position: number,
  overrides: Partial<{ anchor: string; direction: string; offset_minutes: number }> = {},
) => ({
  position,
  step_type: 'WAIT',
  config: { mode: 'anchored', anchor: 'job.scheduled_start', direction: 'before', offset_minutes: 1440, ...overrides },
});

function def(steps: unknown[], overrides: Record<string, unknown> = {}) {
  return { trigger_type: 'JOB_SCHEDULED', trigger_config: null, send_window: 'ANYTIME', steps, ...overrides };
}

function workflowRow(overrides: Record<string, unknown> = {}) {
  return {
    id: WF_ID,
    name: 'Welcome flow',
    status: 'PUBLISHED',
    is_enabled: true,
    trigger_type: 'JOB_SCHEDULED',
    published_version_id: VER_ID,
    organization_id: ORG,
    ...overrides,
  };
}

function enrollmentRow(overrides: Record<string, unknown> = {}) {
  return {
    id: ENR_ID,
    workflow_id: WF_ID,
    workflow_version_id: VER_ID,
    status: 'ACTIVE',
    entity_type: 'job',
    entity_id: JOB_ID,
    entity_label: 'J00042',
    occurrence_key: null,
    dedupe_key: `JOB_SCHEDULED:${JOB_ID}`,
    step_cursor: 0,
    resume_at: NOW,
    organization_id: ORG,
    workflow: workflowRow(),
    version: { definition: def([anchoredWaitStep(0)]) },
    ...overrides,
  } as any;
}

beforeEach(() => {
  vi.clearAllMocks();
  mockPrisma.workflow = {
    findMany: vi.fn().mockResolvedValue([]),
    update: vi.fn().mockResolvedValue({}),
  };
  mockPrisma.workflowEnrollment = {
    create: vi.fn().mockResolvedValue({ id: ENR_ID }),
    findUnique: vi.fn(),
    update: vi.fn().mockResolvedValue({}),
    updateMany: vi.fn().mockResolvedValue({ count: 1 }), // cursor CAS / park succeeds by default
  };
  mockPrisma.workflowStepRun = {
    create: vi.fn().mockResolvedValue({ id: 'run-1' }),
    update: vi.fn().mockResolvedValue({}),
    updateMany: vi.fn().mockResolvedValue({ count: 1 }),
  };
  mockPrisma.automationRun = mockPrisma.automationRun ?? {};
  mockPrisma.automationRun.findUnique = vi.fn().mockResolvedValue(null);
  mockPrisma.organization.findUnique.mockResolvedValue(ORG_ROW);
  mockPrisma.job.findFirst.mockResolvedValue(jobRow(new Date('2026-07-15T13:00:00.000Z')));
});

// ── Anchored WAIT execution (block 4b) ────────────────────────────────────────
describe('advanceEnrollment — anchored WAIT', () => {
  it('(a) parks WITHOUT claiming when the anchored target is still in the future', async () => {
    // scheduled_start = now + 25h; target = start − 24h (1440m before) = now + 1h → future.
    const scheduledStart = new Date(NOW.getTime() + 25 * 60 * 60_000);
    mockPrisma.job.findFirst.mockResolvedValueOnce(jobRow(scheduledStart));
    mockPrisma.workflowEnrollment.findUnique.mockResolvedValueOnce(
      enrollmentRow({ version: { definition: def([anchoredWaitStep(0)]) } }),
    );

    await advanceEnrollment(ENR_ID, NOW);

    // No claim row — a reschedule can re-arm resume_at later (Task 5).
    expect(mockPrisma.workflowStepRun.create).not.toHaveBeenCalled();
    // Parked at THIS step: cursor unchanged, resume_at == target (start − 24h).
    const park = mockPrisma.workflowEnrollment.updateMany.mock.calls[0][0];
    expect(park.where).toMatchObject({ id: ENR_ID, step_cursor: 0, status: 'ACTIVE' });
    expect(park.data.step_cursor).toBeUndefined(); // cursor NOT advanced
    expect(park.data.resume_at.getTime()).toBe(scheduledStart.getTime() - 1440 * 60_000);
    expect(mockExecute).not.toHaveBeenCalled();
  });

  it('(b) fires when the anchored target already passed: claims CONTINUED + advances the cursor to 1', async () => {
    // scheduled_start = now + 1h; target = start − 24h = now − 23h → already due.
    const scheduledStart = new Date(NOW.getTime() + 1 * 60 * 60_000);
    mockPrisma.job.findFirst.mockResolvedValueOnce(jobRow(scheduledStart));
    mockPrisma.workflowEnrollment.findUnique.mockResolvedValueOnce(
      enrollmentRow({ version: { definition: def([anchoredWaitStep(0)]) } }),
    );

    await advanceEnrollment(ENR_ID, NOW);

    // Idempotent claim row records the completed wait (NOT the pessimistic FAILED provisional).
    const claim = mockPrisma.workflowStepRun.create.mock.calls[0][0].data;
    expect(claim).toMatchObject({ enrollment_id: ENR_ID, step_index: 0, step_type: 'WAIT', status: 'CONTINUED' });
    expect(claim.detail).toContain('before the appointment time');
    // cursor CAS 0 → 1
    const cas = mockPrisma.workflowEnrollment.updateMany.mock.calls[0][0];
    expect(cas.where).toMatchObject({ id: ENR_ID, step_cursor: 0, status: 'ACTIVE' });
    expect(cas.data.step_cursor).toBe(1);
    expect(mockExecute).not.toHaveBeenCalled(); // WAIT never sends
  });

  it('(c) stops the enrollment when the anchor date is null (no longer scheduled)', async () => {
    mockPrisma.job.findFirst.mockResolvedValueOnce(jobRow(null));
    mockPrisma.workflowEnrollment.findUnique.mockResolvedValueOnce(
      enrollmentRow({ version: { definition: def([anchoredWaitStep(0)]) } }),
    );

    await advanceEnrollment(ENR_ID, NOW);

    expect(mockPrisma.workflowStepRun.create).not.toHaveBeenCalled(); // no claim row
    expect(mockPrisma.workflowEnrollment.update.mock.calls[0][0].data).toMatchObject({
      status: 'STOPPED',
      finished_reason: 'the appointment is no longer scheduled',
    });
    expect(mockExecute).not.toHaveBeenCalled();
  });
});
