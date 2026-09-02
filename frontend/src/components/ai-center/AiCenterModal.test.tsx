import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { AiCenterModal } from './AiCenterModal';
import { AgentDetailModal } from './AgentDetailModal';
import { AI_AGENTS } from '@/lib/ai-center/agents';
import { useAiCenterStore } from '@/stores/aiCenterStore';
import {
  useSpiderWatcherStore,
  resolveLeadStageAndElapsedTime,
  formatLeadServiceLocation,
  formatAddressParts,
  buildWatcherCustomersFromLive,
  resolveSpiderAlertRecipients,
  type WatcherCustomer,
} from '@/stores/spiderWatcherStore';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

const mockNavigate = vi.fn();
vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual('react-router-dom');
  return {
    ...actual,
    useNavigate: () => mockNavigate,
  };
});

const mockUseOrganization = vi.fn();
vi.mock('@/lib/api/organization', () => ({
  useOrganization: () => mockUseOrganization(),
}));

const queryClient = new QueryClient();

const TEST_CUSTOMERS: WatcherCustomer[] = [
  {
    id: 'c1',
    name: 'John Smith',
    company: 'Apex Plumbing Co.',
    email: 'john@apexplumbing.com',
    phone: '+1 (555) 234-5678',
    leads: [
      {
        id: 'l1',
        leadNumber: 'LD-101',
        serviceRequest: 'Main Line Leak & Pipe Replacement',
        serviceLocation: '9462 Highland Ave, Suite 414 Paterson, NJ 07501',
        stageId: 'new-contacted',
        stageLabel: 'New → Contacted',
        elapsedValue: 4,
        elapsedUnit: 'Day',
        elapsedSeconds: 4 * 86400,
      },
      {
        id: 'l2',
        leadNumber: 'LD-102',
        serviceRequest: 'Commercial Water Heater Installation',
        serviceLocation: '1048 Industrial Pkwy, Suite 300 Portland, OR 97201',
        stageId: 'contacted-walkthrough-scheduled',
        stageLabel: 'Contacted → Walkthrough Scheduled',
        elapsedValue: 6,
        elapsedUnit: 'Day',
        elapsedSeconds: 6 * 86400,
        contactedAt: new Date(Date.now() - 6 * 24 * 3600 * 1000).toISOString(),
      },
    ],
  },
];

function renderAiCenter() {
  useAiCenterStore.setState({ open: true });
  return render(
    <QueryClientProvider client={queryClient}>
      <AiCenterModal />
    </QueryClientProvider>
  );
}

function renderSpiderDetail() {
  const agent = AI_AGENTS.find((a) => a.id === 'spider')!;
  return render(
    <QueryClientProvider client={queryClient}>
      <AgentDetailModal
        agent={agent}
        onOpenChange={() => {}}
        onBook={() => {}}
      />
    </QueryClientProvider>
  );
}

