import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, fireEvent, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithProviders } from '@/__tests__/helpers';
import WorkflowsHome from './WorkflowsHome';
import {
  useWorkflows,
  useWorkflowCatalog,
  useToggleWorkflow,
  useDeleteWorkflow,
  useCreateWorkflow,
  type ApiWorkflow,
  type WorkflowCatalog,
} from '@/lib/api/workflows';

const mockNavigate = vi.fn();
vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual<typeof import('react-router-dom')>('react-router-dom');
  return { ...actual, useNavigate: () => mockNavigate };
});

vi.mock('@/lib/api/workflows', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api/workflows')>();
  return {
    ...actual,
    useWorkflows: vi.fn(),
    useWorkflowCatalog: vi.fn(),
    useToggleWorkflow: vi.fn(),
    useDeleteWorkflow: vi.fn(),
    useCreateWorkflow: vi.fn(),
  };
});

const mockUseWorkflows = vi.mocked(useWorkflows);
const mockUseWorkflowCatalog = vi.mocked(useWorkflowCatalog);
const mockUseToggleWorkflow = vi.mocked(useToggleWorkflow);
const mockUseDeleteWorkflow = vi.mocked(useDeleteWorkflow);
const mockUseCreateWorkflow = vi.mocked(useCreateWorkflow);

type WorkflowsResult = ReturnType<typeof useWorkflows>;
type CatalogResult = ReturnType<typeof useWorkflowCatalog>;

function workflowsResult(
  data: ApiWorkflow[] | undefined,
  overrides: Partial<WorkflowsResult> = {},
): WorkflowsResult {
  return { data, isLoading: false, isError: false, refetch: vi.fn(), ...overrides } as unknown as WorkflowsResult;
}

function catalogResult(data: WorkflowCatalog | undefined, overrides: Partial<CatalogResult> = {}): CatalogResult {
  return { data, isLoading: false, isError: false, refetch: vi.fn(), ...overrides } as unknown as CatalogResult;
}

/** Minimal catalog fixture, one template per category. */
const CATALOG: WorkflowCatalog = {
  triggers: {} as WorkflowCatalog['triggers'],
  actions: {} as WorkflowCatalog['actions'],
  audiences: {} as WorkflowCatalog['audiences'],
  anchors: {} as WorkflowCatalog['anchors'],
  merge_field_labels: {},
  sample_context: {},
  templates: [
    {
      key: 'reminder-24h',
      name: '24-hour appointment reminder',
      description: 'Text the customer one day before their scheduled job.',
      category: 'customer',
      trigger_type: 'BEFORE_JOB_START',
      trigger_config: { offset_minutes: 24 * 60 },
      action_type: 'SEND_SMS',
      action_config: { recipient: 'customer', body: 'Hi {{customer.first_name}}' },
      send_window: 'BUSINESS_HOURS',
    },
    {
      key: 'job-scheduled-confirmation',
      name: 'Job scheduled confirmation',
      description: 'Email the customer the moment their job is booked in.',
      category: 'customer',
      trigger_type: 'JOB_SCHEDULED',
      action_type: 'SEND_EMAIL',
      action_config: { recipient: 'customer', subject: "You're booked", body: 'See you then.' },
      send_window: 'ANYTIME',
    },
    {
      key: 'payment-thank-you',
      name: 'Payment thank-you',
      description: 'Thank the customer automatically when an invoice is paid.',
      category: 'money',
      trigger_type: 'INVOICE_PAID',
      action_type: 'SEND_EMAIL',
      action_config: { recipient: 'customer', subject: 'Thank you!', body: 'Thanks for paying.' },
      send_window: 'ANYTIME',
    },
    {
      key: 'new-lead-alert',
      name: 'New lead alert',
      description: 'Ping the office in-app whenever a new lead lands.',
      category: 'team',
      trigger_type: 'LEAD_CREATED',
      action_type: 'NOTIFY_TEAM',
      action_config: { recipient: 'all_dispatchers', body: 'New lead landed.' },
      send_window: 'ANYTIME',
    },
  ],
  stop_if: { conditions: {}, labels: { invoice_paid: 'the invoice is paid' } },
  capabilities: { sms_available: false },
};

function makeWorkflow(overrides: Partial<ApiWorkflow> = {}): ApiWorkflow {
  return {
    id: 'w0000000-0000-0000-0000-000000000001',
    name: 'Review request follow-up',
    status: 'PUBLISHED',
    is_enabled: true,
    trigger_type: 'JOB_COMPLETED',
    trigger_config: null,
    send_window: 'ANYTIME',
    template_key: null,
    legacy_rule_id: null,
    published_at: '2026-07-01T00:00:00.000Z',
    last_triggered_at: '2026-07-10T09:00:00.000Z',
    trigger_count: 42,
    created_at: '2026-06-01T00:00:00.000Z',
    updated_at: '2026-07-01T00:00:00.000Z',
    steps: [
      { id: 's1', position: 0, step_type: 'WAIT', config: { duration_minutes: 1440 } },
      { id: 's2', position: 1, step_type: 'SEND_TEXT', config: { recipient: 'customer', body: 'hi' } },
    ],
    issues: [],
    has_unpublished_changes: false,
    published_version: { version: 1, published_at: '2026-07-01T00:00:00.000Z' },
    ...overrides,
  };
}

