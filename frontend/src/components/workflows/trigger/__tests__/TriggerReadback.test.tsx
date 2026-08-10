import { describe, it, expect } from 'vitest';
import { screen, within } from '@testing-library/react';
import { renderWithProviders } from '@/__tests__/helpers';
import TriggerReadback from '../TriggerReadback';
import type { TriggerSelection } from '@/lib/workflows/triggerModel';
import type { WorkflowCatalog } from '@/lib/api/workflows';
import { UNIT_MINUTES, type OffsetUnit } from '@/lib/workflows/timing';

/**
 * A trimmed but shape-faithful catalog (same trimming approach as
 * EventModePanel.test.tsx's/SubjectPicker.test.tsx's CATALOG fixtures), plus
 * the `anchors` slice this component additionally reads (not needed by those
 * two siblings). Anchor labels are the exact strings already established as
 * fixtures elsewhere in this same PR (DateModePanel.test.tsx's "the
 * appointment", ModeFork.test.tsx's "the invoice due date") or, where no
 * prior fixture exists (estimate, lead), the mockup's own SUBJECTS.*.anchor.word
 * ("the estimate expiration", "the walkthrough").
 */
const CATALOG = {
  triggers: {
    INVOICE_PAID: {
      label: 'Invoice is paid',
      description: 'Fires when an invoice is paid in full.',
      category: 'events',
      entity: 'invoice',
      timeBased: false,
      mergeFields: [],
    },
    JOB_COMPLETED: {
      label: 'Job is completed',
      description: 'Fires when a job is marked complete.',
      category: 'events',
      entity: 'job',
      timeBased: false,
      mergeFields: [],
    },
    ESTIMATE_APPROVED: {
      label: 'Estimate is approved',
      description: 'Fires when the customer accepts.',
      category: 'events',
      entity: 'estimate',
      timeBased: false,
      mergeFields: [],
    },
  },
  anchors: {
    job: [{ key: 'job.scheduled_start', label: 'the appointment' }],
    estimate: [{ key: 'estimate.valid_until', label: 'the estimate expiration' }],
    invoice: [{ key: 'invoice.due_date', label: 'the invoice due date' }],
    lead: [{ key: 'lead.walkthrough_scheduled_at', label: 'the walkthrough' }],
  },
} as unknown as WorkflowCatalog;

/** The exact rule-1 note copy, verbatim from the task brief / mockup, with {anchorLabel} substituted. */
function ruleOneNoteText(anchorLabel: string): string {
  return (
    `If ${anchorLabel} is still coming up but it’s too late for the full head start, we send right away. ` +
    `If ${anchorLabel} has already passed, we skip it — no reminder for something that’s over.`
  );
}

function dateSelection(overrides: Partial<TriggerSelection> = {}): TriggerSelection {
  return {
    subject: 'invoice',
    mode: 'date',
    anchor: 'invoice.due_date',
    direction: 'before',
    offsetMinutes: 1440,
    ...overrides,
  };
}

function sentenceText(): string {
  return screen.getByRole('status').textContent ?? '';
}

