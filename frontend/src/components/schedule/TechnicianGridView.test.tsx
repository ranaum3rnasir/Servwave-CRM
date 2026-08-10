// TG6 — D1 multi-column rendering: an event renders in EVERY assigned crew member's
// column. This is the contract that replaces the pre-redesign single-assignee model.
// TG10 — board cards write the swap channels (from-member) and hour-slot drops deliver them.
import { describe, it, expect, vi } from 'vitest';
import { screen, fireEvent } from '@testing-library/react';
import { renderWithProviders } from '@/__tests__/helpers';
import { TechnicianGridView } from '@/components/schedule/TechnicianGridView';
import { JOB_ID, GRID_EVENT_ID, GRID_EVENT_TYPE, FROM_MEMBER } from '@/components/schedule/dragChannels';
import type { SchedulableEvent } from '@/components/schedule/scheduleModel';
import { asWallClock } from '@/lib/schedule-tz';

const twoCrewJob: SchedulableEvent = {
  id: 'job-1',
  type: 'job',
  number: 'J00043',
  title: 'Rooftop Unit Swap',
  customer: 'Acme',
  crew: ['m-alice', 'm-bob'],
  ownerId: null,
  start: asWallClock(new Date(2026, 5, 10, 9, 0)),
  end: asWallClock(new Date(2026, 5, 10, 11, 0)),
  raw: {},
};

const soloJob: SchedulableEvent = {
  id: 'job-2',
  type: 'job',
  number: 'J00044',
  title: 'Filter Replacement',
  customer: 'Globex',
  crew: ['m-bob'],
  ownerId: null,
  start: asWallClock(new Date(2026, 5, 10, 13, 0)),
  end: asWallClock(new Date(2026, 5, 10, 14, 0)),
  raw: {},
};

const members = [
  { id: 'm-alice', first_name: 'Alice', last_name: 'Ng', is_active: true, role: 'TECHNICIAN' },
  { id: 'm-bob', first_name: 'Bob', last_name: 'Ortiz', is_active: true, role: 'TECHNICIAN' },
];

function renderGrid(
  events: SchedulableEvent[],
  conflictIds: Set<string> = new Set(),
  onDropJob = vi.fn(),
) {
  renderWithProviders(
    <TechnicianGridView
      date={asWallClock(new Date(2026, 5, 10))}
      events={events}
      members={members}
      conflictIds={conflictIds}
      isLoading={false}
      draggingJobIdRef={{ current: null }}
      onDropJob={onDropJob}
      onSelectJob={vi.fn()}
      onEventClick={vi.fn()}
    />,
  );
  return onDropJob;
}

describe('TechnicianGridView — D1 multi-column rendering', () => {
  it("renders a 2-crew job in BOTH members' columns", () => {
    renderGrid([twoCrewJob]);
    expect(screen.getAllByText('Rooftop Unit Swap')).toHaveLength(2);
  });

  it('renders a single-crew job in exactly one column', () => {
    renderGrid([twoCrewJob, soloJob]);
    expect(screen.getAllByText('Rooftop Unit Swap')).toHaveLength(2);
    expect(screen.getAllByText('Filter Replacement')).toHaveLength(1);
  });

  it('does not render a crew-less (state 4) event in any member column', () => {
    renderGrid([{ ...twoCrewJob, crew: [] }]);
    expect(screen.queryByText('Rooftop Unit Swap')).not.toBeInTheDocument();
  });

  it('does not render an event scheduled on a DIFFERENT date (pins the isSameDay leg)', () => {
    renderGrid([
      {
        ...twoCrewJob,
        start: asWallClock(new Date(2026, 5, 11, 9, 0)),
        end: asWallClock(new Date(2026, 5, 11, 11, 0)),
      },
    ]);
    expect(screen.queryByText('Rooftop Unit Swap')).not.toBeInTheDocument();
  });
});

