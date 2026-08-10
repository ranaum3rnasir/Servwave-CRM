import { describe, it, expect, beforeEach, vi } from 'vitest';
import { prisma } from '../../../lib/prisma';
import { rearmAnchoredWaits } from '../enrollment';

// Mirror the sibling harnesses (enrollment.test.ts / enrollment.anchoredWait.test.ts):
// stub the executor so a stray send would be observable. rearm re-times pending
// waits ONLY — it must never dispatch a message.
vi.mock('../executors', () => ({
  executeAction: vi.fn().mockResolvedValue({ status: 'SENT', recipientSummary: 'x@y.com', detail: 'ok' }),
}));
import { executeAction } from '../executors';

const mockPrisma = prisma as any;
const mockExecute = executeAction as ReturnType<typeof vi.fn>;

const ORG = '00000000-0000-0000-0000-000000000001';
const LEAD_ID = 'd0000000-0000-0000-0000-000000000001';
const WF_ID = 'f0000000-0000-0000-0000-000000000001';
const VER_ID = 'a0000000-0000-0000-0000-000000000002';
const ENR_ID = 'e0000000-0000-0000-0000-000000000003';

// The walkthrough date this enrollment was pinned to when it parked at the wait.
const OLD_WALKTHROUGH = new Date('2026-08-01T15:00:00.000Z');
const OFFSET = 1440; // minutes = 1 day (the "1 day before the walkthrough" reminder)

const ORG_ROW = {
  name: 'Blue Ridge Plumbing',
  phone: '(555) 204-7788',
  timezone: 'America/New_York',
  currency: 'USD',
  logo_url: null,
  brand_color: '#0C2D3A',
};

// Live lead row — walkthrough_scheduled_at is the anchor rearm reads FRESH via
// loadExecutionBundle (→ state.leadWalkthroughScheduledAt).
//
// Walkthrough-as-entity redesign, PR-B2: the anchor now resolves from the lead's CURRENT
// visit (D15) via the `walkthroughs` relation instead of the legacy flat column. `null` means
// "no current visit" (a REQUESTED-only lead), mirroring the old "walkthrough cleared" case.
const leadRow = (walkthroughAt: Date | null) => ({
  id: LEAD_ID,
  lead_number: 'L00042',
  status: 'CONTACTED',
  service_request: 'Leaking kitchen faucet',
  walkthroughs: walkthroughAt
    ? [{
        id: 'w0000000-0000-0000-0000-000000000001', status: 'SCHEDULED', scheduled_at: walkthroughAt,
        duration_minutes: 60, completed_at: null, cancelled_at: null, cancelled_reason: null,
        cancelled_by: null, customer_email_sent_at: null, notes: null, created_at: new Date('2026-07-01'),
        performers: [{ user: { first_name: 'Mike', last_name: 'Torres' } }],
      }]
    : [],
  customer: {
    id: 'c0000000-0000-0000-0000-000000000001',
    first_name: 'Sarah',
    last_name: 'Mitchell',
    email: 'sarah@example.com',
    phone: '+15551234567',
  },
});

// An anchored WAIT: parks until lead.walkthrough_scheduled_at − 1 day (read live).
const anchoredWaitStep = (
  position: number,
  overrides: Partial<{ anchor: string; direction: string; offset_minutes: number }> = {},
) => ({
  position,
  step_type: 'WAIT',
  config: { mode: 'anchored', anchor: 'lead.walkthrough_scheduled_at', direction: 'before', offset_minutes: OFFSET, ...overrides },
});
const emailStep = (position: number) => ({ position, step_type: 'SEND_EMAIL', config: { recipient: 'customer', subject: 's', body: 'b' } });
// A legacy RELATIVE wait (now + duration) — NOT anchored, so rearm must ignore it.
const relativeWaitStep = (position: number, duration_minutes: number) => ({ position, step_type: 'WAIT', config: { duration_minutes } });

