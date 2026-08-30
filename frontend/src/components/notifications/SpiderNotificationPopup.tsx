import { useState, useEffect, useRef, useMemo } from 'react';
import { Sparkles, BellOff, X } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { Button } from '@/components/ui/button';
import { Heading } from '@/components/ui/heading';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { cn } from '@/lib/utils';
import { useToast } from '@/components/ui/use-toast';
import {
  useSpiderWatcherStore,
  formatCurrentStageName,
  type InAppNotification,
} from '@/stores/spiderWatcherStore';

export function SpiderNotificationPopup() {
  const navigate = useNavigate();
  const { toast } = useToast();
  const panelRef = useRef<HTMLDivElement>(null);
  const [tick, setTick] = useState(0);

  const inAppEnabled = useSpiderWatcherStore((s) => s.notifications.inApp);
  const customers = useSpiderWatcherStore((s) => s.customers);
  const selectedLeadIds = useSpiderWatcherStore((s) => s.selectedLeadIds);
  const leadStages = useSpiderWatcherStore((s) => s.leadStages);
  const readNotificationIds = useSpiderWatcherStore((s) => s.readNotificationIds);
  const getComputedNotifications = useSpiderWatcherStore((s) => s.getComputedNotifications);
  const selectNotification = useSpiderWatcherStore((s) => s.selectNotification);
  const setInAppNotification = useSpiderWatcherStore((s) => s.setInAppNotification);
  const isWindowOpen = useSpiderWatcherStore((s) => s.isWindowOpen);
  const setIsWindowOpen = useSpiderWatcherStore((s) => s.setIsWindowOpen);

  useEffect(() => {
    const timer = setInterval(() => {
      setTick((t) => (t + 1) % 10000);
    }, 2500);
    return () => clearInterval(timer);
  }, []);

  const activeNotifications = useMemo(() => {
    return inAppEnabled ? getComputedNotifications() : [];
  }, [inAppEnabled, customers, selectedLeadIds, leadStages, readNotificationIds, getComputedNotifications, tick]);

  const unreadCount = inAppEnabled
    ? activeNotifications.filter((n) => !n.read).length
    : 0;

  // Close panel when clicking outside
  useEffect(() => {
    if (!isWindowOpen) return;
    const handler = (e: MouseEvent) => {
      if (panelRef.current && !panelRef.current.contains(e.target as Node)) {
        setIsWindowOpen(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [isWindowOpen, setIsWindowOpen]);

  const handleNotificationClick = (notif: InAppNotification) => {
    selectNotification(notif.id);
    setIsWindowOpen(false);
    const stageName = formatCurrentStageName(notif.leadStage);
    toast({
      title: `🕷️ Spider Lead Active: ${notif.contactName}`,
      description: `Opening Lead Communication tab for ${notif.contactName} (${stageName})`,
      duration: 3000,
    });
    const draftMsg = encodeURIComponent(
      `Hello ${notif.contactName}, following up regarding your ${notif.serviceRequest || 'service request'} (Stage: ${stageName}).`
    );
    const targetLeadId = notif.leadId || notif.contactId;
    navigate(`/leads/${targetLeadId}?tab=communication&draft=${draftMsg}`);
  };

  // Keep spider icon completely hidden by default. Only display when there is an active/unread notification.
  if (!inAppEnabled || unreadCount === 0) return null;

  return (
    <div ref={panelRef} className="fixed bottom-5 right-5 z-50">
      {/* ── Floating Notification Bell FAB ───────────────────────────── */}
      <Button
        type="button"
        variant="solid"
        tone="ai"
        size={null}
        id="spider-notification-bell-trigger"
        onClick={() => setIsWindowOpen(!isWindowOpen)}
        aria-label={
          unreadCount > 0
            ? `${unreadCount} unread Spider notification${unreadCount > 1 ? 's' : ''} — click to view`
            : 'Spider Lead Watcher notifications'
        }
        aria-expanded={isWindowOpen}
        className={cn(
          'relative flex h-14 w-14 items-center justify-center p-0 transition-transform hover:scale-110 active:scale-95',
          !isWindowOpen && unreadCount > 0 && 'animate-bounce',
        )}
        style={!isWindowOpen && unreadCount > 0 ? { animationDuration: '1.4s' } : undefined}
      >
        <Avatar className="h-9 w-9 shrink-0 select-none pointer-events-none">
          <AvatarImage
            src="/ai-center/agents/spider.png"
            alt="Spider Agent"
            className="object-contain"
          />
          <AvatarFallback tone="solid">
            🕷️
          </AvatarFallback>
        </Avatar>

        {/* Unread badge */}
        {unreadCount > 0 && (
          <span className="absolute -top-1 -right-1 flex h-5 min-w-[20px] items-center justify-center rounded-full bg-notify px-1 text-[11px] font-bold text-on-fill ring-2 ring-surface-light animate-pulse">
            {unreadCount > 99 ? '99+' : unreadCount}
          </span>
        )}
      </Button>

      {/* ── Notification panel ────────────────────────────────────────── */}
      {isWindowOpen && (
        <div
          role="dialog"
          aria-label="Spider Lead Watcher Notifications"
          className="absolute bottom-16 right-0 w-88 sm:w-96 rounded-xl border border-border bg-surface-light shadow-card overflow-hidden animate-in slide-in-from-bottom-3 duration-200"
        >
          {/* Header */}
          <div className="flex items-center justify-between border-b border-border bg-surface-light px-4 py-3">
            <div className="flex items-center gap-2">
              <Avatar className="h-6 w-6 shrink-0">
                <AvatarImage
                  src="/ai-center/agents/spider.png"
                  alt="Spider Agent"
                  className="object-contain"
                />
                <AvatarFallback tone="solid">
                  🕷️
                </AvatarFallback>
              </Avatar>
              <div>
                <Heading level={3} scale="sm" weight="bold">
                  Spider Notifications
                </Heading>
                <p className="text-[11px] text-text-soft">Lead Watcher Stage Alerts</p>
              </div>
            </div>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              onClick={() => setIsWindowOpen(false)}
              className="h-6 w-6 transition-colors"
              title="Close"
            >
              <X className="h-4 w-4" />
            </Button>
          </div>

          {/* Body */}
          <div className="max-h-80 overflow-y-auto divide-y divide-border/60">
            {!inAppEnabled ? (
              <div className="flex flex-col items-center gap-2 px-4 py-8 text-center">
                <BellOff className="h-8 w-8 text-text-soft/60" />
                <p className="text-xs font-medium text-text-secondary">
                  In-App Spider notifications are currently disabled.
                </p>
                <Button
                  variant="outline"
                  size="sm"
                  className="mt-2"
                  onClick={() => {
                    setInAppNotification(true);
                    toast({ title: 'Enabled Spider In-App Notifications', duration: 2000 });
                  }}
                >
                  Enable Notifications
                </Button>
              </div>
            ) : activeNotifications.length === 0 ? (
              <p className="px-4 py-8 text-center text-xs text-text-soft">
                No Spider lead watcher alerts currently active.
              </p>
            ) : (
              activeNotifications.map((n) => (
                <div
                  key={n.id}
                  onClick={() => handleNotificationClick(n)}
                  className={cn(
                    'flex gap-3 p-3.5 transition-colors cursor-pointer hover:bg-background-light group',
                    !n.read ? 'bg-ai-50/40' : 'bg-surface-light'
                  )}
                >
                  <Avatar className="h-8 w-8 shrink-0 mt-0.5">
                    <AvatarFallback tone="subtle">
                      {n.contactName[0]}
                    </AvatarFallback>
                  </Avatar>
                  <div className="min-w-0 flex-1 space-y-1.5">
                    <div className="flex items-center justify-between gap-2">
                      <div className="flex items-center gap-2 min-w-0">
                        <p className="text-xs font-bold text-text-primary truncate group-hover:text-ai-strong transition-colors">
                          {n.contactName}
                        </p>
                        {n.leadStage && (
                          <span className="shrink-0 rounded bg-ai-50 border border-ai-200 px-1.5 py-0.5 text-[10px] font-bold text-ai-strong">
                            {formatCurrentStageName(n.leadStage)}
                          </span>
                        )}
                      </div>
                      <div className="flex items-center gap-1.5 shrink-0">
                        <span className="text-[10px] text-text-soft">{n.timeAgo}</span>
                        {!n.read && (
                          <span className="h-2 w-2 rounded-full bg-notify shrink-0 animate-pulse" />
                        )}
                      </div>
                    </div>
                    <p className="text-xs text-text-secondary line-clamp-2 leading-relaxed">
                      {n.message}
                    </p>
                    <div className="pt-1 flex items-center justify-between">
                      <span className="rounded-full bg-danger-surface border border-danger-border px-2 py-0.5 text-[10px] font-semibold text-danger-strong">
                        Threshold Exceeded
                      </span>
                    </div>
                  </div>
                </div>
              ))
            )}
          </div>
        </div>
      )}
    </div>
  );
}
