import { describe, it, expect } from 'vitest';
import { calendarEntryToEvent, jobToEvents, walkthroughToEvent } from './eventAdapters';

/**
 * Multi-visit S6 turned `jobToEvent` into `jobToEvents`, one event per live visit. Every case
 * below feeds a job with NO visits array, which is exactly the fallback the slice preserves: one
 * event off the D14 mirror, keyed on the bare job id. This helper keeps those cases asserting
 * that fallback rather than being deleted with the old name.
 */
const jobToEvent = (job: Record<string, unknown>, tz: string) => jobToEvents(job, tz)[0]!;
import { toInstant } from '@/lib/schedule-tz';

const NY = 'America/New_York';
const MANILA = 'Asia/Manila';

const job = {
  id: 'job-1', job_number: 'J00041', status: 'SCHEDULED',
  scope_notes: 'Install HVAC',
  scheduled_start: '2026-06-10T09:00:00.000Z', scheduled_end: '2026-06-10T11:00:00.000Z',
  customer: { first_name: 'Lee', last_name: 'Adams', company_name: null },
  assignees: [{ user: { id: 'u-alice', first_name: 'Alice', last_name: 'Ng' } }],
  estimate: { lead: { commission_owner: { id: 'u-eve', first_name: 'Eve', last_name: 'Park' } } },
};
const lead = {
  id: 'lead-9', lead_number: 'L00012',
  walkthrough_scheduled_at: '2026-06-10T13:00:00.000Z', walkthrough_duration_minutes: 90,
  customer: { first_name: 'Lee', last_name: 'Adams', company_name: 'Lee Co' },
  walkthrough_performers: [{ user: { id: 'u-eve', first_name: 'Eve', last_name: 'Park' } }],
  commission_owner: { id: 'u-eve', first_name: 'Eve', last_name: 'Park' },
};

describe('jobToEvent (converts at the read boundary — start/end become the org-tz WallClock)', () => {
  it('maps id, number, crew ids, owner, and a WallClock start/end in the given tz', () => {
    const e = jobToEvent(job, NY);
    expect(e).toMatchObject({ boardId: 'job-1', parentId: 'job-1', type: 'job', number: 'J00041', crew: ['u-alice'], ownerId: 'u-eve' });
    // 2026-06-10T09:00:00Z is 05:00 EDT (June is DST) — the WallClock's local digits read that.
    expect(e.start?.getHours()).toBe(5);
    expect(e.start?.getMinutes()).toBe(0);
    expect(e.end?.getHours()).toBe(7);
    expect(e.raw).toBe(job);
  });
  it('the WallClock round-trips back to the exact stored instant via toInstant', () => {
    const e = jobToEvent(job, NY);
    expect(toInstant(e.start!, NY).toISOString()).toBe(job.scheduled_start);
    expect(toInstant(e.end!, NY).toISOString()).toBe(job.scheduled_end);
  });
  it('unscheduled job → null start/end (state 1/3)', () => {
    const e = jobToEvent({ ...job, scheduled_start: null, scheduled_end: null }, NY);
    expect(e.start).toBeNull();
    expect(e.end).toBeNull();
  });
  it('crew-less job → empty crew (state 4 when timed)', () => {
    expect(jobToEvent({ ...job, assignees: [] }, NY).crew).toEqual([]);
  });
  it('start set, scheduled_end null → end synthesized as start + 120m default, in wall-clock space', () => {
    const e = jobToEvent({ ...job, scheduled_end: null }, NY);
    expect(e.start?.getHours()).toBe(5);
    expect(e.end?.getHours()).toBe(7); // +120m
  });
  it('customer null → customer field falls back to "Customer"', () => {
    const e = jobToEvent({ ...job, customer: null }, NY);
    expect(e.customer).toBe('Customer');
  });
  // SRVW-58 - tag chips on the board read event.tags, not event.raw.tags.
  it('carries tags through from the job payload', () => {
    const tags = [{ id: 't-1', name: 'VIP', color: '#EF4444' }];
    expect(jobToEvent({ ...job, tags }, NY).tags).toEqual(tags);
  });
  it('no tags key on the payload → empty array, never undefined', () => {
    expect(jobToEvent(job, NY).tags).toEqual([]);
  });
  it('a non-DST org tz (Manila) reads its own offset, not New York\'s', () => {
    // 2026-06-10T09:00:00Z is 17:00 in Asia/Manila (UTC+8, no DST).
    const e = jobToEvent(job, MANILA);
    expect(e.start?.getHours()).toBe(17);
  });
});

