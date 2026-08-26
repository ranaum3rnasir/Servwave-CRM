/**
 * QA finding 3 (slice 05, calendar-entries spec §3 "What to build"): the all-day slot popover
 * must be able to seed a new Event, not only a job/walkthrough. `onCreateEvent` is an optional
 * prop precisely so the regular TIMED slot popover (which never passes it) is unaffected -
 * driven through the public interface (render, click), never component internals.
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { QuickScheduleCard } from '../quickScheduleCard';

const baseProps = {
  x: 100,
  y: 100,
  startTime: '2026-08-24T04:00:00.000Z',
  endTime: '2026-08-25T04:00:00.000Z',
  tz: 'America/New_York',
  unassignedJobs: [],
  unscheduledWalkthroughs: [],
  onSelectJob: vi.fn(),
  onSelectWalkthrough: vi.fn(),
  onClose: vi.fn(),
};

describe('QuickScheduleCard - onCreateEvent (slice 05)', () => {
  it('omitting onCreateEvent renders no Event affordance (regular timed popover, unaffected)', () => {
    render(<QuickScheduleCard {...baseProps} />);
    expect(screen.queryByRole('button', { name: /new event/i })).not.toBeInTheDocument();
  });

  it('passing onCreateEvent renders a New Event affordance that fires it on click', async () => {
    const user = userEvent.setup();
    const onCreateEvent = vi.fn();

    render(<QuickScheduleCard {...baseProps} onCreateEvent={onCreateEvent} />);

    const button = screen.getByRole('button', { name: /new event/i });
    await user.click(button);

    expect(onCreateEvent).toHaveBeenCalledTimes(1);
  });
});
