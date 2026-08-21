import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { BrowserAutomationIndicator } from '../BrowserAutomationIndicator';
import { useSpiderWatcherStore, type WatcherCustomer } from '@/stores/spiderWatcherStore';

const TEST_CUSTOMERS: WatcherCustomer[] = [
  {
    id: 'c1',
    name: 'Apex Customer',
    company: 'Apex Plumbing Co.',
    leads: [
      {
        id: 'l1',
        leadNumber: 'LD-101',
        serviceRequest: 'Pipe Repair',
        stageId: 'new-contacted',
        stageLabel: 'New → Contacted',
        elapsedValue: 5,
        elapsedUnit: 'Day',
        elapsedSeconds: 5 * 86400,
      },
    ],
  },
];

describe('BrowserAutomationIndicator', () => {
  beforeEach(() => {
    useSpiderWatcherStore.setState({
      notifications: { email: true, sms: true, inApp: true },
      days: '0',
      customers: TEST_CUSTOMERS,
      selectedCustomerIds: ['c1'],
      selectedLeadIds: ['l1'],
      isRedBorderActive: false,
      isWindowOpen: false,
      readNotificationIds: [],
    });
  });

  it('renders subdued glowing maroon viewport frame when unread spider notifications exist for selected leads', () => {
    render(<BrowserAutomationIndicator />);

    const indicator = screen.getByRole('status');
    expect(indicator).toBeInTheDocument();
    expect(indicator).toHaveClass('pointer-events-none');
    expect(indicator.firstElementChild).toHaveClass('border-[#800000]');
  });

  it('does not render frame when no leads or customers are selected', () => {
    useSpiderWatcherStore.setState({
      selectedCustomerIds: [],
      selectedLeadIds: [],
    });

    render(<BrowserAutomationIndicator />);
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });

  it('auto-dismisses when all notifications are marked as read', () => {
    const { rerender } = render(<BrowserAutomationIndicator />);
    expect(screen.getByRole('status')).toBeInTheDocument();

    // Mark all notifications as read
    const notifs = useSpiderWatcherStore.getState().getComputedNotifications();
    useSpiderWatcherStore.setState({
      readNotificationIds: notifs.map((n) => n.id),
    });

    rerender(<BrowserAutomationIndicator />);
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });

  it('does not render when inApp notifications are disabled', () => {
    useSpiderWatcherStore.setState({
      notifications: { email: true, sms: true, inApp: false },
    });

    render(<BrowserAutomationIndicator />);
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });
});
