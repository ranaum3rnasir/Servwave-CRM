import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import { useLocation } from 'react-router-dom';
import userEvent from '@testing-library/user-event';
import api from '@/lib/axios';
import { renderWithProviders, LEAD_FIXTURE, NOTES_FIXTURE } from './helpers';
import { buildAbility } from '@/lib/ability';
import { requestCall } from '@/lib/communication/phoneTabHandoff';
import LeadDetailPage from '@/pages/LeadDetailPage';

// Org-level comms access (E2): default FALSE — the pre-existing specs exercise
// the native tel: baseline; the call-entry matrix flips it per test.
const commAccess = vi.hoisted(() => ({ value: false }));
vi.mock('@/lib/entitlements', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/entitlements')>()),
  useFeature: () => commAccess.value,
}));

// Task B4 — the customer phone link routes through the cross-tab dial
// handoff into the /phone tab, not the legacy in-app GlobalDialer popup.
vi.mock('@/lib/communication/phoneTabHandoff', () => ({
  requestCall: vi.fn(),
}));

// Capture the entity prop passed to JobLeadTasksTab to assert UUID correctness
let capturedLeadEntity: { type: string; id: string; label: string } | null = null;
vi.mock('@/components/tasks/JobLeadTasksTab', () => ({
  JobLeadTasksTab: (props: { entity: { type: string; id: string; label: string } }) => {
    capturedLeadEntity = props.entity;
    return null;
  },
}));

// Mock the lead comms tab (slice E4 swapped the customer roll-up out for the
// lead-union timeline) so the Communication tab tests can assert the leadId +
// customerId wiring without pulling in the real query.
vi.mock('@/components/communication/LeadCommunicationsTab', () => ({
  LeadCommunicationsTab: (p: { leadId: string; customerId?: string }) => (
    <div data-testid="lead-comms" data-lead={p.leadId} data-customer={p.customerId} />
  ),
}));

// Action buttons (Edit, Assign, Mark Lost, Create Estimate, Convert to Job …) are
// now gated on CASL ability rather than the auth-store role (see #238). Render
// with a full-access (admin superuser) ability so the action surface appears.
const adminAbility = buildAbility([{ action: 'manage', subject: 'all' }]);

// floating-ui (under Radix dropdown) does `new ResizeObserver(...)`; the global
// setup mock returns a plain object and isn't constructable, so install a real
// class stub (same pattern as sms-inbox-job-pills.test.tsx).
class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
global.ResizeObserver = ResizeObserverStub as unknown as typeof ResizeObserver;

// Mock useParams to return the lead ID
vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual('react-router-dom');
  return {
    ...actual,
    useParams: () => ({ id: 'e0000000-0000-0000-0000-000000000001' }),
  };
});

const mockApi = vi.mocked(api);
const mockRequestCall = vi.mocked(requestCall);

const openLeadActions = async (user: ReturnType<typeof userEvent.setup>) =>
  user.click(await screen.findByRole('button', { name: /Lead actions/i }));

beforeEach(() => {
  vi.clearAllMocks();
  capturedLeadEntity = null;
  commAccess.value = false;

  // GET /api/leads/:id
  mockApi.get.mockImplementation(async (url: string) => {
    if (url.includes('/notes')) {
      return { data: { notes: NOTES_FIXTURE } };
    }
    if (url.includes('/api/users')) {
      return { data: { users: [{ id: 'u1', first_name: 'Alice', last_name: 'Sales', role: 'SALES', is_active: true, has_login: true, department: null }] } };
    }
    if (url.includes('/api/leads/')) {
      return { data: { lead: LEAD_FIXTURE } };
    }
    if (url.includes('/api/tags')) {
      return { data: { tags: [] } };
    }
    return { data: {} };
  });
});