function def(steps: unknown[], overrides: Record<string, unknown> = {}) {
  return { trigger_type: 'WALKTHROUGH_SCHEDULED', trigger_config: null, send_window: 'ANYTIME', steps, ...overrides };
}

// A findMany enrollment row, shaped like the rearm include
// (version.definition + workflow.trigger_type) plus the scalar fields it reads.
// Default: an ACTIVE, fires-once (WALKTHROUGH_SCHEDULED) enrollment parked at an
// anchored WAIT at cursor 0, pinned to the OLD walkthrough occurrence.
function enrollmentRow(overrides: Record<string, unknown> = {}) {
  return {
    id: ENR_ID,
    workflow_id: WF_ID,
    workflow_version_id: VER_ID,
    status: 'ACTIVE',
    entity_type: 'lead',
    entity_id: LEAD_ID,
    entity_label: 'L00042',
    occurrence_key: OLD_WALKTHROUGH.toISOString(),
    dedupe_key: `WALKTHROUGH_SCHEDULED:${LEAD_ID}`,
    step_cursor: 0,
    organization_id: ORG,
    version: { definition: def([anchoredWaitStep(0)]) },
    workflow: { trigger_type: 'WALKTHROUGH_SCHEDULED' },
    ...overrides,
  } as any;
}

beforeEach(() => {
  vi.clearAllMocks();
  // Reassign with findMany + updateMany present (the two methods rearm calls);
  // the rest are here for parity with the sibling harnesses.
  mockPrisma.workflowEnrollment = {
    findMany: vi.fn().mockResolvedValue([]),
    updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    create: vi.fn(),
    findUnique: vi.fn(),
    update: vi.fn().mockResolvedValue({}),
  };
  mockPrisma.organization.findUnique.mockResolvedValue(ORG_ROW);
  mockPrisma.lead.findFirst.mockResolvedValue(leadRow(OLD_WALKTHROUGH));
});

