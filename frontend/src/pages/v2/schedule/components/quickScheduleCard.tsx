import { Search, XCircle, CheckCircle2, MapPin, CalendarPlus } from 'lucide-react';
import { useState } from 'react';

import { TimeSelect } from '../../_shared/timeSelect';

import { isoToHHmm, withTime, slotTimeLabel } from '@/components/schedule/slotPopoverTime';

import { Button } from '@/ui-kit/components/ui/button';
import { Input } from '@/ui-kit/components/ui/input';

import { EM, EN } from '../glyphs';
import { Segment, SegmentedGroup } from './segmented';

interface QuickScheduleCardProps {
  x: number;
  y: number;
  startTime: string; // ISO string
  endTime: string;   // ISO string
  /**
   * The ORG's scheduling zone. Required, not optional: this popover both reads and
   * WRITES a visit window, and the fork that made it implicit resolved every time
   * against the booker's browser instead (MV-TZ-02).
   */
  tz: string;
  unassignedJobs: Record<string, unknown>[];
  unscheduledWalkthroughs: Record<string, unknown>[];
  onSelectJob: (jobId: string) => void;
  onSelectWalkthrough: (leadId: string) => void;
  onClose: () => void;
  onTimeChange?: (startISO: string, endISO: string) => void;
  /**
   * False when the org lacks the `leads` entitlement - the tab is not offered
   * rather than shown empty. `unscheduledWalkthroughs` is [] there only because
   * the query was disabled, so "No walkthroughs to schedule" would be the same
   * false claim the Unassigned bucket used to make about rows never fetched.
   */
  showWalkthroughs?: boolean;
  /**
   * QA finding 3 (slice 05, calendar-entries spec §3 "What to build") - lets the caller offer
   * "New Event" alongside the existing job/walkthrough picks. Omitted entirely on the regular
   * TIMED slot popover, which only the all-day one wires - a calendar entry is created fresh,
   * never picked from an existing unattached list the way a job/walkthrough is, so it is a
   * persistent action row rather than a third tab with its own search/list.
   */
  onCreateEvent?: () => void;
}

type ActiveTab = 'jobs' | 'walkthroughs';

// The 260x360 footprint and the 8px viewport clamp are what the popover's
// position assertions ride on. Keep both.
const CARD_WIDTH = 260;
const CARD_HEIGHT = 360;

function safeLeft(x: number): number {
  return Math.min(x, window.innerWidth - CARD_WIDTH - 8);
}

function safeTop(y: number): number {
  return Math.min(y, window.innerHeight - CARD_HEIGHT - 8);
}

/**
 * Where the calendar's own chrome ends: the app bar, the toolbar and the
 * day-header row all sit above `.rbc-time-header`'s bottom edge (`.rbc-month-
 * header`'s, in month view). The time lists are told to keep out of that band.
 *
 * A 96-item list is always taller than the space it has, so it always runs to
 * the edge of whatever boundary it is given - and the viewport edge is the
 * wrong boundary here. The day header is what tells you WHICH day the time you
 * are picking belongs to; a list that paints over it takes that away at exactly
 * the moment it is being used. 8px of air below the header keeps the two
 * visibly separate rather than flush.
 */
function calendarChromeBottom(): number {
  const header = document.querySelector('.schedule-cal .rbc-time-header, .schedule-cal .rbc-month-header');
  return header ? Math.round(header.getBoundingClientRect().bottom) + 8 : 8;
}

/**
 * The empty-slot popover: click a free slot (or, outside week view, a day
 * header) and pick something to drop into it.
 *
 * Picking a JOB opens AssignJobDialog pre-filled; picking a WALKTHROUGH fires
 * the reschedule mutation immediately at the org default duration. Both of those
 * are the page's callbacks and are untouched, as is the native CSS `resize:
 * both` handle, the 240-520 x 260-85vh clamp, and the `fixed` + `z-[...]` class
 * pair the page's outside-click listener matches on.
 *
 * `TimeSelect` stays: the kit ships a date picker but no TIME picker, and this
 * one is a Radix Select whose portalled content the page's outside-click
 * listener already whitelists by `[data-radix-popper-content-wrapper]`. Swapping
 * it for a native time input would break that whitelist and close the popover
 * every time a time was picked. Recorded as a gap.
 */
