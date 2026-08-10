/**
 * EstimateStatusMenu - the estimate workspace's status pill, as a dropdown.
 *
 * Lists all six product statuses so the lifecycle is legible at a glance, but only offers the ones
 * legally reachable from where the estimate is now. Every option routes to the endpoint that
 * ALREADY owns that transition - this component adds no new way to change a status, it just puts
 * the existing ones behind the pill instead of only inside the Actions menu:
 *
 *   DRAFT     PATCH /:id/status {backtodraft}   (SENT/PENDING only)
 *   SENT      MarkSentDialog (from DRAFT) · PATCH /:id/status {backtosent} (from PENDING)
 *   PENDING   nothing - see below
 *   WON       POST /:id/approve-internal
 *   DECLINED  DeclineEstimateInternalDialog -> POST /:id/decline-internal
 *   ARCHIVED  CancelEstimateDialog -> POST /:id/cancel
 *
 * PENDING is never selectable, by design and not by omission. It means "customer approved AND
 * signed, deposit outstanding" (D6), and `approvePublic` is the only path that captures a
 * signature. A staff-set SENT->PENDING would manufacture that state with `signature_data` null,
 * and approvePublic's `isPaymentRetry` branch treats PENDING as already-signed and never
 * re-prompts - so the estimate could reach WON with no signature on file. The backend enforces
 * this too (`STATUS_TRANSITIONS` has no such entry); the disabled row exists to explain the
 * absence rather than leave a hole the reader has to infer.
 *
 * Unwinding a WON estimate is deliberately NOT here: that is `void-approval`, a guarded admin-only
 * destructive action that keeps its explicit home in the Actions menu.
 */
import { ChevronDown } from 'lucide-react';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { StatusBadge } from '@/components/data/status-badge';
import { ESTIMATE_STATUS, type EstimateStatusValue } from '@/constants/estimateStatus';

/** The order the statuses are listed in - the lifecycle, not the reachability. */
const STATUS_ORDER: EstimateStatusValue[] = [
  ESTIMATE_STATUS.DRAFT,
  ESTIMATE_STATUS.SENT,
  ESTIMATE_STATUS.PENDING,
  ESTIMATE_STATUS.WON,
  ESTIMATE_STATUS.DECLINED,
  ESTIMATE_STATUS.ARCHIVED,
];

export interface EstimateStatusTarget {
  enabled: boolean;
  /** Shown as the disabled row's tooltip - why this status is not reachable right now. */
  reason?: string;
  /** Omitted for a target that is never selectable (PENDING). */
  onSelect?: () => void;
}

export interface EstimateStatusMenuProps {
  status: string;
  /** Renders the pill inert - a terminal or locked estimate has nothing to offer. */
  readOnly?: boolean;
  /**
   * Per-target availability, computed by the page from the SAME capability flags its Actions-menu
   * items use. `true` means selectable; `false` renders the row disabled with `reason`.
   * Every status is required, so adding one to ESTIMATE_STATUS is a compile error here rather
   * than a row that silently goes missing.
   */
  targets: Record<EstimateStatusValue, EstimateStatusTarget>;
}

export function EstimateStatusMenu({ status, readOnly, targets }: EstimateStatusMenuProps) {
  const badge = <StatusBadge domain="estimate" status={status} size="lg" />;

  if (readOnly) return badge;

  return (
    <DropdownMenu>
      {/* asChild + a native button: appearance classes belong on the element, not on the
          DropdownMenuTrigger primitive (design-system layering guard), and it matches how the
          Actions menu on this page builds its trigger. */}
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          className="flex items-center gap-1 rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          aria-label={`Status: ${status}. Change status`}
        >
          {badge}
          <ChevronDown className="h-4 w-4 text-text-secondary" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-56">
        {STATUS_ORDER.map((target) => {
          const entry = targets[target];
          const isCurrent = target === status;
          const enabled = !isCurrent && entry.enabled;

          return (
            <DropdownMenuItem
              key={target}
              disabled={!enabled}
              title={isCurrent ? 'Current status' : entry.reason}
              onClick={enabled ? entry.onSelect : undefined}
            >
              <StatusBadge domain="estimate" status={target} />
              {isCurrent && <span className="ml-auto text-xs text-text-secondary">Current</span>}
            </DropdownMenuItem>
          );
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
