/**
 * Multi-visit spec slice S0b - the drift guard.
 *
 * The two board surfaces (MemberWeekBoard's BoardCard, TechnicianGridView's JobCard) used to carry
 * byte-identical copies of the same card body, including the `isWalk ? customer : title` branch
 * that multi-visit has to change. #1551 is the standing proof of what that costs: a shipped fix in
 * one schedule tree was silently reverted by its untouched copy in the other.
 *
 * These tests assert the two boards render the SAME card content for the SAME event - through the
 * rendered component, not by reaching into ScheduleCardBody. If a future edit reintroduces a
 * per-board branch, these fail regardless of how the sharing is implemented.
 *
 * S0b's premise was INCOMPLETE, corrected 2026-08-19 by driving the real board: there is a THIRD
 * card renderer, `ScheduleEvent` in pages/v2/schedule/SchedulePage, which paints the Standard
 * week view - the board a dispatcher lands on first - and shares no JSX with this body at all.
 * S6 shipped its "Visit N of M" label into this body only, so the Standard board painted three
 * identical unlabelled cards for a three-trip job. The visit-label suite at the bottom of this
 * file therefore covers all THREE renderers; see the comment there for why the earlier content
 * assertions cannot be extended the same way.
 */
import { describe, it, expect, vi } from 'vitest';
import { screen } from '@testing-library/react';
import { renderWithProviders } from '@/__tests__/helpers';
import { MemberWeekBoard } from '@/components/schedule/MemberWeekBoard';
import { TechnicianGridView } from '@/components/schedule/TechnicianGridView';
import { ScheduleEvent } from '@/pages/v2/schedule/SchedulePage';
import type { SchedulableEvent } from '@/components/schedule/scheduleModel';
import { asWallClock } from '@/lib/schedule-tz';

const DAY = new Date(2026, 5, 10);
const TZ = 'America/New_York';

const members = [
  { id: 'm-alice', first_name: 'Alice', last_name: 'Ng', is_active: true, role: 'TECHNICIAN' },
];

const walkthrough: SchedulableEvent = {
  boardId: 'wt-1',
  parentId: 'lead-1',
  type: 'walkthrough',
  number: 'L00021',
  title: 'Site survey',
  customer: 'Wayne Industries',
  crew: ['m-alice'],
  ownerId: null,
  start: asWallClock(new Date(2026, 5, 10, 9, 0)),
  end: asWallClock(new Date(2026, 5, 10, 10, 0)),
  raw: { service_address_line1: '12 Foundry Rd', service_city: 'Newark', service_state: 'NJ' },
};

const job: SchedulableEvent = {
  boardId: 'job-1',
  parentId: 'job-1',
  type: 'job',
  number: 'J00043',
  title: 'Rooftop Unit Swap',
  customer: 'Acme',
  crew: ['m-alice'],
  ownerId: null,
  start: asWallClock(new Date(2026, 5, 10, 13, 0)),
  end: asWallClock(new Date(2026, 5, 10, 15, 0)),
  // Two shapes in one row on purpose: the shared body reads the normalised `number`/`customer`
  // fields above, the Standard board's own card reads `raw.job_number`/`raw.customer`. One
  // fixture has to satisfy both for the drift guard to render the SAME event through all three.
  raw: {
    status: 'SCHEDULED',
    job_number: 'J00043',
    customer: { first_name: 'Ada', last_name: 'Byron' },
    service_location: { address: '5 Mill St', city: 'Trenton', state: 'NJ' },
  },
};

function renderWeekBoard(events: SchedulableEvent[]) {
  return renderWithProviders(
    <MemberWeekBoard
      weekStart={asWallClock(DAY)}
      staff={members}
      events={events}
      conflictIds={new Set()}
      isLoading={false}
      tz={TZ}
      onSelectEvent={vi.fn()}
      onDropJob={vi.fn()}
    />,
  );
}

function renderGrid(events: SchedulableEvent[]) {
  return renderWithProviders(
    <TechnicianGridView
      date={asWallClock(DAY)}
      events={events}
      members={members}
      conflictIds={new Set()}
      isLoading={false}
      draggingJobIdRef={{ current: null }}
      onDropJob={vi.fn()}
      onSelectJob={vi.fn()}
      onEventClick={vi.fn()}
    />,
  );
}

/**
 * The Standard week board's card. Rendered on its own rather than through SchedulePage because
 * the assertion is about the CARD, and the page would drag react-big-calendar's grid, the API
 * fakes and the whole board chrome in to reach the same DOM. `ScheduleEvent` reads its handlers
 * from a context whose default value is a no-op, so it stands up alone.
 */
function renderStandardCard(event: SchedulableEvent) {
  return renderWithProviders(<ScheduleEvent event={event} />);
}

