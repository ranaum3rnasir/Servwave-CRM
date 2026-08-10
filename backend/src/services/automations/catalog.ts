/**
 * catalog.ts — single source of truth for the Automation Center's vocabulary.
 *
 * Everything the builder UI and the engine agree on lives here: trigger
 * definitions (incl. which merge fields each exposes), action definitions
 * (incl. which recipients each allows per trigger entity), merge-field labels
 * + sample values (client-side live preview), and the prebuilt template
 * gallery. Served verbatim by GET /api/workflows/catalog.
 *
 * Invariants are pinned by __tests__/catalog.test.ts — every enum member must
 * be described here, and every template must validate against its trigger.
 */

import {
  AutomationTriggerType,
  AutomationActionType,
  AutomationSendWindow,
  WorkflowStepType,
} from '@prisma/client';
import { audiencesForEntity, audienceLabel, type RecipientKey as AudienceKey } from './recipients';
import { ANCHORS_FOR_ENTITY, ANCHOR_LABELS, type AnchorKey } from './anchors';

export type AutomationEntity = 'job' | 'estimate' | 'invoice' | 'lead';

export type RecipientKey =
  | 'customer'
  | 'assigned_techs'
  | 'all_admins'
  | 'all_dispatchers'
  | 'specific_user'
  | 'custom';

// ── merge fields ──────────────────────────────────────────────────────────────

const ORG_FIELDS = ['org.name', 'org.phone'];
const CUSTOMER_FIELDS = ['customer.first_name', 'customer.last_name', 'customer.full_name'];
const JOB_FIELDS = [
  'job.number',
  'job.scheduled_date',
  'job.scheduled_time',
  'job.address',
  'job.type',
  'job.scope_notes',
  'technician.first_name',
  'technician.names',
];
const ESTIMATE_FIELDS = ['estimate.number', 'estimate.total', 'estimate.link'];
const INVOICE_FIELDS = ['invoice.number', 'invoice.total', 'invoice.due_date', 'invoice.link'];
const LEAD_FIELDS = ['lead.name', 'lead.number', 'lead.address'];
const WALKTHROUGH_FIELDS = ['lead.walkthrough_date', 'lead.walkthrough_time', 'lead.performer_names'];

// Who is actually reading this send — distinct from customer.first_name, which
// only names the record's customer. Every entity can target staff audiences
// (assigned crew, dispatcher, salesperson, creator, admins, a specific person),
// so this belongs in BASE rather than any one entity's field group.
const RECIPIENT_FIELDS = ['recipient.first_name'];

// Request-time text the triggering event captured (event_payload.mergeFields —
// context.ts), not a live column any entity load could re-derive. Legal only
// on the two cancellation triggers that have a reason to carry — appended to
// their mergeFields directly below, NOT folded into BASE.
const EVENT_REASON_FIELD = ['event.reason'];

// SRVW-113 — the sub-status label the job just entered. Legal only on
// JOB_SUB_STATUS_ENTERED (appended below, NOT folded into JOB_FIELDS): every
// other job trigger's entity load has no reliable sub-status to offer (a job
// can be re-scheduled, completed, etc. with no sub-status set at all).
const JOB_SUB_STATUS_FIELD = ['job.sub_status'];

const BASE = [...ORG_FIELDS, ...CUSTOMER_FIELDS, ...RECIPIENT_FIELDS];

export const MERGE_FIELD_LABELS: Record<string, string> = {
  'org.name': 'Company name',
  'org.phone': 'Company phone',
  'customer.first_name': 'Customer first name',
  'customer.last_name': 'Customer last name',
  'customer.full_name': 'Customer full name',
  'recipient.first_name': "This recipient's first name",
  'event.reason': 'The reason given',
  'job.sub_status': 'Sub-status the job just entered',
  'job.number': 'Job number',
  'job.scheduled_date': 'Job date',
  'job.scheduled_time': 'Job time',
  'job.address': 'Service address',
  'job.type': 'Job type',
  'job.scope_notes': 'Scope of work',
  'technician.first_name': 'Technician first name',
  'technician.names': 'Technician name(s)',
  'estimate.number': 'Estimate number',
  'estimate.total': 'Estimate total',
  'estimate.link': 'Estimate link',
  'invoice.number': 'Invoice number',
  'invoice.total': 'Invoice total',
  'invoice.due_date': 'Invoice due date',
  'invoice.link': 'Invoice link',
  'lead.name': 'Lead name',
  'lead.number': 'Lead number',
  'lead.address': 'Service address',
  'lead.walkthrough_date': 'Walkthrough date',
  'lead.walkthrough_time': 'Walkthrough time',
  'lead.performer_names': 'Walkthrough team',
};