// Phase 11.6 - LeadDetailPage moves from DetailPageShell to TabStrip.
// Pins the real page's rendered tab-strip markup byte-exact: the old
// `railWrapperClassName="border-t border-border"` becomes an outer div
// wrapping the whole TabStrip (rail + content) rather than the rail alone -
// see this page's own comment above its `TabStrip` call for why that still
// lands the border in the identical position. The rest of the old
// `listClassName` was already a no-op and is not reproduced.
describe('LeadDetailPage tab strip - TabStrip rendered contract', () => {
  const cls = (el: Element | null) => el?.getAttribute('class') ?? '';

  it('wraps the whole strip in the top-border div, no Card, underline triggers', async () => {
    renderWithProviders(<LeadDetailPage />, { ability: adminAbility });

    const list = await screen.findByRole('tablist');
    expect(cls(list)).toBe('flex items-center gap-[26px] border-b border-border');

    // TabStrip's own Tabs root is a direct child of the top-border wrapper, no className.
    const tabsRoot = list.parentElement as HTMLElement;
    expect(cls(tabsRoot)).toBe('');
    const borderWrapper = tabsRoot.parentElement as HTMLElement;
    expect(cls(borderWrapper)).toBe('border-t border-border');

    const overviewTab = screen.getByRole('tab', { name: 'Overview' });
    expect(cls(overviewTab)).toBe(
      'inline-flex items-center justify-center whitespace-nowrap transition-colors ' +
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary ' +
        'focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-50 relative ' +
        'border-b-[3px] border-transparent text-sm font-medium text-text-secondary ' +
        'hover:text-text-primary data-[state=active]:border-primary data-[state=active]:text-primary ' +
        'data-[state=active]:font-semibold px-5 py-3'
    );
  });
});

describe('LeadDetailPage', () => {
  it('renders lead title with customer name', async () => {
    renderWithProviders(<LeadDetailPage />, { ability: adminAbility });

    await waitFor(() => {
      expect(screen.getAllByText(/Lead from John Doe/).length).toBeGreaterThan(0);
    });
  });

  it('renders customer company name', async () => {
    renderWithProviders(<LeadDetailPage />, { ability: adminAbility });

    // Company name renders in both the hero and the contact card.
    await waitFor(() => {
      expect(screen.getAllByText('Doe HVAC').length).toBeGreaterThan(0);
    });
  });

  it('renders all 4 tab triggers', async () => {
    renderWithProviders(<LeadDetailPage />, { ability: adminAbility });

    await waitFor(() => {
      expect(screen.getByText('Overview')).toBeInTheDocument();
    });
    // "Walkthrough" appears in both a tab trigger and a section heading.
    expect(screen.getAllByText('Walkthrough').length).toBeGreaterThan(0);
    // The Attachments tab label now includes a count, e.g. "Attachments (0)".
    expect(screen.getByText(/Attachments \(\d+\)/)).toBeInTheDocument();
    // The Estimates tab label includes a count, e.g. "Estimates (0)".
    expect(screen.getByText(/Estimates \(\d+\)/)).toBeInTheDocument();
  });

  it('shows KPI strip labels', async () => {
    renderWithProviders(<LeadDetailPage />, { ability: adminAbility });

    await waitFor(() => {
      expect(screen.getByText('Estimated Value')).toBeInTheDocument();
    });
    expect(screen.getByText('Days Open')).toBeInTheDocument();
    expect(screen.getByText('Source')).toBeInTheDocument();
  });

  it('shows service request in Details tab', async () => {
    renderWithProviders(<LeadDetailPage />, { ability: adminAbility });

    await waitFor(() => {
      expect(screen.getByText('AC not cooling')).toBeInTheDocument();
    });
  });

  it('shows assigned user name', async () => {
    renderWithProviders(<LeadDetailPage />, { ability: adminAbility });

    await waitFor(() => {
      expect(screen.getByText('Test Sales')).toBeInTheDocument();
    });
  });

  it('shows customer phone', async () => {
    renderWithProviders(<LeadDetailPage />, { ability: adminAbility });

    // Phone is rendered through formatPhone().
    await waitFor(() => {
      expect(screen.getByText('(555) 123-4567')).toBeInTheDocument();
    });
  });

  // ── E2: in-app call entry gating for the customer phone link ─────────────

  it('routes into the /phone tab with lead attribution when comms access + create ability are present', async () => {
    commAccess.value = true;
    const user = userEvent.setup();
    renderWithProviders(<LeadDetailPage />, { ability: adminAbility });

    const phoneButton = await screen.findByRole('button', { name: '(555) 123-4567' });
    await user.click(phoneButton);

    expect(mockRequestCall).toHaveBeenCalledWith('5551234567', {
      leadId: 'e0000000-0000-0000-0000-000000000001',
      leadLabel: 'L00001',
      customerId: 'c0000000-0000-0000-0000-000000000001',
      customerName: 'John Doe',
    });
  });

  it('keeps the native tel: link without org comms access', async () => {
    renderWithProviders(<LeadDetailPage />, { ability: adminAbility });

    await waitFor(() => {
      expect(screen.getByText('(555) 123-4567')).toBeInTheDocument();
    });
    expect(screen.getByText('(555) 123-4567').closest('a')).toHaveAttribute(
      'href',
      'tel:5551234567'
    );
    expect(
      screen.queryByRole('button', { name: '(555) 123-4567' })
    ).not.toBeInTheDocument();
  });

  it('keeps the native tel: link without create:Communication even with comms access', async () => {
    commAccess.value = true;
    renderWithProviders(<LeadDetailPage />, {
      ability: buildAbility([{ action: 'read', subject: 'Communication' }]),
    });

    await waitFor(() => {
      expect(screen.getByText('(555) 123-4567')).toBeInTheDocument();
    });
    expect(screen.getByText('(555) 123-4567').closest('a')).toHaveAttribute(
      'href',
      'tel:5551234567'
    );
  });

  it('shows action buttons for ADMIN', async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    renderWithProviders(<LeadDetailPage />, { ability: adminAbility });

    await openLeadActions(user);
    expect(screen.getByText('Edit')).toBeInTheDocument();
    expect(screen.getByText('Assign')).toBeInTheDocument();
    expect(await screen.findByRole('menuitem', { name: 'Mark Lost' })).toBeInTheDocument();
  });

  it('shows estimates empty state', async () => {
    const user = userEvent.setup();
    renderWithProviders(<LeadDetailPage />, { ability: adminAbility });

    // The Estimates tab trigger is labelled "Estimates (N)".
    const estimatesTab = await screen.findByText(/Estimates \(\d+\)/);
    await user.click(estimatesTab);

    await waitFor(() => {
      expect(screen.getByText('No estimates yet.')).toBeInTheDocument();
    });
  });

  // NOTE: the lead-notes tab (a notes list + "Add a note..." textarea) was removed
  // when LeadDetailPage was restructured to the Overview/Walkthrough/Estimates/
  // Attachments layout. Lead notes are no longer surfaced on this page, so the two
  // prior notes tests were dropped rather than left asserting on absent UI.

  it('renders not found state when lead is null', async () => {
    mockApi.get.mockResolvedValue({ data: { lead: null } });

    renderWithProviders(<LeadDetailPage />, { ability: adminAbility });

    await waitFor(() => {
      expect(screen.getByText('Lead not found.')).toBeInTheDocument();
    });
  });
});

