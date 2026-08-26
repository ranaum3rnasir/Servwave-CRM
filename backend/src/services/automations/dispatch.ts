/**
 * dispatch.ts — the ONE call controllers make to feed the Automation Center.
 *
 * dispatchAutomationEvent is fire-and-forget and NEVER throws or blocks the
 * caller's response: the enrollment work (enrollOnEvent in enrollment.ts — the
 * multi-step workflow engine) is deferred to the next tick, mirroring the
 * notification service's post-commit contract (#271 rule — the caller must
 * invoke this AFTER its transaction commits, never inside it).
 */

import { AutomationTriggerType } from '@prisma/client';
import { logger } from '../../lib/logger';
import { enrollOnEvent } from './enrollment';
import type { EventPayload } from './context';

/** Event-shaped triggers (time-based ones are owned by the poller). */
export type EventTriggerType = Exclude<
  AutomationTriggerType,
  'BEFORE_JOB_START' | 'AFTER_JOB_COMPLETED' | 'INVOICE_OVERDUE' | 'ESTIMATE_FOLLOW_UP'
>;

export interface AutomationEvent {
  type: EventTriggerType;
  organizationId: string;
  entity: { type: 'job' | 'estimate' | 'invoice' | 'lead'; id: string; label?: string | null };
  /**
   * Occurrence discriminator for occurrence-scoped triggers:
   * JOB_RESCHEDULED → new scheduled_start ISO; TECH_ASSIGNED → user id.
   */
  occurrenceKey?: string;
  /**
   * Multi-visit D18: the visit this occurrence is about. It joins the DEDUPE key
   * only (dedupe.ts), never the occurrence key, so two visits on one job enrol
   * twice instead of visit 2 being swallowed as a duplicate of visit 1. The
   * ENTITY stays the parent job/lead - context.ts's loadExecutionBundle has no
   * 'visit' case, and D18 asks for the occurrence to name the visit, not the entity.
   */
  visitId?: string;
  actorId?: string | null;
  /** Whatever this event captured that the live entity won't have later (a removed
   *  recipient, request-time text) — see context.ts's EventPayload. */
  eventPayload?: EventPayload;
}

export function dispatchAutomationEvent(ev: AutomationEvent): void {
  setImmediate(() => {
    enrollOnEvent(ev).catch((err) => {
      logger.warn('[automations] dispatch failed — swallowing to protect caller', {
        type: ev.type,
        entityId: ev.entity.id,
        error: err instanceof Error ? err.message : String(err),
      });
    });
  });
}
