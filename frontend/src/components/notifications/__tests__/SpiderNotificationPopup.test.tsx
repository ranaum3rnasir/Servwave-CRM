import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { SpiderNotificationPopup } from '../SpiderNotificationPopup';
import { useSpiderWatcherStore } from '@/stores/spiderWatcherStore';

describe('SpiderNotificationPopup', () => {
  beforeEach(() => {
    useSpiderWatcherStore.setState({
      notifications: { email: true, sms: true, inApp: true },
      days: '0',
      isRedBorderActive: false,
      activeNotificationId: null,
      isWindowOpen: true, // open panel to test dialog contents
      readNotificationIds: [],
    });
  });

  it('renders lower section pop-up box with Bell trigger icon when inApp is enabled and unread notifications exist', () => {
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
    expect(screen.getAllByText('Apex Plumbing Co.').length).toBeGreaterThan(0);

    // "Mark all read" button has been removed
    expect(screen.queryByText('Mark all read')).toBeNull();
  });

  it('clicking a notification marks it as read, removes it from the notification list, and activates red border state', () => {
    render(
      <MemoryRouter>
        <SpiderNotificationPopup />
      </MemoryRouter>
    );

    const initialNotifs = useSpiderWatcherStore.getState().getComputedNotifications();
    expect(initialNotifs.length).toBeGreaterThan(0);
    const targetNotif = initialNotifs[0];

    const card = screen.getAllByText(targetNotif.companyName)[0].closest('div[class*="cursor-pointer"]');
    expect(card).not.toBeNull();
    fireEvent.click(card!);

    const state = useSpiderWatcherStore.getState();
    expect(state.isRedBorderActive).toBe(true);
    expect(state.activeNotificationId).toBe(targetNotif.id);
    expect(state.readNotificationIds).toContain(targetNotif.id);

    // After clicking, the clicked notification is removed from the active notifications list
    const remainingNotifs = state.getComputedNotifications();
    expect(remainingNotifs.find((n) => n.id === targetNotif.id)).toBeUndefined();
    expect(remainingNotifs.length).toBe(initialNotifs.length - 1);
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
      notifications: { email: true, sms: true, inApp: false },
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
