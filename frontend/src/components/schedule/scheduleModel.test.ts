import { describe, it, expect } from 'vitest';
import {
  deriveState, timeOverlap, conflictedEventIds, swapCrew, classifyBoardDrop, draftFromDrop,
  hhmmToMin, isOnBoardFor, eventDangerState, conflictNoteFor, boardCapabilitiesFor, rescheduleGate,
  type SchedulableEvent,
} from './scheduleModel';
import { asWallClock, type WallClock } from '@/lib/schedule-tz';

// This module operates entirely in wall-clock space (see schedule-tz.ts) — fixtures are
// plain local Dates re-asserted as WallClock, same as the real read boundary does.
const wc = (day: number, h: number, m = 0): WallClock => asWallClock(new Date(2026, 5, day, h, m));

const at = (h: number, durMin = 120): { start: WallClock; end: WallClock } => {
  const start = wc(10, h, 0);
  return { start, end: asWallClock(new Date(start.getTime() + durMin * 60_000)) };
};
const ev = (over: Partial<SchedulableEvent>): SchedulableEvent => ({
  id: 'e', type: 'job', number: 'J1', title: 't', customer: 'c',
  crew: [], ownerId: null, start: null, end: null, raw: {}, ...over,
});

describe('deriveState (crew ⟂ schedule, §3.8)', () => {
  it('1 Fresh = no crew, no time', () => expect(deriveState(ev({}))).toBe(1));
  it('2 Scheduled = crew + time', () => expect(deriveState(ev({ crew: ['a'], ...at(9) }))).toBe(2));
  it('3 Crewed-unscheduled = crew, no time', () => expect(deriveState(ev({ crew: ['a'] }))).toBe(3));
  it('4 Needs-assignment = time, no crew', () => expect(deriveState(ev({ ...at(9) }))).toBe(4));
});

describe('timeOverlap (real Date intervals)', () => {
  it('overlapping intervals → true', () =>
    expect(timeOverlap(ev({ ...at(9) }), ev({ ...at(10) }))).toBe(true));
  it('touching but not overlapping (9–11 vs 11–13) → false', () =>
    expect(timeOverlap(ev({ ...at(9) }), ev({ ...at(11) }))).toBe(false));
  it('either unscheduled → false', () =>
    expect(timeOverlap(ev({ ...at(9) }), ev({}))).toBe(false));
});

describe('conflictedEventIds (per shared crew member, spans jobs + walkthroughs)', () => {
  it('shared member + overlap → both flagged', () => {
    const a = ev({ id: 'a', crew: ['carol'], ...at(10) });
    const b = ev({ id: 'b', type: 'walkthrough', crew: ['carol'], ...at(11) });
    expect(conflictedEventIds([a, b])).toEqual(new Set(['a', 'b']));
  });
  it('overlap but no shared member → empty', () => {
    const a = ev({ id: 'a', crew: ['alice'], ...at(10) });
    const b = ev({ id: 'b', crew: ['bob'], ...at(11) });
    expect(conflictedEventIds([a, b]).size).toBe(0);
  });
  it('shared member but no time overlap → empty', () => {
    const a = ev({ id: 'a', crew: ['carol'], ...at(8) });
    const b = ev({ id: 'b', crew: ['carol'], ...at(11) });
    expect(conflictedEventIds([a, b]).size).toBe(0);
  });
  it('multi-crew: only the shared member triggers it', () => {
    const a = ev({ id: 'a', crew: ['alice', 'bob'], ...at(10) });
    const b = ev({ id: 'b', crew: ['bob', 'carol'], ...at(11) });
    expect(conflictedEventIds([a, b])).toEqual(new Set(['a', 'b']));
  });
});

describe('eventDangerState (the two reds — one precedence decision for every render site)', () => {
  it('timed + 0 crew → needs-crew (red fill), even when also in conflictIds (precedence)', () => {
    expect(eventDangerState(ev({ id: 'x', ...at(9) }), new Set(['x']))).toBe('needs-crew');
  });
  it('crewed + id ∈ conflictIds → double-booked (red outline)', () => {
    expect(eventDangerState(ev({ id: 'x', crew: ['a'], ...at(9) }), new Set(['x']))).toBe('double-booked');
  });
  it('crewed, scheduled, no conflict → null (normal type styling)', () => {
    expect(eventDangerState(ev({ id: 'x', crew: ['a'], ...at(9) }), new Set())).toBeNull();
  });
  it('ghost/draft cards are previews — never red', () => {
    expect(eventDangerState({ ...ev({ id: 'x', ...at(9) }), isGhost: true }, new Set(['x']))).toBeNull();
  });
});

