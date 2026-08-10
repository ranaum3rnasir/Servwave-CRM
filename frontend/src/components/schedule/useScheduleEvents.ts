import { useMemo } from 'react';
import { jobToEvent, walkthroughToEvent } from './eventAdapters';
import {
  conflictedEventIds,
  type SchedulableEvent,
  type ScheduledBoardEvent,
} from './scheduleModel';

export interface ScheduleEventsArgs {
  scheduledJobs: Record<string, unknown>[] | undefined;
  walkthroughLeads: Record<string, unknown>[] | undefined;
  unassignedJobs: Record<string, unknown>[] | undefined;
  unscheduledWalkthroughs: Record<string, unknown>[] | undefined;
  hiddenSidebarIds: Set<string>;
  tz: string;
}

export interface UseScheduleEventsReturn {
  scheduledEvents: ScheduledBoardEvent[];
  bucketEvents: SchedulableEvent[];
  visibleBucketEvents: SchedulableEvent[];
  conflictIds: Set<string>;
}

/**
 * The scheduler's adapter→event transform layer, lifted verbatim out of
 * SchedulePage (scheduledEvents / bucketEvents / visibleBucketEvents / conflictIds).
 * Plan-mode-dependent merges (allEventsWithPending, ghosts, windowing) stay in
 * the page — they read plan-mode + view state this hook does not own.
 */
export function useScheduleEvents({
  scheduledJobs,
  walkthroughLeads,
  unassignedJobs,
  unscheduledWalkthroughs,
  hiddenSidebarIds,
  tz,
}: ScheduleEventsArgs): UseScheduleEventsReturn {
  // Scheduled work for the calendar + member columns (states 2 and 4). The type
  // predicate narrows start/end to real WallClocks — downstream (calendar accessors)
  // needs no casts. This is the read boundary: every instant crosses into org-tz
  // wall-clock space here, once, via the adapters (schedule-tz.ts).
  const scheduledEvents = useMemo<ScheduledBoardEvent[]>(
    () =>
      [
        ...((scheduledJobs ?? []).map((j) => jobToEvent(j, tz))),
        ...((walkthroughLeads ?? []).map((l) => walkthroughToEvent(l, tz))),
      ].filter((e): e is ScheduledBoardEvent => e.start !== null && e.end !== null),
    [scheduledJobs, walkthroughLeads, tz],
  );

  // Unscheduled work for the buckets (states 1 and 3 — state 3 keeps its crew).
  const bucketEvents = useMemo<SchedulableEvent[]>(
    () => [
      ...((unassignedJobs ?? []).map((j) => jobToEvent(j, tz))),
      ...((unscheduledWalkthroughs ?? []).map((l) => walkthroughToEvent(l, tz))),
    ],
    [unassignedJobs, unscheduledWalkthroughs, tz],
  );
  // Plan mode hides bucket cards that already have ghost drafts. Hidden ids are keyed the
  // way each entity drags: walkthroughs by bare LEAD id, jobs by job id (TG11 — the bucket
  // stack receives pre-filtered events; type splitting happens inside the component).
  const visibleBucketEvents = useMemo(
    () =>
      bucketEvents.filter((ev) =>
        ev.type === 'walkthrough'
          ? !hiddenSidebarIds.has(ev.raw.id as string)
          : !hiddenSidebarIds.has(ev.id),
      ),
    [bucketEvents, hiddenSidebarIds],
  );

  // ─── Client-side conflict detection ──────────────────
  // D7 — per-crew-member double-booking across jobs AND walkthroughs (visual only;
  // the backend independently enforces conflicts on write with a 409).
  const conflictIds = useMemo(() => conflictedEventIds(scheduledEvents), [scheduledEvents]);

  return { scheduledEvents, bucketEvents, visibleBucketEvents, conflictIds };
}