describe('rearmAnchoredWaits', () => {
  // ── Scenario 1: re-arm on move (fires-once trigger) — later + earlier ────────
  it('re-arms a fires-once anchored wait to a LATER date: resume_at = newDate − offset, occurrence_key = newDate ISO', async () => {
    const LATER = new Date('2026-08-05T15:00:00.000Z'); // moved 4 days later
    mockPrisma.workflowEnrollment.findMany.mockResolvedValueOnce([enrollmentRow()]);
    mockPrisma.lead.findFirst.mockResolvedValueOnce(leadRow(LATER));

    await rearmAnchoredWaits('lead', LEAD_ID);

    expect(mockPrisma.workflowEnrollment.updateMany).toHaveBeenCalledTimes(1);
    const call = mockPrisma.workflowEnrollment.updateMany.mock.calls[0][0];
    // CAS-scoped to this enrollment's parked cursor.
    expect(call.where).toMatchObject({ id: ENR_ID, step_cursor: 0, status: 'ACTIVE' });
    // resume_at follows the moved date (start − 1 day) …
    expect(call.data.resume_at.getTime()).toBe(LATER.getTime() - OFFSET * 60_000);
    // … and occurrence_key syncs to the live date so Task 4b staleness keeps it.
    expect(call.data.occurrence_key).toBe(LATER.toISOString());
    expect(mockExecute).not.toHaveBeenCalled();
  });

  it('re-arms a fires-once anchored wait to an EARLIER date too', async () => {
    const EARLIER = new Date('2026-07-20T15:00:00.000Z'); // moved earlier than OLD
    mockPrisma.workflowEnrollment.findMany.mockResolvedValueOnce([enrollmentRow()]);
    mockPrisma.lead.findFirst.mockResolvedValueOnce(leadRow(EARLIER));

    await rearmAnchoredWaits('lead', LEAD_ID);

    expect(mockPrisma.workflowEnrollment.updateMany).toHaveBeenCalledTimes(1);
    const call = mockPrisma.workflowEnrollment.updateMany.mock.calls[0][0];
    expect(call.data.resume_at.getTime()).toBe(EARLIER.getTime() - OFFSET * 60_000);
    expect(call.data.occurrence_key).toBe(EARLIER.toISOString());
  });

  // ── Scenario 2: skip the reschedule trigger (THE double-send guard) ──────────
  it('SKIPS an enrollment whose pinned trigger is the entity reschedule trigger (double-send guard)', async () => {
    mockPrisma.workflowEnrollment.findMany.mockResolvedValueOnce([
      enrollmentRow({
        version: { definition: def([anchoredWaitStep(0)], { trigger_type: 'WALKTHROUGH_RESCHEDULED' }) },
        workflow: { trigger_type: 'WALKTHROUGH_RESCHEDULED' },
      }),
    ]);
    // Even though the walkthrough moved, this reschedule-triggered enrollment gets
    // a FRESH enrollment from the new event + is dropped by staleness — re-arming
    // it would resurrect a superseded copy and double-send. Must be left untouched.
    // (No lead.findFirst mock: we assert below that it is never even loaded.)

    await rearmAnchoredWaits('lead', LEAD_ID);

    // Untouched: no re-arm write, and we short-circuit BEFORE loading the entity.
    expect(mockPrisma.workflowEnrollment.updateMany).not.toHaveBeenCalled();
    expect(mockPrisma.lead.findFirst).not.toHaveBeenCalled();
    expect(mockExecute).not.toHaveBeenCalled();
  });

  // ── Scenario 3: ignore non-anchored-wait enrollments ────────────────────────
  it('leaves non-anchored-wait enrollments untouched (a SEND_EMAIL step and a relative WAIT step)', async () => {
    mockPrisma.workflowEnrollment.findMany.mockResolvedValueOnce([
      // current step is a SEND_EMAIL — not a wait at all
      enrollmentRow({ id: 'e0000000-0000-0000-0000-00000000000a', version: { definition: def([emailStep(0)]) } }),
      // current step is a legacy RELATIVE wait (now + duration) — a WAIT but not anchored
      enrollmentRow({ id: 'e0000000-0000-0000-0000-00000000000b', version: { definition: def([relativeWaitStep(0, 1440)]) } }),
    ]);

    await rearmAnchoredWaits('lead', LEAD_ID);

    expect(mockPrisma.workflowEnrollment.updateMany).not.toHaveBeenCalled();
    expect(mockExecute).not.toHaveBeenCalled();
  });

  // ── Scenario 4: anchor null → skip (STOP happens at the next wake, not here) ──
  it('leaves the enrollment as-is when the live anchor date is null (un-scheduled walkthrough)', async () => {
    mockPrisma.workflowEnrollment.findMany.mockResolvedValueOnce([enrollmentRow()]);
    mockPrisma.lead.findFirst.mockResolvedValueOnce(leadRow(null)); // walkthrough cleared

    await rearmAnchoredWaits('lead', LEAD_ID);

    expect(mockPrisma.workflowEnrollment.updateMany).not.toHaveBeenCalled();
    expect(mockExecute).not.toHaveBeenCalled();
  });
});

