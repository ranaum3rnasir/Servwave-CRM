/**
 * Multi-visit S7 / B9 (D23, user stories 40-42) - the board's confirm carries the opt-out.
 *
 * The routed board is the surface dispatchers actually schedule on, and until S7 it sent no
 * notify key on any of its writes: the confirm dialog was presentational, and its own docstring
 * still claimed it rendered "the list of people about to be emailed", which was false.
 *
 * These drive the ROUTED board through the same drag-and-confirm gesture boardReadsVisits uses,
 * so a composer that renders but never reaches the request cannot pass.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, fireEvent, waitFor, within } from '@testing-library/react';
import { addDays, format, startOfWeek } from 'date-fns';

import api from '@/lib/axios';
import { buildAbility } from '@/lib/ability';
import { renderWithProviders } from '@/__tests__/helpers';
import { TooltipProvider } from '@/ui-kit/components/ui/tooltip';
import { GRID_EVENT_ID, GRID_EVENT_TYPE, FROM_MEMBER } from '@/components/schedule/dragChannels';

import SchedulePage from '../SchedulePage';

const ADMIN = buildAbility([{ action: 'manage', subject: 'all' }]);
const mockApi = vi.mocked(api);

class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
global.ResizeObserver = ResizeObserverStub as unknown as typeof ResizeObserver;

const WEEK_START = startOfWeek(new Date(), { weekStartsOn: 0 });
function dayAt(offset: number, hour = 14, minute = 0): string {
  const d = addDays(WEEK_START, offset);
  return new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate(), hour, minute, 0)).toISOString();
}

const CREW = [{ user: { id: 'm-alice', first_name: 'Alice', last_name: 'Ng' } }];

const TWO_VISIT_JOB = {
  id: 'job-1',
  job_number: 'J00041',
  status: 'SCHEDULED',
  scope_notes: 'Rooftop Unit Swap',
  customer: { first_name: 'Ada', last_name: 'Byron', company_name: 'Acme', email: 'ada@acme.test' },
  assignees: CREW,
  tags: [],
  scheduled_start: dayAt(1),
  scheduled_end: dayAt(1, 16),
  visits: [
    { id: 'v1', visit_seq: 1, status: 'SCHEDULED', scheduled_at: dayAt(1), scheduled_end: dayAt(1, 16), is_all_day: false, assignees: [{ user_id: 'm-alice', user: { id: 'm-alice', first_name: 'Alice', last_name: 'Ng' } }] },
    { id: 'v2', visit_seq: 2, status: 'SCHEDULED', scheduled_at: dayAt(2), scheduled_end: dayAt(2, 16), is_all_day: false, assignees: [{ user_id: 'm-alice', user: { id: 'm-alice', first_name: 'Alice', last_name: 'Ng' } }] },
  ],
};

/** One trip only - the commonest shape on the board, and the one /unassign owns. */
const SINGLE_VISIT_JOB = {
  ...TWO_VISIT_JOB,
  id: 'job-2',
  job_number: 'J00042',
  visits: [
    { id: 'v9', visit_seq: 1, status: 'SCHEDULED', scheduled_at: dayAt(1), scheduled_end: dayAt(1, 16), is_all_day: false, assignees: [{ user_id: 'm-alice', user: { id: 'm-alice', first_name: 'Alice', last_name: 'Ng' } }] },
  ],
};

/** A job the board can still draw with no visit row at all - the /assign fallback. */
const NO_VISIT_JOB = { ...TWO_VISIT_JOB, id: 'job-3', job_number: 'J00043', visits: [] };

/** A lead whose walkthrough sits in Alice's lane, so it can be dragged like any other card. */
const WALKTHROUGH_LEAD = {
  id: 'lead-1',
  lead_number: 'L00007',
  customer: { first_name: 'Ada', last_name: 'Byron', company_name: 'Acme', email: 'ada@acme.test' },
  walkthrough_scheduled_at: dayAt(1, 10),
  walkthrough_duration_minutes: 60,
  walkthrough_performers: [{ user: { id: 'm-alice', first_name: 'Alice', last_name: 'Ng' } }],
  tags: [],
};

