// frontend/src/components/schedule/scheduleModel.ts
// The pure, framework-free heart of the scheduler board — a tested module derived from the
// locked scheduler-assignment redesign (PRD: md_files/plans/scheduler/).
// Crew (0..N performers) and schedule (a time or null) are INDEPENDENT axes (§3.8 four-state).
// Time is modeled as real Dates (an earlier {dayIndex,minutes} sketch was a design-time abstraction).
//
// start/end are WallClock, not a raw Instant: every event that reaches this module has already
// crossed the org-timezone boundary in eventAdapters.ts. See frontend/src/lib/schedule-tz.ts for
// what that means and why — react-big-calendar (the consumer downstream of this module) has no
// timezone concept, so the whole board operates in wall-clock space between the two boundaries.

import type { WallClock } from '@/lib/schedule-tz';

export type EventType = 'job' | 'walkthrough' | 'service-plan';

export interface SchedulableEvent {
  id: string;                       // board id: job.id for jobs, `wt-${lead.id}` for walkthroughs
  type: EventType;
  number: string;                   // J00041 / L00012 / SP0003
  title: string;
  customer: string;
  crew: string[];                   // performer user ids (0..N) — equal, no lead/primary
  ownerId: string | null;           // commission owner — OFF-BOARD (a field, never a column)
  start: WallClock | null;          // null = unscheduled
  end: WallClock | null;            // null = unscheduled
  raw: Record<string, unknown>;     // the source job/lead row (for popups, downstream reads)
  // SRVW-58 - tag chips on the board. OPTIONAL deliberately: a required member would
  // break every SchedulableEvent fixture in the five schedule test files. Typed here
  // rather than read off `raw` (which already carries it) because three card renderers
  // consume it and `raw` is Record<string, unknown> - declaring the shape once beats
  // casting it three times.
  tags?: { id: string; name: string; color: string }[];
}

/**
 * The board event: the pure SchedulableEvent plus plan-mode draft flags. The flags are
 * optional, so a bare SchedulableEvent (straight from the adapters, or a test fixture)
 * is a valid board event. Status / urgency / all-day live on `raw` — read them there.
 */
export type BoardEvent = SchedulableEvent & { isGhost?: boolean; ghostId?: string };

/** A BoardEvent actually placed on the board — start/end narrowed to real WallClocks. */
export type ScheduledBoardEvent = BoardEvent & { start: WallClock; end: WallClock };

export type AssignmentState = 1 | 2 | 3 | 4;

export interface StateMeta { label: string; where: string; hint: string }
export const STATE_META: Record<AssignmentState, StateMeta> = {
  1: { label: 'Fresh', where: 'Unassigned bucket', hint: 'no crew · no time' },
  2: { label: 'Scheduled', where: 'Board', hint: 'crew ≥1 · timed' },
  3: { label: 'Crewed, unscheduled', where: 'Unassigned bucket', hint: 'keeps crew · no time' },
  4: { label: 'Needs assignment', where: 'Standard view only', hint: 'timed · 0 crew (red flag)' },
};

export function deriveState(e: Pick<SchedulableEvent, 'crew' | 'start'>): AssignmentState {
  const crewed = e.crew.length > 0;
  const scheduled = e.start !== null;
  if (crewed && scheduled) return 2;
  if (crewed && !scheduled) return 3;
  if (!crewed && scheduled) return 4;
  return 1;
}

export const DEFAULT_DURATION_MIN: Record<EventType, number> = { job: 120, walkthrough: 60, 'service-plan': 90 };
export const HOURLESS_DEFAULT_START_MIN = 8 * 60; // 08:00 fallback for day-granularity drops

// Type-keyed presentation — Tailwind tokens ONLY (job=info, walkthrough=warning, service-plan=ai).
// `accent`/`soft`/`text` are class fragments components compose; a 3rd type slots in additively.
export interface EventTypeMeta { label: string; accent: string; soft: string; text: string }
export const EVENT_TYPE_META: Record<EventType, EventTypeMeta> = {
  job:            { label: 'Job',          accent: 'border-l-info',    soft: 'bg-info/5',    text: 'text-info' },
  walkthrough:    { label: 'Walkthrough',  accent: 'border-l-warning', soft: 'bg-warning/5', text: 'text-warning' },
  'service-plan': { label: 'Service Plan', accent: 'border-l-ai',      soft: 'bg-ai/5',      text: 'text-ai' },
};