// ── Job entity mirror — same function, the OTHER entityType branch ──────────
// job.controller.ts calls rearmAnchoredWaits('job', id) right after a reschedule
// (existing.scheduled_start ? 'JOB_RESCHEDULED' : 'JOB_SCHEDULED'). The lead
// coverage above proves the shared step-filtering/offset-math logic; this proves
// the job-specific wiring itself: job.scheduled_start is read live, and
// RESCHEDULE_TRIGGER.job ('JOB_RESCHEDULED') is the correct double-send skip key.
describe('rearmAnchoredWaits — job entity', () => {
  const JOB_ID = 'b0000000-0000-0000-0000-000000000001';
  const OLD_START = new Date('2026-08-01T13:00:00.000Z');
  const JOB_ENR_ID = 'e0000000-0000-0000-0000-00000000000c';

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

  const jobAnchoredWaitStep = (position: number) => ({
    position,
    step_type: 'WAIT',
    config: { mode: 'anchored', anchor: 'job.scheduled_start', direction: 'before', offset_minutes: OFFSET },
  });

  function jobDef(steps: unknown[], overrides: Record<string, unknown> = {}) {
    return { trigger_type: 'JOB_SCHEDULED', trigger_config: null, send_window: 'ANYTIME', steps, ...overrides };
  }

  function jobEnrollmentRow(overrides: Record<string, unknown> = {}) {
    return {
      id: JOB_ENR_ID,
      workflow_id: WF_ID,
      workflow_version_id: VER_ID,
      status: 'ACTIVE',
      entity_type: 'job',
      entity_id: JOB_ID,
      entity_label: 'J00042',
      occurrence_key: OLD_START.toISOString(),
      dedupe_key: `JOB_SCHEDULED:${JOB_ID}`,
      step_cursor: 0,
      organization_id: ORG,
      version: { definition: jobDef([jobAnchoredWaitStep(0)]) },
      workflow: { trigger_type: 'JOB_SCHEDULED' },
      ...overrides,
    } as any;
  }

  beforeEach(() => {
    mockPrisma.job.findFirst.mockResolvedValue(jobRow(OLD_START));
  });

  it('re-arms a fires-once anchored wait when the job is RESCHEDULED to a later date', async () => {
    const LATER = new Date('2026-08-05T13:00:00.000Z');
    mockPrisma.workflowEnrollment.findMany.mockResolvedValueOnce([jobEnrollmentRow()]);
    mockPrisma.job.findFirst.mockResolvedValueOnce(jobRow(LATER));

    await rearmAnchoredWaits('job', JOB_ID);

    expect(mockPrisma.workflowEnrollment.updateMany).toHaveBeenCalledTimes(1);
    const call = mockPrisma.workflowEnrollment.updateMany.mock.calls[0][0];
    expect(call.where).toMatchObject({ id: JOB_ENR_ID, step_cursor: 0, status: 'ACTIVE' });
    expect(call.data.resume_at.getTime()).toBe(LATER.getTime() - OFFSET * 60_000);
    expect(call.data.occurrence_key).toBe(LATER.toISOString());
    expect(mockExecute).not.toHaveBeenCalled();
  });

  it('SKIPS a JOB_RESCHEDULED-triggered enrollment — the double-send guard for jobs', async () => {
    mockPrisma.workflowEnrollment.findMany.mockResolvedValueOnce([
      jobEnrollmentRow({
        version: { definition: jobDef([jobAnchoredWaitStep(0)], { trigger_type: 'JOB_RESCHEDULED' }) },
        workflow: { trigger_type: 'JOB_RESCHEDULED' },
      }),
    ]);
    // A reschedule-triggered enrollment gets a FRESH copy from the new event and
    // is dropped by staleness — re-arming it here would resurrect a superseded
    // copy and double-send. Must be left untouched, entity never even loaded.

    await rearmAnchoredWaits('job', JOB_ID);

    expect(mockPrisma.workflowEnrollment.updateMany).not.toHaveBeenCalled();
    expect(mockPrisma.job.findFirst).not.toHaveBeenCalled();
    expect(mockExecute).not.toHaveBeenCalled();
  });

  it('leaves the enrollment as-is when the job is no longer scheduled (scheduled_start cleared)', async () => {
    mockPrisma.workflowEnrollment.findMany.mockResolvedValueOnce([jobEnrollmentRow()]);
    mockPrisma.job.findFirst.mockResolvedValueOnce(jobRow(null));

    await rearmAnchoredWaits('job', JOB_ID);

    expect(mockPrisma.workflowEnrollment.updateMany).not.toHaveBeenCalled();
    expect(mockExecute).not.toHaveBeenCalled();
  });
});