export function QuickScheduleCard({
  x,
  y,
  startTime,
  endTime,
  tz,
  unassignedJobs,
  unscheduledWalkthroughs,
  onSelectJob,
  onSelectWalkthrough,
  onClose,
  onTimeChange,
  showWalkthroughs = true,
  onCreateEvent,
}: QuickScheduleCardProps) {
  const [activeTab, setActiveTab] = useState<ActiveTab>('jobs');
  const [query, setQuery] = useState('');

  const left = safeLeft(x);
  const top = safeTop(y);
  const timeListPadding = { top: calendarChromeBottom(), right: 8, bottom: 8, left: 8 };

  const timeLabel = slotTimeLabel(startTime, endTime, tz);

  const q = query.trim().toLowerCase();

  const filteredJobs = unassignedJobs.filter((job) => {
    if (!q) return true;
    const jobNumber = ((job.job_number as string | undefined) ?? '').toLowerCase();
    const customerObj = job.customer as { first_name?: string; last_name?: string; company_name?: string } | null;
    const customerName = customerObj
      ? `${customerObj.first_name ?? ''} ${customerObj.last_name ?? ''} ${customerObj.company_name ?? ''}`.toLowerCase()
      : '';
    return jobNumber.includes(q) || customerName.includes(q);
  });

  const filteredWalkthroughs = unscheduledWalkthroughs.filter((wt) => {
    if (!q) return true;
    const leadNumber = ((wt.lead_number as string | undefined) ?? '').toLowerCase();
    const customerObj = wt.customer as { first_name?: string; last_name?: string; company_name?: string } | null;
    const customerName = customerObj
      ? `${customerObj.first_name ?? ''} ${customerObj.last_name ?? ''} ${customerObj.company_name ?? ''}`.toLowerCase()
      : '';
    return leadNumber.includes(q) || customerName.includes(q);
  });

  const activeItems = activeTab === 'jobs' ? filteredJobs : filteredWalkthroughs;
  const searchPlaceholder = activeTab === 'jobs' ? 'Search jobs...' : 'Search walkthroughs...';
  const emptyLabel = activeTab === 'jobs' ? 'No unscheduled jobs' : 'No walkthroughs to schedule';

  return (
    <div
      data-schedule-overlay=""
      className="fixed z-surface-raised bg-kit-popover border overflow-hidden rounded-xl shadow-popover schedule-popup-enter"
      style={{
        left,
        top,
        width: CARD_WIDTH,
        height: CARD_HEIGHT,
        resize: 'both',
        minWidth: 240,
        minHeight: 260,
        maxWidth: 520,
        maxHeight: '85vh',
        display: 'flex',
        flexDirection: 'column',
      }}
      onClick={(e) => e.stopPropagation()}
    >
      {/* ── Header ────────────────────────────────────────── */}
      <div className="px-3 py-2.5 bg-muted border-b flex items-center justify-between gap-2 shrink-0">
        <div className="min-w-0">
          <p className="text-xs font-bold leading-none">Schedule</p>
          {onTimeChange ? (
            <div className="flex items-center gap-1 mt-1 min-w-0">
              <TimeSelect
                value={isoToHHmm(startTime, tz)}
                onChange={(v) => {
                  // The "Select time..." empty option - ignore it, withTime('') throws.
                  if (!v) return;
                  onTimeChange(withTime(startTime, v, tz), endTime);
                }}
                className="h-6 w-auto min-w-0 px-1 text-[11px] rounded-md"
                collisionPadding={timeListPadding}
              />
              <span className="text-[11px] text-muted-foreground">{EN}</span>
              <TimeSelect
                value={isoToHHmm(endTime, tz)}
                onChange={(v) => {
                  if (!v) return;
                  onTimeChange(startTime, withTime(endTime, v, tz));
                }}
                className="h-6 w-auto min-w-0 px-1 text-[11px] rounded-md"
                collisionPadding={timeListPadding}
              />
            </div>
          ) : (
            <p className="text-[11px] text-muted-foreground mt-0.5">{timeLabel}</p>
          )}
        </div>
        <Button variant="ghost" size="icon-sm" className="shrink-0" aria-label="Close" onClick={onClose}>
          <XCircle />
        </Button>
      </div>

      {/* ── Tab bar ───────────────────────────────────────── */}
      {/* Not offered at all without the `leads` entitlement; `activeTab` then
          stays pinned to 'jobs' because its only other setter is here. */}
      {showWalkthroughs && (
        <div className="px-2 pt-2 shrink-0">
          <SegmentedGroup className="w-full" aria-label="Schedule what">
            <Segment
              className="flex-1"
              active={activeTab === 'jobs'}
              onClick={() => { setActiveTab('jobs'); setQuery(''); }}
            >
              Jobs
            </Segment>
            <Segment
              className="flex-1"
              active={activeTab === 'walkthroughs'}
              onClick={() => { setActiveTab('walkthroughs'); setQuery(''); }}
            >
              Walkthroughs
            </Segment>
          </SegmentedGroup>
        </div>
      )}

      {/* ── Search input ──────────────────────────────────── */}
      <div className="px-2 pt-2 shrink-0">
        <div className="relative">
          <Search className="absolute left-2 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-subtle-foreground pointer-events-none z-10" />
          <Input
            type="text"
            value={query}
            aria-label={searchPlaceholder}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={searchPlaceholder}
            className="h-8 pl-7 text-xs"
          />
        </div>
      </div>

      {/* ── Results list ──────────────────────────────────── */}
      <div className="flex-1 min-h-0 overflow-y-auto mt-1.5 px-2 pb-2">
        {activeItems.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-6 gap-1.5 text-muted-foreground">
            <CheckCircle2 className="h-5 w-5 text-status-green" />
            <p className="text-xs">{emptyLabel}</p>
          </div>
        ) : (
          <ul className="space-y-0.5">
            {activeTab === 'jobs'
              ? filteredJobs.map((job) => {
                  const id = job.id as string;
                  const jobNumber = (job.job_number as string | undefined) ?? EM;
                  const customerObj = job.customer as { first_name?: string; last_name?: string; company_name?: string } | null;
                  const customerName = customerObj
                    ? (customerObj.company_name || `${customerObj.first_name ?? ''} ${customerObj.last_name ?? ''}`.trim())
                    : '';
                  return (
                    <li key={id}>
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-auto w-full justify-start gap-2 px-2 py-1.5 text-left font-normal"
                        onClick={() => onSelectJob(id)}
                      >
                        <span className="text-xs font-bold text-brand shrink-0">{jobNumber}</span>
                        {customerName && (
                          <span className="text-xs text-muted-foreground truncate flex-1">{customerName}</span>
                        )}
                      </Button>
                    </li>
                  );
                })
              : filteredWalkthroughs.map((wt) => {
                  const id = wt.id as string;
                  const leadNumber = (wt.lead_number as string | undefined) ?? EM;
                  const customerObj = wt.customer as { first_name?: string; last_name?: string; company_name?: string } | null;
                  const customerName = customerObj
                    ? (customerObj.company_name || `${customerObj.first_name ?? ''} ${customerObj.last_name ?? ''}`.trim())
                    : '';
                  const address = [
                    wt.service_address_line1 as string | undefined,
                    wt.service_city as string | undefined,
                    wt.service_state as string | undefined,
                  ]
                    .filter(Boolean)
                    .join(', ');
                  return (
                    <li key={id}>
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-auto w-full flex-col items-start gap-0 px-2 py-1.5 text-left font-normal"
                        onClick={() => onSelectWalkthrough(id)}
                      >
                        <span className="flex w-full items-center gap-2">
                          <span className="text-xs font-bold text-status-amber-emphasis shrink-0">{leadNumber}</span>
                          {customerName && (
                            <span className="text-xs text-muted-foreground truncate">{customerName}</span>
                          )}
                        </span>
                        {address && (
                          <span className="flex w-full items-center gap-1 mt-0.5">
                            <MapPin className="h-3 w-3 text-subtle-foreground shrink-0" />
                            <span className="text-[11px] text-muted-foreground truncate">{address}</span>
                          </span>
                        )}
                      </Button>
                    </li>
                  );
                })}
          </ul>
        )}
      </div>

      {/* ── "New Event" (slice 05, QA finding 3) ── a persistent action, not a third tab:
          an Event is created fresh at this slot, never picked from an existing list the
          way a job/walkthrough is. */}
      {onCreateEvent && (
        <div className="px-2 py-1.5 border-t shrink-0">
          <Button
            variant="ghost"
            size="sm"
            className="h-auto w-full justify-start gap-2 px-2 py-1.5 text-left font-normal"
            onClick={onCreateEvent}
          >
            <CalendarPlus className="h-3.5 w-3.5 text-brand shrink-0" />
            <span className="text-xs">New Event</span>
          </Button>
        </div>
      )}

      {/* Decorative resize-grip glyph - the native CSS resize hit area is beneath it */}
      <div aria-hidden="true" className="pointer-events-none absolute bottom-1 right-1 text-subtle-foreground">
        <svg width="8" height="8" viewBox="0 0 8 8" fill="none">
          <path d="M7 1L1 7M7 4.5L4.5 7" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
        </svg>
      </div>
    </div>
  );
}