function mockBoard(jobs: Array<Record<string, unknown>>, leads: Array<Record<string, unknown>> = []) {
  mockApi.get.mockImplementation((url: string, config?: { params?: unknown }) => {
    if (url === '/api/jobs') {
      const status = (config?.params as { status?: unknown } | undefined)?.status;
      const wantsBucket = status === 'UNSCHEDULED'
        || (Array.isArray(status) && status.includes('UNSCHEDULED'));
      return Promise.resolve({ data: { jobs: wantsBucket ? [] : jobs } });
    }
    if (url === '/api/departments') return Promise.resolve({ data: { departments: [] } });
    if (url === '/api/leads') {
      const params = (config?.params ?? {}) as { walkthrough_after?: string };
      return Promise.resolve({ data: { leads: params.walkthrough_after ? leads : [] } });
    }
    if (url === '/api/users') {
      return Promise.resolve({
        data: { users: [{ id: 'm-alice', first_name: 'Alice', last_name: 'Ng', is_active: true, role: 'TECHNICIAN' }] },
      });
    }
    if (url === '/api/organization') return Promise.resolve({ data: {} });
    if (url === '/api/service-plans/scheduler-bucket') return Promise.resolve({ data: { plans: [] } });
    return Promise.resolve({ data: {} });
  });
}

const cellFor = (offset: number) => `week-cell-m-alice-${format(addDays(WEEK_START, offset), 'yyyy-MM-dd')}`;

/** Mount the member board over a given set of rows and wait for a card to be on it. */
async function mountBoard(
  jobs: Array<Record<string, unknown>>,
  leads: Array<Record<string, unknown>> = [],
  waitFor: RegExp = /J00041/,
) {
  mockBoard(jobs, leads);
  renderWithProviders(
    <TooltipProvider>
      <SchedulePage />
    </TooltipProvider>,
    { ability: ADMIN },
  );
  await screen.findAllByText(waitFor);
  fireEvent.click(screen.getByText('Member'));
}

/** Drag one card that is already on the board onto another day in the same lane. */
async function dropOnDay(boardId: string, toOffset: number, type: 'job' | 'walkthrough' = 'job') {
  const cell = await screen.findByTestId(cellFor(toOffset));
  fireEvent.drop(cell, {
    dataTransfer: {
      getData: (k: string) =>
        k === GRID_EVENT_ID ? boardId : k === FROM_MEMBER ? 'm-alice' : k === GRID_EVENT_TYPE ? type : '',
      types: [GRID_EVENT_ID, FROM_MEMBER],
    },
  });
}

/** The original two-visit gesture: mount, then drag visit 2 to another day. */
async function dragCard(boardId: string, toOffset: number) {
  await mountBoard([TWO_VISIT_JOB]);
  await dropOnDay(boardId, toOffset);
}

