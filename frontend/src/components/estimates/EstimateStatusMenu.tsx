/**
 * EstimateStatusMenu - the estimate workspace's status pill, as a dropdown.
 *
 * Estimate status is UNORDERED (Spec B1, the same rule Job status follows): every one of the six
 * product statuses is reachable from every other, forward or backward, matching what Workiz lets
 * users do. This component lists all six and offers all six; what it does NOT do is decide which
 * are legal - the page passes that in via `targets`, and the backend is the authority.
 *
 * Every option routes through the free status setter (PATCH /:id/status {status}), except two that
 * first need a reason the setter cannot invent:
 *
 *   DRAFT     PATCH /:id/status {status:'DRAFT'}    (invalidates the customer link, voids signature)
 *   SENT      PATCH /:id/status {status:'SENT'}     (a label - see below)
 *   PENDING   PATCH /:id/status {status:'PENDING'}  (honestly unsigned - see below)
 *   WON       PATCH /:id/status {status:'WON'}      (stamps approved_at, wins the lead, reserves)
 *   DECLINED  DeclineEstimateInternalDialog         (lost_reason is required)
 *   ARCHIVED  CancelEstimateDialog                  (cancellation reason, optional)
 *
 * SENT is a LABEL, not a delivery receipt. It says where the estimate sits in the pipeline; it does
 * not assert that a customer link exists, and picking it mints none. Sent-ness is its own axis,
 * owned by Send / Resend / Mark as sent in the Actions menu. This row used to open MarkSentDialog
 * whenever `public_token` was null, which sent every token-less WON/DECLINED/ARCHIVED estimate into
 * an endpoint that accepts DRAFT only - offered, then refused.
 *
 * PENDING used to be permanently disabled here, and the reason was real: it means "customer
 * approved AND signed, deposit outstanding" (D6), `approvePublic` is the only path that captures a
 * signature, and that route decided "already signed, skip capture" from `status === 'PENDING'`
 * alone - so a staff-set PENDING could have reached WON with no signature on file. That check is
 * now keyed on `signature_data != null`, so a hand-set PENDING is still asked to sign and the
 * transition is safe to offer.
 *
 * Only ONE rule still disables a row: the money trail. A won estimate whose job is already
 * invoiced, or whose deposit carries payments, cannot be unwound - the page computes that and
 * passes the explanation as `reason`. Ordering is never a reason any more.
 *
 * `void-approval` still keeps its own explicit home in the Actions menu: it is the guarded,
 * audited admin unwind with its own notification verb, not merely a status change.
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
  /** Optional only so a disabled row need not carry a handler; the page supplies one for all six. */
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
              // `reason` explains a refusal, so only a refusing row shows it. The page hands a
              // reason to every target (it computes one alongside `enabled` for all six), so
              // rendering it unconditionally told users they lacked permission for moves they were
              // about to successfully make.
              title={isCurrent ? 'Current status' : enabled ? undefined : entry.reason}
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
