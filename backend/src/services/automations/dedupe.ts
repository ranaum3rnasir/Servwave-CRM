/**
 * dedupe.ts — occurrence-identity keys for automation runs.
 *
 * The (rule_id, dedupe_key) unique constraint on automation_runs is the
 * engine's idempotency mechanism. The key must encode WHICH occurrence of the
 * trigger this run belongs to:
 *  - plain event triggers fire once per entity per rule,
 *  - reschedule/assignment/time triggers fire once per occurrence, so a
 *    rescheduled job automatically re-arms its reminder (new scheduled_start
 *    → new key) while the stale run is skipped at execution time.
 */

import { AutomationTriggerType } from '@prisma/client';

/** Triggers whose dedupe key must include an occurrence discriminator. */
const OCCURRENCE_SCOPED: ReadonlySet<AutomationTriggerType> = new Set([
  'JOB_RESCHEDULED',   // occurrence = new scheduled_start ISO
  'TECH_ASSIGNED',     // occurrence = assigned user id
  'BEFORE_JOB_START',  // occurrence = scheduled_start ISO
  'AFTER_JOB_COMPLETED', // occurrence = completed_at ISO
  'WALKTHROUGH_SCHEDULED',        // occurrence = walkthrough_scheduled_at ISO
  'WALKTHROUGH_RESCHEDULED',      // occurrence = new walkthrough_scheduled_at ISO
  'WALKTHROUGH_PERFORMER_ASSIGNED', // occurrence = assigned performer user id
  'WALKTHROUGH_PERFORMER_REMOVED', // occurrence = removed performer user id
  'TECH_UNASSIGNED',   // occurrence = removed technician user id
  'JOB_EN_ROUTE',      // occurrence = en_route_at ISO
  'LEAD_ASSIGNED',                // occurrence = assigned owner user id
  'JOB_DATE_ANCHORED',       // occurrence = job.scheduled_start ISO (Task A2/A5)
  'LEAD_DATE_ANCHORED',      // occurrence = lead.walkthrough_scheduled_at ISO (Task A2/A5)
  'INVOICE_DATE_ANCHORED',   // occurrence = invoice.due_date ISO (Task A2/A5)
  'ESTIMATE_DATE_ANCHORED',  // occurrence = estimate.valid_until ISO (Task A2/A5)
  'JOB_SUB_STATUS_ENTERED',  // occurrence = sub_status_id (SRVW-113) - a job cycling A -> B -> A re-fires
] satisfies AutomationTriggerType[]);

export function isOccurrenceScoped(trigger: AutomationTriggerType): boolean {
  return OCCURRENCE_SCOPED.has(trigger);
}

/**
 * Multi-visit D18: when the CALLER supplies a visit id, it is spliced between
 * the entity id and the occurrence. Keyed on the parent job alone, visit 2's
 * "scheduled" notification is swallowed by the [workflow_id, dedupe_key] unique
 * constraint as a duplicate of visit 1's - the exact swallow D18 names.
 *
 * Scoping is driven purely by whether the dispatch site has a visit id. No
 * member is added to OCCURRENCE_SCOPED and no second set exists, so this helper
 * gains NO new way to throw. That matters: the throw is swallowed by
 * createEnrollment's catch, which logs at warn and returns null, i.e. the
 * automation silently stops firing. The cron and the date-anchor sweep never
 * pass a visit id, so BEFORE_JOB_START / *_DATE_ANCHORED are untouched by
 * construction.
 *
 * The visit id goes ONLY here, never into occurrence_key. stopIf.ts and
 * terminalStale.ts compare occurrence_key against someDate.toISOString() and,
 * on a mismatch, return a stale-reason rather than erroring - widening that
 * format would quietly kill every anchored wait. rearmAnchoredWaits writes
 * occurrence_key and never dedupe_key, so it cannot clobber this either.
 *
 * REJECTED, and why - no data migration rewrites the two persisted ledgers
 * (workflow_enrollments.dedupe_key and automation_runs.dedupe_key):
 *  1. A dual probe (check the old job-only key as well) would suppress exactly
 *     the visit-2 enrollment D18 exists to create. It defeats the change.
 *  2. A rewrite migration is unnecessary. Every visit-scoped trigger's
 *     occurrence is either a freshly minted millisecond stamp (JOB_EN_ROUTE =
 *     en_route_at, JOB_RESCHEDULED = the new start) or already guarded
 *     once-per-job by a persisted column (JOB_SCHEDULED via
 *     Job.customer_scheduled_email_sent_at). So a historical row that stops
 *     colliding has nothing left that would re-dispatch it.
 */
export function buildDedupeKey(
  trigger: AutomationTriggerType,
  entityId: string,
  occurrence?: string,
  visitId?: string,
): string {
  const scope = visitId ? `${entityId}:${visitId}` : entityId;
  if (OCCURRENCE_SCOPED.has(trigger)) {
    if (!occurrence) {
      throw new Error(`buildDedupeKey: trigger ${trigger} requires an occurrence key`);
    }
    return `${trigger}:${scope}:${occurrence}`;
  }
  return `${trigger}:${scope}`;
}
