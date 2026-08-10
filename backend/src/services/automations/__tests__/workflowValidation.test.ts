import { describe, it, expect } from 'vitest';
import {
  STOP_IF_CONDITIONS,
  STOP_IF_LABELS,
  waitConfigSchema,
  sendTextConfigSchema,
  sendEmailConfigSchema,
  notifyTeamConfigSchema,
  stopIfConfigSchema,
  subStatusTriggerConfigSchema,
  validateWorkflowDefinition,
  type WorkflowStepInput,
} from '../workflowValidation';

// ── step fixtures ────────────────────────────────────────────────────────────

const waitStep = (position: number, duration = 60): WorkflowStepInput => ({
  position,
  step_type: 'WAIT',
  config: { duration_minutes: duration },
});

const sendTextStep = (
  position: number,
  overrides: Partial<{ recipient: string; body: string }> = {},
): WorkflowStepInput => ({
  position,
  step_type: 'SEND_TEXT',
  config: { recipient: 'customer', body: 'Hi {{customer.first_name}}', ...overrides },
});

const sendEmailStep = (
  position: number,
  overrides: Partial<{ recipient: string; subject: string; body: string; custom_email: string }> = {},
): WorkflowStepInput => ({
  position,
  step_type: 'SEND_EMAIL',
  config: {
    recipient: 'customer',
    subject: 'Hello',
    body: 'Hi {{customer.first_name}}',
    ...overrides,
  },
});

const notifyTeamStep = (
  position: number,
  overrides: Partial<{ recipient: string; body: string; user_id: string }> = {},
): WorkflowStepInput => ({
  position,
  step_type: 'NOTIFY_TEAM',
  config: { recipient: 'all_admins', body: 'FYI', ...overrides },
});

const stopIfStep = (position: number, condition: string): WorkflowStepInput => ({
  position,
  step_type: 'STOP_IF',
  config: { condition },
});

// ── per-step config schemas ─────────────────────────────────────────────────

describe('waitConfigSchema', () => {
  it('rejects below the 5-minute floor', () => {
    expect(waitConfigSchema.safeParse({ duration_minutes: 4 }).success).toBe(false);
  });

  it('accepts the 5-minute floor', () => {
    expect(waitConfigSchema.safeParse({ duration_minutes: 5 }).success).toBe(true);
  });

  it('accepts the 129600-minute ceiling (90 days)', () => {
    expect(waitConfigSchema.safeParse({ duration_minutes: 129600 }).success).toBe(true);
  });

  it('rejects above the 129600-minute ceiling', () => {
    expect(waitConfigSchema.safeParse({ duration_minutes: 129601 }).success).toBe(false);
  });

  it('rejects non-integer durations', () => {
    expect(waitConfigSchema.safeParse({ duration_minutes: 60.5 }).success).toBe(false);
  });

  it('rejects unknown keys (strict)', () => {
    expect(waitConfigSchema.safeParse({ duration_minutes: 60, extra: true }).success).toBe(false);
  });
});

describe('sendTextConfigSchema', () => {
  it('accepts a valid customer text', () => {
    expect(sendTextConfigSchema.safeParse({ recipient: 'customer', body: 'Hi there' }).success).toBe(true);
  });

  it('rejects a non-customer recipient', () => {
    expect(sendTextConfigSchema.safeParse({ recipient: 'all_admins', body: 'Hi' }).success).toBe(false);
  });

  it('rejects a body over 320 characters', () => {
    expect(sendTextConfigSchema.safeParse({ recipient: 'customer', body: 'x'.repeat(321) }).success).toBe(false);
  });

  it('rejects an empty body', () => {
    expect(sendTextConfigSchema.safeParse({ recipient: 'customer', body: '' }).success).toBe(false);
  });
});