function mutationResult(overrides: Record<string, unknown> = {}) {
  return { mutate: vi.fn(), mutateAsync: vi.fn(), isPending: false, ...overrides } as any;
}

beforeEach(() => {
  vi.clearAllMocks();
  mockUseToggleWorkflow.mockReturnValue(mutationResult());
  mockUseDeleteWorkflow.mockReturnValue(mutationResult());
  mockUseCreateWorkflow.mockReturnValue(mutationResult());
});

describe('WorkflowsHome — templates gallery front door', () => {
  it('renders gallery groups from the mocked catalog; zero workflows → gallery-first, no "My automations" table', () => {
    mockUseWorkflows.mockReturnValue(workflowsResult([]));
    mockUseWorkflowCatalog.mockReturnValue(catalogResult(CATALOG));

    renderWithProviders(<WorkflowsHome />);

    expect(screen.getByText('Customer communication')).toBeInTheDocument();
    expect(screen.getByText('Getting paid')).toBeInTheDocument();
    expect(screen.getByText('Team coordination')).toBeInTheDocument();
    expect(screen.getByText('Job scheduled confirmation')).toBeInTheDocument();
    expect(screen.getByText('Payment thank-you')).toBeInTheDocument();
    expect(screen.getByText('New lead alert')).toBeInTheDocument();

    expect(screen.queryByText('My automations')).toBeNull();
    expect(screen.getByRole('button', { name: 'Start from scratch' })).toBeInTheDocument();
  });

  it('hides texting templates from the gallery for an org that cannot text (capabilities.sms_available: false)', () => {
    mockUseWorkflows.mockReturnValue(workflowsResult([]));
    mockUseWorkflowCatalog.mockReturnValue(catalogResult(CATALOG));

    renderWithProviders(<WorkflowsHome />);

    // The only SEND_SMS template in the fixture must not surface anywhere.
    expect(screen.queryByText('24-hour appointment reminder')).toBeNull();
    // …but its (email) category sibling still renders the section.
    expect(screen.getByText('Customer communication')).toBeInTheDocument();
    expect(screen.getByText('Job scheduled confirmation')).toBeInTheDocument();
  });

  it('shows texting templates for an org that can text (capabilities.sms_available: true)', () => {
    mockUseWorkflows.mockReturnValue(workflowsResult([]));
    mockUseWorkflowCatalog.mockReturnValue(
      catalogResult({ ...CATALOG, capabilities: { sms_available: true } }),
    );

    renderWithProviders(<WorkflowsHome />);

    expect(screen.getByText('24-hour appointment reminder')).toBeInTheDocument();
  });

  it('shows loading skeletons while the catalog is loading', () => {
    mockUseWorkflows.mockReturnValue(workflowsResult([]));
    mockUseWorkflowCatalog.mockReturnValue(catalogResult(undefined, { isLoading: true }));
    const { container } = renderWithProviders(<WorkflowsHome />);
    expect(container.querySelectorAll('.animate-pulse').length).toBeGreaterThan(0);
  });

  it('shows an error state with retry when the catalog fails to load', () => {
    const refetch = vi.fn();
    mockUseWorkflows.mockReturnValue(workflowsResult([]));
    mockUseWorkflowCatalog.mockReturnValue(catalogResult(undefined, { isError: true, refetch }));
    renderWithProviders(<WorkflowsHome />);

    const retry = screen.getByRole('button', { name: 'Retry' });
    fireEvent.click(retry);
    expect(refetch).toHaveBeenCalled();
  });
});