// #397 gave the Lead page a Communication tab (customer roll-up); slice E4
// swapped its body onto LeadCommunicationsTab — the LEAD union endpoint — so
// lead_id-only rows surface too. Wired with the lead's own id (plus the
// customer id for the attach menu scope), gated on `read Communication` (RBAC
// parity with the Customer/Job pages). The tab is Radix-lazy, so the mock only
// mounts once clicked.
describe('LeadDetailPage — Communication tab (#397 / E4)', () => {
  it('renders the Communication tab and mounts the lead comms timeline with the lead id (+ customer scope)', async () => {
    const user = userEvent.setup();
    renderWithProviders(<LeadDetailPage />, { ability: adminAbility });

    const commsTab = await screen.findByRole('tab', { name: /^Communication$/ });
    await user.click(commsTab);

    await waitFor(() => {
      expect(screen.getByTestId('lead-comms')).toBeInTheDocument();
    });
    // Wired to the LEAD id (the union endpoint's scope) — not customer-only anymore.
    expect(screen.getByTestId('lead-comms')).toHaveAttribute(
      'data-lead',
      'e0000000-0000-0000-0000-000000000001'
    );
    // The customer id rides along as the open-jobs scope for the attach menu.
    expect(screen.getByTestId('lead-comms')).toHaveAttribute(
      'data-customer',
      'c0000000-0000-0000-0000-000000000001'
    );
  });

  it('hides the Communication tab when the ability lacks read Communication', async () => {
    const readOnly = buildAbility([{ action: 'read', subject: 'Lead' }]);
    renderWithProviders(<LeadDetailPage />, { ability: readOnly });

    await waitFor(() => {
      expect(screen.getAllByText(/Lead from John Doe/).length).toBeGreaterThan(0);
    });
    expect(screen.queryByRole('tab', { name: /^Communication$/ })).toBeNull();
  });
});

