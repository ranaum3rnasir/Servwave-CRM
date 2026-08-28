/**
 * The one schedule-card body, shared by MemberWeekBoard's BoardCard and TechnicianGridView's
 * JobCard.
 *
 * Multi-visit spec (md_files/specs/scheduling/2026-08-17-multi-visit.md) slice S0b. Both cards
 * carried a byte-identical inner column - time range, number/label + badge row, title, customer,
 * address, tag chips - including the same `isWalk ? customer : title` branch in two places. Under
 * multi-visit that branch has to change in every renderer at once, and #1551 is the standing proof
 * of what happens when a duplicated schedule surface is edited in only one of its copies: the v2
 * tree silently reverted a shipped v1 fix. Collapsing it first turns that class of edit into one
 * edit.
 *
 * The wrapper stays with each card: the two genuinely differ there (the grid view is absolutely
 * positioned at a caller-supplied top/height inside an overflow-hidden lane, the week board is
 * content-sized), and forcing one wrapper would mean threading layout props that only one caller
 * ever uses. What is shared is the CONTENT and the colour/danger resolution - which is exactly what
 * multi-visit needs to change.
 *
 * The spec's evidence section claimed three renderers carried this branch; re-derived on
 * 2026-08-17 there are two - `UnassignedBuckets` renders sidebar rows, not event cards. The spec
 * explicitly says to re-derive these counts rather than trust them.
 *
 * CORRECTED 2026-08-19, by driving the real board rather than re-reading the code: two renderers
 * carry THIS BODY, but three renderers paint schedule cards. `ScheduleEvent` in
 * pages/v2/schedule/SchedulePage paints the Standard week view - the board a dispatcher lands on
 * first - from its own JSX, and it was missed because it imports nothing from here. So "collapsed
 * into one body" is not the same claim as "one place to edit a card": anything a dispatcher must
 * read on EVERY board (the S6 visit label was the first) belongs in scheduleModel as a shared
 * derivation both bodies call, not in this file's JSX. See visitLabel there, and the all-three
 * drift guard at the bottom of ScheduleCardBody.test.tsx.
 */
import React from 'react';
import { format } from 'date-fns';
import { AlertTriangle, MapPin } from 'lucide-react';
import { cn } from '@/lib/utils';
import { TagChips } from '@/components/data/TagChips';
import {
  eventDangerState, isCompletedEvent, boardCardScheme, visitLabel, IN_FLIGHT_STATUSES, boardEventStatus,
  type BoardEvent, type ScheduledBoardEvent, type EventDangerState, type BoardCardScheme,
} from './scheduleModel';

/**
 * Everything both cards derive from an event before they can paint it. Resolved once here so the
 * two boards cannot disagree about what "in progress" or "needs crew" looks like.
 */
export interface ScheduleCardVisual {
  needsCrew: boolean;
  doubleBooked: boolean;
  isCompleted: boolean;
  isInProgress: boolean;
  isGhost: boolean;
  scheme: BoardCardScheme;
}

export function scheduleCardVisual(event: BoardEvent, dangerState: EventDangerState): ScheduleCardVisual {
  const status = boardEventStatus(event);
  const isCompleted = isCompletedEvent(event);
  const isInProgress = IN_FLIGHT_STATUSES.has(status ?? '');
  return {
    // The two reds (precedence pre-resolved in eventDangerState; ghosts come back null).
    needsCrew: dangerState === 'needs-crew',
    doubleBooked: dangerState === 'double-booked',
    isCompleted,
    isInProgress,
    isGhost: event.isGhost ?? false,
    // Board-card scheme: a THREE-axis treatment, not a status badge. Precedence is exception
    // state first (needs-crew fill / double-booked outline, applied on each card's wrapper),
    // then completed / in-progress status, then the event-type accent from EVENT_TYPE_META
    // (job=info, walkthrough=warning, service-plan=ai). Red is reserved for the two exception
    // states.
    //
    // This deliberately does NOT resolve through STATUS_REGISTRY. The registry models a single
    // status axis, and this board inverts it on two of its values: completed reads neutral grey
    // here where the registry says success, and the three in-flight statuses read green here
    // where the registry says warning. Resolving per-status through the registry would repaint
    // every scheduled block and delete the event-type language the board legend advertises.
    scheme: boardCardScheme(event.type, isCompleted, isInProgress),
  };
}

/** The shared half of each card's wrapper className - the danger/scheme paint, not the layout. */
export function scheduleCardPaintClass(v: ScheduleCardVisual): string {
  if (v.needsCrew) return 'bg-danger text-on-fill';                    // red FILL - needs crew (state 4)
  if (v.doubleBooked) return 'border-2 border-danger bg-surface-light'; // red OUTLINE - double-booked (D7)
  return cn(v.scheme.bg, v.scheme.accent, v.isGhost ? 'border-l-4 border-dashed' : 'border-l-4');
}

/** Opacity treatment shared by both wrappers; each card merges its own layout style on top. */
export function scheduleCardOpacityStyle(v: ScheduleCardVisual): React.CSSProperties {
  return {
    ...(v.isCompleted && { opacity: 0.5 }),
    ...(v.isGhost && { opacity: 0.55 }),
  };
}

