import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, fireEvent, waitFor } from '@testing-library/react';

import api from '@/lib/axios';
import { buildAbility } from '@/lib/ability';
import { renderWithProviders } from '@/__tests__/helpers';

import CustomerDetailPage from '../CustomerDetailPage';

/**
 * Slice 10 — the combined Schedule tab on the v2 customer detail page.
 *
 * `frontend/src/pages/v2/customers/CustomerDetailPage.tsx` is the LIVE page: it is the component
 * `pages/v2/routes/customers.routes.tsx` mounts at `/customers/:id` (verified by reading that
 * route file - `customers.routes.tsx` imports `../customers/CustomerDetailPage`, which resolves
 * to this file, not `src/pages/CustomerDetailPage.tsx`). Editing the wrong copy is slice 01's
 * documented trap (a change that lands in a dead v1 fork nothing routes to).
 */

class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
global.ResizeObserver = ResizeObserverStub as unknown as typeof ResizeObserver;

const CUSTOMER_ID = 'c0000000-0000-0000-0000-000000000001';

vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual('react-router-dom');
  return { ...actual, useParams: () => ({ id: CUSTOMER_ID }) };
});

const mockApi = vi.mocked(api);

const CUSTOMER_DETAIL_FIXTURE = {
  customer: {
    id: CUSTOMER_ID,
    customer_number: 'C00001',
    first_name: 'John',
    last_name: 'Doe',
    company_name: null,
    email: 'john@doe.com',
    phone: '5551234567',
    phone_ext: null,
    secondary_phone: null,
    ad_source: null,
    allow_billing: false,
    tax_exempt: false,
    payment_type: null,
    extra_emails: [],
    custom_fields: {},
    created_at: '2026-01-01T00:00:00.000Z',
    archived_at: null,
    is_active: true,
    tags: [],
    service_locations: [],
    _count: { leads: 1, jobs: 1 },
    jobs: [
      {
        id: 'job-1',
        job_number: 'J00041',
        status: 'SCHEDULED',
        scope_notes: 'Replace condenser',
        scheduled_start: '2026-09-10T14:00:00.000Z',
        completed_at: null,
        created_at: '2026-09-01T00:00:00.000Z',
        assignees: [],
        service_location: null,
        estimate: null,
        invoices: [],
      },
    ],
    activity_notes: [],
    orphan_invoices: [],
    invoices: [],
  },
  summary: {
    financials: {
      lifetime_revenue: 0, total_invoiced: 0, past_due_balance: 0, due_balance: 0,
      paid_invoice_count: 0, unpaid_invoice_count: 0,
    },
    estimates: { total: 0, pending: 0, approved: 0, total_value: 0 },
    deposits: { collected: 0, pending: 0 },
    leads: { open: 1, active: 0 },
    tasks: { open: 0 },
  },
};

const LEADS_WITH_WALKTHROUGH_FIXTURE = {
  leads: [
    {
      id: 'lead-1',
      lead_number: 'L00012',
      status: 'NEW',
      service_request: 'AC not cooling',
      created_at: '2026-09-01T00:00:00.000Z',
      walkthrough_scheduled_at: '2026-09-05T09:00:00.000Z',
      estimates: [],
    },
  ],
};

const CALENDAR_ENTRIES_FIXTURE = {
  calendar_entries: [
    {
      id: 'entry-1',
      title: "Dave's follow-up call",
      description: '',
      start: '2026-09-12T16:00:00.000Z',
      end: '2026-09-12T16:30:00.000Z',
      is_all_day: false,
      participants: [],
    },
  ],
};