/** Sample values used for live preview + test-sends. Kept realistic on purpose. */
export const SAMPLE_CONTEXT: Record<string, string> = {
  'org.name': 'Blue Ridge Plumbing',
  'org.phone': '(555) 204-7788',
  'customer.first_name': 'Sarah',
  'customer.last_name': 'Mitchell',
  'customer.full_name': 'Sarah Mitchell',
  'recipient.first_name': 'Mike',
  'event.reason': 'Customer requested reschedule',
  'job.sub_status': 'Waiting on parts',
  'job.number': 'J00042',
  'job.scheduled_date': 'Tue, Jul 14',
  'job.scheduled_time': '9:00 AM',
  'job.address': '18 Maple Ave, Richmond, VA',
  'job.type': 'Water heater replacement',
  'job.scope_notes': 'Replace 40gal water heater; shut-off is in the crawlspace',
  'technician.first_name': 'Mike',
  'technician.names': 'Mike Torres',
  'estimate.number': 'E00108',
  'estimate.total': '$2,450.00',
  'estimate.link': 'https://app.servwave.com/p/estimates/…',
  'invoice.number': 'I00073',
  'invoice.total': '$1,180.00',
  'invoice.due_date': 'Jul 20',
  'invoice.link': 'https://app.servwave.com/p/invoices/…',
  'lead.name': 'Sarah Mitchell — water heater',
  'lead.number': 'L00042',
  'lead.address': '88 Cedar Lane, Asheville, NC',
  'lead.walkthrough_date': 'Sat, Aug 1',
  'lead.walkthrough_time': '2:00 PM',
  'lead.performer_names': 'Mike Torres',
};

// ── triggers ──────────────────────────────────────────────────────────────────

export interface TriggerDef {
  label: string;
  description: string;
  category: 'events' | 'timed' | 'date';
  entity: AutomationEntity;
  timeBased: boolean;
  /** Sensible builder default, minutes. Only for timed triggers. */
  defaultOffsetMinutes?: number;
  /** Which {{merge.fields}} are valid in message copy for this trigger. */
  mergeFields: string[];
}

