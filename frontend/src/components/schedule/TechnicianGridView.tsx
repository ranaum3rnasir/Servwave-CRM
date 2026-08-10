import React, { useState } from 'react';
import { format, isSameDay, setHours, setMinutes, addHours } from 'date-fns';
import { AlertTriangle, MapPin, Loader2 } from 'lucide-react';
import { cn, getInitials } from '@/lib/utils';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { EmptyState } from '@/components/ui/empty-state';
import {
  isOnBoardFor, eventDangerState, isCompletedEvent, boardCardScheme, IN_FLIGHT_STATUSES,
  type BoardEvent, type ScheduledBoardEvent, type EventDangerState,
} from './scheduleModel';
import {
  GRID_EVENT_ID, GRID_EVENT_TYPE, FROM_MEMBER,
  hasBoardDragPayload, resolveBoardDropId,
} from './dragChannels';
import { TagChips } from '@/components/data/TagChips';
import { asWallClock, type WallClock } from '@/lib/schedule-tz';

// ─── Types ───────────────────────────────────────────────

interface TechUser {
  id: string;
  first_name: string;
  last_name: string;
  is_active: boolean;
  role?: string;
  avatar_url?: string | null;
}

interface TechnicianGridViewProps {
  date: WallClock;
  members: TechUser[];
  events: BoardEvent[];
  conflictIds: Set<string>;
  isLoading: boolean;
  draggingJobIdRef: React.MutableRefObject<string | null>;
  /** `fromMember` = the lane a BOARD card was dragged from (null for bucket cards) — TG10 swap. */
  onDropJob: (jobId: string, techId: string, start: WallClock, end: WallClock, fromMember: string | null) => void;
  onSelectJob: (jobId: string) => void;
  onGhostContextMenu?: (ghostId: string, x: number, y: number) => void;
  onEventClick?: (event: BoardEvent, x: number, y: number) => void;
  onEventContextMenu?: (event: BoardEvent, x: number, y: number) => void;
}

// ─── Grid Constants ───────────────────────────────────────

const START_HOUR  = 6;    // 6:00 AM
const END_HOUR    = 20;   // 8:00 PM
const ROW_H       = 96;   // px per hour — h-24 equivalent, enough room for card content
const COL_W       = 280;  // px per technician column — min-w-[280px]
const TIME_W      = 72;   // px for time axis
const TECH_H      = 72;   // px for header row

// [6,7,8,...,20] = 15 labels, 14 one-hour intervals
const HOURS = Array.from({ length: END_HOUR - START_HOUR + 1 }, (_, i) => i + START_HOUR);
const GRID_HEIGHT = (HOURS.length - 1) * ROW_H; // 14 * 96 = 1344px

// ─── Helpers ──────────────────────────────────────────────

function timeToPixels(date: Date): number {
  const h = date.getHours() + date.getMinutes() / 60;
  return Math.max(0, (h - START_HOUR) * ROW_H);
}

function durationToPixels(start: Date, end: Date): number {
  const hours = (end.getTime() - start.getTime()) / (1000 * 60 * 60);
  return Math.max(ROW_H * 0.5, hours * ROW_H) - 2; // -2px inter-card gap
}

function formatHour(h: number): string {
  if (h === 12) return '12 PM';
  if (h > 12)   return `${h - 12} PM`;
  return `${h} AM`;
}

// ─── TechAvatar ───────────────────────────────────────────

function TechAvatar({ tech }: { tech: TechUser }) {
  return (
    <Avatar ring="stack" size="sm">
      {tech.avatar_url && (
        <AvatarImage src={tech.avatar_url} alt={`${tech.first_name} ${tech.last_name}`} className="object-cover" />
      )}
      <AvatarFallback tone="solid" className="text-xs font-bold">
        {getInitials(`${tech.first_name} ${tech.last_name}`)}
      </AvatarFallback>
    </Avatar>
  );
}

// ─── JobCard ──────────────────────────────────────────────

