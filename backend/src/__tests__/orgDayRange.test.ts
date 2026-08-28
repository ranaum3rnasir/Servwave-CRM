import { describe, it, expect } from 'vitest';
import { isBareOrgDay, addOrgDays, orgDayStart, orgDayRange } from '../lib/orgDayRange';

// America/New_York is the org zone the bug was found in (UTC-4 in August, so a UTC-anchored
// boundary lands at 8:00 PM the PREVIOUS evening). Asia/Manila is the discriminating fixture
// the frontend's date suites already use — UTC+8, i.e. the offset points the OTHER way, so a
// test that passes in both cannot be accidentally satisfied by a fixed-direction offset.
const NY = 'America/New_York';
const MANILA = 'Asia/Manila';

describe('isBareOrgDay', () => {
  it('accepts a zoneless calendar day', () => {
    expect(isBareOrgDay('2026-08-24')).toBe(true);
  });

  it('rejects a full ISO instant — this is what keeps the schedule board on its old path', () => {
    expect(isBareOrgDay('2026-08-24T21:00:00.000Z')).toBe(false);
    expect(isBareOrgDay('2026-08-24T00:00:00')).toBe(false);
  });

  it('rejects non-strings and empties', () => {
    expect(isBareOrgDay(undefined)).toBe(false);
    expect(isBareOrgDay('')).toBe(false);
    expect(isBareOrgDay(20260824)).toBe(false);
  });
});

describe('addOrgDays', () => {
  it('steps whole calendar days', () => {
    expect(addOrgDays('2026-08-24', 1)).toBe('2026-08-25');
    expect(addOrgDays('2026-08-24', -1)).toBe('2026-08-23');
  });

  it('rolls over month and year ends', () => {
    expect(addOrgDays('2026-08-31', 1)).toBe('2026-09-01');
    expect(addOrgDays('2026-12-31', 1)).toBe('2027-01-01');
  });

  it('crosses a DST boundary as a CALENDAR step, not a 24h step', () => {
    // 2026-03-08 is spring-forward in the US: that org day is only 23 hours long. Counting
    // in days rather than milliseconds is what keeps this exact.
    expect(addOrgDays('2026-03-07', 1)).toBe('2026-03-08');
    expect(addOrgDays('2026-03-08', 1)).toBe('2026-03-09');
  });
});

describe('orgDayStart', () => {
  it('anchors on the ORG midnight, not UTC midnight', () => {
    // New York in August is UTC-4, so the day begins at 04:00Z.
    expect(orgDayStart('2026-08-24', NY).toISOString()).toBe('2026-08-24T04:00:00.000Z');
    // Manila is UTC+8, so its day begins the PREVIOUS UTC day at 16:00Z — the opposite sign.
    expect(orgDayStart('2026-08-24', MANILA).toISOString()).toBe('2026-08-23T16:00:00.000Z');
  });

  it('tracks the offset change across DST rather than assuming a fixed one', () => {
    // EST (UTC-5) before spring-forward, EDT (UTC-4) after.
    expect(orgDayStart('2026-03-07', NY).toISOString()).toBe('2026-03-07T05:00:00.000Z');
    expect(orgDayStart('2026-03-09', NY).toISOString()).toBe('2026-03-09T04:00:00.000Z');
  });
});

