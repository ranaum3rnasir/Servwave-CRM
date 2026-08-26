/**
 * A5 (RATIFIED 2026-08-24, Option A) - `job.scheduled_start` / `scheduled_end` / `is_all_day` are
 * no longer STORED columns on `jobs` (S8's DROP). The WIRE KEYS survive as a computed projection
 * of the job's visit set, built in exactly ONE place so every caller agrees. `jobDetailSelect`,
 * `jobListSelect` and every other job select in this codebase still ship the `visits` array with
 * `status` / `scheduled_at` / `scheduled_end` / `is_all_day` / `created_at` on each row, which is
 * all this file needs.
 *
 * DERIVED, NOT AUTHORITATIVE: new code should read `job.visits[]` directly. These three keys exist
 * so the ~10 pre-existing consumers that read them as flat scalars (the job detail hero, the jobs
 * list + CSV export, both dashboard Today's Schedule widgets, the invoices list, the customer
 * detail Jobs tab, the copilot job tools) keep working unmodified. Tracked for an eventual
 * `visits[]`-native migration as #1696 (A5's rejected Option B).
 *
 * RULE (all three conditions are load-bearing, do not "simplify" one in isolation):
 *   (i)   All three keys derive from ONE visit, atomically - the NEXT UPCOMING LIVE visit
 *         (`resolveNextJobVisit`, the same function the write-side mirror and the automation
 *         anchor resolver both use - see walkthrough.service.ts and A4).
 *   (ii)  When no live visit qualifies (every visit is CANCELLED/COMPLETED, or none carries a
 *         time), fall back to the EARLIEST NON-CANCELLED visit - never a synthetic mix of visits.
 *         This keeps historical and completed jobs non-blank and agrees with the A1 sort key
 *         (`first_visit_start`), so sort and render tell one story on old rows.
 *   (iii) Zero visits (or zero with a `scheduled_at`) -> all three null. `is_all_day` therefore
 *         widens from the old column's `boolean` to `boolean | null` on the wire - a falsy check
 *         (`if (job.is_all_day)`) reads `null` identically to the old `false` default; only a
 *         strict `=== false` comparison would need to change, and none of the ~10 consumers do.
 */

import type { VisitStatus } from '@prisma/client';
import { resolveNextJobVisit } from '../services/walkthrough.service';
import { isLiveVisit } from './visit-status';

export type VisitForScheduleProjection = {
  status: VisitStatus;
  scheduled_at: Date | null;
  scheduled_end: Date | null;
  is_all_day: boolean;
  created_at: Date;
};

export type JobScheduleWindow = {
  scheduled_start: Date | null;
  scheduled_end: Date | null;
  is_all_day: boolean | null;
};

/**
 * The projection, over a bare visit array. Used directly by controllers that need the CURRENT
 * window as a value (e.g. to compare a PATCH body against, or to feed a downstream computation)
 * without wanting the whole job object re-spread - `update()`, `assign()` and `setAssignees()` all
 * use this form.
 */
export function resolveJobScheduleWindow(
  visits: VisitForScheduleProjection[] | null | undefined,
): JobScheduleWindow {
  const all = visits ?? [];
  const live = all.filter(isLiveVisit);
  const next = resolveNextJobVisit(live);
  if (next) {
    return { scheduled_start: next.scheduled_at, scheduled_end: next.scheduled_end, is_all_day: next.is_all_day };
  }
  // Fallback: no live visit qualifies. Restricted to TIMED rows for the same reason
  // resolveNextJobVisit restricts to `timed` internally - an untimed visit has nothing to sort by
  // and must never win the projection. `!= null` (not `!== null`) so a mocked-Prisma test fixture
  // that OMITS scheduled_at (`undefined`) is excluded the same as one that sets it `null` - a real
  // Prisma select never omits a selected column, but the mocked seam this codebase's whole test
  // suite runs on can and does, and the alternative is a TypeError two lines down.
  const nonCancelled = all.filter((v) => v.status !== 'CANCELLED' && v.scheduled_at != null);
  if (nonCancelled.length === 0) {
    return { scheduled_start: null, scheduled_end: null, is_all_day: null };
  }
  const earliest = nonCancelled.reduce((a, b) => {
    const at = a.scheduled_at!.getTime();
    const bt = b.scheduled_at!.getTime();
    if (at !== bt) return at < bt ? a : b;
    // Tie-break by creation order, mirroring resolveNextJobVisit's own tie-break - two visits
    // booked for the same instant resolve deterministically rather than by array order.
    return a.created_at.getTime() <= b.created_at.getTime() ? a : b;
  });
  return { scheduled_start: earliest.scheduled_at, scheduled_end: earliest.scheduled_end, is_all_day: earliest.is_all_day };
}

/**
 * Rebuild a job payload's `scheduled_start` / `scheduled_end` / `is_all_day` WIRE KEYS from its
 * `visits` array. Mirrors `projectJobCrewUnion`'s shape and signature exactly (job-crew.ts, D6's
 * precedent for this same class of problem) - `T extends Record<string, unknown>` with an internal
 * cast, so it composes with `projectJobCrewUnion` on the same loosely-typed payload shape
 * `presentJobDetail`/`list()`/`exportAll()` already pass around. Callers that need both project
 * crew first (crew needs the raw `visits[].assignees` shape) and schedule second - the order
 * `presentJobDetail` uses - but the two projections are independent reads of the same `visits`
 * array, so either order is correct.
 */
export function projectJobScheduleFields<T extends Record<string, unknown>>(job: T): T {
  const visits = job.visits as VisitForScheduleProjection[] | null | undefined;
  return { ...job, ...resolveJobScheduleWindow(visits) };
}