describe('sendEmailConfigSchema', () => {
  it('accepts a valid email config', () => {
    expect(
      sendEmailConfigSchema.safeParse({ recipient: 'customer', subject: 'Hi', body: 'Hello' }).success,
    ).toBe(true);
  });

  it('accepts custom recipient with a valid custom_email', () => {
    expect(
      sendEmailConfigSchema.safeParse({
        recipient: 'custom',
        subject: 'Hi',
        body: 'Hello',
        custom_email: 'a@b.com',
      }).success,
    ).toBe(true);
  });

  it('rejects a malformed custom_email', () => {
    expect(
      sendEmailConfigSchema.safeParse({
        recipient: 'custom',
        subject: 'Hi',
        body: 'Hello',
        custom_email: 'not-an-email',
      }).success,
    ).toBe(false);
  });

  it('rejects an empty subject', () => {
    expect(sendEmailConfigSchema.safeParse({ recipient: 'customer', subject: '', body: 'Hello' }).success).toBe(
      false,
    );
  });

  it('accepts a specific_user recipient (a team member is a valid email audience in v2.1)', () => {
    expect(
      sendEmailConfigSchema.safeParse({ recipient: 'specific_user', subject: 'Hi', body: 'Hello' }).success,
    ).toBe(true);
  });

  it('normalizes the legacy singular { recipient } into recipients: [recipient]', () => {
    const parsed = sendEmailConfigSchema.safeParse({ recipient: 'customer', subject: 'Hi', body: 'Hello' });
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data).toMatchObject({ recipients: ['customer'] });
  });

  it('accepts a recipients[] array shape directly', () => {
    expect(
      sendEmailConfigSchema.safeParse({
        recipients: ['customer', 'all_admins'],
        subject: 'Hi',
        body: 'Hello',
      }).success,
    ).toBe(true);
  });

  it('folds the legacy custom_email into custom_emails: [custom_email]', () => {
    const parsed = sendEmailConfigSchema.safeParse({
      recipient: 'custom',
      subject: 'Hi',
      body: 'Hello',
      custom_email: 'a@b.com',
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data).toMatchObject({ custom_emails: ['a@b.com'] });
  });
});

