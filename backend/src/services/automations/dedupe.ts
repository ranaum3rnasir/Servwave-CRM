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

export function buildDedupeKey(
  trigger: AutomationTriggerType,
  entityId: string,
  occurrence?: string,
): string {
  if (OCCURRENCE_SCOPED.has(trigger)) {
    if (!occurrence) {
      throw new Error(`buildDedupeKey: trigger ${trigger} requires an occurrence key`);
    }
    return `${trigger}:${entityId}:${occurrence}`;
  }
  return `${trigger}:${entityId}`;
}