describe('TechnicianGridView — the two reds (D7 red outline; state 4 is structural)', () => {
  it("a conflicted 2-crew event shows the double-booked treatment in BOTH members' columns", () => {
    renderGrid([twoCrewJob], new Set([twoCrewJob.id]));
    expect(screen.getAllByText(/double-booked/i)).toHaveLength(2);
  });

  it('a non-conflicted event shows no double-booked treatment', () => {
    renderGrid([twoCrewJob]);
    expect(screen.queryByText(/double-booked/i)).not.toBeInTheDocument();
  });
});

describe('TechnicianGridView — TG10 swap wiring (board cards carry their lane)', () => {
  it("dragging Bob's card writes grid-event-id/type + from-member=bob (codec channels)", () => {
    renderGrid([soloJob]); // crew: ['m-bob'] → exactly one card, in Bob's column
    const setData = vi.fn();
    const card = screen.getByText('Filter Replacement').closest('[draggable="true"]');
    expect(card).not.toBeNull();
    fireEvent.dragStart(card!, { dataTransfer: { setData, effectAllowed: 'none' } });
    expect(setData).toHaveBeenCalledWith(GRID_EVENT_ID, 'job-2');
    expect(setData).toHaveBeenCalledWith(GRID_EVENT_TYPE, 'job');
    expect(setData).toHaveBeenCalledWith(FROM_MEMBER, 'm-bob');
  });

  it("a board card from Bob's lane dropped on Alice's hour slot delivers from-member to onDropJob", () => {
    const onDropJob = renderGrid([soloJob]);
    const slot = screen.getByTestId('grid-slot-m-alice-13'); // 1 PM slot in Alice's column
    fireEvent.drop(slot, {
      dataTransfer: {
        getData: (k: string) => (k === GRID_EVENT_ID ? 'job-2' : k === FROM_MEMBER ? 'm-bob' : ''),
        types: [GRID_EVENT_ID, GRID_EVENT_TYPE, FROM_MEMBER],
      },
    });
    expect(onDropJob).toHaveBeenCalledTimes(1);
    // The page classifies from≠to as a SWAP (the slot time is ignored there).
    expect(onDropJob).toHaveBeenCalledWith(
      'job-2',
      'm-alice',
      new Date(2026, 5, 10, 13, 0),
      new Date(2026, 5, 10, 15, 0),
      'm-bob',
    );
  });

  it('a bucket-card drop (job-id channel, no from-member) delivers null', () => {
    const onDropJob = renderGrid([]);
    const slot = screen.getByTestId('grid-slot-m-bob-9');
    fireEvent.drop(slot, {
      dataTransfer: {
        getData: (k: string) => (k === JOB_ID ? 'job-7' : ''),
        types: [JOB_ID],
      },
    });
    expect(onDropJob).toHaveBeenCalledWith(
      'job-7',
      'm-bob',
      new Date(2026, 5, 10, 9, 0),
      new Date(2026, 5, 10, 11, 0),
      null,
    );
  });
});

describe('TechnicianGridView — type accents (META)', () => {
  it('a crewed job (no conflict) renders the job accent — no red fill', () => {
    renderGrid([soloJob]);
    const card = screen.getByText('Filter Replacement').closest('[draggable="true"]');
    expect(card).not.toBeNull();
    // Red fill is reserved for needs-crew (state 4) — a crewed job keeps the job accent.
    expect(card).not.toHaveClass('bg-danger');
    expect(card).toHaveClass('bg-info/5');
    expect(card).toHaveClass('border-l-info');
  });

  it('a walkthrough card carries the META warning accent (legend parity), not the legacy cyan', () => {
    const walkthrough: SchedulableEvent = {
      id: 'wt-1',
      type: 'walkthrough',
      number: 'L00012',
      title: 'Walkthrough',
      customer: 'Initech',
      crew: ['m-alice'],
      ownerId: null,
      start: asWallClock(new Date(2026, 5, 10, 15, 0)),
      end: asWallClock(new Date(2026, 5, 10, 16, 0)),
      raw: {},
    };
    renderGrid([walkthrough]);
    const card = screen.getByText('Initech').closest('[draggable="true"]');
    expect(card).not.toBeNull();
    expect(card).toHaveClass('bg-warning/5');
    expect(card).toHaveClass('border-l-warning');
    expect(card).not.toHaveClass('bg-cyan-50');
  });
});
