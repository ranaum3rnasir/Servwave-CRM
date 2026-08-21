import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { AiCenterModal } from './AiCenterModal';
import { AgentDetailModal } from './AgentDetailModal';
import { AI_AGENTS } from '@/lib/ai-center/agents';
import { useAiCenterStore } from '@/stores/aiCenterStore';
import {
  useSpiderWatcherStore,
  resolveLeadStageAndElapsedTime,
  type WatcherCustomer,
} from '@/stores/spiderWatcherStore';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

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
        stageId: 'contacted-walkthrough-scheduled',
        stageLabel: 'Contacted → Walkthrough Scheduled',
        elapsedValue: 6,
        elapsedUnit: 'Day',
        elapsedSeconds: 6 * 86400,
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
        open={true}
        onOpenChange={() => {}}
        onStart={() => {}}
        onStop={() => {}}
        isPending={false}
      />
    </QueryClientProvider>
  );
}

describe('AiCenterModal', () => {
  beforeEach(() => {
    mockUseOrganization.mockReturnValue({
      data: { is_demo: false },
    });
    useAiCenterStore.setState({ open: true, focusAgentId: null });
    useSpiderWatcherStore.setState({
      customers: TEST_CUSTOMERS,
      selectedCustomerIds: ['c1'],
      selectedLeadIds: ['l1', 'l2'],
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

    // 1. Lead Stages section with 3 stages and default 0 second period
    expect(screen.getByText('Distance')).toBeInTheDocument();
    expect(screen.getByText('New → Contacted')).toBeInTheDocument();
    expect(screen.getByText('Contacted → Walkthrough Scheduled')).toBeInTheDocument();
    expect(screen.getByText('Walkthrough Scheduled → Estimate')).toBeInTheDocument();

    const stages = useSpiderWatcherStore.getState().leadStages;
    expect(stages.length).toBe(3);
    expect(stages.every((s) => s.duration === 0 && s.unit === 'Second')).toBe(true);

    // Parallel time period & units inputs exist
    const unitSelects = screen.getAllByLabelText(/Time unit for/i);
    expect(unitSelects.length).toBe(3);
    const durationInputs = screen.getAllByLabelText(/Time period for/i);
    expect(durationInputs.length).toBe(3);

    // Changing stage time period updates store
    fireEvent.change(durationInputs[0], { target: { value: '7' } });
    expect(useSpiderWatcherStore.getState().leadStages[0].duration).toBe(7);

    // Save button exists at the end of Distance section and saves thresholds
    const saveThresholdsBtn = screen.getByRole('button', { name: /Save/i });
    expect(saveThresholdsBtn).toBeInTheDocument();
    fireEvent.click(saveThresholdsBtn);
    expect(screen.getByText('Saved')).toBeInTheDocument();

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
    expect(screen.getByText('Main Line Leak & Pipe Replacement')).toBeInTheDocument();
    expect(screen.getByText('LD-102')).toBeInTheDocument();

    // Select/deselect customer and specific lead
    const leadCheckbox = screen.getByLabelText(/Select lead LD-101 for notifications/i);
    expect(leadCheckbox).toBeInTheDocument();

    // Lead stage badge in Contact Watcher displays single stage ("New", "Contacted", "Walkthrough")
    expect(screen.getAllByText('New').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Contacted').length).toBeGreaterThan(0);
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
});
