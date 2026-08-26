/**
 * The v2 event editor - the port of
 * `src/components/schedule/EventEditor.test.tsx` onto the rebuilt component at
 * `pages/v2/schedule/components/eventEditor.tsx`.
 *
 * The contract is unchanged by the rebuild: this is the ONLY per-person crew
 * path (drags are whole-lane swaps, the D5 modal is initial scheduling), it is
 * a PURE controlled dialog that stages crew and time drafts locally and emits
 * onSaveCrew / onSaveTime / onUnschedule / onClose, and the commission owner is
 * OFF-BOARD - display only.
 *
 * ONE ASSERTION HAD TO CHANGE, and the change is the finding rather than a
 * concession:
 *
 *  1. NAVIGATION TARGETS ARE PINNED. `detailUrlOf` runs the path through
 *     `preferV2Path`, so the popup navigates to `/jobs/:id` and
 *     `/leads/:id?tab=walkthrough` - the same destinations the original
 *     component used. They were `/v2`-prefixed for as long as the two designs
 *     sat at different URLs; `preferV2Path` is a no-op shim now (see `uiV2.ts`),
 *     so the destinations are pinned here to catch it ever growing logic again.
 *
 *  2. CALL / TEXT ARE BUTTONS, NOT ANCHORS. The legacy pair are raw `tel:` and
 *     `sms:` anchors carrying the destination in `href`. The raw-anchor ratchet
 *     is at its floor, so the v2 pair are kit Buttons that assign
 *     `window.location.href` on click. Same destinations and same accessible
 *     names, reached differently - so `toHaveAttribute('href', ...)` becomes a
 *     click plus an assertion on the assigned location. This is a real
 *     behavioural difference: there is no middle-click, no long-press "copy
 *     link", and no href for a screen reader's link list.
 */
import { asWallClock } from '@/lib/schedule-tz';
import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import type { ComponentProps } from 'react';
import { screen, fireEvent } from '@testing-library/react';

import { renderWithProviders } from '@/__tests__/helpers';
import api from '@/lib/axios';
import type { SchedulableEvent } from '@/components/schedule/scheduleModel';
import type { AssignableUser } from '@/lib/api/users';

import { EM } from '../glyphs';
import { EventEditor } from '../components/eventEditor';

// Navigation spy: whole-popup click + Open-full-page must navigate via useNavigate.
const navSpy = vi.hoisted(() => vi.fn());
vi.mock('react-router-dom', async (orig) => ({
  ...(await orig() as object),
  useNavigate: () => navSpy,
}));

// The call/text buttons assign window.location.href. jsdom's real Location
// cannot be assigned to, so it is swapped for a plain object for this file.
const REAL_LOCATION = window.location;
Object.defineProperty(window, 'location', {
  configurable: true,
  writable: true,
  value: { ...window.location, href: '' },
});
afterAll(() => {
  Object.defineProperty(window, 'location', { configurable: true, value: REAL_LOCATION });
});

const MEMBERS: AssignableUser[] = [
  { id: 'u-alice', first_name: 'Alice', last_name: 'Ng', role: 'TECHNICIAN', is_active: true, has_login: true, phone: '555-0101', department: null },
  { id: 'u-bob', first_name: 'Bob', last_name: 'Ortiz', role: 'TECHNICIAN', is_active: true, has_login: true, phone: null, department: null },
];

const OWNER = { id: 'u-olivia', first_name: 'Olivia', last_name: 'Owner' };

/** State-2 job: crew >=1 + timed, SCHEDULED; owner reached via estimate.lead. */
const scheduledJob: SchedulableEvent = {
  boardId: 'job-1',
  parentId: 'job-1',
  type: 'job',
  number: 'J00043',
  title: 'Rooftop Unit Swap',
  customer: 'Acme Corp',
  crew: ['u-alice', 'u-bob'],
  ownerId: 'u-olivia',
  start: asWallClock(new Date(2026, 5, 10, 9, 0)),
  end: asWallClock(new Date(2026, 5, 10, 11, 0)),
  raw: {
    status: 'SCHEDULED',
    customer: { phone: '555-0199' },
    assignees: [
      { user: { id: 'u-alice', first_name: 'Alice', last_name: 'Ng' } },
      { user: { id: 'u-bob', first_name: 'Bob', last_name: 'Ortiz' } },
    ],
    estimate: { lead: { commission_owner: OWNER } },
  },
};