describe('swapCrew (D2: drag changes who is on a lane; 1:1 replace)', () => {
  it('replaces from→to, preserving crew size + other members', () => {
    expect(swapCrew(['alice', 'bob'], 'alice', 'carol')).toEqual({ kind: 'swapped', crew: ['carol', 'bob'] });
  });
  it('to-member already on crew → no-op (already-on)', () => {
    expect(swapCrew(['alice', 'bob'], 'alice', 'bob')).toEqual({ kind: 'noop-already-on' });
  });
  it('from-member not on crew → no-op (not-on, defensive)', () => {
    expect(swapCrew(['alice'], 'zzz', 'carol')).toEqual({ kind: 'noop-not-on' });
  });
});

describe('classifyBoardDrop (TG10: drag = where/when + whole-lane swap; the editor = who)', () => {
  it('cross-lane hour-slot drop → swap (the slot time is ignored by the caller)', () =>
    expect(classifyBoardDrop({ fromMember: 'alice', toMember: 'bob', sameDay: true, hasTime: true })).toBe('swap'));
  it('cross-lane day-cell drop → swap (the cell date is ignored by the caller)', () =>
    expect(classifyBoardDrop({ fromMember: 'alice', toMember: 'bob', sameDay: false, hasTime: false })).toBe('swap'));
  it('same lane + hour slot → reschedule within the lane', () =>
    expect(classifyBoardDrop({ fromMember: 'alice', toMember: 'alice', sameDay: true, hasTime: true })).toBe('reschedule'));
  it('same lane + different day cell → reschedule to that date', () =>
    expect(classifyBoardDrop({ fromMember: 'alice', toMember: 'alice', sameDay: false, hasTime: false })).toBe('reschedule'));
  it('same lane + same day cell → noop', () =>
    expect(classifyBoardDrop({ fromMember: 'alice', toMember: 'alice', sameDay: true, hasTime: false })).toBe('noop'));
  it('from-member absent → noop (defensive: board drags only originate in member lanes)', () =>
    expect(classifyBoardDrop({ fromMember: null, toMember: 'bob', sameDay: false, hasTime: true })).toBe('noop'));
});

describe('draftFromDrop (D5 pre-fill by drop target)', () => {
  const e = ev({ id: 'e', crew: [] });
  it('member-day: seeds crew + exact time, all auto flags', () => {
    const start = wc(10, 9, 0);
    const d = draftFromDrop(e, { kind: 'member-day', memberId: 'm1', start }, { defaultStartMin: 480, defaultDurationMin: 120 });
    expect(d).toMatchObject({ eventId: 'e', crew: ['m1'], start, durationMin: 120, autoDate: true, autoTime: true, autoMember: true });
  });
  it('member-week: seeds crew + date, default start time (08:00), no autoTime', () => {
    const d = draftFromDrop(e, { kind: 'member-week', memberId: 'm1', date: wc(10, 0) }, { defaultStartMin: 480, defaultDurationMin: 120 });
    expect(d.crew).toEqual(['m1']);
    expect(d.start.getHours()).toBe(8);
    expect(d).toMatchObject({ autoDate: true, autoTime: false, autoMember: true });
  });
  it('standard-time: time, no crew', () => {
    const start = wc(10, 13, 0);
    const d = draftFromDrop(e, { kind: 'standard-time', start }, { defaultStartMin: 480, defaultDurationMin: 120 });
    expect(d).toMatchObject({ crew: [], start, autoDate: true, autoTime: true, autoMember: false });
  });
  it('standard-day: date only, default start, no crew, no autoTime', () => {
    const d = draftFromDrop(e, { kind: 'standard-day', date: wc(10, 0) }, { defaultStartMin: 480, defaultDurationMin: 120 });
    expect(d).toMatchObject({ crew: [], autoDate: true, autoTime: false, autoMember: false });
    expect(d.start.getHours()).toBe(8);
  });
  it('preserves an already-scheduled event\'s duration over the default', () => {
    const scheduled = ev({ id: 'e2', ...at(9, 90) }); // 9:00–10:30
    const d = draftFromDrop(scheduled, { kind: 'standard-time', start: wc(11, 13, 0) }, { defaultStartMin: 480, defaultDurationMin: 120 });
    expect(d.durationMin).toBe(90);
  });
});

describe('isOnBoardFor (M3 — the shared column-membership predicate)', () => {
  it('member on the crew → true', () =>
    expect(isOnBoardFor(ev({ crew: ['alice', 'bob'] }), 'bob')).toBe(true));
  it('member not on the crew (owner is OFF-BOARD, never a column) → false', () =>
    expect(isOnBoardFor(ev({ crew: ['alice'], ownerId: 'sam' }), 'sam')).toBe(false));
});