describe('LeadDetailPage — Convert to Job (bug #12)', () => {
  const APPROVED_ESTIMATE = {
    id: 'es000000-0000-0000-0000-000000000001',
    estimate_number: 'E00001',
    status: 'WON',
    total_amount: '1500.00',
    created_at: '2026-02-01T00:00:00.000Z',
  };

  function mockLeadWithApprovedEstimate() {
    mockApi.get.mockImplementation(async (url: string) => {
      if (url.includes('/notes')) return { data: { notes: NOTES_FIXTURE } };
      if (url.includes('/api/leads/')) {
        return {
          data: { lead: { ...LEAD_FIXTURE, status: 'WON', estimates: [APPROVED_ESTIMATE] } },
        };
      }
      if (url.includes('/api/tags')) return { data: { tags: [] } };
      return { data: {} };
    });
  }

  it('Create Job opens the convert dialog; confirming POSTs /api/jobs with the approved estimate_id', async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    mockLeadWithApprovedEstimate();
    mockApi.post.mockResolvedValue({ data: { job: { id: 'j0000000-0000-0000-0000-000000000001' } } });

    renderWithProviders(<LeadDetailPage />, { ability: adminAbility });

    // "Convert to job" menu item (gated on CASL `create Job`) opens the convert dialog.
    await openLeadActions(user);
    await user.click(screen.getByRole('menuitem', { name: /Convert to job/i }));

    // CreateJobFromLeadDialog auto-selects the lone WON estimate; its "Create job"
    // confirm fires onConvert → createJobMutation → POST /api/jobs { estimate_id }. Scope
    // to the dialog so we hit the confirm, not the masthead button (both match /Create job/i).
    const dialog = await screen.findByRole('dialog');
    await user.click(within(dialog).getByRole('button', { name: /Create job/i }));

    await waitFor(() =>
      expect(mockApi.post).toHaveBeenCalledWith('/api/jobs', {
        estimate_id: APPROVED_ESTIMATE.id,
      }),
    );
  });
});

describe('LeadDetailPage — Assign menu item (#576)', () => {
  it('Assign menu item opens the assign popover (menu closes, panel opens)', async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    renderWithProviders(<LeadDetailPage />, { ability: adminAbility });
    await openLeadActions(user);
    await user.click(screen.getByRole('menuitem', { name: /Assign/i }));
    // Panel open: search input + roster row visible
    expect(await screen.findByPlaceholderText(/search team members/i)).toBeInTheDocument();
    expect(await screen.findByText('Alice Sales')).toBeInTheDocument();
    // Menu closed: no menuitems remain
    expect(screen.queryByRole('menuitem')).toBeNull();
  });
});

describe('LeadDetailPage — JobLeadTasksTab receives entity UUID', () => {
  it('passes the lead UUID (route param id) not lead_number as entity.id', async () => {
    const user = userEvent.setup();
    renderWithProviders(<LeadDetailPage />);

    // Wait for the page to load, then click the Tasks tab to mount JobLeadTasksTab
    const tasksTab = await screen.findByRole('tab', { name: /^Tasks$/ });
    await user.click(tasksTab);

    await waitFor(() => {
      expect(capturedLeadEntity).not.toBeNull();
    });
    // useParams returns id: 'e0000000-0000-0000-0000-000000000001'
    expect(capturedLeadEntity!.id).toBe('e0000000-0000-0000-0000-000000000001');
    expect(capturedLeadEntity!.type).toBe('LEAD');
  });
});