export const TRIGGERS: Record<AutomationTriggerType, TriggerDef> = {
  JOB_SCHEDULED: {
    label: 'Job is scheduled',
    description: 'Fires the first time a job gets a date on the calendar.',
    category: 'events', entity: 'job', timeBased: false,
    mergeFields: [...BASE, ...JOB_FIELDS],
  },
  JOB_RESCHEDULED: {
    label: 'Job is rescheduled',
    description: 'Fires whenever a scheduled job is moved to a new date or time.',
    category: 'events', entity: 'job', timeBased: false,
    mergeFields: [...BASE, ...JOB_FIELDS],
  },
  TECH_ASSIGNED: {
    label: 'Technician is assigned',
    description: 'Fires for each technician the moment they are added to a job.',
    category: 'events', entity: 'job', timeBased: false,
    mergeFields: [...BASE, ...JOB_FIELDS],
  },
  JOB_COMPLETED: {
    label: 'Job is completed',
    description: 'Fires when a job is marked complete.',
    category: 'events', entity: 'job', timeBased: false,
    mergeFields: [...BASE, ...JOB_FIELDS],
  },
  JOB_CANCELLED: {
    label: 'Job is cancelled',
    description: 'Fires when a job is cancelled.',
    category: 'events', entity: 'job', timeBased: false,
    mergeFields: [...BASE, ...JOB_FIELDS, ...EVENT_REASON_FIELD],
  },
  ESTIMATE_SENT: {
    label: 'Estimate is sent',
    description: 'Fires the first time an estimate is sent to the customer.',
    category: 'events', entity: 'estimate', timeBased: false,
    mergeFields: [...BASE, ...ESTIMATE_FIELDS],
  },
  ESTIMATE_APPROVED: {
    label: 'Estimate is approved',
    description: 'Fires when the customer approves an estimate (any approval path).',
    category: 'events', entity: 'estimate', timeBased: false,
    mergeFields: [...BASE, ...ESTIMATE_FIELDS],
  },
  ESTIMATE_DECLINED: {
    label: 'Estimate is declined',
    description: 'Fires when the customer declines an estimate.',
    category: 'events', entity: 'estimate', timeBased: false,
    mergeFields: [...BASE, ...ESTIMATE_FIELDS],
  },
  INVOICE_SENT: {
    label: 'Invoice is sent',
    description: 'Fires when an invoice is sent to the customer.',
    category: 'events', entity: 'invoice', timeBased: false,
    mergeFields: [...BASE, ...INVOICE_FIELDS],
  },
  INVOICE_PAID: {
    label: 'Invoice is paid',
    description: 'Fires when an invoice is paid in full.',
    category: 'events', entity: 'invoice', timeBased: false,
    mergeFields: [...BASE, ...INVOICE_FIELDS],
  },
  LEAD_CREATED: {
    label: 'Lead is created',
    description: 'Fires when a new lead is created.',
    category: 'events', entity: 'lead', timeBased: false,
    mergeFields: [...BASE, ...LEAD_FIELDS],
  },
  LEAD_ASSIGNED: {
    label: 'Lead is assigned',
    description: 'Fires when a lead is assigned to an owner.',
    category: 'events', entity: 'lead', timeBased: false,
    mergeFields: [...BASE, ...LEAD_FIELDS],
  },
  WALKTHROUGH_SCHEDULED: {
    label: 'Walkthrough is scheduled',
    description: 'Fires when a lead’s walkthrough is put on the calendar.',
    category: 'events', entity: 'lead', timeBased: false,
    mergeFields: [...BASE, ...LEAD_FIELDS, ...WALKTHROUGH_FIELDS],
  },
  WALKTHROUGH_RESCHEDULED: {
    label: 'Walkthrough is rescheduled',
    description: 'Fires whenever a scheduled walkthrough is moved to a new time.',
    category: 'events', entity: 'lead', timeBased: false,
    mergeFields: [...BASE, ...LEAD_FIELDS, ...WALKTHROUGH_FIELDS],
  },
  WALKTHROUGH_COMPLETED: {
    label: 'Walkthrough is completed',
    description: 'Fires when a walkthrough is marked complete.',
    category: 'events', entity: 'lead', timeBased: false,
    mergeFields: [...BASE, ...LEAD_FIELDS, ...WALKTHROUGH_FIELDS],
  },
  WALKTHROUGH_CANCELLED: {
    label: 'Walkthrough is cancelled',
    description: 'Fires when a scheduled walkthrough is cancelled.',
    category: 'events', entity: 'lead', timeBased: false,
    mergeFields: [...BASE, ...LEAD_FIELDS, ...WALKTHROUGH_FIELDS, ...EVENT_REASON_FIELD],
  },
  WALKTHROUGH_PERFORMER_ASSIGNED: {
    label: 'Walkthrough performer is assigned',
    description: 'Fires for each person added to perform a walkthrough.',
    category: 'events', entity: 'lead', timeBased: false,
    mergeFields: [...BASE, ...LEAD_FIELDS, ...WALKTHROUGH_FIELDS],
  },
  WALKTHROUGH_PERFORMER_REMOVED: {
    label: 'Walkthrough performer is removed',
    description: 'Fires for each person taken off a walkthrough.',
    category: 'events', entity: 'lead', timeBased: false,
    mergeFields: [...BASE, ...LEAD_FIELDS, ...WALKTHROUGH_FIELDS],
  },
  TECH_UNASSIGNED: {
    label: 'Technician is unassigned',
    description: 'Fires for each technician the moment they are taken off a job.',
    category: 'events', entity: 'job', timeBased: false,
    mergeFields: [...BASE, ...JOB_FIELDS],
  },
  JOB_EN_ROUTE: {
    label: 'Technician is marked en route',
    description: 'Fires the moment a technician is marked on the way to a job.',
    category: 'events', entity: 'job', timeBased: false,
    mergeFields: [...BASE, ...JOB_FIELDS],
  },
  JOB_SUB_STATUS_ENTERED: {
    label: 'Job enters a sub-status',
    description: 'Fires when a job is deliberately given a specific sub-status label (e.g. "Waiting on parts").',
    category: 'events', entity: 'job', timeBased: false,
    mergeFields: [...BASE, ...JOB_FIELDS, ...JOB_SUB_STATUS_FIELD],
  },
  BEFORE_JOB_START: {
    label: 'Before a job starts',
    description: 'Fires a set amount of time before the job’s scheduled start. Reschedules re-arm it automatically.',
    category: 'timed', entity: 'job', timeBased: true, defaultOffsetMinutes: 24 * 60,
    mergeFields: [...BASE, ...JOB_FIELDS],
  },
  AFTER_JOB_COMPLETED: {
    label: 'After a job is completed',
    description: 'Fires a set amount of time after the job was marked complete.',
    category: 'timed', entity: 'job', timeBased: true, defaultOffsetMinutes: 24 * 60,
    mergeFields: [...BASE, ...JOB_FIELDS],
  },
  INVOICE_OVERDUE: {
    label: 'Invoice is overdue',
    description: 'Fires a set amount of time after the due date if the invoice is still unpaid. Skips automatically once paid.',
    category: 'timed', entity: 'invoice', timeBased: true, defaultOffsetMinutes: 3 * 24 * 60,
    mergeFields: [...BASE, ...INVOICE_FIELDS],
  },
  ESTIMATE_FOLLOW_UP: {
    label: 'Estimate awaiting response',
    description: 'Fires a set amount of time after an estimate was sent if the customer hasn’t responded. Skips automatically once approved or declined.',
    category: 'timed', entity: 'estimate', timeBased: true, defaultOffsetMinutes: 3 * 24 * 60,
    mergeFields: [...BASE, ...ESTIMATE_FIELDS],
  },
  JOB_DATE_ANCHORED: {
    label: 'Before or after the appointment',
    description: 'Counts from the job’s scheduled time.',
    category: 'date', entity: 'job', timeBased: false,
    mergeFields: [...BASE, ...JOB_FIELDS],
  },
  LEAD_DATE_ANCHORED: {
    label: 'Before or after the walkthrough',
    description: 'Counts from the walkthrough’s scheduled time.',
    category: 'date', entity: 'lead', timeBased: false,
    mergeFields: [...BASE, ...LEAD_FIELDS, ...WALKTHROUGH_FIELDS],
  },
  INVOICE_DATE_ANCHORED: {
    label: 'Before or after the invoice due date',
    description: 'Counts from when payment is due.',
    category: 'date', entity: 'invoice', timeBased: false,
    mergeFields: [...BASE, ...INVOICE_FIELDS],
  },
  ESTIMATE_DATE_ANCHORED: {
    label: 'Before or after the estimate expiration',
    description: 'Counts from the day the estimate expires.',
    category: 'date', entity: 'estimate', timeBased: false,
    mergeFields: [...BASE, ...ESTIMATE_FIELDS],
  },
};

