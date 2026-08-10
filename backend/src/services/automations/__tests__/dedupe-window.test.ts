import { describe, it, expect } from 'vitest';
import { buildDedupeKey } from '../dedupe';
import { shiftIntoWindow } from '../sendWindow';

describe('buildDedupeKey', () => {
  const JOB = 'aaaaaaaa-0000-0000-0000-000000000001';

  it('is once-per-entity for plain event triggers', () => {
    expect(buildDedupeKey('ESTIMATE_APPROVED', JOB)).toBe(`ESTIMATE_APPROVED:${JOB}`);
    expect(buildDedupeKey('INVOICE_PAID', JOB)).toBe(`INVOICE_PAID:${JOB}`);
  });

  it('encodes the occurrence for occurrence-scoped triggers', () => {
    const iso = '2026-07-14T13:00:00.000Z';
    expect(buildDedupeKey('JOB_RESCHEDULED', JOB, iso)).toBe(`JOB_RESCHEDULED:${JOB}:${iso}`);
    expect(buildDedupeKey('BEFORE_JOB_START', JOB, iso)).toBe(`BEFORE_JOB_START:${JOB}:${iso}`);
    expect(buildDedupeKey('TECH_ASSIGNED', JOB, 'user-1')).toBe(`TECH_ASSIGNED:${JOB}:user-1`);
  });

  it('a reschedule produces a different key than the original occurrence (re-arms reminders)', () => {
    const a = buildDedupeKey('BEFORE_JOB_START', JOB, '2026-07-14T13:00:00.000Z');
    const b = buildDedupeKey('BEFORE_JOB_START', JOB, '2026-07-15T13:00:00.000Z');
    expect(a).not.toBe(b);
  });

  it('throws when an occurrence-scoped trigger is missing its occurrence', () => {
    expect(() => buildDedupeKey('BEFORE_JOB_START', JOB)).toThrow(/occurrence/);
  });

  it('scopes walkthrough scheduled/rescheduled by the walkthrough-date ISO', () => {
    expect(buildDedupeKey('WALKTHROUGH_SCHEDULED', 'lead1', '2026-08-01T15:00:00Z')).toBe('WALKTHROUGH_SCHEDULED:lead1:2026-08-01T15:00:00Z');
    expect(buildDedupeKey('WALKTHROUGH_RESCHEDULED', 'lead1', '2026-08-02T15:00:00Z')).toBe('WALKTHROUGH_RESCHEDULED:lead1:2026-08-02T15:00:00Z');
  });

  it('scopes performer-assigned + lead-assigned by user id', () => {
    expect(buildDedupeKey('WALKTHROUGH_PERFORMER_ASSIGNED', 'lead1', 'user9')).toBe('WALKTHROUGH_PERFORMER_ASSIGNED:lead1:user9');
    expect(buildDedupeKey('LEAD_ASSIGNED', 'lead1', 'user9')).toBe('LEAD_ASSIGNED:lead1:user9');
  });

  // Removing two different people from the same job/lead must be TWO
  // occurrences — scoped by the removed person's id, mirroring the
  // corresponding *_ASSIGNED trigger just above.
  it('scopes removed-crew + removed-performer by the removed user id', () => {
    expect(buildDedupeKey('TECH_UNASSIGNED', JOB, 'user9')).toBe(`TECH_UNASSIGNED:${JOB}:user9`);
    expect(buildDedupeKey('WALKTHROUGH_PERFORMER_REMOVED', 'lead1', 'user9')).toBe('WALKTHROUGH_PERFORMER_REMOVED:lead1:user9');
  });

  // A job can only re-enter EN_ROUTE after a fresh SCHEDULED transition, so this
  // fires at most once per en_route_at — but scoping it anyway mirrors
  // JOB_RESCHEDULED's ISO-occurrence pattern rather than assuming that
  // invariant holds forever.
  it('scopes en-route by the en_route_at ISO', () => {
    const iso = '2026-07-21T15:00:00.000Z';
    expect(buildDedupeKey('JOB_EN_ROUTE', JOB, iso)).toBe(`JOB_EN_ROUTE:${JOB}:${iso}`);
  });

  // SRVW-113 — a job cycling A -> B -> A must re-fire on returning to A, so the
  // key is scoped by sub_status_id, not just the trigger + entity.
  it('scopes sub-status-entered by the sub_status_id (a job cycling A -> B -> A re-fires)', () => {
    expect(buildDedupeKey('JOB_SUB_STATUS_ENTERED', JOB, 'sub-status-1')).toBe(
      `JOB_SUB_STATUS_ENTERED:${JOB}:sub-status-1`,
    );
    expect(() => buildDedupeKey('JOB_SUB_STATUS_ENTERED', JOB)).toThrow(/occurrence/);
  });

  it('fires once (not occurrence-scoped) for completed + cancelled', () => {
    expect(buildDedupeKey('WALKTHROUGH_COMPLETED', 'lead1')).toBe('WALKTHROUGH_COMPLETED:lead1');
    expect(buildDedupeKey('WALKTHROUGH_CANCELLED', 'lead1')).toBe('WALKTHROUGH_CANCELLED:lead1');
  });

  // Task A6b: the four unified date-anchored triggers (Task A2) must be occurrence-scoped
  // the same way the legacy 8 already are, or a moved anchor date (rescheduled job,
  // extended invoice due date, ...) silently fails to re-arm its reminder.
  it('encodes the occurrence for the four date-anchored triggers (Task A6b)', () => {
    const iso = '2026-08-01T15:00:00.000Z';
    expect(buildDedupeKey('JOB_DATE_ANCHORED', JOB, iso)).toBe(`JOB_DATE_ANCHORED:${JOB}:${iso}`);
    expect(buildDedupeKey('LEAD_DATE_ANCHORED', 'lead1', iso)).toBe(`LEAD_DATE_ANCHORED:lead1:${iso}`);
    expect(buildDedupeKey('INVOICE_DATE_ANCHORED', 'inv-1', iso)).toBe(`INVOICE_DATE_ANCHORED:inv-1:${iso}`);
    expect(buildDedupeKey('ESTIMATE_DATE_ANCHORED', 'est-1', iso)).toBe(`ESTIMATE_DATE_ANCHORED:est-1:${iso}`);
  });

  it('a moved anchor date produces a different key for each date-anchored trigger (re-arms the reminder)', () => {
    // Mirrors the brief's concrete scenario: an invoice due date extended two weeks must
    // produce a fresh dedupe key so scanDateAnchorTriggers's re-enrollment on the new date
    // isn't silently swallowed by the (workflow_id, dedupe_key) unique constraint.
    const invoiceBefore = buildDedupeKey('INVOICE_DATE_ANCHORED', 'inv-1', '2026-07-01T00:00:00.000Z');
    const invoiceAfter = buildDedupeKey('INVOICE_DATE_ANCHORED', 'inv-1', '2026-07-15T00:00:00.000Z');
    expect(invoiceBefore).not.toBe(invoiceAfter);

    const jobA = buildDedupeKey('JOB_DATE_ANCHORED', JOB, '2026-07-14T13:00:00.000Z');
    const jobB = buildDedupeKey('JOB_DATE_ANCHORED', JOB, '2026-07-16T13:00:00.000Z');
    expect(jobA).not.toBe(jobB);

    const leadA = buildDedupeKey('LEAD_DATE_ANCHORED', 'lead1', '2026-08-01T15:00:00.000Z');
    const leadB = buildDedupeKey('LEAD_DATE_ANCHORED', 'lead1', '2026-08-02T15:00:00.000Z');
    expect(leadA).not.toBe(leadB);

    const estA = buildDedupeKey('ESTIMATE_DATE_ANCHORED', 'est-1', '2026-07-20T00:00:00.000Z');
    const estB = buildDedupeKey('ESTIMATE_DATE_ANCHORED', 'est-1', '2026-08-03T00:00:00.000Z');
    expect(estA).not.toBe(estB);
  });

  it('throws when a date-anchored trigger is missing its occurrence', () => {
    expect(() => buildDedupeKey('JOB_DATE_ANCHORED', JOB)).toThrow(/occurrence/);
    expect(() => buildDedupeKey('LEAD_DATE_ANCHORED', 'lead1')).toThrow(/occurrence/);
    expect(() => buildDedupeKey('INVOICE_DATE_ANCHORED', 'inv-1')).toThrow(/occurrence/);
    expect(() => buildDedupeKey('ESTIMATE_DATE_ANCHORED', 'est-1')).toThrow(/occurrence/);
  });
});

