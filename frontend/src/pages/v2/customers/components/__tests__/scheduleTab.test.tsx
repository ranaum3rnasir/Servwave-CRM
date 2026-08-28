import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';

import {
  ScheduleTab, buildScheduleRows, EventDetailDialog,
  type CalendarEntrySummary,
} from '../scheduleTab';
import type { JobSummary, LeadSummary } from '../detailTabs';

// floating-ui, under the kit Dialog, does `new ResizeObserver(...)`.
class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
global.ResizeObserver = ResizeObserverStub as unknown as typeof ResizeObserver;

const JOB: JobSummary = {
  id: 'job-1',
  job_number: 'J00041',
  status: 'SCHEDULED',
  scope_notes: 'Replace condenser',
  scheduled_start: '2026-09-10T14:00:00.000Z',
  completed_at: null,
  created_at: '2026-09-01T00:00:00.000Z',
};

const WALKTHROUGH_LEAD: LeadSummary = {
  id: 'lead-1',
  lead_number: 'L00012',
  status: 'NEW',
  service_request: 'AC not cooling',
  created_at: '2026-09-01T00:00:00.000Z',
  walkthrough_scheduled_at: '2026-09-05T09:00:00.000Z',
};

// No live walkthrough - must contribute NO row (buildScheduleRows filters these out).
const NON_WALKTHROUGH_LEAD: LeadSummary = {
  id: 'lead-2',
  lead_number: 'L00013',
  status: 'NEW',
  service_request: 'Furnace tune-up',
  created_at: '2026-09-01T00:00:00.000Z',
  walkthrough_scheduled_at: null,
};

const EVENT: CalendarEntrySummary = {
  id: 'entry-1',
  title: "Dave's follow-up call",
  description: 'Discuss financing options.',
  start: '2026-09-12T16:00:00.000Z',
  end: '2026-09-12T16:30:00.000Z',
  is_all_day: false,
  participants: [
    { id: 'p1', kind: 'USER', first_name: 'Dana', last_name: 'Brooks', name: null, email: null },
    { id: 'p2', kind: 'CUSTOMER', first_name: null, last_name: null, name: 'Doe HVAC', email: 'john@doe.com' },
  ],
};

const UNSCHEDULED_JOB: JobSummary = {
  id: 'job-2',
  job_number: 'J00099',
  status: 'UNSCHEDULED',
  scope_notes: null,
  scheduled_start: null,
  completed_at: null,
  created_at: '2026-09-01T00:00:00.000Z',
};

describe('buildScheduleRows', () => {
  it('merges jobs, walkthroughs (leads with a live walkthrough) and Events into one chronological list', () => {
    const rows = buildScheduleRows([JOB], [WALKTHROUGH_LEAD, NON_WALKTHROUGH_LEAD], [EVENT]);

    expect(rows.map((r) => r.kind)).toEqual(['walkthrough', 'job', 'event']);
    expect(rows.map((r) => r.id)).toEqual(['lead-1', 'job-1', 'entry-1']);
  });

  it('excludes a lead with no live walkthrough', () => {
    const rows = buildScheduleRows([], [NON_WALKTHROUGH_LEAD], []);
    expect(rows).toHaveLength(0);
  });

  it('sorts unscheduled (null-start) rows last, keeping timed rows in chronological order', () => {
    const rows = buildScheduleRows([JOB, UNSCHEDULED_JOB], [WALKTHROUGH_LEAD], [EVENT]);
    expect(rows.map((r) => r.id)).toEqual(['lead-1', 'job-1', 'entry-1', 'job-2']);
  });
});

