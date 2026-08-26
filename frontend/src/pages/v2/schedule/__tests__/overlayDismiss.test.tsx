/**
 * The page-level dismissal predicate behind SchedulePage's capturing document
 * `mousedown` listener (`../overlayDismiss`), pinned against the quick-schedule
 * card that actually depends on it.
 *
 * THE BUG THIS GUARDS: the card carries a start-time and an end-time TimeSelect.
 * Clicking from one to the other closed the whole card and opened a fresh one in
 * its place. A Radix Select holds `pointer-events: none` on `<body>` while its
 * list is open, so the press that dismisses that list cannot hit anything inside
 * `<body>` - the card included - and the browser retargets it to `<html>`. The
 * predicate read that as an outside click, dismissed the card, and
 * react-big-calendar's own document `mousedown` then started a fresh slot
 * selection over the freed space.
 *
 * jsdom has no layout and no hit-testing, so the two portalled cases are stood
 * in for rather than produced: the retarget is asserted by handing the predicate
 * the target a real browser hands it (`document.documentElement`), and the
 * portalled list by a `[data-radix-popper-content-wrapper]` node of the shape
 * Radix renders. The card itself is the real component.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { screen } from '@testing-library/react';

import { renderWithProviders } from '@/__tests__/helpers';

import { QuickScheduleCard } from '../components/quickScheduleCard';
import { isScheduleOverlayInteraction } from '../overlayDismiss';

function renderCard() {
  const props = {
    x: 120,
    y: 140,
    startTime: new Date(2026, 5, 10, 9, 0).toISOString(),
    endTime: new Date(2026, 5, 10, 11, 0).toISOString(),
    tz: 'America/New_York',
    unassignedJobs: [],
    unscheduledWalkthroughs: [],
    onSelectJob: vi.fn(),
    onSelectWalkthrough: vi.fn(),
    onClose: vi.fn(),
    onTimeChange: vi.fn(),
  };
  const { container } = renderWithProviders(<QuickScheduleCard {...props} />);
  return { ...props, container };
}

/** A node of the shape Radix portals its open Select list into. */
function portalledList(): HTMLElement {
  const wrapper = document.createElement('div');
  wrapper.setAttribute('data-radix-popper-content-wrapper', '');
  const item = document.createElement('div');
  item.textContent = '9:30 AM';
  wrapper.appendChild(item);
  document.body.appendChild(wrapper);
  return item;
}

let strays: HTMLElement[] = [];

beforeEach(() => {
  strays = [];
});

afterEach(() => {
  strays.forEach((el) => el.remove());
});

describe('SchedulePage overlay dismissal - what counts as a press INSIDE an overlay', () => {
  it('the card is the surface the predicate recognises, and both time pickers sit inside it', () => {
    renderCard();
    const triggers = screen.getAllByRole('combobox');
    expect(triggers).toHaveLength(2); // start time + end time
    triggers.forEach((trigger) => {
      expect(trigger.closest('[data-schedule-overlay]')).not.toBeNull();
      expect(isScheduleOverlayInteraction(trigger)).toBe(true);
    });
  });

  it('REGRESSION: the press retargeted to the document root while a time list is open is NOT outside', () => {
    renderCard();
    // What the browser hands the listener once Radix has put `pointer-events:
    // none` on <body>: the pointer is over the card, but nothing in <body> can
    // be hit. Treating this as an outside click closed the card and let the
    // calendar open a brand-new one underneath.
    expect(isScheduleOverlayInteraction(document.documentElement)).toBe(true);
    expect(isScheduleOverlayInteraction(document.body)).toBe(true);
  });

  it('the open time list itself is inside, wherever Radix portals it', () => {
    renderCard();
    const item = portalledList();
    strays.push(item.parentElement as HTMLElement);
    expect(isScheduleOverlayInteraction(item)).toBe(true);
  });

  it('SENSITIVITY: a press on the calendar behind the card still dismisses it', () => {
    renderCard();
    const slot = document.createElement('div');
    slot.className = 'rbc-day-slot';
    document.body.appendChild(slot);
    strays.push(slot);
    expect(isScheduleOverlayInteraction(slot)).toBe(false);
  });

  it('a target that is not an element dismisses too (nothing to reason about)', () => {
    expect(isScheduleOverlayInteraction(null)).toBe(false);
    expect(isScheduleOverlayInteraction(document)).toBe(false);
  });
});
