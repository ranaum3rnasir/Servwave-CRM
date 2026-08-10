import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor, fireEvent, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import api from '@/lib/axios';
import { renderWithProviders } from './helpers';
import JobDetailPage from '@/pages/JobDetailPage';
import { buildAbility } from '@/lib/ability';

// Capture the entity prop passed to JobLeadTasksTab to assert UUID correctness
let capturedJobEntity: { type: string; id: string; label: string } | null = null;
vi.mock('@/components/tasks/JobLeadTasksTab', () => ({
  JobLeadTasksTab: (props: { entity: { type: string; id: string; label: string } }) => {
    capturedJobEntity = props.entity;
    return null;
  },
}));

// floating-ui (under Radix dropdown) does `new ResizeObserver(...)`; the global
// setup mock returns a plain object and isn't constructable, so install a real
// class stub (same pattern as lead-detail-page.test.tsx).
class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
global.ResizeObserver = ResizeObserverStub as unknown as typeof ResizeObserver;

const mockNavigate = vi.fn();
vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual('react-router-dom');
  return {
    ...actual,
    useParams: () => ({ id: 'j0000000-0000-0000-0000-000000000001' }),
    useNavigate: () => mockNavigate,
  };
});

// Inventory P1 — the complete-job stock nudge fires through the module-level toast fn;
// spy it so the nudge is assertable without mounting a Toaster.
const toastHoisted = vi.hoisted(() => ({ toast: vi.fn() }));
vi.mock('@/components/ui/use-toast', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/components/ui/use-toast')>();
  return { ...actual, toast: toastHoisted.toast };
});

const adminAbility = buildAbility([{ action: 'manage', subject: 'all' }]);

const mockApi = vi.mocked(api);

const BASE_JOB = {
  id: 'j0000000-0000-0000-0000-000000000001',
  job_number: 'J00001',
  status: 'UNASSIGNED',
  scope_notes: null,
  estimated_duration: null,
  completion_notes: null,
  scheduled_start: null as string | null,
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
  assignees: [] as { user: { id: string; first_name: string; last_name: string } }[],
  service_location: null,
  estimate: null,
  invoices: [] as Array<{ id: string; invoice_number: string; status: string; total_amount: number | string; amount_due: number | string; created_at: string }>,
  linked_estimates: [] as Array<{ id: string; estimate_number: string; total_amount: number | string; status: string }>,
  tags: [] as Array<{ id: string; name: string; color: string }>,
  source_plan_id: null,
  source_plan: null,
};

