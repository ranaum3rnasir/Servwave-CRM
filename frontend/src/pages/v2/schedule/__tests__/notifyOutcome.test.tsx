/**
 * The board's RECEIPT for a send it offered (SRVW-243, S7 follow-up).
 *
 * S7 gave the routed board the composer and made every gesture carry it to the request. What it
 * did not carry back is the ANSWER: each of those routes returns a top-level
 * `notify: { status, reason? }` describing what happened to the email, and every `onSuccess` on
 * this page took its response as `_`.
 *
 * That matters because the schedule write and the email succeed independently. The server 200s
 * either way on purpose - a trip that genuinely moved must not be rolled back by a mail provider
 * - so a dropped `notify` means the dispatcher ticked "email the customer", watched the card
 * move, and was told nothing at all when the address was missing, blocked, or the send failed.
 *
 * The job page's Visits card is NOT this receipt. It stamps `customer_email_sent_at` only when
 * the status is 'sent', so a failure leaves the column null - byte-identical to never having
 * asked - and a walkthrough has no visit row to stamp in the first place.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, fireEvent, waitFor } from '@testing-library/react';
import { addDays, format, startOfWeek } from 'date-fns';

import api from '@/lib/axios';
import { toast } from '@/ui-kit/components/ui/sonner';
import { buildAbility } from '@/lib/ability';
import { renderWithProviders } from '@/__tests__/helpers';
import { TooltipProvider } from '@/ui-kit/components/ui/tooltip';
import { GRID_EVENT_ID, GRID_EVENT_TYPE, FROM_MEMBER } from '@/components/schedule/dragChannels';

import SchedulePage from '../SchedulePage';

// The page announces a successful send through sonner, which mounts no Toaster in this harness.
vi.mock('@/ui-kit/components/ui/sonner', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  toast: vi.fn(),
}));

const ADMIN = buildAbility([{ action: 'manage', subject: 'all' }]);
const mockApi = vi.mocked(api);
const mockToast = vi.mocked(toast);

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
const VISIT_CREW = [{ user_id: 'm-alice', user: { id: 'm-alice', first_name: 'Alice', last_name: 'Ng' } }];

/** One trip - the commonest shape on the board, and the branch /unassign owns. */
const JOB = {
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
    {
      id: 'v1', visit_seq: 1, status: 'SCHEDULED', scheduled_at: dayAt(1),
      scheduled_end: dayAt(1, 16), is_all_day: false, assignees: VISIT_CREW,
    },
  ],
};

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

async function mountBoard(
  jobs: Array<Record<string, unknown>>,
  leads: Array<Record<string, unknown>> = [],
  waitForText: RegExp = /J00041/,
) {
  mockBoard(jobs, leads);
  renderWithProviders(
    <TooltipProvider>
      <SchedulePage />
    </TooltipProvider>,
    { ability: ADMIN },
  );
  await screen.findAllByText(waitForText);
  fireEvent.click(screen.getByText('Member'));
}

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

/** Drag the single trip to another day; the composer opens TICKED (D23: defaulted on). */
async function dragAndTick() {
  await mountBoard([JOB]);
  await dropOnDay('jv-v1', 5);
  await screen.findByRole('checkbox', { name: /notify the customer/i });
}

/** What the server said about the email, in the shape every notify-carrying route returns. */
const NOTIFY = {
  sent: { status: 'sent', providerMessageId: 'msg_1', fromAddress: 'ops@acme.test', fromName: 'Acme' },
  noRecipient: { status: 'skipped', reason: 'no_recipient' },
  suppressed: { status: 'skipped', reason: 'suppressed' },
  failed: { status: 'failed', error: 'provider rejected the message' },
} as const;

const toastText = () => mockToast.mock.calls.map((c) => String(c[0])).join(' | ');