describe('WorkflowsHome — My automations list', () => {
  it('renders the recipe sentence + status pill for a workflow row', () => {
    mockUseWorkflows.mockReturnValue(workflowsResult([makeWorkflow()]));
    mockUseWorkflowCatalog.mockReturnValue(catalogResult(CATALOG));
    renderWithProviders(<WorkflowsHome />);

    expect(screen.getByText('Review request follow-up')).toBeInTheDocument();
    // describeWorkflow('JOB_COMPLETED', null, [WAIT 1440, SEND_TEXT customer], catalog)
    expect(screen.getByText('When a job is completed → wait 1 day → text the customer')).toBeInTheDocument();
    expect(screen.getByText('Live')).toBeInTheDocument();
    // trigger_count is a run count, not a send count (a step can WAIT or be SKIPPED/FAILED
    // downstream) - copy must say "Ran", never "Sent". See CONTEXT.md, "Run" / "Send".
    expect(screen.getByText(/Ran 42 times/)).toBeInTheDocument();
    expect(screen.getByText('Runs all-time')).toBeInTheDocument();
  });

  it('toggling the Switch on a published workflow fires the flipped value', () => {
    const toggle = mutationResult();
    mockUseToggleWorkflow.mockReturnValue(toggle);
    mockUseWorkflows.mockReturnValue(workflowsResult([makeWorkflow({ is_enabled: true })]));
    mockUseWorkflowCatalog.mockReturnValue(catalogResult(CATALOG));
    renderWithProviders(<WorkflowsHome />);

    const switchEl = screen.getByRole('switch');
    fireEvent.click(switchEl);
    expect(toggle.mutate).toHaveBeenCalledWith({ id: 'w0000000-0000-0000-0000-000000000001', is_enabled: false });
  });

  it("a DRAFT row's Switch is disabled", () => {
    mockUseWorkflows.mockReturnValue(
      workflowsResult([makeWorkflow({ status: 'DRAFT', is_enabled: false, published_at: null, published_version: null })]),
    );
    mockUseWorkflowCatalog.mockReturnValue(catalogResult(CATALOG));
    renderWithProviders(<WorkflowsHome />);

    expect(screen.getByRole('switch')).toBeDisabled();
    expect(screen.getByText('Draft')).toBeInTheDocument();
  });

  it('deleting flows through the confirm dialog before calling deleteWorkflow', async () => {
    const remove = mutationResult();
    mockUseDeleteWorkflow.mockReturnValue(remove);
    mockUseWorkflows.mockReturnValue(workflowsResult([makeWorkflow()]));
    mockUseWorkflowCatalog.mockReturnValue(catalogResult(CATALOG));
    renderWithProviders(<WorkflowsHome />);

    await userEvent.click(screen.getByRole('button', { name: 'Actions for Review request follow-up' }));
    await userEvent.click(await screen.findByText('Delete'));

    // Confirm dialog is up; delete must NOT have fired yet.
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText(/Delete "Review request follow-up"\?/)).toBeInTheDocument();
    expect(remove.mutate).not.toHaveBeenCalled();

    fireEvent.click(within(dialog).getByRole('button', { name: 'Delete' }));
    expect(remove.mutate).toHaveBeenCalledWith('w0000000-0000-0000-0000-000000000001', expect.anything());
  });
});

describe('WorkflowsHome — Duplicate', () => {
  it('does not carry a legacy send_window onto the copy', async () => {
    const create = mutationResult({
      mutateAsync: vi.fn().mockResolvedValue({ id: 'copy-id' }),
    });
    mockUseCreateWorkflow.mockReturnValue(create);
    // A legacy row from before the send window was removed from the builder.
    mockUseWorkflows.mockReturnValue(workflowsResult([makeWorkflow({ send_window: 'BUSINESS_HOURS' })]));
    mockUseWorkflowCatalog.mockReturnValue(catalogResult(CATALOG));
    renderWithProviders(<WorkflowsHome />);

    await userEvent.click(screen.getByRole('button', { name: 'Actions for Review request follow-up' }));
    await userEvent.click(await screen.findByRole('menuitem', { name: /duplicate/i }));

    await waitFor(() => expect(create.mutateAsync).toHaveBeenCalled());
    expect(create.mutateAsync.mock.calls[0]?.[0]).not.toHaveProperty('send_window');
  });
});

describe('WorkflowsHome — "Use this" on a template', () => {
  // The SEND_SMS → SEND_TEXT fold is unit-covered in describeWorkflow.test.ts.
  // Here we only assert the gallery wiring against a non-texting template
  // (texting templates are hidden while SMS delivery is locked).
  it('folds the template, calls createWorkflow and navigates to the new workflow', async () => {
    const create = mutationResult({
      mutateAsync: vi.fn().mockResolvedValue({ id: 'new-workflow-id' }),
    });
    mockUseCreateWorkflow.mockReturnValue(create);
    mockUseWorkflows.mockReturnValue(workflowsResult([]));
    mockUseWorkflowCatalog.mockReturnValue(catalogResult(CATALOG));
    renderWithProviders(<WorkflowsHome />);

    const card = screen.getByText('Job scheduled confirmation').closest('div')!;
    fireEvent.click(within(card).getByRole('button', { name: 'Use this' }));

    await waitFor(() => expect(create.mutateAsync).toHaveBeenCalled());
    expect(create.mutateAsync).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'Job scheduled confirmation',
        trigger_type: 'JOB_SCHEDULED',
        steps: [
          { step_type: 'SEND_EMAIL', config: { recipient: 'customer', subject: "You're booked", body: 'See you then.' } },
        ],
      }),
    );
    await waitFor(() => expect(mockNavigate).toHaveBeenCalledWith('/automations/new-workflow-id'));
  });
});