/** Timed walkthrough - owner read straight off lead.commission_owner. */
const walkthrough: SchedulableEvent = {
  boardId: 'wt-lead-1',
  parentId: 'lead-1',
  type: 'walkthrough',
  number: 'L00012',
  title: 'Initial site visit',
  customer: 'Acme Corp',
  crew: ['u-alice'],
  ownerId: 'u-olivia',
  start: asWallClock(new Date(2026, 5, 11, 14, 0)),
  end: asWallClock(new Date(2026, 5, 11, 15, 0)),
  raw: {
    id: 'lead-1',
    status: 'CONTACTED',
    walkthrough_performers: [{ user: { id: 'u-alice', first_name: 'Alice', last_name: 'Ng' } }],
    commission_owner: OWNER,
  },
};

/** State-3 job: keeps its crew, no time. */
const unscheduledJob: SchedulableEvent = {
  ...scheduledJob,
  boardId: 'job-2',
  parentId: 'job-2',
  number: 'J00044',
  start: null,
  end: null,
};

function renderEditor(over: Partial<ComponentProps<typeof EventEditor>> = {}) {
  const onSaveCrew = vi.fn();
  const onSaveTime = vi.fn();
  const onUnschedule = vi.fn();
  const onComplete = vi.fn();
  const onClose = vi.fn();
  renderWithProviders(
    <EventEditor
      open
      event={scheduledJob}
      members={MEMBERS}
      canUnschedule
      onSaveCrew={onSaveCrew}
      onSaveTime={onSaveTime}
      onUnschedule={onUnschedule}
      onComplete={onComplete}
      onClose={onClose}
      {...over}
    />,
  );
  return { onSaveCrew, onSaveTime, onUnschedule, onComplete, onClose };
}

beforeEach(() => {
  // MultiAssigneeSelect self-fetches the org-wide assignable roster for chip labels.
  vi.mocked(api.get).mockResolvedValue({ data: { users: MEMBERS } });
  vi.mocked(api.post).mockClear();
  navSpy.mockClear();
  window.location.href = '';
});

