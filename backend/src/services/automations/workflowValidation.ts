/**
 * workflowValidation.ts — the validation authority for a multi-step workflow
 * definition.
 *
 * Per-step config shape (Zod, one schema per WorkflowStepType) plus the
 * cross-field invariants a rule needs to be engine-runnable: trigger timing,
 * recipient legality, merge-field legality, and stop-if legality. The multi-step successor to the retired
 * automation.controller.ts's `validateBundle` — same invariants, applied
 * per-step instead of to a single action. PURE — no prisma, no I/O. Consumed by the API controller (Phase 3)
 * to gate PATCH/publish, and by the engine (Task 6) for the WorkflowDefinition
 * type frozen into WorkflowVersion.definition.
 */

import { z } from 'zod';
import {
  AutomationTriggerType,
  AutomationActionType,
  AutomationSendWindow,
  WorkflowStepType,
} from '@prisma/client';
import { TRIGGERS, audiencesFor, type AutomationEntity } from './catalog';
import { type RecipientKey } from './recipients';
import { ANCHORS_FOR_ENTITY, type AnchorKey } from './anchors';

/** Stop-if conditions legal per trigger entity (lead has none in v1). */
export const STOP_IF_CONDITIONS: Record<'job' | 'estimate' | 'invoice' | 'lead', readonly string[]> = {
  invoice: ['invoice_paid', 'invoice_not_open'],
  estimate: ['estimate_answered', 'estimate_approved', 'estimate_declined'],
  job: ['job_cancelled', 'job_completed', 'job_rescheduled'],
  lead: [],
};

/** Plain-English labels for the builder UI + activity log. */
export const STOP_IF_LABELS: Record<string, string> = {
  invoice_paid: 'the invoice is paid',
  invoice_not_open: 'the invoice is no longer open',
  estimate_answered: 'the customer answered the estimate',
  estimate_approved: 'the estimate was approved',
  estimate_declined: 'the estimate was declined',
  job_cancelled: 'the job was cancelled',
  job_completed: 'the job was completed',
  job_rescheduled: 'the job was rescheduled',
};

/** Timed-trigger offset bound, minutes — 90 days. Same bound as the retired legacy ruleShape. */
const MAX_OFFSET_MINUTES = 60 * 24 * 90;

// ── per-step config schemas ─────────────────────────────────────────────────

export const waitRelativeConfigSchema = z
  .object({ mode: z.literal('relative'), duration_minutes: z.number().int().min(5).max(MAX_OFFSET_MINUTES) })
  .strict();

export const waitAnchoredConfigSchema = z
  .object({
    mode: z.literal('anchored'),
    anchor: z.enum(['job.scheduled_start', 'lead.walkthrough_scheduled_at']),
    direction: z.enum(['before', 'after']),
    offset_minutes: z.number().int().min(0).max(MAX_OFFSET_MINUTES),
  })
  .strict();

// Legacy relative configs have no `mode` key — default it so discriminatedUnion can route them,
// giving proper field-level error paths (invalid duration → path 'duration_minutes', not a path-less union error).
export const waitConfigSchema = z.preprocess(
  (val) => (val && typeof val === 'object' && !('mode' in (val as object)) ? { mode: 'relative', ...(val as object) } : val),
  z.discriminatedUnion('mode', [waitRelativeConfigSchema, waitAnchoredConfigSchema]),
);

// ── recipients[] multi-select (v2.1) ────────────────────────────────────────
// A messaging step now targets a SET of audiences. The element enum is the
// coarse structural gate — the precise trigger+action legality (audiencesFor,
// catalog.ts — the SAME function the builder's multi-select reads, so the two
// can never legalize different sets) is enforced in validateStep, mirroring
// how the schema stays broad and the cross-field checks stay in
// validateWorkflowDefinition. `custom` is a SEND_EMAIL-only audience, so it is
// absent from the NOTIFY_TEAM element enum; `removed_user` / `assigned_user`
// are legal here structurally for both but only actually offered by
// audiencesFor() on the two REMOVED / two ASSIGNED triggers respectively —
// everywhere else validateStep's legal-set check below is what rejects them.
const AUDIENCE_KEYS = [
  'customer',
  'assigned_team',
  'dispatcher',
  'salesperson',
  'creator',
  'all_admins',
  'all_dispatchers',
  'specific_user',
  'removed_user',
  'assigned_user',
] as const;
const emailRecipientKey = z.enum([...AUDIENCE_KEYS, 'custom']);
const teamRecipientKey = z.enum(AUDIENCE_KEYS);

