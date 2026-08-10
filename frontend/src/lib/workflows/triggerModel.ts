/**
 * triggerModel.ts — pure mapping between the two-mode trigger builder's UI
 * selection state (`TriggerSelection`: subject → event-or-date → the
 * mode-specific fields) and the wire shape the backend API expects
 * (`{ trigger_type, trigger_config }`).
 *
 * Zero React/DOM dependencies — plain TypeScript functions and types, unit
 * tested in isolation. Every later builder component (SubjectPicker,
 * ModeFork, EventModePanel, DateModePanel, TriggerReadback, and the
 * TriggerForm shell that composes them) reads/writes a `TriggerSelection`
 * and calls `selectionToTrigger`/`triggerToSelection` at the edges, so this
 * module is the builder's single source of truth for that conversion.
 *
 * Types below (`AutomationTriggerType`, `AnchorKey`, `TriggerConfig`,
 * `WorkflowCatalog`) are declared LOCALLY rather than imported from
 * `lib/api/workflows.ts`. That file's `AutomationTriggerType` union and
 * `WorkflowCatalog` shape have not been widened for the four new
 * `*_DATE_ANCHORED` triggers / the catalog's `anchors` field yet — that
 * widening is a separate task. The literal unions here are grounded directly
 * in the real backend shapes (`backend/src/services/automations/catalog.ts`
 * TRIGGERS, `anchors.ts` AnchorKey, `workflowValidation.ts`
 * DateAnchorTriggerConfig), so once the API types are widened to match, a
 * value from either source is structurally interchangeable with the other.
 * `WorkflowCatalog` here is intentionally minimal (only what this module
 * reads: each trigger's owning entity, and the legal anchor options per
 * entity) rather than the full served catalog shape.
 */

export type BuilderSubject = 'job' | 'estimate' | 'invoice' | 'lead';
export type BuilderMode = 'event' | 'date';

/** Mirrors backend/src/services/automations/anchors.ts's AnchorKey (Task A1). */
export type AnchorKey =
  | 'job.scheduled_start'
  | 'lead.walkthrough_scheduled_at'
  | 'invoice.due_date'
  | 'estimate.valid_until';

/** Mirrors the Prisma AutomationTriggerType enum (incl. the Part A additions). */
export type AutomationTriggerType =
  | 'JOB_SCHEDULED'
  | 'JOB_RESCHEDULED'
  | 'TECH_ASSIGNED'
  | 'JOB_COMPLETED'
  | 'JOB_CANCELLED'
  | 'ESTIMATE_SENT'
  | 'ESTIMATE_APPROVED'
  | 'ESTIMATE_DECLINED'
  | 'INVOICE_SENT'
  | 'INVOICE_PAID'
  | 'LEAD_CREATED'
  | 'LEAD_ASSIGNED'
  | 'WALKTHROUGH_SCHEDULED'
  | 'WALKTHROUGH_RESCHEDULED'
  | 'WALKTHROUGH_COMPLETED'
  | 'WALKTHROUGH_CANCELLED'
  | 'WALKTHROUGH_PERFORMER_ASSIGNED'
  | 'WALKTHROUGH_PERFORMER_REMOVED'
  | 'TECH_UNASSIGNED'
  | 'JOB_EN_ROUTE'
  | 'JOB_SUB_STATUS_ENTERED'
  | 'BEFORE_JOB_START'
  | 'AFTER_JOB_COMPLETED'
  | 'INVOICE_OVERDUE'
  | 'ESTIMATE_FOLLOW_UP'
  | 'JOB_DATE_ANCHORED'
  | 'LEAD_DATE_ANCHORED'
  | 'INVOICE_DATE_ANCHORED'
  | 'ESTIMATE_DATE_ANCHORED';

/** Mirrors backend/src/services/automations/workflowValidation.ts's DateAnchorTriggerConfig (Task A4). */
export interface DateAnchorTriggerConfig {
  anchor: AnchorKey;
  direction: 'before' | 'after';
  offset_minutes: number;
}

/** Mirrors backend/src/services/automations/workflowValidation.ts's SubStatusTriggerConfig (SRVW-113). */
export interface SubStatusTriggerConfig {
  sub_status_id: string;
}

/** A legacy timed trigger's (BEFORE_JOB_START etc.) bare-offset config, the anchored shape, or
 *  JOB_SUB_STATUS_ENTERED's bare sub_status_id. */
export type TriggerConfig = { offset_minutes: number } | DateAnchorTriggerConfig | SubStatusTriggerConfig;

export interface TriggerSelection {
  subject: BuilderSubject;
  mode: BuilderMode;
  eventTrigger?: AutomationTriggerType; // mode 'event'
  anchor?: AnchorKey; // mode 'date'
  direction?: 'before' | 'after'; // mode 'date'
  offsetMinutes?: number; // mode 'date'
  subStatusId?: string; // mode 'event', only when eventTrigger === 'JOB_SUB_STATUS_ENTERED'
}

/** The minimal catalog slice this module reads: entity per trigger, anchors per entity. */
export interface WorkflowCatalog {
  triggers: Partial<Record<AutomationTriggerType, { entity: BuilderSubject }>>;
  anchors: Partial<Record<BuilderSubject, Array<{ key: AnchorKey; label: string }>>>;
}