/**
 * Anchors advertised to the builder. Previously the frontend kept a hand-synced
 * copy of the anchor registry; serving it here (sourced from anchors.ts, Task
 * A1's module) removes that drift risk.
 */
export const ANCHOR_OPTIONS: Record<AutomationEntity, Array<{ key: AnchorKey; label: string }>> = {
  job: ANCHORS_FOR_ENTITY.job.map((key) => ({ key, label: ANCHOR_LABELS[key] })),
  lead: ANCHORS_FOR_ENTITY.lead.map((key) => ({ key, label: ANCHOR_LABELS[key] })),
  invoice: ANCHORS_FOR_ENTITY.invoice.map((key) => ({ key, label: ANCHOR_LABELS[key] })),
  estimate: ANCHORS_FOR_ENTITY.estimate.map((key) => ({ key, label: ANCHOR_LABELS[key] })),
};

// ── actions ───────────────────────────────────────────────────────────────────

export interface ActionDef {
  label: string;
  description: string;
  /** Recipient keys this action supports (before entity narrowing). */
  recipients: RecipientKey[];
  requiresSubject: boolean;
}

export const ACTIONS: Record<AutomationActionType, ActionDef> = {
  SEND_EMAIL: {
    label: 'Send an email',
    description: 'Delivered via your ServWave email with your company branding.',
    recipients: ['customer', 'assigned_techs', 'all_admins', 'all_dispatchers', 'custom'],
    requiresSubject: true,
  },
  SEND_SMS: {
    label: 'Send a text message',
    description: 'Recorded in the customer’s conversation thread. Delivery to their phone activates when an SMS provider is connected.',
    recipients: ['customer'],
    requiresSubject: false,
  },
  NOTIFY_TEAM: {
    label: 'Notify your team',
    description: 'In-app notification in the ServWave bell, delivered instantly.',
    recipients: ['assigned_techs', 'all_admins', 'all_dispatchers', 'specific_user'],
    requiresSubject: false,
  },
};

/** Recipients valid for a given trigger+action pair (assigned_techs needs a job). */
export function recipientsFor(
  trigger: AutomationTriggerType,
  action: AutomationActionType,
): RecipientKey[] {
  const base = ACTIONS[action].recipients;
  if (TRIGGERS[trigger].entity !== 'job') {
    return base.filter((r) => r !== 'assigned_techs');
  }
  return base;
}

