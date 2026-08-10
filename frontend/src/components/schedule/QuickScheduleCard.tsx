import { format } from 'date-fns';
import { Search, XCircle, CheckCircle2, MapPin } from 'lucide-react';
import { useState } from 'react';

import { TimeSelect } from '@/components/form/TimeSelect';
import { toWallClock, wallClockToIso } from '@/lib/schedule-tz';

// ─── Types ────────────────────────────────────────────────

interface QuickScheduleCardProps {
  x: number;
  y: number;
  startTime: string; // ISO string — a real instant, not org wall-clock
  endTime: string;   // ISO string — a real instant, not org wall-clock
  /** The org's scheduling timezone — startTime/endTime display and edit in this zone. */
  tz: string;
  unassignedJobs: Record<string, unknown>[];
  unscheduledWalkthroughs: Record<string, unknown>[];
  onSelectJob: (jobId: string) => void;
  onSelectWalkthrough: (leadId: string) => void;
  onClose: () => void;
  onTimeChange?: (startISO: string, endISO: string) => void;
  /**
   * False when the org lacks the `leads` entitlement - the tab is not offered rather than
   * shown empty. `unscheduledWalkthroughs` is [] there only because the query was disabled,
   * so "No walkthroughs to schedule" would be the same false claim the Unassigned bucket used
   * to make about rows that were never fetched.
   */
  showWalkthroughs?: boolean;
}

type ActiveTab = 'jobs' | 'walkthroughs';

// ─── Position helpers ─────────────────────────────────────

const CARD_WIDTH  = 260;
const CARD_HEIGHT = 360;

function safeLeft(x: number): number {
  return Math.min(x, window.innerWidth - CARD_WIDTH - 8);
}

function safeTop(y: number): number {
  return Math.min(y, window.innerHeight - CARD_HEIGHT - 8);
}

function isoToHHmm(iso: string, tz: string): string {
  return format(toWallClock(new Date(iso), tz), 'HH:mm');
}

function withTime(iso: string, hhmm: string, tz: string): string {
  const [h = 0, m = 0] = hhmm.split(':').map(Number);
  const wc = toWallClock(new Date(iso), tz);
  wc.setHours(h, m, 0, 0);
  return wallClockToIso(wc, tz);
}

