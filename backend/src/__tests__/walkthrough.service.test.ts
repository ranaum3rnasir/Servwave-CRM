import { describe, it, expect } from 'vitest';
import {
  resolveCurrentWalkthrough,
  projectLegacyWalkthroughFields,
  projectLeadWalkthroughFields,
} from '../services/walkthrough.service';

// D15: "Current visit" = the next upcoming SCHEDULED visit; if none upcoming, the most recent visit
// that happened (completed or cancelled). One rule, reused by updateWalkthrough's write target, the
// four legacy-shaped SELECT/serialize sites, and the automation merge fields.
describe('resolveCurrentWalkthrough', () => {
  const base = {
    id: 'w1', status: 'REQUESTED' as const, scheduled_at: null, duration_minutes: null,
    completed_at: null, notes: null, cancelled_at: null, cancelled_reason: null,
    cancelled_by: null, customer_email_sent_at: null, created_at: new Date('2026-01-01'),
  };

  it('returns null for an empty list (fresh lead, only ever REQUESTED)', () => {
    expect(resolveCurrentWalkthrough([])).toBeNull();
  });

  it('a REQUESTED-only visit is not "current" - nothing has happened yet', () => {
    expect(resolveCurrentWalkthrough([{ ...base, status: 'REQUESTED' }])).toBeNull();
  });

  it('a SCHEDULED visit is current even alongside older happened visits', () => {
    const completed = { ...base, id: 'w-old', status: 'COMPLETED' as const, completed_at: new Date('2026-02-01') };
    const scheduled = { ...base, id: 'w-new', status: 'SCHEDULED' as const, scheduled_at: new Date('2026-04-01') };
    expect(resolveCurrentWalkthrough([completed, scheduled])?.id).toBe('w-new');
  });

  it('with no SCHEDULED visit, the most recently COMPLETED one is current', () => {
    const older = { ...base, id: 'w-older', status: 'COMPLETED' as const, completed_at: new Date('2026-02-01') };
    const newer = { ...base, id: 'w-newer', status: 'COMPLETED' as const, completed_at: new Date('2026-03-01') };
    expect(resolveCurrentWalkthrough([older, newer])?.id).toBe('w-newer');
  });

  it('a later CANCELLED visit outranks an earlier COMPLETED one', () => {
    const completed = { ...base, id: 'w-completed', status: 'COMPLETED' as const, completed_at: new Date('2026-02-01') };
    const cancelled = { ...base, id: 'w-cancelled', status: 'CANCELLED' as const, cancelled_at: new Date('2026-03-01') };
    expect(resolveCurrentWalkthrough([completed, cancelled])?.id).toBe('w-cancelled');
  });
});