// ── recipient audiences (v2.1 multi-select) ─────────────────────────────────
// The legal AUDIENCE for a trigger+action pair now comes from the audience
// resolver (recipients.ts), replacing the legacy RecipientKey/ACTIONS.recipients
// above as the multi-select's data source (that pair stays put, unchanged, for
// back-compat — see recipientsFor()). AudienceKey is a separate name from this
// file's own (legacy) RecipientKey so the two nine- vs six-member enums can't
// collide in the same module.
export type { AudienceKey };

export interface AudienceOption {
  key: AudienceKey;
  label: string;
  /** Plain-English copy for the audiences that aren't guaranteed to resolve to anyone (skipped, not blocked). */
  hint?: string;
}

/** Copy for the "not-guaranteed" audiences — Ran's decision: hint inline, never block authoring on these. */
function audienceHint(key: AudienceKey, entity: AutomationEntity): string | undefined {
  switch (key) {
    case 'salesperson':
      return 'Skipped if no salesperson is set.';
    case 'dispatcher':
      return 'Skipped if no dispatcher is set.';
    case 'creator':
      return 'Skipped if the record has no creator on file.';
    case 'assigned_team':
      return entity === 'lead' ? 'Skipped if no walkthrough team is assigned yet.' : 'Skipped if no one is assigned yet.';
    default:
      return undefined;
  }
}

/** The two triggers whose whole point is "someone was just taken off the record" — the only
 *  place `removed_user` means anything, since it resolves from the dispatching event, not the
 *  live entity (they're gone from it by the time the automation runs). */
const REMOVED_RECIPIENT_TRIGGERS: ReadonlySet<AutomationTriggerType> = new Set([
  'TECH_UNASSIGNED',
  'WALKTHROUGH_PERFORMER_REMOVED',
] satisfies AutomationTriggerType[]);

/** The mirror of REMOVED_RECIPIENT_TRIGGERS: the two triggers that fire once PER newly-added
 *  person. `assigned_team` resolves to the live full crew/team, which is the wrong audience here
 *  — it would re-notify everyone already on the record every time one more person joins. */
const ASSIGNED_RECIPIENT_TRIGGERS: ReadonlySet<AutomationTriggerType> = new Set([
  'TECH_ASSIGNED',
  'WALKTHROUGH_PERFORMER_ASSIGNED',
] satisfies AutomationTriggerType[]);

/**
 * Legal recipient audiences for one trigger+action pair — the multi-select's
 * data source. Starts from audiencesForEntity(trigger.entity), adds `removed_user`
 * for the two REMOVED triggers and `assigned_user` for the two ASSIGNED triggers
 * (both trigger-specific, not entity-wide — added here rather than in
 * audiencesForEntity since e.g. JOB_SCHEDULED/TECH_ASSIGNED share job's entity
 * but only one of them has an assigned person to offer), then channel-narrows:
 * SEND_SMS is customer-only (no SMS provider for team numbers yet — same
 * reason recipientsFor() narrows this way, and it drops removed_user/assigned_user
 * with everything else non-customer); NOTIFY_TEAM drops `customer` (in-app
 * notifications have no customer-facing surface — a customer audience always
 * resolves to zero users, see executors.ts notifyTeamAction); SEND_EMAIL adds
 * `custom` (a one-off address, not tied to any user/entity relationship).
 */
export function audiencesFor(trigger: AutomationTriggerType, action: AutomationActionType): AudienceOption[] {
  const entity = TRIGGERS[trigger].entity;
  let keys: AudienceKey[] = audiencesForEntity(entity);
  if (REMOVED_RECIPIENT_TRIGGERS.has(trigger)) {
    keys = [...keys, 'removed_user'];
  }
  if (ASSIGNED_RECIPIENT_TRIGGERS.has(trigger)) {
    keys = [...keys, 'assigned_user'];
  }
  if (action === 'SEND_SMS') {
    keys = keys.filter((k) => k === 'customer');
  } else if (action === 'NOTIFY_TEAM') {
    keys = keys.filter((k) => k !== 'customer');
  } else if (action === 'SEND_EMAIL') {
    keys = [...keys, 'custom'];
  }
  return keys.map((key) => {
    const label = audienceLabel(key, entity);
    const hint = audienceHint(key, entity);
    return hint ? { key, label, hint } : { key, label };
  });
}

// Derived from ACTIONS (not hardcoded) so a future AutomationActionType — which
// TypeScript already forces into the ACTIONS record above — is picked up here too.
const AUDIENCE_ACTION_TYPES = Object.keys(ACTIONS) as AutomationActionType[];