/**
 * Legacy-singular normalization (back-compat is MANDATORY — stored configs from
 * before v2.1 carry `recipient`/`custom_email`/`user_id`):
 *   { recipient } → { recipients: [recipient] }
 *   { custom_email } → { custom_emails: [custom_email] }
 *   { user_id } → { user_ids: [user_id] }
 * The legacy `assigned_techs` key is folded to its canonical `assigned_team`
 * (same alias the audience resolver honors), so entity legality sees one key.
 * The singular keys are dropped so `.strict()` accepts the normalized object.
 */
function normalizeMessagingConfig(raw: unknown): unknown {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return raw;
  const v: Record<string, unknown> = { ...(raw as Record<string, unknown>) };
  if (!('recipients' in v) && 'recipient' in v) v.recipients = [v.recipient];
  if (!('custom_emails' in v) && 'custom_email' in v) v.custom_emails = [v.custom_email];
  if (!('user_ids' in v) && 'user_id' in v) v.user_ids = [v.user_id];
  delete v.recipient;
  delete v.custom_email;
  delete v.user_id;
  if (Array.isArray(v.recipients)) {
    v.recipients = v.recipients.map((r) => (r === 'assigned_techs' ? 'assigned_team' : r));
  }
  return v;
}

export const sendTextConfigSchema = z.preprocess(
  normalizeMessagingConfig,
  z
    .object({
      recipients: z.array(z.literal('customer')).min(1),
      body: z.string().min(1).max(320),
    })
    .strict(),
);

export const sendEmailConfigSchema = z.preprocess(
  normalizeMessagingConfig,
  z
    .object({
      recipients: z.array(emailRecipientKey).min(1),
      subject: z.string().min(1).max(200),
      body: z.string().min(1).max(5000),
      custom_emails: z.array(z.string().email()).optional(),
      user_ids: z.array(z.string().uuid()).optional(),
    })
    .strict(),
);

export const notifyTeamConfigSchema = z.preprocess(
  normalizeMessagingConfig,
  z
    .object({
      recipients: z.array(teamRecipientKey).min(1),
      body: z.string().min(1).max(5000),
      user_ids: z.array(z.string().uuid()).optional(),
    })
    .strict(),
);

export const stopIfConfigSchema = z
  .object({
    condition: z.string().min(1),
  })
  .strict();

const STEP_CONFIG_SCHEMAS: Record<WorkflowStepType, z.ZodTypeAny> = {
  WAIT: waitConfigSchema,
  SEND_TEXT: sendTextConfigSchema,
  SEND_EMAIL: sendEmailConfigSchema,
  NOTIFY_TEAM: notifyTeamConfigSchema,
  STOP_IF: stopIfConfigSchema,
};

/** WorkflowStepType → the AutomationActionType recipientsFor() expects (WAIT/STOP_IF have none). */
const STEP_ACTION_TYPE: Partial<Record<WorkflowStepType, AutomationActionType>> = {
  SEND_TEXT: 'SEND_SMS',
  SEND_EMAIL: 'SEND_EMAIL',
  NOTIFY_TEAM: 'NOTIFY_TEAM',
};

/** Shape shared by the three messaging step configs, once parsed. */
type MessagingConfig = {
  recipients: RecipientKey[];
  body: string;
  subject?: string;
  custom_emails?: string[];
  user_ids?: string[];
};

// ── trigger-level config schemas ────────────────────────────────────────────
// Date-anchored triggers (JOB/LEAD/INVOICE/ESTIMATE_DATE_ANCHORED) carry their
// timing as anchor + direction + offset instead of a bare offset — same shape
// as an anchored WAIT step's config, but the anchor enum spans all four
// entities (a WAIT step's anchor is narrower — only the two mid-workflow
// entities job/lead currently support an anchored wait).