/**
 * The board card treatment, spelled ONCE for both member boards (MemberWeekBoard's
 * BoardCard and TechnicianGridView's JobCard previously carried byte-identical copies).
 *
 * This is a THREE-AXIS board treatment - exception state, then status, then event type -
 * NOT a status badge, and it deliberately does NOT resolve through STATUS_REGISTRY. The
 * first axis (the two reds: needs-crew fill, double-booked outline) is resolved by the
 * callers via eventDangerState and never reaches this helper; what is left is the status
 * axis and the type axis, in that order.
 *
 * Why the registry is the wrong source here, concretely:
 *   - EVENT_TYPE_META (see just above) paints job=info, walkthrough=warning and
 *     service-plan=ai. That is the type-accent language the on-screen board legend
 *     advertises to the user. Resolving per status through the registry would repaint
 *     every SCHEDULED and UNASSIGNED block amber and delete those type accents outright.
 *   - COMPLETED_STATUSES (below) deliberately buckets COMPLETED and CANCELLED together as
 *     one "this is over" treatment for jobs (isCompletedEvent adds the walkthrough case
 *     separately, off walkthrough_completed_at rather than a status value - see there). The
 *     registry splits the job bucket into a success tone and a neutral tone.
 *   - The in-flight treatment here is green; the registry maps EN_ROUTE / ON_SITE /
 *     IN_PROGRESS to amber, where it would collide with SCHEDULED.
 * So a registry migration of this helper is a repaint of the busiest screen in the app,
 * not a consolidation. Any change to it is a deliberate design decision, not a cleanup.
 */
export interface BoardCardScheme { accent: string; bg: string; text: string }

export function boardCardScheme(type: EventType, isCompleted: boolean, isInProg: boolean): BoardCardScheme {
  if (isCompleted) return { accent: 'border-l-neutral-strong', bg: 'bg-neutral-surface', text: 'text-neutral-text' };
  if (isInProg)    return { accent: 'border-l-success',        bg: 'bg-success-surface', text: 'text-success-text' };
  const m = EVENT_TYPE_META[type];
  return { accent: m.accent, bg: m.soft, text: m.text };
}

/**
 * M3 — the one column-membership predicate both member views share: an event sits on a
 * member's board lane iff the member is on its crew. (Owner is OFF-BOARD — never a column.)
 * Any same-day narrowing is a view concern and stays local to the views.
 */
export function isOnBoardFor(e: Pick<SchedulableEvent, 'crew'>, memberId: string): boolean {
  return e.crew.includes(memberId);
}

// ─── D9 — role-gated board capabilities (TG13) ───────────────────────────────
// DATA scoping is server-side (PR A scopeWhereFor); this only gates UI CONTROLS.
// ADMIN/DISPATCHER: member view + full edit. SALES: no member view, normal edits
// on their (server-scoped) data. TECHNICIAN — and any unknown/missing role, which
// fails SAFE — gets no member view and a READ-ONLY board.

export interface BoardCapabilities { memberView: boolean; readOnly: boolean }

export function boardCapabilitiesFor(role: string | undefined): BoardCapabilities {
  if (role === 'ADMIN' || role === 'DISPATCHER') return { memberView: true, readOnly: false };
  if (role === 'SALES') return { memberView: false, readOnly: false };
  return { memberView: false, readOnly: true };
}

// ─── Shared status reads (M2) ────────────────────────────────────────────────
// Status / urgency / all-day live on the raw row (the adapters keep events pure).
// One source for all render sites — `raw` can be absent at runtime on the transient
// outside-drag preview stub (cast in), so every read defaults off.

// Job statuses only - a walkthrough's "is this over" reading is not a status value at all
// (see isCompletedEvent below).
export const COMPLETED_STATUSES = new Set(['COMPLETED', 'CANCELLED']);

/** Statuses that render as "work is happening right now". */
export const IN_FLIGHT_STATUSES = new Set(['EN_ROUTE', 'ON_SITE', 'IN_PROGRESS']);

// Walkthrough-as-entity redesign, PR-C2: WALKTHROUGH_COMPLETED left LeadStatus - completing a
// visit is now purely a fact recorded on the Walkthrough row, not a lead-pipeline transition,
// so a walkthrough event's "completed" reading comes off walkthrough_completed_at instead of
// a status value. Jobs are unaffected - COMPLETED/CANCELLED are still real JobStatus values.
export const isCompletedEvent = (e: BoardEvent): boolean => {
  if (e.type === 'walkthrough') return Boolean(e.raw?.walkthrough_completed_at);
  return COMPLETED_STATUSES.has((e.raw?.status as string | undefined) ?? '');
};

