/**
 * Backward-move policy for the job lifecycle bar (Spec B1).
 *
 * The bar's `reached` flag forward-fills from later stages (lifecycle.ts:50-55), so moving a
 * job BACKWARD is invisible unless the later timestamps are cleared. This module is the single
 * source of truth for what each milestone clears — one place to read, one place to change.
 *
 * Two invariants worth stating out loud, because both are load-bearing:
 *
 *  1. `scheduled_start` / `scheduled_end` / `is_all_day` are NEVER cleared. Nothing precedes
 *     Scheduled but Job Created, which is not actionable. Clearing them would break
 *     assignJobSchema's start/end pairing refine, drop the job out of the schedule board's
 *     date-range query, and misfire the JOB_SCHEDULED-vs-JOB_RESCHEDULED automation branch.
 *
 *  2. Invoice and payment state is NEVER touched. You cannot un-send an invoice or un-receive a
 *     payment by clicking a job node; those reverse through void and refund. Clicking Completed
 *     on a job whose invoice is already sent moves the job and leaves the invoice alone.
 *
 * Also deliberately preserved: `completion_notes` and `signature_*` (work product — still valid
 * on re-completion) and `customer_scheduled_email_sent_at` (a send-guard; clearing it re-emails
 * the customer).
 */

export type Milestone = 'scheduled' | 'on_site' | 'started' | 'completed';

/** Later-stage timestamps each milestone nulls, in bar order. */
const LATER_TIMESTAMPS: Record<Milestone, readonly string[]> = {
  scheduled: ['en_route_at', 'on_site_at', 'started_at', 'completed_at'],
  on_site: ['started_at', 'completed_at'],
  started: ['completed_at'],
  completed: [],
};

/**
 * The `data` fragment to spread into a job update for `milestone`. Every milestone also
 * un-cancels: cancellation is not terminal, so moving a cancelled job anywhere revives it.
 */
export function milestoneClears(milestone: Milestone): Record<string, null> {
  const out: Record<string, null> = {};
  for (const field of LATER_TIMESTAMPS[milestone]) out[field] = null;
  out.cancelled_at = null;
  out.cancelled_reason = null;
  return out;
}

/**
 * Does this milestone null `completed_at`? A transition that does must also revert the linked
 * PlanVisit — `complete()` cascades it to COMPLETED (job.controller.ts:2187-2192) but `reopen()`
 * never reverts it (:2413-2417), so servicePlans/derive.ts keeps counting the visit as consumed
 * and `visits_remaining` stays permanently decremented. That is a live pre-existing bug; free
 * backward movement would reproduce it far more often.
 */
export function clearsCompletion(milestone: Milestone): boolean {
  return LATER_TIMESTAMPS[milestone].includes('completed_at');
}