describe('shiftIntoWindow (BUSINESS_HOURS = 08:00–20:00 org-local)', () => {
  const NY = 'America/New_York';

  it('ANYTIME passes through unchanged', () => {
    const d = new Date('2026-07-14T02:30:00.000Z');
    expect(shiftIntoWindow(d, 'ANYTIME', NY).getTime()).toBe(d.getTime());
  });

  it('inside the window passes through unchanged', () => {
    // 2026-07-14 15:00 UTC = 11:00 New York (EDT, UTC-4)
    const d = new Date('2026-07-14T15:00:00.000Z');
    expect(shiftIntoWindow(d, 'BUSINESS_HOURS', NY).getTime()).toBe(d.getTime());
  });

  it('too early shifts to 08:00 the same local day', () => {
    // 2026-07-14 09:30 UTC = 05:30 New York → 08:00 New York = 12:00 UTC
    const d = new Date('2026-07-14T09:30:00.000Z');
    expect(shiftIntoWindow(d, 'BUSINESS_HOURS', NY).toISOString()).toBe('2026-07-14T12:00:00.000Z');
  });

  it('too late shifts to 08:00 the NEXT local day', () => {
    // 2026-07-14 02:00 UTC = Jul 13 22:00 New York → Jul 14 08:00 NY = 12:00 UTC
    const d = new Date('2026-07-14T02:00:00.000Z');
    expect(shiftIntoWindow(d, 'BUSINESS_HOURS', NY).toISOString()).toBe('2026-07-14T12:00:00.000Z');
  });

  it('exactly 20:00 local is out of window (shifts to next morning)', () => {
    // 2026-07-15 00:00 UTC = Jul 14 20:00 New York → Jul 15 08:00 NY = 12:00 UTC
    const d = new Date('2026-07-15T00:00:00.000Z');
    expect(shiftIntoWindow(d, 'BUSINESS_HOURS', NY).toISOString()).toBe('2026-07-15T12:00:00.000Z');
  });

  it('works for UTC-timezone orgs too', () => {
    const d = new Date('2026-07-14T21:15:00.000Z'); // 21:15 UTC-local → next day 08:00 UTC
    expect(shiftIntoWindow(d, 'BUSINESS_HOURS', 'UTC').toISOString()).toBe('2026-07-15T08:00:00.000Z');
  });

  it('never throws on a garbage org timezone — falls back to the default (America/New_York)', () => {
    const d = new Date('2026-07-14T09:30:00.000Z'); // 05:30 NY → 08:00 NY = 12:00 UTC under the fallback
    expect(() => shiftIntoWindow(d, 'BUSINESS_HOURS', 'Not/AZone')).not.toThrow();
    expect(shiftIntoWindow(d, 'BUSINESS_HOURS', 'Not/AZone').toISOString()).toBe('2026-07-14T12:00:00.000Z');
    // empty string too
    expect(() => shiftIntoWindow(d, 'BUSINESS_HOURS', '')).not.toThrow();
  });
});