describe('v2 EventEditor', () => {
  it('renders a state-2 job: type pill, state chip, owner row, crew chips, time inputs', async () => {
    renderEditor();
    // Header: type pill + number + title + customer
    expect(screen.getByText('Job')).toBeInTheDocument();
    expect(screen.getByText('J00043')).toBeInTheDocument();
    expect(screen.getByText(/Rooftop Unit Swap/)).toBeInTheDocument();
    expect(screen.getByText(/Acme Corp/)).toBeInTheDocument();
    // State chip - label + hint from STATE_META
    expect(screen.getByText('Scheduled')).toBeInTheDocument();
    expect(screen.getByText(/crew ≥1 · timed/)).toBeInTheDocument();
    // Owner row - off-board, read-only
    expect(screen.getByText('Owner (off-board)')).toBeInTheDocument();
    expect(screen.getByText('Olivia Owner')).toBeInTheDocument();
    // Current crew as chips (labels resolve from the roster query). Alice also has a
    // contact row (she has a phone) so her name can appear more than once.
    expect((await screen.findAllByText('Alice Ng')).length).toBeGreaterThan(0);
    expect((await screen.findAllByText('Bob Ortiz')).length).toBeGreaterThan(0);
    // Timed, so the schedule fields are pre-filled from the event. Both are
    // typeable pickers now (`_shared/datePicker` / `_shared/timeCombobox`), so
    // they DISPLAY US text - MM/DD/YYYY and a 12-hour clock - where the native
    // inputs showed their raw 'yyyy-MM-dd' / 'HH:mm' in the browser's locale.
    // The value handed to the handlers is unchanged.
    expect(screen.getByLabelText('Start date')).toHaveValue('06/10/2026');
    expect(screen.getByLabelText('Start time')).toHaveValue('9:00 AM');
    // The event's duration reads as an end, not as a Duration dropdown: `onSaveTime`
    // still speaks start + durationMin, and the duration is derived at that seam.
    expect(screen.getByLabelText('End date')).toHaveValue('06/10/2026');
    expect(screen.getByLabelText('End time')).toHaveValue('11:00 AM');
    expect(screen.queryByLabelText('Duration')).not.toBeInTheDocument();
    // Nothing is dirty yet, so no save buttons
    expect(screen.queryByRole('button', { name: 'Save crew' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Save time' })).not.toBeInTheDocument();
  });

  it('crew edit + Save crew emits the full REPLACE array - and the component never POSTs', async () => {
    const { onSaveCrew } = renderEditor();
    fireEvent.click(await screen.findByLabelText('Remove Alice Ng'));
    // Draft differs from the event crew, so the explicit save button appears
    fireEvent.click(screen.getByRole('button', { name: 'Save crew' }));
    expect(onSaveCrew).toHaveBeenCalledWith(['u-bob']);
    expect(vi.mocked(api.post)).not.toHaveBeenCalled();
  });

  it('time edit + Save time emits (start, durationMin) - page owns the POST', () => {
    const { onSaveTime } = renderEditor();
    // A typeable field commits on blur, so the edit is change-then-blur. It
    // still emits 'HH:mm' to handleTimeChange, hence the same Date below.
    fireEvent.change(screen.getByLabelText('Start time'), { target: { value: '1:30 PM' } });
    fireEvent.blur(screen.getByLabelText('Start time'));
    fireEvent.click(screen.getByRole('button', { name: 'Save time' }));
    expect(onSaveTime).toHaveBeenCalledWith(new Date(2026, 5, 10, 13, 30), 120);
    expect(vi.mocked(api.post)).not.toHaveBeenCalled();
  });

  it('Move to Unscheduled fires onUnschedule (page owns confirm + POST)', () => {
    const { onUnschedule } = renderEditor();
    fireEvent.click(screen.getByRole('button', { name: /Move to Unscheduled/ }));
    expect(onUnschedule).toHaveBeenCalledTimes(1);
    expect(vi.mocked(api.post)).not.toHaveBeenCalled();
  });

  it('canUnschedule=false disables the button and renders the reason', () => {
    renderEditor({
      canUnschedule: false,
      unscheduleDisabledReason: "In-progress jobs can't be unscheduled.",
    });
    expect(screen.getByRole('button', { name: /Move to Unscheduled/ })).toBeDisabled();
    expect(screen.getByText("In-progress jobs can't be unscheduled.")).toBeInTheDocument();
  });

  it('a walkthrough renders its type pill and owner', () => {
    renderEditor({ event: walkthrough });
    expect(screen.getByText('Walkthrough')).toBeInTheDocument();
    expect(screen.getByText('L00012')).toBeInTheDocument();
    expect(screen.getByText('Owner (off-board)')).toBeInTheDocument();
    expect(screen.getByText('Olivia Owner')).toBeInTheDocument();
  });

  it('readOnly renders crew as plain text with no editing affordances', () => {
    renderEditor({ readOnly: true });
    // Joined names are per-member rows - both names still queryable.
    expect(screen.getByText('Alice Ng')).toBeInTheDocument();
    expect(screen.getByText('Bob Ortiz')).toBeInTheDocument();
    expect(screen.queryByLabelText('Remove Alice Ng')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Save crew' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Save time' })).not.toBeInTheDocument();
    // The unschedule action is hidden entirely when readOnly
    expect(screen.queryByRole('button', { name: /Move to Unscheduled/ })).not.toBeInTheDocument();
    // Time renders as text, not inputs
    expect(screen.queryByLabelText('Start date')).not.toBeInTheDocument();
  });

  it('an unscheduled event says so - no time inputs, no unschedule button', () => {
    renderEditor({ event: unscheduledJob });
    expect(screen.getByText(new RegExp(`Unscheduled ${EM}`))).toBeInTheDocument();
    expect(screen.queryByLabelText('Start date')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Start time')).not.toBeInTheDocument();
    // Move to Unscheduled is for TIMED events only
    expect(screen.queryByRole('button', { name: /Move to Unscheduled/ })).not.toBeInTheDocument();
  });

  it('Mark Complete is a job-only, canComplete-only affordance and emits onComplete', () => {
    const { onComplete } = renderEditor({ canComplete: true });
    fireEvent.click(screen.getByRole('button', { name: /Mark Complete/ }));
    expect(onComplete).toHaveBeenCalledTimes(1);
    expect(vi.mocked(api.post)).not.toHaveBeenCalled();
  });

  it('Mark Complete is absent without canComplete, on a walkthrough, and when readOnly', () => {
    renderEditor();
    expect(screen.queryByRole('button', { name: /Mark Complete/ })).not.toBeInTheDocument();
    renderEditor({ event: walkthrough, canComplete: true });
    expect(screen.queryByRole('button', { name: /Mark Complete/ })).not.toBeInTheDocument();
    renderEditor({ canComplete: true, readOnly: true });
    expect(screen.queryByRole('button', { name: /Mark Complete/ })).not.toBeInTheDocument();
  });

  // ── whole-popup click, Open-full-page icon, call/text affordances ──

  it('clicking a non-interactive body area closes and navigates to the job page', () => {
    const { onClose } = renderEditor();
    fireEvent.click(screen.getByText('Scheduled')); // state-chip text - not a control
    expect(onClose).toHaveBeenCalled();
    // v2 delta: the destination is the v2 job page, not the bare legacy path.
    expect(navSpy).toHaveBeenCalledWith('/jobs/job-1');
  });

  it('clicking interactive elements does NOT close or navigate', async () => {
    const { onClose } = renderEditor();
    fireEvent.click(screen.getByLabelText('Start date'));                  // input
    fireEvent.click(await screen.findByLabelText('Remove Alice Ng'));      // crew chip button
    fireEvent.click(screen.getByLabelText('Call Alice Ng'));               // call affordance
    expect(onClose).not.toHaveBeenCalled();
    expect(navSpy).not.toHaveBeenCalled();
  });

  it('an "Open full page" header button closes and navigates to the job page', () => {
    const { onClose } = renderEditor();
    fireEvent.click(screen.getByRole('button', { name: 'Open full page' }));
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(navSpy).toHaveBeenCalledWith('/jobs/job-1');
  });

  it('"Open full page" on a walkthrough navigates to the lead walkthrough tab', () => {
    renderEditor({ event: walkthrough });
    fireEvent.click(screen.getByRole('button', { name: 'Open full page' }));
    // The ?tab= suffix is appended AFTER the v2 prefix is resolved: the matcher
    // compares path segments, so a query string on the last one would make it
    // unmatchable and silently drop the user out of v2.
    expect(navSpy).toHaveBeenCalledWith('/leads/lead-1?tab=walkthrough');
  });

  it('offers call/text next to the customer name from the payload phone', () => {
    renderEditor();
    fireEvent.click(screen.getByLabelText('Call Acme Corp'));
    expect(window.location.href).toBe('tel:555-0199');
    fireEvent.click(screen.getByLabelText('Text Acme Corp'));
    expect(window.location.href).toBe('sms:555-0199');
  });

  it('crew contact affordances: member with a roster phone gets call/text, phoneless member gets none (edit mode)', () => {
    renderEditor();
    fireEvent.click(screen.getByLabelText('Call Alice Ng'));
    expect(window.location.href).toBe('tel:555-0101');
    fireEvent.click(screen.getByLabelText('Text Alice Ng'));
    expect(window.location.href).toBe('sms:555-0101');
    expect(screen.queryByLabelText('Call Bob Ortiz')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Text Bob Ortiz')).not.toBeInTheDocument();
  });

  it('crew contact affordances render in readOnly mode too', () => {
    renderEditor({ readOnly: true });
    fireEvent.click(screen.getByLabelText('Call Alice Ng'));
    expect(window.location.href).toBe('tel:555-0101');
    fireEvent.click(screen.getByLabelText('Text Alice Ng'));
    expect(window.location.href).toBe('sms:555-0101');
    expect(screen.queryByLabelText('Call Bob Ortiz')).not.toBeInTheDocument();
  });

  it('the View details button still navigates', () => {
    const { onClose } = renderEditor();
    fireEvent.click(screen.getByRole('button', { name: /View details/ }));
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(navSpy).toHaveBeenCalledWith('/jobs/job-1');
  });

  it('renders nothing without an event', () => {
    const { container } = renderWithProviders(
      <EventEditor
        open
        event={null}
        members={MEMBERS}
        canUnschedule
        onSaveCrew={vi.fn()}
        onSaveTime={vi.fn()}
        onUnschedule={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    expect(container).toBeEmptyDOMElement();
  });
});
