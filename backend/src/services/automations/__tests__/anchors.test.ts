import { describe, it, expect } from 'vitest';
import { anchorDateFor, isAnchoredWait, describeAnchoredWait, ANCHORS_FOR_ENTITY, ANCHOR_LABELS, type AnchorKey } from '../anchors';
import type { EntityState } from '../context';

describe('anchors', () => {
  it('reads the job start from state', () => {
    const d = new Date('2026-08-01T15:00:00Z');
    expect(anchorDateFor('job.scheduled_start', { jobScheduledStart: d })).toEqual(d);
  });
  it('reads the walkthrough time from state', () => {
    const d = new Date('2026-08-01T15:00:00Z');
    expect(anchorDateFor('lead.walkthrough_scheduled_at', { leadWalkthroughScheduledAt: d })).toEqual(d);
  });
  it('returns null when the anchor date is unset', () => {
    expect(anchorDateFor('job.scheduled_start', {})).toBeNull();
  });
  it('detects an anchored wait config by mode', () => {
    expect(isAnchoredWait({ mode: 'anchored', anchor: 'job.scheduled_start', direction: 'before', offset_minutes: 1440 })).toBe(true);
    expect(isAnchoredWait({ duration_minutes: 60 })).toBe(false);
  });
  it('humanizes the anchored wait for the activity log', () => {
    expect(describeAnchoredWait({ mode: 'anchored', anchor: 'lead.walkthrough_scheduled_at', direction: 'before', offset_minutes: 1440 }))
      .toBe('1 day before the walkthrough time');
  });
});

describe('anchors — invoice + estimate', () => {
  it('offers a due-date anchor for invoices and an expiration anchor for estimates', () => {
    expect(ANCHORS_FOR_ENTITY.invoice).toEqual(['invoice.due_date']);
    expect(ANCHORS_FOR_ENTITY.estimate).toEqual(['estimate.valid_until']);
  });

  it('reads the invoice due date off EntityState', () => {
    const due = new Date('2026-08-01T12:00:00.000Z');
    const state = { invoiceDueDate: due } as unknown as EntityState;
    expect(anchorDateFor('invoice.due_date', state)?.toISOString()).toBe(due.toISOString());
  });

  it('reads the estimate expiration off EntityState', () => {
    const exp = new Date('2026-08-05T12:00:00.000Z');
    const state = { estimateValidUntil: exp } as unknown as EntityState;
    expect(anchorDateFor('estimate.valid_until', state)?.toISOString()).toBe(exp.toISOString());
  });

  it('returns null when the anchor date is absent', () => {
    expect(anchorDateFor('invoice.due_date', {} as EntityState)).toBeNull();
    expect(anchorDateFor('estimate.valid_until', {} as EntityState)).toBeNull();
  });

  it('labels every anchor with the approved mockup wording', () => {
    const expected: Record<AnchorKey, string> = {
      'job.scheduled_start': 'the appointment',
      'lead.walkthrough_scheduled_at': 'the walkthrough',
      'invoice.due_date': 'the invoice due date',
      'estimate.valid_until': 'the estimate expiration',
    };
    expect(ANCHOR_LABELS).toEqual(expected);
  });
});