describe('walkthroughToEvent (converts at the read boundary — start/end become the org-tz WallClock)', () => {
  it('id is wt-prefixed; crew = performers; owner = commission_owner; end = start + duration', () => {
    const e = walkthroughToEvent(lead, NY);
    expect(e).toMatchObject({ boardId: 'wt-lead-9', parentId: 'lead-9', type: 'walkthrough', number: 'L00012', crew: ['u-eve'], ownerId: 'u-eve' });
    // 2026-06-10T13:00:00Z is 09:00 EDT.
    expect(e.start?.getHours()).toBe(9);
    expect(e.end?.getHours()).toBe(10);
    expect(e.end?.getMinutes()).toBe(30); // +90m
    expect(e.title).toContain('Lee Co'); // company name preferred
  });
  it('the WallClock round-trips back to the exact stored instant via toInstant', () => {
    const e = walkthroughToEvent(lead, NY);
    expect(toInstant(e.start!, NY).toISOString()).toBe(lead.walkthrough_scheduled_at);
  });
  it('unscheduled walkthrough → null start/end', () => {
    const e = walkthroughToEvent({ ...lead, walkthrough_scheduled_at: null }, NY);
    expect(e.start).toBeNull();
    expect(e.end).toBeNull();
  });
  it('walkthrough_duration_minutes null → end = start + 60m default', () => {
    const e = walkthroughToEvent({ ...lead, walkthrough_duration_minutes: null }, NY);
    expect(e.start?.getHours()).toBe(9);
    expect(e.end?.getHours()).toBe(10); // +60m
    expect(e.end?.getMinutes()).toBe(0);
  });
  // SRVW-58 - the /api/leads payload already carries tags (withTagsMany).
  it('carries tags through from the lead payload', () => {
    const tags = [{ id: 't-2', name: 'Recurring billing', color: '#2F7D5D' }];
    expect(walkthroughToEvent({ ...lead, tags }, NY).tags).toEqual(tags);
  });
  it('no tags key on the payload → empty array, never undefined', () => {
    expect(walkthroughToEvent(lead, NY).tags).toEqual([]);
  });
});

describe('calendarEntryToEvent (slice 03 — the CalendarEntry read boundary, ADR 0002)', () => {
  const entry = {
    id: 'entry-abc123',
    title: 'Dave is off Thursday',
    description: '',
    start: '2026-06-10T09:00:00.000Z',
    end: '2026-06-10T11:00:00.000Z',
    is_all_day: false,
  };

  it('boardId is ce-<id>; number is empty (spec §2 — no record number, title alone)', () => {
    const e = calendarEntryToEvent(entry, NY);
    expect(e.boardId).toBe('ce-entry-abc123');
    expect(e.parentId).toBe('entry-abc123');
    expect(e.type).toBe('calendar-entry');
    expect(e.number).toBe('');
    expect(e.title).toBe('Dave is off Thursday');
  });

  it('crew is empty and ownerId is null — an entry joins nothing (ADR 0002)', () => {
    const e = calendarEntryToEvent(entry, NY);
    expect(e.crew).toEqual([]);
    expect(e.ownerId).toBeNull();
    expect(e.customer).toBe('');
  });

  it('start/end are the org-zone WallClock, not the browser zone', () => {
    // 2026-06-10T09:00:00Z is 05:00 EDT (June is DST) in New York.
    const e = calendarEntryToEvent(entry, NY);
    expect(e.start?.getHours()).toBe(5);
    expect(e.end?.getHours()).toBe(7);
    // A different org tz reads its own offset, not New York's — proves the conversion happens
    // here, at the read boundary, using the passed tz (2026-06-10T09:00:00Z is 17:00 in Manila).
    const eManila = calendarEntryToEvent(entry, MANILA);
    expect(eManila.start?.getHours()).toBe(17);
  });

  it('the WallClock round-trips back to the exact stored instant via toInstant', () => {
    const e = calendarEntryToEvent(entry, NY);
    expect(toInstant(e.start!, NY).toISOString()).toBe(entry.start);
    expect(toInstant(e.end!, NY).toISOString()).toBe(entry.end);
  });

  it('carries the raw entry through for downstream reads', () => {
    expect(calendarEntryToEvent(entry, NY).raw).toBe(entry);
  });

  it('tags is always empty — a calendar entry does not carry tag chips', () => {
    expect(calendarEntryToEvent(entry, NY).tags).toEqual([]);
  });
});

describe('calendarEntryToEvent — participantUserIds (slice 06, member column placement)', () => {
  const entry = {
    id: 'entry-abc123',
    title: 'Dave is off Thursday',
    description: '',
    start: '2026-06-10T09:00:00.000Z',
    end: '2026-06-10T11:00:00.000Z',
    is_all_day: false,
  };

  it('fills participantUserIds from USER participants; CUSTOMER rows are excluded', () => {
    const withParticipants = {
      ...entry,
      participants: [
        { kind: 'USER', user_id: 'u-dave', customer_id: null, first_name: 'Dave', last_name: 'Ng' },
        { kind: 'CUSTOMER', user_id: null, customer_id: 'c-1', name: 'Acme Co' },
      ],
    };
    const e = calendarEntryToEvent(withParticipants, NY);
    expect(e.participantUserIds).toEqual(['u-dave']);
  });

  // ADR 0002's central constraint for this slice: naming a participant must never populate crew.
  it('crew stays [] even when the entry names a user participant', () => {
    const withParticipants = {
      ...entry,
      participants: [{ kind: 'USER', user_id: 'u-dave', customer_id: null }],
    };
    expect(calendarEntryToEvent(withParticipants, NY).crew).toEqual([]);
  });

  it('an entry whose only participants are customers → participantUserIds has no user ids', () => {
    const customerOnly = {
      ...entry,
      participants: [{ kind: 'CUSTOMER', user_id: null, customer_id: 'c-1', name: 'Acme Co' }],
    };
    expect(calendarEntryToEvent(customerOnly, NY).participantUserIds).toEqual([]);
  });

  it('no participants key on the payload → participantUserIds is empty, never throws', () => {
    expect(calendarEntryToEvent(entry, NY).participantUserIds).toEqual([]);
  });
});
