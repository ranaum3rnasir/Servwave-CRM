/**
 * terminalStale.ts — the multi-step engine's terminal staleness floor.
 *
 * Standalone extraction of `stalenessReason()` from the frozen legacy
 * `engine.ts` (lines 91-171). There, a stale entity SKIPS a single send; here,
 * the same checks TERMINATE the whole enrollment (a cancelled job must stop
 * every remaining step, not just the one about to fire). PURE — no prisma,
 * no I/O. The plain-English strings are product copy, kept verbatim.
 */

import { AutomationTriggerType } from '@prisma/client';
import type { EntityState } from './context';

/**
 * Plain-English reason the enrollment is terminally stale (→ STOP the whole
 * flow), or null when still relevant. `occurrence` is the enrollment's
 * occurrence_key (ISO scheduled_start / completed_at / tech user id) — passed
 * directly, NOT parsed from a dedupe key (that parsing was engine.ts's
 * extractOccurrence; the new model stores occurrence_key explicitly).
 *
 * `direction` — 'before' | 'after' | undefined — is the 5th, OPTIONAL
 * parameter, read ONLY by the four unified date-anchored triggers (JOB/LEAD/
 * INVOICE/ESTIMATE_DATE_ANCHORED, Task A2). Those triggers fire on either
 * side of the SAME anchor date, so "the anchor already passed" is correct
 * staleness for direction:'before' (mirrors BEFORE_JOB_START) but WRONG for
 * direction:'after' — the anchor having passed is that direction's own
 * firing precondition (Task A5's anchorWindow only ever selects
 * already-past anchors for 'after'). Every legacy trigger case below ignores
 * this parameter outright: passing it, passing any value, or omitting it
 * entirely has zero effect on their behavior (see the regression tests).
 * `undefined` — e.g. a malformed trigger_config on an otherwise-new-type
 * trigger — is treated like 'after' for every already-passed-style check
 * (plain `direction === 'before'` guards, so anything else short-circuits
 * them): failing OPEN is the safer default, since misclassifying a genuine
 * 'after' enrollment as 'before' would permanently and silently kill every
 * after-direction reminder in the system, while the reverse mistake only
 * risks one borderline-late send (the same risk a send-window deferral
 * already carries).
 */