describe('both boards render the same card content (S0b drift guard)', () => {
  it('a walkthrough card leads with "Walkthrough" and shows the customer as its title on both boards', () => {
    const week = renderWeekBoard([walkthrough]);
    expect(screen.getAllByText('Walkthrough').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Wayne Industries').length).toBeGreaterThan(0);
    // The lead number rides alongside the label rather than replacing it.
    expect(screen.getAllByText('L00021').length).toBeGreaterThan(0);
    week.unmount();

    renderGrid([walkthrough]);
    expect(screen.getAllByText('Walkthrough').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Wayne Industries').length).toBeGreaterThan(0);
    expect(screen.getAllByText('L00021').length).toBeGreaterThan(0);
  });

  it('a job card leads with its job number and shows its scope title on both boards', () => {
    const week = renderWeekBoard([job]);
    expect(screen.getAllByText('J00043').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Rooftop Unit Swap').length).toBeGreaterThan(0);
    // A job whose customer differs from its title shows BOTH - the walkthrough branch shows one.
    expect(screen.getAllByText('Acme').length).toBeGreaterThan(0);
    week.unmount();

    renderGrid([job]);
    expect(screen.getAllByText('J00043').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Rooftop Unit Swap').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Acme').length).toBeGreaterThan(0);
  });

  it('resolves a walkthrough address from the lead fields and a job address from service_location, on both boards', () => {
    const week = renderWeekBoard([walkthrough, job]);
    expect(screen.getAllByText('12 Foundry Rd, Newark, NJ').length).toBeGreaterThan(0);
    expect(screen.getAllByText('5 Mill St, Trenton').length).toBeGreaterThan(0);
    week.unmount();

    renderGrid([walkthrough, job]);
    expect(screen.getAllByText('12 Foundry Rd, Newark, NJ').length).toBeGreaterThan(0);
    expect(screen.getAllByText('5 Mill St, Trenton').length).toBeGreaterThan(0);
  });
});

/**
 * ALL THREE renderers, not two.
 *
 * Only the visit label is asserted across the third one, and that is a real limit rather than
 * laziness: the Standard board's card and the shared body genuinely say different things about
 * the same event. The shared body leads with the job number and prints the scope title; the
 * Standard card leads with "number - customer" and prints the crew instead of the scope. So
 * there is no honest single assertion for the title/customer/address rows - forcing one would
 * mean rewriting one board's content, which is a design decision and not a guard. The visit
 * label IS shared vocabulary (visitLabel in scheduleModel), so it is guarded here for all three.
 * A fourth renderer, or a fourth wording, fails this block.
 */
describe('the card says WHICH visit it is, identically on ALL THREE boards (S6, F2, D13)', () => {
  /** D13: the label reads visit_seq (creation order), never the position in the sorted board. */
  const secondOfThree: SchedulableEvent = {
    ...job,
    boardId: 'jv-3f2a1c88-0000-0000-0000-000000000002',
    visitId: '3f2a1c88-0000-0000-0000-000000000002',
    visitSeq: 2,
    visitCount: 3,
  };

  it('a job with three trips labels this card "Visit 2 of 3" on every board', () => {
    const week = renderWeekBoard([secondOfThree]);
    expect(screen.getAllByText('Visit 2 of 3').length).toBeGreaterThan(0);
    week.unmount();

    const grid = renderGrid([secondOfThree]);
    expect(screen.getAllByText('Visit 2 of 3').length).toBeGreaterThan(0);
    grid.unmount();

    renderStandardCard(secondOfThree);
    expect(screen.getAllByText('Visit 2 of 3').length).toBeGreaterThan(0);
  });

  it('a single-trip job gains no visit label at all, on any board - the 99% case must not gain noise', () => {
    const single: SchedulableEvent = { ...job, boardId: 'jv-v1', visitId: 'v1', visitSeq: 1, visitCount: 1 };

    const week = renderWeekBoard([single]);
    expect(screen.queryByText(/^Visit \d+ of \d+$/)).not.toBeInTheDocument();
    week.unmount();

    const grid = renderGrid([single]);
    expect(screen.queryByText(/^Visit \d+ of \d+$/)).not.toBeInTheDocument();
    grid.unmount();

    renderStandardCard(single);
    expect(screen.queryByText(/^Visit \d+ of \d+$/)).not.toBeInTheDocument();
  });

  it('never prints the board id when the number is missing - a card must not show a UUID', () => {
    const numberless: SchedulableEvent = { ...secondOfThree, number: '' };

    const week = renderWeekBoard([numberless]);
    expect(screen.queryByText(/^jv-/)).not.toBeInTheDocument();
    week.unmount();

    renderGrid([numberless]);
    expect(screen.queryByText(/^jv-/)).not.toBeInTheDocument();
  });
});
