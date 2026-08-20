import { Bell, Sparkles, MessageSquare, BellOff } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { Button } from '@/components/ui/button';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Heading } from '@/components/ui/heading';
import { Avatar, AvatarFallback } from '@/components/ui/avatar';
import { cn } from '@/lib/utils';
import { useToast } from '@/components/ui/use-toast';
import { useSpiderWatcherStore, type InAppNotification } from '@/stores/spiderWatcherStore';

export type { InAppNotification };

/** Dedicated In-App Notification Bell component for Spider Lead Watcher Messages */
export function InAppNotificationBell() {
  const inAppEnabled = useSpiderWatcherStore((s) => s.notifications.inApp);
  const setInAppNotification = useSpiderWatcherStore((s) => s.setInAppNotification);
  const getComputedNotifications = useSpiderWatcherStore((s) => s.getComputedNotifications);
  const selectNotification = useSpiderWatcherStore((s) => s.selectNotification);
  const isWindowOpen = useSpiderWatcherStore((s) => s.isWindowOpen);
  const setIsWindowOpen = useSpiderWatcherStore((s) => s.setIsWindowOpen);

  const navigate = useNavigate();
  const { toast } = useToast();

  const activeNotifications = inAppEnabled ? getComputedNotifications() : [];

  const unreadCount = inAppEnabled ? activeNotifications.filter((n) => !n.read).length : 0;

  const handleNotificationClick = (notif: InAppNotification) => {
    selectNotification(notif.id);
    setIsWindowOpen(false);
    toast({
      title: `🕷️ Spider Lead Active: ${notif.contactName}`,
      description: `Opening Lead Communication tab for ${notif.contactName} (${notif.leadStage || 'Lead Alert'})`,
      duration: 3000,
    });
    const draftMsg = encodeURIComponent(
      `Hello ${notif.contactName}, following up regarding your ${notif.serviceRequest || 'service request'} (Stage: ${notif.leadStage || 'Active'}).`
    );
    const targetLeadId = notif.leadId || notif.contactId;
    navigate(`/leads/${targetLeadId}?tab=communication&draft=${draftMsg}`);
  };

  const handleSendMessage = (notif: InAppNotification, e: React.MouseEvent) => {
    e.stopPropagation();
    selectNotification(notif.id);
    toast({
      title: 'Opening Lead Communication Composer',
      description: `Drafting message for ${notif.contactName} (${notif.companyName})`,
      duration: 3000,
    });
    setIsWindowOpen(false);
    const draftMsg = encodeURIComponent(
      `Hello ${notif.contactName}, following up regarding your ${notif.serviceRequest || 'service request'} (Stage: ${notif.leadStage || 'Active'}).`
    );
    const targetLeadId = notif.leadId || notif.contactId;
    navigate(`/leads/${targetLeadId}?tab=communication&draft=${draftMsg}`);
  };

  return (
    <Popover open={isWindowOpen} onOpenChange={setIsWindowOpen}>
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
      <PopoverContent align="end" className="w-88 p-0 sm:w-96 shadow-card border border-border">
        {/* Header */}
        <div className="flex items-center justify-between border-b border-border bg-surface-light px-4 py-3">
          <div className="flex items-center gap-2">
            <span className="flex h-6 w-6 items-center justify-center rounded-md bg-ai-50 text-ai-600">
              <Sparkles className="h-3.5 w-3.5" />
            </span>
            <div>
              <Heading level={3} scale="sm" weight="bold">
                In-App Notifications
              </Heading>
              <p className="text-[11px] text-text-soft">Spider Lead Watcher Alerts</p>
            </div>
          </div>
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
              No in-app notifications for contacts inactive past configured thresholds.
            </p>
          ) : (
            activeNotifications.map((n) => (
              <div
                key={n.id}
                onClick={() => handleNotificationClick(n)}
                className={cn(
                  'flex gap-3 p-3.5 transition-colors cursor-pointer hover:bg-background-light',
                  !n.read ? 'bg-ai-50/40' : 'bg-surface-light'
                )}
              >
                <Avatar className="h-8 w-8 shrink-0 mt-0.5">
                  <AvatarFallback tone="subtle" className="text-xs font-bold">
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
                        <span className="h-2 w-2 rounded-full bg-notify shrink-0 animate-pulse" />
                      )}
                    </div>
                  </div>
                  <p className="text-xs font-medium text-text-secondary truncate">{n.contactName}</p>
                  {n.leadStage && (
                    <span className="inline-block rounded bg-ai-50 border border-ai-200 px-1.5 py-0.5 text-[10px] font-bold text-ai-strong">
                      {n.leadStage}
                    </span>
                  )}
                  <p className="text-xs text-text-secondary line-clamp-2 leading-relaxed">
                    {n.message}
                  </p>
                  <div className="pt-1.5 flex items-center justify-between">
                    <span className="rounded-full bg-danger-surface border border-danger-border px-2 py-0.5 text-[10px] font-semibold text-danger-strong">
                      Stage Alert
                    </span>
                    <button
                      type="button"
                      onClick={(e) => handleSendMessage(n, e)}
                      className="inline-flex items-center gap-1 text-xs font-semibold text-ai-600 hover:text-ai-strong"
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
