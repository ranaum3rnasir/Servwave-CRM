import { useState } from 'react';
import { Bell, Sparkles, MessageSquare, BellOff } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { Button } from '@/components/ui/button';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Heading } from '@/components/ui/heading';
import { Avatar, AvatarFallback } from '@/components/ui/avatar';
import { cn } from '@/lib/utils';
import { useToast } from '@/components/ui/use-toast';
import { useSpiderWatcherStore } from '@/stores/spiderWatcherStore';

export interface InAppNotification {
  id: string;
  contactName: string;
  companyName: string;
  inactiveDays: number;
  message: string;
  timeAgo: string;
  read: boolean;
  contactId: string;
}

const DEFAULT_IN_APP_NOTIFICATIONS: InAppNotification[] = [
  {
    id: 'inapp-1',
    contactName: 'John Smith',
    companyName: 'Apex Plumbing Co.',
    inactiveDays: 45,
    message: 'No messages or activity for 45 days. Spider Agent detected re-engagement opportunity.',
    timeAgo: '10m ago',
    read: false,
    contactId: 'c1',
  },
  {
    id: 'inapp-2',
    contactName: 'Sarah Johnson',
    companyName: 'Metro HVAC Services',
    inactiveDays: 60,
    message: 'No messages or activity for 60 days. Follow-up SMS pending.',
    timeAgo: '45m ago',
    read: false,
    contactId: 'c2',
  },
  {
    id: 'inapp-3',
    contactName: 'Emily Davis',
    companyName: 'Highland Builders',
    inactiveDays: 90,
    message: 'No messages or activity for 90 days. Re-engagement offer ready.',
    timeAgo: '2h ago',
    read: false,
    contactId: 'c4',
  },
  {
    id: 'inapp-4',
    contactName: 'Robert Wilson',
    companyName: 'Summit Property Management',
    inactiveDays: 35,
    message: 'No messages or activity for 35 days.',
    timeAgo: '5h ago',
    read: true,
    contactId: 'c5',
  },
];