describe('the board confirm offers the opt-out and rides the visit PATCH (S7, B9)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockApi.patch.mockResolvedValue({ data: {} });
    mockApi.post.mockResolvedValue({ data: {} });
  });

  it('shows a TICKED opt-out naming the address (D23: defaulted on), and unticking sends an EXPLICIT decline', async () => {
    // Q1 (RATIFIED, both halves): the composer is always rendered for a drag-and-confirm
    // reschedule and defaults to sending (D23, user story 42). An untick is a decision made in
    // front of the dispatcher and must reach the wire as `notify_customer: false` - it used to
    // post NO notify key at all, which let the JOB_RESCHEDULED automation notify anyway.
    await dragCard('jv-v2', 5);

    const optOut = await screen.findByRole('checkbox', { name: /notify the customer/i });
    expect(optOut).toBeChecked();
    expect(screen.getByText('Email ada@acme.test')).toBeInTheDocument();

    fireEvent.click(optOut);
    fireEvent.click(await screen.findByRole('button', { name: /Confirm reschedule/i }));

    await waitFor(() => expect(mockApi.patch).toHaveBeenCalledTimes(1));
    expect(mockApi.patch.mock.calls[0]?.[1]).toEqual(
      expect.objectContaining({ notify: { notify_customer: false } }),
    );
  });

  it('opens with the send label and confirms with the NESTED notify object; unticking relabels', async () => {
    await dragCard('jv-v2', 5);

    // The button has to say what it is about to do - and the default IS a send.
    const send = await screen.findByRole('button', { name: /Reschedule & send/i });
    fireEvent.click(send);

    await waitFor(() => expect(mockApi.patch).toHaveBeenCalledTimes(1));
    const body = mockApi.patch.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(body).not.toHaveProperty('notify_customer');
    expect(body.notify).toMatchObject({ notify_customer: true, notify_recipient_email: 'ada@acme.test' });
  });

  it('seeds the message on the ORG clock - the same time the dialog itself renders', async () => {
    await dragCard('jv-v2', 5);

    const message = (await screen.findByLabelText('Message')) as HTMLTextAreaElement;
    // The target day, spelled out. A browser-zone seed on a UTC runner names a different day for
    // any evening slot - #1551's second defect.
    expect(message.value).toContain(format(addDays(WEEK_START, 5), 'MMMM d'));
    // And the same clock time the dialog's own "To" panel prints, rather than a second
    // conversion that could disagree with what the dispatcher is looking at.
    const dialog = screen.getByRole('dialog');
    const shownTime = within(dialog).getAllByText(/\d{1,2}:\d{2} (AM|PM)/)[1]?.textContent ?? '';
    const toTime = shownTime.split(/\s/)[0] + ' ' + shownTime.split(/\s/)[1];
    expect(message.value).toContain(toTime);
  });
});

describe('removing a card from the schedule can tell the customer too (S7, B9)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockApi.patch.mockResolvedValue({ data: {} });
    mockApi.post.mockResolvedValue({ data: {} });
  });

  async function openUnscheduleConfirm() {
    mockBoard([TWO_VISIT_JOB]);
    renderWithProviders(
      <TooltipProvider>
        <SchedulePage />
      </TooltipProvider>,
      { ability: ADMIN },
    );
    await screen.findAllByText(/J00041/);
    fireEvent.click(screen.getByText('Member'));
    // Open the trip's editor, then take its "Move to Unscheduled" action - the page owns the
    // confirm and the write, exactly as it does for the drag-to-sidebar gesture.
    const [card] = await screen.findAllByText(/Visit 2 of 2/);
    if (!card) throw new Error('no card for visit 2');
    fireEvent.click(card);
    fireEvent.click(await screen.findByRole('button', { name: /Move to Unscheduled/ }));
  }

  it('cancels THAT trip with a reason, and carries the notify object with the D23 default on', async () => {
    await openUnscheduleConfirm();

    await screen.findByRole('checkbox', { name: /notify the customer/i });
    fireEvent.click(screen.getByRole('button', { name: /^Unschedule$/i }));

    await waitFor(() => expect(mockApi.post).toHaveBeenCalled());
    const call = mockApi.post.mock.calls.find(([url]) => String(url).endsWith('/cancel'));
    if (!call) throw new Error('no per-visit cancel POST');
    expect(call[0]).toBe('/api/jobs/job-1/visits/v2/cancel');
    expect(call[1]).toMatchObject({
      cancelled_reason: 'Removed from schedule',
      notify: { notify_customer: true },
    });
  });
});