describe('projectLegacyWalkthroughFields', () => {
  const base = {
    id: 'w1', status: 'REQUESTED' as const, scheduled_at: null, duration_minutes: null,
    completed_at: null, notes: null, cancelled_at: null, cancelled_reason: null,
    cancelled_by: null, customer_email_sent_at: null, created_at: new Date('2026-01-01'),
  };

  it('an empty/REQUESTED-only walkthrough list projects every field to null', () => {
    expect(projectLegacyWalkthroughFields(undefined, { full: true })).toEqual({
      walkthrough_scheduled_at: null,
      walkthrough_completed_at: null,
      walkthrough_duration_minutes: null,
      walkthrough_notes: null,
      walkthrough_cancelled_at: null,
      walkthrough_cancelled_reason: null,
      walkthrough_cancelled_by: null,
      walkthrough_canceller: null,
      walkthrough_customer_email_sent_at: null,
      walkthrough_count: 0,
      walkthrough_history: [],
    });
  });

  it('a SCHEDULED current visit projects scheduled_at/duration but NOT completed_at (D15 incoherence fix)', () => {
    const scheduled = { ...base, status: 'SCHEDULED' as const, scheduled_at: new Date('2026-04-01'), duration_minutes: 45 };
    const fields = projectLegacyWalkthroughFields([scheduled], { full: false });
    expect(fields.walkthrough_scheduled_at).toEqual(new Date('2026-04-01'));
    expect(fields.walkthrough_completed_at).toBeNull();
    expect(fields.walkthrough_duration_minutes).toBe(45);
  });

  it('a COMPLETED current visit projects completed_at and notes; list mode omits the detail-only keys', () => {
    const completed = { ...base, status: 'COMPLETED' as const, completed_at: new Date('2026-04-05'), notes: 'All good' };
    const full = projectLegacyWalkthroughFields([completed], { full: true });
    expect(full.walkthrough_completed_at).toEqual(new Date('2026-04-05'));
    expect(full.walkthrough_notes).toBe('All good');

    const list = projectLegacyWalkthroughFields([completed], { full: false });
    expect(list).not.toHaveProperty('walkthrough_notes');
    expect(list.walkthrough_completed_at).toEqual(new Date('2026-04-05'));
  });

  it('a CANCELLED current visit projects cancellation fields, never completed_at', () => {
    const cancelled = {
      ...base, status: 'CANCELLED' as const, cancelled_at: new Date('2026-04-10'),
      cancelled_reason: 'Customer rescheduled', cancelled_by: 'user-1',
    };
    const fields = projectLegacyWalkthroughFields([cancelled], { full: true });
    expect(fields.walkthrough_cancelled_at).toEqual(new Date('2026-04-10'));
    expect(fields.walkthrough_cancelled_reason).toBe('Customer rescheduled');
    expect(fields.walkthrough_cancelled_by).toBe('user-1');
    expect(fields.walkthrough_completed_at).toBeNull();
  });

  // PR-C2: WALKTHROUGH_SCHEDULED/WALKTHROUGH_COMPLETED left LeadStatus, so LeadDetailPage's
  // walkthrough tab can no longer branch on lead.status to show "how many visits, and what
  // happened on the earlier ones" - it needs that off the wire. full mode only (list mode has
  // never carried per-visit detail, same reasoning as walkthrough_notes above).
  it('full mode also projects walkthrough_count and a newest-first walkthrough_history', () => {
    const older = { ...base, id: 'w-older', status: 'CANCELLED' as const, cancelled_at: new Date('2026-02-01'), created_at: new Date('2026-01-15') };
    const current = { ...base, id: 'w-current', status: 'SCHEDULED' as const, scheduled_at: new Date('2026-04-01'), created_at: new Date('2026-03-20') };
    const fields = projectLegacyWalkthroughFields([older, current], { full: true });
    expect(fields.walkthrough_count).toBe(2);
    expect((fields.walkthrough_history as Array<{ id: string }>).map((w) => w.id)).toEqual(['w-current', 'w-older']);
  });

  it('list mode omits walkthrough_count and walkthrough_history', () => {
    const fields = projectLegacyWalkthroughFields([{ ...base }], { full: false });
    expect(fields).not.toHaveProperty('walkthrough_count');
    expect(fields).not.toHaveProperty('walkthrough_history');
  });

  it('an empty walkthrough list projects walkthrough_count: 0 and an empty history', () => {
    const fields = projectLegacyWalkthroughFields(undefined, { full: true });
    expect(fields.walkthrough_count).toBe(0);
    expect(fields.walkthrough_history).toEqual([]);
  });
});

// Reused at every SELECT/serialize site the PR-D2 gap flagged (lead.controller.ts's
// leadListSelect/leadDetailSelect, estimate/job's lead-nested selects, search's LEAD_SELECT).
describe('projectLeadWalkthroughFields', () => {
  it('a no-op when the object never selected `walkthroughs` at all (untouched callers)', () => {
    // Real objects like this never fail the generic constraint (they're never bare literals at the
    // call site - see estimate.controller.ts/job.controller.ts's `as never` casts); the `as never`
    // here only works around TS's weak-type check on an inline object literal with zero properties
    // in common with `{ walkthroughs?: ... }`, not a production concern.
    const lead = { id: 'lead-1', status: 'NEW' };
    expect(projectLeadWalkthroughFields(lead as never, { full: true })).toBe(lead);
  });

  it('projects an empty walkthroughs array to null fields, not a skip (the `in` check)', () => {
    const lead = { id: 'lead-1', walkthroughs: [] };
    const out = projectLeadWalkthroughFields(lead, { full: false }) as Record<string, unknown>;
    expect(out.walkthrough_scheduled_at).toBeNull();
    expect(out).not.toHaveProperty('walkthroughs');
  });

  it('sources walkthrough_scheduled_at from the relation and strips the raw walkthroughs key', () => {
    const scheduled = {
      id: 'w1', status: 'SCHEDULED' as const, scheduled_at: new Date('2026-05-01'), duration_minutes: 60,
      completed_at: null, notes: null, cancelled_at: null, cancelled_reason: null,
      cancelled_by: null, customer_email_sent_at: null, created_at: new Date('2026-04-01'),
    };
    const lead = { id: 'lead-1', status: 'CONTACTED', walkthroughs: [scheduled] };
    const out = projectLeadWalkthroughFields(lead, { full: false }) as Record<string, unknown>;
    expect(out.walkthrough_scheduled_at).toEqual(new Date('2026-05-01'));
    expect(out).not.toHaveProperty('walkthroughs');
    expect(out.id).toBe('lead-1');
  });
});
