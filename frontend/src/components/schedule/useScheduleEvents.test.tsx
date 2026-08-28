import { describe, it, expect } from 'vitest';
import { renderHook } from '@testing-library/react';
import { useScheduleEvents } from './useScheduleEvents';

const scheduledJob = {
  id: 'job-1',
  job_number: 'J00001',
  scope_notes: 'Fix unit',
  customer: { first_name: 'Ada', last_name: 'Lovelace', company_name: null },
  scheduled_start: '2026-06-02T15:00:00.000Z',
  scheduled_end: '2026-06-02T17:00:00.000Z',
  status: 'SCHEDULED',
  assignees: [{ user: { id: 'u-1', first_name: 'Tech', last_name: 'One' } }],
};
const unassignedJob = {
  id: 'job-2',
  job_number: 'J00002',
  scope_notes: '',
  customer: { first_name: 'Grace', last_name: 'Hopper', company_name: null },
  scheduled_start: null,
  scheduled_end: null,
  status: 'UNSCHEDULED',
  assignees: [],
};

describe('useScheduleEvents', () => {
  it('builds scheduledEvents from jobs+walkthroughs and narrows to placed events only', () => {
    const { result } = renderHook(() =>
      useScheduleEvents({
        scheduledJobs: [scheduledJob],
        walkthroughLeads: [],
        unassignedJobs: [unassignedJob],
        unscheduledWalkthroughs: [],
        hiddenSidebarIds: new Set<string>(),
        tz: 'America/New_York',
      }),
    );
    expect(result.current.scheduledEvents.map((e) => e.boardId)).toEqual(['job-1']);
    expect(result.current.bucketEvents.map((e) => e.boardId)).toEqual(['job-2']);
    expect(result.current.visibleBucketEvents.map((e) => e.boardId)).toEqual(['job-2']);
    expect(result.current.conflictIds.size).toBe(0);
  });

  it('hides a bucket job whose id is in hiddenSidebarIds', () => {
    const { result } = renderHook(() =>
      useScheduleEvents({
        scheduledJobs: [],
        walkthroughLeads: [],
        unassignedJobs: [unassignedJob],
        unscheduledWalkthroughs: [],
        hiddenSidebarIds: new Set<string>(['job-2']),
        tz: 'America/New_York',
      }),
    );
    expect(result.current.visibleBucketEvents).toHaveLength(0);
  });
});

// ─── Slice 03 — calendar entries merge into scheduledEvents, never bucketEvents ───────────────

const calendarEntry = {
  id: 'entry-1',
  title: 'Dave is off Thursday',
  description: '',
  // Squarely inside scheduledJob's 15:00–17:00Z window (a genuine overlap, not a touching edge).
  start: '2026-06-02T15:30:00.000Z',
  end: '2026-06-02T16:30:00.000Z',
  is_all_day: false,
};

describe('useScheduleEvents — calendar entries (slice 03)', () => {
  it('a timed calendar entry lands in scheduledEvents, never in bucketEvents/visibleBucketEvents', () => {
    const { result } = renderHook(() =>
      useScheduleEvents({
        scheduledJobs: [],
        walkthroughLeads: [],
        unassignedJobs: [],
        unscheduledWalkthroughs: [],
        calendarEntries: [calendarEntry],
        hiddenSidebarIds: new Set<string>(),
        tz: 'America/New_York',
      }),
    );
    expect(result.current.scheduledEvents.map((e) => e.boardId)).toEqual(['ce-entry-1']);
    expect(result.current.bucketEvents).toHaveLength(0);
    expect(result.current.visibleBucketEvents).toHaveLength(0);
  });

  it('a calendar entry sharing a time window with a crewed job produces no conflict (ADR 0002)', () => {
    const { result } = renderHook(() =>
      useScheduleEvents({
        scheduledJobs: [scheduledJob],
        walkthroughLeads: [],
        unassignedJobs: [],
        unscheduledWalkthroughs: [],
        calendarEntries: [calendarEntry],
        hiddenSidebarIds: new Set<string>(),
        tz: 'America/New_York',
      }),
    );
    expect(result.current.scheduledEvents).toHaveLength(2);
    expect(result.current.conflictIds.size).toBe(0);
  });

  it('calendarEntries omitted entirely (pre-slice-03 callers) — behaves exactly as before', () => {
    const { result } = renderHook(() =>
      useScheduleEvents({
        scheduledJobs: [scheduledJob],
        walkthroughLeads: [],
        unassignedJobs: [unassignedJob],
        unscheduledWalkthroughs: [],
        hiddenSidebarIds: new Set<string>(),
        tz: 'America/New_York',
      }),
    );
    expect(result.current.scheduledEvents.map((e) => e.boardId)).toEqual(['job-1']);
  });
});
