import { describe, it, expect, beforeEach, vi } from 'vitest';
import { prisma } from '../../../lib/prisma';
import { enrollOnEvent, createEnrollment, advanceEnrollment, mapStepToActionType } from '../enrollment';

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
const LATE = new Date('2026-07-15T02:00:00.000Z'); // 22:00 July 14 America/New_York — outside window

const ORG_ROW = {
  name: 'Blue Ridge Plumbing',
  phone: '(555) 204-7788',
  timezone: 'America/New_York',
  currency: 'USD',
  logo_url: null,
  brand_color: '#0C2D3A',
  // Entitled to automations by default - every pre-existing test in this file
  // exercises the normal enrollment path, not the entitlement gate.
  plan: 'PRO',
  trial_ends_at: null,
  feature_overrides: null,
};

const JOB_ROW = {
  id: JOB_ID,
  job_number: 'J00042',
  status: 'SCHEDULED',
  scheduled_start: new Date('2026-07-15T13:00:00.000Z'),
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
};

// ── step + definition + row builders ──────────────────────────────────────────
const waitStep = (position: number, duration_minutes: number) => ({ position, step_type: 'WAIT', config: { duration_minutes } });
const emailStep = (position: number) => ({ position, step_type: 'SEND_EMAIL', config: { recipient: 'customer', subject: 's', body: 'b' } });
const textStep = (position: number) => ({ position, step_type: 'SEND_TEXT', config: { recipient: 'customer', body: 'b' } });
const notifyStep = (position: number) => ({ position, step_type: 'NOTIFY_TEAM', config: { recipient: 'assigned_techs', body: 'b' } });
const stopIfStep = (position: number, condition: string) => ({ position, step_type: 'STOP_IF', config: { condition } });

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
    version: { definition: def([emailStep(0)]) },
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
    updateMany: vi.fn().mockResolvedValue({ count: 1 }), // cursor CAS succeeds by default
  };
  mockPrisma.workflowStepRun = {
    create: vi.fn().mockResolvedValue({ id: 'run-1' }),
    update: vi.fn().mockResolvedValue({}),
    updateMany: vi.fn().mockResolvedValue({ count: 1 }),
  };
  mockPrisma.automationRun = mockPrisma.automationRun ?? {};
  mockPrisma.automationRun.findUnique = vi.fn().mockResolvedValue(null);
  mockPrisma.organization.findUnique.mockResolvedValue(ORG_ROW);
  mockPrisma.job.findFirst.mockResolvedValue(JOB_ROW);
});

// ── mapStepToActionType (point 18) ────────────────────────────────────────────
describe('mapStepToActionType', () => {
  it('maps every step type', () => {
    expect(mapStepToActionType('SEND_TEXT' as any)).toBe('SEND_SMS');
    expect(mapStepToActionType('SEND_EMAIL' as any)).toBe('SEND_EMAIL');
    expect(mapStepToActionType('NOTIFY_TEAM' as any)).toBe('NOTIFY_TEAM');
    expect(mapStepToActionType('WAIT' as any)).toBeNull();
    expect(mapStepToActionType('STOP_IF' as any)).toBeNull();
  });
});

