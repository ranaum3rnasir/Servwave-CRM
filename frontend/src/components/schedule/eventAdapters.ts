import type { SchedulableEvent } from './scheduleModel';
import { DEFAULT_DURATION_MIN } from './scheduleModel';
import { crewPeopleOf, ownerOf } from './eventPeople';
import { toWallClock, addMsToWallClock, type WallClock } from '@/lib/schedule-tz';

type CustomerLike = { first_name?: string; last_name?: string; company_name?: string | null } | null | undefined;

// Board display policy: company name first (company-dominant for field crew clarity).
// This is intentionally different from src/lib/customer-name.ts customerDisplayName, which is
// person-first (used in office/sales views). Do not unify — the contexts differ.
export function customerName(c: CustomerLike): string {
  if (!c) return 'Customer';
  if (c.company_name?.trim()) return c.company_name.trim();
  const n = `${c.first_name ?? ''} ${c.last_name ?? ''}`.trim();
  return n || 'Customer';
}

const ids = (people: { id?: string }[]): string[] =>
  people.map((p) => p.id).filter((id): id is string => Boolean(id));

/**
 * One VISIT row as the board sees it. `scheduled_at` is deliberately spelled the way the API
 * spells it - the rename to `scheduled_start` is S8's, and widening this to accept both
 * spellings is what lib/visits.ts's header forbids.
 */
export interface BoardVisitRow {
  id: string;
  visit_seq?: number | null;
  status?: string | null;
  scheduled_at?: string | null;
  scheduled_end?: string | null;
  is_all_day?: boolean | null;
}

type NarrowedJob = {
  id: string;
  job_number: string;
  scope_notes?: string | null;
  scheduled_start?: string | null;
  scheduled_end?: string | null;
  is_all_day?: boolean | null;
  customer?: CustomerLike;
  tags?: SchedulableEvent['tags'];
  visits?: BoardVisitRow[] | null;
};

/**
 * The job as ONE card, keyed on the bare job id and carrying the job's own mirror window.
 *
 * This is the identity a card has when it is NOT a trip: a job that holds no visit row yet, and
 * every card in the unscheduled bucket (see jobToBucketEvent).
 */
function jobIdentityEvent(j: NarrowedJob, shared: Omit<SchedulableEvent, 'boardId' | 'start' | 'end'>, tz: string): SchedulableEvent {
  const start: WallClock | null = j.scheduled_start ? toWallClock(new Date(j.scheduled_start), tz) : null;
  const end: WallClock | null = j.scheduled_end
    ? toWallClock(new Date(j.scheduled_end), tz)
    : start
      ? addMsToWallClock(start, DEFAULT_DURATION_MIN.job * 60_000)
      : null;
  return { ...shared, boardId: j.id, isAllDay: j.is_all_day ?? false, start, end };
}

/**
 * Multi-visit S6 (F4, D16): a card in the UNSCHEDULED bucket addresses the JOB, never a trip.
 *
 * "Unscheduled" means the job holds no LIVE visit, so there is no trip for the card to be - and
 * the gesture the card offers is "book this work", which is `/assign`'s first-booking path.
 * Fanning the bucket out per visit the way the board does looks like a no-op (an unscheduled job
 * usually has no surviving visit at all) right up until `/unassign` leaves one behind: it cancels
 * only the LIVE statuses, so a job whose trip had already COMPLETED keeps that row. Keyed on the
 * visit, that card dragged out would PATCH the finished trip - rewriting when the work was
 * actually done and booking nothing - and its plan-mode ghost would carry `jv-<uuid>` as a JOB id
 * (parseBoardDragId has no `jv-` case) straight into a 404.
 */
export function jobToBucketEvent(job: Record<string, unknown>, tz: string): SchedulableEvent {
  const j = job as NarrowedJob;
  return jobIdentityEvent(j, sharedJobFields(j, job), tz);
}