export interface DateAnchorTriggerConfig {
  anchor: AnchorKey;
  direction: 'before' | 'after';
  offset_minutes: number;
}

export const dateAnchorTriggerConfigSchema = z
  .object({
    anchor: z.enum([
      'job.scheduled_start',
      'lead.walkthrough_scheduled_at',
      'invoice.due_date',
      'estimate.valid_until',
    ]),
    direction: z.enum(['before', 'after']),
    offset_minutes: z.number().int().min(0).max(MAX_OFFSET_MINUTES),
  })
  .strict();

/** Triggers whose timing is an anchor + direction + offset rather than a bare offset. */
const DATE_ANCHORED_TRIGGERS: ReadonlySet<AutomationTriggerType> = new Set([
  'JOB_DATE_ANCHORED',
  'LEAD_DATE_ANCHORED',
  'INVOICE_DATE_ANCHORED',
  'ESTIMATE_DATE_ANCHORED',
]);

// SRVW-113 — JOB_SUB_STATUS_ENTERED fires on the event itself (not time-based),
// but unlike every other event trigger it still needs a trigger_config: WHICH
// sub-status the workflow cares about. `sub_status_id` only resolves inside
// the publishing org, but that lookup is I/O — this module is pure, so the
// org-membership check happens at publish time in workflow.controller.ts,
// mirroring how specific_user's user_id is resolved there today.
export interface SubStatusTriggerConfig {
  sub_status_id: string;
}

export const subStatusTriggerConfigSchema = z
  .object({ sub_status_id: z.string().uuid() })
  .strict();

/** Triggers whose trigger_config is a bare sub_status_id rather than an offset. */
const SUB_STATUS_SCOPED_TRIGGERS: ReadonlySet<AutomationTriggerType> = new Set([
  'JOB_SUB_STATUS_ENTERED',
]);

// ── shapes ───────────────────────────────────────────────────────────────────

export interface WorkflowStepInput {
  position: number;
  step_type: WorkflowStepType;
  config: unknown;
}

/** The shape frozen into WorkflowVersion.definition (and what the engine executes). */
export interface WorkflowDefinition {
  trigger_type: AutomationTriggerType;
  trigger_config: { offset_minutes: number } | DateAnchorTriggerConfig | SubStatusTriggerConfig | null;
  send_window: AutomationSendWindow;
  steps: Array<{ position: number; step_type: WorkflowStepType; config: unknown }>;
}

export interface ValidationIssue {
  step_index: number; // -1 for workflow-level issues (trigger/offset/steps-shape)
  path: string; // e.g. 'config.body', 'trigger_config', 'steps'
  message: string; // plain-English, user-facing
}

/** Merge fields referenced in a piece of copy — same regex the legacy controller used. */
const MERGE_FIELD_RE = /\{\{([a-z_.]+)\}\}/g;
function mergeFieldsIn(text: string): string[] {
  return [...text.matchAll(MERGE_FIELD_RE)].map((m) => m[1]);
}

function isValidOffset(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 5 && value <= MAX_OFFSET_MINUTES;
}

/**
 * Triggers that fire on a PAST/terminal state of the anchor's entity (the job
 * or walkthrough is already done or cancelled). An anchored WAIT's target date
 * (anchorDate ± offset) is only meaningful when the anchor is plausibly in the
 * future — under one of these triggers it has already passed, so the wait would
 * resolve as immediately due and send a stale reminder. Scheduling/assignment
 * triggers (JOB_SCHEDULED/RESCHEDULED, TECH_ASSIGNED, WALKTHROUGH_SCHEDULED/
 * RESCHEDULED/PERFORMER_ASSIGNED, LEAD_*) are left out — their anchor is
 * plausibly future (or null, which Task 4b's park-then-stop already handles).
 */
const TERMINAL_TRIGGERS: ReadonlySet<AutomationTriggerType> = new Set([
  'JOB_COMPLETED',
  'JOB_CANCELLED',
  'WALKTHROUGH_COMPLETED',
  'WALKTHROUGH_CANCELLED',
]);