/**
 * The drag/resize gate for the calendar and member boards (Spec B1, B-2). Dragging or
 * resizing a scheduled event goes through `/assign`, which un-completes and un-cancels
 * a job via milestoneClears — money, not status, is what should freeze it. Walkthroughs
 * are a Lead, out of scope — they keep the completed-walkthrough block.
 *
 * `e.raw` reads `?.` throughout: react-big-calendar's outside-drag preview stub
 * (`dragFromOutsideItem`) is an untyped `{id,title,start,end}` with no `raw`/`type`, and
 * `draggableAccessor`/`resizableAccessor` call this on every rendered event, preview
 * included. A crash here trips the top-level ErrorBoundary mid-drag.
 */
export type RescheduleGateResult = { ok: true } | { ok: false; reason: string };

export function rescheduleGate(e: Pick<SchedulableEvent, 'type' | 'raw'>): RescheduleGateResult {
  if (e.type === 'walkthrough') {
    return isCompletedEvent(e as BoardEvent)
      ? { ok: false, reason: 'This walkthrough already happened.' }
      : { ok: true };
  }
  const invoices = (e.raw?.invoices as Array<{ sent_at: string | null }> | undefined) ?? [];
  return invoices.some((i) => i.sent_at)
    ? { ok: false, reason: 'This job has already been invoiced.' }
    : { ok: true };
}

export const isAllDayEvent = (e: BoardEvent): boolean => {
  if (!e.raw) return false;
  if (e.type === 'job') return Boolean(e.raw.is_all_day);
  if (e.type === 'walkthrough') {
    return ((e.raw.walkthrough_duration_minutes as number | null) ?? 60) >= 1440;
  }
  return false;
};

// ─── The two reds (D7 + §3.8 state 4) ────────────────────────────────────────

export type EventDangerState = 'needs-crew' | 'double-booked' | null;

/**
 * The single precedence decision for the two reds, shared by all three render
 * sites (member grid card, member week chip, standard-calendar styles):
 *   - 'needs-crew'   → red FILL (state 4: timed + 0 crew). Standard views only in
 *     practice — `isOnBoardFor` structurally keeps state-4 out of member columns.
 *   - 'double-booked' → red OUTLINE (id ∈ conflictIds, D7).
 * needs-crew WINS: a crew-less event can't share a member with anything, so the
 * overlap is impossible — but the precedence is encoded here, once.
 * Ghost/draft cards are plan-mode previews — never painted red.
 */
export function eventDangerState(e: BoardEvent, conflictIds: Set<string>): EventDangerState {
  if (e.isGhost) return null;
  if (deriveState(e) === 4) return 'needs-crew';
  if (conflictIds.has(e.id)) return 'double-booked';
  return null;
}

/** Do two scheduled events overlap in real time? Unscheduled → never. */
export function timeOverlap(a: SchedulableEvent, b: SchedulableEvent): boolean {
  if (!a.start || !a.end || !b.start || !b.end) return false;
  return a.start < b.end && b.start < a.end;
}

/**
 * D7 — double-booking. The ids of events that share a crew member with another scheduled
 * event whose time overlaps. Per-crew-member, spans jobs + walkthroughs in one flat pass.
 * (Visual only — the backend independently enforces conflicts on write with a 409.)
 */
export function conflictedEventIds(events: SchedulableEvent[]): Set<string> {
  const out = new Set<string>();
  for (let i = 0; i < events.length; i++) {
    for (let j = i + 1; j < events.length; j++) {
      const a = events[i];
      const b = events[j];
      if (!a || !b) continue;
      if (a.crew.some((c) => b.crew.includes(c)) && timeOverlap(a, b)) {
        out.add(a.id);
        out.add(b.id);
      }
    }
  }
  return out;
}

/**
 * D2 swap reducer — the drop-target member replaces the from-lane member (1:1, preserves size).
 * No-op if the target is already on the crew (the card already renders in their column — per-person
 * removal is an EDITOR action, never a drag) or if from-member isn't on the crew (defensive).
 */
export type SwapOutcome =
  | { kind: 'swapped'; crew: string[] }
  | { kind: 'noop-already-on' }
  | { kind: 'noop-not-on' };

export function swapCrew(crew: string[], fromMember: string, toMember: string): SwapOutcome {
  if (!crew.includes(fromMember)) return { kind: 'noop-not-on' };
  if (crew.includes(toMember)) return { kind: 'noop-already-on' };
  return { kind: 'swapped', crew: crew.map((c) => (c === fromMember ? toMember : c)) };
}