// Every gesture the composer is rendered over has to CARRY it. A dialog that offers the tick over
// a request with no notify key is the same lie the old "Notification emails will be sent to:"
// panel was, only worse: this one is ticked deliberately and reports success.
describe('the composer reaches the request on every gesture that offers it (S7, B9)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockApi.patch.mockResolvedValue({ data: {} });
    mockApi.post.mockResolvedValue({ data: {} });
  });

  async function unscheduleFrom(number: RegExp, cardText: RegExp, jobs: Array<Record<string, unknown>>) {
    await mountBoard(jobs, [], number);
    const [card] = await screen.findAllByText(cardText);
    if (!card) throw new Error('no card to unschedule');
    fireEvent.click(card);
    fireEvent.click(await screen.findByRole('button', { name: /Move to Unscheduled/ }));
  }

  it('unscheduling a SINGLE-visit job carries the default-on tick to /unassign', async () => {
    await unscheduleFrom(/J00042/, /J00042/, [SINGLE_VISIT_JOB]);

    await screen.findByRole('checkbox', { name: /notify the customer/i });
    fireEvent.click(screen.getByRole('button', { name: /^Unschedule$/i }));

    await waitFor(() => expect(mockApi.post).toHaveBeenCalled());
    const call = mockApi.post.mock.calls.find(([url]) => String(url).endsWith('/unassign'));
    if (!call) throw new Error('no /unassign POST');
    expect(call[0]).toBe('/api/jobs/job-2/unassign');
    expect(call[1]).toMatchObject({ notify: { notify_customer: true } });
  });

  it('unticking posts /unassign with an EXPLICIT decline, not silence', async () => {
    // Q1 (RATIFIED, both halves): the unschedule-confirm composer is rendered for every job
    // unschedule and defaults to sending, so an untick is a decision - it must reach the wire
    // as `notify_customer: false`, never as the silence a route with no composer sends.
    await unscheduleFrom(/J00042/, /J00042/, [SINGLE_VISIT_JOB]);

    fireEvent.click(await screen.findByRole('checkbox', { name: /notify the customer/i }));
    fireEvent.click(screen.getByRole('button', { name: /^Unschedule$/i }));

    await waitFor(() => expect(mockApi.post).toHaveBeenCalled());
    const call = mockApi.post.mock.calls.find(([url]) => String(url).endsWith('/unassign'));
    expect(call?.[1]).toEqual({ notify: { notify_customer: false } });
  });

  it('rescheduling a WALKTHROUGH carries the default-on tick to /walkthrough/schedule', async () => {
    await mountBoard([], [WALKTHROUGH_LEAD], /L00007/);
    await dropOnDay('wt-lead-1', 5, 'walkthrough');

    fireEvent.click(await screen.findByRole('button', { name: /Reschedule & send/i }));

    await waitFor(() => expect(mockApi.post).toHaveBeenCalled());
    const call = mockApi.post.mock.calls.find(([url]) => String(url).endsWith('/walkthrough/schedule'));
    if (!call) throw new Error('no walkthrough schedule POST');
    // FLAT keys on this door, not the visit routes' nested object - posting the wrong one is not
    // an error anyone sees: Zod strips it and the toast still says it worked.
    expect(call[1]).toMatchObject({ notify_customer: true, notify_recipient_email: 'ada@acme.test' });
  });

  it('rescheduling a job with NO visit row carries the default-on tick to /assign', async () => {
    await mountBoard([NO_VISIT_JOB], [], /J00043/);
    await dropOnDay('job-3', 5);

    fireEvent.click(await screen.findByRole('button', { name: /Reschedule & send/i }));

    await waitFor(() => expect(mockApi.post).toHaveBeenCalled());
    const call = mockApi.post.mock.calls.find(([url]) => String(url).endsWith('/assign'));
    if (!call) throw new Error('no /assign POST');
    expect(call[1]).toMatchObject({ notify_customer: true });
  });

  it('the 409 "Schedule Anyway" retry still sends the message that was composed', async () => {
    // D21 says a crew conflict warns and never blocks, so this is a routine path, not an edge:
    // the first attempt never reached the send, so a retry that drops the notify means the
    // customer is never told at all - under a success toast.
    mockApi.patch.mockRejectedValueOnce({
      response: { status: 409, data: { error: 'Schedule conflict detected', conflicts: [] } },
    });
    await dragCard('jv-v2', 5);

    fireEvent.click(await screen.findByRole('button', { name: /Reschedule & send/i }));

    fireEvent.click(await screen.findByRole('button', { name: /Schedule Anyway/i }));

    await waitFor(() => expect(mockApi.patch).toHaveBeenCalledTimes(2));
    const retry = mockApi.patch.mock.calls[1]?.[1] as Record<string, unknown>;
    expect(retry.force).toBe(true);
    expect(retry.notify).toMatchObject({ notify_customer: true, notify_recipient_email: 'ada@acme.test' });
  });
});