// ── enrollOnEvent (points 1-2) ────────────────────────────────────────────────
describe('enrollOnEvent', () => {
  it('enrolls a matching PUBLISHED+enabled workflow and inline-advances it', async () => {
    mockPrisma.workflow.findMany.mockResolvedValueOnce([workflowRow()]);
    mockPrisma.workflowEnrollment.findUnique.mockResolvedValueOnce(enrollmentRow());
    await enrollOnEvent(
      { type: 'JOB_SCHEDULED', organizationId: ORG, entity: { type: 'job', id: JOB_ID, label: 'J00042' } },
      NOW,
    );
    expect(mockPrisma.workflowEnrollment.create).toHaveBeenCalledTimes(1);
    // inline advance happened: a step-run was claimed and the send was dispatched
    expect(mockPrisma.workflowStepRun.create).toHaveBeenCalledTimes(1);
    expect(mockExecute).toHaveBeenCalledTimes(1);
    expect(mockPrisma.workflowEnrollment.update.mock.calls[0][0].data).toMatchObject({ status: 'COMPLETED' });
  });

  it('excludes DRAFT / disabled workflows via the findMany where-clause', async () => {
    mockPrisma.workflow.findMany.mockResolvedValueOnce([]);
    await enrollOnEvent(
      { type: 'JOB_SCHEDULED', organizationId: ORG, entity: { type: 'job', id: JOB_ID, label: 'J00042' } },
      NOW,
    );
    expect(mockPrisma.workflow.findMany.mock.calls[0][0]).toMatchObject({
      where: {
        organization_id: ORG,
        trigger_type: 'JOB_SCHEDULED',
        is_enabled: true,
        status: 'PUBLISHED',
        published_version_id: { not: null },
      },
    });
    expect(mockPrisma.workflowEnrollment.create).not.toHaveBeenCalled();
  });

  it('one failing workflow does not block the others', async () => {
    mockPrisma.workflow.findMany.mockResolvedValueOnce([workflowRow({ id: 'wf-a' }), workflowRow({ id: 'wf-b' })]);
    // first enrollment create throws (non-P2002) — createEnrollment swallows it and returns null;
    // second one enrolls + advances.
    mockPrisma.workflowEnrollment.create
      .mockRejectedValueOnce(new Error('db down'))
      .mockResolvedValueOnce({ id: ENR_ID });
    mockPrisma.workflowEnrollment.findUnique.mockResolvedValueOnce(enrollmentRow());
    await enrollOnEvent(
      { type: 'JOB_SCHEDULED', organizationId: ORG, entity: { type: 'job', id: JOB_ID } },
      NOW,
    );
    expect(mockPrisma.workflowEnrollment.create).toHaveBeenCalledTimes(2);
    expect(mockExecute).toHaveBeenCalledTimes(1);
  });

  // SRVW-113 — the ONE case enrollOnEvent must filter on trigger_config, not just
  // trigger_type + org + enabled: two JOB_SUB_STATUS_ENTERED workflows can watch
  // two DIFFERENT sub-statuses, so only the one matching THIS occurrence enrolls.
  describe('sub-status predicate (Approach A)', () => {
    const subStatusWorkflow = (subStatusId: string, overrides: Record<string, unknown> = {}) =>
      workflowRow({
        id: `wf-${subStatusId}`,
        trigger_type: 'JOB_SUB_STATUS_ENTERED',
        trigger_config: { sub_status_id: subStatusId },
        ...overrides,
      });

    it('enrolls the workflow whose trigger_config.sub_status_id matches the occurrence', async () => {
      mockPrisma.workflow.findMany.mockResolvedValueOnce([subStatusWorkflow('sub-a')]);
      mockPrisma.workflowEnrollment.findUnique.mockResolvedValueOnce(
        enrollmentRow({ dedupe_key: `JOB_SUB_STATUS_ENTERED:${JOB_ID}:sub-a`, occurrence_key: 'sub-a' }),
      );
      await enrollOnEvent(
        { type: 'JOB_SUB_STATUS_ENTERED', organizationId: ORG, entity: { type: 'job', id: JOB_ID }, occurrenceKey: 'sub-a' },
        NOW,
      );
      expect(mockPrisma.workflowEnrollment.create).toHaveBeenCalledTimes(1);
    });

    it('skips a workflow whose trigger_config.sub_status_id does not match the occurrence', async () => {
      mockPrisma.workflow.findMany.mockResolvedValueOnce([subStatusWorkflow('sub-b')]);
      await enrollOnEvent(
        { type: 'JOB_SUB_STATUS_ENTERED', organizationId: ORG, entity: { type: 'job', id: JOB_ID }, occurrenceKey: 'sub-a' },
        NOW,
      );
      expect(mockPrisma.workflowEnrollment.create).not.toHaveBeenCalled();
    });

    it('two workflows watching different sub-statuses: only the matching one enrolls', async () => {
      mockPrisma.workflow.findMany.mockResolvedValueOnce([subStatusWorkflow('sub-a'), subStatusWorkflow('sub-b')]);
      mockPrisma.workflowEnrollment.findUnique.mockResolvedValueOnce(
        enrollmentRow({ dedupe_key: `JOB_SUB_STATUS_ENTERED:${JOB_ID}:sub-a`, occurrence_key: 'sub-a' }),
      );
      await enrollOnEvent(
        { type: 'JOB_SUB_STATUS_ENTERED', organizationId: ORG, entity: { type: 'job', id: JOB_ID }, occurrenceKey: 'sub-a' },
        NOW,
      );
      expect(mockPrisma.workflowEnrollment.create).toHaveBeenCalledTimes(1);
      expect(mockPrisma.workflowEnrollment.create.mock.calls[0][0].data.workflow_id).toBe('wf-sub-a');
    });
  });
});