export function terminalStaleReason(
  trigger: AutomationTriggerType,
  occurrence: string | undefined,
  state: EntityState,
  now: Date,
  direction?: 'before' | 'after',
): string | null {
  switch (trigger) {
    case 'BEFORE_JOB_START': {
      if (state.jobStatus === 'CANCELLED') return 'Job was cancelled';
      if (state.jobStatus === 'COMPLETED') return 'Job was already completed';
      // B-6 (Spec B1): the cron scan widens to include EN_ROUTE/ON_SITE/IN_PROGRESS so a
      // technician marking themselves en-route/on-site early no longer kills the reminder
      // outright -- but ON_SITE/IN_PROGRESS specifically means the tech is already there or
      // already working, so "your appointment is in 1 hour" would be messaging a customer whose
      // technician is at the door. EN_ROUTE is deliberately NOT included here: the tech is still
      // travelling, so the reminder is still useful.
      if (state.jobStatus === 'ON_SITE' || state.jobStatus === 'IN_PROGRESS') return 'Work has already started';
      if (!state.jobScheduledStart) return 'Job is no longer scheduled';
      if (occurrence && state.jobScheduledStart.toISOString() !== occurrence) {
        return 'Job was rescheduled — this run was replaced by an updated reminder';
      }
      // A send-window deferral can push a reminder past the appointment itself
      // (e.g. a 1h reminder landing at 22:00 deferred to 08:00 next day). A
      // "reminder" after the fact is worse than silence.
      if (state.jobScheduledStart.getTime() <= now.getTime()) {
        return 'Job start time has already passed';
      }
      return null;
    }
    case 'AFTER_JOB_COMPLETED': {
      if (state.jobStatus !== 'COMPLETED') return 'Job is no longer marked completed';
      // Symmetry with BEFORE_JOB_START above. A job can be moved backward off COMPLETED and
      // re-completed (Spec B1's free transitions, and reopen() -> re-complete already today).
      // The new completed_at mints a NEW dedupe key, so a second run enrols -- correct, because
      // a job genuinely re-completed months later SHOULD re-arm its follow-up. What must not
      // happen is the FIRST run also firing: it belongs to a completion that no longer exists.
      if (occurrence && state.jobCompletedAt && state.jobCompletedAt.toISOString() !== occurrence) {
        return 'Job was re-completed — this run was replaced by an updated follow-up';
      }
      return null;
    }
    case 'INVOICE_OVERDUE': {
      const s = state.invoiceStatus;
      if (s === 'PAID') return 'Invoice was paid — nothing to chase';
      if (s && s !== 'SENT' && s !== 'PARTIAL') return `Invoice is ${s.toLowerCase()} — reminder not needed`;
      // A credit can zero the balance while leaving the invoice SENT/PARTIAL —
      // dunning a $0 balance would be a false alarm.
      if (state.invoiceAmountDue !== undefined && state.invoiceAmountDue <= 0) {
        return 'Invoice has no outstanding balance';
      }
      return null;
    }
    case 'ESTIMATE_FOLLOW_UP': {
      const s = state.estimateStatus;
      if (s && s !== 'SENT' && s !== 'PENDING') {
        return `Estimate was ${s.toLowerCase()} — follow-up not needed`;
      }
      return null;
    }

    // ── Unified date-anchored triggers (Task A2/A5b) — bidirectional around
    //    the SAME anchor date. The floor in each case mirrors its timed-
    //    trigger analogue directly above (dead/terminal entity states, plus —
    //    unlike those always-one-direction triggers — an occurrence-mismatch
    //    check, since Task A5's candidatesForAnchor sets occurrence to the
    //    anchor date for all four). Only the "already passed" check is
    //    direction-gated: see the function doc comment for why direction:
    //    'after' must NOT reuse it unmodified.
    case 'JOB_DATE_ANCHORED': {
      if (state.jobStatus === 'CANCELLED') return 'Job was cancelled';
      // Unlike BEFORE_JOB_START above, COMPLETED is only stale for 'before'.
      // Spec B1 removed the ordering guard on complete() entirely, so a job can be marked
      // COMPLETED from ANY active status (including SCHEDULED) with no scheduled_start guard
      // anywhere in job.controller.ts's complete() — so a job can be marked COMPLETED while
      // scheduled_start is still in the future, which the already-passed check below would NOT
      // catch. For 'after', COMPLETED is the expected, desired state at send time (that's the
      // whole point of an after-appointment reminder) and must NOT be treated as stale.
      if (direction === 'before' && state.jobStatus === 'COMPLETED') return 'Job was already completed';
      if (!state.jobScheduledStart) return 'Job is no longer scheduled';
      if (occurrence && state.jobScheduledStart.toISOString() !== occurrence) {
        return 'Job was rescheduled — this run was replaced by an updated reminder';
      }
      if (direction === 'before' && state.jobScheduledStart.getTime() <= now.getTime()) {
        return 'Job start time has already passed';
      }
      return null;
    }

    case 'LEAD_DATE_ANCHORED': {
      const s = state.leadStatus;
      // LOST/CANCELLED are terminal regardless of direction (a dead lead gets
      // no reminder either way). NOTE: this is NOT redundant with the null-date
      // check below — lead.controller.ts's markLost()/cancelLead() only null
      // walkthrough_scheduled_at when the lead WAS WALKTHROUGH_SCHEDULED at the
      // moment of loss/cancellation; a lead lost/cancelled AFTER the walkthrough
      // already completed (the realistic case for an 'after' reminder, which by
      // definition fires once time has moved past the walkthrough) keeps its
      // historical walkthrough date untouched, so only an explicit status check
      // catches that case.
      if (s === 'LOST') return 'Lead was marked as lost';
      if (s === 'CANCELLED') return 'Lead was cancelled';
      if (!state.leadWalkthroughScheduledAt) return 'Walkthrough is no longer scheduled';
      if (occurrence && state.leadWalkthroughScheduledAt.toISOString() !== occurrence) {
        return 'Walkthrough was rescheduled — this reminder was replaced by an updated one';
      }
      // Walkthrough-as-entity redesign, PR-B2: 'before' narrows further to the VISIT's own
      // status being EXACTLY SCHEDULED, not lead.status — after this redesign,
      // scheduleWalkthrough only ever advances a NEW lead to CONTACTED (D5), so lead.status is
      // no longer a reliable "still pending" signal. A before-reminder promises a STILL-pending
      // walkthrough, so a visit that is REQUESTED/COMPLETED/CANCELLED is stale for 'before'.
      // For 'after', those same visit states are normal forward progress (time moved past the
      // walkthrough, which is what an after-reminder expects) and must NOT be flagged —
      // applying this exact-match check unconditionally is the bug this task closes.
      if (direction === 'before') {
        const wt = state.leadWalkthroughStatus;
        if (wt && wt !== 'SCHEDULED') {
          return `Walkthrough is ${wt.toLowerCase().replace(/_/g, ' ')} — reminder not needed`;
        }
        if (state.leadWalkthroughScheduledAt.getTime() <= now.getTime()) {
          return 'Walkthrough time has already passed';
        }
      }
      return null;
    }

    case 'INVOICE_DATE_ANCHORED': {
      // Direction-independent floor, identical to INVOICE_OVERDUE's above:
      // paying or voiding ends BOTH a pre-due reminder and a post-due chase,
      // and a due-date anchor is only ever meaningful while SENT/PARTIAL —
      // unlike JOB/LEAD's event-flavored anchors, "after due date" has no
      // desired-positive-status to protect (PAID is the desired outcome and
      // INVOICE_OVERDUE already unconditionally treats it as terminal).
      const s = state.invoiceStatus;
      if (s === 'PAID') return 'Invoice was paid — nothing to chase';
      if (s && s !== 'SENT' && s !== 'PARTIAL') return `Invoice is ${s.toLowerCase()} — reminder not needed`;
      if (state.invoiceAmountDue !== undefined && state.invoiceAmountDue <= 0) {
        return 'Invoice has no outstanding balance';
      }
      if (!state.invoiceDueDate) return 'Invoice no longer has a due date';
      if (occurrence && state.invoiceDueDate.toISOString() !== occurrence) {
        return 'Invoice due date was changed — this run was replaced by an updated reminder';
      }
      if (direction === 'before' && state.invoiceDueDate.getTime() <= now.getTime()) {
        return 'Invoice due date has already passed';
      }
      return null;
    }

    case 'ESTIMATE_DATE_ANCHORED': {
      // Direction-independent floor, identical to ESTIMATE_FOLLOW_UP's above,
      // for the same reason INVOICE_DATE_ANCHORED's is: once answered
      // (WON/DECLINED/etc.) there's nothing left for either a
      // pre-expiration nudge or a post-expiration one to say — WON is the
      // desired outcome and is already unconditionally terminal here, exactly
      // like ESTIMATE_FOLLOW_UP treats it today. Note this is an allowlist of
      // still-open statuses, so it stays correct across EstimateStatus renames
      // (it survived APPROVED→WON in #886 untouched).
      const s = state.estimateStatus;
      if (s && s !== 'SENT' && s !== 'PENDING') {
        return `Estimate was ${s.toLowerCase()} — follow-up not needed`;
      }
      if (!state.estimateValidUntil) return 'Estimate no longer has an expiration date';
      if (occurrence && state.estimateValidUntil.toISOString() !== occurrence) {
        return 'Estimate expiration date was changed — this run was replaced by an updated reminder';
      }
      if (direction === 'before' && state.estimateValidUntil.getTime() <= now.getTime()) {
        return 'Estimate expiration date has already passed';
      }
      return null;
    }

    // ── Event triggers can also be send-window-deferred (queued at 21:00, sent
    //    at 08:00), so re-verify the entity at send time — the same guarantee the
    //    time triggers give. Only the "state-of-being" events (JOB_COMPLETED,
    //    JOB_CANCELLED, INVOICE_PAID, ESTIMATE_APPROVED/DECLINED, LEAD_CREATED)
    //    stay message-valid regardless of later changes and fall through to null.
    case 'JOB_SCHEDULED':
    case 'TECH_ASSIGNED': {
      if (state.jobStatus === 'CANCELLED') return 'Job was cancelled';
      if (state.jobStatus === 'COMPLETED') return 'Job was already completed';
      return null;
    }
    case 'JOB_RESCHEDULED': {
      if (state.jobStatus === 'CANCELLED') return 'Job was cancelled';
      if (state.jobStatus === 'COMPLETED') return 'Job was already completed';
      if (occurrence && state.jobScheduledStart && state.jobScheduledStart.toISOString() !== occurrence) {
        return 'Job was rescheduled again — a newer notice replaced this one';
      }
      return null;
    }
    case 'INVOICE_SENT': {
      const s = state.invoiceStatus;
      if (s === 'VOIDED') return 'Invoice was voided';
      if (s === 'PAID') return 'Invoice was already paid';
      return null;
    }
    case 'ESTIMATE_SENT': {
      const s = state.estimateStatus;
      if (s && s !== 'SENT' && s !== 'PENDING') {
        return `Estimate was ${s.toLowerCase()} — no longer awaiting a response`;
      }
      return null;
    }
    case 'WALKTHROUGH_SCHEDULED':
    case 'WALKTHROUGH_RESCHEDULED': {
      // Walkthrough-as-entity redesign, PR-B2: keys off the VISIT's own status
      // (leadWalkthroughStatus), not lead.status — scheduleWalkthrough no longer writes
      // WALKTHROUGH_SCHEDULED onto the lead at all (D5: NEW -> CONTACTED only), so lead.status
      // was never going to reliably read 'WALKTHROUGH_SCHEDULED' again after this redesign.
      const wt = state.leadWalkthroughStatus;
      if (wt && wt !== 'SCHEDULED') {
        return `Walkthrough is ${wt.toLowerCase().replace(/_/g, ' ')} — reminder not needed`;
      }
      if (!state.leadWalkthroughScheduledAt) return 'Walkthrough is no longer scheduled';
      if (state.leadWalkthroughScheduledAt.getTime() <= now.getTime()) return 'Walkthrough time has already passed';
      if (occurrence && state.leadWalkthroughScheduledAt.toISOString() !== occurrence) {
        return 'Walkthrough was rescheduled — this reminder was replaced by an updated one';
      }
      return null;
    }
    default:
      return null;
  }
}
