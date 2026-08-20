import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { BrowserAutomationIndicator } from '../BrowserAutomationIndicator';
import { useSpiderWatcherStore } from '@/stores/spiderWatcherStore';

describe('BrowserAutomationIndicator', () => {
  beforeEach(() => {
    useSpiderWatcherStore.setState({
      notifications: { email: true, sms: true, inApp: true },
      days: '0',
      isRedBorderActive: false,
      isWindowOpen: false,
      readNotificationIds: [],
    });
  });

  it('renders subdued glowing maroon viewport frame when unread spider notifications exist', () => {
    render(<BrowserAutomationIndicator />);

    const indicator = screen.getByRole('status');
    expect(indicator).toBeInTheDocument();
    expect(indicator).toHaveClass('pointer-events-none');
    expect(indicator.firstElementChild).toHaveClass('border-[#800000]');
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