describe('ScheduleTab', () => {
  it('renders a single time-ordered list across all three kinds, with a Job/Walkthrough/Event type chip', () => {
    render(
      <ScheduleTab
        jobs={[JOB]}
        leads={[WALKTHROUGH_LEAD]}
        calendarEntries={[EVENT]}
        onNavigateJob={vi.fn()}
        onNavigateWalkthrough={vi.fn()}
        onOpenEvent={vi.fn()}
      />,
    );

    const rows = screen.getAllByRole('row').slice(1); // drop the header row
    expect(rows).toHaveLength(3);
    // Chronological: walkthrough (Sep 5) -> job (Sep 10) -> event (Sep 12).
    expect(rows[0]).toHaveTextContent('Walkthrough');
    expect(rows[1]).toHaveTextContent('Job');
    expect(rows[1]).toHaveTextContent('J00041');
    expect(rows[2]).toHaveTextContent('Event');
    expect(rows[2]).toHaveTextContent("Dave's follow-up call");
  });

  it('shows no Events rows when calendarEntries is empty (the caller\'s ungranted-viewer shape), but still shows jobs and walkthroughs', () => {
    render(
      <ScheduleTab
        jobs={[JOB]}
        leads={[WALKTHROUGH_LEAD]}
        calendarEntries={[]}
        onNavigateJob={vi.fn()}
        onNavigateWalkthrough={vi.fn()}
        onOpenEvent={vi.fn()}
      />,
    );

    expect(screen.queryByText('Event')).toBeNull();
    expect(screen.getByText('AC not cooling')).toBeInTheDocument();
    expect(screen.getByText('J00041')).toBeInTheDocument();
  });

  it('renders the empty state when nothing is scheduled', () => {
    render(
      <ScheduleTab
        jobs={[]}
        leads={[]}
        calendarEntries={[]}
        onNavigateJob={vi.fn()}
        onNavigateWalkthrough={vi.fn()}
        onOpenEvent={vi.fn()}
      />,
    );
    expect(screen.getByText('Nothing scheduled yet.')).toBeInTheDocument();
  });

  it('clicking a job row calls onNavigateJob with the job id', () => {
    const onNavigateJob = vi.fn();
    render(
      <ScheduleTab
        jobs={[JOB]}
        leads={[]}
        calendarEntries={[]}
        onNavigateJob={onNavigateJob}
        onNavigateWalkthrough={vi.fn()}
        onOpenEvent={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByText('J00041').closest('tr')!);
    expect(onNavigateJob).toHaveBeenCalledWith('job-1');
  });

  it('clicking a walkthrough row calls onNavigateWalkthrough with the LEAD id', () => {
    const onNavigateWalkthrough = vi.fn();
    render(
      <ScheduleTab
        jobs={[]}
        leads={[WALKTHROUGH_LEAD]}
        calendarEntries={[]}
        onNavigateJob={vi.fn()}
        onNavigateWalkthrough={onNavigateWalkthrough}
        onOpenEvent={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByText('AC not cooling').closest('tr')!);
    expect(onNavigateWalkthrough).toHaveBeenCalledWith('lead-1');
  });

  it('clicking an Event row calls onOpenEvent with the full entry, not just its id', () => {
    const onOpenEvent = vi.fn();
    render(
      <ScheduleTab
        jobs={[]}
        leads={[]}
        calendarEntries={[EVENT]}
        onNavigateJob={vi.fn()}
        onNavigateWalkthrough={vi.fn()}
        onOpenEvent={onOpenEvent}
      />,
    );
    fireEvent.click(screen.getByText("Dave's follow-up call").closest('tr')!);
    expect(onOpenEvent).toHaveBeenCalledWith(EVENT);
  });
});

describe('EventDetailDialog', () => {
  it('renders the title, time range, description and participants, with no edit/delete control', () => {
    render(<EventDetailDialog entry={EVENT} open onOpenChange={vi.fn()} />);

    expect(screen.getByText("Dave's follow-up call")).toBeInTheDocument();
    expect(screen.getByText('Discuss financing options.')).toBeInTheDocument();
    expect(screen.getByText('Dana Brooks')).toBeInTheDocument();
    expect(screen.getByText('Doe HVAC')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /delete/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /save/i })).toBeNull();
    // Two "Close" buttons exist (the footer button and Radix's own dialog-close X) - both
    // read-only affordances, neither an edit/delete one, which is the thing under test.
    expect(screen.getAllByRole('button', { name: /close/i }).length).toBeGreaterThanOrEqual(1);
  });

  it('renders nothing when closed', () => {
    render(<EventDetailDialog entry={EVENT} open={false} onOpenChange={vi.fn()} />);
    expect(screen.queryByText("Dave's follow-up call")).toBeNull();
  });
});
