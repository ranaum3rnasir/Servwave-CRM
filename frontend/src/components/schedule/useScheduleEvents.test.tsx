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
  status: 'UNASSIGNED',
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
    expect(result.current.scheduledEvents.map((e) => e.id)).toEqual(['job-1']);
    expect(result.current.bucketEvents.map((e) => e.id)).toEqual(['job-2']);
    expect(result.current.visibleBucketEvents.map((e) => e.id)).toEqual(['job-2']);
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