describe('orgDayRange: the "to" day is INCLUSIVE', () => {
  it('a single-day range is a real 24h window, not the zero-width one that made "Today" empty', () => {
    const range = orgDayRange('2026-08-24', '2026-08-24', NY);
    expect(range).toEqual({
      gte: new Date('2026-08-24T04:00:00.000Z'),
      lt: new Date('2026-08-25T04:00:00.000Z'),
    });
  });

  it('MATCHES the reported repro: a 5:00 PM org-time visit on the "to" day is inside the window', () => {
    // J00312's visit — 2026-08-24T21:00:00Z is 5:00 PM in New York on Aug 24.
    const visit = new Date('2026-08-24T21:00:00.000Z');
    const range = orgDayRange('2026-08-24', '2026-08-24', NY)!;
    expect(visit >= range.gte!).toBe(true);
    expect(visit < range.lt!).toBe(true);
  });

  it('EXCLUDES an instant that is already the next ORG day though it is the same UTC day', () => {
    // 2026-08-25T02:00:00Z is 10:00 PM Aug 24 in New York — still inside.
    expect(new Date('2026-08-25T02:00:00.000Z') < orgDayRange('2026-08-24', '2026-08-24', NY)!.lt!).toBe(true);
    // 2026-08-25T05:00:00Z is 1:00 AM Aug 25 in New York — outside.
    expect(new Date('2026-08-25T05:00:00.000Z') < orgDayRange('2026-08-24', '2026-08-24', NY)!.lt!).toBe(false);
  });

  it('EXCLUDES the evening BEFORE the _after edge, which the UTC cut used to let in', () => {
    // 21:00 New York on Aug 23 is 2026-08-24T01:00:00Z — the next UTC day, so a UTC-anchored
    // `gte` admitted it. On the org clock it is the day before the range starts.
    const range = orgDayRange('2026-08-24', '2026-08-24', NY)!;
    expect(new Date('2026-08-24T01:00:00.000Z') >= range.gte!).toBe(false);
  });

  it('keeps the last day of a MULTI-day range, which the old bound dropped', () => {
    const range = orgDayRange('2026-08-23', '2026-08-24', NY)!;
    // A visit at 5:00 PM on Aug 24 (the "to" day) must be in the window.
    expect(new Date('2026-08-24T21:00:00.000Z') < range.lt!).toBe(true);
  });

  it('is inclusive in a UTC+ zone too', () => {
    const range = orgDayRange('2026-08-24', '2026-08-24', MANILA);
    expect(range).toEqual({
      gte: new Date('2026-08-23T16:00:00.000Z'),
      lt: new Date('2026-08-24T16:00:00.000Z'),
    });
  });

  it('spans the extra hour on a fall-back day rather than a flat 24h', () => {
    // 2026-11-01 is fall-back in the US: that org day is 25 hours long.
    const range = orgDayRange('2026-11-01', '2026-11-01', NY)!;
    expect(range.lt!.getTime() - range.gte!.getTime()).toBe(25 * 3_600_000);
  });
});

describe('orgDayRange: full ISO instants are left exactly as they were', () => {
  it('keeps gte/lte semantics for the schedule board, byte-for-byte', () => {
    // What useScheduleData.ts sends: toInstant(...).toISOString() on both ends.
    const after = '2026-08-24T04:00:00.000Z';
    const before = '2026-08-25T03:59:59.999Z';
    expect(orgDayRange(after, before, NY)).toEqual({
      gte: new Date(after),
      lte: new Date(before),
    });
  });

  it('does not resolve an instant through the org zone', () => {
    // The same instant in two different org zones must produce the same bound.
    const iso = '2026-08-24T21:00:00.000Z';
    expect(orgDayRange(iso, undefined, NY)).toEqual(orgDayRange(iso, undefined, MANILA));
  });
});

describe('orgDayRange: partial and empty input', () => {
  it('sets only the bound that is present', () => {
    expect(orgDayRange('2026-08-24', undefined, NY)).toEqual({
      gte: new Date('2026-08-24T04:00:00.000Z'),
    });
    expect(orgDayRange(undefined, '2026-08-24', NY)).toEqual({
      lt: new Date('2026-08-25T04:00:00.000Z'),
    });
  });

  it('resolves each bound independently when the shapes are MIXED', () => {
    const range = orgDayRange('2026-08-24T21:00:00.000Z', '2026-08-25', NY);
    expect(range).toEqual({
      gte: new Date('2026-08-24T21:00:00.000Z'),
      lt: new Date('2026-08-26T04:00:00.000Z'),
    });
  });

  it('returns null when there is nothing to filter on, so `where` is left untouched', () => {
    expect(orgDayRange(undefined, undefined, NY)).toBeNull();
    expect(orgDayRange('', '', NY)).toBeNull();
  });
});