describe('notifyTeamConfigSchema', () => {
  it('accepts a valid notify-team config', () => {
    expect(notifyTeamConfigSchema.safeParse({ recipient: 'all_dispatchers', body: 'FYI' }).success).toBe(true);
  });

  it('accepts specific_user with a valid uuid', () => {
    expect(
      notifyTeamConfigSchema.safeParse({
        recipient: 'specific_user',
        body: 'FYI',
        user_id: 'aaaaaaaa-0000-0000-0000-000000000001',
      }).success,
    ).toBe(true);
  });

  it('rejects a custom recipient (custom email is a SEND_EMAIL-only audience)', () => {
    expect(notifyTeamConfigSchema.safeParse({ recipient: 'custom', body: 'FYI' }).success).toBe(false);
  });

  it('rejects a non-uuid user_id', () => {
    expect(
      notifyTeamConfigSchema.safeParse({ recipient: 'specific_user', body: 'FYI', user_id: 'not-a-uuid' }).success,
    ).toBe(false);
  });

  it('normalizes the legacy singular { user_id } into user_ids: [user_id]', () => {
    const parsed = notifyTeamConfigSchema.safeParse({
      recipient: 'specific_user',
      body: 'FYI',
      user_id: 'aaaaaaaa-0000-0000-0000-000000000001',
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data).toMatchObject({ user_ids: ['aaaaaaaa-0000-0000-0000-000000000001'] });
  });

  it('accepts multiple user_ids for a specific_user notify', () => {
    expect(
      notifyTeamConfigSchema.safeParse({
        recipients: ['specific_user'],
        body: 'FYI',
        user_ids: ['aaaaaaaa-0000-0000-0000-000000000001', 'bbbbbbbb-0000-0000-0000-000000000002'],
      }).success,
    ).toBe(true);
  });
});

describe('stopIfConfigSchema', () => {
  it('accepts any non-empty condition string (entity-legality is validateWorkflowDefinition\'s job)', () => {
    expect(stopIfConfigSchema.safeParse({ condition: 'job_cancelled' }).success).toBe(true);
  });

  it('rejects an empty condition', () => {
    expect(stopIfConfigSchema.safeParse({ condition: '' }).success).toBe(false);
  });
});

// ── STOP_IF_CONDITIONS / STOP_IF_LABELS ─────────────────────────────────────

describe('STOP_IF_CONDITIONS', () => {
  it('lists the legal conditions per entity, with lead empty', () => {
    expect(STOP_IF_CONDITIONS.invoice).toEqual(['invoice_paid', 'invoice_not_open']);
    expect(STOP_IF_CONDITIONS.estimate).toEqual(['estimate_answered', 'estimate_approved', 'estimate_declined']);
    expect(STOP_IF_CONDITIONS.job).toEqual(['job_cancelled', 'job_completed', 'job_rescheduled']);
    expect(STOP_IF_CONDITIONS.lead).toEqual([]);
  });
});

describe('STOP_IF_LABELS', () => {
  it('has a plain-English label for every condition across all entities', () => {
    const all = Object.values(STOP_IF_CONDITIONS).flat();
    for (const condition of all) {
      expect(STOP_IF_LABELS[condition]).toBeTruthy();
    }
  });

  it('matches the exact wording from the design', () => {
    expect(STOP_IF_LABELS.invoice_paid).toBe('the invoice is paid');
    expect(STOP_IF_LABELS.invoice_not_open).toBe('the invoice is no longer open');
    expect(STOP_IF_LABELS.estimate_answered).toBe('the customer answered the estimate');
    expect(STOP_IF_LABELS.estimate_approved).toBe('the estimate was approved');
    expect(STOP_IF_LABELS.estimate_declined).toBe('the estimate was declined');
    expect(STOP_IF_LABELS.job_cancelled).toBe('the job was cancelled');
    expect(STOP_IF_LABELS.job_completed).toBe('the job was completed');
    expect(STOP_IF_LABELS.job_rescheduled).toBe('the job was rescheduled');
  });
});

// ── validateWorkflowDefinition ───────────────────────────────────────────────

describe('validateWorkflowDefinition — happy path', () => {
  it('returns [] for a fully valid multi-step definition', () => {
    const issues = validateWorkflowDefinition({
      trigger_type: 'JOB_SCHEDULED',
      steps: [waitStep(0), sendEmailStep(1), stopIfStep(2, 'job_cancelled'), sendTextStep(3)],
    });
    expect(issues).toEqual([]);
  });
});

describe('validateWorkflowDefinition — rule 1: timed trigger requires offset', () => {
  it('flags a timed trigger with no trigger_config', () => {
    const issues = validateWorkflowDefinition({
      trigger_type: 'BEFORE_JOB_START',
      steps: [sendTextStep(0)],
    });
    expect(issues).toContainEqual({
      step_index: -1,
      path: 'trigger_config',
      message: 'This trigger needs a timing offset (e.g. 24 hours before)',
    });
  });

  it('flags a timed trigger whose offset is out of bounds', () => {
    const issues = validateWorkflowDefinition({
      trigger_type: 'BEFORE_JOB_START',
      trigger_config: { offset_minutes: 129601 },
      steps: [sendTextStep(0)],
    });
    expect(issues).toContainEqual({
      step_index: -1,
      path: 'trigger_config',
      message: 'This trigger needs a timing offset (e.g. 24 hours before)',
    });
  });

  it('passes a timed trigger with a valid offset', () => {
    const issues = validateWorkflowDefinition({
      trigger_type: 'BEFORE_JOB_START',
      trigger_config: { offset_minutes: 1440 },
      steps: [sendTextStep(0)],
    });
    expect(issues.filter((i) => i.path === 'trigger_config')).toEqual([]);
  });
});

describe('validateWorkflowDefinition — rule 2: event trigger rejects an offset', () => {
  it('flags an event trigger carrying a trigger_config', () => {
    const issues = validateWorkflowDefinition({
      trigger_type: 'JOB_SCHEDULED',
      trigger_config: { offset_minutes: 60 },
      steps: [sendTextStep(0)],
    });
    expect(issues).toContainEqual({
      step_index: -1,
      path: 'trigger_config',
      message: 'This trigger fires on the event itself — remove the timing offset',
    });
  });
});

describe('validateWorkflowDefinition — rule 3: steps must be non-empty', () => {
  it('flags an empty steps array', () => {
    const issues = validateWorkflowDefinition({ trigger_type: 'JOB_SCHEDULED', steps: [] });
    expect(issues).toEqual([{ step_index: -1, path: 'steps', message: 'Add at least one step' }]);
  });
});

describe('validateWorkflowDefinition — rule 4: positions must be 0..n-1 ascending', () => {
  it('flags a gap in positions', () => {
    const issues = validateWorkflowDefinition({
      trigger_type: 'JOB_SCHEDULED',
      steps: [sendTextStep(0), sendTextStep(2)],
    });
    expect(issues).toContainEqual({
      step_index: -1,
      path: 'steps',
      message: 'Steps are out of order — tidy up and try again',
    });
  });

  it('flags steps presented out of ascending order', () => {
    const issues = validateWorkflowDefinition({
      trigger_type: 'JOB_SCHEDULED',
      steps: [sendTextStep(1), sendTextStep(0)],
    });
    expect(issues).toContainEqual({
      step_index: -1,
      path: 'steps',
      message: 'Steps are out of order — tidy up and try again',
    });
  });

  it('passes contiguous ascending positions starting at 0', () => {
    const issues = validateWorkflowDefinition({
      trigger_type: 'JOB_SCHEDULED',
      steps: [sendTextStep(0), sendTextStep(1)],
    });
    expect(issues.filter((i) => i.message.includes('out of order'))).toEqual([]);
  });
});

describe('validateWorkflowDefinition — rule 5: per-step config must parse', () => {
  // waitConfigSchema routes through z.preprocess + z.discriminatedUnion('mode', …):
  // a no-`mode`-key config is defaulted to mode:'relative' before the union picks
  // a branch, so an invalid legacy WAIT config still reports a field-scoped
  // config.duration_minutes path instead of a path-less invalid_union issue.
  it('surfaces the zod message with a config.<field> path and the step array index', () => {
    const issues = validateWorkflowDefinition({
      trigger_type: 'JOB_SCHEDULED',
      steps: [sendTextStep(0), waitStep(1, 2)],
    });
    const issue = issues.find((i) => i.path.startsWith('config.duration_minutes'));
    expect(issue).toBeDefined();
    expect(issue?.step_index).toBe(1);
    expect(issue?.message.length).toBeGreaterThan(0);
  });
});

describe('validateWorkflowDefinition — rule 6: every recipient must be legal for the trigger entity', () => {
  it('flags a key not in the entity audience (dispatcher on a lead trigger)', () => {
    const issues = validateWorkflowDefinition({
      trigger_type: 'LEAD_CREATED',
      steps: [notifyTeamStep(0, { recipient: 'dispatcher' })],
    });
    expect(issues).toContainEqual({
      step_index: 0,
      path: 'config.recipients',
      message: 'Recipient "dispatcher" is not available for this trigger',
    });
  });

  it('allows assigned_team on a job trigger (the assigned crew)', () => {
    const issues = validateWorkflowDefinition({
      trigger_type: 'JOB_SCHEDULED',
      steps: [notifyTeamStep(0, { recipient: 'assigned_team' })],
    });
    expect(issues.filter((i) => i.path === 'config.recipients')).toEqual([]);
  });

  it('allows the walkthrough team (assigned_team) on a lead trigger', () => {
    const issues = validateWorkflowDefinition({
      trigger_type: 'LEAD_CREATED',
      steps: [notifyTeamStep(0, { recipient: 'assigned_team' })],
    });
    expect(issues.filter((i) => i.path === 'config.recipients')).toEqual([]);
  });

  it('folds the legacy assigned_techs alias to assigned_team (legal on a job)', () => {
    const issues = validateWorkflowDefinition({
      trigger_type: 'JOB_SCHEDULED',
      steps: [notifyTeamStep(0, { recipient: 'assigned_techs' })],
    });
    expect(issues.filter((i) => i.path === 'config.recipients')).toEqual([]);
  });

  // removed_user is trigger-specific (catalog.ts's REMOVED_RECIPIENT_TRIGGERS),
  // not entity-wide like every other audience — this is the case that forced
  // rule 6 off audiencesForEntity(entity) and onto the trigger-aware
  // audiencesFor(trigger, action) the catalog's own multi-select already uses,
  // so the builder and the validator can never legalize different sets.
  it('allows removed_user on TECH_UNASSIGNED but flags it on TECH_ASSIGNED (same entity, wrong trigger)', () => {
    const legal = validateWorkflowDefinition({
      trigger_type: 'TECH_UNASSIGNED',
      steps: [sendEmailStep(0, { recipient: 'removed_user' })],
    });
    expect(legal.filter((i) => i.path === 'config.recipients')).toEqual([]);

    const illegal = validateWorkflowDefinition({
      trigger_type: 'TECH_ASSIGNED',
      steps: [sendEmailStep(0, { recipient: 'removed_user' })],
    });
    expect(illegal).toContainEqual({
      step_index: 0,
      path: 'config.recipients',
      message: 'Recipient "removed_user" is not available for this trigger',
    });
  });

  it('allows removed_user on WALKTHROUGH_PERFORMER_REMOVED', () => {
    const issues = validateWorkflowDefinition({
      trigger_type: 'WALKTHROUGH_PERFORMER_REMOVED',
      steps: [notifyTeamStep(0, { recipient: 'removed_user' })],
    });
    expect(issues.filter((i) => i.path === 'config.recipients')).toEqual([]);
  });

  // Mirror of the removed_user case above, for the opposite direction: the
  // audience that must be "the one person just added", not the live crew.
  it('allows assigned_user on TECH_ASSIGNED but flags it on TECH_UNASSIGNED (same entity, wrong trigger)', () => {
    const legal = validateWorkflowDefinition({
      trigger_type: 'TECH_ASSIGNED',
      steps: [sendEmailStep(0, { recipient: 'assigned_user' })],
    });
    expect(legal.filter((i) => i.path === 'config.recipients')).toEqual([]);

    const illegal = validateWorkflowDefinition({
      trigger_type: 'TECH_UNASSIGNED',
      steps: [sendEmailStep(0, { recipient: 'assigned_user' })],
    });
    expect(illegal).toContainEqual({
      step_index: 0,
      path: 'config.recipients',
      message: 'Recipient "assigned_user" is not available for this trigger',
    });
  });

  it('allows assigned_user on WALKTHROUGH_PERFORMER_ASSIGNED', () => {
    const issues = validateWorkflowDefinition({
      trigger_type: 'WALKTHROUGH_PERFORMER_ASSIGNED',
      steps: [notifyTeamStep(0, { recipient: 'assigned_user' })],
    });
    expect(issues.filter((i) => i.path === 'config.recipients')).toEqual([]);
  });

  it('flags an illegal key inside a multi-key recipients[] array', () => {
    const issues = validateWorkflowDefinition({
      trigger_type: 'ESTIMATE_APPROVED',
      steps: [{ position: 0, step_type: 'NOTIFY_TEAM', config: { recipients: ['all_admins', 'dispatcher'], body: 'FYI' } }],
    });
    // dispatcher is not an estimate audience; all_admins is fine
    expect(issues).toContainEqual({
      step_index: 0,
      path: 'config.recipients',
      message: 'Recipient "dispatcher" is not available for this trigger',
    });
    expect(issues.filter((i) => i.message.includes('all_admins'))).toEqual([]);
  });

  it('allows custom only for SEND_EMAIL, never for NOTIFY_TEAM', () => {
    const emailOk = validateWorkflowDefinition({
      trigger_type: 'JOB_SCHEDULED',
      steps: [sendEmailStep(0, { recipient: 'custom', custom_email: 'a@b.com' })],
    });
    expect(emailOk.filter((i) => i.path === 'config.recipients')).toEqual([]);
  });
});

describe('validateWorkflowDefinition — rule 7: custom/specific_user companion fields', () => {
  it('requires custom_emails for a custom email recipient', () => {
    const issues = validateWorkflowDefinition({
      trigger_type: 'JOB_SCHEDULED',
      steps: [sendEmailStep(0, { recipient: 'custom' })],
    });
    expect(issues).toContainEqual({
      step_index: 0,
      path: 'config.custom_emails',
      message: 'Enter the email address to send to',
    });
  });

  it('requires user_ids for a specific_user notify-team recipient', () => {
    const issues = validateWorkflowDefinition({
      trigger_type: 'JOB_SCHEDULED',
      steps: [notifyTeamStep(0, { recipient: 'specific_user' })],
    });
    expect(issues).toContainEqual({
      step_index: 0,
      path: 'config.user_ids',
      message: 'Pick the team member to notify',
    });
  });

  it('flags user_ids present WITHOUT specific_user selected (iff, reverse direction)', () => {
    const issues = validateWorkflowDefinition({
      trigger_type: 'JOB_SCHEDULED',
      steps: [
        {
          position: 0,
          step_type: 'NOTIFY_TEAM',
          config: { recipients: ['all_admins'], body: 'FYI', user_ids: ['aaaaaaaa-0000-0000-0000-000000000001'] },
        },
      ],
    });
    expect(issues.some((i) => i.path === 'config.user_ids')).toBe(true);
  });

  it('flags custom_emails present WITHOUT custom selected (iff, reverse direction)', () => {
    const issues = validateWorkflowDefinition({
      trigger_type: 'JOB_SCHEDULED',
      steps: [
        {
          position: 0,
          step_type: 'SEND_EMAIL',
          config: { recipients: ['customer'], subject: 'Hi', body: 'Hello', custom_emails: ['a@b.com'] },
        },
      ],
    });
    expect(issues.some((i) => i.path === 'config.custom_emails')).toBe(true);
  });

  it('passes custom email with custom_emails present', () => {
    const issues = validateWorkflowDefinition({
      trigger_type: 'JOB_SCHEDULED',
      steps: [sendEmailStep(0, { recipient: 'custom', custom_email: 'a@b.com' })],
    });
    expect(issues).toEqual([]);
  });

  it('passes specific_user with user_ids present', () => {
    const issues = validateWorkflowDefinition({
      trigger_type: 'JOB_SCHEDULED',
      steps: [
        {
          position: 0,
          step_type: 'NOTIFY_TEAM',
          config: { recipients: ['specific_user'], body: 'FYI', user_ids: ['aaaaaaaa-0000-0000-0000-000000000001'] },
        },
      ],
    });
    expect(issues).toEqual([]);
  });

  it('legacy singular { recipient } still validates end-to-end (back-compat)', () => {
    const issues = validateWorkflowDefinition({
      trigger_type: 'JOB_SCHEDULED',
      steps: [{ position: 0, step_type: 'SEND_EMAIL', config: { recipient: 'customer', subject: 'Hi', body: 'Hello' } }],
    });
    expect(issues).toEqual([]);
  });
});

describe('validateWorkflowDefinition — rule 8: merge fields must be legal for the trigger', () => {
  it('flags an unavailable field used in the body', () => {
    const issues = validateWorkflowDefinition({
      trigger_type: 'JOB_SCHEDULED',
      steps: [sendTextStep(0, { body: 'Total: {{estimate.total}}' })],
    });
    expect(issues).toContainEqual({
      step_index: 0,
      path: 'config.body',
      message: "The field {{estimate.total}} isn't available for this trigger",
    });
  });

  it('flags an unavailable field used in the subject (email only)', () => {
    const issues = validateWorkflowDefinition({
      trigger_type: 'JOB_SCHEDULED',
      steps: [sendEmailStep(0, { subject: 'Re: {{invoice.number}}' })],
    });
    expect(issues).toContainEqual({
      step_index: 0,
      path: 'config.body',
      message: "The field {{invoice.number}} isn't available for this trigger",
    });
  });

  it('passes a field that IS available for the trigger', () => {
    const issues = validateWorkflowDefinition({
      trigger_type: 'JOB_SCHEDULED',
      steps: [sendTextStep(0, { body: 'Job {{job.number}} at {{job.scheduled_time}}' })],
    });
    expect(issues).toEqual([]);
  });
});

describe('validateWorkflowDefinition — rule 9: STOP_IF condition must be legal for the trigger entity', () => {
  it('flags any STOP_IF condition on a lead trigger (empty legal set)', () => {
    const issues = validateWorkflowDefinition({
      trigger_type: 'LEAD_CREATED',
      steps: [stopIfStep(0, 'job_cancelled')],
    });
    expect(issues).toContainEqual({
      step_index: 0,
      path: 'config.condition',
      message: "This stop condition isn't available for this trigger",
    });
  });

  it('flags a condition from the wrong entity (invoice condition on a job trigger)', () => {
    const issues = validateWorkflowDefinition({
      trigger_type: 'JOB_SCHEDULED',
      steps: [stopIfStep(0, 'invoice_paid')],
    });
    expect(issues).toContainEqual({
      step_index: 0,
      path: 'config.condition',
      message: "This stop condition isn't available for this trigger",
    });
  });

  it('passes a legal condition for the trigger entity', () => {
    const issues = validateWorkflowDefinition({
      trigger_type: 'JOB_SCHEDULED',
      steps: [stopIfStep(0, 'job_cancelled')],
    });
    expect(issues).toEqual([]);
  });
});

// ── rule 10: anchored WAIT — legacy relative still valid, anchor must match entity ──

describe('validateWorkflowDefinition — rule 10: anchored wait legality', () => {
  it('still accepts a legacy relative wait (no mode key)', () => {
    const issues = validateWorkflowDefinition({
      trigger_type: 'JOB_SCHEDULED', trigger_config: null, send_window: 'ANYTIME',
      steps: [{ position: 0, step_type: 'WAIT', config: { duration_minutes: 1440 } }],
    });
    expect(issues).toEqual([]);
  });
  it('accepts an anchored wait whose anchor matches the trigger entity', () => {
    const issues = validateWorkflowDefinition({
      trigger_type: 'JOB_SCHEDULED', trigger_config: null, send_window: 'ANYTIME',
      steps: [{ position: 0, step_type: 'WAIT', config: { mode: 'anchored', anchor: 'job.scheduled_start', direction: 'before', offset_minutes: 1440 } }],
    });
    expect(issues).toEqual([]);
  });
  it('rejects an anchor that does not belong to the trigger entity', () => {
    const issues = validateWorkflowDefinition({
      trigger_type: 'JOB_SCHEDULED', trigger_config: null, send_window: 'ANYTIME',
      steps: [{ position: 0, step_type: 'WAIT', config: { mode: 'anchored', anchor: 'lead.walkthrough_scheduled_at', direction: 'before', offset_minutes: 60 } }],
    });
    expect(issues.some((i) => i.path === 'config.anchor')).toBe(true);
  });
});

// ── rule 11: anchored WAIT — disallowed under a terminal (past-state) trigger ──

describe('validateWorkflowDefinition — rule 11: anchored wait disallowed under a terminal trigger', () => {
  it('flags an anchored wait whose trigger is WALKTHROUGH_COMPLETED (fires after the fact)', () => {
    const issues = validateWorkflowDefinition({
      trigger_type: 'WALKTHROUGH_COMPLETED', trigger_config: null, send_window: 'ANYTIME',
      steps: [{ position: 0, step_type: 'WAIT', config: { mode: 'anchored', anchor: 'lead.walkthrough_scheduled_at', direction: 'before', offset_minutes: 1440 } }],
    });
    expect(issues).toContainEqual({
      step_index: 0,
      path: 'config.mode',
      message: 'A ‘wait until before/after’ timer needs a trigger with an upcoming date — this trigger fires after the fact',
    });
  });

  it('flags an anchored wait whose trigger is WALKTHROUGH_CANCELLED', () => {
    const issues = validateWorkflowDefinition({
      trigger_type: 'WALKTHROUGH_CANCELLED', trigger_config: null, send_window: 'ANYTIME',
      steps: [{ position: 0, step_type: 'WAIT', config: { mode: 'anchored', anchor: 'lead.walkthrough_scheduled_at', direction: 'after', offset_minutes: 60 } }],
    });
    expect(issues.some((i) => i.path === 'config.mode')).toBe(true);
  });

  it('flags an anchored wait whose trigger is JOB_COMPLETED', () => {
    const issues = validateWorkflowDefinition({
      trigger_type: 'JOB_COMPLETED', trigger_config: null, send_window: 'ANYTIME',
      steps: [{ position: 0, step_type: 'WAIT', config: { mode: 'anchored', anchor: 'job.scheduled_start', direction: 'before', offset_minutes: 60 } }],
    });
    expect(issues.some((i) => i.path === 'config.mode')).toBe(true);
  });

  it('flags an anchored wait whose trigger is JOB_CANCELLED', () => {
    const issues = validateWorkflowDefinition({
      trigger_type: 'JOB_CANCELLED', trigger_config: null, send_window: 'ANYTIME',
      steps: [{ position: 0, step_type: 'WAIT', config: { mode: 'anchored', anchor: 'job.scheduled_start', direction: 'before', offset_minutes: 60 } }],
    });
    expect(issues.some((i) => i.path === 'config.mode')).toBe(true);
  });

  it('allows an anchored wait whose trigger is WALKTHROUGH_SCHEDULED (an upcoming date)', () => {
    const issues = validateWorkflowDefinition({
      trigger_type: 'WALKTHROUGH_SCHEDULED', trigger_config: null, send_window: 'ANYTIME',
      steps: [{ position: 0, step_type: 'WAIT', config: { mode: 'anchored', anchor: 'lead.walkthrough_scheduled_at', direction: 'before', offset_minutes: 1440 } }],
    });
    expect(issues).toEqual([]);
  });

  it('still accepts a legacy relative wait under a terminal trigger (only anchored waits are timing-sensitive)', () => {
    const issues = validateWorkflowDefinition({
      trigger_type: 'JOB_COMPLETED', trigger_config: null, send_window: 'ANYTIME',
      steps: [{ position: 0, step_type: 'WAIT', config: { duration_minutes: 60 } }],
    });
    expect(issues).toEqual([]);
  });
});

// ── rule 12: NOTIFY_TEAM channel-narrows recipients (no customer/custom) ──────

describe('validateWorkflowDefinition — rule 12: NOTIFY_TEAM channel-narrows recipients', () => {
  it("flags a NOTIFY_TEAM step with recipients: ['customer']", () => {
    const issues = validateWorkflowDefinition({
      trigger_type: 'JOB_SCHEDULED',
      steps: [notifyTeamStep(0, { recipient: 'customer' })],
    });
    expect(issues).toContainEqual({
      step_index: 0,
      path: 'config.recipients',
      message: 'Team notifications can’t be sent to the customer',
    });
  });

  it("allows a NOTIFY_TEAM step with recipients: ['all_dispatchers']", () => {
    const issues = validateWorkflowDefinition({
      trigger_type: 'JOB_SCHEDULED',
      steps: [notifyTeamStep(0, { recipient: 'all_dispatchers' })],
    });
    expect(issues.filter((i) => i.path === 'config.recipients')).toEqual([]);
  });
});

// ── date-anchored triggers (JOB/LEAD/INVOICE/ESTIMATE_DATE_ANCHORED) ────────

const emailStep = {
  position: 0,
  step_type: 'SEND_EMAIL' as const,
  config: { recipients: ['customer'], subject: 'Reminder', body: 'Your invoice is due soon.' },
};

describe('validateWorkflowDefinition — date-anchored triggers', () => {
  it('accepts a valid invoice due-date reminder', () => {
    const issues = validateWorkflowDefinition({
      trigger_type: 'INVOICE_DATE_ANCHORED',
      trigger_config: { anchor: 'invoice.due_date', direction: 'before', offset_minutes: 1440 },
      steps: [emailStep],
    });
    expect(issues).toEqual([]);
  });

  it('rejects an anchor that does not belong to the trigger entity', () => {
    const issues = validateWorkflowDefinition({
      trigger_type: 'INVOICE_DATE_ANCHORED',
      trigger_config: { anchor: 'job.scheduled_start', direction: 'before', offset_minutes: 1440 },
      steps: [emailStep],
    });
    expect(issues).toContainEqual({
      step_index: -1,
      path: 'trigger_config.anchor',
      message: 'This timing anchor isn’t available for this trigger',
    });
  });

  it('rejects a missing trigger_config on a date-anchored trigger', () => {
    const issues = validateWorkflowDefinition({
      trigger_type: 'INVOICE_DATE_ANCHORED',
      trigger_config: null,
      steps: [emailStep],
    });
    expect(issues.some((i) => i.path === 'trigger_config')).toBe(true);
  });

  it('rejects a negative or over-bound offset', () => {
    const tooBig = validateWorkflowDefinition({
      trigger_type: 'JOB_DATE_ANCHORED',
      trigger_config: { anchor: 'job.scheduled_start', direction: 'after', offset_minutes: 60 * 24 * 91 },
      steps: [emailStep],
    });
    expect(tooBig.some((i) => i.path.startsWith('trigger_config'))).toBe(true);
  });

  it('still rejects an offset on a plain event trigger', () => {
    const issues = validateWorkflowDefinition({
      trigger_type: 'JOB_COMPLETED',
      trigger_config: { offset_minutes: 1440 },
      steps: [emailStep],
    });
    expect(issues).toContainEqual({
      step_index: -1,
      path: 'trigger_config',
      message: 'This trigger fires on the event itself — remove the timing offset',
    });
  });
});

// ── SRVW-113: JOB_SUB_STATUS_ENTERED ────────────────────────────────────────

describe('subStatusTriggerConfigSchema', () => {
  const SUB_STATUS_ID = '00000000-0000-0000-0000-0000000000d1';

  it('accepts a bare sub_status_id', () => {
    expect(subStatusTriggerConfigSchema.safeParse({ sub_status_id: SUB_STATUS_ID }).success).toBe(true);
  });

  it('rejects a non-uuid sub_status_id', () => {
    expect(subStatusTriggerConfigSchema.safeParse({ sub_status_id: 'not-a-uuid' }).success).toBe(false);
  });

  it('rejects a missing sub_status_id', () => {
    expect(subStatusTriggerConfigSchema.safeParse({}).success).toBe(false);
  });

  it('rejects unknown keys (strict)', () => {
    expect(
      subStatusTriggerConfigSchema.safeParse({ sub_status_id: SUB_STATUS_ID, extra: 'nope' }).success,
    ).toBe(false);
  });
});

describe('validateWorkflowDefinition — JOB_SUB_STATUS_ENTERED requires a sub_status_id', () => {
  const SUB_STATUS_ID = '00000000-0000-0000-0000-0000000000d1';

  it('accepts a valid sub_status_id', () => {
    const issues = validateWorkflowDefinition({
      trigger_type: 'JOB_SUB_STATUS_ENTERED',
      trigger_config: { sub_status_id: SUB_STATUS_ID },
      steps: [emailStep],
    });
    expect(issues).toEqual([]);
  });

  it('rejects a missing trigger_config — unlike a plain event trigger, this one needs the label picked', () => {
    const issues = validateWorkflowDefinition({
      trigger_type: 'JOB_SUB_STATUS_ENTERED',
      trigger_config: null,
      steps: [emailStep],
    });
    expect(issues).toContainEqual({
      step_index: -1,
      path: 'trigger_config.sub_status_id',
      message: 'Pick which sub-status should trigger this automation',
    });
  });

  it('rejects a non-uuid sub_status_id', () => {
    const issues = validateWorkflowDefinition({
      trigger_type: 'JOB_SUB_STATUS_ENTERED',
      trigger_config: { sub_status_id: 'not-a-uuid' },
      steps: [emailStep],
    });
    expect(issues.some((i) => i.path.startsWith('trigger_config'))).toBe(true);
  });

  it('the job.sub_status merge field is legal in copy for this trigger', () => {
    const issues = validateWorkflowDefinition({
      trigger_type: 'JOB_SUB_STATUS_ENTERED',
      trigger_config: { sub_status_id: SUB_STATUS_ID },
      steps: [
        {
          position: 0,
          step_type: 'SEND_EMAIL',
          config: { recipients: ['customer'], subject: 'Update', body: 'Now: {{job.sub_status}}' },
        },
      ],
    });
    expect(issues).toEqual([]);
  });
});