describe('a gesture that cannot send does not offer to (S7, B9)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockApi.patch.mockResolvedValue({ data: {} });
    mockApi.post.mockResolvedValue({ data: {} });
  });

  it('removing a WALKTHROUGH from the board shows no composer, because that route sends nothing', async () => {
    await mountBoard([], [WALKTHROUGH_LEAD], /L00007/);
    const [card] = await screen.findAllByText(/L00007/);
    if (!card) throw new Error('no walkthrough card');
    fireEvent.click(card);
    fireEvent.click(await screen.findByRole('button', { name: /Move to Unscheduled/ }));

    // The confirm is up...
    expect(await screen.findByText(/Move to Unscheduled\?/)).toBeInTheDocument();
    // ...and offers no tick, because POST /leads/:id/walkthrough/unschedule takes no notify and
    // no cancelled-walkthrough template exists. An offer here would be discarded in silence.
    expect(screen.queryByRole('checkbox', { name: /notify the customer/i })).not.toBeInTheDocument();
  });
});

// The send gate, through the screen rather than through notifyBlocked's return value: a malformed
// To must stop the write here, because the backend schemas tightened to `.string().email()` in
// this same slice - past this button the whole move is lost behind a generic 400.
describe('the composer will not send to an address that cannot receive (S7, B9)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockApi.patch.mockResolvedValue({ data: {} });
    mockApi.post.mockResolvedValue({ data: {} });
  });

  it('blocks the confirm and says why while the To is malformed, and unblocks when it is fixed', async () => {
    await dragCard('jv-v2', 5);

    const to = await screen.findByLabelText('To');
    fireEvent.change(to, { target: { value: 'ada@' } });

    expect(await screen.findByText('Enter a valid email address')).toBeInTheDocument();
    const send = screen.getByRole('button', { name: /Reschedule & send/i });
    expect(send).toBeDisabled();
    fireEvent.click(send);
    expect(mockApi.patch).not.toHaveBeenCalled();

    fireEvent.change(to, { target: { value: 'ada@acme.test' } });
    expect(screen.queryByText('Enter a valid email address')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /Reschedule & send/i }));
    await waitFor(() => expect(mockApi.patch).toHaveBeenCalledTimes(1));
  });

  it('an EMPTY To is not a malformed one - the server falls back to the saved address', async () => {
    await dragCard('jv-v2', 5);

    fireEvent.change(await screen.findByLabelText('To'), { target: { value: '' } });

    fireEvent.click(screen.getByRole('button', { name: /Reschedule & send/i }));
    await waitFor(() => expect(mockApi.patch).toHaveBeenCalledTimes(1));
    const body = mockApi.patch.mock.calls[0]?.[1] as { notify?: Record<string, unknown> };
    expect(body.notify).toMatchObject({ notify_customer: true });
    expect(body.notify).not.toHaveProperty('notify_recipient_email');
  });

  it('a CC the dispatcher adds rides the request as an array', async () => {
    await dragCard('jv-v2', 5);

    const cc = await screen.findByLabelText(/^CC/);
    fireEvent.change(cc, { target: { value: 'ops@acme.test' } });
    fireEvent.keyDown(cc, { key: 'Enter' });

    fireEvent.click(screen.getByRole('button', { name: /Reschedule & send/i }));
    await waitFor(() => expect(mockApi.patch).toHaveBeenCalledTimes(1));
    const body = mockApi.patch.mock.calls[0]?.[1] as { notify?: Record<string, unknown> };
    expect(body.notify).toMatchObject({ notify_cc_emails: ['ops@acme.test'] });
  });
});
