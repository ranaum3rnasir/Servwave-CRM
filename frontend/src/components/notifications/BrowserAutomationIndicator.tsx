import { useSpiderWatcherStore } from '@/stores/spiderWatcherStore';
import { cn } from '@/lib/utils';

interface BrowserAutomationIndicatorProps {
  className?: string;
}

/**
 * Visual Browser Automation Indicator Frame (Spider Notification Indicator)
 *
 * Refinements:
 * 1. Solid deep maroon hue (#800000 / rgba(128, 0, 0, ...)).
 * 2. 10% reduced intensity and opacity for a more subdued, elegant, balanced ambient tone.
 * 3. Smooth 3.5s breathing/pulsing animation with pointer-events: none.
 * 4. Strictly visible only while unread spider notifications exist; auto-dismisses on read.
 */
export function BrowserAutomationIndicator({ className }: BrowserAutomationIndicatorProps) {
  const inAppEnabled = useSpiderWatcherStore((s) => s.notifications.inApp);
  const getComputedNotifications = useSpiderWatcherStore((s) => s.getComputedNotifications);

  const activeNotifs = inAppEnabled ? getComputedNotifications() : [];
  const unreadCount = activeNotifs.filter((n) => !n.read).length;

  // Frame is strictly visible only while there are active unread spider notifications
  const isVisible = inAppEnabled && unreadCount > 0;

  if (!isVisible) return null;

  return (
    <div
      aria-live="polite"
      role="status"
      className={cn('pointer-events-none fixed inset-0 z-50 overflow-hidden', className)}
    >
      {/* ── Ambient Glowing Subdued Maroon Viewport Frame ────────────────── */}
      <div
        className="pointer-events-none absolute inset-0 border-[3.5px] border-[#800000]"
        style={{
          animation: 'spiderMaroonPulse 3.5s ease-in-out infinite',
        }}
      >
        {/* Subtle maroon corner accents */}
        <span className="absolute -top-0.5 -left-0.5 h-3.5 w-3.5 border-t-[2.5px] border-l-[2.5px] border-[#990000] shadow-[0_0_8px_rgba(128,0,0,0.5)]" />
        <span className="absolute -top-0.5 -right-0.5 h-3.5 w-3.5 border-t-[2.5px] border-r-[2.5px] border-[#990000] shadow-[0_0_8px_rgba(128,0,0,0.5)]" />
        <span className="absolute -bottom-0.5 -left-0.5 h-3.5 w-3.5 border-b-[2.5px] border-l-[2.5px] border-[#990000] shadow-[0_0_8px_rgba(128,0,0,0.5)]" />
        <span className="absolute -bottom-0.5 -right-0.5 h-3.5 w-3.5 border-b-[2.5px] border-r-[2.5px] border-[#990000] shadow-[0_0_8px_rgba(128,0,0,0.5)]" />
      </div>

      {/* Gentle maroon breathing animation keyframes with balanced subdued opacity */}
      <style>{`
        @keyframes spiderMaroonPulse {
          0%, 100% {
            opacity: 0.72;
            box-shadow: inset 0 0 24px rgba(128, 0, 0, 0.48), 0 0 24px rgba(128, 0, 0, 0.48);
          }
          50% {
            opacity: 0.88;
            box-shadow: inset 0 0 40px rgba(128, 0, 0, 0.76), 0 0 35px rgba(128, 0, 0, 0.72);
          }
        }
      `}</style>
    </div>
  );
}