function mockJob(overrides: Partial<typeof BASE_JOB> = {}) {
  const job = { ...BASE_JOB, ...overrides };
  mockApi.get.mockImplementation(async (url: string) => {
    if (url.includes('/api/jobs/')) {
      return { data: { job } };
    }
    return { data: {} };
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  capturedJobEntity = null;
});

// Phase 11.6 - JobDetailPage moves from DetailPageShell to TabStrip.
// Pins the real page's rendered tab-strip markup byte-exact: the outer card
// (replacing `tabsSurface="card"` + the redundant rail-wrapper rounding) and
// the content tint wrapper (replacing `contentWrapperClassName`, now a plain
// div the page wraps around its own `<TabsContent>` children rather than a
// className handed straight to `TabsContent` itself - see this page's own
// comment above its `TabStrip` call for why that distinction is load-bearing
// for `layering-guard.test.ts`).
describe('JobDetailPage tab strip - TabStrip rendered contract', () => {
  const cls = (el: Element | null) => el?.getAttribute('class') ?? '';

  it('renders the outer card, TabsList, underline triggers and the content-tint wrapper', async () => {
    mockJob({ status: 'UNASSIGNED' });
    renderWithProviders(<JobDetailPage />, { ability: adminAbility });

    const list = await screen.findByRole('tablist');
    expect(cls(list)).toBe('flex items-center gap-[26px] border-b border-border');

    // TabStrip's own Tabs root is a direct child of the outer card div, carrying no className.
    const tabsRoot = list.parentElement as HTMLElement;
    expect(cls(tabsRoot)).toBe('');
    const cardWrapper = tabsRoot.parentElement as HTMLElement;
    expect(cls(cardWrapper)).toBe('rounded-card border border-border bg-surface-light shadow-card');

    const overviewTab = screen.getByRole('tab', { name: 'Overview' });
    expect(cls(overviewTab)).toBe(
      'inline-flex items-center justify-center whitespace-nowrap transition-colors ' +
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary ' +
        'focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-50 relative ' +
        'border-b-[3px] border-transparent text-sm font-medium text-text-secondary ' +
        'hover:text-text-primary data-[state=active]:border-primary data-[state=active]:text-primary ' +
        'data-[state=active]:font-semibold px-5 py-3'
    );

    // The content-tint wrapper is the Tabs root's other direct child (TabsList's sibling),
    // and the visible panel is nested inside it.
    const overviewPanel = await screen.findByText('Details');
    const contentWrapper = overviewPanel.closest('.rounded-b-card') as HTMLElement;
    expect(contentWrapper).not.toBeNull();
    expect(cls(contentWrapper)).toBe('rounded-b-card bg-primary-subtle/50');
    expect(contentWrapper.parentElement).toBe(tabsRoot);
  });
});

describe('JobDetailPage — schedule action (bug #44, #583 consolidated menu)', () => {
  it('surfaces "Schedule Job" as an Actions menu item for an UNASSIGNED job', async () => {
    mockJob({ status: 'UNASSIGNED', scheduled_start: null });

    // Task 8 (Spec A): getAvailableActions is ability-driven now, not role-string-driven —
    // an explicit ability is required or every action-gated control disappears.
    renderWithProviders(<JobDetailPage />, { ability: adminAbility });

    await userEvent.click(await screen.findByRole('button', { name: /actions/i }));
    expect(await screen.findByRole('menuitem', { name: /Schedule Job/ })).toBeInTheDocument();
  });

  it('surfaces "Reschedule" as an Actions menu item for a SCHEDULED job', async () => {
    mockJob({
      status: 'SCHEDULED',
      scheduled_start: '2026-02-10T09:00:00.000Z',
      scheduled_end: '2026-02-10T11:00:00.000Z',
      assignees: [
        { user: { id: '00000000-0000-0000-0000-000000000003', first_name: 'Tina', last_name: 'Tech' } },
      ],
    });

    renderWithProviders(<JobDetailPage />, { ability: adminAbility });

    await userEvent.click(await screen.findByRole('button', { name: /actions/i }));
    expect(await screen.findByRole('menuitem', { name: /Reschedule/ })).toBeInTheDocument();
  });

  // Reschedule opens on a job that ALREADY has a schedule; the fields must show it so
  // the user edits the current slot rather than retyping it blind from memory.
  it('pre-fills Scheduled Start/End with the job\'s current schedule when rescheduling', async () => {
    const start = '2026-02-10T09:00:00.000Z';
    const end = '2026-02-10T11:00:00.000Z';
    mockJob({
      status: 'SCHEDULED',
      scheduled_start: start,
      scheduled_end: end,
      assignees: [
        { user: { id: '00000000-0000-0000-0000-000000000003', first_name: 'Tina', last_name: 'Tech' } },
      ],
    });

    renderWithProviders(<JobDetailPage />, { ability: adminAbility });

    await userEvent.click(await screen.findByRole('button', { name: /actions/i }));
    await userEvent.click(await screen.findByRole('menuitem', { name: /Reschedule/ }));

    // Rendered on the ORG's clock, NOT the runner's. This assertion used to derive its
    // expectation with date-fns `format`, which reads the local zone - so it agreed with the
    // component only when the runner happened to sit in the org's zone, and failed under
    // TZ=Asia/Manila. The org here is unmocked, so the dialog falls back to
    // DEFAULT_SCHEDULE_TIMEZONE (America/New_York), where 09:00Z in February (EST) is 4:00 AM.
    // Hard-coded rather than computed: a literal cannot drift back into the viewer's zone.
    const dateFields = await screen.findAllByPlaceholderText('MM/DD/YYYY');
    expect(dateFields.map((f) => (f as HTMLInputElement).value)).toEqual(['02/10/2026', '02/10/2026']);
    const timeFields = screen.getAllByPlaceholderText('Time');
    expect(timeFields.map((f) => (f as HTMLInputElement).value)).toEqual(['4:00 AM', '6:00 AM']);
  });

  it('opens the assign/reschedule dialog when the Schedule KPI card is clicked (#583 AC4)', async () => {
    mockJob({ status: 'UNASSIGNED', scheduled_start: null });

    renderWithProviders(<JobDetailPage />, { ability: adminAbility });

    await userEvent.click(await screen.findByRole('button', { name: /reschedule job/i }));
    // The KPI card triggers 'schedule' mode, not 'assign' - the dialog's copy matches
    // what the user actually clicked, not a hardcoded default.
    expect(await screen.findByText(/^Schedule Job$/)).toBeInTheDocument();
  });
});

describe('JobDetailPage — Create Invoice paths (SERV10X-38 Task 6c: always the draw/itemized dialog)', () => {
  it('estimate-less job: clicking "Create Invoice" opens CreateJobInvoiceDialog and does NOT POST', async () => {
    mockJob({ estimate: null });

    renderWithProviders(<JobDetailPage />, { ability: adminAbility });

    const btn = await screen.findByRole('button', { name: /Create Invoice/ });
    fireEvent.click(btn);

    await waitFor(() => {
      expect(screen.getByTestId('create-job-invoice-dialog')).toBeVisible();
    });
    expect(mockApi.post).not.toHaveBeenCalledWith('/api/invoices', expect.anything());
  });

  it('estimate-backed job: clicking "Create Invoice" ALSO opens CreateJobInvoiceDialog, not the old one-click POST', async () => {
    mockJob({
      estimate: {
        id: 'e0000000-0000-0000-0000-000000000001',
        estimate_number: 'E00001',
        total_amount: 1000,
        status: 'WON',
        lead_id: null,
        lead: null,
        deposit: null,
        line_items: [],
      } as unknown as typeof BASE_JOB['estimate'],
    });

    renderWithProviders(<JobDetailPage />, { ability: adminAbility });

    const btn = await screen.findByRole('button', { name: /Create Invoice/ });
    fireEvent.click(btn);

    await waitFor(() => {
      expect(screen.getByTestId('create-job-invoice-dialog')).toBeVisible();
    });
    expect(mockApi.post).not.toHaveBeenCalledWith('/api/invoices', expect.anything());
  });
});

describe('JobDetailPage — JobLeadTasksTab receives entity UUID', () => {
  it('passes job.id (UUID) not job_number as entity.id', async () => {
    const { user } = { user: (await import('@testing-library/user-event')).default.setup() };
    mockJob();
    renderWithProviders(<JobDetailPage />);

    // Wait for the page to load, then click the Tasks tab to mount JobLeadTasksTab
    const tasksTab = await screen.findByRole('tab', { name: /Tasks/ });
    await user.click(tasksTab);

    await waitFor(() => {
      expect(capturedJobEntity).not.toBeNull();
    });
    // Must be the UUID 'j0000000-…', not the display number 'J00001'
    expect(capturedJobEntity!.id).toBe('j0000000-0000-0000-0000-000000000001');
    expect(capturedJobEntity!.id).not.toBe('J00001');
    expect(capturedJobEntity!.type).toBe('JOB');
  });
});

// Batch 3: the Items tab grew two new SectionCard siblings around <LineItemsEditor> —
// <JobScopeOfWorkCard> (before <LineItemsEditor>) and
// <InternalCostsCard> (after <LineItemsEditor>, gated on canSeePricing).
describe('JobDetailPage — Items tab: Scope of Work + Internal Costs (Batch 3)', () => {
  const SCOPE = {
    id: 'scope-1',
    title: 'Demo & haul-away',
    body: 'Remove old unit.',
    flat_price: 250,
    is_taxable: true,
    internal_cost: 100,
  };
  const LINE = {
    id: 'line-1',
    job_id: 'j0000000-0000-0000-0000-000000000001',
    sequence: 1,
    description: 'Compressor swap',
    quantity: 1,
    unit_price: 300,
    unit_cost: 200,
    markup_percent: null,
    is_taxable: true,
    line_total: 300,
    discount_type: null,
    discount_value: null,
    discount_amount: 0,
    item_type: 'SERVICE',
    price_book_item_id: null,
  };

  function mockJobWithItems(overrides: Partial<typeof BASE_JOB> = {}) {
    const job = { ...BASE_JOB, ...overrides };
    mockApi.get.mockImplementation(async (url: string) => {
      if (url.endsWith('/scopes')) {
        return { data: { scopes: [SCOPE], billing: { total: 550, invoiced: 0, remaining: 550 } } };
      }
      if (url.endsWith('/line-items')) {
        return { data: { lines: [LINE], billing: { total: 550, invoiced: 0, remaining: 550 } } };
      }
      if (url.includes('/api/jobs/')) {
        return { data: { job } };
      }
      return { data: {} };
    });
  }

  it('fetches GET /jobs/:id/scopes and renders the scope block as a sibling of LineItemsEditor', async () => {
    mockJobWithItems();
    renderWithProviders(<JobDetailPage />, { ability: adminAbility });

    const user = userEvent.setup();
    await user.click(await screen.findByRole('tab', { name: /Items/i }));

    expect(await screen.findByDisplayValue('Demo & haul-away')).toBeInTheDocument();
    expect(screen.getByText('Compressor swap')).toBeInTheDocument();
    expect(mockApi.get).toHaveBeenCalledWith(`/api/jobs/${BASE_JOB.id}/scopes`);
  });

  // ── creation confers control, wired end to end (technician-ownership spec, Part C) ──────────
  //
  // canOnJob has its own unit tests, but nothing asserted that the PAGE actually asks it. Reverting
  // all three JobDetailPage call sites to the old subject-level `ability.can('manage_lines','Job')`
  // left every existing suite green, because the components used to fall back to that same
  // expression when the prop was absent. The prop is required now and these two cases pin the
  // wiring: same ability, same page, opposite answers driven only by the job's `created_by_id`.
  describe('the Items tab follows CREATION, not assignment', () => {
    const TECH_ID = '00000000-0000-0000-0000-000000000001'; // the mocked auth-store user
    const OWN_JOB_COND = { assignees: { some: { user_id: TECH_ID } } };
    const CREATED_BY_ME_COND = { created_by_id: TECH_ID };

    // The exact rules the server ships for a technician after PR 3.
    const technicianAbility = buildAbility([
      { action: 'read', subject: 'Job', conditions: { OR: [OWN_JOB_COND, CREATED_BY_ME_COND] } },
      { action: 'update', subject: 'Job', conditions: OWN_JOB_COND },
      { action: 'manage_lines', subject: 'Job', conditions: CREATED_BY_ME_COND },
      { action: 'read', subject: 'Pricing' },
    ] as never);

    async function openItemsTab(created_by_id: string) {
      mockJobWithItems({ created_by_id } as never);
      renderWithProviders(<JobDetailPage />, { ability: technicianAbility });
      await userEvent.setup().click(await screen.findByRole('tab', { name: /Items/i }));
      await screen.findByText('Compressor swap');
    }

    it('offers the line-item and scope editors on a job the technician CREATED', async () => {
      await openItemsTab(TECH_ID);
      expect(screen.getByRole('button', { name: /add item/i })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /remove compressor swap/i })).toBeInTheDocument();
    });

    it('offers neither on a job the technician is only assigned to - the API would refuse', async () => {
      await openItemsTab('99555555-0224-9999-9999-995555550224');
      // Absent, not disabled - house convention.
      expect(screen.queryByRole('button', { name: /add item/i })).toBeNull();
      expect(screen.queryByRole('button', { name: /remove compressor swap/i })).toBeNull();
      // Still READABLE: `read Job` covers assigned-or-created, and `read Pricing` is a role default
      // now, so the line and its money are on screen. Only the WRITE affordances are gone.
      expect(screen.getByText('Compressor swap')).toBeInTheDocument();
    });
  });

  it('renders InternalCostsCard after LineItemsEditor when the ability can read Invoice', async () => {
    mockJobWithItems();
    renderWithProviders(<JobDetailPage />, { ability: adminAbility });

    const user = userEvent.setup();
    await user.click(await screen.findByRole('tab', { name: /Items/i }));

    await screen.findByDisplayValue('Demo & haul-away');
    expect(screen.getByText('Internal costs')).toBeInTheDocument();
  });

  it('hides InternalCostsCard entirely when the ability cannot read Invoice', async () => {
    mockJobWithItems();
    const restrictedAbility = buildAbility([{ action: 'manage_lines', subject: 'Job' }]);
    renderWithProviders(<JobDetailPage />, { ability: restrictedAbility });

    const user = userEvent.setup();
    await user.click(await screen.findByRole('tab', { name: /Items/i }));

    await screen.findByText('Compressor swap');
    expect(screen.queryByText('Internal costs')).not.toBeInTheDocument();
  });
});

