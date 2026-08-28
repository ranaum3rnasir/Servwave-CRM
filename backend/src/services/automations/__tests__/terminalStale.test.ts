import { describe, it, expect } from 'vitest';
import { terminalStaleReason } from '../terminalStale';
import type { EntityState } from '../context';

describe('terminalStaleReason', () => {
  const NOW = new Date('2026-07-14T15:00:00.000Z');
  const FUTURE = new Date('2026-07-15T15:00:00.000Z');
  const PAST = new Date('2026-07-14T10:00:00.000Z');

  describe('BEFORE_JOB_START', () => {
    it('is stale when the job was cancelled', () => {
      const state: EntityState = { jobStatus: 'CANCELLED', jobScheduledStart: FUTURE };
      expect(terminalStaleReason('BEFORE_JOB_START', undefined, state, NOW)).toBe('Job was cancelled');
    });

    it('is stale when the job was already completed', () => {
      const state: EntityState = { jobStatus: 'COMPLETED', jobScheduledStart: FUTURE };
      expect(terminalStaleReason('BEFORE_JOB_START', undefined, state, NOW)).toBe('Job was already completed');
    });

    it('is stale when there is no scheduled_start', () => {
      const state: EntityState = { jobStatus: 'SCHEDULED', jobScheduledStart: null };
      expect(terminalStaleReason('BEFORE_JOB_START', undefined, state, NOW)).toBe('Job is no longer scheduled');
    });

    it('is stale when the occurrence no longer matches the current scheduled_start (rescheduled)', () => {
      const state: EntityState = { jobStatus: 'SCHEDULED', jobScheduledStart: FUTURE };
      const occurrence = '2026-07-16T15:00:00.000Z'; // different from FUTURE
      expect(terminalStaleReason('BEFORE_JOB_START', occurrence, state, NOW)).toBe(
        'Job was rescheduled — this run was replaced by an updated reminder',
      );
    });

    it('is stale when the job start time has already passed (send-window-deferral case)', () => {
      // A reminder deferred past the appointment start must be stale, even
      // with no occurrence mismatch.
      const state: EntityState = { jobStatus: 'SCHEDULED', jobScheduledStart: PAST };
      expect(terminalStaleReason('BEFORE_JOB_START', undefined, state, NOW)).toBe(
        'Job start time has already passed',
      );
    });

    it('is stale when scheduled_start equals now exactly (<=)', () => {
      const state: EntityState = { jobStatus: 'SCHEDULED', jobScheduledStart: NOW };
      expect(terminalStaleReason('BEFORE_JOB_START', undefined, state, NOW)).toBe(
        'Job start time has already passed',
      );
    });

    it('is null when the occurrence matches and the start is still in the future', () => {
      const state: EntityState = { jobStatus: 'SCHEDULED', jobScheduledStart: FUTURE };
      const occurrence = FUTURE.toISOString();
      expect(terminalStaleReason('BEFORE_JOB_START', occurrence, state, NOW)).toBeNull();
    });

    it('is null when there is no occurrence to compare and the start is still in the future', () => {
      const state: EntityState = { jobStatus: 'SCHEDULED', jobScheduledStart: FUTURE };
      expect(terminalStaleReason('BEFORE_JOB_START', undefined, state, NOW)).toBeNull();
    });

    // Multi-visit S4 (D17) replaces the old ON_SITE case here, and the replacement is a real
    // BEHAVIOUR CHANGE rather than a fixture tidy-up, so it is asserted rather than deleted.
    //
    // Before S4 a technician marking themselves on site moved the JOB to ON_SITE, and this guard
    // suppressed the "your appointment is in 1 hour" reminder because the tech was already at the
    // door. ON_SITE has now retired from JobStatus and lives on VisitStatus, and D12 defines
    // IN_PROGRESS as "any visit STARTED" - so a job whose crew has arrived but not started reads
    // SCHEDULED, and the reminder is NO LONGER suppressed by arrival alone. Suppression now begins
    // when work actually starts (the IN_PROGRESS case directly below).
    it('still chases a job whose crew has arrived but not started, because arrival leaves it SCHEDULED', () => {
      const state: EntityState = { jobStatus: 'SCHEDULED', jobScheduledStart: FUTURE };
      expect(terminalStaleReason('BEFORE_JOB_START', undefined, state, NOW)).toBeNull();
    });

    it('is stale once the job is IN_PROGRESS (Spec B1, B-6)', () => {
      const state: EntityState = { jobStatus: 'IN_PROGRESS', jobScheduledStart: FUTURE };
      expect(terminalStaleReason('BEFORE_JOB_START', undefined, state, NOW)).toBe('Work has already started');
    });
  });

  describe('AFTER_JOB_COMPLETED', () => {
    it('is stale when the job is no longer marked completed', () => {
      const state: EntityState = { jobStatus: 'IN_PROGRESS' };
      expect(terminalStaleReason('AFTER_JOB_COMPLETED', undefined, state, NOW)).toBe(
        'Job is no longer marked completed',
      );
    });

    it('is null when the job is still completed', () => {
      const state: EntityState = { jobStatus: 'COMPLETED' };
      expect(terminalStaleReason('AFTER_JOB_COMPLETED', undefined, state, NOW)).toBeNull();
    });

    it('skips a run whose occurrence no longer matches the job\u2019s completed_at (Spec B1)', () => {
      // Complete -> backward move -> re-complete 20 min later. The FIRST run is now stale.
      const state: EntityState = { jobStatus: 'COMPLETED', jobCompletedAt: FUTURE };
      const occurrence = PAST.toISOString(); // this run's occurrence is the OLD completed_at
      expect(terminalStaleReason('AFTER_JOB_COMPLETED', occurrence, state, NOW)).toBe(
        'Job was re-completed — this run was replaced by an updated follow-up',
      );
    });

    it('fires a run whose occurrence still matches (Spec B1)', () => {
      const state: EntityState = { jobStatus: 'COMPLETED', jobCompletedAt: FUTURE };
      expect(terminalStaleReason('AFTER_JOB_COMPLETED', FUTURE.toISOString(), state, NOW)).toBeNull();
    });

    it('fires when no occurrence was recorded — defensive, never skip on missing data (Spec B1)', () => {
      const state: EntityState = { jobStatus: 'COMPLETED', jobCompletedAt: FUTURE };
      expect(terminalStaleReason('AFTER_JOB_COMPLETED', undefined, state, NOW)).toBeNull();
    });
  });

  describe('INVOICE_OVERDUE', () => {
    it('is stale when the invoice was paid', () => {
      const state: EntityState = { invoiceStatus: 'PAID' };
      expect(terminalStaleReason('INVOICE_OVERDUE', undefined, state, NOW)).toBe(
        'Invoice was paid — nothing to chase',
      );
    });

    it('is stale with a status-specific reason when the status is neither SENT nor PARTIAL', () => {
      const state: EntityState = { invoiceStatus: 'VOIDED' };
      expect(terminalStaleReason('INVOICE_OVERDUE', undefined, state, NOW)).toBe(
        'Invoice is voided — reminder not needed',
      );
    });

    it('is stale when the outstanding balance is zero or less', () => {
      const state: EntityState = { invoiceStatus: 'SENT', invoiceAmountDue: 0 };
      expect(terminalStaleReason('INVOICE_OVERDUE', undefined, state, NOW)).toBe(
        'Invoice has no outstanding balance',
      );
    });

    it('is null when SENT with an outstanding balance', () => {
      const state: EntityState = { invoiceStatus: 'SENT', invoiceAmountDue: 250 };
      expect(terminalStaleReason('INVOICE_OVERDUE', undefined, state, NOW)).toBeNull();
    });

    it('is null when PARTIAL with an outstanding balance', () => {
      const state: EntityState = { invoiceStatus: 'PARTIAL', invoiceAmountDue: 50 };
      expect(terminalStaleReason('INVOICE_OVERDUE', undefined, state, NOW)).toBeNull();
    });
  });

  describe('ESTIMATE_FOLLOW_UP', () => {
    it('is stale with a status-specific reason when the estimate was answered', () => {
      const state: EntityState = { estimateStatus: 'WON' };
      expect(terminalStaleReason('ESTIMATE_FOLLOW_UP', undefined, state, NOW)).toBe(
        'Estimate was won — follow-up not needed',
      );
    });

    it('is null when still SENT', () => {
      const state: EntityState = { estimateStatus: 'SENT' };
      expect(terminalStaleReason('ESTIMATE_FOLLOW_UP', undefined, state, NOW)).toBeNull();
    });

    it('is null when still PENDING', () => {
      const state: EntityState = { estimateStatus: 'PENDING' };
      expect(terminalStaleReason('ESTIMATE_FOLLOW_UP', undefined, state, NOW)).toBeNull();
    });
  });

  // ── Unified date-anchored triggers (Task A2/A5b) — bidirectional around the
  //    SAME anchor date. Each block below tests: direction:'before' on-track
  //    and already-passed, the direction:'after' contrast on the SAME
  //    anchor-passed state (the core bug this task fixes), direction-
  //    independent terminal states, and direction:undefined defensive
  //    fail-open behavior.
  describe('JOB_DATE_ANCHORED', () => {
    describe('direction: before', () => {
      it('is null when the job is on track and the start is still in the future', () => {
        const state: EntityState = { jobStatus: 'SCHEDULED', jobScheduledStart: FUTURE };
        expect(terminalStaleReason('JOB_DATE_ANCHORED', FUTURE.toISOString(), state, NOW, 'before')).toBeNull();
      });

      it('is stale once the start time has passed', () => {
        const state: EntityState = { jobStatus: 'SCHEDULED', jobScheduledStart: PAST };
        expect(terminalStaleReason('JOB_DATE_ANCHORED', PAST.toISOString(), state, NOW, 'before')).toBe(
          'Job start time has already passed',
        );
      });

      it('is stale when the job was completed early — before its scheduled start ever arrived', () => {
        // Spec B1 removed the ordering guard on complete() entirely — any status can complete,
        // including SCHEDULED, with no scheduled_start guard anywhere in job.controller.ts's
        // complete(). So scheduled_start can still be in the future when status flips to
        // COMPLETED. The already-passed check alone would miss this.
        const state: EntityState = { jobStatus: 'COMPLETED', jobScheduledStart: FUTURE };
        expect(terminalStaleReason('JOB_DATE_ANCHORED', FUTURE.toISOString(), state, NOW, 'before')).toBe(
          'Job was already completed',
        );
      });
    });

    describe('direction: after', () => {
      it('is null for the SAME anchor-passed state that is stale under before — the core direction contrast', () => {
        const state: EntityState = { jobStatus: 'SCHEDULED', jobScheduledStart: PAST };
        expect(terminalStaleReason('JOB_DATE_ANCHORED', PAST.toISOString(), state, NOW, 'before')).toBe(
          'Job start time has already passed',
        );
        expect(terminalStaleReason('JOB_DATE_ANCHORED', PAST.toISOString(), state, NOW, 'after')).toBeNull();
      });

      it('is null when the job is COMPLETED — the expected, desired state for an after-reminder', () => {
        const state: EntityState = { jobStatus: 'COMPLETED', jobScheduledStart: PAST };
        expect(terminalStaleReason('JOB_DATE_ANCHORED', PAST.toISOString(), state, NOW, 'after')).toBeNull();
      });
    });

    describe('direction-independent', () => {
      it('is stale when the job was cancelled, regardless of direction', () => {
        const state: EntityState = { jobStatus: 'CANCELLED', jobScheduledStart: FUTURE };
        expect(terminalStaleReason('JOB_DATE_ANCHORED', undefined, state, NOW, 'before')).toBe('Job was cancelled');
        expect(terminalStaleReason('JOB_DATE_ANCHORED', undefined, state, NOW, 'after')).toBe('Job was cancelled');
      });

      it('is stale when the job is no longer scheduled (null start), regardless of direction', () => {
        const state: EntityState = { jobStatus: 'UNSCHEDULED', jobScheduledStart: null };
        expect(terminalStaleReason('JOB_DATE_ANCHORED', undefined, state, NOW, 'before')).toBe('Job is no longer scheduled');
        expect(terminalStaleReason('JOB_DATE_ANCHORED', undefined, state, NOW, 'after')).toBe('Job is no longer scheduled');
      });

      it('is stale on an occurrence mismatch (rescheduled), regardless of direction', () => {
        const state: EntityState = { jobStatus: 'SCHEDULED', jobScheduledStart: FUTURE };
        const occurrence = '2026-07-16T15:00:00.000Z'; // different from FUTURE
        expect(terminalStaleReason('JOB_DATE_ANCHORED', occurrence, state, NOW, 'before')).toBe(
          'Job was rescheduled — this run was replaced by an updated reminder',
        );
        expect(terminalStaleReason('JOB_DATE_ANCHORED', occurrence, state, NOW, 'after')).toBe(
          'Job was rescheduled — this run was replaced by an updated reminder',
        );
      });
    });

    describe('direction: undefined (defensive — malformed trigger_config)', () => {
      it('does not apply the already-passed check — fails open like an after-direction reminder', () => {
        const state: EntityState = { jobStatus: 'SCHEDULED', jobScheduledStart: PAST };
        expect(terminalStaleReason('JOB_DATE_ANCHORED', PAST.toISOString(), state, NOW, undefined)).toBeNull();
      });

      it('does not apply the early-completion check either', () => {
        const state: EntityState = { jobStatus: 'COMPLETED', jobScheduledStart: FUTURE };
        expect(terminalStaleReason('JOB_DATE_ANCHORED', FUTURE.toISOString(), state, NOW, undefined)).toBeNull();
      });

      it('still catches direction-independent terminal states', () => {
        const state: EntityState = { jobStatus: 'CANCELLED', jobScheduledStart: FUTURE };
        expect(terminalStaleReason('JOB_DATE_ANCHORED', undefined, state, NOW, undefined)).toBe('Job was cancelled');
      });
    });
  });

  describe('LEAD_DATE_ANCHORED', () => {
    describe('direction: before', () => {
      it('is null when the walkthrough is still scheduled and in the future', () => {
        const state: EntityState = { leadStatus: 'CONTACTED', leadVisitStatus: 'SCHEDULED', leadWalkthroughScheduledAt: FUTURE };
        expect(terminalStaleReason('LEAD_DATE_ANCHORED', FUTURE.toISOString(), state, NOW, 'before')).toBeNull();
      });

      it('is stale once the walkthrough time has passed', () => {
        const state: EntityState = { leadStatus: 'CONTACTED', leadVisitStatus: 'SCHEDULED', leadWalkthroughScheduledAt: PAST };
        expect(terminalStaleReason('LEAD_DATE_ANCHORED', PAST.toISOString(), state, NOW, 'before')).toBe(
          'Walkthrough time has already passed',
        );
      });

      // Walkthrough-as-entity redesign, PR-B2: the "still pending" check now keys off the
      // VISIT's own status (leadVisitStatus), not lead.status — a lead can sit at any
      // LeadStatus (ESTIMATED, WON, CONTACTED, ...) while its current visit is REQUESTED/
      // COMPLETED/CANCELLED, and any of those non-SCHEDULED visit states is stale for 'before'.
      it.each(['COMPLETED', 'CANCELLED', 'REQUESTED'] as const)(
        'is stale when the current visit is %s — a before-reminder promises a STILL-pending walkthrough',
        (leadVisitStatus) => {
          const state: EntityState = { leadStatus: 'ESTIMATED', leadVisitStatus, leadWalkthroughScheduledAt: FUTURE };
          expect(terminalStaleReason('LEAD_DATE_ANCHORED', FUTURE.toISOString(), state, NOW, 'before')).toBe(
            `Walkthrough is ${leadVisitStatus.toLowerCase().replace(/_/g, ' ')} — reminder not needed`,
          );
        },
      );
    });

    describe('direction: after', () => {
      it('is null for the SAME anchor-passed state that is stale under before — the core direction contrast', () => {
        const state: EntityState = { leadStatus: 'CONTACTED', leadVisitStatus: 'SCHEDULED', leadWalkthroughScheduledAt: PAST };
        expect(terminalStaleReason('LEAD_DATE_ANCHORED', PAST.toISOString(), state, NOW, 'before')).toBe(
          'Walkthrough time has already passed',
        );
        expect(terminalStaleReason('LEAD_DATE_ANCHORED', PAST.toISOString(), state, NOW, 'after')).toBeNull();
      });

      it.each(['COMPLETED', 'CANCELLED'] as const)(
        'is null when the current visit is %s — normal forward progress by the time an after-reminder is due, not staleness',
        (leadVisitStatus) => {
          const state: EntityState = { leadStatus: 'ESTIMATED', leadVisitStatus, leadWalkthroughScheduledAt: PAST };
          expect(terminalStaleReason('LEAD_DATE_ANCHORED', PAST.toISOString(), state, NOW, 'after')).toBeNull();
        },
      );
    });

    describe('direction-independent', () => {
      it('is stale when the lead was marked lost, regardless of direction', () => {
        const state: EntityState = { leadStatus: 'LOST', leadWalkthroughScheduledAt: FUTURE };
        expect(terminalStaleReason('LEAD_DATE_ANCHORED', undefined, state, NOW, 'before')).toBe('Lead was marked as lost');
        expect(terminalStaleReason('LEAD_DATE_ANCHORED', undefined, state, NOW, 'after')).toBe('Lead was marked as lost');
      });

      it('is stale when the lead was cancelled, regardless of direction', () => {
        const state: EntityState = { leadStatus: 'CANCELLED', leadWalkthroughScheduledAt: FUTURE };
        expect(terminalStaleReason('LEAD_DATE_ANCHORED', undefined, state, NOW, 'before')).toBe('Lead was cancelled');
        expect(terminalStaleReason('LEAD_DATE_ANCHORED', undefined, state, NOW, 'after')).toBe('Lead was cancelled');
      });

      it('is stale when the walkthrough date was cleared (null), regardless of direction', () => {
        const state: EntityState = { leadStatus: 'CONTACTED', leadWalkthroughScheduledAt: null };
        expect(terminalStaleReason('LEAD_DATE_ANCHORED', undefined, state, NOW, 'before')).toBe(
          'Walkthrough is no longer scheduled',
        );
        expect(terminalStaleReason('LEAD_DATE_ANCHORED', undefined, state, NOW, 'after')).toBe(
          'Walkthrough is no longer scheduled',
        );
      });

      it('is stale on an occurrence mismatch (rescheduled), regardless of direction', () => {
        const state: EntityState = { leadStatus: 'CONTACTED', leadVisitStatus: 'SCHEDULED', leadWalkthroughScheduledAt: FUTURE };
        const occurrence = '2026-07-16T15:00:00.000Z'; // different from FUTURE
        expect(terminalStaleReason('LEAD_DATE_ANCHORED', occurrence, state, NOW, 'before')).toBe(
          'Walkthrough was rescheduled — this reminder was replaced by an updated one',
        );
        expect(terminalStaleReason('LEAD_DATE_ANCHORED', occurrence, state, NOW, 'after')).toBe(
          'Walkthrough was rescheduled — this reminder was replaced by an updated one',
        );
      });

      it('catches a lead lost AFTER the walkthrough completed — walkthrough_scheduled_at is only nulled by markLost when the lead WAS still SCHEDULED at loss time, so this is not redundant with the null-date check', () => {
        // lead.controller.ts markLost()/autoCancelScheduledWalkthroughOnLeadExit: the visit's
        // walkthrough_scheduled_at (legacy dual-write) is only nulled when there WAS a
        // SCHEDULED visit at the moment of loss/cancellation — a lead lost from ESTIMATED /
        // WALKTHROUGH_COMPLETED keeps its historical walkthrough date untouched, so an
        // explicit leadStatus check is load-bearing here.
        const state: EntityState = { leadStatus: 'LOST', leadWalkthroughScheduledAt: PAST };
        expect(terminalStaleReason('LEAD_DATE_ANCHORED', PAST.toISOString(), state, NOW, 'after')).toBe(
          'Lead was marked as lost',
        );
      });
    });

    describe('direction: undefined (defensive — malformed trigger_config)', () => {
      it('does not apply the already-passed check — fails open like an after-direction reminder', () => {
        const state: EntityState = { leadStatus: 'CONTACTED', leadVisitStatus: 'SCHEDULED', leadWalkthroughScheduledAt: PAST };
        expect(terminalStaleReason('LEAD_DATE_ANCHORED', PAST.toISOString(), state, NOW, undefined)).toBeNull();
      });

      it('does not apply the before-only exact-status-match check either', () => {
        const state: EntityState = { leadStatus: 'WON', leadVisitStatus: 'COMPLETED', leadWalkthroughScheduledAt: FUTURE };
        expect(terminalStaleReason('LEAD_DATE_ANCHORED', FUTURE.toISOString(), state, NOW, undefined)).toBeNull();
      });

      it('still catches direction-independent terminal states', () => {
        const state: EntityState = { leadStatus: 'LOST', leadWalkthroughScheduledAt: FUTURE };
        expect(terminalStaleReason('LEAD_DATE_ANCHORED', undefined, state, NOW, undefined)).toBe('Lead was marked as lost');
      });
    });
  });

  describe('INVOICE_DATE_ANCHORED', () => {
    describe('direction: before', () => {
      it('is null when SENT with a balance due and the due date is still in the future', () => {
        const state: EntityState = { invoiceStatus: 'SENT', invoiceAmountDue: 250, invoiceDueDate: FUTURE };
        expect(terminalStaleReason('INVOICE_DATE_ANCHORED', FUTURE.toISOString(), state, NOW, 'before')).toBeNull();
      });

      it('is stale once the due date has passed', () => {
        const state: EntityState = { invoiceStatus: 'SENT', invoiceAmountDue: 250, invoiceDueDate: PAST };
        expect(terminalStaleReason('INVOICE_DATE_ANCHORED', PAST.toISOString(), state, NOW, 'before')).toBe(
          'Invoice due date has already passed',
        );
      });
    });

    describe('direction: after', () => {
      it('is null for the SAME anchor-passed state that is stale under before — the core direction contrast', () => {
        const state: EntityState = { invoiceStatus: 'SENT', invoiceAmountDue: 250, invoiceDueDate: PAST };
        expect(terminalStaleReason('INVOICE_DATE_ANCHORED', PAST.toISOString(), state, NOW, 'before')).toBe(
          'Invoice due date has already passed',
        );
        expect(terminalStaleReason('INVOICE_DATE_ANCHORED', PAST.toISOString(), state, NOW, 'after')).toBeNull();
      });
    });

    describe('direction-independent', () => {
      it('is stale when the invoice was paid, regardless of direction', () => {
        const state: EntityState = { invoiceStatus: 'PAID', invoiceDueDate: FUTURE };
        expect(terminalStaleReason('INVOICE_DATE_ANCHORED', undefined, state, NOW, 'before')).toBe(
          'Invoice was paid — nothing to chase',
        );
        expect(terminalStaleReason('INVOICE_DATE_ANCHORED', undefined, state, NOW, 'after')).toBe(
          'Invoice was paid — nothing to chase',
        );
      });

      it('is stale with a status-specific reason for a non-SENT/PARTIAL status, regardless of direction', () => {
        const state: EntityState = { invoiceStatus: 'VOIDED', invoiceDueDate: FUTURE };
        expect(terminalStaleReason('INVOICE_DATE_ANCHORED', undefined, state, NOW, 'before')).toBe(
          'Invoice is voided — reminder not needed',
        );
        expect(terminalStaleReason('INVOICE_DATE_ANCHORED', undefined, state, NOW, 'after')).toBe(
          'Invoice is voided — reminder not needed',
        );
      });

      it('is stale when the outstanding balance is zero, regardless of direction', () => {
        const state: EntityState = { invoiceStatus: 'SENT', invoiceAmountDue: 0, invoiceDueDate: FUTURE };
        expect(terminalStaleReason('INVOICE_DATE_ANCHORED', undefined, state, NOW, 'before')).toBe(
          'Invoice has no outstanding balance',
        );
        expect(terminalStaleReason('INVOICE_DATE_ANCHORED', undefined, state, NOW, 'after')).toBe(
          'Invoice has no outstanding balance',
        );
      });

      it('is stale when the due date was cleared (null), regardless of direction', () => {
        const state: EntityState = { invoiceStatus: 'SENT', invoiceAmountDue: 250, invoiceDueDate: null };
        expect(terminalStaleReason('INVOICE_DATE_ANCHORED', undefined, state, NOW, 'before')).toBe(
          'Invoice no longer has a due date',
        );
        expect(terminalStaleReason('INVOICE_DATE_ANCHORED', undefined, state, NOW, 'after')).toBe(
          'Invoice no longer has a due date',
        );
      });

      it('is stale on an occurrence mismatch (due date edited), regardless of direction', () => {
        const state: EntityState = { invoiceStatus: 'SENT', invoiceAmountDue: 250, invoiceDueDate: FUTURE };
        const occurrence = '2026-07-16T15:00:00.000Z'; // different from FUTURE
        expect(terminalStaleReason('INVOICE_DATE_ANCHORED', occurrence, state, NOW, 'before')).toBe(
          'Invoice due date was changed — this run was replaced by an updated reminder',
        );
        expect(terminalStaleReason('INVOICE_DATE_ANCHORED', occurrence, state, NOW, 'after')).toBe(
          'Invoice due date was changed — this run was replaced by an updated reminder',
        );
      });
    });

    describe('direction: undefined (defensive — malformed trigger_config)', () => {
      it('does not apply the already-passed check — fails open like an after-direction reminder', () => {
        const state: EntityState = { invoiceStatus: 'SENT', invoiceAmountDue: 250, invoiceDueDate: PAST };
        expect(terminalStaleReason('INVOICE_DATE_ANCHORED', PAST.toISOString(), state, NOW, undefined)).toBeNull();
      });

      it('still catches direction-independent terminal states', () => {
        const state: EntityState = { invoiceStatus: 'PAID', invoiceDueDate: FUTURE };
        expect(terminalStaleReason('INVOICE_DATE_ANCHORED', undefined, state, NOW, undefined)).toBe(
          'Invoice was paid — nothing to chase',
        );
      });
    });
  });

  describe('ESTIMATE_DATE_ANCHORED', () => {
    describe('direction: before', () => {
      it('is null when SENT and the expiration is still in the future', () => {
        const state: EntityState = { estimateStatus: 'SENT', estimateValidUntil: FUTURE };
        expect(terminalStaleReason('ESTIMATE_DATE_ANCHORED', FUTURE.toISOString(), state, NOW, 'before')).toBeNull();
      });

      it('is stale once the expiration has passed', () => {
        const state: EntityState = { estimateStatus: 'SENT', estimateValidUntil: PAST };
        expect(terminalStaleReason('ESTIMATE_DATE_ANCHORED', PAST.toISOString(), state, NOW, 'before')).toBe(
          'Estimate expiration date has already passed',
        );
      });
    });

    describe('direction: after', () => {
      it('is null for the SAME anchor-passed state that is stale under before — the core direction contrast', () => {
        const state: EntityState = { estimateStatus: 'SENT', estimateValidUntil: PAST };
        expect(terminalStaleReason('ESTIMATE_DATE_ANCHORED', PAST.toISOString(), state, NOW, 'before')).toBe(
          'Estimate expiration date has already passed',
        );
        expect(terminalStaleReason('ESTIMATE_DATE_ANCHORED', PAST.toISOString(), state, NOW, 'after')).toBeNull();
      });
    });

    describe('direction-independent', () => {
      it('is stale with a status-specific reason when the estimate was answered, regardless of direction', () => {
        const state: EntityState = { estimateStatus: 'WON', estimateValidUntil: FUTURE };
        expect(terminalStaleReason('ESTIMATE_DATE_ANCHORED', undefined, state, NOW, 'before')).toBe(
          'Estimate was won — follow-up not needed',
        );
        expect(terminalStaleReason('ESTIMATE_DATE_ANCHORED', undefined, state, NOW, 'after')).toBe(
          'Estimate was won — follow-up not needed',
        );
      });

      it('is stale when declined, regardless of direction', () => {
        const state: EntityState = { estimateStatus: 'DECLINED', estimateValidUntil: PAST };
        expect(terminalStaleReason('ESTIMATE_DATE_ANCHORED', undefined, state, NOW, 'before')).toBe(
          'Estimate was declined — follow-up not needed',
        );
        expect(terminalStaleReason('ESTIMATE_DATE_ANCHORED', undefined, state, NOW, 'after')).toBe(
          'Estimate was declined — follow-up not needed',
        );
      });

      it('is stale when the expiration date was cleared (null), regardless of direction', () => {
        const state: EntityState = { estimateStatus: 'SENT', estimateValidUntil: null };
        expect(terminalStaleReason('ESTIMATE_DATE_ANCHORED', undefined, state, NOW, 'before')).toBe(
          'Estimate no longer has an expiration date',
        );
        expect(terminalStaleReason('ESTIMATE_DATE_ANCHORED', undefined, state, NOW, 'after')).toBe(
          'Estimate no longer has an expiration date',
        );
      });

      it('is stale on an occurrence mismatch (expiration edited), regardless of direction', () => {
        const state: EntityState = { estimateStatus: 'SENT', estimateValidUntil: FUTURE };
        const occurrence = '2026-07-16T15:00:00.000Z'; // different from FUTURE
        expect(terminalStaleReason('ESTIMATE_DATE_ANCHORED', occurrence, state, NOW, 'before')).toBe(
          'Estimate expiration date was changed — this run was replaced by an updated reminder',
        );
        expect(terminalStaleReason('ESTIMATE_DATE_ANCHORED', occurrence, state, NOW, 'after')).toBe(
          'Estimate expiration date was changed — this run was replaced by an updated reminder',
        );
      });
    });

    describe('direction: undefined (defensive — malformed trigger_config)', () => {
      it('does not apply the already-passed check — fails open like an after-direction reminder', () => {
        const state: EntityState = { estimateStatus: 'SENT', estimateValidUntil: PAST };
        expect(terminalStaleReason('ESTIMATE_DATE_ANCHORED', PAST.toISOString(), state, NOW, undefined)).toBeNull();
      });

      it('still catches direction-independent terminal states', () => {
        const state: EntityState = { estimateStatus: 'WON', estimateValidUntil: FUTURE };
        expect(terminalStaleReason('ESTIMATE_DATE_ANCHORED', undefined, state, NOW, undefined)).toBe(
          'Estimate was won — follow-up not needed',
        );
      });
    });
  });

  describe.each(['JOB_SCHEDULED', 'TECH_ASSIGNED'] as const)('%s', (trigger) => {
    it('is stale when the job was cancelled', () => {
      const state: EntityState = { jobStatus: 'CANCELLED' };
      expect(terminalStaleReason(trigger, undefined, state, NOW)).toBe('Job was cancelled');
    });

    it('is stale when the job was already completed', () => {
      const state: EntityState = { jobStatus: 'COMPLETED' };
      expect(terminalStaleReason(trigger, undefined, state, NOW)).toBe('Job was already completed');
    });

    it('is null otherwise', () => {
      const state: EntityState = { jobStatus: 'SCHEDULED' };
      expect(terminalStaleReason(trigger, undefined, state, NOW)).toBeNull();
    });
  });

  describe('JOB_RESCHEDULED', () => {
    it('is stale when the job was cancelled', () => {
      const state: EntityState = { jobStatus: 'CANCELLED', jobScheduledStart: FUTURE };
      expect(terminalStaleReason('JOB_RESCHEDULED', undefined, state, NOW)).toBe('Job was cancelled');
    });

    it('is stale when the job was already completed', () => {
      const state: EntityState = { jobStatus: 'COMPLETED', jobScheduledStart: FUTURE };
      expect(terminalStaleReason('JOB_RESCHEDULED', undefined, state, NOW)).toBe('Job was already completed');
    });

    it('is stale when a newer reschedule replaced this occurrence', () => {
      const state: EntityState = { jobStatus: 'SCHEDULED', jobScheduledStart: FUTURE };
      const occurrence = '2026-07-16T15:00:00.000Z';
      expect(terminalStaleReason('JOB_RESCHEDULED', occurrence, state, NOW)).toBe(
        'Job was rescheduled again — a newer notice replaced this one',
      );
    });

    it('is null when the occurrence matches the current scheduled_start', () => {
      const state: EntityState = { jobStatus: 'SCHEDULED', jobScheduledStart: FUTURE };
      expect(terminalStaleReason('JOB_RESCHEDULED', FUTURE.toISOString(), state, NOW)).toBeNull();
    });

    it('is null when there is no occurrence to compare', () => {
      const state: EntityState = { jobStatus: 'SCHEDULED', jobScheduledStart: FUTURE };
      expect(terminalStaleReason('JOB_RESCHEDULED', undefined, state, NOW)).toBeNull();
    });

    it('is null when there is no scheduled_start to compare against', () => {
      const state: EntityState = { jobStatus: 'SCHEDULED', jobScheduledStart: null };
      const occurrence = '2026-07-16T15:00:00.000Z';
      expect(terminalStaleReason('JOB_RESCHEDULED', occurrence, state, NOW)).toBeNull();
    });
  });

  describe('INVOICE_SENT', () => {
    it('is stale when the invoice was voided', () => {
      const state: EntityState = { invoiceStatus: 'VOIDED' };
      expect(terminalStaleReason('INVOICE_SENT', undefined, state, NOW)).toBe('Invoice was voided');
    });

    it('is stale when the invoice was already paid', () => {
      const state: EntityState = { invoiceStatus: 'PAID' };
      expect(terminalStaleReason('INVOICE_SENT', undefined, state, NOW)).toBe('Invoice was already paid');
    });

    it('is null otherwise', () => {
      const state: EntityState = { invoiceStatus: 'SENT' };
      expect(terminalStaleReason('INVOICE_SENT', undefined, state, NOW)).toBeNull();
    });
  });

  describe('ESTIMATE_SENT', () => {
    it('is stale with a status-specific reason when the estimate was answered', () => {
      const state: EntityState = { estimateStatus: 'DECLINED' };
      expect(terminalStaleReason('ESTIMATE_SENT', undefined, state, NOW)).toBe(
        'Estimate was declined — no longer awaiting a response',
      );
    });

    it('is null when still SENT', () => {
      const state: EntityState = { estimateStatus: 'SENT' };
      expect(terminalStaleReason('ESTIMATE_SENT', undefined, state, NOW)).toBeNull();
    });

    it('is null when still PENDING', () => {
      const state: EntityState = { estimateStatus: 'PENDING' };
      expect(terminalStaleReason('ESTIMATE_SENT', undefined, state, NOW)).toBeNull();
    });
  });

  // Walkthrough-as-entity redesign, PR-B2: keys off the VISIT's own status
  // (leadVisitStatus), not lead.status — scheduleWalkthrough no longer writes
  // WALKTHROUGH_SCHEDULED onto the lead at all (D5: NEW -> CONTACTED only).
  describe.each(['WALKTHROUGH_SCHEDULED', 'WALKTHROUGH_RESCHEDULED'] as const)('%s', (trigger) => {
    describe.each(['COMPLETED', 'CANCELLED', 'REQUESTED'] as const)(
      'when the current visit is %s',
      (leadVisitStatus) => {
        it('is stale — walkthrough reminder not needed', () => {
          const state: EntityState = { leadStatus: 'ESTIMATED', leadVisitStatus, leadWalkthroughScheduledAt: FUTURE };
          expect(terminalStaleReason(trigger, undefined, state, NOW)).toBe(
            `Walkthrough is ${leadVisitStatus.toLowerCase().replace(/_/g, ' ')} — reminder not needed`,
          );
        });
      },
    );

    it('is stale when the walkthrough is no longer scheduled (null date)', () => {
      const state: EntityState = { leadStatus: 'CONTACTED', leadVisitStatus: 'SCHEDULED', leadWalkthroughScheduledAt: null };
      expect(terminalStaleReason(trigger, undefined, state, NOW)).toBe('Walkthrough is no longer scheduled');
    });

    it('is stale when the walkthrough time has already passed', () => {
      const state: EntityState = { leadStatus: 'CONTACTED', leadVisitStatus: 'SCHEDULED', leadWalkthroughScheduledAt: PAST };
      expect(terminalStaleReason(trigger, undefined, state, NOW)).toBe('Walkthrough time has already passed');
    });

    it('is stale when the walkthrough time equals now exactly (<=)', () => {
      const state: EntityState = { leadStatus: 'CONTACTED', leadVisitStatus: 'SCHEDULED', leadWalkthroughScheduledAt: NOW };
      expect(terminalStaleReason(trigger, undefined, state, NOW)).toBe('Walkthrough time has already passed');
    });

    it('is stale when the occurrence no longer matches the current walkthrough time (rescheduled)', () => {
      const state: EntityState = { leadStatus: 'CONTACTED', leadVisitStatus: 'SCHEDULED', leadWalkthroughScheduledAt: FUTURE };
      const occurrence = '2026-07-16T15:00:00.000Z'; // different from FUTURE
      expect(terminalStaleReason(trigger, occurrence, state, NOW)).toBe(
        'Walkthrough was rescheduled — this reminder was replaced by an updated one',
      );
    });

    it('is null when the occurrence matches and the walkthrough is still in the future', () => {
      const state: EntityState = { leadStatus: 'CONTACTED', leadVisitStatus: 'SCHEDULED', leadWalkthroughScheduledAt: FUTURE };
      const occurrence = FUTURE.toISOString();
      expect(terminalStaleReason(trigger, occurrence, state, NOW)).toBeNull();
    });

    it('is null when there is no occurrence to compare and the walkthrough is still in the future', () => {
      const state: EntityState = { leadStatus: 'CONTACTED', leadVisitStatus: 'SCHEDULED', leadWalkthroughScheduledAt: FUTURE };
      expect(terminalStaleReason(trigger, undefined, state, NOW)).toBeNull();
    });
  });

  describe.each([
    'JOB_COMPLETED',
    'JOB_CANCELLED',
    'INVOICE_PAID',
    'ESTIMATE_APPROVED',
    'ESTIMATE_DECLINED',
    'LEAD_CREATED',
  ] as const)('%s (state-of-being events)', (trigger) => {
    it('is always null — the event stays message-valid regardless of later state', () => {
      const state: EntityState = {
        jobStatus: 'CANCELLED',
        invoiceStatus: 'VOIDED',
        estimateStatus: 'DECLINED',
      };
      expect(terminalStaleReason(trigger, undefined, state, NOW)).toBeNull();
    });
  });

  // ── Regression: the new optional 5th `direction` parameter must have ZERO
  //    effect on every pre-existing (legacy) trigger — they never had a
  //    direction concept, and BEFORE_JOB_START's "already passed" check in
  //    particular must NOT become direction-gated as a side effect of adding
  //    that same check to JOB_DATE_ANCHORED above. One case per legacy
  //    "family" (offset-based BEFORE/date trigger, event trigger, invoice
  //    time trigger, estimate time trigger) proves the omitted-vs-'before'-
  //    vs-'after'-vs-explicit-undefined call forms are all byte-identical.
  describe('regression — legacy triggers ignore the new direction parameter', () => {
    it('BEFORE_JOB_START: the already-passed check fires the same way no matter what direction is passed', () => {
      const state: EntityState = { jobStatus: 'SCHEDULED', jobScheduledStart: PAST };
      const omitted = terminalStaleReason('BEFORE_JOB_START', undefined, state, NOW);
      expect(omitted).toBe('Job start time has already passed');
      expect(terminalStaleReason('BEFORE_JOB_START', undefined, state, NOW, 'before')).toBe(omitted);
      expect(terminalStaleReason('BEFORE_JOB_START', undefined, state, NOW, 'after')).toBe(omitted);
      expect(terminalStaleReason('BEFORE_JOB_START', undefined, state, NOW, undefined)).toBe(omitted);
    });

    it('BEFORE_JOB_START: the not-stale (future start) branch is also unaffected', () => {
      const state: EntityState = { jobStatus: 'SCHEDULED', jobScheduledStart: FUTURE };
      const omitted = terminalStaleReason('BEFORE_JOB_START', undefined, state, NOW);
      expect(omitted).toBeNull();
      expect(terminalStaleReason('BEFORE_JOB_START', undefined, state, NOW, 'before')).toBeNull();
      expect(terminalStaleReason('BEFORE_JOB_START', undefined, state, NOW, 'after')).toBeNull();
    });

    it('WALKTHROUGH_SCHEDULED: unaffected by direction', () => {
      const state: EntityState = { leadStatus: 'ESTIMATED', leadVisitStatus: 'COMPLETED', leadWalkthroughScheduledAt: FUTURE };
      const omitted = terminalStaleReason('WALKTHROUGH_SCHEDULED', undefined, state, NOW);
      expect(omitted).toBe('Walkthrough is completed — reminder not needed');
      expect(terminalStaleReason('WALKTHROUGH_SCHEDULED', undefined, state, NOW, 'before')).toBe(omitted);
      expect(terminalStaleReason('WALKTHROUGH_SCHEDULED', undefined, state, NOW, 'after')).toBe(omitted);
    });

    it('INVOICE_OVERDUE: unaffected by direction', () => {
      const state: EntityState = { invoiceStatus: 'SENT', invoiceAmountDue: 250 };
      const omitted = terminalStaleReason('INVOICE_OVERDUE', undefined, state, NOW);
      expect(omitted).toBeNull();
      expect(terminalStaleReason('INVOICE_OVERDUE', undefined, state, NOW, 'before')).toBeNull();
      expect(terminalStaleReason('INVOICE_OVERDUE', undefined, state, NOW, 'after')).toBeNull();
    });

    it('ESTIMATE_FOLLOW_UP: unaffected by direction', () => {
      const state: EntityState = { estimateStatus: 'SENT' };
      const omitted = terminalStaleReason('ESTIMATE_FOLLOW_UP', undefined, state, NOW);
      expect(omitted).toBeNull();
      expect(terminalStaleReason('ESTIMATE_FOLLOW_UP', undefined, state, NOW, 'before')).toBeNull();
      expect(terminalStaleReason('ESTIMATE_FOLLOW_UP', undefined, state, NOW, 'after')).toBeNull();
    });
  });
});
