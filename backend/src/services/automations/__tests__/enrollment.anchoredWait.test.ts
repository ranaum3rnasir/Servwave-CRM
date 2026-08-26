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

// S8 §2 (A4, RATIFIED): the anchored-WAIT resolver now reads context.ts's
// resolveNextJobVisit(isLiveVisit subset) instead of a flat Job.scheduled_start column, so the
// fixture carries a `visits` array — exactly what `include: { visits: {...} }` would return —
// rather than a bare scheduled_start. `jobRow(scheduledStart)` is the single-visit convenience
// wrapper every pre-existing scenario used; `jobRowWithVisits(visits)` is the multi-visit form
// the new scenarios below need. Passing `null` means NO live visit at all (the empty-`visits`
// case), matching "no longer scheduled" exactly as a bare null column used to.
type VisitFixture = {
  id: string;
  status: string;
  scheduled_at: Date | null;
  scheduled_end?: Date | null;
  created_at: Date;
  assignees: { user: { id: string; email: string; first_name: string; last_name: string } }[];
};

const TECH = { user: { id: 'tech-1', email: 'mike@org.com', first_name: 'Mike', last_name: 'Torres' } };

function liveVisit(id: string, scheduledAt: Date, createdAt = new Date('2026-07-01T00:00:00.000Z')): VisitFixture {
  return { id, status: 'SCHEDULED', scheduled_at: scheduledAt, scheduled_end: null, created_at: createdAt, assignees: [TECH] };
}

const jobRowWithVisits = (visits: VisitFixture[]) => ({
  id: JOB_ID,
  job_number: 'J00042',
  status: 'SCHEDULED',
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
  visits,
});

// Base job row (SCHEDULED so JOB_SCHEDULED staleness never stops it). Each scenario overrides
// scheduled_start — the anchor the engine reads live, now via the job's single live visit.
const jobRow = (scheduledStart: Date | null) =>
  jobRowWithVisits(scheduledStart ? [liveVisit('visit-1', scheduledStart)] : []);

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

  it('(c) stops the enrollment when the job has no visits at all — anchor resolves null (no longer scheduled)', async () => {
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

  it('(d) stops the enrollment when EVERY visit on the job is CANCELLED — same as no visits at all', async () => {
    mockPrisma.job.findFirst.mockResolvedValueOnce(
      jobRowWithVisits([
        { id: 'visit-1', status: 'CANCELLED', scheduled_at: new Date('2026-07-15T13:00:00.000Z'), created_at: new Date('2026-07-01'), assignees: [] },
        { id: 'visit-2', status: 'CANCELLED', scheduled_at: new Date('2026-07-20T13:00:00.000Z'), created_at: new Date('2026-07-02'), assignees: [] },
      ]),
    );
    mockPrisma.workflowEnrollment.findUnique.mockResolvedValueOnce(
      enrollmentRow({ version: { definition: def([anchoredWaitStep(0)]) } }),
    );

    await advanceEnrollment(ENR_ID, NOW);

    expect(mockPrisma.workflowStepRun.create).not.toHaveBeenCalled();
    expect(mockPrisma.workflowEnrollment.update.mock.calls[0][0].data).toMatchObject({
      status: 'STOPPED',
      finished_reason: 'the appointment is no longer scheduled',
    });
    expect(mockExecute).not.toHaveBeenCalled();
  });

  // S8 §2 (A4, RATIFIED): the anchored WAIT stays PER-JOB even on a multi-visit job — it parks
  // against whichever visit resolveNextJobVisit calls "next" (earliest UPCOMING live visit),
  // never the one that originally triggered enrollment (context.ts has no per-visit context on
  // the enrollment by design). A past, already-actioned-looking visit and a further-out visit
  // must not win over the genuinely next one.
  //
  // resolveNextJobVisit's "upcoming" filter has no injectable clock (it defaults to
  // `new Date()`, same as syncJobFromVisits's own caller) — context.ts calls it the same way,
  // so this test's "next"/"later" fixtures are built off REAL Date.now(), not the fixed NOW used
  // for the enrollment engine's due-vs-park comparison, matching the existing convention for
  // this exact constraint (job-visits.test.ts's `past`/`future` fixtures).
  it('(e) on a 3-visit job, parks against the NEXT upcoming live visit — not the earliest and not the furthest', async () => {
    const HOUR_MS = 60 * 60 * 1000;
    const DAY_MS = 24 * HOUR_MS;
    const past = new Date(Date.now() - 10 * HOUR_MS); // already elapsed
    const next = new Date(Date.now() + 5 * DAY_MS); // the one that should win
    const later = new Date(Date.now() + 20 * DAY_MS); // further out
    mockPrisma.job.findFirst.mockResolvedValueOnce(
      jobRowWithVisits([liveVisit('visit-past', past), liveVisit('visit-next', next), liveVisit('visit-later', later)]),
    );
    mockPrisma.workflowEnrollment.findUnique.mockResolvedValueOnce(
      enrollmentRow({ version: { definition: def([anchoredWaitStep(0)]) } }),
    );

    await advanceEnrollment(ENR_ID, NOW);

    expect(mockPrisma.workflowStepRun.create).not.toHaveBeenCalled(); // no claim — still parked
    const park = mockPrisma.workflowEnrollment.updateMany.mock.calls[0][0];
    expect(park.data.step_cursor).toBeUndefined(); // cursor NOT advanced
    expect(park.data.resume_at.getTime()).toBe(next.getTime() - 1440 * 60_000);
    expect(mockExecute).not.toHaveBeenCalled();
  });

  it('(f) on a 3-visit job with every visit already elapsed, falls back to the EARLIEST rather than nothing', async () => {
    // resolveNextJobVisit's own documented fallback when nothing is upcoming: earliest of the
    // timed set wins, ties broken by created_at — preserved here purely by reuse.
    const earliest = new Date(NOW.getTime() - 48 * 60 * 60_000);
    const middle = new Date(NOW.getTime() - 24 * 60 * 60_000);
    const latest = new Date(NOW.getTime() - 1 * 60 * 60_000);
    mockPrisma.job.findFirst.mockResolvedValueOnce(
      jobRowWithVisits([liveVisit('visit-mid', middle), liveVisit('visit-earliest', earliest), liveVisit('visit-latest', latest)]),
    );
    mockPrisma.workflowEnrollment.findUnique.mockResolvedValueOnce(
      enrollmentRow({ version: { definition: def([anchoredWaitStep(0)]) } }),
    );

    await advanceEnrollment(ENR_ID, NOW);

    // target (earliest − 24h) is deep in the past → already due → fires rather than parks.
    const claim = mockPrisma.workflowStepRun.create.mock.calls[0][0].data;
    expect(claim).toMatchObject({ status: 'CONTINUED' });
    expect(mockExecute).not.toHaveBeenCalled();
  });
});