/** Full-definition validation. Returns [] when publishable. */
export function validateWorkflowDefinition(def: {
  trigger_type: AutomationTriggerType;
  trigger_config?: { offset_minutes: number } | DateAnchorTriggerConfig | SubStatusTriggerConfig | null;
  send_window?: AutomationSendWindow;
  steps: WorkflowStepInput[];
}): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const trigger = TRIGGERS[def.trigger_type];

  // 1 & 2 — trigger timing
  if (DATE_ANCHORED_TRIGGERS.has(def.trigger_type)) {
    const parsed = dateAnchorTriggerConfigSchema.safeParse(def.trigger_config);
    if (!parsed.success) {
      for (const issue of parsed.error.issues) {
        const field = issue.path.join('.');
        issues.push({
          step_index: -1,
          path: field ? `trigger_config.${field}` : 'trigger_config',
          message: issue.message,
        });
      }
    } else if (!ANCHORS_FOR_ENTITY[trigger.entity].includes(parsed.data.anchor)) {
      issues.push({
        step_index: -1,
        path: 'trigger_config.anchor',
        message: 'This timing anchor isn’t available for this trigger',
      });
    }
  } else if (trigger.timeBased) {
    if (!isValidOffset((def.trigger_config as { offset_minutes?: unknown } | null)?.offset_minutes)) {
      issues.push({
        step_index: -1,
        path: 'trigger_config',
        message: 'This trigger needs a timing offset (e.g. 24 hours before)',
      });
    }
  } else if (SUB_STATUS_SCOPED_TRIGGERS.has(def.trigger_type)) {
    const parsed = subStatusTriggerConfigSchema.safeParse(def.trigger_config);
    if (!parsed.success) {
      issues.push({
        step_index: -1,
        path: 'trigger_config.sub_status_id',
        message: 'Pick which sub-status should trigger this automation',
      });
    }
  } else if (def.trigger_config != null) {
    issues.push({
      step_index: -1,
      path: 'trigger_config',
      message: 'This trigger fires on the event itself — remove the timing offset',
    });
  }

  // 3 — steps must be non-empty
  if (def.steps.length === 0) {
    issues.push({ step_index: -1, path: 'steps', message: 'Add at least one step' });
    return issues; // nothing left to validate per-step
  }

  // 4 — positions must be exactly 0..n-1, in ascending array order
  const inOrder = def.steps.every((step, index) => step.position === index);
  if (!inOrder) {
    issues.push({ step_index: -1, path: 'steps', message: 'Steps are out of order — tidy up and try again' });
  }

  // 5-9 — per-step config + cross-field invariants
  def.steps.forEach((step, index) => {
    validateStep(step, index, def.trigger_type, trigger.entity, issues);
  });

  return issues;
}

