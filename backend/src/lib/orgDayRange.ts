// backend/src/lib/orgDayRange.ts
//
// The list filters' date boundary. A filter chip reading "08/24/2026 - 08/24/2026" is a
// question about the ORG's calendar day, but it arrives on the wire as a bare 'YYYY-MM-DD'
// string, which carries no zone at all. `new Date('2026-08-24')` resolves that to midnight
// UTC, and that single line was wrong twice over:
//
//   1. `_before` is the INCLUSIVE "to" day, so `lte: <start of that day>` is a zero-width
//      window for a single-day range ("Today" could never match anything) and silently
//      dropped the last day of every longer range.
//   2. The cut landed on UTC's midnight rather than the org's, so in America/New_York the
//      boundary sat at 8:00 PM the previous evening - the `_after` edge was wrong too.
//
// The Scheduled COLUMN already renders on the org clock, so the column and the filter
// disagreed about which day a job was on. The semantics below are the ones the chip
// promises:
//
//   `_after=YYYY-MM-DD`  ->  >= the instant that org-zone day BEGINS
//   `_before=YYYY-MM-DD` ->  <  the instant the NEXT org-zone day begins  (to-day inclusive)
//
// A `_before` bound is expressed as `lt` on the next day's start rather than `lte` on
// "23:59:59.999" because a DST day is 23 or 25 hours long: any hardcoded end-of-day offset
// over- or under-shoots twice a year. Deriving the far edge from the next day's start is
// exact in every zone.
//
// FULL ISO INSTANTS PASS THROUGH UNTOUCHED. The schedule board reuses these same
// `scheduled_after`/`scheduled_before` params but sends real instants
// (`useScheduleData.ts` converts its org-zone WallClock window through `toInstant`), and it
// passed the whole org-zone QA campaign. Only a BARE 'YYYY-MM-DD' is treated as an org-zone
// day; anything else keeps the previous `new Date(raw)` behaviour byte-for-byte.
//
// The day -> instant conversion goes through date-fns-tz's `fromZonedTime`, the same
// primitive the frontend's `orgDayStart` uses (frontend/src/lib/schedule-tz.ts), so the two
// sides cannot drift and neither hand-rolls UTC-offset arithmetic. It also resolves the
// zones where a calendar day does NOT begin at 00:00 local (a spring-forward day in e.g.
// America/Santiago starts at 01:00).
import { fromZonedTime } from 'date-fns-tz';

/** A bare, zoneless calendar day as the filter wire contract sends it. */
const BARE_DAY = /^\d{4}-\d{2}-\d{2}$/;

/** The Prisma range filter this module builds. `lt` is only ever the org-day-exclusive far edge. */
export type DateWindow = { gte?: Date; lte?: Date; lt?: Date };

/** True for a zoneless 'YYYY-MM-DD' - the only shape read as an ORG day rather than an instant. */
export function isBareOrgDay(value: unknown): value is string {
  return typeof value === 'string' && BARE_DAY.test(value);
}

/**
 * Shift an org-zone 'YYYY-MM-DD' by whole calendar days. Pure calendar-number arithmetic:
 * the day is anchored at UTC midnight purely as a counting device, so the result is never
 * reinterpreted through the server's own zone (which is UTC in production and the
 * developer's zone locally). Mirrors the frontend's `addOrgDays`.
 */
export function addOrgDays(day: string, n: number): string {
  return new Date(Date.parse(`${day}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
}

/**
 * The instant an org-zone calendar day BEGINS. Not always midnight local - see the file
 * header on zones that skip 00:00; `fromZonedTime` resolves that for us.
 */
export function orgDayStart(day: string, timeZone: string): Date {
  return fromZonedTime(`${day}T00:00:00`, timeZone);
}

/**
 * Turn a raw `_after`/`_before` pair into the Prisma range filter, honouring the org clock.
 *
 * Each bound is resolved independently, so a mixed request (one bare day, one full instant)
 * is well-defined rather than all-or-nothing. Returns `null` when neither bound is usable,
 * so the caller can leave `where` untouched instead of writing an empty range object.
 */
export function orgDayRange(
  after: unknown,
  before: unknown,
  timeZone: string,
): DateWindow | null {
  const range: DateWindow = {};

  if (after) {
    const raw = String(after);
    // A bare day starts at the org's midnight; a full ISO instant is already an instant.
    range.gte = isBareOrgDay(raw) ? orgDayStart(raw, timeZone) : new Date(raw);
  }

  if (before) {
    const raw = String(before);
    if (isBareOrgDay(raw)) {
      // The "to" DAY is inclusive: everything strictly before the next org day begins.
      range.lt = orgDayStart(addOrgDays(raw, 1), timeZone);
    } else {
      // Unchanged instant semantics - this is the schedule board's path.
      range.lte = new Date(raw);
    }
  }

  return Object.keys(range).length > 0 ? range : null;
}
