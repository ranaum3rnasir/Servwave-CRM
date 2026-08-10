/**
 * dateAnchorSweep.ts — candidate selection for the unified date-anchored trigger
 * family.
 *
 * A date-anchored workflow fires at `anchorDate ∓ offset`. Rather than parking an
 * enrollment ahead of time, the poller sweeps each anchor's date field every
 * minute for rows whose fire moment has just arrived and enrolls them then. Two
 * consequences worth knowing:
 *
 *  - No re-arm. Nothing is parked before the fire moment, so a rescheduled job or
 *    an edited due date is simply picked up at its new time on a later tick. The
 *    occurrence key is the anchor date itself, so a moved date is a genuinely new
 *    occurrence (new dedupe key → a fresh reminder) while the old date's key can
 *    never fire twice.
 *  - The product rule falls out of the window. For `before`, the window is
 *    [now, now+offset]: an anchor still upcoming but inside the lead time is in
 *    range and fires immediately (late but useful); an anchor already past is
 *    below `now` and can never enter the window (no stale reminder).
 *
 * PURE query layer — selects rows, never enrolls. cron.ts owns enrollment.
 */
import { prisma } from '../../lib/prisma';
import type { AnchorKey, WaitDirection } from './anchors';

/** Missed-tick grace for "after" sweeps — mirrors the INVOICE_OVERDUE precedent. */
export const AFTER_GRACE_MS = 7 * 24 * 60 * 60 * 1000;

export interface DateAnchorCandidate {
  entityType: 'job' | 'lead' | 'invoice' | 'estimate';
  entityId: string;
  entityLabel: string | null;
  /** The anchor date, ISO — the occurrence key (per-date dedupe). */
  occurrence: string;
}

export function anchorWindow(
  direction: WaitDirection,
  offsetMs: number,
  now: Date,
): { gte: Date; lte: Date } {
  if (direction === 'before') {
    return { gte: now, lte: new Date(now.getTime() + offsetMs) };
  }
  return {
    gte: new Date(now.getTime() - offsetMs - AFTER_GRACE_MS),
    lte: new Date(now.getTime() - offsetMs),
  };
}

export async function candidatesForAnchor(
  anchor: AnchorKey,
  organizationId: string,
  window: { gte: Date; lte: Date },
): Promise<DateAnchorCandidate[]> {
  switch (anchor) {
    case 'job.scheduled_start': {
      const rows = await prisma.job.findMany({
        where: { organization_id: organizationId, status: 'SCHEDULED', scheduled_start: window },
        select: { id: true, job_number: true, scheduled_start: true },
      });
      return rows.flatMap((r) =>
        r.scheduled_start
          ? [{ entityType: 'job' as const, entityId: r.id, entityLabel: r.job_number, occurrence: r.scheduled_start.toISOString() }]
          : [],
      );
    }
    case 'lead.walkthrough_scheduled_at': {
      // No status filter here: terminalStale's LEAD_DATE_ANCHORED case (Task
      // A5b) re-checks the CURRENT VISIT's status at EXECUTION time instead (Walkthrough-as-
      // entity redesign, PR-B2: leadWalkthroughStatus, not leadStatus) — LOST/CANCELLED leads
      // are dropped regardless of direction; a `before` reminder is additionally dropped once
      // the visit leaves SCHEDULED (including COMPLETED — a before-reminder promises a still-
      // pending walkthrough). An `after` reminder deliberately survives COMPLETED/CANCELLED:
      // that is the expected, desired visit state by the time an after-the-walkthrough
      // reminder fires, not staleness. Filtering status here (rather than at execution time)
      // would have to pick ONE of those two allow-lists for both directions and get it wrong
      // for the other.
      //
      // Walkthrough-as-entity redesign, PR-B2: repointed onto the Walkthrough table directly
      // (any lead's visit, any status) instead of the legacy Lead.walkthrough_scheduled_at
      // column — a lead can now have more than one Walkthrough row, so the sweep must scan the
      // rows themselves rather than a single flat column per lead.
      const rows = await prisma.walkthrough.findMany({
        where: { organization_id: organizationId, scheduled_at: window },
        select: { scheduled_at: true, lead: { select: { id: true, lead_number: true } } },
      });
      return rows.flatMap((r) =>
        r.scheduled_at
          ? [{ entityType: 'lead' as const, entityId: r.lead.id, entityLabel: r.lead.lead_number, occurrence: r.scheduled_at.toISOString() }]
          : [],
      );
    }
    case 'invoice.due_date': {
      const rows = await prisma.invoice.findMany({
        where: {
          organization_id: organizationId,
          status: { in: ['SENT', 'PARTIAL'] },
          amount_due: { gt: 0 }, // a credit can zero the balance without changing status
          due_date: window,
        },
        select: { id: true, invoice_number: true, due_date: true },
      });
      return rows.flatMap((r) =>
        r.due_date
          ? [{ entityType: 'invoice' as const, entityId: r.id, entityLabel: r.invoice_number, occurrence: r.due_date.toISOString() }]
          : [],
      );
    }
    case 'estimate.valid_until': {
      // SENT only — a PENDING estimate is already accepted and signed (D6) and no longer
      // expires, so anchoring automations to its lapsed validity date is meaningless.
      const rows = await prisma.estimate.findMany({
        where: { organization_id: organizationId, status: 'SENT', valid_until: window },
        select: { id: true, estimate_number: true, valid_until: true },
      });
      return rows.flatMap((r) =>
        r.valid_until
          ? [{ entityType: 'estimate' as const, entityId: r.id, entityLabel: r.estimate_number, occurrence: r.valid_until.toISOString() }]
          : [],
      );
    }
    default:
      return [];
  }
}