// ── createEnrollment (point 3) ────────────────────────────────────────────────
describe('createEnrollment', () => {
  it('writes the enrollment with dedupe key + occurrence and returns its id', async () => {
    mockPrisma.workflowEnrollment.create.mockResolvedValueOnce({ id: ENR_ID });
    const res = await createEnrollment({
      workflow: { id: WF_ID, published_version_id: VER_ID, trigger_type: 'TECH_ASSIGNED', organization_id: ORG },
      entity: { type: 'job', id: JOB_ID, label: 'J00042' },
      occurrenceKey: 'tech-1',
      now: NOW,
    });
    expect(res).toEqual({ id: ENR_ID });
    const data = mockPrisma.workflowEnrollment.create.mock.calls[0][0].data;
    expect(data).toMatchObject({
      workflow_id: WF_ID,
      workflow_version_id: VER_ID,
      status: 'ACTIVE',
      entity_type: 'job',
      entity_id: JOB_ID,
      occurrence_key: 'tech-1',
      dedupe_key: `TECH_ASSIGNED:${JOB_ID}:tech-1`,
      step_cursor: 0,
      organization_id: ORG,
    });
    expect(data.resume_at.getTime()).toBe(NOW.getTime());
  });

  it('cross-engine cutover guard: a folded workflow defers to an existing legacy run with the same dedupe key', async () => {
    mockPrisma.automationRun.findUnique.mockResolvedValueOnce({ id: 'legacy-run-1' });
    const res = await createEnrollment({
      workflow: { id: WF_ID, published_version_id: VER_ID, trigger_type: 'JOB_SCHEDULED', organization_id: ORG, legacy_rule_id: 'rule-9' },
      entity: { type: 'job', id: JOB_ID },
      now: NOW,
    });
    expect(res).toBeNull();
    expect(mockPrisma.automationRun.findUnique).toHaveBeenCalledWith({
      where: { rule_id_dedupe_key: { rule_id: 'rule-9', dedupe_key: `JOB_SCHEDULED:${JOB_ID}` } },
      select: { id: true },
    });
    expect(mockPrisma.workflowEnrollment.create).not.toHaveBeenCalled();
  });

  it('cross-engine cutover guard: no legacy run -> enrolls normally; non-folded workflows never even look', async () => {
    mockPrisma.workflowEnrollment.create.mockResolvedValue({ id: ENR_ID });
    const folded = await createEnrollment({
      workflow: { id: WF_ID, published_version_id: VER_ID, trigger_type: 'JOB_SCHEDULED', organization_id: ORG, legacy_rule_id: 'rule-9' },
      entity: { type: 'job', id: JOB_ID },
      now: NOW,
    });
    expect(folded).toEqual({ id: ENR_ID });
    mockPrisma.automationRun.findUnique.mockClear();
    const native = await createEnrollment({
      workflow: { id: WF_ID, published_version_id: VER_ID, trigger_type: 'JOB_SCHEDULED', organization_id: ORG, legacy_rule_id: null },
      entity: { type: 'job', id: JOB_ID },
      now: NOW,
    });
    expect(native).toEqual({ id: ENR_ID });
    expect(mockPrisma.automationRun.findUnique).not.toHaveBeenCalled();
  });

  it('returns null (no throw) on a P2002 dedupe collision — the idempotency guarantee', async () => {
    mockPrisma.workflowEnrollment.create.mockRejectedValueOnce({ code: 'P2002' });
    const res = await createEnrollment({
      workflow: { id: WF_ID, published_version_id: VER_ID, trigger_type: 'JOB_SCHEDULED', organization_id: ORG },
      entity: { type: 'job', id: JOB_ID },
      now: NOW,
    });
    expect(res).toBeNull();
  });

  it('returns null (no throw) when the occurrence key is missing for an occurrence-scoped trigger', async () => {
    const res = await createEnrollment({
      workflow: { id: WF_ID, published_version_id: VER_ID, trigger_type: 'TECH_ASSIGNED', organization_id: ORG },
      entity: { type: 'job', id: JOB_ID },
      now: NOW,
    });
    expect(res).toBeNull();
    expect(mockPrisma.workflowEnrollment.create).not.toHaveBeenCalled();
  });

  // The removed technician has to survive to whatever step actually sends —
  // possibly after a WAIT of days — so it's captured at ENROLLMENT time, not
  // re-derived later (they're off the crew by then).
  it('persists eventPayload onto the enrollment row as event_payload', async () => {
    const removed = { id: 'r1', email: 'removed@org.com', first_name: 'Priya', last_name: 'Nair' };
    mockPrisma.workflowEnrollment.create.mockResolvedValueOnce({ id: ENR_ID });
    await createEnrollment({
      workflow: { id: WF_ID, published_version_id: VER_ID, trigger_type: 'TECH_UNASSIGNED', organization_id: ORG },
      entity: { type: 'job', id: JOB_ID },
      occurrenceKey: 'r1',
      eventPayload: { recipient: removed },
      now: NOW,
    });
    const data = mockPrisma.workflowEnrollment.create.mock.calls[0][0].data;
    expect(data.event_payload).toEqual({ recipient: removed });
  });

  it('writes event_payload as null when no eventPayload is given (every existing trigger)', async () => {
    mockPrisma.workflowEnrollment.create.mockResolvedValueOnce({ id: ENR_ID });
    await createEnrollment({
      workflow: { id: WF_ID, published_version_id: VER_ID, trigger_type: 'JOB_SCHEDULED', organization_id: ORG },
      entity: { type: 'job', id: JOB_ID },
      now: NOW,
    });
    const data = mockPrisma.workflowEnrollment.create.mock.calls[0][0].data;
    expect(data.event_payload).toBeNull();
  });
});