// #238 — action buttons gate on CASL ability, NOT the auth-store role. The auth
// store is mocked to ADMIN globally (setup.ts); these tests pass a narrower
// ability and prove the buttons follow it, independent of that role.
describe('LeadDetailPage — action buttons gate on ability not role (#238)', () => {
  // A SALES-shaped ability: can edit/mark-lost a lead and create estimates, but
  // CANNOT assign (no `assign Lead` grant for Sales).
  const salesAbility = buildAbility([
    { action: 'read', subject: 'Lead' },
    { action: 'update', subject: 'Lead' },
    { action: 'mark_lost', subject: 'Lead' },
    { action: 'create', subject: 'Estimate' },
  ]);

  it('shows Edit (update Lead) but hides Assign when ability lacks assign Lead', async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    renderWithProviders(<LeadDetailPage />, { ability: salesAbility });

    await openLeadActions(user);
    expect(screen.getByText('Edit')).toBeInTheDocument();
    // Create Estimate is granted; Assign is not.
    expect(screen.getByText('Create Estimate')).toBeInTheDocument();
    expect(screen.queryByText('Assign')).toBeNull();
  });

  it('hides all editor actions for a read-only ability (despite ADMIN auth role)', async () => {
    const readOnly = buildAbility([{ action: 'read', subject: 'Lead' }]);
    renderWithProviders(<LeadDetailPage />, { ability: readOnly });

    // Page still renders the lead, but no Edit/Assign/Create Estimate buttons.
    await waitFor(() => {
      expect(screen.getAllByText(/Lead from John Doe/).length).toBeGreaterThan(0);
    });
    expect(screen.queryByText('Edit')).toBeNull();
    expect(screen.queryByText('Assign')).toBeNull();
    expect(screen.queryByText('Create Estimate')).toBeNull();
  });
});

// #238 follow-up - the "Mark Lost" (mark_lost Lead) action split off the old
// `canEdit`/`update Lead` gate onto its own capability. LEAD_FIXTURE.status is NEW
// (not terminal), so the button is status-eligible - visibility therefore turns
// purely on the ability. These lock the split gate from both sides; previously
// only the granted side was implied.
//
// Walkthrough-as-entity redesign, PR-C2: this block used to also cover "Mark
// Contacted" (contact Lead) - D6 removed that menu item and its ContactLeadDialog
// entirely (contacted_at is now inferred from outbound activity, never set by
// hand), so there is no longer a button here to gate.
describe('LeadDetailPage - mark_lost gates on its own capability (#238)', () => {
  it('shows Mark Lost when the ability grants mark_lost Lead', async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    const ability = buildAbility([
      { action: 'read', subject: 'Lead' },
      { action: 'mark_lost', subject: 'Lead' },
    ]);
    renderWithProviders(<LeadDetailPage />, { ability });

    await openLeadActions(user);
    expect(screen.getByText('Mark Lost')).toBeInTheDocument();
  });

  it('hides Mark Lost when the ability lacks mark_lost Lead', async () => {
    // Holds update Lead (so the page is clearly in "editor" mode and Edit shows),
    // but NOT mark_lost - proving the button no longer rides canEdit.
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    const ability = buildAbility([
      { action: 'read', subject: 'Lead' },
      { action: 'update', subject: 'Lead' },
    ]);
    renderWithProviders(<LeadDetailPage />, { ability });

    // Edit (update Lead) renders, confirming the action surface is mounted...
    await openLeadActions(user);
    expect(screen.getByText('Edit')).toBeInTheDocument();
    // ...but the capability-split action is absent.
    expect(screen.queryByText('Mark Lost')).toBeNull();
  });
});