/** The one date-anchored trigger per subject (mirrors backend catalog.ts's per-entity DATE_ANCHORED defs). */
export const DATE_ANCHORED_BY_SUBJECT: Record<BuilderSubject, AutomationTriggerType> = {
  job: 'JOB_DATE_ANCHORED',
  estimate: 'ESTIMATE_DATE_ANCHORED',
  invoice: 'INVOICE_DATE_ANCHORED',
  lead: 'LEAD_DATE_ANCHORED',
};

/**
 * Builder selection → wire shape. Returns null (never throws, never returns a
 * partial/garbage trigger) whenever the fields the chosen mode requires
 * aren't all present yet — the natural "still filling out the form" state.
 * `offsetMinutes` is checked for `undefined` specifically (not falsiness) so
 * a legitimate 0-minute ("immediately") offset isn't mistaken for missing.
 *
 * Deliberately does NOT cross-check `anchor`/`eventTrigger` legality against
 * a catalog — this function takes no catalog argument, by design: the
 * builder UI (DateModePanel/EventModePanel) is the thing responsible for
 * only ever offering legal choices for the current subject, and the backend
 * validator is the authority of record. This function only asks "is the
 * selection structurally complete for its mode".
 */
export function selectionToTrigger(
  sel: TriggerSelection,
): { trigger_type: AutomationTriggerType; trigger_config: TriggerConfig | null } | null {
  if (sel.mode === 'event') {
    if (sel.eventTrigger === undefined) return null;
    // Unlike every other event trigger's bare null, JOB_SUB_STATUS_ENTERED still
    // needs a trigger_config (SRVW-113) - WHICH sub-status the workflow watches.
    if (sel.eventTrigger === 'JOB_SUB_STATUS_ENTERED') {
      if (sel.subStatusId === undefined) return null;
      return { trigger_type: sel.eventTrigger, trigger_config: { sub_status_id: sel.subStatusId } };
    }
    return { trigger_type: sel.eventTrigger, trigger_config: null };
  }

  if (sel.anchor === undefined || sel.direction === undefined || sel.offsetMinutes === undefined) {
    return null;
  }
  return {
    trigger_type: DATE_ANCHORED_BY_SUBJECT[sel.subject],
    trigger_config: { anchor: sel.anchor, direction: sel.direction, offset_minutes: sel.offsetMinutes },
  };
}

function isDateAnchorConfig(config: TriggerConfig | null): config is DateAnchorTriggerConfig {
  if (config === null) return false;
  if (!('anchor' in config)) return false;
  return (config.direction === 'before' || config.direction === 'after') && typeof config.offset_minutes === 'number';
}

function isSubStatusConfig(config: TriggerConfig | null): config is SubStatusTriggerConfig {
  return config !== null && 'sub_status_id' in config && typeof config.sub_status_id === 'string';
}

/**
 * Wire shape → builder selection, as seen when opening an existing saved
 * workflow. Returns null for any trigger_type/trigger_config combination
 * that doesn't cleanly map back into the two-mode shape rather than
 * fabricating a guess:
 *   - the trigger_type isn't in the catalog at all,
 *   - a date-anchored trigger_type paired with an incomplete/malformed config,
 *   - a date-anchored trigger_type paired with an anchor that isn't legal
 *     for its entity (cross-checked against `catalog.anchors`),
 *   - a non-date-anchored trigger_type paired with a non-null config — this
 *     is what a legacy timed trigger (BEFORE_JOB_START, etc.) looks like on
 *     the wire, and its bare `{ offset_minutes }` has no field in
 *     TriggerSelection to live in under either mode, so it doesn't cleanly
 *     map back either (the builder UI showing "nothing selected yet" for a
 *     legacy timed trigger is what B7's amber "changing the trigger"
 *     handling is for, not this function's job).
 */
export function triggerToSelection(
  trigger_type: AutomationTriggerType,
  trigger_config: TriggerConfig | null,
  catalog: WorkflowCatalog,
): TriggerSelection | null {
  const def = catalog.triggers[trigger_type];
  if (!def) return null;
  const subject = def.entity;

  if (trigger_type === DATE_ANCHORED_BY_SUBJECT[subject]) {
    if (!isDateAnchorConfig(trigger_config)) return null;
    const legalAnchors = catalog.anchors[subject] ?? [];
    if (!legalAnchors.some((option) => option.key === trigger_config.anchor)) return null;
    return {
      subject,
      mode: 'date',
      anchor: trigger_config.anchor,
      direction: trigger_config.direction,
      offsetMinutes: trigger_config.offset_minutes,
    };
  }

  if (trigger_type === 'JOB_SUB_STATUS_ENTERED') {
    if (!isSubStatusConfig(trigger_config)) return null;
    return { subject, mode: 'event', eventTrigger: trigger_type, subStatusId: trigger_config.sub_status_id };
  }

  if (trigger_config == null) {
    return { subject, mode: 'event', eventTrigger: trigger_type };
  }

  return null;
}