describe('TriggerReadback', () => {
  describe('date mode sentences', () => {
    it('1 day before → "The day before the invoice due date, send the customer an email." (singular, no "1 days")', () => {
      renderWithProviders(
        <TriggerReadback selection={dateSelection({ direction: 'before', offsetMinutes: 1440 })} catalog={CATALOG} />,
      );
      expect(sentenceText()).toBe('The day before the invoice due date, send the customer an email.');
    });

    it('1 day after → "The day after the invoice due date, send the customer an email."', () => {
      renderWithProviders(
        <TriggerReadback selection={dateSelection({ direction: 'after', offsetMinutes: 1440 })} catalog={CATALOG} />,
      );
      expect(sentenceText()).toBe('The day after the invoice due date, send the customer an email.');
    });

    it('3 days before → "3 days before the invoice due date, send the customer an email."', () => {
      renderWithProviders(
        <TriggerReadback selection={dateSelection({ direction: 'before', offsetMinutes: 4320 })} catalog={CATALOG} />,
      );
      expect(sentenceText()).toBe('3 days before the invoice due date, send the customer an email.');
    });

    it('3 days after → "3 days after the invoice due date, send the customer an email." (brief\'s exact example)', () => {
      renderWithProviders(
        <TriggerReadback selection={dateSelection({ direction: 'after', offsetMinutes: 4320 })} catalog={CATALOG} />,
      );
      expect(sentenceText()).toBe('3 days after the invoice due date, send the customer an email.');
    });

    it('0 offset before → "Just before the invoice due date, send the customer an email." (never "0 hours before")', () => {
      renderWithProviders(
        <TriggerReadback selection={dateSelection({ direction: 'before', offsetMinutes: 0 })} catalog={CATALOG} />,
      );
      expect(sentenceText()).toBe('Just before the invoice due date, send the customer an email.');
    });

    it('0 offset after → "Right after the invoice due date, send the customer an email."', () => {
      renderWithProviders(
        <TriggerReadback selection={dateSelection({ direction: 'after', offsetMinutes: 0 })} catalog={CATALOG} />,
      );
      expect(sentenceText()).toBe('Right after the invoice due date, send the customer an email.');
    });

    it('1 hour before (singular, non-day unit) → "1 hour before …" — not "The day before"', () => {
      renderWithProviders(
        <TriggerReadback selection={dateSelection({ direction: 'before', offsetMinutes: 60 })} catalog={CATALOG} />,
      );
      expect(sentenceText()).toBe('1 hour before the invoice due date, send the customer an email.');
    });

    it('2 hours after (DateModePanel preset parity) → "2 hours after …"', () => {
      renderWithProviders(
        <TriggerReadback selection={dateSelection({ direction: 'after', offsetMinutes: 120 })} catalog={CATALOG} />,
      );
      expect(sentenceText()).toBe('2 hours after the invoice due date, send the customer an email.');
    });

    it('1 minute before (singular, minutes unit) → "1 minute before …"', () => {
      renderWithProviders(
        <TriggerReadback selection={dateSelection({ direction: 'before', offsetMinutes: 1 })} catalog={CATALOG} />,
      );
      expect(sentenceText()).toBe('1 minute before the invoice due date, send the customer an email.');
    });

    it('a stored 2-week (20160min) offset renders as "14 days" — matches DateModePanel’s own splitOffset precedent', () => {
      renderWithProviders(
        <TriggerReadback selection={dateSelection({ direction: 'before', offsetMinutes: 20160 })} catalog={CATALOG} />,
      );
      expect(sentenceText()).toBe('14 days before the invoice due date, send the customer an email.');
    });

    it('uses the job subject’s own anchor label ("the appointment"), not the invoice one', () => {
      renderWithProviders(
        <TriggerReadback
          selection={{ subject: 'job', mode: 'date', anchor: 'job.scheduled_start', direction: 'before', offsetMinutes: 1440 }}
          catalog={CATALOG}
        />,
      );
      expect(sentenceText()).toBe('The day before the appointment, send the customer an email.');
    });
  });

  describe('event mode sentences (no-wait only — TriggerSelection has no wait field, see component docblock)', () => {
    it('invoice paid → "The moment an invoice is paid, send the customer an email." (brief\'s exact example, no-wait variant)', () => {
      renderWithProviders(
        <TriggerReadback selection={{ subject: 'invoice', mode: 'event', eventTrigger: 'INVOICE_PAID' }} catalog={CATALOG} />,
      );
      expect(sentenceText()).toBe('The moment an invoice is paid, send the customer an email.');
    });

    it('job completed → "a job" article (consonant-led noun)', () => {
      renderWithProviders(
        <TriggerReadback selection={{ subject: 'job', mode: 'event', eventTrigger: 'JOB_COMPLETED' }} catalog={CATALOG} />,
      );
      expect(sentenceText()).toBe('The moment a job is completed, send the customer an email.');
    });

    it('estimate approved → "an estimate" article (vowel-led noun)', () => {
      renderWithProviders(
        <TriggerReadback selection={{ subject: 'estimate', mode: 'event', eventTrigger: 'ESTIMATE_APPROVED' }} catalog={CATALOG} />,
      );
      expect(sentenceText()).toBe('The moment an estimate is approved, send the customer an email.');
    });
  });

  describe('rule-1 note — only for direction === "before" date selections', () => {
    it('appears for a "before" date selection, with the exact verbatim copy', () => {
      renderWithProviders(
        <TriggerReadback selection={dateSelection({ direction: 'before', offsetMinutes: 1440 })} catalog={CATALOG} />,
      );
      const note = screen.getByTestId('trigger-readback-note');
      expect(note).toHaveTextContent(ruleOneNoteText('the invoice due date'));
      // the two emphasized phrases are genuinely present as distinct text, not just substrings of other words
      expect(within(note).getByText('still coming up')).toBeInTheDocument();
      expect(within(note).getByText('already passed')).toBeInTheDocument();
    });

    it('still appears for the 0-offset "Just before" case (not gated on the offset amount)', () => {
      renderWithProviders(
        <TriggerReadback selection={dateSelection({ direction: 'before', offsetMinutes: 0 })} catalog={CATALOG} />,
      );
      expect(screen.getByTestId('trigger-readback-note')).toBeInTheDocument();
    });

    it('is absent for an "after" date selection', () => {
      renderWithProviders(
        <TriggerReadback selection={dateSelection({ direction: 'after', offsetMinutes: 1440 })} catalog={CATALOG} />,
      );
      expect(screen.queryByTestId('trigger-readback-note')).not.toBeInTheDocument();
    });

    it('is absent for event mode', () => {
      renderWithProviders(
        <TriggerReadback selection={{ subject: 'invoice', mode: 'event', eventTrigger: 'INVOICE_PAID' }} catalog={CATALOG} />,
      );
      expect(screen.queryByTestId('trigger-readback-note')).not.toBeInTheDocument();
    });

    it('uses the anchor label matching the selection’s own subject, not a hardcoded one', () => {
      renderWithProviders(
        <TriggerReadback
          selection={{ subject: 'job', mode: 'date', anchor: 'job.scheduled_start', direction: 'before', offsetMinutes: 1440 }}
          catalog={CATALOG}
        />,
      );
      expect(screen.getByTestId('trigger-readback-note')).toHaveTextContent(ruleOneNoteText('the appointment'));
    });
  });

  describe('incomplete selections render gracefully (no crash, no fabricated timing/event)', () => {
    it('event mode with no eventTrigger chosen yet shows a placeholder, not a crash', () => {
      renderWithProviders(<TriggerReadback selection={{ subject: 'invoice', mode: 'event' }} catalog={CATALOG} />);
      expect(sentenceText()).not.toMatch(/send the customer an email/);
      expect(screen.queryByTestId('trigger-readback-note')).not.toBeInTheDocument();
    });

    it('date mode with anchor picked but no timing chosen yet shows a placeholder, not a crash', () => {
      renderWithProviders(
        <TriggerReadback selection={{ subject: 'invoice', mode: 'date', anchor: 'invoice.due_date' }} catalog={CATALOG} />,
      );
      expect(sentenceText()).not.toMatch(/send the customer an email/);
      expect(screen.queryByTestId('trigger-readback-note')).not.toBeInTheDocument();
    });

    it('date mode with nothing at all chosen yet (bare subject+mode) shows a placeholder, not a crash', () => {
      renderWithProviders(<TriggerReadback selection={{ subject: 'invoice', mode: 'date' }} catalog={CATALOG} />);
      expect(sentenceText()).not.toMatch(/send the customer an email/);
      expect(screen.queryByTestId('trigger-readback-note')).not.toBeInTheDocument();
    });
  });

  describe('number-wording regression guard', () => {
    // Every unit × a spread of amounts × both directions — the exact matrix the task's
    // "lesson carried forward" asks for, computed from the same UNIT_MINUTES the
    // component itself sources `splitOffset` from (no independent arithmetic to drift).
    const UNITS: OffsetUnit[] = ['minutes', 'hours', 'days'];
    const AMOUNTS = [0, 1, 2, 3, 5, 10];
    const DIRECTIONS = ['before', 'after'] as const;

    const cases = DIRECTIONS.flatMap((direction) =>
      UNITS.flatMap((unit) =>
        AMOUNTS.map((n) => ({ direction, unit, n, offsetMinutes: n * UNIT_MINUTES[unit] })),
      ),
    );

    it.each(cases)(
      'never renders "1 $unit-with-s" or "0 hours/minutes/days" for n=$n $unit $direction',
      ({ direction, offsetMinutes }) => {
        renderWithProviders(
          <TriggerReadback selection={dateSelection({ direction, offsetMinutes })} catalog={CATALOG} />,
        );
        const text = sentenceText();
        expect(text).not.toMatch(/\b1 (minutes|hours|days)\b/);
        expect(text).not.toMatch(/\b0 (minute|minutes|hour|hours|day|days)\b/);
        // sanity: every case in this matrix is a *complete* date selection, so it must
        // still render the real sentence, not silently fall back to the empty placeholder.
        expect(text).toMatch(/send the customer an email\.$/);
      },
    );

    // The brief's literal `/1 days|0 hours/` regex, checked verbatim against the brief's own
    // named canonical scenarios (1 day, 3 days, 0 offset — before AND after). NOT run across the
    // full generated `cases` matrix above: that regex has no `\b` word boundaries, so it's a loose
    // substring match — "10 hours" (a legitimate, correctly-pluralized value already covered and
    // passing in the `\b`-bounded sweep above) contains the substring "0 hours" and would falsely
    // trip it. The `\b`-bounded sweep above is the real, mathematically-correct regression guard
    // across arbitrary N; this test satisfies the brief's exact literal assertion against the
    // specific inputs it was clearly written for.
    it('the brief’s literal /1 days|0 hours/ regex never matches for the named canonical scenarios', () => {
      const scenarios = [
        { direction: 'before' as const, offsetMinutes: 1440 }, // 1 day before
        { direction: 'after' as const, offsetMinutes: 1440 }, // 1 day after
        { direction: 'before' as const, offsetMinutes: 4320 }, // 3 days before
        { direction: 'after' as const, offsetMinutes: 4320 }, // 3 days after
        { direction: 'before' as const, offsetMinutes: 0 }, // 0 offset before
        { direction: 'after' as const, offsetMinutes: 0 }, // 0 offset after
      ];
      for (const { direction, offsetMinutes } of scenarios) {
        const { unmount } = renderWithProviders(
          <TriggerReadback selection={dateSelection({ direction, offsetMinutes })} catalog={CATALOG} />,
        );
        expect(sentenceText()).not.toMatch(/1 days|0 hours/);
        unmount();
      }
    });
  });

  describe('visual chrome (ServWave tokens, verbatim label)', () => {
    it('renders the mockup’s "This automation will…" label', () => {
      renderWithProviders(
        <TriggerReadback selection={dateSelection()} catalog={CATALOG} />,
      );
      expect(screen.getByText('This automation will…')).toBeInTheDocument();
    });
  });
});