// Phase B (strict technician) — the Walkthrough recording + completion controls
// (Notes editor, Save Notes, Complete Walkthrough) gate on `perform_walkthrough
// Lead`, NOT `update Lead`. A strict TECHNICIAN was re-scoped to hold
// `perform_walkthrough` (OWN_WALKTHROUGH) but NOT `update Lead`; the backend routes
// POST /:id/walkthrough + /walkthrough/complete already enforce `perform_walkthrough`.
// Before this fix the UI rode `canEdit` (`update Lead`), so a strict tech could not
// record/complete their own walkthrough from the UI even though the API allowed it.
describe('LeadDetailPage — walkthrough recording gates on perform_walkthrough not update (Phase B)', () => {
  // Drive WalkthroughTabContent into its SCHEDULED branch so the Notes editor +
  // Complete Walkthrough button render. A scheduled lead with no completed_at.
  function mockScheduledWalkthroughLead() {
    mockApi.get.mockImplementation(async (url: string) => {
      if (url.includes('/notes')) return { data: { notes: NOTES_FIXTURE } };
      if (url.includes('/api/leads/')) {
        return {
          data: {
            lead: {
              ...LEAD_FIXTURE,
              status: 'CONTACTED',
              walkthrough_scheduled_at: '2026-03-01T15:00:00.000Z',
              walkthrough_duration_minutes: 60,
              walkthrough_completed_at: null,
              walkthrough_notes: null,
              walkthrough_performers: [
                { user: { id: '00000000-0000-0000-0000-000000000004', first_name: 'Test', last_name: 'Tech' } },
              ],
            },
          },
        };
      }
      if (url.includes('/api/tags')) return { data: { tags: [] } };
      return { data: {} };
    });
  }

  // Strict technician: can read the lead + perform (record/complete) its
  // walkthrough, but CANNOT update the lead or schedule a walkthrough.
  const technicianAbility = buildAbility([
    { action: 'read', subject: 'Lead' },
    { action: 'perform_walkthrough', subject: 'Lead' },
  ]);

  it('lets a technician (perform_walkthrough, no update) open the Walkthrough tab and use record + complete controls', async () => {
    const user = userEvent.setup();
    mockScheduledWalkthroughLead();
    renderWithProviders(<LeadDetailPage />, { ability: technicianAbility });

    // The page renders for a read-only-ish lead ability...
    await waitFor(() => {
      expect(screen.getAllByText(/Lead from John Doe/).length).toBeGreaterThan(0);
    });
    // ...and the Walkthrough tab is reachable (not gated on update Lead).
    const walkthroughTab = screen.getByRole('tab', { name: /Walkthrough/ });
    await user.click(walkthroughTab);

    // Complete Walkthrough button is shown (perform_walkthrough), even though the
    // tech lacks `update Lead`.
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /Complete Walkthrough/ })).toBeInTheDocument();
    });

    // The Notes editor is enabled, and typing a note reveals the Save Notes button.
    const notes = screen.getByPlaceholderText('Walkthrough notes...');
    expect(notes).not.toBeDisabled();
    await user.type(notes, 'Unit is on the roof; access via south stairwell.');
    expect(await screen.findByRole('button', { name: /Save Notes/ })).toBeInTheDocument();
  });

  it('hides record + complete controls for a user with neither update nor perform_walkthrough', async () => {
    const user = userEvent.setup();
    mockScheduledWalkthroughLead();
    // read-only: can see the lead/tab, but cannot record or complete.
    const readOnly = buildAbility([{ action: 'read', subject: 'Lead' }]);
    renderWithProviders(<LeadDetailPage />, { ability: readOnly });

    await waitFor(() => {
      expect(screen.getAllByText(/Lead from John Doe/).length).toBeGreaterThan(0);
    });
    const walkthroughTab = screen.getByRole('tab', { name: /Walkthrough/ });
    await user.click(walkthroughTab);

    // The Notes editor renders read-only and the Complete button is absent.
    await waitFor(() => {
      expect(screen.getByPlaceholderText('Walkthrough notes...')).toBeDisabled();
    });
    expect(screen.queryByRole('button', { name: /Complete Walkthrough/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /Save Notes/ })).toBeNull();
  });
});

// ─── ?tab=walkthrough deep link (Leads-list schedule action, #445) ───────────

// Probe that reports the current location so the param-strip can be asserted.
function LocationProbe() {
  const location = useLocation();
  return <div data-testid="location-probe">{location.pathname + location.search}</div>;
}