// createEnrollment is the ONE choke point every enrollment path funnels through -
// enrollOnEvent's per-workflow loop AND cron.ts's date-anchored sweep both call it
// directly (see docstring). Gating here, rather than only in enrollOnEvent, is what
// makes the check survive a plan downgrade, a hand-built workflow, or any future
// dispatch site - see docs/adr/0001-gate-automation-engine-at-point-of-effect.md.
describe('createEnrollment - entitlement gate (#1069)', () => {
  it('a STARTER org (below automations\' PRO minimum) never enrolls - fails closed, no throw', async () => {
    mockPrisma.organization.findUnique.mockResolvedValueOnce({ ...ORG_ROW, plan: 'STARTER' });
    const res = await createEnrollment({
      workflow: { id: WF_ID, published_version_id: VER_ID, trigger_type: 'JOB_SCHEDULED', organization_id: ORG },
      entity: { type: 'job', id: JOB_ID },
      now: NOW,
    });
    expect(res).toBeNull();
    expect(mockPrisma.workflowEnrollment.create).not.toHaveBeenCalled();
  });

  it('a PRO org enrolls normally', async () => {
    mockPrisma.organization.findUnique.mockResolvedValueOnce({ ...ORG_ROW, plan: 'PRO' });
    mockPrisma.workflowEnrollment.create.mockResolvedValueOnce({ id: ENR_ID });
    const res = await createEnrollment({
      workflow: { id: WF_ID, published_version_id: VER_ID, trigger_type: 'JOB_SCHEDULED', organization_id: ORG },
      entity: { type: 'job', id: JOB_ID },
      now: NOW,
    });
    expect(res).toEqual({ id: ENR_ID });
  });

  it('a STARTER org with an explicit automations override still enrolls - the real entitlement resolver is used, not a hardcoded plan check', async () => {
    mockPrisma.organization.findUnique.mockResolvedValueOnce({
      ...ORG_ROW,
      plan: 'STARTER',
      feature_overrides: { automations: true },
    });
    mockPrisma.workflowEnrollment.create.mockResolvedValueOnce({ id: ENR_ID });
    const res = await createEnrollment({
      workflow: { id: WF_ID, published_version_id: VER_ID, trigger_type: 'JOB_SCHEDULED', organization_id: ORG },
      entity: { type: 'job', id: JOB_ID },
      now: NOW,
    });
    expect(res).toEqual({ id: ENR_ID });
  });

  it('downgrade case: a PRO org whose override explicitly revokes automations never enrolls, even for a hand-built workflow', async () => {
    mockPrisma.organization.findUnique.mockResolvedValueOnce({
      ...ORG_ROW,
      plan: 'PRO',
      feature_overrides: { automations: false },
    });
    const res = await createEnrollment({
      workflow: { id: WF_ID, published_version_id: VER_ID, trigger_type: 'JOB_SCHEDULED', organization_id: ORG },
      entity: { type: 'job', id: JOB_ID },
      now: NOW,
    });
    expect(res).toBeNull();
    expect(mockPrisma.workflowEnrollment.create).not.toHaveBeenCalled();
  });

  it('a missing organization row fails closed rather than throwing', async () => {
    mockPrisma.organization.findUnique.mockResolvedValueOnce(null);
    const res = await createEnrollment({
      workflow: { id: WF_ID, published_version_id: VER_ID, trigger_type: 'JOB_SCHEDULED', organization_id: ORG },
      entity: { type: 'job', id: JOB_ID },
      now: NOW,
    });
    expect(res).toBeNull();
    expect(mockPrisma.workflowEnrollment.create).not.toHaveBeenCalled();
  });

  it("cron.ts's direct createEnrollment call (the date-anchored sweep / timed poller path) is covered too - same function, same gate", async () => {
    // No enrollOnEvent involved here - this reproduces cron.ts's call shape exactly
    // (see services/automations/cron.ts) to prove the poller path isn't a gap.
    mockPrisma.organization.findUnique.mockResolvedValueOnce({ ...ORG_ROW, plan: 'STARTER' });
    const res = await createEnrollment({
      workflow: { id: WF_ID, published_version_id: VER_ID, trigger_type: 'JOB_DATE_ANCHORED', organization_id: ORG },
      entity: { type: 'job', id: JOB_ID },
      occurrenceKey: 'anchor-1',
      now: NOW,
    });
    expect(res).toBeNull();
    expect(mockPrisma.workflowEnrollment.create).not.toHaveBeenCalled();
  });
});