describe('AiCenterModal', () => {
  beforeEach(() => {
    mockNavigate.mockReset();
    mockUseOrganization.mockReturnValue({
      data: { is_demo: false },
    });
    useAiCenterStore.setState({ open: true, focusAgentId: null });
    useSpiderWatcherStore.setState({
      notifications: {
        email: true,
        sms: true,
        inApp: true,
        redFrame: true,
      },
      days: '',
      leadStages: [
        {
          id: 'new-contacted',
          label: 'New → Contacted',
          fromStage: 'New',
          toStage: 'Contacted',
          duration: undefined,
          unit: 'Second',
        },
        {
          id: 'contacted-walkthrough-scheduled',
          label: 'Contacted → Walkthrough Scheduled',
          fromStage: 'Contacted',
          toStage: 'Walkthrough Scheduled',
          duration: undefined,
          unit: 'Second',
        },
        {
          id: 'walkthrough-scheduled-estimate',
          label: 'Walkthrough Scheduled → Estimate',
          fromStage: 'Walkthrough Scheduled',
          toStage: 'Estimate',
          duration: undefined,
          unit: 'Second',
        },
      ],
      customers: TEST_CUSTOMERS,
      selectedCustomerIds: ['c1'],
      selectedLeadIds: ['l1', 'l2'],
      hasUserModifiedSelection: false,
    });
  });

  it('renders the dialog for a real (non-demo) org', () => {
    renderAiCenter();
    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });

  it('renders the dialog for a demo org', () => {
    mockUseOrganization.mockReturnValue({
      data: { is_demo: true },
    });
    renderAiCenter();
    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });

  it('does not present unbuilt agents as live', () => {
    renderAiCenter();
    expect(screen.getAllByText('Coming soon').length).toBeGreaterThan(0);
  });

  it('renders custom Watcher configuration UI for Spider agent with Lead Stages and multi-lead Contact Watchers', () => {
    renderSpiderDetail();

    // 0. Notifications section with Email, SMS, In-app Message, and Red Frame
    expect(screen.getByText('Notifications')).toBeInTheDocument();
    expect(screen.getByText('Email')).toBeInTheDocument();
    expect(screen.getByText('SMS')).toBeInTheDocument();
    expect(screen.getByText('In-app Message')).toBeInTheDocument();
    expect(screen.getByText('Red Frame')).toBeInTheDocument();

    // Footer buttons: Book a call about Spider and Save button
    expect(screen.getByRole('button', { name: /Book a call about Spider/i })).toBeInTheDocument();
    const saveBtn = screen.getByRole('button', { name: /Save/i });
    expect(saveBtn).toBeInTheDocument();

    // Toggling Red Frame in UI modifies draft, but does NOT update store until Save is clicked
    expect(useSpiderWatcherStore.getState().notifications.redFrame).toBe(true);
    const redFrameOption = screen.getByText('Red Frame').closest('div[class*="cursor-pointer"]');
    expect(redFrameOption).not.toBeNull();
    fireEvent.click(redFrameOption!);
    // Store remains unchanged before saving
    expect(useSpiderWatcherStore.getState().notifications.redFrame).toBe(true);

    // 1. Lead Stages section with 3 stages and default blank duration
    expect(screen.getByText('Distance')).toBeInTheDocument();
    expect(screen.getByText('New → Contacted')).toBeInTheDocument();
    expect(screen.getByText('Contacted → Walkthrough Scheduled')).toBeInTheDocument();
    expect(screen.getByText('Walkthrough Scheduled → Estimate')).toBeInTheDocument();

    const stages = useSpiderWatcherStore.getState().leadStages;
    expect(stages.length).toBe(3);
    expect(stages.every((s) => s.duration === undefined && s.unit === 'Second')).toBe(true);

    // Parallel time period & units inputs exist and default to blank
    const unitSelects = screen.getAllByLabelText(/^Time unit for/i);
    expect(unitSelects.length).toBe(3);
    const durationInputs = screen.getAllByLabelText(/^Time period for/i);
    expect(durationInputs.length).toBe(3);
    expect(durationInputs[0]!.getAttribute('value') || '').toBe('');

    // Stepper + / - buttons exist
    const incButtons = screen.getAllByLabelText(/^Increment time period for/i);
    expect(incButtons.length).toBe(3);
    const decButtons = screen.getAllByLabelText(/^Decrement time period for/i);
    expect(decButtons.length).toBe(3);

    // Decrement button is disabled when blank/<1
    expect(decButtons[0]!).toBeDisabled();

    // Clicking increment button increments draft value to 1 and enables decrement button
    fireEvent.click(incButtons[0]!);
    expect(durationInputs[0]!.getAttribute('value')).toBe('1');
    expect(decButtons[0]!).not.toBeDisabled();

    // Changing stage time period to 7 in draft
    fireEvent.change(durationInputs[0]!, { target: { value: '7' } });
    expect(durationInputs[0]!.getAttribute('value')).toBe('7');

    // Before clicking Save, store still has undefined duration and redFrame: true
    expect(useSpiderWatcherStore.getState().leadStages[0]!.duration).toBeUndefined();
    expect(useSpiderWatcherStore.getState().notifications.redFrame).toBe(true);

    // Clicking Save in footer applies all draft changes to the store
    fireEvent.click(saveBtn);
    expect(screen.getByText('Saved')).toBeInTheDocument();
    expect(useSpiderWatcherStore.getState().leadStages[0]!.duration).toBe(7);
    expect(useSpiderWatcherStore.getState().notifications.redFrame).toBe(false);

    // 2. Contact Watchers with Multi-Lead Dropdowns
    expect(screen.getByText('John Smith')).toBeInTheDocument();
    expect(screen.getByText(/Apex Plumbing Co/i)).toBeInTheDocument();

    // Dropdown is NOT open on hover
    const customerCard = screen.getByText('John Smith').closest('div[class*="rounded-lg border"]');
    expect(customerCard).not.toBeNull();
    fireEvent.mouseEnter(customerCard!);
    expect(screen.queryByText('Leads for John Smith')).toBeNull();

    // Click dropdown button to open dropdown of leads
    const dropdownBtn = screen.getByLabelText(/Toggle leads for John Smith/i);
    expect(dropdownBtn).toBeInTheDocument();
    fireEvent.click(dropdownBtn);

    // Dropdown shows customer's multiple leads
    expect(screen.getByText('Leads for John Smith')).toBeInTheDocument();
    expect(screen.getByText('LD-101')).toBeInTheDocument();
    // Complete address with suite, city, state, zip is displayed
    expect(screen.getByText('9462 Highland Ave, Suite 414 Paterson, NJ 07501')).toBeInTheDocument();
    expect(screen.queryByText('Main Line Leak & Pipe Replacement')).toBeNull();
    expect(screen.getByText('LD-102')).toBeInTheDocument();
    expect(screen.getByText('1048 Industrial Pkwy, Suite 300 Portland, OR 97201')).toBeInTheDocument();

    // Stage elapsed time is rendered between Lead ID and Stage
    expect(screen.getByText('4 Days in stage')).toBeInTheDocument();
    expect(screen.getByText('6 Days in stage')).toBeInTheDocument();

    // Last Communication Time is rendered before threshold value for Contacted lead
    expect(screen.getByText(/Last Comm:\s*6 Days ago/i)).toBeInTheDocument();

    // With blank stage threshold (default), displays 'none threshold set'
    expect(screen.getAllByText('none threshold set').length).toBeGreaterThan(0);

    // Select/deselect customer and specific lead
    const leadCheckbox = screen.getByLabelText(/Select lead LD-101 for notifications/i);
    expect(leadCheckbox).toBeInTheDocument();

    // Lead stage badge in Contact Watcher displays single stage ("New", "Contacted", "Walkthrough")
    expect(screen.getAllByText('New').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Contacted').length).toBeGreaterThan(0);

    // Clicking a lead redirects to Lead Overview
    const leadLink = screen.getByRole('button', { name: /Open Lead Overview for LD-101/i });
    expect(leadLink).toBeInTheDocument();
    fireEvent.click(leadLink);
    expect(mockNavigate).toHaveBeenCalledWith('/leads/l1');
  });

  it('redirects to Lead Overview when clicking on lead service location in Contact Watcher', () => {
    renderSpiderDetail();

    // Expand customer
    const dropdownBtn = screen.getByLabelText(/Toggle leads for John Smith/i);
    fireEvent.click(dropdownBtn);

    // Click service location
    const locationEl = screen.getByText('9462 Highland Ave, Suite 414 Paterson, NJ 07501');
    fireEvent.click(locationEl);

    expect(mockNavigate).toHaveBeenCalledWith('/leads/l1');
    expect(useAiCenterStore.getState().open).toBe(false);
  });

  it('calculates real lead stage and actual elapsed time accurately', () => {
    const now = Date.now();

    // Stage 1: New -> Contacted
    const newLead = {
      id: 'lead-1',
      created_at: new Date(now - 15 * 60 * 1000).toISOString(), // 15 mins ago
      status: 'NEW',
    };
    const s1 = resolveLeadStageAndElapsedTime(newLead);
    expect(s1.stageId).toBe('new-contacted');
    expect(s1.stageLabel).toBe('New → Contacted');
    expect(s1.elapsedUnit).toBe('Minute');
    expect(s1.elapsedValue).toBe(15);

    // Stage 2: Contacted -> Walkthrough Scheduled
    const contactedLead = {
      id: 'lead-2',
      created_at: new Date(now - 2 * 24 * 3600 * 1000).toISOString(),
      contacted_at: new Date(now - 3 * 3600 * 1000).toISOString(), // 3 hours ago
      status: 'CONTACTED',
    };
    const s2 = resolveLeadStageAndElapsedTime(contactedLead);
    expect(s2.stageId).toBe('contacted-walkthrough-scheduled');
    expect(s2.stageLabel).toBe('Contacted → Walkthrough Scheduled');
    expect(s2.elapsedUnit).toBe('Hour');
    expect(s2.elapsedValue).toBe(3);

    // Stage 3: Walkthrough Scheduled -> Estimate
    const scheduledLead = {
      id: 'lead-3',
      created_at: new Date(now - 5 * 24 * 3600 * 1000).toISOString(),
      contacted_at: new Date(now - 4 * 24 * 3600 * 1000).toISOString(),
      walkthrough_scheduled_at: new Date(now - 45 * 1000).toISOString(), // 45 seconds ago
    };
    const s3 = resolveLeadStageAndElapsedTime(scheduledLead);
    expect(s3.stageId).toBe('walkthrough-scheduled-estimate');
    expect(s3.stageLabel).toBe('Walkthrough Scheduled → Estimate');
    expect(s3.elapsedUnit).toBe('Second');
    expect(s3.elapsedValue).toBe(45);

    // Also handles estimated / completed status
    const completedLead = {
      id: 'lead-4',
      created_at: new Date(now - 7 * 24 * 3600 * 1000).toISOString(),
      walkthrough_completed_at: new Date(now - 2 * 24 * 3600 * 1000).toISOString(), // 2 days ago
    };
    const s4 = resolveLeadStageAndElapsedTime(completedLead);
    expect(s4.stageId).toBe('walkthrough-scheduled-estimate');
    expect(s4.stageLabel).toBe('Walkthrough Scheduled → Estimate');
    expect(s4.elapsedUnit).toBe('Day');
    expect(s4.elapsedValue).toBe(2);
  });

  it('selects all customers and all leads by default in Spider Contact Watchers', () => {
    useSpiderWatcherStore.setState({
      customers: [],
      selectedCustomerIds: [],
      selectedLeadIds: [],
      leadStages: [
        {
          id: 'new-contacted',
          label: 'New → Contacted',
          fromStage: 'New',
          toStage: 'Contacted',
          duration: 0,
          unit: 'Second',
        },
        {
          id: 'contacted-walkthrough-scheduled',
          label: 'Contacted → Walkthrough Scheduled',
          fromStage: 'Contacted',
          toStage: 'Walkthrough Scheduled',
          duration: 0,
          unit: 'Second',
        },
      ],
      hasUserModifiedSelection: false,
    });

    useSpiderWatcherStore.getState().setCustomers(TEST_CUSTOMERS);

    const state = useSpiderWatcherStore.getState();
    expect(state.selectedCustomerIds).toEqual(['c1']);
    expect(state.selectedLeadIds).toEqual(['l1', 'l2']);

    // Computed notifications evaluate all selected leads as triggered by default (0s threshold)
    const notifs = state.getComputedNotifications();
    expect(notifs.length).toBe(2);
    expect(notifs.map((n) => n.leadId)).toEqual(['l1', 'l2']);
  });

  it('selects nested leads when customers load before leads arrive asynchronously', () => {
    useSpiderWatcherStore.setState({
      customers: [],
      selectedCustomerIds: [],
      selectedLeadIds: [],
      leadStages: [
        {
          id: 'new-contacted',
          label: 'New → Contacted',
          fromStage: 'New',
          toStage: 'Contacted',
          duration: 0,
          unit: 'Second',
        },
        {
          id: 'contacted-walkthrough-scheduled',
          label: 'Contacted → Walkthrough Scheduled',
          fromStage: 'Contacted',
          toStage: 'Walkthrough Scheduled',
          duration: 0,
          unit: 'Second',
        },
      ],
      hasUserModifiedSelection: false,
    });

    // Step 1: Customers API returns first without leads
    const customersWithoutLeads: WatcherCustomer[] = [
      {
        id: 'c1',
        name: 'John Smith',
        company: 'Apex Plumbing Co.',
        email: 'john@apexplumbing.com',
        leads: [],
      },
    ];
    useSpiderWatcherStore.getState().setCustomers(customersWithoutLeads);
    expect(useSpiderWatcherStore.getState().selectedCustomerIds).toEqual(['c1']);
    expect(useSpiderWatcherStore.getState().selectedLeadIds).toEqual([]);

    // Step 2: Leads API returns shortly after
    useSpiderWatcherStore.getState().setCustomers(TEST_CUSTOMERS);
    const state = useSpiderWatcherStore.getState();
    expect(state.selectedCustomerIds).toEqual(['c1']);
    expect(state.selectedLeadIds).toEqual(['l1', 'l2']);
    expect(state.getComputedNotifications().length).toBe(2);
  });

  it('allows toggling customer and lead selections and supports select/deselect all', () => {
    useSpiderWatcherStore.setState({
      customers: TEST_CUSTOMERS,
      selectedCustomerIds: ['c1'],
      selectedLeadIds: ['l1', 'l2'],
      leadStages: [
        {
          id: 'new-contacted',
          label: 'New → Contacted',
          fromStage: 'New',
          toStage: 'Contacted',
          duration: 0,
          unit: 'Second',
        },
        {
          id: 'contacted-walkthrough-scheduled',
          label: 'Contacted → Walkthrough Scheduled',
          fromStage: 'Contacted',
          toStage: 'Walkthrough Scheduled',
          duration: 0,
          unit: 'Second',
        },
      ],
      hasUserModifiedSelection: false,
    });

    // Deselect customer c1
    useSpiderWatcherStore.getState().toggleCustomerSelection('c1', ['l1', 'l2']);
    let state = useSpiderWatcherStore.getState();
    expect(state.selectedCustomerIds).toEqual([]);
    expect(state.selectedLeadIds).toEqual([]);
    expect(state.getComputedNotifications().length).toBe(0);

    // Select customer c1 again -> selects both customer and its leads
    useSpiderWatcherStore.getState().toggleCustomerSelection('c1', ['l1', 'l2']);
    state = useSpiderWatcherStore.getState();
    expect(state.selectedCustomerIds).toEqual(['c1']);
    expect(state.selectedLeadIds).toEqual(['l1', 'l2']);

    // Deselect single lead l1
    useSpiderWatcherStore.getState().toggleLeadSelection('l1', 'c1', ['l1', 'l2']);
    state = useSpiderWatcherStore.getState();
    expect(state.selectedCustomerIds).toEqual(['c1']); // c1 still selected because l2 is selected
    expect(state.selectedLeadIds).toEqual(['l2']);

    // Deselect all
    useSpiderWatcherStore.getState().deselectAllCustomers();
    state = useSpiderWatcherStore.getState();
    expect(state.selectedCustomerIds).toEqual([]);
    expect(state.selectedLeadIds).toEqual([]);

    // Select all
    useSpiderWatcherStore.getState().selectAllCustomers();
    state = useSpiderWatcherStore.getState();
    expect(state.selectedCustomerIds).toEqual(['c1']);
    expect(state.selectedLeadIds).toEqual(['l1', 'l2']);
  });

  it('does not apply selection changes until the user clicks Save', () => {
    useSpiderWatcherStore.setState({
      customers: TEST_CUSTOMERS,
      selectedCustomerIds: ['c1'],
      selectedLeadIds: ['l1', 'l2'],
      hasUserModifiedSelection: false,
    });

    renderSpiderDetail();

    // Click "Deselect all" in modal
    const deselectAllBtn = screen.getByText('Deselect all');
    fireEvent.click(deselectAllBtn);

    // The modal UI now reflects "Select all" (draft was updated)
    expect(screen.getByText('Select all')).toBeInTheDocument();

    // BUT store has NOT changed yet because Save was not clicked
    expect(useSpiderWatcherStore.getState().selectedCustomerIds).toEqual(['c1']);
    expect(useSpiderWatcherStore.getState().selectedLeadIds).toEqual(['l1', 'l2']);

    // Now click the Save button in the footer
    const saveBtn = screen.getByRole('button', { name: /Save/i });
    fireEvent.click(saveBtn);

    // Now store has been updated!
    expect(useSpiderWatcherStore.getState().selectedCustomerIds).toEqual([]);
    expect(useSpiderWatcherStore.getState().selectedLeadIds).toEqual([]);
  });

  it('triggers notification alerts for Contacted stage leads based on the last communication timestamp', () => {
    useSpiderWatcherStore.setState({
      customers: TEST_CUSTOMERS,
      selectedCustomerIds: ['c1'],
      selectedLeadIds: ['l1', 'l2'],
      leadStages: [
        {
          id: 'new-contacted',
          label: 'New → Contacted',
          fromStage: 'New',
          toStage: 'Contacted',
          duration: 10,
          unit: 'Day',
        },
        {
          id: 'contacted-walkthrough-scheduled',
          label: 'Contacted → Walkthrough Scheduled',
          fromStage: 'Contacted',
          toStage: 'Walkthrough Scheduled',
          duration: 5,
          unit: 'Day',
        },
        {
          id: 'walkthrough-scheduled-estimate',
          label: 'Walkthrough Scheduled → Estimate',
          fromStage: 'Walkthrough Scheduled',
          toStage: 'Estimate',
          duration: undefined,
          unit: 'Second',
        },
      ],
      readNotificationIds: [],
    });

    const notifs = useSpiderWatcherStore.getState().getComputedNotifications();
    // LD-102 has 6 days since contacted, exceeding 5 Day threshold -> triggers alert
    expect(notifs.some((n) => n.leadId === 'l2')).toBe(true);

    // LD-101 has 4 days in New stage, below 10 Day threshold -> no alert
    expect(notifs.some((n) => n.leadId === 'l1')).toBe(false);
  });

  it('persists Spider settings to localStorage across reload', () => {
    localStorage.clear();

    useSpiderWatcherStore.setState({
      customers: TEST_CUSTOMERS,
      selectedCustomerIds: ['c1'],
      selectedLeadIds: ['l1', 'l2'],
      hasUserModifiedSelection: false,
    });

    renderSpiderDetail();

    // Change redFrame and stage duration
    const redFrameOption = screen.getByText('Red Frame').closest('div[class*="cursor-pointer"]');
    fireEvent.click(redFrameOption!);

    const durationInputs = screen.getAllByLabelText(/^Time period for/i);
    fireEvent.change(durationInputs[0]!, { target: { value: '14' } });

    // Click Save
    const saveBtn = screen.getByRole('button', { name: /Save/i });
    fireEvent.click(saveBtn);

    // Verify localStorage has persisted settings
    const stored = localStorage.getItem('servwave_spider_watcher_settings');
    expect(stored).not.toBeNull();
    const parsed = JSON.parse(stored!);
    expect(parsed.state.notifications.redFrame).toBe(false);
    expect(parsed.state.leadStages[0].duration).toBe(14);
    expect(parsed.state.hasUserModifiedSelection).toBe(true);
    expect(parsed.state.customers.length).toBeGreaterThan(0);
  });

  it('persists Spider notifications across page refresh so active alerts remain visible', () => {
    localStorage.clear();

    // Setup active overdue lead
    useSpiderWatcherStore.setState({
      customers: TEST_CUSTOMERS,
      selectedCustomerIds: ['c1'],
      selectedLeadIds: ['l1', 'l2'],
      leadStages: [
        {
          id: 'new-contacted',
          label: 'New → Contacted',
          fromStage: 'New',
          toStage: 'Contacted',
          duration: 1,
          unit: 'Day',
        },
        {
          id: 'contacted-walkthrough-scheduled',
          label: 'Contacted → Walkthrough Scheduled',
          fromStage: 'Contacted',
          toStage: 'Walkthrough Scheduled',
          duration: 1,
          unit: 'Day',
        },
        {
          id: 'walkthrough-scheduled-estimate',
          label: 'Walkthrough Scheduled → Estimate',
          fromStage: 'Walkthrough Scheduled',
          toStage: 'Estimate',
          duration: undefined,
          unit: 'Second',
        },
      ],
      notifications: {
        email: true,
        sms: true,
        inApp: true,
        redFrame: true,
      },
      readNotificationIds: [],
      hasUserModifiedSelection: true,
    });

    const activeBeforeReload = useSpiderWatcherStore.getState().getComputedNotifications();
    expect(activeBeforeReload.length).toBeGreaterThan(0);

    // Simulate page refresh by reading persisted state from localStorage and rehydrating
    const persistedRaw = localStorage.getItem('servwave_spider_watcher_settings');
    expect(persistedRaw).not.toBeNull();
    const persistedObj = JSON.parse(persistedRaw!).state;

    // Reset store in memory to simulate fresh app start
    useSpiderWatcherStore.setState({
      customers: [],
      selectedCustomerIds: [],
      selectedLeadIds: [],
      readNotificationIds: [],
    });
    expect(useSpiderWatcherStore.getState().getComputedNotifications()).toEqual([]);

    // Rehydrate from persisted state (as zustand/persist does on reload)
    useSpiderWatcherStore.setState({
      ...persistedObj,
    });

    const activeAfterReload = useSpiderWatcherStore.getState().getComputedNotifications();
    expect(activeAfterReload.length).toBe(activeBeforeReload.length);
    expect(activeAfterReload.map((n) => n.id)).toEqual(activeBeforeReload.map((n) => n.id));
  });

  describe('Service Location Resolution for Customer Leads', () => {
    it('formatAddressParts formats full street address, unit, city, state, zip cleanly', () => {
      expect(
        formatAddressParts('1888 Main St', null, 'Clifton', 'NJ', '07011')
      ).toBe('1888 Main St, Clifton, NJ 07011');

      expect(
        formatAddressParts('9462 Highland Ave', 'Suite 414', 'Paterson', 'NJ', '07501')
      ).toBe('9462 Highland Ave, Suite 414, Paterson, NJ 07501');

      expect(
        formatAddressParts(null, null, 'Clifton', 'NJ', null)
      ).toBe('Clifton, NJ');
    });

    it('formatLeadServiceLocation extracts complete address from service_location relation', () => {
      const lead = {
        id: 'l-test-1',
        service_location: {
          address_line1: '1888 Main St',
          address_line2: null,
          city: 'Clifton',
          state: 'NJ',
          zip: '07011',
        },
      };
      expect(formatLeadServiceLocation(lead)).toBe('1888 Main St, Clifton, NJ 07011');
    });

    it('formatLeadServiceLocation extracts complete address matching customer service_locations', () => {
      const lead = {
        id: 'l-test-2',
        service_location_id: 'loc-primary',
        service_city: 'Clifton',
        service_state: 'NJ',
      };
      const customer = {
        id: 'c-test',
        service_locations: [
          {
            id: 'loc-primary',
            address_line1: '1888 Main St',
            city: 'Clifton',
            state: 'NJ',
            zip: '07011',
            is_primary: true,
          },
        ],
      };
      expect(formatLeadServiceLocation(lead, customer)).toBe('1888 Main St, Clifton, NJ 07011');
    });

    it('buildWatcherCustomersFromLive links live API customers and leads with complete service locations', () => {
      const apiLeads = [
        {
          id: 'lead-87',
          lead_number: 'L00087',
          customer_id: 'cust-12',
          service_request: 'Automatic slide gate stuck halfway, motor humming',
          service_location_id: 'loc-1',
          created_at: new Date(Date.now() - 20 * 86400 * 1000).toISOString(),
          status: 'CONTACTED',
          contacted_at: new Date(Date.now() - 20 * 86400 * 1000).toISOString(),
        },
      ];

      const apiCustomers = [
        {
          id: 'cust-12',
          first_name: 'Steven',
          last_name: 'Nguyen',
          email: 'steven.nguyen@example.com',
          phone: '+15552012571',
          service_locations: [
            {
              id: 'loc-1',
              address_line1: '1888 Main St',
              city: 'Clifton',
              state: 'NJ',
              zip: '07011',
              is_primary: true,
            },
          ],
        },
      ];

      const customers = buildWatcherCustomersFromLive(apiLeads, apiCustomers);
      expect(customers).toHaveLength(1);
      expect(customers[0].name).toBe('Steven Nguyen');
      expect(customers[0].leads).toHaveLength(1);
      expect(customers[0].leads[0].serviceLocation).toBe('1888 Main St, Clifton, NJ 07011');
    });

    it('renders complete service location in Spider Contact Watchers dropdown', () => {
      const customersWithFullAddress: WatcherCustomer[] = [
        {
          id: 'c-steven',
          name: 'Steven Nguyen',
          email: 'steven.nguyen@example.com',
          service_locations: [
            {
              id: 'loc-1',
              address_line1: '1888 Main St',
              city: 'Clifton',
              state: 'NJ',
              zip: '07011',
              is_primary: true,
            },
          ],
          leads: [
            {
              id: 'l-87',
              leadNumber: 'L00087',
              serviceRequest: 'Automatic slide gate stuck halfway, motor humming',
              serviceLocation: '1888 Main St, Clifton, NJ 07011',
              stageId: 'contacted-walkthrough-scheduled',
              stageLabel: 'Contacted → Walkthrough Scheduled',
              elapsedValue: 20,
              elapsedUnit: 'Day',
              elapsedSeconds: 20 * 86400,
            },
          ],
        },
      ];

      useSpiderWatcherStore.setState({
        customers: customersWithFullAddress,
        selectedCustomerIds: ['c-steven'],
        selectedLeadIds: ['l-87'],
      });

      renderSpiderDetail();

      // Expand Steven Nguyen's lead dropdown
      const stevenRow = screen.getByText('Steven Nguyen').closest('div[class*="rounded-lg"]');
      const expandBtn = stevenRow!.querySelector('button[aria-label="Toggle leads for Steven Nguyen"]');
      fireEvent.click(expandBtn!);

      // Complete service location is visible
      expect(screen.getByText('1888 Main St, Clifton, NJ 07011')).toBeInTheDocument();
      expect(screen.getByTitle('1888 Main St, Clifton, NJ 07011')).toBeInTheDocument();
    });
  });

  describe('Spider Watcher Assignment Section', () => {
    it('renders the Assignment section with Admin role, Owner, and User categories', () => {
      renderSpiderDetail();

      expect(screen.getByText('Assignment')).toBeInTheDocument();
      expect(
        screen.getByText('Assign watcher alerts to specific roles and team members')
      ).toBeInTheDocument();

      expect(screen.getByText('Admin role')).toBeInTheDocument();
      expect(screen.getByText('Owner')).toBeInTheDocument();
      expect(screen.getByText('User')).toBeInTheDocument();
    });

    it('expands Admin role to show 4 roles from Settings > Roles & Permissions', () => {
      renderSpiderDetail();

      // Initially collapsed
      expect(screen.queryByText('Administrator (Owner)')).toBeNull();
      expect(screen.queryByText('Dispatcher')).toBeNull();

      // Expand Admin role
      const toggleAdmin = screen.getByLabelText(/Toggle Admin role options/i);
      fireEvent.click(toggleAdmin);
      expect(screen.getByText('Administrator (Owner)')).toBeInTheDocument();
      expect(screen.getByText('Sales')).toBeInTheDocument();
      expect(screen.getByText('Dispatcher')).toBeInTheDocument();
      expect(screen.getByText('Technician')).toBeInTheDocument();
    });

    it('renders Owner as a direct toggle without nested sub-options', () => {
      renderSpiderDetail();

      const ownerCheckbox = screen.getByLabelText(/Notify Lead Owner/i);
      expect(ownerCheckbox).toBeInTheDocument();
      expect(screen.getByText('Enabled')).toBeInTheDocument();

      // No dropdown chevron for Owner
      expect(screen.queryByLabelText(/Toggle Owner options/i)).toBeNull();

      // Click Owner toggle
      fireEvent.click(ownerCheckbox);
      expect(screen.getByText('Disabled')).toBeInTheDocument();
    });

    it('dynamically filters User list based on selected Admin roles', () => {
      renderSpiderDetail();

      // Expand Admin role and User
      const toggleAdmin = screen.getByLabelText(/Toggle Admin role options/i);
      fireEvent.click(toggleAdmin);
      const toggleUser = screen.getByLabelText(/Toggle User options/i);
      fireEvent.click(toggleUser);

      // Initially all 4 roles are selected, so all users appear
      expect(screen.getByText('Alex Morgan')).toBeInTheDocument();
      expect(screen.getByText('Michael Scott')).toBeInTheDocument();
      expect(screen.getByText('Dwight Schrute')).toBeInTheDocument();

      // Uncheck all Admin roles by clicking parent Admin role checkbox
      const adminRoleSelectAll = screen.getByLabelText(/Select all Admin roles/i);
      fireEvent.click(adminRoleSelectAll);

      // User list now has 0 matching users
      expect(screen.getByText(/No users match the selected Admin roles/i)).toBeInTheDocument();
      expect(screen.queryByText('Alex Morgan')).toBeNull();
      expect(screen.queryByText('Michael Scott')).toBeNull();

      // Select ONLY 'Sales' role in Admin role
      const salesRoleCheckbox = screen.getByLabelText(/^Sales$/i);
      fireEvent.click(salesRoleCheckbox);

      // Now only Sales users appear in the User list and they are ALL selected by default (2/2 selected)
      expect(screen.getByText('Michael Scott')).toBeInTheDocument();
      expect(screen.getByText('Jim Halpert')).toBeInTheDocument();
      expect(screen.getByText('2/2 selected')).toBeInTheDocument();
      expect(screen.queryByText('Alex Morgan')).toBeNull();
      expect(screen.queryByText('Dwight Schrute')).toBeNull();
    });

    it('toggles assignments and saves to store', () => {
      renderSpiderDetail();

      // Expand Admin role and User
      const toggleAdmin = screen.getByLabelText(/Toggle Admin role options/i);
      fireEvent.click(toggleAdmin);
      const toggleUser = screen.getByLabelText(/Toggle User options/i);
      fireEvent.click(toggleUser);

      // Deselect Dwight Schrute
      const dwightRow = screen.getByText('Dwight Schrute').closest('div[class*="cursor-pointer"]');
      expect(dwightRow).not.toBeNull();
      fireEvent.click(dwightRow!);

      // Toggle Owner
      const ownerCheckbox = screen.getByLabelText(/Notify Lead Owner/i);
      fireEvent.click(ownerCheckbox);

      // Save changes
      const saveBtn = screen.getByRole('button', { name: /Save/i });
      fireEvent.click(saveBtn);

      const savedAssignments = useSpiderWatcherStore.getState().assignments;
      expect(savedAssignments.owner).toBe(false);
      expect(savedAssignments.users).not.toContain('u-tech-1');
      expect(savedAssignments.users).toContain('u-admin-1');
    });

    it('resolves alert recipients according to Assignment configuration rules', () => {
      const mockLead = {
        id: 'l101',
        assigned_to: 'user-lead-owner',
      };

      const allUsers = [
        { id: 'u-admin-1', name: 'Alex Morgan', role: 'ADMIN' },
        { id: 'u-sales-1', name: 'Michael Scott', role: 'SALES' },
        { id: 'u-disp-1', name: 'Pam Beesly', role: 'DISPATCHER' },
        { id: 'u-tech-1', name: 'Dwight Schrute', role: 'TECHNICIAN' },
      ];

      // 1. Admin roles selected: alerts sent ONLY to those selected roles
      const adminRolesOnly = resolveSpiderAlertRecipients({
        assignments: {
          adminRoles: ['ADMIN', 'SALES'],
          owner: false,
          users: [],
        },
        lead: mockLead,
        allUsers,
      });
      expect(adminRolesOnly).toContain('u-admin-1');
      expect(adminRolesOnly).toContain('u-sales-1');
      expect(adminRolesOnly).not.toContain('user-lead-owner');
      expect(adminRolesOnly).not.toContain('u-disp-1');

      // 2. Owner selected: alerts sent ONLY to the owner of the lead
      const ownerOnly = resolveSpiderAlertRecipients({
        assignments: {
          adminRoles: [],
          owner: true,
          users: [],
        },
        lead: mockLead,
        allUsers,
      });
      expect(ownerOnly).toEqual(['user-lead-owner']);

      // 3. Both Admin roles and Owner selected: alert sent to BOTH
      const bothSelected = resolveSpiderAlertRecipients({
        assignments: {
          adminRoles: ['ADMIN'],
          owner: true,
          users: [],
        },
        lead: mockLead,
        allUsers,
      });
      expect(bothSelected).toContain('u-admin-1');
      expect(bothSelected).toContain('user-lead-owner');
      expect(bothSelected.length).toBe(2);

      // 4. Nothing selected: 0 recipients
      const noneSelected = resolveSpiderAlertRecipients({
        assignments: {
          adminRoles: [],
          owner: false,
          users: [],
        },
        lead: mockLead,
        allUsers,
      });
      expect(noneSelected).toEqual([]);
    });

    it('suppresses notifications when current user does not match the Assignment selection', () => {
      useSpiderWatcherStore.setState({
        customers: TEST_CUSTOMERS,
        selectedLeadIds: ['l1', 'l2'],
        readNotificationIds: [],
        leadStages: [
          {
            id: 'new-contacted',
            label: 'New → Contacted',
            fromStage: 'New',
            toStage: 'Contacted',
            duration: 3,
            unit: 'Day',
          },
          {
            id: 'contacted-walkthrough-scheduled',
            label: 'Contacted → Walkthrough Scheduled',
            fromStage: 'Contacted',
            toStage: 'Walkthrough Scheduled',
            duration: 5,
            unit: 'Day',
          },
        ],
        assignments: {
          adminRoles: [],
          owner: false,
          users: [],
        },
      });

      const adminUser = { id: 'usr-admin-1', role: 'ADMIN' };

      // Case 1: Nothing selected in Assignment -> 0 notifications for system admin user
      const notifsNone = useSpiderWatcherStore.getState().getComputedNotifications(adminUser);
      expect(notifsNone).toEqual([]);

      // Case 2: Only SALES selected -> ADMIN user receives 0 notifications
      useSpiderWatcherStore.setState({
        assignments: {
          adminRoles: ['SALES'],
          owner: false,
          users: ['u-sales-1'],
        },
      });
      const notifsSalesOnly = useSpiderWatcherStore.getState().getComputedNotifications(adminUser);
      expect(notifsSalesOnly).toEqual([]);

      // Case 3: ADMIN role selected -> ADMIN user receives notifications
      useSpiderWatcherStore.setState({
        assignments: {
          adminRoles: ['ADMIN'],
          owner: false,
          users: ['u-admin-1'],
        },
      });
      const notifsAdminActive = useSpiderWatcherStore.getState().getComputedNotifications(adminUser);
      expect(notifsAdminActive.length).toBeGreaterThan(0);
    });
  });
});