/** Every trigger × action's legal audiences — served verbatim by GET /api/workflows/catalog. */
export const AUDIENCES: Record<AutomationTriggerType, Record<AutomationActionType, AudienceOption[]>> = (() => {
  const result = {} as Record<AutomationTriggerType, Record<AutomationActionType, AudienceOption[]>>;
  for (const trigger of Object.keys(TRIGGERS) as AutomationTriggerType[]) {
    const byAction = {} as Record<AutomationActionType, AudienceOption[]>;
    for (const action of AUDIENCE_ACTION_TYPES) {
      byAction[action] = audiencesFor(trigger, action);
    }
    result[trigger] = byAction;
  }
  return result;
})();

// ── prebuilt templates ────────────────────────────────────────────────────────

export interface AutomationTemplate {
  key: string;
  name: string;
  description: string;
  category: 'customer' | 'team' | 'money';
  trigger_type: AutomationTriggerType;
  trigger_config?: { offset_minutes: number };
  action_type: AutomationActionType;
  action_config: {
    recipient: RecipientKey;
    subject?: string;
    body: string;
    custom_email?: string;
    user_id?: string;
  };
  /**
   * Optional full step sequence for multi-step recipes (e.g. an anchored WAIT
   * before a SEND_EMAIL). When present, `templateToWorkflowBody` (FE) uses it
   * verbatim instead of folding `action_type`/`action_config` into one step.
   * `action_type`/`action_config` still carry a representative single action
   * for category grouping and gallery-card display either way.
   */
  steps?: Array<{ step_type: WorkflowStepType; config: Record<string, unknown> }>;
  /**
   * Always `ANYTIME`. The per-automation send window was removed from the
   * builder together with the trigger-surface control: the timing builder now
   * states send time concretely ("2 days before the invoice due date"), so a
   * separate "…but only 8am–8pm" qualifier contradicted the sentence the UI
   * shows, with no control left anywhere to reveal or change it. Seven recipes
   * used to ship BUSINESS_HOURS; leaving them would have meant real deferral
   * behaviour that no screen could explain.
   *
   * Kept as a field (not deleted) because published WorkflowVersions froze it
   * and `enrollment.ts` still reads it for those rows. Reinstate quiet hours as
   * ONE org-level setting before SMS unlocks (#743) — a 2am email is harmless,
   * a 2am text is not.
   */
  send_window: AutomationSendWindow;
}