function validateStep(
  step: WorkflowStepInput,
  index: number,
  triggerType: AutomationTriggerType,
  entity: AutomationEntity,
  issues: ValidationIssue[],
): void {
  const schema = STEP_CONFIG_SCHEMAS[step.step_type];
  const result = schema.safeParse(step.config);
  if (!result.success) {
    for (const issue of result.error.issues) {
      const field = issue.path.join('.');
      issues.push({
        step_index: index,
        path: field ? `config.${field}` : 'config',
        message: issue.message,
      });
    }
    return; // config didn't even parse — nothing typed left to check
  }

  // WAIT: bounds are fully covered by the schema parse above (rule 5); an
  // anchored wait additionally needs its anchor to belong to the trigger's
  // entity, and its trigger must NOT be terminal (rule 11 — a past/terminal
  // trigger's anchor has already happened, so the wait would fire immediately).
  if (step.step_type === 'WAIT') {
    const cfg = result.data as { mode?: string; anchor?: AnchorKey };
    if (cfg.mode === 'anchored' && cfg.anchor && !ANCHORS_FOR_ENTITY[entity].includes(cfg.anchor)) {
      issues.push({
        step_index: index,
        path: 'config.anchor',
        message: 'This timing anchor isn’t available for this trigger',
      });
    }
    if (cfg.mode === 'anchored' && TERMINAL_TRIGGERS.has(triggerType)) {
      issues.push({
        step_index: index,
        path: 'config.mode',
        message:
          'A ‘wait until before/after’ timer needs a trigger with an upcoming date — this trigger fires after the fact',
      });
    }
    return;
  }

  // 6-8 — messaging steps: recipient legality (every key in recipients[] must be
  // an audience audiencesFor(triggerType, actionType) actually offers — trigger-
  // scoped, not just entity-scoped, so a trigger-specific audience like
  // removed_user validates correctly), the custom/specific_user companion
  // fields (required-iff-selected, both directions), and merge-field legality.
  const actionType = STEP_ACTION_TYPE[step.step_type];
  if (actionType) {
    const cfg = result.data as MessagingConfig;

    const legal = new Set<string>(audiencesFor(triggerType, actionType).map((opt) => opt.key));
    for (const key of cfg.recipients) {
      // NOTIFY_TEAM is an in-app notification with no customer-facing surface
      // and no one-off address — customer/custom never resolve to anyone (see
      // executors.ts notifyTeamAction). Checked before the generic entity-
      // audience legality below, since `customer` IS a legal audience key for
      // the entity in general (just not for this action).
      if (step.step_type === 'NOTIFY_TEAM' && (key === 'customer' || key === 'custom')) {
        issues.push({
          step_index: index,
          path: 'config.recipients',
          message: 'Team notifications can’t be sent to the customer',
        });
        continue;
      }
      if (!legal.has(key)) {
        issues.push({
          step_index: index,
          path: 'config.recipients',
          message: `Recipient "${key}" is not available for this trigger`,
        });
      }
    }

    // specific_user ⇔ user_ids (both directions): a chosen person needs at least
    // one id, and stray ids without the specific-person audience are a mistake.
    const hasSpecificUser = cfg.recipients.includes('specific_user');
    const userIds = cfg.user_ids ?? [];
    if (hasSpecificUser && userIds.length === 0) {
      issues.push({ step_index: index, path: 'config.user_ids', message: 'Pick the team member to notify' });
    } else if (!hasSpecificUser && userIds.length > 0) {
      issues.push({
        step_index: index,
        path: 'config.user_ids',
        message: 'Add the specific-person recipient, or remove the chosen team member(s)',
      });
    }

    // custom ⇔ custom_emails (SEND_EMAIL only, both directions).
    if (step.step_type === 'SEND_EMAIL') {
      const hasCustom = cfg.recipients.includes('custom');
      const customEmails = cfg.custom_emails ?? [];
      if (hasCustom && customEmails.length === 0) {
        issues.push({ step_index: index, path: 'config.custom_emails', message: 'Enter the email address to send to' });
      } else if (!hasCustom && customEmails.length > 0) {
        issues.push({
          step_index: index,
          path: 'config.custom_emails',
          message: 'Add the custom-email recipient, or remove the extra address(es)',
        });
      }
    }

    // Mirrors validateBundle: every field referenced anywhere in the copy is
    // checked, and any miss is reported at config.body (parity with the
    // single-action validator this module mirrors).
    const allowedFields = new Set(TRIGGERS[triggerType].mergeFields);
    const used = [...mergeFieldsIn(cfg.body), ...mergeFieldsIn(cfg.subject ?? '')];
    for (const field of used) {
      if (!allowedFields.has(field)) {
        issues.push({
          step_index: index,
          path: 'config.body',
          message: `The field {{${field}}} isn't available for this trigger`,
        });
      }
    }
    return;
  }

  // 9 — stop-if condition must be legal for the trigger's entity
  if (step.step_type === 'STOP_IF') {
    const cfg = result.data as { condition: string };
    const legal = STOP_IF_CONDITIONS[entity];
    if (!legal.includes(cfg.condition)) {
      issues.push({
        step_index: index,
        path: 'config.condition',
        message: "This stop condition isn't available for this trigger",
      });
    }
  }
}