// E1/E2 (job-owns-tax-discount) - the Items tab's tax rate + discount are editable now, not a
// read-only reflection of a linked estimate.
describe('JobDetailPage — Items tab: editable tax + discount (job-owns-tax-discount)', () => {
  const LINE = {
    id: 'line-1',
    job_id: 'j0000000-0000-0000-0000-000000000001',
    sequence: 1,
    description: 'Compressor swap',
    quantity: 1,
    unit_price: 1000,
    unit_cost: 200,
    markup_percent: null,
    is_taxable: true,
    line_total: 1000,
    discount_type: null,
    discount_value: null,
    discount_amount: 0,
    item_type: 'SERVICE',
    price_book_item_id: null,
  };
  const TAX_RATES = [{ id: 't1', state_code: 'TX', state_name: 'Texas', tax_rate: 0.0825 }];

  function mockEditableJob(billingOverrides: Record<string, unknown> = {}) {
    const job = { ...BASE_JOB };
    mockApi.get.mockImplementation(async (url: string) => {
      if (url.endsWith('/scopes')) {
        return { data: { scopes: [], billing: { total: 1000, invoiced: 0, remaining: 1000 } } };
      }
      if (url.endsWith('/line-items')) {
        return {
          data: {
            lines: [LINE],
            billing: {
              subtotal: 1000, discount_amount: 0, tax_rate: 0, tax_amount: 0, total: 1000,
              invoiced: 0, remaining: 1000, over_billed: 0,
              ...billingOverrides,
            },
          },
        };
      }
      if (url === '/api/state-tax-rates') {
        return { data: TAX_RATES };
      }
      if (url.includes('/api/jobs/')) {
        return { data: { job } };
      }
      return { data: {} };
    });
    mockApi.patch.mockResolvedValue({ data: { job } });
  }

  it('sends tax_rate when a jurisdiction is picked from the Items tab', async () => {
    mockEditableJob();
    renderWithProviders(<JobDetailPage />, { ability: adminAbility });

    const user = userEvent.setup();
    await user.click(await screen.findByRole('tab', { name: /Items/i }));
    await screen.findByText('Compressor swap');

    const trigger = await screen.findByRole('combobox', { name: 'Tax jurisdiction' });
    await user.click(trigger);
    await user.click(await screen.findByRole('option', { name: /Texas/ }));

    await waitFor(() => expect(mockApi.patch).toHaveBeenCalledWith(
      `/api/jobs/${BASE_JOB.id}`,
      expect.objectContaining({ tax_rate: 0.0825 }),
    ));
  });

  it('sends discount_type/discount_value when the discount row is edited', async () => {
    mockEditableJob();
    renderWithProviders(<JobDetailPage />, { ability: adminAbility });

    const user = userEvent.setup();
    await user.click(await screen.findByRole('tab', { name: /Items/i }));
    await screen.findByText('Compressor swap');

    const discountInput = await screen.findByRole('spinbutton', { name: 'Discount amount' });
    await user.clear(discountInput);
    await user.type(discountInput, '50');
    await user.tab();

    await waitFor(() => expect(mockApi.patch).toHaveBeenCalledWith(
      `/api/jobs/${BASE_JOB.id}`,
      expect.objectContaining({ discount_type: 'FIXED_AMOUNT', discount_value: 50 }),
    ));
  });

  it('renders the tax rate read-only when the requester cannot update the job', async () => {
    mockEditableJob();
    const restrictedAbility = buildAbility([{ action: 'read', subject: 'Job' }, { action: 'read', subject: 'Pricing' }]);
    renderWithProviders(<JobDetailPage />, { ability: restrictedAbility });

    const user = userEvent.setup();
    await user.click(await screen.findByRole('tab', { name: /Items/i }));
    await screen.findByText('Compressor swap');

    expect(screen.queryByRole('combobox', { name: 'Tax jurisdiction' })).not.toBeInTheDocument();
  });
});