interface JobCardProps {
  event: ScheduledBoardEvent;
  /** The lane this card is rendered in — emitted as the `from-member` drag marker (TG10 swap). */
  fromMemberId: string;
  dangerState: EventDangerState;
  onClick: (e: React.MouseEvent) => void;
  onContextMenu?: (e: React.MouseEvent) => void;
  topPx: number;
  heightPx: number;
}

function JobCard({ event, fromMemberId, dangerState, onClick, onContextMenu, topPx, heightPx }: JobCardProps) {
  const location   = event.raw.service_location as { address?: string; city?: string; state?: string } | null;
  const deviceImg  = event.raw.device_image as string | null;
  const deviceName = event.raw.device_name as string | null;
  const status     = event.raw.status as string | undefined;
  const isWalk     = event.type === 'walkthrough';
  const isInProg   = IN_FLIGHT_STATUSES.has(status ?? '');
  const isCompleted = isCompletedEvent(event);
  // The two reds (precedence pre-resolved in eventDangerState; ghosts come back null).
  const needsCrew    = dangerState === 'needs-crew';
  const doubleBooked = dangerState === 'double-booked';

  // Build address — for walkthroughs use lead fields, for jobs use service_location
  let addressText = '';
  if (isWalk) {
    addressText = [event.raw.service_address_line1, event.raw.service_city, event.raw.service_state]
      .filter(Boolean).join(', ');
  } else if (location) {
    addressText = location.address
      ? `${location.address}, ${location.city ?? ''}`
      : [location.city, location.state].filter(Boolean).join(', ');
  }

  // ── Color scheme ── a THREE-axis board treatment, not a status badge. Precedence is
  // exception state first (needs crew / double booked, applied on the wrapper below and
  // pre-resolved in eventDangerState), then completed / in-progress status, then the
  // event-type accent. Red is reserved for the two exception states.
  //
  // Resolved by boardCardScheme in scheduleModel.ts, the one place this treatment is now
  // spelled; this card previously inlined a copy byte-identical to the one in
  // MemberWeekBoard's BoardCard, which now resolves through the same helper. See it for
  // why this deliberately does NOT resolve through STATUS_REGISTRY: the board inverts the
  // registry on completed and on the three in-flight statuses, and resolving per status
  // would delete the event-type language the board legend advertises to the user.
  const scheme = boardCardScheme(event.type, isCompleted, isInProg);

  const showDeviceMedia = !!deviceImg && heightPx > 140;
  const showAddress     = !!addressText;
  // SRVW-58 tag chips. This card - unlike the other two renderers - is absolutely
  // positioned at a caller-supplied heightPx inside an overflow-hidden wrapper, and
  // its inner column is flex with default flex-shrink, so unconditional extra content
  // clips either the chips or the address above them. Same height-gating policy the
  // showDeviceMedia line above already sets.
  //
  // The threshold is ROW_H - 2, not ROW_H, because durationToPixels subtracts the 2px
  // inter-card gap: a one-hour card is 94px, so `>= ROW_H` would hide chips on every
  // exactly-one-hour card - including the DEFAULT walkthrough, one of the two things
  // this feature is for. Chips hide only on sub-hour cards, which floor at
  // ROW_H * 0.5 - 2 = 46px.
  const showTags = (event.tags?.length ?? 0) > 0 && heightPx >= ROW_H - 2;

  const isGhost = event.isGhost ?? false;

  return (
    <div
      className={cn(
        'absolute inset-x-1.5 rounded-lg overflow-hidden cursor-pointer',
        'transition-all duration-100',
        'hover:shadow-md hover:brightness-[0.97] active:scale-[0.99]',
        needsCrew
          ? 'bg-danger text-on-fill'                // red FILL — needs crew (state 4)
          : doubleBooked
          ? 'border-2 border-danger bg-surface-light'     // red OUTLINE — double-booked (D7)
          : cn(scheme.bg, scheme.accent, isGhost ? 'border-l-4 border-dashed' : 'border-l-4'),
      )}
      style={{
        top:        topPx,
        height:     heightPx,
        zIndex:     5,
        ...(isCompleted && { opacity: 0.5 }),
        ...(isGhost && { opacity: 0.55 }),
      }}
      draggable
      onDragStart={(e) => {
        // Same payload keys as MemberWeekBoard's BoardCard — incl. the from-member lane
        // marker so a cross-lane drop can swap (TG10). Codec constants only.
        e.dataTransfer.setData(GRID_EVENT_ID, event.id);
        e.dataTransfer.setData(GRID_EVENT_TYPE, event.type);
        e.dataTransfer.setData(FROM_MEMBER, fromMemberId);
        e.dataTransfer.effectAllowed = 'move';
      }}
      onDragEnd={() => {/* no-op; parent manages state */}}
      onClick={(e) => { e.stopPropagation(); onClick(e); }}
      onContextMenu={onContextMenu}
    >
      <div className="px-2.5 py-2 h-full flex flex-col gap-1 overflow-hidden relative">

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
            {isWalk ? 'Walkthrough' : (event.number || event.id)}
          </span>
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
          {isInProg && (
            <span className="text-[9px] font-bold px-1.5 py-0.5 rounded-full
                             bg-success-surface text-success-text shrink-0 leading-none">
              In Progress
            </span>
          )}
        </div>

        {/* Title (scope-first for jobs; customer for walkthroughs — their title repeats the header) */}
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
        {showAddress && (
          <p className="text-[10px] text-text-secondary flex items-center gap-0.5 min-w-0 leading-none">
            <MapPin className="h-2.5 w-2.5 shrink-0 text-text-soft" />
            <span className="truncate">{addressText}</span>
          </p>
        )}

        {/* Tag chips - hidden on sub-hour cards (see showTags above) */}
        {showTags && <TagChips tags={event.tags} max={2} />}

        {/* Rich-media device slot — visible when card is tall enough */}
        {showDeviceMedia && (
          <div className="mt-1 flex-1 flex gap-2 items-start overflow-hidden rounded-md
                          border border-border bg-surface-light/70 px-2 py-1.5 min-h-0">
            <img
              src={deviceImg!}
              alt={deviceName ?? 'Device'}
              className="h-10 w-10 object-contain shrink-0 rounded"
            />
            <div className="flex flex-col justify-center min-w-0 gap-0.5">
              {deviceName && (
                <p className="text-[11px] font-semibold text-text-primary truncate leading-tight">
                  {deviceName}
                </p>
              )}
              <div className="flex items-center gap-1">
                <span className="h-2 w-2 rounded-full bg-success-strong shrink-0 shadow-[0_0_4px_rgb(var(--success)/0.6)]" />
                <span className="text-[10px] text-success-text font-medium">connected</span>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// ─── TechColumn ───────────────────────────────────────────

interface TechColumnProps {
  tech: TechUser;
  /** This member's same-day scheduled events — pre-filtered by the parent (one predicate). */
  events: ScheduledBoardEvent[];
  conflictIds: Set<string>;
  date: WallClock;
  draggingJobIdRef: React.MutableRefObject<string | null>;
  onDropJob: (jobId: string, techId: string, start: WallClock, end: WallClock, fromMember: string | null) => void;
  onSelectJob: (jobId: string) => void;
  onGhostContextMenu?: (ghostId: string, x: number, y: number) => void;
  onEventClick?: (event: BoardEvent, x: number, y: number) => void;
  onEventContextMenu?: (event: BoardEvent, x: number, y: number) => void;
}

function TechColumn({
  tech, events, conflictIds, date,
  draggingJobIdRef, onDropJob, onSelectJob, onGhostContextMenu,
  onEventClick, onEventContextMenu,
}: TechColumnProps) {
  const [dragOverHour, setDragOverHour] = useState<number | null>(null);

  const idle = events.length === 0;

  return (
    <div
      className="relative border-r border-border shrink-0 bg-surface-light"
      style={{ width: COL_W, height: GRID_HEIGHT }}
    >
      {/* Alternating row backgrounds for even/odd hours */}
      {HOURS.slice(0, -1).map((_, i) => (
        <div
          key={i}
          className={cn(
            'absolute w-full border-b border-border pointer-events-none',
            i % 2 === 1 ? 'bg-background-light/40' : 'bg-surface-light',
          )}
          style={{ top: i * ROW_H, height: ROW_H }}
        />
      ))}

      {/* D3 — idle column: ocean-tinted hatch + hint. Purely decorative (pointer-events-none);
          the per-hour drop zones below keep the column fully droppable. Never hidden. */}
      {idle && (
        <>
          <div
            className="absolute inset-0 pointer-events-none
                       bg-[repeating-linear-gradient(45deg,transparent,transparent_10px,theme(colors.primary.subtle/45%)_10px,theme(colors.primary.subtle/45%)_20px)]"
          />
          <div className="pointer-events-none absolute inset-x-0 top-16 text-center text-[11px] italic text-text-secondary">
            available
            <br />
            (drop work here)
          </div>
        </>
      )}

      {/* Drop zones — one per hour slot */}
      {HOURS.slice(0, -1).map((h, i) => (
        <div
          key={h}
          className={cn(
            'absolute inset-x-1 rounded-lg transition-all duration-150',
            dragOverHour === h
              ? 'border-2 border-dashed border-info-border bg-info-surface z-10 shadow-inner'
              : 'border-2 border-transparent',
          )}
          style={{ top: i * ROW_H + 2, height: ROW_H - 4 }}
          data-testid={`grid-slot-${tech.id}-${h}`}
          onDragOver={(e) => {
            if (hasBoardDragPayload(e.dataTransfer.types)) {
              e.preventDefault();
              e.dataTransfer.dropEffect = 'move';
              setDragOverHour(h);
            }
          }}
          onDragLeave={(e) => {
            if (!e.currentTarget.contains(e.relatedTarget as Node)) {
              setDragOverHour(null);
            }
          }}
          onDrop={(e) => {
            e.preventDefault();
            setDragOverHour(null);
            // Codec-normalized BOARD id — the walkthrough channel's bare lead id gets
            // its wt- prefix restored so the page can't mistake it for a job id.
            const resolvedId = resolveBoardDropId(e.dataTransfer, draggingJobIdRef.current);
            if (!resolvedId) return;
            // setHours/setMinutes/addHours always return a plain Date, even given a
            // WallClock input — re-assert the brand (date is already wall-clock space).
            const startDate = asWallClock(setMinutes(setHours(date, h), 0));
            const endDate   = asWallClock(addHours(startDate, 2));
            // BOARD cards carry the lane they came from — the page classifies the drop
            // (cross-lane = swap / same-lane = reschedule). Bucket cards carry none → null.
            const fromMember = e.dataTransfer.getData(FROM_MEMBER) || null;
            onDropJob(resolvedId, tech.id, startDate, endDate, fromMember);
          }}
        >
          {/* Landing-zone label — only visible during drag-over */}
          {dragOverHour === h && (
            <div className="h-full flex items-center justify-center pointer-events-none">
              <span className="text-[10px] text-info-text font-semibold tracking-wide">
                Drop here · {formatHour(h)}
              </span>
            </div>
          )}
        </div>
      ))}

      {/* Positioned job / walkthrough cards */}
      {events.map((ev) => (
        <JobCard
          key={ev.id}
          event={ev}
          fromMemberId={tech.id}
          dangerState={eventDangerState(ev, conflictIds)}
          onClick={(e) => {
            if (onEventClick) {
              onEventClick(ev, e.clientX, e.clientY);
            } else if (ev.type === 'job' && !ev.isGhost) {
              onSelectJob(ev.id);
            }
          }}
          onContextMenu={
            ev.isGhost && ev.ghostId && onGhostContextMenu
              ? (e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  onGhostContextMenu(ev.ghostId!, e.clientX, e.clientY);
                }
              : onEventContextMenu
              ? (e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  onEventContextMenu(ev, e.clientX, e.clientY);
                }
              : undefined
          }
          topPx={timeToPixels(ev.start)}
          heightPx={durationToPixels(ev.start, ev.end)}
        />
      ))}
    </div>
  );
}

// ─── TechnicianGridView (main export) ─────────────────────

export function TechnicianGridView({
  date,
  members,
  events,
  conflictIds,
  isLoading,
  draggingJobIdRef,
  onDropJob,
  onSelectJob,
  onGhostContextMenu,
  onEventClick,
  onEventContextMenu,
}: TechnicianGridViewProps) {
  const activeTechs   = members.filter((t) => t.is_active);
  const totalMinWidth = TIME_W + activeTechs.length * COL_W;

  // D1 — crew membership, not single ownership: a 2-crew event renders in BOTH columns.
  // Computed once per member so the header (idle tint) and the column share one filter;
  // members with zero events keep a full droppable column (D3 — no hide-empty anywhere).
  const columns = activeTechs.map((tech) => ({
    tech,
    events: events.filter(
      (ev): ev is ScheduledBoardEvent =>
        ev.start !== null && ev.end !== null && isOnBoardFor(ev, tech.id) && isSameDay(ev.start, date),
    ),
  }));

  return (
    <div className="h-full overflow-x-auto overflow-y-auto relative bg-background-light">

      {/* Loading overlay */}
      {isLoading && (
        <div className="absolute inset-0 z-50 bg-surface-light/70 flex items-center justify-center pointer-events-none">
          <Loader2 className="h-8 w-8 animate-spin text-primary" />
        </div>
      )}

      {/* Content wrapper — enforces rigid min-width so columns never collapse */}
      <div style={{ minWidth: totalMinWidth }}>

        {/* ── Sticky Technician Header Row ─────────────────── */}
        <div className="flex sticky top-0 z-30 bg-surface-light border-b border-border shadow-sm">

          {/* Corner cell — sticky on both axes */}
          <div
            className="sticky left-0 z-40 bg-surface-light border-r border-border shrink-0"
            style={{ width: TIME_W, height: TECH_H }}
          />

          {/* Per-technician header cells — idle members get a soft ocean tint (D3) */}
          {columns.map(({ tech, events: techEvents }) => (
            <div
              key={tech.id}
              className={cn(
                'border-r border-border flex items-center gap-3 px-3 shrink-0',
                techEvents.length === 0 && 'bg-primary-subtle/30',
              )}
              style={{ width: COL_W, height: TECH_H }}
            >
              <TechAvatar tech={tech} />
              <div className="min-w-0">
                <p className="text-sm font-semibold text-text-primary truncate leading-tight">
                  {tech.first_name} {tech.last_name}
                </p>
                <p className="text-xs text-text-secondary truncate mt-0.5">
                  {tech.role ?? 'Technician'}
                </p>
              </div>
            </div>
          ))}
        </div>

        {/* ── Grid Body ──────────────────────────────────────── */}
        <div className="flex">

          {/* Time axis — sticky left */}
          <div
            className="sticky left-0 z-20 bg-surface-light border-r border-border shrink-0"
            style={{ width: TIME_W }}
          >
            {HOURS.map((h) => (
              <div
                key={h}
                className="border-b border-border flex items-start pt-2 px-2"
                style={{ height: ROW_H }}
              >
                <span className="text-xs text-text-soft font-medium leading-none whitespace-nowrap">
                  {formatHour(h)}
                </span>
              </div>
            ))}
          </div>

          {/* Technician columns */}
          {columns.length > 0 ? (
            columns.map(({ tech, events: techEvents }) => (
              <TechColumn
                key={tech.id}
                tech={tech}
                events={techEvents}
                conflictIds={conflictIds}
                date={date}
                draggingJobIdRef={draggingJobIdRef}
                onDropJob={onDropJob}
                onSelectJob={onSelectJob}
                onGhostContextMenu={onGhostContextMenu}
                onEventClick={onEventClick}
                onEventContextMenu={onEventContextMenu}
              />
            ))
          ) : (
            <EmptyState density="roomy" title="No active staff members found." className="flex-1" />
          )}
        </div>
      </div>
    </div>
  );
}