describe('the board reports what happened to the email it offered to send', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockApi.patch.mockResolvedValue({ data: {} });
    mockApi.post.mockResolvedValue({ data: {} });
  });

  it('confirms the send when the server says it went', async () => {
    mockApi.patch.mockResolvedValue({ data: { notify: NOTIFY.sent } });
    await dragAndTick();

    fireEvent.click(await screen.findByRole('button', { name: /Reschedule & send/i }));

    await waitFor(() => expect(mockApi.patch).toHaveBeenCalledTimes(1));
    // A send with no receipt reads as a send that did not happen - the exact gap the first cut
    // of SRVW-243 shipped, and the reason v1 grew this reporter at all.
    await waitFor(() => expect(toastText()).toMatch(/customer notified/i));
  });

  it('says so plainly when the customer has no address on file', async () => {
    mockApi.patch.mockResolvedValue({ data: { notify: NOTIFY.noRecipient } });
    await dragAndTick();

    fireEvent.click(await screen.findByRole('button', { name: /Reschedule & send/i }));

    // The move DID happen. Only the email did not, and the sentence has to carry both halves or
    // the dispatcher cannot tell whether to re-drag the card or pick up the phone.
    expect(await screen.findByText(/rescheduled, but the customer has no email address on file/i))
      .toBeInTheDocument();
    expect(toastText()).not.toMatch(/customer notified/i);
  });

  it('distinguishes a blocked address from a send that simply failed', async () => {
    mockApi.patch.mockResolvedValue({ data: { notify: NOTIFY.suppressed } });
    await dragAndTick();

    fireEvent.click(await screen.findByRole('button', { name: /Reschedule & send/i }));

    // 'suppressed' is a deliberate policy block after an earlier bounce or spam report, not a
    // provider error - retrying will never work, so "could not be sent" is the wrong advice.
    expect(await screen.findByText(/earlier bounce or spam report/i)).toBeInTheDocument();
  });

  it('reports a provider failure rather than an unqualified success', async () => {
    mockApi.patch.mockResolvedValue({ data: { notify: NOTIFY.failed } });
    await dragAndTick();

    fireEvent.click(await screen.findByRole('button', { name: /Reschedule & send/i }));

    expect(await screen.findByText(/rescheduled, but the customer email could not be sent/i))
      .toBeInTheDocument();
  });

  it('says nothing about email when the dispatcher unticks the composer', async () => {
    await mountBoard([JOB]);
    await dropOnDay('jv-v1', 5);

    fireEvent.click(await screen.findByRole('checkbox', { name: /notify the customer/i }));
    fireEvent.click(await screen.findByRole('button', { name: /Confirm reschedule/i }));

    await waitFor(() => expect(mockApi.patch).toHaveBeenCalledTimes(1));
    // An absent `notify` means the user never asked for a send. Reporting one here would be the
    // same false claim the old amber panel made, arriving one step later.
    expect(toastText()).not.toMatch(/customer notified/i);
    expect(screen.queryByText(/customer email could not be sent/i)).not.toBeInTheDocument();
  });

  it('reports the outcome on the walkthrough door too', async () => {
    mockApi.post.mockImplementation((url: string) =>
      Promise.resolve(
        String(url).endsWith('/walkthrough/schedule')
          ? { data: { notify: NOTIFY.noRecipient } }
          : { data: {} },
      ),
    );
    await mountBoard([], [WALKTHROUGH_LEAD], /L00007/);
    await dropOnDay('wt-lead-1', 5, 'walkthrough');

    fireEvent.click(await screen.findByRole('button', { name: /Reschedule & send/i }));

    // This door's mutationFn discarded its response entirely, so the answer could not have been
    // read even if someone had asked for it.
    expect(await screen.findByText(/rescheduled, but the customer has no email address on file/i))
      .toBeInTheDocument();
  });

  it('reports the outcome when the tick rode an unschedule', async () => {
    mockApi.post.mockImplementation((url: string) =>
      Promise.resolve(
        String(url).endsWith('/unassign') ? { data: { notify: NOTIFY.failed } } : { data: {} },
      ),
    );
    await mountBoard([JOB]);
    const [card] = await screen.findAllByText(/J00041/);
    if (!card) throw new Error('no card to unschedule');
    fireEvent.click(card);
    fireEvent.click(await screen.findByRole('button', { name: /Move to Unscheduled/ }));

    fireEvent.click(screen.getByRole('button', { name: /^Unschedule$/i }));

    expect(await screen.findByText(/Unscheduled, but the customer email could not be sent/i))
      .toBeInTheDocument();
  });
});