describe('LeadDetailPage — ?tab=walkthrough deep link', () => {
  it('activates the Walkthrough tab and strips the param (replace)', async () => {
    renderWithProviders(
      <>
        <LeadDetailPage />
        <LocationProbe />
      </>,
      {
        ability: adminAbility,
        initialEntries: ['/leads/e0000000-0000-0000-0000-000000000001?tab=walkthrough'],
      }
    );

    // Walkthrough tab becomes the active one (not the default Overview).
    await waitFor(() => {
      expect(screen.getByRole('tab', { name: /Walkthrough/ })).toHaveAttribute(
        'aria-selected',
        'true'
      );
    });
    expect(screen.getByRole('tab', { name: /Overview/ })).toHaveAttribute(
      'aria-selected',
      'false'
    );

    // The param is stripped (replace: true) so refresh/back won't re-trigger.
    await waitFor(() => {
      expect(screen.getByTestId('location-probe').textContent).not.toContain('tab=walkthrough');
    });
  });

  it('ignores a non-whitelisted ?tab= value', async () => {
    renderWithProviders(<LeadDetailPage />, {
      ability: adminAbility,
      initialEntries: ['/leads/e0000000-0000-0000-0000-000000000001?tab=bogus'],
    });

    await waitFor(() => {
      expect(screen.getAllByText(/Lead from John Doe/).length).toBeGreaterThan(0);
    });
    // Overview stays active; the bogus value selects nothing.
    expect(screen.getByRole('tab', { name: /Overview/ })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('tab', { name: /Walkthrough/ })).toHaveAttribute(
      'aria-selected',
      'false'
    );
  });
});

// SRVW-111 (label-override shape) - the status dropdown resolves an org's rename/hide of
// LeadStatus display via useLeadStatusOverrides(), never the enum value itself.
describe('LeadDetailPage - status dropdown resolves org label overrides (SRVW-111)', () => {
  function mockLeadWithOverrides(overrides: Array<{ status: string; label: string | null; sort_order: number; is_default: boolean; hidden: boolean }>) {
    mockApi.get.mockImplementation(async (url: string) => {
      if (url.includes('/notes')) return { data: { notes: NOTES_FIXTURE } };
      if (url.includes('/api/lead-status-overrides')) return { data: { lead_status_overrides: overrides } };
      if (url.includes('/api/users')) return { data: { users: [] } };
      if (url.includes('/api/leads/')) return { data: { lead: LEAD_FIXTURE } };
      if (url.includes('/api/tags')) return { data: { tags: [] } };
      return { data: {} };
    });
  }

  it('renders the org-renamed label on the trigger and in the dropdown list, not the enum default', async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    mockLeadWithOverrides([
      { status: 'NEW', label: 'Fresh Lead', sort_order: 0, is_default: true, hidden: false },
      { status: 'CONTACTED', label: null, sort_order: 1, is_default: false, hidden: false },
      { status: 'ESTIMATED', label: null, sort_order: 2, is_default: false, hidden: false },
      { status: 'WON', label: null, sort_order: 3, is_default: false, hidden: false },
      { status: 'LOST', label: null, sort_order: 4, is_default: false, hidden: false },
      { status: 'CANCELLED', label: null, sort_order: 5, is_default: false, hidden: false },
    ]);
    renderWithProviders(<LeadDetailPage />, { ability: adminAbility });

    // Trigger button - LEAD_FIXTURE.status is 'NEW'.
    expect(await screen.findByText('Fresh Lead')).toBeInTheDocument();
    expect(screen.queryByText('New')).not.toBeInTheDocument();

    await user.click(screen.getByText('Fresh Lead').closest('button')!);
    expect(screen.getAllByText('Fresh Lead').length).toBeGreaterThan(1); // trigger + list item
  });

  it('excludes a hidden status from the dropdown list, but keeps a hidden CURRENT status selectable', async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    mockLeadWithOverrides([
      { status: 'NEW', label: null, sort_order: 0, is_default: true, hidden: true },
      { status: 'CONTACTED', label: null, sort_order: 1, is_default: false, hidden: false },
      { status: 'ESTIMATED', label: null, sort_order: 2, is_default: false, hidden: false },
      { status: 'WON', label: null, sort_order: 3, is_default: false, hidden: false },
      { status: 'LOST', label: null, sort_order: 4, is_default: false, hidden: false },
      { status: 'CANCELLED', label: null, sort_order: 5, is_default: false, hidden: false },
    ]);
    renderWithProviders(<LeadDetailPage />, { ability: adminAbility });

    // LEAD_FIXTURE.status is 'NEW', which is hidden here - the trigger still shows it.
    const trigger = await screen.findByText('New');
    await user.click(trigger.closest('button')!);

    // 'New' still appears (trigger + its own list row, since the current status is exempt).
    expect(screen.getAllByText('New').length).toBe(2);
  });
});
