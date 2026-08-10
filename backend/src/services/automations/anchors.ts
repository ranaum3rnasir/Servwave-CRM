/**
 * anchors.ts — the registry of entity DATE fields an anchored WAIT can target.
 *
 * An anchored WAIT parks until `anchorDate ± offset` instead of `now + duration`.
 * The anchor date is read from the EntityState the engine already loads per step.
 * Single source of truth for which entity exposes which anchor, so validation
 * (legal anchors per trigger entity) and the engine (how to read the date) never drift.
 */
import type { EntityState } from './context';

export type AnchorKey =
  | 'job.scheduled_start'
  | 'lead.walkthrough_scheduled_at'
  | 'invoice.due_date'
  | 'estimate.valid_until';

export type WaitDirection = 'before' | 'after';

export interface AnchoredWaitConfig {
  mode: 'anchored';
  anchor: AnchorKey;
  direction: WaitDirection;
  offset_minutes: number;
}

/** Short noun for the recipe sentence ("wait until 1 day before the walkthrough"). */
export const ANCHOR_LABELS: Record<AnchorKey, string> = {
  'job.scheduled_start': 'the appointment',
  'lead.walkthrough_scheduled_at': 'the walkthrough',
  'invoice.due_date': 'the invoice due date',
  'estimate.valid_until': 'the estimate expiration',
};

/** Longer noun for the activity log ("1 day before the walkthrough time"). */
const ANCHOR_TIME_LABELS: Record<AnchorKey, string> = {
  'job.scheduled_start': 'the appointment time',
  'lead.walkthrough_scheduled_at': 'the walkthrough time',
  'invoice.due_date': 'the invoice due date',
  'estimate.valid_until': 'the estimate expiration date',
};

/** Which anchors a trigger's entity may use (drives builder options + validation). */
export const ANCHORS_FOR_ENTITY: Record<'job' | 'estimate' | 'invoice' | 'lead', AnchorKey[]> = {
  job: ['job.scheduled_start'],
  lead: ['lead.walkthrough_scheduled_at'],
  estimate: ['estimate.valid_until'],
  invoice: ['invoice.due_date'],
};

export function anchorDateFor(anchor: AnchorKey, state: EntityState): Date | null {
  switch (anchor) {
    case 'job.scheduled_start':
      return state.jobScheduledStart ?? null;
    case 'lead.walkthrough_scheduled_at':
      return state.leadWalkthroughScheduledAt ?? null;
    case 'invoice.due_date':
      return state.invoiceDueDate ?? null;
    case 'estimate.valid_until':
      return state.estimateValidUntil ?? null;
    default:
      return null;
  }
}

export function isAnchoredWait(config: unknown): config is AnchoredWaitConfig {
  return Boolean(config && typeof config === 'object' && (config as { mode?: unknown }).mode === 'anchored');
}

function humanizeOffset(minutes: number): string {
  if (minutes === 0) return '0 minutes';
  if (minutes % (60 * 24) === 0) { const d = minutes / (60 * 24); return `${d} ${d === 1 ? 'day' : 'days'}`; }
  if (minutes % 60 === 0) { const h = minutes / 60; return `${h} ${h === 1 ? 'hour' : 'hours'}`; }
  return `${minutes} ${minutes === 1 ? 'minute' : 'minutes'}`;
}

/** "1 day before the walkthrough time" — activity-log copy for a completed anchored wait. */
export function describeAnchoredWait(cfg: AnchoredWaitConfig): string {
  return `${humanizeOffset(cfg.offset_minutes)} ${cfg.direction} ${ANCHOR_TIME_LABELS[cfg.anchor]}`;
}
