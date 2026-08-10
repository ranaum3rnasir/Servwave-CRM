/**
 * Shared comm-timeline row (slice E6) — the single renderer behind the Job,
 * Customer and Lead page Communication tabs, consolidating their drifted
 * markup. Standard line:
 *
 *   channel icon · title [auto·transactional] [StateChip] ·············· time
 *   preview
 *   direction · who [· answered by X (calls)] [· meta] ··· [lead chip][job chip]
 *
 * Chips are navigable: the job pill links to /jobs/:id (via CommRowJobControl,
 * which upgrades call/sms/email pills to the attach/move/detach menu when gated) and
 * the NEW lead chip links to /leads/:id — each suppressing the self-link on
 * its own entity page. The hosting tab keeps its own list chrome + timestamp
 * formatter via props.
 */
import { Link } from 'react-router-dom';
import { cn } from '@/lib/utils';
import type { CommItem } from '@/lib/api/jobCommunications';
import { ChannelIcon, LeadBadge, StateChip } from './atoms';
import { CommRowJobControl } from './CommRowJobControl';
import { EmailDeliveryPill } from './EmailDeliveryPill';

interface CommRowProps {
  item: CommItem;
  /** The hosting tab's timestamp formatter (relative on the job tab, absolute elsewhere). */
  formatTimestamp: (at: string) => string;
  /** Job page id — its own rows show a plain job pill (no self-link). */
  currentJobId?: string;
  /** Lead page id — its own rows show a plain lead chip (no self-link). */
  currentLeadId?: string;
  /** Customer scope powering the attach/move/detach menu on call/sms/email rows. */
  customerId?: string;
  /** When set, the row becomes a button that opens the detail drawer. Chip
   *  clicks stop propagation, so navigating a job/lead pill never also opens it. */
  onSelect?: (item: CommItem) => void;
  /** Per-tab li chrome (padding / dividers / hover). */
  className?: string;
}

export function CommRow({
  item,
  formatTimestamp,
  currentJobId,
  currentLeadId,
  customerId,
  onSelect,
  className,
}: CommRowProps) {
  const leadChip = item.leadLabel ? (
    item.leadId && item.leadId !== currentLeadId ? (
      <Link
        to={`/leads/${item.leadId}`}
        title={`Open ${item.leadLabel}`}
        className="rounded-pill transition hover:opacity-80"
      >
        <LeadBadge lead={item.leadLabel} />
      </Link>
    ) : (
      <LeadBadge lead={item.leadLabel} />
    )
  ) : null;

  return (
    <li
      className={cn(
        'flex gap-3',
        onSelect && 'cursor-pointer rounded-md transition hover:bg-background-light',
        className,
      )}
      onClick={onSelect ? () => onSelect(item) : undefined}
      onKeyDown={
        onSelect
          ? (e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                onSelect(item);
              }
            }
          : undefined
      }
      role={onSelect ? 'button' : undefined}
      tabIndex={onSelect ? 0 : undefined}
    >
      <div className="mt-0.5">
        <ChannelIcon channel={item.channel} />
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="truncate text-sm font-semibold text-text-primary">{item.title}</span>
          {item.transactional && (
            <span className="shrink-0 rounded-full bg-background-light px-1.5 py-0.5 text-[10px] font-medium text-text-secondary">
              auto · transactional
            </span>
          )}
          <StateChip state={item.state} />
          {/* Delivery fact (slice 5) — sent-email rows only. A bounce/failure
              must never render through StateChip's hardcoded sage; see
              CommItem.deliveryStatus's doc comment. */}
          {item.channel === 'email' && item.direction === 'out' && (
            <EmailDeliveryPill status={item.deliveryStatus} reason={item.deliveryStatusReason} className="shrink-0" />
          )}
          <span
            className="ml-auto shrink-0 text-xs text-text-soft"
            title={new Date(item.at).toLocaleString('en-US')}
          >
            {formatTimestamp(item.at)}
          </span>
        </div>
        <p className="mt-0.5 truncate text-sm text-text-secondary">{item.preview}</p>
        <div className="mt-1 flex items-center gap-2 text-xs text-text-soft">
          <span className="truncate">
            <span className="text-text-secondary/70">
              {item.direction === 'in' ? 'Inbound' : 'Outbound'}
            </span>{' '}
            · {item.who}
          </span>
          {item.answeredBy && <span className="shrink-0">· answered by {item.answeredBy}</span>}
          {item.meta && <span className="shrink-0">· {item.meta}</span>}
          <span
            className="ml-auto flex shrink-0 items-center gap-1.5"
            onClick={(e) => e.stopPropagation()}
          >
            {leadChip}
            <CommRowJobControl item={item} customerId={customerId} currentJobId={currentJobId} />
          </span>
        </div>
      </div>
    </li>
  );
}