/**
 * TG10 — the governing rule for dropping an already-scheduled BOARD card on a member
 * lane, encoded once: drag changes WHERE/WHEN an event is + whole-lane swaps; the
 * EDITOR changes who is on it. So:
 *   - cross-lane (from ≠ to)            → 'swap'       (crew change; the drop slot's time/date is IGNORED)
 *   - same lane + hour slot             → 'reschedule' (move within the lane; crew unchanged)
 *   - same lane + day cell, other day   → 'reschedule' (keep time-of-day + duration; crew unchanged)
 *   - same lane + day cell, same day    → 'noop'       (nothing to change)
 *   - from-member absent                → 'noop'       (defensive — board drags only originate in member lanes)
 */
export type BoardDropDecision = 'swap' | 'reschedule' | 'noop';

export function classifyBoardDrop(args: {
  fromMember: string | null;
  toMember: string;
  sameDay: boolean;
  hasTime: boolean;
}): BoardDropDecision {
  if (!args.fromMember) return 'noop';
  if (args.fromMember !== args.toMember) return 'swap';
  if (args.hasTime) return 'reschedule';
  return args.sameDay ? 'noop' : 'reschedule';
}

/** A board drop location. Member targets carry a member id; time targets carry an exact start. */
export type DropTarget =
  | { kind: 'member-day'; memberId: string; start: WallClock }   // member + exact time
  | { kind: 'member-week'; memberId: string; date: WallClock }   // member + day, no time
  | { kind: 'standard-time'; start: WallClock }                  // time, no member
  | { kind: 'standard-day'; date: WallClock };                   // day, no member, no time

export interface ScheduleDraft {
  eventId: string;
  start: WallClock;
  durationMin: number;
  crew: string[];
  autoDate: boolean;   // highlight: date came from the drop
  autoTime: boolean;   // highlight: time came from the drop
  autoMember: boolean; // highlight: member came from the drop
}

/** A copy of `day` with the time-of-day set to `minutes` since midnight (wall-clock space). */
export function atMinutes(day: WallClock, minutes: number): WallClock {
  const d = new Date(day);
  d.setHours(Math.floor(minutes / 60), minutes % 60, 0, 0);
  return d as WallClock;
}

/** 'HH:MM' → minutes since midnight; falls back to 08:00 on malformed input. */
export function hhmmToMin(hhmm: string): number {
  const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm);
  if (!m) return HOURLESS_DEFAULT_START_MIN;
  return Number(m[1]) * 60 + Number(m[2]);
}

/**
 * D5 — the drop modal's ADVISORY conflict note (decision D5 in the scheduler redesign PRD).
 * Scans the scheduled events for the first one that shares ≥1 crew member with the draft
 * AND overlaps its hypothetical [start, start+duration) window — excluding the dragged
 * event itself. Returns "overlaps <number> for <firstName>" (name resolved via
 * `firstNameById`, omitted when unknown) or null. Advisory only — never a blocker; the
 * backend independently enforces conflicts on write with a 409.
 */
export function conflictNoteFor(
  draft: Pick<ScheduleDraft, 'eventId' | 'start' | 'durationMin' | 'crew'>,
  events: SchedulableEvent[],
  firstNameById: ReadonlyMap<string, string>,
): string | null {
  if (draft.crew.length === 0) return null;
  const end = new Date(draft.start.getTime() + draft.durationMin * 60_000);
  for (const other of events) {
    if (other.id === draft.eventId) continue;
    if (!other.start || !other.end) continue;
    const shared = draft.crew.find((c) => other.crew.includes(c));
    if (shared === undefined) continue;
    if (draft.start < other.end && other.start < end) {
      const first = firstNameById.get(shared);
      return `overlaps ${other.number}${first ? ` for ${first}` : ''}`;
    }
  }
  return null;
}

/** D5 — derive the modal's initial draft from where the card was dropped. Pure. */
export function draftFromDrop(
  event: SchedulableEvent,
  target: DropTarget,
  opts: { defaultStartMin: number; defaultDurationMin: number },
): ScheduleDraft {
  const durationMin =
    event.start && event.end
      ? Math.round((event.end.getTime() - event.start.getTime()) / 60_000)
      : opts.defaultDurationMin;
  const base = { eventId: event.id, durationMin, crew: [...event.crew] };
  switch (target.kind) {
    case 'member-day':
      return { ...base, start: target.start, crew: [target.memberId], autoDate: true, autoTime: true, autoMember: true };
    case 'member-week':
      return { ...base, start: atMinutes(target.date, opts.defaultStartMin), crew: [target.memberId], autoDate: true, autoTime: false, autoMember: true };
    case 'standard-time':
      return { ...base, start: target.start, autoDate: true, autoTime: true, autoMember: false };
    case 'standard-day':
      return { ...base, start: atMinutes(target.date, opts.defaultStartMin), autoDate: true, autoTime: false, autoMember: false };
  }
}