// ── advanceEnrollment (points 1-10) ───────────────────────────────────────────
describe('advanceEnrollment', () => {
  it('returns early when the enrollment is missing, not ACTIVE, or not yet due', async () => {
    mockPrisma.workflowEnrollment.findUnique.mockResolvedValueOnce(null);
    await advanceEnrollment(ENR_ID, NOW);

    mockPrisma.workflowEnrollment.findUnique.mockResolvedValueOnce(enrollmentRow({ status: 'COMPLETED' }));
    await advanceEnrollment(ENR_ID, NOW);

    mockPrisma.workflowEnrollment.findUnique.mockResolvedValueOnce(
      enrollmentRow({ resume_at: new Date(NOW.getTime() + 60_000) }),
    );
    await advanceEnrollment(ENR_ID, NOW);

    expect(mockPrisma.workflowStepRun.create).not.toHaveBeenCalled();
  });

  it('full walk [SEND_EMAIL]: claims, sends once, records SENT, bumps counters, CASes cursor, completes', async () => {
    mockPrisma.workflowEnrollment.findUnique.mockResolvedValueOnce(enrollmentRow());
    await advanceEnrollment(ENR_ID, NOW);

    // claim = the pessimistic FAILED provisional insert
    const claim = mockPrisma.workflowStepRun.create.mock.calls[0][0].data;
    expect(claim).toMatchObject({ enrollment_id: ENR_ID, step_index: 0, step_type: 'SEND_EMAIL', status: 'FAILED' });

    expect(mockExecute).toHaveBeenCalledTimes(1);
    // executor is fed a per-step id for the notification dedup key
    expect(mockExecute.mock.calls[0][0]).toMatchObject({ id: `${WF_ID}:0`, action_type: 'SEND_EMAIL' });

    // outcome update on the claimed row
    expect(mockPrisma.workflowStepRun.update.mock.calls[0][0]).toMatchObject({
      where: { id: 'run-1' },
      data: { status: 'SENT' },
    });
    // counter bump
    expect(mockPrisma.workflow.update.mock.calls[0][0].data.trigger_count).toEqual({ increment: 1 });
    // cursor CAS 0 -> 1
    expect(mockPrisma.workflowEnrollment.updateMany.mock.calls[0][0]).toMatchObject({
      where: { id: ENR_ID, step_cursor: 0, status: 'ACTIVE' },
      data: { step_cursor: 1 },
    });
    // completed
    expect(mockPrisma.workflowEnrollment.update.mock.calls[0][0].data).toMatchObject({
      status: 'COMPLETED',
      finished_reason: 'Completed all steps',
    });
  });

  // The enrollment's persisted event_payload must reach the executor on EVERY
  // step, not just the first — re-read fresh alongside the entity each time
  // (block 6), so it survives however many WAIT steps come before the send.
  it('threads the enrollment’s event_payload into the executor’s bundle (eventRecipient + merged mergeCtx)', async () => {
    const removed = { id: 'r1', email: 'removed@org.com', first_name: 'Priya', last_name: 'Nair' };
    mockPrisma.workflowEnrollment.findUnique.mockResolvedValueOnce(
      enrollmentRow({
        workflow: workflowRow({ trigger_type: 'TECH_UNASSIGNED' }),
        version: { definition: def([emailStep(0)], { trigger_type: 'TECH_UNASSIGNED' }) },
        event_payload: { recipient: removed, mergeFields: { 'event.note': 'left the crew' } },
      }),
    );
    await advanceEnrollment(ENR_ID, NOW);

    const bundle = mockExecute.mock.calls[0][1];
    expect(bundle.eventRecipient).toEqual(removed);
    expect(bundle.mergeCtx['event.note']).toBe('left the crew');
  });

  it('[WAIT(1d), SEND_TEXT]: WAIT records CONTINUED, parks resume_at at now+1d, sends nothing', async () => {
    mockPrisma.workflowEnrollment.findUnique.mockResolvedValueOnce(
      enrollmentRow({ version: { definition: def([waitStep(0, 1440), textStep(1)]) } }),
    );
    await advanceEnrollment(ENR_ID, NOW);

    expect(mockPrisma.workflowStepRun.update.mock.calls[0][0].data).toMatchObject({
      status: 'CONTINUED',
      detail: 'Waited 1 day',
    });
    const cas = mockPrisma.workflowEnrollment.updateMany.mock.calls[0][0];
    expect(cas.where).toMatchObject({ id: ENR_ID, step_cursor: 0 });
    expect(cas.data.step_cursor).toBe(1);
    expect(cas.data.resume_at.getTime()).toBe(NOW.getTime() + 1440 * 60_000);
    expect(mockExecute).not.toHaveBeenCalled(); // parked before any send
  });

  it('resumes after a park (cursor=1, due) and finishes the flow', async () => {
    mockPrisma.workflowEnrollment.findUnique.mockResolvedValueOnce(
      enrollmentRow({ step_cursor: 1, version: { definition: def([waitStep(0, 1440), textStep(1)]) } }),
    );
    await advanceEnrollment(ENR_ID, NOW);
    expect(mockPrisma.workflowStepRun.create.mock.calls[0][0].data.step_index).toBe(1);
    expect(mockExecute).toHaveBeenCalledTimes(1);
    expect(mockPrisma.workflowEnrollment.update.mock.calls[0][0].data.status).toBe('COMPLETED');
  });

  it('STOP_IF holds -> step-run STOPPED + enrollment STOPPED; later steps never run', async () => {
    mockPrisma.workflowEnrollment.findUnique.mockResolvedValueOnce(
      enrollmentRow({
        occurrence_key: '2026-07-14T13:00:00.000Z', // differs from job.scheduled_start -> "rescheduled"
        version: { definition: def([stopIfStep(0, 'job_rescheduled'), textStep(1)]) },
      }),
    );
    await advanceEnrollment(ENR_ID, NOW);
    expect(mockPrisma.workflowStepRun.update.mock.calls[0][0].data).toMatchObject({
      status: 'STOPPED',
      detail: 'Stopped — the job was rescheduled',
    });
    expect(mockPrisma.workflowEnrollment.update.mock.calls[0][0].data).toMatchObject({
      status: 'STOPPED',
      finished_reason: 'Stopped — the job was rescheduled',
    });
    expect(mockExecute).not.toHaveBeenCalled();
  });

  it("STOP_IF doesn't hold -> CONTINUED, next step runs in the same tick", async () => {
    mockPrisma.workflowEnrollment.findUnique.mockResolvedValueOnce(
      enrollmentRow({
        occurrence_key: '2026-07-15T13:00:00.000Z', // matches job.scheduled_start -> not rescheduled
        version: { definition: def([stopIfStep(0, 'job_rescheduled'), emailStep(1)]) },
      }),
    );
    await advanceEnrollment(ENR_ID, NOW);
    expect(mockPrisma.workflowStepRun.update.mock.calls[0][0].data).toMatchObject({
      status: 'CONTINUED',
      detail: 'Checked — kept going',
    });
    expect(mockExecute).toHaveBeenCalledTimes(1);
    expect(mockPrisma.workflowEnrollment.update.mock.calls[0][0].data.status).toBe('COMPLETED');
  });

  it('terminal staleness (cancelled job on JOB_SCHEDULED) -> STOPPED; no send', async () => {
    mockPrisma.job.findFirst.mockResolvedValueOnce({ ...JOB_ROW, status: 'CANCELLED' });
    mockPrisma.workflowEnrollment.findUnique.mockResolvedValueOnce(enrollmentRow());
    await advanceEnrollment(ENR_ID, NOW);
    expect(mockPrisma.workflowStepRun.update.mock.calls[0][0].data).toMatchObject({
      status: 'STOPPED',
      detail: 'Job was cancelled',
    });
    expect(mockPrisma.workflowEnrollment.update.mock.calls[0][0].data).toMatchObject({
      status: 'STOPPED',
      finished_reason: 'Job was cancelled',
    });
    expect(mockExecute).not.toHaveBeenCalled();
  });

  it('entity gone (job.findFirst -> null) -> STOPPED "no longer exists"', async () => {
    mockPrisma.job.findFirst.mockResolvedValueOnce(null);
    mockPrisma.workflowEnrollment.findUnique.mockResolvedValueOnce(enrollmentRow());
    await advanceEnrollment(ENR_ID, NOW);
    expect(mockPrisma.workflowStepRun.update.mock.calls[0][0].data).toMatchObject({ status: 'STOPPED' });
    expect(mockPrisma.workflowStepRun.update.mock.calls[0][0].data.detail).toMatch(/no longer exists/i);
    expect(mockPrisma.workflowEnrollment.update.mock.calls[0][0].data.finished_reason).toMatch(/no longer exists/i);
  });

  it('send-window deferral: BUSINESS_HOURS at 22:00 -> parks WITHOUT claiming, cursor unchanged', async () => {
    mockPrisma.workflowEnrollment.findUnique.mockResolvedValueOnce(
      enrollmentRow({ resume_at: LATE, version: { definition: def([textStep(0)], { send_window: 'BUSINESS_HOURS' }) } }),
    );
    await advanceEnrollment(ENR_ID, LATE);
    expect(mockPrisma.workflowStepRun.create).not.toHaveBeenCalled(); // no claim, no step-run row
    const park = mockPrisma.workflowEnrollment.updateMany.mock.calls[0][0];
    expect(park.where).toMatchObject({ id: ENR_ID, step_cursor: 0, status: 'ACTIVE' });
    expect(park.data.step_cursor).toBeUndefined(); // cursor unchanged
    expect(park.data.resume_at.toISOString()).toBe('2026-07-15T12:00:00.000Z'); // next 08:00 NY
    expect(mockExecute).not.toHaveBeenCalled();
  });

  it('claim race: workflowStepRun.create rejects P2002 -> return, no send, no CAS', async () => {
    mockPrisma.workflowStepRun.create.mockRejectedValueOnce({ code: 'P2002' });
    mockPrisma.workflowEnrollment.findUnique.mockResolvedValueOnce(enrollmentRow());
    await advanceEnrollment(ENR_ID, NOW);
    expect(mockExecute).not.toHaveBeenCalled();
    expect(mockPrisma.workflowEnrollment.updateMany).not.toHaveBeenCalled();
    expect(mockPrisma.workflowEnrollment.update).not.toHaveBeenCalled();
  });

  it('cursor CAS loses after a send (count 0) -> loop exits without advancing again', async () => {
    mockPrisma.workflowEnrollment.updateMany.mockResolvedValueOnce({ count: 0 });
    mockPrisma.workflowEnrollment.findUnique.mockResolvedValueOnce(
      enrollmentRow({ version: { definition: def([emailStep(0), emailStep(1)]) } }),
    );
    await advanceEnrollment(ENR_ID, NOW);
    expect(mockPrisma.workflowStepRun.create).toHaveBeenCalledTimes(1); // only step 0 claimed
    expect(mockExecute).toHaveBeenCalledTimes(1);
    expect(mockPrisma.workflowEnrollment.update).not.toHaveBeenCalled(); // never reached COMPLETED
  });

  it('transient skip: executeAction SKIPPED -> step-run SKIPPED, flow continues', async () => {
    mockExecute
      .mockResolvedValueOnce({ status: 'SKIPPED', detail: 'Customer has no email address on file' })
      .mockResolvedValueOnce({ status: 'SKIPPED', detail: 'Customer has no email address on file' });
    mockPrisma.workflowEnrollment.findUnique.mockResolvedValueOnce(
      enrollmentRow({ version: { definition: def([emailStep(0), emailStep(1)]) } }),
    );
    await advanceEnrollment(ENR_ID, NOW);
    expect(mockPrisma.workflowStepRun.update.mock.calls[0][0].data.status).toBe('SKIPPED');
    expect(mockPrisma.workflow.update).not.toHaveBeenCalled(); // no counter bump on skip
    expect(mockExecute).toHaveBeenCalledTimes(2); // continued to step 1
    expect(mockPrisma.workflowEnrollment.update.mock.calls[0][0].data.status).toBe('COMPLETED');
  });

  it('executeAction throws -> step-run FAILED with the message, flow continues, no throw', async () => {
    mockExecute.mockRejectedValueOnce(new Error('resend exploded'));
    mockPrisma.workflowEnrollment.findUnique.mockResolvedValueOnce(
      enrollmentRow({ version: { definition: def([emailStep(0), emailStep(1)]) } }),
    );
    await advanceEnrollment(ENR_ID, NOW);
    expect(mockPrisma.workflowStepRun.update.mock.calls[0][0].data).toMatchObject({
      status: 'FAILED',
      detail: 'resend exploded',
    });
    expect(mockExecute).toHaveBeenCalledTimes(2); // cursor CAS'd, step 1 still ran
    expect(mockPrisma.workflowEnrollment.update.mock.calls[0][0].data.status).toBe('COMPLETED');
  });

  it('TECH_ASSIGNED narrowing: occurrence tech no longer assigned -> SKIPPED, flow continues', async () => {
    mockPrisma.workflowEnrollment.findUnique.mockResolvedValueOnce(
      enrollmentRow({
        occurrence_key: 'tech-99', // not on the crew
        workflow: workflowRow({ trigger_type: 'TECH_ASSIGNED' }),
        version: { definition: def([notifyStep(0)], { trigger_type: 'TECH_ASSIGNED' }) },
      }),
    );
    await advanceEnrollment(ENR_ID, NOW);
    expect(mockPrisma.workflowStepRun.update.mock.calls[0][0].data).toMatchObject({
      status: 'SKIPPED',
      detail: 'Technician is no longer assigned to this job',
    });
    expect(mockExecute).not.toHaveBeenCalled();
    expect(mockPrisma.workflowEnrollment.update.mock.calls[0][0].data.status).toBe('COMPLETED'); // continued, not stopped
  });

  it('workflow disabled mid-flight -> STOPPED "Automation was turned off"', async () => {
    mockPrisma.workflowEnrollment.findUnique.mockResolvedValueOnce(
      enrollmentRow({ workflow: workflowRow({ is_enabled: false }) }),
    );
    await advanceEnrollment(ENR_ID, NOW);
    expect(mockPrisma.workflowStepRun.create).not.toHaveBeenCalled();
    expect(mockPrisma.workflowEnrollment.update.mock.calls[0][0].data).toMatchObject({
      status: 'STOPPED',
      finished_reason: 'Automation was turned off',
    });
    expect(mockExecute).not.toHaveBeenCalled();
  });

  it('an unexpected internal error is caught: no throw, and the GUARDED annotate can only touch a still-provisional claim', async () => {
    mockPrisma.job.findFirst.mockRejectedValueOnce(new Error('db exploded'));
    mockPrisma.workflowEnrollment.findUnique.mockResolvedValueOnce(enrollmentRow());
    await expect(advanceEnrollment(ENR_ID, NOW)).resolves.toBeUndefined();
    // The catch-all uses a guarded updateMany filtered to the provisional
    // sentinel — a row already resolved (e.g. SENT before the CAS threw) is
    // never clobbered; the recovery sweeper finishes those instead.
    expect(mockPrisma.workflowStepRun.updateMany.mock.calls[0][0]).toEqual({
      where: { id: 'run-1', status: 'FAILED', detail: 'Interrupted mid-step' },
      data: { detail: 'db exploded' },
    });
  });

  it('executes with the PINNED definition trigger, not the live workflow row — a mid-flight trigger edit cannot corrupt staleness', async () => {
    // Live row was edited to INVOICE_OVERDUE, but this enrollment is pinned to a
    // JOB_SCHEDULED definition. The cancelled job MUST stop the flow — judging
    // it as INVOICE_OVERDUE would find no invoice state and wrongly send.
    mockPrisma.job.findFirst.mockResolvedValueOnce({ ...JOB_ROW, status: 'CANCELLED' });
    mockPrisma.workflowEnrollment.findUnique.mockResolvedValueOnce(
      enrollmentRow({ workflow: workflowRow({ trigger_type: 'INVOICE_OVERDUE' }) }),
    );
    await advanceEnrollment(ENR_ID, NOW);
    expect(mockPrisma.workflowStepRun.update.mock.calls[0][0].data).toMatchObject({
      status: 'STOPPED',
      detail: 'Job was cancelled',
    });
    expect(mockExecute).not.toHaveBeenCalled();
  });

  // ── direction wiring (Task A5b) — terminalStale.test.ts proves the pure
  //    function is direction-aware; these two prove enrollment.ts actually
  //    EXTRACTS trigger_config.direction and threads it through call site 7
  //    correctly, using the SAME already-passed anchor for both, so a wiring
  //    mistake (e.g. always passing 'before', or never reading trigger_config)
  //    would fail one of this pair.
  describe('date-anchored trigger direction wiring', () => {
    const PAST_START = new Date('2026-07-14T10:00:00.000Z'); // before NOW (2026-07-14T15:00:00.000Z)

    it("JOB_DATE_ANCHORED direction:'before' stops once the anchor has already passed", async () => {
      mockPrisma.job.findFirst.mockResolvedValueOnce({ ...JOB_ROW, scheduled_start: PAST_START });
      mockPrisma.workflowEnrollment.findUnique.mockResolvedValueOnce(
        enrollmentRow({
          occurrence_key: PAST_START.toISOString(),
          workflow: workflowRow({ trigger_type: 'JOB_DATE_ANCHORED' }),
          version: {
            definition: def([emailStep(0)], {
              trigger_type: 'JOB_DATE_ANCHORED',
              trigger_config: { anchor: 'job.scheduled_start', direction: 'before', offset_minutes: 60 },
            }),
          },
        }),
      );
      await advanceEnrollment(ENR_ID, NOW);
      expect(mockPrisma.workflowStepRun.update.mock.calls[0][0].data).toMatchObject({
        status: 'STOPPED',
        detail: 'Job start time has already passed',
      });
      expect(mockExecute).not.toHaveBeenCalled();
    });

    it("JOB_DATE_ANCHORED direction:'after' does NOT stop on the SAME already-passed anchor", async () => {
      mockPrisma.job.findFirst.mockResolvedValueOnce({ ...JOB_ROW, scheduled_start: PAST_START });
      mockPrisma.workflowEnrollment.findUnique.mockResolvedValueOnce(
        enrollmentRow({
          occurrence_key: PAST_START.toISOString(),
          workflow: workflowRow({ trigger_type: 'JOB_DATE_ANCHORED' }),
          version: {
            definition: def([emailStep(0)], {
              trigger_type: 'JOB_DATE_ANCHORED',
              trigger_config: { anchor: 'job.scheduled_start', direction: 'after', offset_minutes: 60 },
            }),
          },
        }),
      );
      await advanceEnrollment(ENR_ID, NOW);
      expect(mockExecute).toHaveBeenCalledTimes(1);
      expect(mockPrisma.workflowEnrollment.update.mock.calls[0][0].data.status).toBe('COMPLETED');
    });
  });
});