/** Dedicated In-App Notification Bell component for Spider Lead Watcher Messages */
export function InAppNotificationBell() {
  const [open, setOpen] = useState(false);
  const inAppEnabled = useSpiderWatcherStore((s) => s.notifications.inApp);
  const configuredDays = useSpiderWatcherStore((s) => s.days);
  const setInAppNotification = useSpiderWatcherStore((s) => s.setInAppNotification);

  const [notifications, setNotifications] = useState<InAppNotification[]>(
    DEFAULT_IN_APP_NOTIFICATIONS
  );
  const navigate = useNavigate();
  const { toast } = useToast();

  const selectedDaysNum = parseInt(configuredDays || '3', 10);

  // Filter notifications based on whether inApp is enabled and matching inactiveDays
  const activeNotifications = inAppEnabled
    ? notifications.filter((n) => n.inactiveDays >= selectedDaysNum)
    : [];

  const unreadCount = inAppEnabled ? activeNotifications.filter((n) => !n.read).length : 0;

  const markAllRead = () => {
    setNotifications((prev) => prev.map((n) => ({ ...n, read: true })));
    toast({ title: 'Marked all in-app notifications as read', duration: 2000 });
  };

  const markRead = (id: string) => {
    setNotifications((prev) =>
      prev.map((n) => (n.id === id ? { ...n, read: true } : n))
    );
  };

  const handleSendMessage = (notif: InAppNotification, e: React.MouseEvent) => {
    e.stopPropagation();
    markRead(notif.id);
    toast({
      title: 'Opening Message Composer',
      description: `Sending automated message to ${notif.contactName} (${notif.companyName})`,
      duration: 3000,
    });
    setOpen(false);
    navigate(`/communication/text?contact=${notif.contactId}`);
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          className="relative text-ai-600 hover:bg-ai-50"
          aria-label="In-App Notifications"
          title={
            inAppEnabled
              ? 'In-App Notification Messages (Spider Lead Watcher)'
              : 'In-App Notifications Disabled'
          }
        >
          <Bell className={cn("h-5 w-5", inAppEnabled ? "text-ai-600" : "text-text-soft opacity-60")} />
          {inAppEnabled && unreadCount > 0 && (
            <span className="absolute -right-0.5 -top-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-notify px-1 text-[10px] font-bold leading-none text-on-fill ring-2 ring-surface-light animate-pulse">
              {unreadCount > 99 ? '99+' : unreadCount}
            </span>
          )}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-88 p-0 sm:w-96 shadow-lg border border-border">
        {/* Header */}
        <div className="flex items-center justify-between border-b border-border bg-surface-light px-4 py-3">
          <div className="flex items-center gap-2">
            <span className="flex h-6 w-6 items-center justify-center rounded-md bg-ai-100 text-ai-700">
              <Sparkles className="h-3.5 w-3.5" />
            </span>
            <div>
              <Heading level={3} scale="sm" weight="bold" className="text-text-primary">
                In-App Notifications
              </Heading>
              <p className="text-[11px] text-text-soft">Spider Lead Watcher Alerts</p>
            </div>
          </div>
          {inAppEnabled && unreadCount > 0 && (
            <button
              type="button"
              onClick={markAllRead}
              className="text-xs font-semibold text-ai-600 hover:text-ai-700"
            >
              Mark all read
            </button>
          )}
        </div>

        {/* Body */}
        <div className="max-h-80 overflow-y-auto divide-y divide-border/60">
          {!inAppEnabled ? (
            <div className="flex flex-col items-center gap-2 px-4 py-8 text-center">
              <BellOff className="h-8 w-8 text-text-soft/60" />
              <p className="text-xs font-medium text-text-secondary">
                In-App notifications are currently disabled in Spider Agent settings.
              </p>
              <Button
                variant="outline"
                size="sm"
                className="mt-2 text-xs"
                onClick={() => {
                  setInAppNotification(true);
                  toast({ title: 'Enabled In-App Notifications', duration: 2000 });
                }}
              >
                Enable In-App Notifications
              </Button>
            </div>
          ) : activeNotifications.length === 0 ? (
            <p className="px-4 py-8 text-center text-xs text-text-soft">
              No in-app notifications for contacts inactive in the last {configuredDays} days.
            </p>
          ) : (
            activeNotifications.map((n) => (
              <div
                key={n.id}
                onClick={() => markRead(n.id)}
                className={cn(
                  'flex gap-3 p-3.5 transition-colors cursor-pointer hover:bg-background-light',
                  !n.read ? 'bg-ai-50/40' : 'bg-surface-light'
                )}
              >
                <Avatar className="h-8 w-8 shrink-0 mt-0.5">
                  <AvatarFallback className="bg-ai-100 text-ai-700 text-xs font-bold">
                    {n.contactName[0]}
                  </AvatarFallback>
                </Avatar>
                <div className="min-w-0 flex-1 space-y-1">
                  <div className="flex items-start justify-between gap-2">
                    <p className="text-xs font-bold text-text-primary truncate">
                      {n.companyName}
                    </p>
                    <div className="flex items-center gap-1.5 shrink-0">
                      <span className="text-[10px] text-text-soft">{n.timeAgo}</span>
                      {!n.read && (
                        <span className="h-2 w-2 rounded-full bg-notify shrink-0" />
                      )}
                    </div>
                  </div>
                  <p className="text-xs text-text-secondary line-clamp-2 leading-relaxed">
                    {n.message}
                  </p>
                  <div className="pt-1.5 flex items-center justify-between">
                    <span className="rounded-full bg-ai-100/80 px-2 py-0.5 text-[10px] font-semibold text-ai-700">
                      No activity for {n.inactiveDays} days
                    </span>
                    <button
                      type="button"
                      onClick={(e) => handleSendMessage(n, e)}
                      className="inline-flex items-center gap-1 text-xs font-semibold text-ai-600 hover:text-ai-700"
                    >
                      <MessageSquare className="h-3 w-3" />
                      Send Message
                    </button>
                  </div>
                </div>
              </div>
            ))
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}
