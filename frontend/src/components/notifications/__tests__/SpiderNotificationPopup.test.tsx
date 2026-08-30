import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { SpiderNotificationPopup } from '../SpiderNotificationPopup';
import { useSpiderWatcherStore, type WatcherCustomer } from '@/stores/spiderWatcherStore';

const TEST_CUSTOMERS: WatcherCustomer[] = [
  {
    id: 'c1',
    name: 'John Smith',
    company: 'Apex Plumbing Co.',
    leads: [
      {
        id: 'l1',
        leadNumber: 'LD-101',
        serviceRequest: 'Main Line Leak',
        stageId: 'new-contacted',
        stageLabel: 'New → Contacted',
        elapsedValue: 4,
        elapsedUnit: 'Day',
        elapsedSeconds: 4 * 86400,
      },
      {
        id: 'l2',
        leadNumber: 'LD-102',
        serviceRequest: 'Water Heater',
        stageId: 'contacted-walkthrough-scheduled',
        stageLabel: 'Contacted → Walkthrough Scheduled',
        elapsedValue: 6,
        elapsedUnit: 'Day',
        elapsedSeconds: 6 * 86400,
      },
      {
        id: 'l3',
        leadNumber: 'LD-103',
        serviceRequest: 'Valve Testing',
        stageId: 'walkthrough-scheduled-estimate',
        stageLabel: 'Walkthrough Scheduled → Estimate',
        elapsedValue: 12,
        elapsedUnit: 'Hour',
        elapsedSeconds: 12 * 3600,
      },
    ],
  },
];

describe('SpiderNotificationPopup', () => {
  beforeEach(() => {
    useSpiderWatcherStore.setState({
      notifications: { email: true, sms: true, inApp: true, redFrame: true },
      days: '0',
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
        {
          id: 'walkthrough-scheduled-estimate',
          label: 'Walkthrough Scheduled → Estimate',
          fromStage: 'Walkthrough Scheduled',
          toStage: 'Estimate',
          duration: 0,
          unit: 'Second',
        },
      ],
      customers: TEST_CUSTOMERS,
      selectedCustomerIds: ['c1'],
      selectedLeadIds: ['l1', 'l2', 'l3'],
      isRedBorderActive: false,
      activeNotificationId: null,
      isWindowOpen: true, // open panel to test dialog contents
      readNotificationIds: [],
    });
  });

  it('renders lower section pop-up box with Bell trigger icon when inApp is enabled and unread notifications exist for selected leads', () => {
    render(
      <MemoryRouter>
        <SpiderNotificationPopup />
      </MemoryRouter>
    );

    // Bell trigger button exists
    expect(screen.getByRole('button', { name: /Spider notification/i })).toBeInTheDocument();

    // Dialog renders
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(screen.getByText('Spider Notifications')).toBeInTheDocument();
    expect(screen.getAllByText('John Smith').length).toBe(3); // one per notification item at the top row only

    // "Mark all read" and "Send Message" buttons are removed
    expect(screen.queryByText('Mark all read')).toBeNull();
    expect(screen.queryByText('Send Message')).toBeNull();

    // Displays only current stage name (e.g. 'New', 'Contacted', 'Walkthrough') parallel to the name
    expect(screen.getAllByText('New').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Contacted').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Walkthrough').length).toBeGreaterThan(0);
    expect(screen.queryByText('New → Contacted')).toBeNull();
  });

  it('displays empty notification state when no customer or lead is selected', () => {
    useSpiderWatcherStore.setState({
      selectedCustomerIds: [],
      selectedLeadIds: [],
    });

    render(
      <MemoryRouter>
        <SpiderNotificationPopup />
      </MemoryRouter>
    );

    // No notifications triggered, bell icon hidden
    expect(screen.queryByRole('button', { name: /Spider notification/i })).not.toBeInTheDocument();
  });

  it('clicking a notification activates indicator and selects it, but does NOT mark it as read', () => {
    render(
      <MemoryRouter>
        <SpiderNotificationPopup />
      </MemoryRouter>
    );

    const initialNotifs = useSpiderWatcherStore.getState().getComputedNotifications();
    expect(initialNotifs.length).toBeGreaterThan(0);
    const targetNotif = initialNotifs[0]!;

    const card = screen.getAllByText(targetNotif.contactName)[0]?.closest('div[class*="cursor-pointer"]');
    expect(card).not.toBeNull();
    fireEvent.click(card!);

    const state = useSpiderWatcherStore.getState();
    expect(state.isRedBorderActive).toBe(true);
    expect(state.activeNotificationId).toBe(targetNotif.id);
    // Clicking/opening does NOT mark as read
    expect(state.readNotificationIds).not.toContain(targetNotif.id);
    expect(state.getComputedNotifications().length).toBe(initialNotifs.length);
  });

  it('marking lead notifications as read (on message send) removes the notification from list', () => {
    const initialNotifs = useSpiderWatcherStore.getState().getComputedNotifications();
    expect(initialNotifs.length).toBe(3);

    // Simulate successful message dispatch to lead l1
    useSpiderWatcherStore.getState().markLeadNotificationsRead('l1');

    const remaining = useSpiderWatcherStore.getState().getComputedNotifications();
    expect(remaining.length).toBe(2);
    expect(remaining.find((n) => n.leadId === 'l1')).toBeUndefined();
  });

  it('keeps icon completely hidden when unreadCount is 0 or all notifications are read', () => {
    const allNotifs = useSpiderWatcherStore.getState().getComputedNotifications();
    useSpiderWatcherStore.setState({
      readNotificationIds: allNotifs.map((n) => n.id),
    });

    const { container } = render(
      <MemoryRouter>
        <SpiderNotificationPopup />
      </MemoryRouter>
    );

    // No button or popup should render
    expect(container.firstChild).toBeNull();
    expect(screen.queryByRole('button', { name: /Spider notification/i })).not.toBeInTheDocument();
  });

  it('does not render popup when inApp notification setting is disabled', () => {
    useSpiderWatcherStore.setState({
      notifications: { email: true, sms: true, inApp: false, redFrame: true },
      inAppNotifications: [],
      customers: [],
    });

    render(
      <MemoryRouter>
        <SpiderNotificationPopup />
      </MemoryRouter>
    );

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });
});