describe('hhmmToMin', () => {
  it('parses HH:MM to minutes', () => {
    expect(hhmmToMin('08:00')).toBe(480);
    expect(hhmmToMin('13:45')).toBe(825);
  });
  it('falls back to 08:00 on garbage', () => {
    expect(hhmmToMin('')).toBe(480);
    expect(hhmmToMin('nope')).toBe(480);
  });
});

describe('conflictNoteFor (D5 — the modal\'s advisory note, never a blocker)', () => {
  const names = new Map([['carol', 'Carol'], ['bob', 'Bob']]);

  it('shared crew member + time overlap → "overlaps <number> for <firstName>"', () => {
    const other = ev({ id: 'o', number: 'J00099', crew: ['carol'], ...at(10) }); // 10:00–12:00
    const note = conflictNoteFor(
      { eventId: 'e', start: wc(10, 11, 0), durationMin: 120, crew: ['carol'] },
      [other],
      names,
    );
    expect(note).toBe('overlaps J00099 for Carol');
  });

  it('no shared member → null; and the dragged event itself is excluded', () => {
    const stranger = ev({ id: 'o', number: 'J00099', crew: ['bob'], ...at(10) });
    const self = ev({ id: 'e', number: 'J00001', crew: ['carol'], ...at(10) });
    const note = conflictNoteFor(
      { eventId: 'e', start: wc(10, 10, 0), durationMin: 60, crew: ['carol'] },
      [stranger, self],
      names,
    );
    expect(note).toBeNull();
  });

  it('empty crew → null (nobody to collide with); unknown member still notes without a name', () => {
    const other = ev({ id: 'o', number: 'J00099', crew: ['zed'], ...at(10) });
    expect(
      conflictNoteFor({ eventId: 'e', start: wc(10, 10, 0), durationMin: 60, crew: [] }, [other], names),
    ).toBeNull();
    expect(
      conflictNoteFor({ eventId: 'e', start: wc(10, 10, 0), durationMin: 60, crew: ['zed'] }, [other], names),
    ).toBe('overlaps J00099');
  });
});

describe('boardCapabilitiesFor (D9 — UI-control gating; data scoping is server-side)', () => {
  it('ADMIN → member view + full edit', () =>
    expect(boardCapabilitiesFor('ADMIN')).toEqual({ memberView: true, readOnly: false }));
  it('DISPATCHER → member view + full edit', () =>
    expect(boardCapabilitiesFor('DISPATCHER')).toEqual({ memberView: true, readOnly: false }));
  it('SALES → no member view, normal edits on their server-scoped data', () =>
    expect(boardCapabilitiesFor('SALES')).toEqual({ memberView: false, readOnly: false }));
  it('TECHNICIAN → no member view, READ-ONLY board', () =>
    expect(boardCapabilitiesFor('TECHNICIAN')).toEqual({ memberView: false, readOnly: true }));
  it('missing/unknown role fails SAFE → no member view, read-only', () => {
    expect(boardCapabilitiesFor(undefined)).toEqual({ memberView: false, readOnly: true });
    expect(boardCapabilitiesFor('SOMETHING_NEW')).toEqual({ memberView: false, readOnly: true });
  });
});

describe('rescheduleGate (Spec B1, B-2 — money, not status, freezes a job)', () => {
  it('job with a sent invoice → blocked', () => {
    const e = ev({ raw: { invoices: [{ sent_at: '2026-06-01T00:00:00Z' }] } });
    expect(rescheduleGate(e)).toEqual({ ok: false, reason: 'This job has already been invoiced.' });
  });
  it('job with only unsent invoices → ok', () => {
    const e = ev({ raw: { invoices: [{ sent_at: null }] } });
    expect(rescheduleGate(e)).toEqual({ ok: true });
  });
  it('job with no invoices → ok', () => {
    expect(rescheduleGate(ev({}))).toEqual({ ok: true });
  });
  it('completed walkthrough → blocked', () => {
    const e = ev({ type: 'walkthrough', raw: { walkthrough_completed_at: '2026-06-01T00:00:00Z' } });
    expect(rescheduleGate(e)).toEqual({ ok: false, reason: 'This walkthrough already happened.' });
  });
  it('scheduled (not yet completed) walkthrough → ok', () => {
    const e = ev({ type: 'walkthrough', raw: { walkthrough_scheduled_at: '2026-06-01T00:00:00Z', walkthrough_completed_at: null } });
    expect(rescheduleGate(e)).toEqual({ ok: true });
  });
  it('the rbc outside-drag preview stub (no raw, no type) never throws — treated as ok', () => {
    // Mirrors the untyped dragFromOutsideItem() preview: { id, title, start, end } only.
    const stub = { id: 'preview', title: 'Drop to schedule', start: new Date(), end: new Date() } as unknown as SchedulableEvent;
    expect(() => rescheduleGate(stub)).not.toThrow();
    expect(rescheduleGate(stub)).toEqual({ ok: true });
  });
});
