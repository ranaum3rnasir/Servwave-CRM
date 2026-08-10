import { Check } from 'lucide-react';
import { cn } from '@/lib/utils';
import { computeLifecycle, type StageKey } from '@/lib/jobs/lifecycle';
import type { JobFinancials } from '@/lib/api/jobs';
import { Button } from '@/components/ui/button';
import { DEFAULT_SCHEDULE_TIMEZONE, formatInstant } from '@/lib/schedule-tz';

/** Every stage a click can act on. `created` is not actionable — you cannot un-create a job. */
export type ActionableNodeKey = Exclude<StageKey, 'created'>;
const ACTIONABLE_NODES: readonly StageKey[] = [
  'scheduled', 'on_site', 'completed', 'invoice_sent', 'payment_received',
];
/** The two invoice nodes act on money, not status — see the `interactive` note below. */
const INVOICE_NODES: readonly StageKey[] = ['invoice_sent', 'payment_received'];

interface JobLifecycleBarProps {
  job: {
    created_at?: string | null;
    scheduled_start?: string | null;
    on_site_at?: string | null;
    completed_at?: string | null;
    status: string;
    cancelled_at?: string | null;
  };
  financials: JobFinancials | undefined;
  /** Per-node capability. A node the user cannot act on renders inert — no disabled affordance. */
  can?: {
    scheduled?: boolean; on_site?: boolean; started?: boolean; completed?: boolean;
    invoice_sent?: boolean; payment_received?: boolean;
  };
  onNodeClick?: (key: ActionableNodeKey) => void;
  onStartClick?: () => void;
  /** Disables every control while a mutation is in flight. */
  busy?: boolean;
  /** The org's scheduling zone, which milestone dates are read on. Passed in rather than
   *  pulled from `useScheduleTimezone` here: this component is presentational, and the
   *  hook's `useQuery` would make every bare `render()` of it need a QueryClientProvider. */
  tz?: string;
}

/** Milestone dates read on the ORG's clock, so a node never shows a different day than
 *  the board or the schedule tile for a viewer outside that zone.
 *
 *  The catch is load-bearing, and predates this change: `toLocaleDateString` throws
 *  RangeError on an unrecognised zone, so a malformed `organization.timezone` would take
 *  the whole page down rather than drop one date label. */
function formatAt(at: string | null, tz: string): string | null {
  try {
    return formatInstant(at, tz, { month: 'short', day: 'numeric' }) || null;
  } catch {
    return null;
  }
}

export function JobLifecycleBar({
  job, financials, can, onNodeClick, onStartClick, busy = false,
  tz = DEFAULT_SCHEDULE_TIMEZONE,
}: JobLifecycleBarProps) {
  const stages = computeLifecycle(job, financials);
  const isCancelled = !!job.cancelled_at;

  // Start is reachable only while the job is neither started nor past. Because a backward move
  // clears `started_at` and `completed_at`, moving back to On Site re-enables it automatically —
  // no separate rule needed.
  const canStart = !!can?.started && !job.completed_at && job.status !== 'IN_PROGRESS';

  return (
    <div className="space-y-2 pt-3 border-t border-border">
      {/* Cancelled badge */}
      {isCancelled && (
        <div className="flex items-center gap-2">
          <span className="inline-flex items-center rounded-full border border-danger/30 bg-danger/10 px-2.5 py-0.5 text-xs font-semibold text-danger">
            Cancelled
          </span>
        </div>
      )}

      {/* Stage nodes + connectors — evenly distributed across the full width */}
      <div className="flex items-start pt-1">
        {stages.map((stage, idx) => {
          const isLast = idx === stages.length - 1;
          const dateStr = formatAt(stage.at, tz);

          const isActionable = ACTIONABLE_NODES.includes(stage.key);
          const isInvoiceNode = INVOICE_NODES.includes(stage.key);
          const interactive =
            isActionable &&
            !!onNodeClick &&
            !!can?.[stage.key as keyof NonNullable<typeof can>] &&
            // Clicking the stage the job is already at is a no-op for a JOB node — it would
            // re-stamp the timestamp and re-arm the follow-up automation for nothing. For an
            // INVOICE node it is the most useful click there is: it opens the invoice.
            (isInvoiceNode || !stage.current);

          const circle = (
            <div
              className={cn(
                'relative z-10 flex h-8 w-8 items-center justify-center rounded-full transition-colors',
                stage.current
                  ? 'border-2 border-primary bg-primary text-on-fill ring-4 ring-primary/15'
                  : stage.reached
                  ? 'bg-success text-on-fill'
                  : 'border-2 border-border bg-surface-light',
                interactive && 'group-hover:ring-4 group-hover:ring-primary/20',
              )}
            >
              {stage.reached ? (
                <Check className="h-4 w-4" strokeWidth={2.5} />
              ) : stage.current ? (
                <div className="h-2.5 w-2.5 rounded-full bg-on-fill" />
              ) : (
                <div className="h-2 w-2 rounded-full bg-border" />
              )}
            </div>
          );

          const label = (
            <span
              className={cn(
                'mt-2 text-center text-xs font-semibold leading-tight max-w-[88px]',
                stage.reached || stage.current ? 'text-text-primary' : 'text-text-secondary font-medium',
              )}
            >
              {stage.label}
              {dateStr && (
                <span className="block text-[11px] font-normal text-text-secondary mt-0.5">{dateStr}</span>
              )}
            </span>
          );

          return (
            <div key={stage.key} className="relative flex flex-1 flex-col items-center">
              {/* Connector to the next node — sits behind the circles and spans
                  exactly one cell (this node's centre → the next node's centre),
                  so spacing is identical between every pair of steps. */}
              {!isLast && (
                <div
                  aria-hidden="true"
                  className={cn(
                    'absolute top-4 left-1/2 h-0.5 w-full -translate-y-1/2',
                    stage.reached ? 'bg-success' : 'bg-border',
                  )}
                />
              )}

              {interactive ? (
                // Left raw: wraps a composite lifecycle node (circle + label), a
                // heterogeneous click target, not Button-shaped.
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => onNodeClick(stage.key as ActionableNodeKey)}
                  className="group flex flex-col items-center rounded-control focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary disabled:opacity-60"
                >
                  {circle}
                  {label}
                </button>
              ) : (
                <>
                  {circle}
                  {label}
                </>
              )}

              {/* Start sits UNDER the On Site node rather than becoming a seventh node, so the
                  bar stays at six. IN_PROGRESS is load-bearing — double-booking detection, the
                  board query and styling, and the dashboard KPIs all read it. */}
              {stage.key === 'on_site' && canStart && onStartClick && (
                <Button
                  size="sm"
                  variant="solid" tone="business"
                  className="mt-2"
                  disabled={busy}
                  onClick={onStartClick}
                >
                  Start
                </Button>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