// Inventory P1 — completion nudge (§5), cancel/delete return-to-stock copy (§4).
describe('JobDetailPage — inventory stock semantics (Inventory P1)', () => {
  const BASE_LINE = {
    id: 'line-1',
    job_id: 'j0000000-0000-0000-0000-000000000001',
    sequence: 1,
    description: 'Filter 20x20',
    quantity: 2,
    unit_price: 25,
    unit_cost: 8,
    markup_percent: null,
    is_taxable: true,
    line_total: 50,
    discount_type: null,
    discount_value: null,
    discount_amount: 0,
    item_type: 'MATERIAL',
    price_book_item_id: 'pb-1',
  };
  const SYNCED_LINE = { ...BASE_LINE, stock_status: 'SYNCED', stock_location_id: 'loc-1' };
  const SYNCED_LINE_B = { ...SYNCED_LINE, id: 'line-2', description: 'Wire spool' };
  const UNSYNCED_LINE = {
    ...BASE_LINE,
    id: 'line-3',
    description: 'Breaker',
    stock_status: 'UNSYNCED',
    stock_location_id: null,
  };

  function mockJobWithStockLines(
    lines: Array<Record<string, unknown>>,
    overrides: Partial<typeof BASE_JOB> = {},
  ) {
    const job = { ...BASE_JOB, ...overrides };
    mockApi.get.mockImplementation(async (url: string) => {
      if (url.endsWith('/scopes')) {
        return { data: { scopes: [], billing: { total: 0, invoiced: 0, remaining: 0 } } };
      }
      if (url.endsWith('/line-items')) {
        return { data: { lines, billing: { total: 50, invoiced: 0, remaining: 50 } } };
      }
      if (url.includes('/api/jobs/')) {
        return { data: { job } };
      }
      return { data: {} };
    });
  }

  it('completing a job with tracked lines fires the completion POST without a stock-sync nudge (LO-4)', async () => {
    mockJobWithStockLines([UNSYNCED_LINE, SYNCED_LINE], { status: 'IN_PROGRESS' });
    mockApi.post.mockResolvedValue({ data: {} });

    renderWithProviders(<JobDetailPage />, { ability: adminAbility });

    const user = userEvent.setup();
    // #718 consolidated the header actions — Mark Complete now lives inside the Actions menu.
    await user.click(await screen.findByRole('button', { name: 'Actions' }));
    await user.click(await screen.findByRole('menuitem', { name: /Mark Complete/ }));

    // Never a gate: the completion POST fires regardless of any line's stock state.
    await waitFor(() => {
      expect(mockApi.post).toHaveBeenCalledWith(
        '/api/jobs/j0000000-0000-0000-0000-000000000001/complete',
      );
    });
    // LO-4: the legacy "never synced with inventory" completion nudge is retired.
    expect(toastHoisted.toast).not.toHaveBeenCalledWith(
      expect.objectContaining({ description: expect.stringContaining('never synced') }),
    );
  });

  it('CancelJobDialog announces how many synced lines will be returned to stock (QA-413 copy)', async () => {
    mockJobWithStockLines([SYNCED_LINE, SYNCED_LINE_B, UNSYNCED_LINE], { status: 'UNASSIGNED' });

    renderWithProviders(<JobDetailPage />, { ability: adminAbility });

    const user = userEvent.setup();
    // #718: the three-dot "More actions" trigger became the consolidated "Actions" menu.
    await user.click(await screen.findByRole('button', { name: 'Actions' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Cancel' }));

    expect(
      await screen.findByText('2 synced inventory item(s) will be returned to stock.'),
    ).toBeInTheDocument();
  });

  it('job delete confirm gains the return sentence only when synced lines exist', async () => {
    mockJobWithStockLines([SYNCED_LINE], { status: 'UNASSIGNED' });

    const first = renderWithProviders(<JobDetailPage />, { ability: adminAbility });
    const user = userEvent.setup();
    // #718: the three-dot "More actions" trigger became the consolidated "Actions" menu.
    await user.click(await first.findByRole('button', { name: 'Actions' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Delete' }));

    expect(
      await screen.findByText('Synced inventory items on this job will be returned to stock.'),
    ).toBeInTheDocument();
    // Cancel — the delete never fired.
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(mockApi.delete).not.toHaveBeenCalled();
    first.unmount();

    // Control: no synced lines ⇒ no stock sentence in the confirm dialog.
    mockJobWithStockLines([UNSYNCED_LINE], { status: 'UNASSIGNED' });
    renderWithProviders(<JobDetailPage />, { ability: adminAbility });
    await user.click(await screen.findByRole('button', { name: 'Actions' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Delete' }));

    expect(await screen.findByText('Delete this job?')).toBeInTheDocument();
    expect(
      screen.queryByText('Synced inventory items on this job will be returned to stock.'),
    ).not.toBeInTheDocument();
  });
});

// Final-review fix: once the job is fully paid off, the Payment Received node must stop being
// interactive — there is no "view" action for it (unlike invoice_sent's State 1), so leaving it
// clickable only invites recording an accidental extra payment.
describe('JobDetailPage — Payment Received node disables once fully paid off (final-review fix)', () => {
  function mockJobWithFinancials(
    jobOverrides: Partial<typeof BASE_JOB>,
    financials: Record<string, unknown>,
  ) {
    const job = { ...BASE_JOB, ...jobOverrides };
    mockApi.get.mockImplementation(async (url: string) => {
      if (url.endsWith('/financials')) {
        return { data: financials };
      }
      if (url.includes('/api/jobs/')) {
        return { data: { job } };
      }
      return { data: {} };
    });
  }

  it('renders Payment Received as inert (not a button) once total_paid meets total_invoiced', async () => {
    mockJobWithFinancials(
      { status: 'COMPLETED', completed_at: '2026-02-10T16:00:00.000Z' },
      {
        final_invoice: {
          id: 'inv-1', invoice_number: 'I00001', status: 'PAID',
          total_amount: 1000, amount_due: 0,
          sent_at: '2026-02-05T12:00:00.000Z', paid_at: '2026-02-06T12:00:00.000Z',
        },
        first_sent_at: '2026-02-05T12:00:00.000Z',
        total_invoiced: 1000,
        total_paid: 1000,
        invoices: [],
        payments: [],
      },
    );

    renderWithProviders(<JobDetailPage />, { ability: adminAbility });

    // Wait for the bar to render with the loaded financials before asserting absence.
    await screen.findByText('Payment Received');
    expect(screen.queryByRole('button', { name: /payment received/i })).not.toBeInTheDocument();
  });

  it('keeps Payment Received clickable — opens Record Payment — while a balance remains', async () => {
    mockJobWithFinancials(
      { status: 'COMPLETED', completed_at: '2026-02-10T16:00:00.000Z' },
      {
        final_invoice: {
          id: 'inv-1', invoice_number: 'I00001', status: 'SENT',
          total_amount: 1000, amount_due: 400,
          sent_at: '2026-02-05T12:00:00.000Z', paid_at: null,
        },
        first_sent_at: '2026-02-05T12:00:00.000Z',
        total_invoiced: 1000,
        total_paid: 600,
        invoices: [],
        payments: [],
      },
    );

    renderWithProviders(<JobDetailPage />, { ability: adminAbility });

    const btn = await screen.findByRole('button', { name: /payment received/i });
    await userEvent.click(btn);

    // The page also has its own standing "Record Payment" button in the money block, so scope
    // to the dialog's heading rather than any "Record Payment" text on the page.
    expect(await screen.findByRole('heading', { name: 'Record Payment' })).toBeInTheDocument();
  });
});

// SRVW-96 - the Estimates tab must list every estimate attached to the job (provenance plus
// linked_estimates), not just job.estimate. The empty state should only show when both are empty.
describe('JobDetailPage - Estimates tab lists attached estimates (SRVW-96)', () => {
  it('lists an attached estimate when the job has no provenance estimate', async () => {
    mockJob({
      estimate: null,
      linked_estimates: [{ id: 'e1', estimate_number: 'J00001-1', total_amount: 425, status: 'WON' }],
    });
    renderWithProviders(<JobDetailPage />, { ability: adminAbility });

    const user = userEvent.setup();
    await user.click(await screen.findByRole('tab', { name: /Estimates/i }));

    expect(await screen.findByText('J00001-1')).toBeInTheDocument();
    expect(screen.getByText(/billed from the job's own line items/)).toBeInTheDocument();
    expect(screen.queryByText('No linked estimate')).not.toBeInTheDocument();
    expect(screen.queryByText(/not on this job/i)).not.toBeInTheDocument();
  });

  it('empty state still renders when both provenance and linked estimates are empty', async () => {
    mockJob({ estimate: null, linked_estimates: [] });
    renderWithProviders(<JobDetailPage />, { ability: adminAbility });

    const user = userEvent.setup();
    await user.click(await screen.findByRole('tab', { name: /Estimates/i }));

    expect(await screen.findByText('No linked estimate')).toBeInTheDocument();
  });
});

// Characterization test over the payload shape step 6 (getFinancials) newly produces - this test
// hand-supplies the financials payload and cannot itself prove the backend produces it; it only
// answers whether the masthead absorbs a linked estimate's paid deposit exactly once.
describe('JobDetailPage - masthead absorbs a linked estimate deposit exactly once (SRVW-96)', () => {
  function mockJobWithFinancials(
    jobOverrides: Partial<typeof BASE_JOB>,
    financials: Record<string, unknown>,
  ) {
    const job = { ...BASE_JOB, ...jobOverrides };
    mockApi.get.mockImplementation(async (url: string) => {
      if (url.endsWith('/financials')) {
        return { data: financials };
      }
      if (url.includes('/api/jobs/')) {
        return { data: { job } };
      }
      return { data: {} };
    });
  }

  it("counts a linked estimate's paid deposit once in the masthead money summary", async () => {
    mockJobWithFinancials(
      { status: 'COMPLETED', completed_at: '2026-02-10T16:00:00.000Z' },
      {
        final_invoice: {
          id: 'std-1', invoice_number: 'I00002', status: 'SENT',
          total_amount: 1000, amount_due: 400,
          sent_at: '2026-03-10T12:00:00.000Z', paid_at: null,
        },
        first_sent_at: '2026-03-10T12:00:00.000Z',
        total_invoiced: 1000,
        total_paid: 600,
        invoices: [],
        payments: [
          { amount: 600, invoice_kind: 'DEPOSIT', paid_at: '2026-02-02T00:00:00.000Z' },
          { amount: 600, reference_number: 'DEPOSIT-CREDIT', invoice_kind: 'STANDARD', paid_at: '2026-03-10T12:00:00.000Z' },
        ],
      },
    );

    renderWithProviders(<JobDetailPage />, { ability: adminAbility });

    expect(await screen.findByText('Deposit $600.00')).toBeInTheDocument();
    expect(await screen.findByText('$400.00')).toBeInTheDocument();
    expect(await screen.findByText('60% collected')).toBeInTheDocument();
  });
});