/** The card content every one of a job's cards shares - see the note inside for why. */
function sharedJobFields(j: NarrowedJob, job: Record<string, unknown>): Omit<SchedulableEvent, 'boardId' | 'start' | 'end'> {
  // The card's content is the JOB's - D4: a visit is an occurrence only, with no address and no
  // customer of its own. Only the time, the identity and the visit label differ per card.
  return {
    type: 'job' as const,
    parentId: j.id,
    number: j.job_number,
    title: j.scope_notes?.trim() || customerName(j.customer),
    customer: customerName(j.customer),
    // Crew stays the JOB-level union (which since S3 is exactly that: the union across the job's
    // visits). Placing each card in only its own visit's lanes is a separate behaviour change and
    // is not part of S6 - a job crewed only at job level would lose every lane it renders in.
    crew: ids(crewPeopleOf('job', job)),
    ownerId: ownerOf('job', job)?.id ?? null,
    tags: j.tags ?? [],
    raw: job,
  };
}

/**
 * job API payload -> board events, ONE PER VISIT.
 *
 * This is the read boundary (schedule-tz.ts): every timestamp the payload carries is an Instant,
 * and everything downstream of this function (RBC, grid layout math) needs a WallClock in the
 * org's `tz` instead - see there for why. Every instant crosses exactly here, exactly once,
 * through toWallClock; a `new Date(v).toISOString()` anywhere else converts in the BROWSER zone,
 * which is #1551's second defect.
 *
 * Multi-visit S6 (D33): `Job.scheduled_start` is a write-through mirror of the job's NEXT
 * upcoming visit (D14), so reading it produced exactly one card however many trips the job held.
 * A job whose `visits` array is EMPTY still yields one event off the mirror, keyed on the bare
 * job id: that is the unassigned bucket, the first-booking path, and the optimistic window after
 * /assign returns but before the refetch lands. Removing that fallback would make a freshly
 * booked job vanish from the board until the next fetch.
 */
export function jobToEvents(job: Record<string, unknown>, tz: string): SchedulableEvent[] {
  // The parameter stays `Record<string, unknown>` - the shape `raw`, crewPeopleOf and
  // ownerOf all speak - and the fields this function actually reads are narrowed once
  // here rather than cast one by one at each use.
  const j = job as NarrowedJob;
  const shared = sharedJobFields(j, job);

  const visits = (j.visits ?? []).filter((v) => v.status !== 'CANCELLED');

  /**
   * The denominator of "Visit 2 of 3", and it has to sit on the SAME axis as the numerator.
   *
   * `visitSeq` is the stable creation-order number (D13 - it is in the customer's email, so it is
   * never renumbered), while `visits.length` counts the LIVE rows the API sent (jobListSelect
   * drops CANCELLED ones, D19 keeps the row). Mixing the two prints a card that cannot be true:
   * cancel visit 1 of three and the survivors, still numbered 2 and 3, render as "Visit 2 of 2"
   * and "Visit 3 of 2". Taking the highest seq keeps both halves counting trips-ever-booked, so
   * the pair reads "Visit 2 of 3" and "Visit 3 of 3". `visits.length` remains the floor for the
   * case a seq is missing entirely.
   */
  const visitCount = visits.reduce(
    (highest, v) => Math.max(highest, v.visit_seq ?? 0),
    visits.length,
  );

  if (visits.length === 0) return [jobIdentityEvent(j, shared, tz)];

  return visits.map((v) => {
    const start: WallClock | null = v.scheduled_at ? toWallClock(new Date(v.scheduled_at), tz) : null;
    // F7: the end comes off the VISIT's own scheduled_end, so the drop modal seeds this trip's
    // duration rather than the job default. The default is the fallback, not the rule.
    const end: WallClock | null = v.scheduled_end
      ? toWallClock(new Date(v.scheduled_end), tz)
      : start
        ? addMsToWallClock(start, DEFAULT_DURATION_MIN.job * 60_000)
        : null;
    return {
      ...shared,
      boardId: `jv-${v.id}`,
      visitId: v.id,
      visitSeq: v.visit_seq ?? undefined,
      // This trip's own state, so the card is coloured by the trip rather than by the
      // job's roll-up across all of them (MV-BOARD-10).
      visitStatus: v.status ?? undefined,
      visitCount,
      isAllDay: v.is_all_day ?? false,
      start,
      end,
    };
  });
}