export const TEMPLATES: AutomationTemplate[] = [
  // ── Customer messages ──────────────────────────────────────────────────────
  {
    key: 'reminder-24h',
    name: '24-hour appointment reminder',
    description: 'Text the customer one day before their scheduled job. The single biggest no-show reducer.',
    category: 'customer',
    trigger_type: 'BEFORE_JOB_START',
    trigger_config: { offset_minutes: 24 * 60 },
    action_type: 'SEND_SMS',
    action_config: {
      recipient: 'customer',
      body: 'Hi {{customer.first_name}}, a reminder from {{org.name}}: {{technician.names}} is scheduled for {{job.scheduled_date}} at {{job.scheduled_time}} at {{job.address}}. Questions? Call us at {{org.phone}}.',
    },
    send_window: 'ANYTIME',
  },
  {
    key: 'reminder-1h',
    name: '1-hour heads-up',
    description: 'A short text shortly before the technician arrives.',
    category: 'customer',
    trigger_type: 'BEFORE_JOB_START',
    trigger_config: { offset_minutes: 60 },
    action_type: 'SEND_SMS',
    action_config: {
      recipient: 'customer',
      body: '{{org.name}} here — {{technician.names}} will arrive at {{job.address}} around {{job.scheduled_time}} today. See you soon!',
    },
    send_window: 'ANYTIME',
  },
  {
    key: 'job-scheduled-confirmation',
    name: 'Job scheduled confirmation',
    description: 'Email the customer as soon as their job gets a date on the calendar.',
    category: 'customer',
    trigger_type: 'JOB_SCHEDULED',
    action_type: 'SEND_EMAIL',
    action_config: {
      recipient: 'customer',
      subject: 'Your appointment with {{org.name}} is booked — {{job.scheduled_date}}',
      body: 'Hi {{customer.first_name}},\n\nYour appointment is confirmed:\n\nJob {{job.number}} — {{job.type}}\n{{job.scheduled_date}} at {{job.scheduled_time}}\n{{job.address}}\n\nIf you need to make changes, call us at {{org.phone}}.\n\nThank you,\n{{org.name}}',
    },
    send_window: 'ANYTIME',
  },
  {
    key: 'job-rescheduled-notice',
    name: 'Reschedule notice',
    description: 'Text the customer their new time whenever a job is moved. Most platforms forget this one.',
    category: 'customer',
    trigger_type: 'JOB_RESCHEDULED',
    action_type: 'SEND_SMS',
    action_config: {
      recipient: 'customer',
      body: 'Hi {{customer.first_name}}, your appointment with {{org.name}} has been moved to {{job.scheduled_date}} at {{job.scheduled_time}}. Questions? Call {{org.phone}}.',
    },
    send_window: 'ANYTIME',
  },
  {
    key: 'estimate-follow-up-3d',
    name: 'Estimate follow-up (3 days)',
    description: 'Nudge customers who haven’t responded to an estimate after 3 days. Stops automatically once they approve or decline.',
    category: 'customer',
    trigger_type: 'ESTIMATE_FOLLOW_UP',
    trigger_config: { offset_minutes: 3 * 24 * 60 },
    action_type: 'SEND_EMAIL',
    action_config: {
      recipient: 'customer',
      subject: 'Any questions about your estimate from {{org.name}}?',
      body: 'Hi {{customer.first_name}},\n\nJust checking in on estimate {{estimate.number}} for {{estimate.total}} — happy to answer any questions or adjust the scope.\n\nYou can review and approve it here: {{estimate.link}}\n\nThank you,\n{{org.name}} · {{org.phone}}',
    },
    send_window: 'ANYTIME',
  },
  {
    key: 'estimate-follow-up-7d',
    name: 'Estimate follow-up (7 days)',
    description: 'A second, final nudge one week after sending.',
    category: 'customer',
    trigger_type: 'ESTIMATE_FOLLOW_UP',
    trigger_config: { offset_minutes: 7 * 24 * 60 },
    action_type: 'SEND_EMAIL',
    action_config: {
      recipient: 'customer',
      subject: 'Still interested? Your {{org.name}} estimate is ready when you are',
      body: 'Hi {{customer.first_name}},\n\nYour estimate {{estimate.number}} ({{estimate.total}}) is still available — approve it online any time:\n{{estimate.link}}\n\nIf now isn’t the right time, just reply and let us know.\n\nThank you,\n{{org.name}}',
    },
    send_window: 'ANYTIME',
  },
  {
    key: 'review-request',
    name: 'Review request',
    description: 'Ask for a review the day after a job is completed, while the experience is fresh.',
    category: 'customer',
    trigger_type: 'AFTER_JOB_COMPLETED',
    trigger_config: { offset_minutes: 24 * 60 },
    action_type: 'SEND_SMS',
    action_config: {
      recipient: 'customer',
      body: 'Hi {{customer.first_name}}, thanks for choosing {{org.name}}! If {{technician.names}} did a great job, we’d really appreciate a quick review — it helps our small business a lot.',
    },
    send_window: 'ANYTIME',
  },
  {
    key: 'walkthrough-scheduled-confirmation',
    name: 'Walkthrough confirmation',
    description: 'Email the customer as soon as their walkthrough is booked.',
    category: 'customer',
    trigger_type: 'WALKTHROUGH_SCHEDULED',
    action_type: 'SEND_EMAIL',
    action_config: {
      recipient: 'customer',
      subject: 'Your walkthrough with {{org.name}} is booked — {{lead.walkthrough_date}}',
      body: 'Hi {{customer.first_name}},\n\nYour walkthrough is scheduled for {{lead.walkthrough_date}} at {{lead.walkthrough_time}}.\n\n{{lead.performer_names}} will be there. Questions? Call {{org.phone}}.\n\nThank you,\n{{org.name}}',
    },
    send_window: 'ANYTIME',
  },
  {
    key: 'walkthrough-reminder-1d',
    name: 'Walkthrough reminder (1 day before)',
    description: 'Email the customer a reminder the day before their walkthrough. Follows the walkthrough if it moves.',
    category: 'customer',
    trigger_type: 'WALKTHROUGH_SCHEDULED',
    action_type: 'SEND_EMAIL',
    action_config: {
      recipient: 'customer',
      subject: 'Reminder: your walkthrough with {{org.name}} is tomorrow',
      body: 'Hi {{customer.first_name}},\n\nReminder — your walkthrough is {{lead.walkthrough_date}} at {{lead.walkthrough_time}}. See you then!\n\n{{org.name}} · {{org.phone}}',
    },
    steps: [
      { step_type: 'WAIT', config: { mode: 'anchored', anchor: 'lead.walkthrough_scheduled_at', direction: 'before', offset_minutes: 1440 } },
      { step_type: 'SEND_EMAIL', config: { recipient: 'customer', subject: 'Reminder: your walkthrough with {{org.name}} is tomorrow', body: 'Hi {{customer.first_name}},\n\nReminder — your walkthrough is {{lead.walkthrough_date}} at {{lead.walkthrough_time}}. See you then!\n\n{{org.name}} · {{org.phone}}' } },
    ],
    send_window: 'ANYTIME',
  },
  // ── Getting paid ───────────────────────────────────────────────────────────
  {
    key: 'invoice-overdue-3d',
    name: 'Overdue invoice reminder',
    description: 'A friendly nudge 3 days past due. Skips automatically the moment the invoice is paid.',
    category: 'money',
    trigger_type: 'INVOICE_OVERDUE',
    trigger_config: { offset_minutes: 3 * 24 * 60 },
    action_type: 'SEND_EMAIL',
    action_config: {
      recipient: 'customer',
      subject: 'Friendly reminder: invoice {{invoice.number}} from {{org.name}}',
      body: 'Hi {{customer.first_name}},\n\nJust a friendly reminder that invoice {{invoice.number}} for {{invoice.total}} was due on {{invoice.due_date}}.\n\nYou can view and pay it online here: {{invoice.link}}\n\nAlready paid? Please disregard this note — and thank you!\n\n{{org.name}} · {{org.phone}}',
    },
    send_window: 'ANYTIME',
  },
  {
    key: 'payment-thank-you',
    name: 'Payment thank-you',
    description: 'Thank the customer automatically when an invoice is paid in full.',
    category: 'money',
    trigger_type: 'INVOICE_PAID',
    action_type: 'SEND_EMAIL',
    action_config: {
      recipient: 'customer',
      subject: 'Thank you from {{org.name}}!',
      body: 'Hi {{customer.first_name}},\n\nWe’ve received your payment for invoice {{invoice.number}} — thank you!\n\nIt was a pleasure working with you. If you ever need us again, we’re one call away: {{org.phone}}.\n\n{{org.name}}',
    },
    send_window: 'ANYTIME',
  },
  {
    key: 'invoice-paid-office',
    name: 'Payment received (office)',
    description: 'Ping dispatchers in-app the moment an invoice is paid.',
    category: 'money',
    trigger_type: 'INVOICE_PAID',
    action_type: 'NOTIFY_TEAM',
    action_config: {
      recipient: 'all_dispatchers',
      body: 'Invoice {{invoice.number}} ({{invoice.total}}) was just paid by {{customer.full_name}}.',
    },
    send_window: 'ANYTIME',
  },
  // ── Team alerts ────────────────────────────────────────────────────────────
  {
    key: 'tech-assignment-alert',
    name: 'Technician assignment alert',
    description: 'Alert a technician the instant they’re assigned to a job.',
    category: 'team',
    trigger_type: 'TECH_ASSIGNED',
    action_type: 'NOTIFY_TEAM',
    action_config: {
      recipient: 'assigned_techs',
      body: 'You’ve been assigned to job {{job.number}} ({{job.type}}) on {{job.scheduled_date}} at {{job.scheduled_time}} — {{job.address}}.',
    },
    send_window: 'ANYTIME',
  },
  {
    key: 'tech-day-before',
    name: 'Technician day-before reminder',
    description: 'Remind assigned technicians about tomorrow’s job.',
    category: 'team',
    trigger_type: 'BEFORE_JOB_START',
    trigger_config: { offset_minutes: 16 * 60 },
    action_type: 'NOTIFY_TEAM',
    action_config: {
      recipient: 'assigned_techs',
      body: 'Reminder: job {{job.number}} ({{job.type}}) starts {{job.scheduled_date}} at {{job.scheduled_time}} — {{job.address}}.',
    },
    send_window: 'ANYTIME',
  },
  {
    key: 'estimate-approved-office',
    name: 'Estimate approved (office)',
    description: 'Tell the office in-app the moment a customer approves an estimate.',
    category: 'team',
    trigger_type: 'ESTIMATE_APPROVED',
    action_type: 'NOTIFY_TEAM',
    action_config: {
      recipient: 'all_dispatchers',
      body: '{{customer.full_name}} approved estimate {{estimate.number}} ({{estimate.total}}). Time to get it scheduled!',
    },
    send_window: 'ANYTIME',
  },
  {
    key: 'new-lead-alert',
    name: 'New lead alert',
    description: 'Ping the office in-app whenever a new lead lands.',
    category: 'team',
    trigger_type: 'LEAD_CREATED',
    action_type: 'NOTIFY_TEAM',
    action_config: {
      recipient: 'all_dispatchers',
      body: 'New lead: {{lead.name}}. Reach out while it’s hot — speed-to-lead wins jobs.',
    },
    send_window: 'ANYTIME',
  },
];