// ─── Component ────────────────────────────────────────────

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
}: QuickScheduleCardProps) {
  const [activeTab, setActiveTab] = useState<ActiveTab>('jobs');
  const [query, setQuery] = useState('');

  const left = safeLeft(x);
  const top  = safeTop(y);

  const timeLabel = `${format(toWallClock(new Date(startTime), tz), 'h:mm a')} – ${format(toWallClock(new Date(endTime), tz), 'h:mm a')}`;

  // ── Filtering ──────────────────────────────────────────

  const q = query.trim().toLowerCase();

  const filteredJobs = unassignedJobs.filter((job) => {
    if (!q) return true;
    const jobNumber    = ((job.job_number as string | undefined) ?? '').toLowerCase();
    const customerObj  = job.customer as { first_name?: string; last_name?: string; company_name?: string } | null;
    const customerName = customerObj
      ? `${customerObj.first_name ?? ''} ${customerObj.last_name ?? ''} ${customerObj.company_name ?? ''}`.toLowerCase()
      : '';
    return jobNumber.includes(q) || customerName.includes(q);
  });

  const filteredWalkthroughs = unscheduledWalkthroughs.filter((wt) => {
    if (!q) return true;
    const leadNumber   = ((wt.lead_number as string | undefined) ?? '').toLowerCase();
    const customerObj  = wt.customer as { first_name?: string; last_name?: string; company_name?: string } | null;
    const customerName = customerObj
      ? `${customerObj.first_name ?? ''} ${customerObj.last_name ?? ''} ${customerObj.company_name ?? ''}`.toLowerCase()
      : '';
    return leadNumber.includes(q) || customerName.includes(q);
  });

  const activeItems    = activeTab === 'jobs' ? filteredJobs : filteredWalkthroughs;
  const searchPlaceholder = activeTab === 'jobs' ? 'Search jobs...' : 'Search walkthroughs...';
  const emptyLabel        = activeTab === 'jobs' ? 'No unscheduled jobs' : 'No walkthroughs to schedule';

  return (
    <div
      className="fixed z-[60] bg-surface-light border border-border overflow-hidden rounded-card shadow-lg schedule-popup-enter"
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
      <div className="px-3 py-2.5 bg-background-light border-b border-border flex items-center justify-between gap-2 shrink-0">
        <div className="min-w-0">
          <p className="text-xs font-bold text-text-primary leading-none">Schedule</p>
          {onTimeChange ? (
            <div className="flex items-center gap-1 mt-1 min-w-0">
              <TimeSelect
                value={isoToHHmm(startTime, tz)}
                onChange={(v) => {
                  if (!v) return; // "Select time…" empty option — ignore (withTime('') would throw)
                  onTimeChange(withTime(startTime, v, tz), endTime);
                }}
                className="h-6 w-auto min-w-0 px-1 text-[11px] rounded-md"
              />
              <span className="text-[11px] text-text-secondary">–</span>
              <TimeSelect
                value={isoToHHmm(endTime, tz)}
                onChange={(v) => {
                  if (!v) return; // "Select time…" empty option — ignore (withTime('') would throw)
                  onTimeChange(startTime, withTime(endTime, v, tz));
                }}
                className="h-6 w-auto min-w-0 px-1 text-[11px] rounded-md"
              />
            </div>
          ) : (
            <p className="text-[11px] text-text-secondary mt-0.5">{timeLabel}</p>
          )}
        </div>
        {/* Raw by design: small close-X card-header affordance; its hover treatment
            (bg-border/50) doesn't match any minted ghost cell either. */}
        <button
          onClick={onClose}
          className="shrink-0 p-0.5 rounded hover:bg-border/50 text-text-secondary hover:text-text-primary transition-colors"
          aria-label="Close"
        >
          <XCircle className="h-4 w-4" />
        </button>
      </div>

      {/* ── Tab bar ───────────────────────────────────────── */}
      {/* Raw by design: a segmented toggle control (Jobs / Walkthroughs), the
          explicit non-Button shape from the conversion program's own list.
          Not offered at all without the `leads` entitlement (showWalkthroughs);
          activeTab stays pinned to 'jobs' because its only other setter is here. */}
      {showWalkthroughs && (
        <div className="px-2 pt-2 shrink-0">
          <div className="flex gap-1 bg-background-light rounded-lg p-0.5">
            <button
              className={`flex-1 text-xs font-medium py-1 rounded-md transition-all ${
                activeTab === 'jobs'
                  ? 'bg-surface-light shadow-sm text-text-primary'
                  : 'text-text-secondary hover:text-text-primary'
              }`}
              onClick={() => { setActiveTab('jobs'); setQuery(''); }}
            >
              Jobs
            </button>
            <button
              className={`flex-1 text-xs font-medium py-1 rounded-md transition-all ${
                activeTab === 'walkthroughs'
                  ? 'bg-surface-light shadow-sm text-text-primary'
                  : 'text-text-secondary hover:text-text-primary'
              }`}
              onClick={() => { setActiveTab('walkthroughs'); setQuery(''); }}
            >
              Walkthroughs
            </button>
          </div>
        </div>
      )}

      {/* ── Search input ──────────────────────────────────── */}
      <div className="px-2 pt-2 shrink-0">
        <div className="relative">
          <Search className="absolute left-2 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-text-secondary pointer-events-none" />
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={searchPlaceholder}
            className="w-full text-xs pl-7 pr-2 py-1.5 border border-border rounded-md bg-surface-light placeholder:text-text-secondary focus:outline-none focus:ring-1 focus:ring-primary/30"
          />
        </div>
      </div>

      {/* ── Results list ──────────────────────────────────── */}
      <div className="flex-1 min-h-0 overflow-y-auto mt-1.5 px-2 pb-2">
        {activeItems.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-6 gap-1.5 text-text-secondary">
            <CheckCircle2 className="h-5 w-5 text-success/70" />
            <p className="text-xs">{emptyLabel}</p>
          </div>
        ) : (
          <ul className="space-y-0.5">
            {activeTab === 'jobs'
              ? filteredJobs.map((job) => {
                  const id          = job.id as string;
                  const jobNumber   = (job.job_number as string | undefined) ?? '—';
                  const customerObj = job.customer as { first_name?: string; last_name?: string; company_name?: string } | null;
                  const customerName = customerObj
                    ? (customerObj.company_name || `${customerObj.first_name ?? ''} ${customerObj.last_name ?? ''}`.trim())
                    : '';
                  return (
                    // Raw by design: a list-row click target in the results list.
                    <li key={id}>
                      <button
                        onClick={() => onSelectJob(id)}
                        className="w-full text-left px-2 py-1.5 rounded-md hover:bg-background-light transition-colors flex items-center gap-2"
                      >
                        <span className="text-xs font-bold text-primary shrink-0">{jobNumber}</span>
                        {customerName && (
                          <span className="text-xs text-text-secondary truncate flex-1">{customerName}</span>
                        )}
                      </button>
                    </li>
                  );
                })
              : filteredWalkthroughs.map((wt) => {
                  const id          = wt.id as string;
                  const leadNumber  = (wt.lead_number as string | undefined) ?? '—';
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
                    // Raw by design: a list-row click target in the results list.
                    <li key={id}>
                      <button
                        onClick={() => onSelectWalkthrough(id)}
                        className="w-full text-left px-2 py-1.5 rounded-md hover:bg-background-light transition-colors"
                      >
                        <div className="flex items-center gap-2">
                          <span className="text-xs font-bold text-warning-text shrink-0">{leadNumber}</span>
                          {customerName && (
                            <span className="text-xs text-text-secondary truncate">{customerName}</span>
                          )}
                        </div>
                        {address && (
                          <div className="flex items-center gap-1 mt-0.5">
                            <MapPin className="h-3 w-3 text-text-soft shrink-0" />
                            <span className="text-[11px] text-text-secondary truncate">{address}</span>
                          </div>
                        )}
                      </button>
                    </li>
                  );
                })}
          </ul>
        )}
      </div>

      {/* Decorative resize-grip glyph — the native CSS resize hit area sits beneath it */}
      <div aria-hidden="true" className="pointer-events-none absolute bottom-1 right-1 text-text-secondary/60">
        <svg width="8" height="8" viewBox="0 0 8 8" fill="none">
          <path d="M7 1L1 7M7 4.5L4.5 7" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
        </svg>
      </div>
    </div>
  );
}