/**
 * A walkthrough's address comes off the denormalized lead fields; a job's off its
 * service_location relation. Spelled once so multi-visit only has to repoint it once.
 */
export function cardAddressText(event: BoardEvent): string {
  if (event.type === 'walkthrough') {
    return [event.raw.service_address_line1, event.raw.service_city, event.raw.service_state]
      .filter(Boolean).join(', ');
  }
  const location = event.raw.service_location as { address?: string; city?: string; state?: string } | null;
  if (!location) return '';
  return location.address
    ? `${location.address}, ${location.city ?? ''}`
    : [location.city, location.state].filter(Boolean).join(', ');
}

export interface ScheduleCardBodyProps {
  /** Narrowed to the placed variant: the body formats start/end, which are non-null only here. */
  event: ScheduledBoardEvent;
  visual: ScheduleCardVisual;
  /**
   * The grid view hides chips on sub-hour cards (it is absolutely positioned inside an
   * overflow-hidden wrapper, so unconditional content clips); the week board is content-sized and
   * always shows them. Caller's call, because only the caller knows its own height budget.
   */
  showTags?: boolean;
  /** Extra content below the shared body - the grid view's rich-media device slot. */
  children?: React.ReactNode;
}

export function ScheduleCardBody({ event, visual, showTags = true, children }: ScheduleCardBodyProps) {
  const { needsCrew, doubleBooked, isInProgress, isGhost, scheme } = visual;
  const isWalk = event.type === 'walkthrough';
  const addressText = cardAddressText(event);

  return (
    <>
      {/* Ghost draft label */}
      {isGhost && (
        <span className="absolute top-1 right-1.5 text-[8px] font-bold uppercase tracking-wider
                         text-info-text/70 bg-info-surface px-1 py-0.5 rounded leading-none">
          draft
        </span>
      )}

      {/* Time range */}
      <p className={cn(
        'text-[10px] leading-none whitespace-nowrap font-medium',
        needsCrew ? 'text-on-fill/85' : 'text-text-soft',
      )}>
        {format(event.start, 'h:mm a')} – {format(event.end, 'h:mm a')}
      </p>

      {/* Job number / label + badges */}
      <div className="flex items-center gap-1 flex-wrap min-w-0">
        <span className={cn('text-[11px] font-bold truncate leading-none', needsCrew ? 'text-on-fill' : scheme.text)}>
          {/* Never `|| event.boardId`: since multi-visit S6 the board id is `jv-<uuid>`, so the
              old fallback would print a UUID on the card. A number-less event shows nothing. */}
          {isWalk ? 'Walkthrough' : event.number}
        </span>
        {/* D13 - which trip this is. Both the condition and the wording come from visitLabel
            in scheduleModel, because the Standard week board renders through a THIRD card
            component that shares no JSX with this one and must say the same words. Only the
            styling below is this renderer's own. */}
        {visitLabel(event) && (
          <span className={cn(
            'text-[9px] font-medium shrink-0 leading-none',
            needsCrew ? 'text-on-fill/85' : 'text-text-soft',
          )}>
            {visitLabel(event)}
          </span>
        )}
        {isWalk && event.number && (
          <span className="text-[9px] text-text-soft font-medium shrink-0 leading-none">{event.number}</span>
        )}
        {needsCrew && (
          <span className="text-[9px] font-bold uppercase tracking-wider text-on-fill/90 shrink-0 leading-none">
            needs crew
          </span>
        )}
        {doubleBooked && (
          <span className="inline-flex items-center gap-0.5 text-[9px] font-bold px-1.5 py-0.5
                           rounded-full bg-danger/10 text-danger shrink-0 leading-none">
            <AlertTriangle className="h-2 w-2" /> double-booked
          </span>
        )}
        {isInProgress && (
          <span className="text-[9px] font-bold px-1.5 py-0.5 rounded-full
                           bg-success-surface text-success-text shrink-0 leading-none">
            In Progress
          </span>
        )}
      </div>

      {/* Title (scope-first for jobs; customer for walkthroughs - their title repeats the header) */}
      <p className={cn(
        'text-xs font-semibold truncate leading-tight',
        needsCrew ? 'text-on-fill' : 'text-text-primary',
      )}>
        {isWalk ? event.customer : (event.title || event.customer)}
      </p>
      {!isWalk && event.customer && event.customer !== event.title && (
        <p className="text-[11px] text-text-secondary truncate leading-tight">
          {event.customer}
        </p>
      )}

      {/* Address */}
      {addressText && (
        <p className="text-[10px] text-text-secondary flex items-center gap-0.5 min-w-0 leading-none">
          <MapPin className="h-2.5 w-2.5 shrink-0 text-text-soft" />
          <span className="truncate">{addressText}</span>
        </p>
      )}

      {/* SRVW-58 tag chips */}
      {showTags && <TagChips tags={event.tags} max={2} />}

      {children}
    </>
  );
}

/** Re-exported so callers need one import for the whole card-painting vocabulary. */
export { eventDangerState };
