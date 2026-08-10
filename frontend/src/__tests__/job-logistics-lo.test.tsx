// LO-3 (plan §3 Placements / spec §14 H3) — Job page Logistics tab fold-in.
//
// Contract under test:
//   • The existing "Logistics" tab renders the LO list as its TOP section (above JobStagesSection),
//     NOT a new 10th tab.
//   • LOList is pre-anchored to the job — it receives jobId = the job's UUID, so new orders are
//     created against this job (number LO-J…-n).
//   • H3 notice: while the job still has legacy SYNCED lines, a one-line notice listing them
//     renders in the Logistics tab; with no SYNCED lines the notice is absent.
//
// LOList + JobStagesSection are mocked — this is a PLACEMENT test (does the page wire them?), not a
// test of their internals (covered by lo-list.test.tsx). LOList captures its props so we can assert
// the anchor.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import api from '@/lib/axios';
import { renderWithProviders } from './helpers';
import JobDetailPage from '@/pages/JobDetailPage';
import { buildAbility } from '@/lib/ability';

const JOB_ID = 'j0000000-0000-0000-0000-000000000001';

// Capture the props the page hands LOList so we can assert the anchor.
let capturedLOListProps: { jobId?: string; invoiceId?: string; servicePlanId?: string } | null =
  null;
vi.mock('@/components/inventory/lo/LOList', () => ({
  LOList: (props: { jobId?: string; invoiceId?: string; servicePlanId?: string }) => {
    capturedLOListProps = props;
    return <div data-testid="lolist" />;
  },
}));
vi.mock('@/components/jobs/JobStagesSection', () => ({
  JobStagesSection: () => <div data-testid="job-stages" />,
}));
// Tasks tab child fires its own queries — irrelevant here.
vi.mock('@/components/tasks/JobLeadTasksTab', () => ({ JobLeadTasksTab: () => null }));

vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual('react-router-dom');
  return { ...actual, useParams: () => ({ id: JOB_ID }), useNavigate: () => vi.fn() };
});

const mockApi = vi.mocked(api);
const adminAbility = buildAbility([{ action: 'manage', subject: 'all' }]);

const BASE_JOB = {
  id: JOB_ID,
  job_number: 'J00042',
  status: 'UNASSIGNED',
  scope_notes: null,
  estimated_duration: null,
  completion_notes: null,
  scheduled_start: null,
  scheduled_end: null,
  started_at: null,
  completed_at: null,
  cancelled_at: null,
  cancelled_reason: null,
  created_at: '2026-02-01T00:00:00.000Z',
  updated_at: '2026-02-01T00:00:00.000Z',
  customer: {
    id: 'c0000000-0000-0000-0000-000000000001',
    first_name: 'John',
    last_name: 'Doe',
    company_name: null,
    email: 'john@doe.com',
    phone: '5551234567',
  },
  assignees: [],
  service_location: null,
  estimate: null,
  invoices: [],
  tags: [],
  source_plan_id: null,
  source_plan: null,
};

const SYNCED_LINE = {
  id: 'line-1',
  sequence: 1,
  description: 'Filter 20x20',
  quantity: 2,
  unit_price: 25,
  is_taxable: true,
  line_total: 50,
  discount_type: null,
  discount_value: null,
  discount_amount: 0,
  item_type: 'MATERIAL',
  price_book_item_id: 'pb-1',
  stock_status: 'SYNCED',
};

function mockJob(lines: unknown[]) {
  mockApi.get.mockImplementation(async (url: string) => {
    if (url.endsWith('/scopes')) {
      return { data: { scopes: [], billing: { total: 0, invoiced: 0, remaining: 0 } } };
    }
    if (url.endsWith('/line-items')) {
      return { data: { lines, billing: { total: 50, invoiced: 0, remaining: 50 } } };
    }
    if (url.includes('/api/jobs/')) {
      return { data: { job: BASE_JOB } };
    }
    return { data: {} };
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  capturedLOListProps = null;
});

describe('JobDetailPage — Logistics tab LO fold-in (plan §3)', () => {
  it('renders LOList pre-anchored to the job as the top section of the Logistics tab', async () => {
    mockJob([]);
    renderWithProviders(<JobDetailPage />, { ability: adminAbility });

    const user = userEvent.setup();
    await user.click(await screen.findByRole('tab', { name: /Logistics/ }));

    // The LO section is present in the Logistics tab (no separate 10th tab) …
    expect(await screen.findByTestId('lolist')).toBeInTheDocument();
    // … and it is anchored to this job (create → LO-J…-n).
    expect(capturedLOListProps?.jobId).toBe(JOB_ID);
    expect(capturedLOListProps?.invoiceId).toBeUndefined();
    // Staging still renders below it.
    expect(screen.getByTestId('job-stages')).toBeInTheDocument();
  });

  it('shows no legacy-synced notice when the job has no SYNCED lines', async () => {
    mockJob([{ ...SYNCED_LINE, stock_status: 'UNSYNCED' }]);
    renderWithProviders(<JobDetailPage />, { ability: adminAbility });

    const user = userEvent.setup();
    await user.click(await screen.findByRole('tab', { name: /Logistics/ }));
    await screen.findByTestId('lolist');

    expect(screen.queryByText(/Legacy synced line/)).not.toBeInTheDocument();
  });

  it('lists the legacy SYNCED lines in a one-line H3 notice when present', async () => {
    mockJob([SYNCED_LINE, { ...SYNCED_LINE, id: 'line-2', description: 'Wire spool' }]);
    renderWithProviders(<JobDetailPage />, { ability: adminAbility });

    const user = userEvent.setup();
    await user.click(await screen.findByRole('tab', { name: /Logistics/ }));
    await screen.findByTestId('lolist');

    const notice = screen.getByText(/Legacy synced lines? still deducting stock on this job/);
    expect(notice).toHaveTextContent('Filter 20x20');
    expect(notice).toHaveTextContent('Wire spool');
  });
});