/**
 * Slice 03 (calendar-entries spec §2/§3) — the CalendarEntry read boundary, same shape as
 * jobToEvents/walkthroughToEvent: every timestamp crosses into the org-tz WallClock exactly
 * here, via toWallClock, and nowhere downstream.
 *
 * `number: ''` — spec §2: an entry carries no record number, so the card renders the title
 * alone. `customer: ''` and `crew: []` — ADR 0002: an entry joins no lead/job/estimate and has
 * no crew; its participants are a SEPARATE field (`participantUserIds`, slice 06), never folded
 * into crew here. `ownerId: null` — there is no commission owner for scheduler content that is
 * not work.
 */
type NarrowedParticipant = { kind: 'USER' | 'CUSTOMER'; user_id: string | null };

type NarrowedCalendarEntry = {
  id: string;
  title: string;
  start: string;
  end: string;
  is_all_day?: boolean | null;
  participants?: NarrowedParticipant[];
};

/**
 * Slice 06 (calendar-entries spec §3, ADR 0002) — the USER participants, as ids, for
 * `isOnBoardFor`. Deliberately its own small function rather than inlined below: it is the ONE
 * place a `calendar-entry` payload's participants are read for board placement, mirroring how
 * `crewPeopleOf`/`ownerOf` in eventPeople.ts are the one place crew/owner are read — so a future
 * reader looking for "where do participants become board membership" finds one function, not a
 * filter buried in a return object.
 */
function participantUserIdsOf(entry: NarrowedCalendarEntry): string[] {
  return (entry.participants ?? [])
    .filter((p) => p.kind === 'USER')
    .map((p) => p.user_id)
    .filter((id): id is string => Boolean(id));
}

/**
 * Post-QA fix (drag/resize "notify participants" toast, PO-reported 2026-08-25) — whether the
 * entry has anyone the "Notify" toast action could actually reach. The original bug was the
 * action offering itself on an entry with NO participants and then reporting that participants
 * had been notified.
 *
 * Counts BOTH kinds since the product-owner change of 2026-08-25 ("I actually wanted all
 * participants to be notified"). It was briefly customer-only, on the reasoning that a teammate
 * had already been told — true of the in-app notice, which fires on the PATCH the drag itself
 * sends, but not of email, which that PATCH never sends. `notifyMoved` now emails both kinds
 * and passes `suppressInAppNotice`, so the in-app notice still fires exactly once and a
 * user-only entry has a real recipient for this action.
 */
function calendarEntryHasParticipantOf(entry: NarrowedCalendarEntry): boolean {
  return (entry.participants ?? []).length > 0;
}

export function calendarEntryToEvent(entry: Record<string, unknown>, tz: string): SchedulableEvent {
  const e = entry as NarrowedCalendarEntry;
  return {
    boardId: `ce-${e.id}`,
    parentId: e.id,
    type: 'calendar-entry',
    number: '',
    title: e.title,
    customer: '',
    crew: [],
    participantUserIds: participantUserIdsOf(e),
    hasParticipants: calendarEntryHasParticipantOf(e),
    ownerId: null,
    isAllDay: e.is_all_day ?? false,
    start: toWallClock(new Date(e.start), tz),
    end: toWallClock(new Date(e.end), tz),
    tags: [],
    raw: entry,
  };
}

export function walkthroughToEvent(lead: Record<string, unknown>, tz: string): SchedulableEvent {
  // Same narrowing as jobToEvent - see the note there.
  const l = lead as {
    id: string;
    lead_number: string;
    walkthrough_scheduled_at?: string | null;
    walkthrough_duration_minutes?: number | null;
    customer?: CustomerLike;
    tags?: SchedulableEvent['tags'];
  };
  const start: WallClock | null = l.walkthrough_scheduled_at
    ? toWallClock(new Date(l.walkthrough_scheduled_at), tz)
    : null;
  const durMin = l.walkthrough_duration_minutes ?? DEFAULT_DURATION_MIN.walkthrough;
  const end: WallClock | null = start ? addMsToWallClock(start, durMin * 60_000) : null;
  return {
    boardId: `wt-${l.id}`,
    parentId: l.id,
    type: 'walkthrough',
    number: l.lead_number,
    title: `Walkthrough · ${customerName(l.customer)}`,
    customer: customerName(l.customer),
    crew: ids(crewPeopleOf('walkthrough', lead)),
    ownerId: ownerOf('walkthrough', lead)?.id ?? null,
    start,
    end,
    tags: (lead.tags as SchedulableEvent['tags']) ?? [],
    raw: lead,
  };
}