function mockGetFor({ withCalendarEntries }: { withCalendarEntries: boolean }) {
  mockApi.get.mockImplementation(async (url: string) => {
    if (url.startsWith('/api/customers/')) return { data: CUSTOMER_DETAIL_FIXTURE };
    if (url === '/api/leads') return { data: LEADS_WITH_WALKTHROUGH_FIXTURE };
    if (url === '/api/calendar-entries') {
      if (!withCalendarEntries) throw new Error('should never be requested without the grant');
      return { data: CALENDAR_ENTRIES_FIXTURE };
    }
    // Every other GET this heavy page fires on mount (tags, estimates, ...) - one
    // generic empty shape is enough, the same reasoning jobsV2Smoke.test.tsx documents.
    return { data: {} };
  });
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('CustomerDetailPage — Schedule tab (slice 10)', () => {
  it('places Schedule right after Jobs in the tab strip', async () => {
    mockGetFor({ withCalendarEntries: true });
    const ability = buildAbility([{ action: 'read', subject: 'CalendarEntry' }]);

    renderWithProviders(<CustomerDetailPage />, { ability, initialEntries: [`/customers/${CUSTOMER_ID}`] });

    const tabs = (await screen.findAllByRole('tab')).map((t) => t.textContent?.trim());
    const jobsIdx = tabs.indexOf('Jobs');
    const scheduleIdx = tabs.indexOf('Schedule');
    expect(jobsIdx).toBeGreaterThanOrEqual(0);
    expect(scheduleIdx).toBe(jobsIdx + 1);
    // Comms still renders last (unchanged by this slice).
    expect(tabs[tabs.length - 1]).not.toBe('Schedule');
  });

  it('with `read CalendarEntry`: renders the job, the walkthrough and the Event in one chronological list', async () => {
    mockGetFor({ withCalendarEntries: true });
    const ability = buildAbility([{ action: 'read', subject: 'CalendarEntry' }]);

    renderWithProviders(<CustomerDetailPage />, { ability, initialEntries: [`/customers/${CUSTOMER_ID}`] });

    fireEvent.click(await screen.findByRole('tab', { name: 'Schedule' }));

    // Three independent queries (jobs come off the already-loaded customer record; leads and
    // calendar-entries are separate fetches) resolve on their own schedules - wait for all
    // three rows together rather than assuming the first one to settle implies the others did.
    await waitFor(() => {
      expect(screen.getByText('AC not cooling')).toBeInTheDocument(); // walkthrough row
      expect(screen.getByText('J00041')).toBeInTheDocument(); // job row
      expect(screen.getByText("Dave's follow-up call")).toBeInTheDocument(); // Event row
    });

    // Chronological order: walkthrough (Sep 5) -> job (Sep 10) -> Event (Sep 12).
    const rows = screen.getAllByRole('row').slice(1);
    expect(rows[0]).toHaveTextContent('AC not cooling');
    expect(rows[1]).toHaveTextContent('J00041');
    expect(rows[2]).toHaveTextContent("Dave's follow-up call");

    // The customer_id filter (this slice's backend addition) actually reached the request.
    const calledUrls = mockApi.get.mock.calls.map((c) => c[0]);
    const entriesCall = mockApi.get.mock.calls.find((c) => c[0] === '/api/calendar-entries');
    expect(entriesCall?.[1]).toMatchObject({ params: { customer_id: CUSTOMER_ID } });
    expect(calledUrls).toContain('/api/calendar-entries');
  });

  it('without `read CalendarEntry`: jobs and walkthroughs still render, no Events row, and /api/calendar-entries is never requested', async () => {
    mockGetFor({ withCalendarEntries: false });
    // No ability at all -> emptyAbility -> can('read','CalendarEntry') is false.

    renderWithProviders(<CustomerDetailPage />, { initialEntries: [`/customers/${CUSTOMER_ID}`] });

    fireEvent.click(await screen.findByRole('tab', { name: 'Schedule' }));

    await waitFor(() => {
      expect(screen.getByText('AC not cooling')).toBeInTheDocument();
      expect(screen.getByText('J00041')).toBeInTheDocument();
    });
    expect(screen.queryByText("Dave's follow-up call")).toBeNull();

    const calledUrls = mockApi.get.mock.calls.map((c) => c[0]);
    expect(calledUrls).not.toContain('/api/calendar-entries');
  });

  it('hides the Schedule tab entirely when the page already hides lead-dependent tabs (no `leads` feature)', async () => {
    mockGetFor({ withCalendarEntries: true });
    const ability = buildAbility([{ action: 'read', subject: 'CalendarEntry' }]);

    // useFeature('leads') reads org_features off the auth store; the globally-mocked default
    // user carries no org_features key, which useFeature treats as "unknown" and fails OPEN
    // (true). An org_features array that omits 'leads' is what actually turns it off.
    const { useAuthStore } = await import('@/stores/auth.store');
    // Matches the store's own permissive selector signature, as job-plan-gating.test.tsx does.
    // The directive has to be the LAST comment line: eslint-disable-next-line applies to the
    // line immediately after it, so splitting the reason across two lines aims it at the comment.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    vi.mocked(useAuthStore).mockImplementation((selector: (s: any) => unknown) =>
      selector({
        user: {
          id: '00000000-0000-0000-0000-000000000001', email: 'admin@test.com',
          first_name: 'Test', last_name: 'Admin', role: 'ADMIN',
          org_features: ['customers', 'jobs', 'estimates', 'invoices', 'payments', 'scheduling'],
        },
        isAuthenticated: true, isLoading: false, error: null,
      }),
    );

    renderWithProviders(<CustomerDetailPage />, { ability, initialEntries: [`/customers/${CUSTOMER_ID}`] });

    await screen.findByRole('tab', { name: 'Jobs' });
    expect(screen.queryByRole('tab', { name: 'Schedule' })).toBeNull();
    expect(screen.queryByRole('tab', { name: 'Leads' })).toBeNull();
  });
});
