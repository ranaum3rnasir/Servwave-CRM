import React, { useState, useCallback, useRef, useMemo, useEffect, useLayoutEffect, useContext } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { usePlanMode, type GhostEvent } from '@/hooks/usePlanMode';
import { useResizableWidth } from '@/hooks/useResizableWidth';
import { useAuthStore } from '@/stores/auth.store';
import { useAppAbility } from '@/contexts/AbilityContext';
import { useSchedulerBucket, useScheduleVisit, servicePlanKeys } from '@/lib/api/service-plans';
import { useFeature, useModuleAccess } from '@/lib/entitlements';
import { Calendar, dateFnsLocalizer, Views } from 'react-big-calendar';
import withDnD from 'react-big-calendar/lib/addons/dragAndDrop';
import {
  format,
  parse,
  startOfWeek,
  endOfWeek,
  startOfDay,
  endOfDay,
  startOfMonth,
  endOfMonth,
  getDay,
  addDays,
  addWeeks,
  addMonths,
  subDays,
  subWeeks,
  subMonths,
  isSameDay,
  differenceInCalendarDays,
} from 'date-fns';
import { enUS } from 'date-fns/locale';
import 'react-big-calendar/lib/css/react-big-calendar.css';
import 'react-big-calendar/lib/addons/dragAndDrop/styles.css';
import './schedule-dark.css';
import api from '@/lib/axios';
import { extractApiError } from '@/lib/utils';
import { customerDisplayName } from '@/lib/customer-name';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogFooter,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog';
import { Modal } from '@/components/ui/modal';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { useCreateDepartment } from '@/lib/api/departments';
import { SelectField } from '@/components/form/SelectField';
import { AssignJobDialog } from '@/components/jobs/AssignJobDialog';
import { CancelJobDialog } from '@/components/jobs/CancelJobDialog';
import { RescheduleConfirmDialog } from '@/components/schedule/RescheduleConfirmDialog';
import { ContextMenu as ScheduleContextMenu } from '@/components/schedule/ContextMenu';
import { SettingsGearDropdown } from '@/components/schedule/SettingsGearDropdown';
import { TechnicianGridView } from '@/components/schedule/TechnicianGridView';
import { MemberWeekBoard } from '@/components/schedule/MemberWeekBoard';
import ScheduleSearch from '@/components/schedule/ScheduleSearch';
import { QuickScheduleCard } from '@/components/schedule/QuickScheduleCard';
import { UnassignedBuckets } from '@/components/schedule/UnassignedBuckets';
import { PlanVisitCard } from '@/components/schedule/PlanVisitCard';
import { EventEditor } from '@/components/schedule/EventEditor';
import { crewPeopleOf, fullName } from '@/components/schedule/eventPeople';
import { useScheduleData } from '@/components/schedule/useScheduleData';
import { useScheduleEvents } from '@/components/schedule/useScheduleEvents';
import {
  eventDangerState,
  isCompletedEvent,
  isAllDayEvent,
  draftFromDrop,
  conflictNoteFor,
  hhmmToMin,
  atMinutes,
  swapCrew,
  classifyBoardDrop,
  boardCapabilitiesFor,
  rescheduleGate,
  IN_FLIGHT_STATUSES,
  type EventType,
  type BoardEvent,
  type ScheduledBoardEvent,
  type SchedulableEvent,
  type ScheduleDraft,
  type DropTarget,
} from '@/components/schedule/scheduleModel';
import {
  parseBoardDragId,
  JOB_ID,
  WALKTHROUGH_ID,
} from '@/components/schedule/dragChannels';
import { UnifiedDropModal } from '@/components/schedule/UnifiedDropModal';
import { EmptyState } from '@/components/ui/empty-state';
import { useAssignableUsers, type AssignableUser } from '@/lib/api/users';
import { useOrganization } from '@/lib/api/organization';
import {
  DEFAULT_SCHEDULE_TIMEZONE,
  toWallClock,
  toInstant,
  wallClockToIso,
  nowWallClock,
  asWallClock,
  addMsToWallClock,
  isoToOrgDay,
  pickerValueToIso,
  type WallClock,
} from '@/lib/schedule-tz';
import { toast } from '@/components/ui/use-toast';
import { type SearchResult } from '@/components/layout/search-shared';
import {
  Loader2,
  CheckCircle2,
  Users,
  Calendar as CalIcon,
  CalendarX2,
  ChevronLeft,
  ChevronRight,
  AlertCircle,
  AlertTriangle,
  MapPin,
  ExternalLink,
  PenLine,
  Trash2,
  CheckSquare,
  PanelLeftClose,
  PanelLeftOpen,
} from 'lucide-react';

// ─── Calendar Setup ──────────────────────────────────────

const DnDCalendar = withDnD(Calendar);

const localizer = dateFnsLocalizer({
  format,
  parse,
  startOfWeek: () => startOfWeek(new Date(), { weekStartsOn: 0 }),
  getDay,
  locales: { 'en-US': enUS },
});

// ─── Types ───────────────────────────────────────────────
// The board event is the pure SchedulableEvent (crew: string[] ⟂ start/end) plus optional
// plan-mode ghost flags — see BoardEvent in scheduleModel. Status / all-day are NOT
// event fields anymore; they are read from `raw` via the helpers below.

// ─── Schedule Context (for ScheduleEvent ↔ Page communication) ───────────────

interface ScheduleContextValue {
  onEventMouseEnter: (event: BoardEvent, x: number, y: number) => void;
  onEventMouseLeave: () => void;
  onEventContextMenu: (event: BoardEvent, x: number, y: number) => void;
  conflictIds: Set<string>;
}

const ScheduleCtx = React.createContext<ScheduleContextValue>({
  onEventMouseEnter: () => {},
  onEventMouseLeave: () => {},
  onEventContextMenu: () => {},
  conflictIds: new Set(),
});

// ─── Helpers ─────────────────────────────────────────────

const safeX = (x: number, w: number) => Math.min(x, window.innerWidth - w - 8);
const safeY = (y: number, h: number) => Math.min(y, window.innerHeight - h - 8);

/**
 * Card-id prefix per search entity type - a search result carries the ENTITY id, the board
 * and sidebar key their cards by a prefixed one. An entity absent from this map (jobs) uses
 * its bare id.
 */
const CARD_ID_PREFIX: Partial<Record<SearchResult['entity_type'], string>> = {
  lead: 'wt-',
  'service-plan': 'pv-',
};

// Status / all-day helpers (isCompletedEvent / isAllDayEvent) moved to
// scheduleModel.ts (M2) — one source for the page + both member views.

// ─── Custom Event Component ──────────────────────────────

function ScheduleEvent({ event }: { event: unknown }) {
  const e = event as BoardEvent;
  const { onEventMouseEnter, onEventMouseLeave, onEventContextMenu, conflictIds } = useContext(ScheduleCtx);
  // The two reds (D7 + §3.8 state 4) — precedence resolved once in eventDangerState.
  const dangerState = e.raw ? eventDangerState(e, conflictIds) : null;
  const needsCrew = dangerState === 'needs-crew';
  const doubleBooked = dangerState === 'double-booked';

  const handleMouseEnter = (ev: React.MouseEvent) => {
    if (e.raw) onEventMouseEnter(e, ev.clientX, ev.clientY);
  };
  const handleMouseLeave = () => onEventMouseLeave();
  const handleContextMenu = (ev: React.MouseEvent) => {
    ev.preventDefault();
    ev.stopPropagation();
    if (e.raw) onEventContextMenu(e, ev.clientX, ev.clientY);
  };

  // Ghost preview during external drag-in (no raw)
  if (!e.raw) {
    return (
      <div className="leading-tight overflow-hidden h-full">
        <div className="font-semibold truncate text-[11px]">{e.title}</div>
      </div>
    );
  }

  // Ghost event in plan mode — checked before all-day so a draft of an all-day
  // job still renders with the "draft" badge.
  if (e.isGhost) {
    const ghostCustomer = e.raw.customer as { first_name: string; last_name: string } | null;
    return (
      <div
        className="leading-tight overflow-hidden h-full relative"
        onContextMenu={handleContextMenu}
      >
        <span className="absolute top-0 right-0 text-[7px] font-bold uppercase tracking-wider
                         text-info-text/80 bg-info-surface/80 px-1 py-0.5 rounded-bl leading-none z-10">
          draft
        </span>
        <div className="font-semibold truncate text-[11px]">{e.title}</div>
        {ghostCustomer && (
          <div className="truncate text-[10px] opacity-80">
            {ghostCustomer.first_name} {ghostCustomer.last_name}
          </div>
        )}
      </div>
    );
  }

  // All-day event: single-line pill
  if (isAllDayEvent(e)) {
    const customer = e.raw.customer as { first_name: string; last_name: string } | null;
    const customerName = customer ? customerDisplayName(customer, '') : '';
    const label = e.type === 'job'
      ? `${e.raw.job_number as string} — ${customerName}`
      : `${(e.raw.lead_number as string) ?? 'Walkthrough'} — ${customerName}`;
    return (
      <div
        className="overflow-hidden h-full flex items-center leading-[1.2]"
        onMouseEnter={handleMouseEnter}
        onMouseLeave={handleMouseLeave}
        onContextMenu={handleContextMenu}
      >
        <div className="font-semibold truncate text-[11px] flex items-center gap-1">
          {doubleBooked && <AlertTriangle className="h-3 w-3 shrink-0" />}
          <span className="truncate">{label}</span>
          {needsCrew && (
            <span className="text-[9px] font-bold uppercase tracking-wider shrink-0">needs crew</span>
          )}
        </div>
      </div>
    );
  }

  // Only scheduled events reach the calendar; the guard narrows start/end for TS.
  if (!e.start || !e.end) return null;

  // ─── Common data extraction ───────────────────────────
  const customer = e.raw.customer as { first_name: string; last_name: string } | null;
  const customerName = customer ? customerDisplayName(customer, '') : '';
  // D1/TG6 — the WHOLE crew, comma-separated (no more single-assignee [0] read).
  const performer = crewPeopleOf(e.type, e.raw).map(fullName).filter(Boolean).join(', ');
  const timeStr = `${format(e.start, 'h:mm a')} – ${format(e.end, 'h:mm a')}`;

  // Height-based content thresholds (GCal approach, Section 5.2)
  // 48px per hour is react-big-calendar's default. We estimate height from duration.
  const durationMin = (e.end.getTime() - e.start.getTime()) / (1000 * 60);
  const estimatedHeight = (durationMin / 60) * 48;

  // Threshold bands:
  //   < 32px  → title only (single line)
  //   32-52px → title + time (2 lines)  ← 1 hour events land here (~48px)
  //   53-80px → title + time + performer (3 lines)
  // > 80px  → title + time + performer + address (4 lines) ← 2+ hour events

  const showTime = estimatedHeight >= 32;
  const showPerformer = estimatedHeight >= 53;
  const showAddress = estimatedHeight >= 80;

  const wrapperProps = {
    className: 'overflow-hidden h-full flex flex-col',
    style: { lineHeight: '1.3' } as React.CSSProperties,
    onMouseEnter: handleMouseEnter,
    onMouseLeave: handleMouseLeave,
    onContextMenu: handleContextMenu,
  };

  if (e.type === 'walkthrough') {
    const leadNumber = e.raw.lead_number as string | undefined;
    const wtAddress = [e.raw.service_address_line1, e.raw.service_city, e.raw.service_state]
      .filter(Boolean).join(', ');

    // Row 1 (title): always shown — "L00041 – Customer Name"
    const title = `${leadNumber ?? ''}${customerName ? ` – ${customerName}` : ''}`;

    return (
      <div {...wrapperProps}>
        <div className="font-bold truncate text-[13px] flex items-center gap-1">
          {doubleBooked && <AlertTriangle className="h-3 w-3 shrink-0 text-danger" />}
          <span className="truncate">{title}</span>
        </div>
        {doubleBooked && (
          <div>
            <span className="inline-block rounded bg-danger/10 px-1 text-[9px] font-bold text-danger leading-tight">
              double-booked
            </span>
          </div>
        )}
        {needsCrew && (
          <div className="text-[9px] font-bold uppercase tracking-wider">needs crew</div>
        )}
        {showTime && <div className="truncate text-xs opacity-85">{timeStr}</div>}
        {showPerformer && performer && (
          <div className="truncate text-[12px] opacity-85">{performer}</div>
        )}
        {showAddress && wtAddress && (
          <div className="truncate text-[11px] opacity-75 flex items-center gap-1 mt-auto">
            <MapPin className="h-3 w-3 shrink-0" />
            {wtAddress}
          </div>
        )}
      </div>
    );
  }

  // ─── Job event ─────────────────────────────────────────
  const location = e.raw.service_location as { address_line1?: string; city?: string; state?: string } | null;
  const address = location ? [location.address_line1, location.city, location.state].filter(Boolean).join(', ') : '';

  // Row 1 (title): always shown — "JOB-2026-0050 – Customer Name"
  const jobTitle = `${e.raw.job_number as string}${customerName ? ` – ${customerName}` : ''}`;

  return (
    <div {...wrapperProps}>
      <div className="font-bold truncate text-[13px] flex items-center gap-1">
        {doubleBooked && <AlertTriangle className="h-3 w-3 shrink-0 text-danger" />}
        <span className="truncate">{jobTitle}</span>
      </div>
      {doubleBooked && (
        <div>
          <span className="inline-block rounded bg-danger/10 px-1 text-[9px] font-bold text-danger leading-tight">
            double-booked
          </span>
        </div>
      )}
      {needsCrew && (
        <div className="text-[9px] font-bold uppercase tracking-wider">needs crew</div>
      )}
      {showTime && <div className="truncate text-xs opacity-85">{timeStr}</div>}
      {showPerformer && performer && (
        <div className="truncate text-[12px] opacity-85">{performer}</div>
      )}
      {showAddress && address && (
        <div className="truncate text-[11px] opacity-75 flex items-center gap-1 mt-auto">
          <MapPin className="h-3 w-3 shrink-0" />
          {address}
        </div>
      )}
    </div>
  );
}

// ─── Page ────────────────────────────────────────────────

/** The exclusive end of an all-day block: the next CALENDAR day in `tz`, as an instant.
 *  Deliberately not `instant + 24h`, which is an hour out on either DST transition. */
function allDayEndIso(startIso: string, tz: string): string {
  const [y, m, d] = isoToOrgDay(startIso, tz).split('-').map(Number);
  const nextDay = new Date(Date.UTC(y!, m! - 1, d! + 1)).toISOString().slice(0, 10);
  return pickerValueToIso(nextDay, tz)!;
}

export default function SchedulePage() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const authUser = useAuthStore((s) => s.user);
  const canPlanMode = authUser?.role === 'ADMIN' || authUser?.role === 'DISPATCHER';

  // Org scheduling defaults (backend shipped in PR A) — drive day-granularity drop anchors
  // and the drop modal's default durations. Settings UI lands in TG14.
  // Declared early (not just before use) because `tz` has to exist before `currentDate`'s
  // initial state below — the scheduler renders and writes in the ORG's wall clock, not the
  // viewer's browser zone (see frontend/src/lib/schedule-tz.ts for why).
  const { data: org } = useOrganization();
  const tz = org?.timezone || DEFAULT_SCHEDULE_TIMEZONE;
  // D9 (TG13) — role-gated UI CONTROLS (data scoping is server-side, PR A scopeWhereFor).
  // Destructured to primitives so they're stable useCallback/useEffect deps.
  const { memberView: canMemberView, readOnly: boardReadOnly } = boardCapabilitiesFor(
    authUser?.role,
  );

  // View / navigation state
  // "Today" is the org's today, not the browser's — a Manila viewer and a New York
  // viewer must land on the same calendar day.
  const [currentDate, setCurrentDate] = useState<WallClock>(() => nowWallClock(tz));
  const [calendarView, setCalendarView] = useState<string>(Views.WEEK);
  const [isGroupedView, setIsGroupedView] = useState(false);
  // D9 render-time fallback: without the member-view capability the board is ALWAYS
  // standard, even if isGroupedView somehow flips (keyboard shortcut, future persistence).
  const effectiveGroupedView = canMemberView && isGroupedView;
  // Left sidebar (search + walkthroughs + unassigned jobs) collapse toggle.
  const [sidebarOpen, setSidebarOpen] = useState(true);
  // Drag-to-resize sidebar width (#193) — persisted per device, clamped 180–420.
  const { width: sidebarWidth, startResize: startSidebarResize } = useResizableWidth({
    storageKey: 'schedule-sidebar-width',
    defaultWidth: 240,
    min: 180,
    max: 420,
  });
  // Week view: index (0–6) of the day column expanded via double-click; null = all equal width.
  const [focusedDayIndex, setFocusedDayIndex] = useState<number | null>(null);
  // Time-of-day window — narrows the visible hours so jobs aren't cramped.
  const [timeWindow, setTimeWindow] = useState<'full' | 'morning' | 'afternoon'>('full');
  const [roleFilter, setRoleFilter] = useState<string>('all');
  const [departmentFilter, setDepartmentFilter] = useState<string>('all');

  // ── Header centering ──────────────────────────────────
  // "All departments" sits centered on the *gap* between the Standard/Member
  // toggle and Plan Mode (row 1), not on the cluster's bounding-box center —
  // the toggle is much wider than Plan Mode, so the two differ. We measure the
  // two pills each layout and offset the dropdown so it looks even.
  const headerRow1Ref = useRef<HTMLDivElement | null>(null);
  const viewToggleRef = useRef<HTMLDivElement | null>(null);
  const planModeRef = useRef<HTMLButtonElement | null>(null);
  const [deptShift, setDeptShift] = useState(0);

  // Create-department affordance ("+ Add department" in the filter dropdown).
  const createDept = useCreateDepartment();
  const [addDeptOpen, setAddDeptOpen] = useState(false);
  const [newDeptName, setNewDeptName] = useState('');

  const submitCreateDepartment = async () => {
    const name = newDeptName.trim();
    if (!name) return;
    const res = await createDept.mutateAsync(name);
    const newId = (res as { department?: { id: string } } | undefined)?.department?.id;
    if (newId) setDepartmentFilter(newId);
    setAddDeptOpen(false);
    setNewDeptName('');
  };

  // Departments for filter dropdown
  const { data: departments } = useQuery({
    queryKey: ['departments'],
    queryFn: async () => {
      const { data } = await api.get('/api/departments');
      return data.departments as Array<{ id: string; name: string }>;
    },
    staleTime: 5 * 60_000,
  });
  // date-fns helpers always return a plain Date, even given a WallClock input — asWallClock
  // re-asserts the brand on values we know stayed in wall-clock space (currentDate already
  // is one). This is the fetch window: it goes out over the API as real instants via
  // useScheduleData, which converts with `tz` right before serialising.
  const dateRange = useMemo<{ start: WallClock; end: WallClock }>(() => {
    if (calendarView === Views.DAY) {
      return { start: asWallClock(startOfDay(currentDate)), end: asWallClock(endOfDay(currentDate)) };
    } else if (calendarView === Views.MONTH) {
      const ms = startOfMonth(currentDate);
      const me = endOfMonth(currentDate);
      return {
        start: asWallClock(startOfWeek(ms, { weekStartsOn: 0 })),
        end: asWallClock(endOfWeek(me, { weekStartsOn: 0 })),
      };
    }
    return {
      start: asWallClock(startOfWeek(currentDate, { weekStartsOn: 0 })),
      end: asWallClock(endOfWeek(currentDate, { weekStartsOn: 0 })),
    };
  }, [currentDate, calendarView]);

  // Search highlight
  const [highlightedEventId, setHighlightedEventId] = useState<string | null>(null);
  const highlightTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // TG12 event editor — opened by every live board/bucket card click. Stores only the
  // ID; the live event re-derives from the query collections so saves refresh in place.
  const [editorEventId, setEditorEventId] = useState<string | null>(null);

  // Hover tooltip
  // Tooltip removed — left-click popup provides all event info

  // Context menu
  const [contextMenu, setContextMenu] = useState<{ event: BoardEvent; x: number; y: number } | null>(null);

  // Slot-click popover
  const [slotPopover, setSlotPopover] = useState<{ x: number; y: number; start: string; end: string } | null>(null);

  // All-day slot popover (from day header click)
  const [allDaySlotPopover, setAllDaySlotPopover] = useState<{
    x: number; y: number; date: string;
  } | null>(null);
  const lastMousePos = useRef({ x: 0, y: 0 });

  // Drag state
  const draggingJobIdRef = useRef<string | null>(null);

  // Sidebar drag visual state — pv- plan-visit cards only (UnassignedBuckets owns its own).
  const [draggingSidebarId, setDraggingSidebarId] = useState<string | null>(null);

  // Service Plans bucket — every ACTIVE plan with remaining visits (admin/dispatcher only).
  const ability = useAppAbility();
  // useModuleAccess, not ability.can: /api/service-plans sits behind
  // requireFeature('service_plans') (Pro) while Scheduling is Starter core, and an
  // admin passes every CASL check regardless of what the org pays for. This drives
  // both the scheduler-bucket fetch and the plan rail below, so the rail disappears
  // instead of sitting empty behind a 402.
  const canSeePlans = useModuleAccess('service_plans', 'read', 'ServicePlan');
  const leadsEnabled = useFeature('leads');
  // ADMIN-only backend gate (POST /api/departments) mirrored in the UI.
  const canCreateDepartment = ability.can('create', 'Department');
  const { data: planBucket } = useSchedulerBucket(canSeePlans);
  const scheduleVisitMutation = useScheduleVisit();

  // Sidebar card context menu
  const [sidebarContextMenu, setSidebarContextMenu] = useState<{
    x: number;
    y: number;
    type: 'walkthrough' | 'job';
    id: string;
  } | null>(null);

  // Dialog / modal state. (defaultTechId is gone — TG10 removed the dialog's only
  // member-seeded path; board-card drops now swap/reschedule directly, never open it.)
  const [assignDialog, setAssignDialog] = useState<{
    open: boolean;
    jobId: string;
    defaultStart?: string;
    defaultEnd?: string;
    defaultIsAllDay?: boolean;
  }>({ open: false, jobId: '' });

  const [cancelDialog, setCancelDialog] = useState<{ open: boolean; jobId: string }>({
    open: false,
    jobId: '',
  });

  // Reschedule confirmation dialog state (Task 11). A standard-view drag moves TIME only;
  // the crew rides along unchanged (crew ⟂ schedule), so there is no "new tech" anymore.
  const [rescheduleConfirm, setRescheduleConfirm] = useState<{
    event: BoardEvent;
    oldStart: WallClock;
    oldEnd: WallClock;
    newStart: WallClock;
    newEnd: WallClock;
  } | null>(null);

  // Temporary position override for event during confirmation dialog — carries the crew.
  const [pendingMove, setPendingMove] = useState<{
    eventId: string;
    newStart: WallClock;
    newEnd: WallClock;
    crew: string[];
  } | null>(null);

  // Toast state. The pending payload is discriminated so "Schedule Anyway" can re-POST
  // force:true through the right mutation (jobs AND walkthroughs — TG9 fold-in).
  const [conflictToast, setConflictToast] = useState<{
    message: string;
    conflicts?: { type: 'job' | 'walkthrough'; id: string; number: string; start: string | Date; end: string | Date }[];
    pendingPayload:
      | { kind: 'job'; jobId: string; crew: string[]; start: string; end: string }
      | { kind: 'walkthrough'; leadId: string; newStart: string; crew: string[]; durationMinutes: number };
  } | null>(null);

  // ── D6 drag-to-unschedule (TG10) ───────────────────────
  // Dragging a BOARD card onto the Unscheduled sidebar clears its TIME but KEEPS the
  // crew (state 2 → 3). Distinct from Cancel — no reason, no customer email.
  const [unscheduleConfirm, setUnscheduleConfirm] = useState<SchedulableEvent | null>(null);

  // ── D5 unified drop modal (TG9) ────────────────────────
  // Every drop FROM an Unassigned bucket onto the board opens this one modal, pre-filled
  // by where it landed (draftFromDrop). The page owns the draft; the modal is controlled.
  const [dropModal, setDropModal] = useState<{ event: SchedulableEvent; draft: ScheduleDraft } | null>(null);
  // Empty-crew confirm (§3.8 state 4 is valid but deliberate): the drop modal hides while
  // this warning overlay is up — stacking a plain overlay over a Radix dialog would fight
  // its focus lock / outside-click close.
  const [needsCrewConfirm, setNeedsCrewConfirm] = useState(false);

  // ─── Global search → jump to event ─────────────────
  // Card-id prefix per search entity type; absent means the bare id (jobs).
  // A result with no date is UNSCHEDULED: its card lives in the sidebar bucket, not on the
  // calendar. Highlight it there instead of returning early — the early return made every
  // unscheduled hit an inert row you could click forever with nothing happening.
  const handleSearchSelect = useCallback((result: SearchResult) => {
    // Card ids are prefixed by type: `wt-` for a walkthrough (board and bucket alike),
    // `pv-` for a service-plan visit card in the sidebar rail. Jobs use the bare id.
    const eventId = CARD_ID_PREFIX[result.entity_type]
      ? `${CARD_ID_PREFIX[result.entity_type]}${result.id}`
      : result.id;
    if (result.date) {
      setCurrentDate(toWallClock(new Date(result.date), tz));
    }
    // A plan visit is never ON the calendar - it is a rail card you drag onto it - so its
    // next-due date positions the board while the highlight still has to land in the sidebar.
    if (!result.date || result.entity_type === 'service-plan') {
      setSidebarOpen(true);
    }
    setHighlightedEventId(eventId);
    if (highlightTimerRef.current) clearTimeout(highlightTimerRef.current);
    highlightTimerRef.current = setTimeout(() => setHighlightedEventId(null), 3000);
  }, [tz]);
  const [errorToast, setErrorToast] = useState<string | null>(null);

  // ─── Plan Mode ─────────────────────────────────────────

  const planMode = usePlanMode();

  // D9 hardening — plan mode restores isActive from localStorage, so a session whose
  // role can't plan (read-only / role-less) could otherwise see the banner + ghosts and
  // Confirm-All would fire raw POSTs. forceDeactivate clears the drafts without posting.
  useEffect(() => {
    if (!canPlanMode && planMode.isActive) planMode.forceDeactivate();
  }, [canPlanMode, planMode]);

  // Measure the row-1 cluster and offset "All departments" to the gap between
  // the view toggle and Plan Mode (falls back to the toggle's center when Plan
  // Mode is hidden). Runs on layout + window resize so it stays even.
  useLayoutEffect(() => {
    const compute = () => {
      const row = headerRow1Ref.current;
      const toggle = viewToggleRef.current;
      if (!row || !toggle) {
        setDeptShift(0);
        return;
      }
      const rowRect = row.getBoundingClientRect();
      const rowCenter = rowRect.left + rowRect.width / 2;
      const toggleRect = toggle.getBoundingClientRect();
      const plan = planModeRef.current;
      // Target = midpoint of the gap between the two pills, or the toggle's
      // center when Plan Mode isn't rendered.
      const target = plan
        ? (toggleRect.right + plan.getBoundingClientRect().left) / 2
        : toggleRect.left + toggleRect.width / 2;
      setDeptShift(Math.round(target - rowCenter));
    };
    compute();
    window.addEventListener('resize', compute);
    return () => window.removeEventListener('resize', compute);
  }, [canPlanMode, isGroupedView, calendarView, planMode.isActive, departments?.length, sidebarOpen, sidebarWidth]);

  const [showExitDialog, setShowExitDialog] = useState(false);
  const [showConfirmDialog, setShowConfirmDialog] = useState<{
    ghostId: string;
    ghost: GhostEvent;
  } | null>(null);
  const [showConfirmAllDialog, setShowConfirmAllDialog] = useState(false);
  const [confirmingGhostIds, setConfirmingGhostIds] = useState<Set<string>>(new Set());

  // Ghost context menu state
  const [ghostContextMenu, setGhostContextMenu] = useState<{
    ghostId: string;
    x: number;
    y: number;
  } | null>(null);

  // Close ghost context menu on outside click
  useEffect(() => {
    if (!ghostContextMenu) return;
    const handler = () => setGhostContextMenu(null);
    const timer = setTimeout(() => document.addEventListener('click', handler), 50);
    return () => { clearTimeout(timer); document.removeEventListener('click', handler); };
  }, [ghostContextMenu]);

  // Plan mode toggle handler
  const handlePlanModeToggle = useCallback(() => {
    if (planMode.isActive) {
      const exited = planMode.deactivate();
      if (!exited) setShowExitDialog(true);
    } else {
      planMode.activate();
    }
  }, [planMode]);

  // beforeunload warning when ghosts exist
  useEffect(() => {
    if (!planMode.isActive || planMode.ghostCount === 0) return;
    const handler = (e: BeforeUnloadEvent) => {
      e.preventDefault();
    };
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, [planMode.isActive, planMode.ghostCount]);

  // Browser-level navigation warning (beforeunload) when plan mode has ghosts
  useEffect(() => {
    if (!planMode.isActive || planMode.ghostCount === 0) return;
    const handler = (e: BeforeUnloadEvent) => {
      e.preventDefault();
    };
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, [planMode.isActive, planMode.ghostCount]);

  // Confirm ghost — calls API then removes ghost
  const handleConfirmGhost = useCallback(async (ghostId: string) => {
    const ghost = planMode.getGhostById(ghostId);
    if (!ghost) return;

    setConfirmingGhostIds((prev) => new Set(prev).add(ghostId));
    try {
      // REPLACE semantics: the ghost's full crew array ([] = schedule with no crew —
      // valid, surfaces as state 4). Any 4xx is caught below, surfaced as a toast,
      // and the ghost is left in place.
      if (ghost.sourceType === 'job') {
        await api.post(`/api/jobs/${ghost.sourceId}/assign`, {
          assignee_ids: ghost.crew,
          scheduled_start: ghost.start,
          scheduled_end: ghost.end,
        });
      } else {
        await api.post(`/api/leads/${ghost.sourceId}/walkthrough/schedule`, {
          walkthrough_scheduled_at: ghost.start,
          performer_ids: ghost.crew,
          walkthrough_duration_minutes: Math.round(
            (new Date(ghost.end).getTime() - new Date(ghost.start).getTime()) / 60000,
          ),
        });
      }
      planMode.removeGhost(ghostId);
      // Invalidate queries so the real event appears
      queryClient.invalidateQueries({ queryKey: ['schedule-jobs'] });
      queryClient.invalidateQueries({ queryKey: ['schedule-walkthroughs'] });
      queryClient.invalidateQueries({ queryKey: ['schedule-unassigned'] });
      queryClient.invalidateQueries({ queryKey: ['schedule-unscheduled-walkthroughs'] });
    } catch (err) {
      setErrorToast(extractApiError(err, 'Failed to confirm schedule change.'));
    } finally {
      setConfirmingGhostIds((prev) => {
        const next = new Set(prev);
        next.delete(ghostId);
        return next;
      });
    }
  }, [planMode, queryClient]);

  // Confirm all visible ghosts
  const handleConfirmAllGhosts = useCallback(async () => {
    // getGhostsForView compares against ghost.start/end, which are real instants — the
    // WallClock dateRange has to convert back before the comparison means anything.
    const visible = planMode.getGhostsForView(toInstant(dateRange.start, tz), toInstant(dateRange.end, tz));
    let succeeded = 0;
    let failed = 0;
    for (const ghost of visible) {
      try {
        await handleConfirmGhost(ghost.id);
        succeeded++;
      } catch {
        failed++;
      }
    }
    setShowConfirmAllDialog(false);
    if (failed > 0) {
      setErrorToast(`${succeeded} of ${succeeded + failed} scheduled. ${failed} failed — resolve manually.`);
    }
  }, [planMode, dateRange, handleConfirmGhost, tz]);

  // Ghost context menu handler for all views
  const handleGhostContextMenu = useCallback((ghostId: string, x: number, y: number) => {
    setGhostContextMenu({ ghostId, x, y });
  }, []);

  // ─── Mouse position tracking (for slot popover) ──────

  useEffect(() => {
    const track = (e: MouseEvent) => { lastMousePos.current = { x: e.clientX, y: e.clientY }; };
    window.addEventListener('mousemove', track);
    return () => window.removeEventListener('mousemove', track);
  }, []);

  // ─── Drag width capture (GCal: preview matches original event width) ────

  useEffect(() => {
    const calendarEl = document.querySelector('.schedule-cal') as HTMLElement | null;
    if (!calendarEl) return;

    const handleMouseDown = (e: MouseEvent) => {
      const eventEl = (e.target as HTMLElement).closest('.rbc-event') as HTMLElement | null;
      if (eventEl) {
        const eventRect = eventEl.getBoundingClientRect();
        // Find the day column container to calculate relative left offset
        const columnEl = eventEl.closest('.rbc-day-slot') || eventEl.closest('.rbc-time-column');
        const columnRect = columnEl?.getBoundingClientRect();
        const leftOffset = columnRect ? eventRect.left - columnRect.left : 0;

        calendarEl.style.setProperty('--drag-preview-width', `${eventRect.width}px`);
        calendarEl.style.setProperty('--drag-preview-left', `${leftOffset}px`);
      }
    };

    const handleMouseUp = () => {
      calendarEl.style.removeProperty('--drag-preview-width');
      calendarEl.style.removeProperty('--drag-preview-left');
    };

    calendarEl.addEventListener('mousedown', handleMouseDown);
    document.addEventListener('mouseup', handleMouseUp);
    return () => {
      calendarEl.removeEventListener('mousedown', handleMouseDown);
      document.removeEventListener('mouseup', handleMouseUp);
    };
  }, []);

  // ─── Keyboard shortcuts ──────────────────────────────

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement).tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;

      if (e.key === 't' || e.key === 'T') setCurrentDate(nowWallClock(tz));
      if (e.key === '1') setCalendarView(Views.DAY);
      if (e.key === '2') setCalendarView(Views.WEEK);
      if (e.key === '3') setCalendarView(Views.MONTH);
      if (e.key === 's' || e.key === 'S') setIsGroupedView(false);
      // D9 — member view is an admin/dispatcher capability; the shortcut respects it too.
      if ((e.key === 'g' || e.key === 'G') && canMemberView) setIsGroupedView(true);
      if (e.key === 'Escape') {
        setConflictToast(null);
        setErrorToast(null);
        setContextMenu(null);
        setSlotPopover(null);
        setAllDaySlotPopover(null);
        setSidebarContextMenu(null);
        setGhostContextMenu(null);
        setUnscheduleConfirm(null);
        setNeedsCrewConfirm(false); // back to the (still-open) drop modal
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [canMemberView, tz]);

  // ─── Close context menu / slot popover on outside click ──

  useEffect(() => {
    if (!contextMenu && !slotPopover && !allDaySlotPopover && !sidebarContextMenu) return;
    const handler = (e: MouseEvent) => {
      // Don't close if the click was inside a popover (they have stopPropagation,
      // but this is defense in depth)
      const target = e.target as HTMLElement;
      // Also treat any open Radix popper content (e.g. the TimeSelect dropdown,
      // which portals to <body>) as "inside" — otherwise picking a time closes the popover.
      if (
        target.closest('[class*="fixed"][class*="z-["]') ||
        target.closest('[data-radix-popper-content-wrapper]')
      ) return;
      setContextMenu(null);
      setSlotPopover(null);
      setAllDaySlotPopover(null);
      setSidebarContextMenu(null);
    };
    // Use mousedown instead of click to fire before react-big-calendar's selection handlers
    // Delay slightly so the triggering interaction doesn't immediately close
    const timer = setTimeout(() => document.addEventListener('mousedown', handler, true), 100);
    return () => {
      clearTimeout(timer);
      document.removeEventListener('mousedown', handler, true);
    };
  }, [contextMenu, slotPopover, allDaySlotPopover, sidebarContextMenu]);

  // ─── Mouse handlers (tooltip removed — popup has all info) ───────────

  const handleEventMouseEnter = useCallback(() => {}, []);
  const handleEventMouseLeave = useCallback(() => {}, []);

  const handleEventContextMenu = useCallback((event: BoardEvent, x: number, y: number) => {
    // Ghost events get their own context menu
    if (event.isGhost && event.ghostId) {
      setGhostContextMenu({ ghostId: event.ghostId, x, y });
      return;
    }
    setContextMenu({ event, x, y });
  }, []);

  // ─── Date label ──────────────────────────────────────

  const dateRangeLabel = useMemo(() => {
    if (calendarView === Views.DAY) {
      return format(currentDate, 'EEEE, MMMM d, yyyy');
    } else if (calendarView === Views.MONTH) {
      return format(currentDate, 'MMMM yyyy');
    } else {
      const wStart = startOfWeek(currentDate, { weekStartsOn: 0 });
      const wEnd = endOfWeek(currentDate, { weekStartsOn: 0 });
      if (wStart.getFullYear() !== wEnd.getFullYear()) {
        return `${format(wStart, 'MMM d, yyyy')} – ${format(wEnd, 'MMM d, yyyy')}`;
      }
      if (wStart.getMonth() !== wEnd.getMonth()) {
        return `${format(wStart, 'MMM d')} – ${format(wEnd, 'MMM d, yyyy')}`;
      }
      return `${format(wStart, 'MMM d')} – ${format(wEnd, 'd, yyyy')}`;
    }
  }, [calendarView, currentDate]);

  // ─── Day focus (week view: double-click a day to expand its column) ──
  const toggleDayFocus = useCallback((idx: number) => {
    setFocusedDayIndex((cur) => (cur === idx ? null : idx));
  }, []);

  // Distinguish a single click (navigate / open the Schedule popover) from a
  // double click (expand the day column). A pending single-click action is
  // cancelled by the second click, so double-clicking a day header only
  // expands the column instead of also firing the single-click popover.
  const dayHeaderClickTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => {
    if (dayHeaderClickTimer.current) clearTimeout(dayHeaderClickTimer.current);
  }, []);

  // Double-clicking a day column or its header toggles that column wider.
  // Only meaningful in week view (day view = one column, month = no time grid).
  const handleCalendarDoubleClick = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    if (calendarView !== Views.WEEK) return;
    const wrapper = e.currentTarget;
    const target = e.target as HTMLElement;

    // 1) Double-click inside a day column body
    const slot = target.closest('.rbc-day-slot');
    if (slot) {
      const cols = Array.from(wrapper.querySelectorAll('.rbc-time-content > .rbc-day-slot'));
      const idx = cols.indexOf(slot);
      if (idx >= 0) { e.preventDefault(); toggleDayFocus(idx); return; }
    }
    // 2) Double-click on a day header cell
    const header = target.closest('.rbc-header');
    if (header) {
      const heads = Array.from(wrapper.querySelectorAll('.rbc-time-header-content .rbc-header'));
      const idx = heads.indexOf(header);
      if (idx >= 0) { e.preventDefault(); toggleDayFocus(idx); return; }
    }
  }, [calendarView, toggleDayFocus]);

  // Reset the expanded day whenever the week, view, or board mode changes.
  useEffect(() => {
    setFocusedDayIndex(null);
  }, [currentDate, calendarView, isGroupedView]);

  // ─── Navigation ──────────────────────────────────────

  const handleNavigateToday = useCallback(() => setCurrentDate(nowWallClock(tz)), [tz]);

  const handleNavigatePrev = useCallback(() => {
    setCurrentDate((d) =>
      calendarView === Views.DAY ? subDays(d, 1)
      : calendarView === Views.MONTH ? subMonths(d, 1)
      : subWeeks(d, 1),
    );
  }, [calendarView]);

  const handleNavigateNext = useCallback(() => {
    setCurrentDate((d) =>
      calendarView === Views.DAY ? addDays(d, 1)
      : calendarView === Views.MONTH ? addMonths(d, 1)
      : addWeeks(d, 1),
    );
  }, [calendarView]);

  // ─── Edge-scroll: auto-navigate when dragging near calendar edges ──────
  const edgeScrollTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    const EDGE_ZONE = 60;
    const NAV_DELAY = 600;

    const handleDragOver = (e: DragEvent) => {
      const calendarEl = document.querySelector('.schedule-cal');
      if (!calendarEl) return;
      const rect = calendarEl.getBoundingClientRect();
      const mouseX = e.clientX;

      const nearLeftEdge = mouseX < rect.left + EDGE_ZONE;
      const nearRightEdge = mouseX > rect.right - EDGE_ZONE;

      if ((nearLeftEdge || nearRightEdge) && !edgeScrollTimerRef.current) {
        edgeScrollTimerRef.current = setInterval(() => {
          if (nearRightEdge) handleNavigateNext();
          else if (nearLeftEdge) handleNavigatePrev();
        }, NAV_DELAY);
      } else if (!nearLeftEdge && !nearRightEdge && edgeScrollTimerRef.current) {
        clearInterval(edgeScrollTimerRef.current);
        edgeScrollTimerRef.current = null;
      }
    };

    const handleDragEnd = () => {
      if (edgeScrollTimerRef.current) {
        clearInterval(edgeScrollTimerRef.current);
        edgeScrollTimerRef.current = null;
      }
    };

    document.addEventListener('dragover', handleDragOver);
    document.addEventListener('dragend', handleDragEnd);
    document.addEventListener('drop', handleDragEnd);
    return () => {
      document.removeEventListener('dragover', handleDragOver);
      document.removeEventListener('dragend', handleDragEnd);
      document.removeEventListener('drop', handleDragEnd);
      if (edgeScrollTimerRef.current) clearInterval(edgeScrollTimerRef.current);
    };
  }, [handleNavigateNext, handleNavigatePrev]);

  // ─── Business hours / time-of-day window ─────────────
  // Three presets narrow the visible range so each hour gets more vertical
  // room, making same-hour job clusters legible. 'full' = whole day (default).
  const { calendarMin, calendarMax, scrollToTime } = useMemo(() => {
    const at = (h: number, m = 0, s = 0) => new Date(1970, 0, 1, h, m, s);
    if (timeWindow === 'morning')   return { calendarMin: at(7),  calendarMax: at(12),         scrollToTime: at(7) };
    if (timeWindow === 'afternoon') return { calendarMin: at(12), calendarMax: at(18),         scrollToTime: at(12) };
    return { calendarMin: at(0), calendarMax: at(23, 59, 59), scrollToTime: at(6) };
  }, [timeWindow]);

  // Custom day/week header — GCal style: abbreviation + large date number
  const DayHeader = useCallback(({ date }: { date: Date; label: string }) => {
    const dayAbbr = format(date, 'EEE').toUpperCase();
    const dayNum = format(date, 'd');
    const isToday = format(date, 'yyyy-MM-dd') === format(nowWallClock(tz), 'yyyy-MM-dd');
    return (
      <div
        className="flex flex-col items-center cursor-pointer"
        onClick={(e) => {
          e.stopPropagation();
          const { clientX, clientY } = e;
          // A double-click should only expand the day column (handled by the
          // calendar wrapper's onDoubleClick → toggleDayFocus). Defer the
          // single-click action so the second click of a double-click cancels
          // it, rather than also navigating / opening the Schedule popover.
          if (dayHeaderClickTimer.current) {
            clearTimeout(dayHeaderClickTimer.current);
            dayHeaderClickTimer.current = null;
            return;
          }
          dayHeaderClickTimer.current = setTimeout(() => {
            dayHeaderClickTimer.current = null;
            // Week view: clicking a day header opens that day's schedule (Day view).
            // Other views keep the click for creating an all-day job.
            if (calendarView === Views.WEEK) {
              setCurrentDate(asWallClock(startOfDay(date)));
              setCalendarView(Views.DAY);
              return;
            }
            // D9 — the all-day popover only offers scheduling actions; skip for read-only.
            if (boardReadOnly) return;
            setAllDaySlotPopover({
              x: clientX,
              y: clientY,
              date: wallClockToIso(asWallClock(startOfDay(date)), tz),
            });
          }, 250);
        }}
      >
        <span className={`text-[11px] font-medium tracking-wide ${isToday ? 'text-primary' : 'text-text-secondary'}`}>
          {dayAbbr}
        </span>
        <span className={`schedule-day-num font-normal leading-none flex items-center justify-center
          w-8 h-8 rounded-full hover:bg-primary/10 transition-colors
          ${isToday
            ? 'schedule-day-today bg-primary text-on-fill hover:bg-primary/90'
            : 'text-text-primary'
          }`}
        >
          {dayNum}
        </span>
      </div>
    );
  }, [calendarView, boardReadOnly, tz]);

  const calendarComponents = useMemo(() => ({
    toolbar: () => null,
    event: ScheduleEvent as unknown as React.ComponentType<{ event: object }>,
    header: DayHeader as unknown as React.ComponentType<{ date: Date; label: string }>,
  }), [DayHeader]);

  // ─── Data Queries ────────────────────────────────────

  const {
    scheduledJobs,
    walkthroughLeads,
    unassignedJobs,
    unscheduledWalkthroughs,
    jobsLoading,
    walkthroughsLoading,
    unassignedError,
  } = useScheduleData({ dateRange, departmentFilter, tz });

  // Bucket types this viewer cannot reach at all. Hide, don't hint (useModuleAccess.ts:18-21) -
  // and killing the section is what stops the empty state from making a positively FALSE claim
  // ("Nothing here - all Walkthroughs are scheduled.") about rows that were never fetched.
  //
  // `leadsEnabled` is the SAME useFeature('leads') result that disabled the two lead queries in
  // useScheduleData, so the hide fails open identically: an unhydrated auth cache keeps the bucket.
  //
  // `canSeePlans` is useFeature('service_plans') && ability.can('read','ServicePlan'), so the
  // Service Plans bucket ALSO disappears for any user without that grant - per defaultGrants.ts
  // that is SALES and TECHNICIAN, on a fully-paid SCALE org. Deliberate, and not a widening:
  // canSeePlans is the identical boolean that already decides `planSlot` below, so the exact set
  // of viewers who see the misleading "soon / Step 9E" stub today is the set that now sees
  // nothing. Keying on useFeature('service_plans') alone would leave planSlot undefined for them
  // and the stub lie fully intact - the opposite of the fix.
  const hiddenBucketTypes: EventType[] = [];
  if (!leadsEnabled) hiddenBucketTypes.push('walkthrough');
  if (!canSeePlans) hiddenBucketTypes.push('service-plan');

  // Roster — the assignable pool (active ADMIN + SALES + TECHNICIAN), department-scoped
  // SERVER-side (D3). One query replaces the old per-role pair; 'all' = org-wide.
  const { data: roster = [] } = useAssignableUsers({
    departmentId: departmentFilter !== 'all' ? departmentFilter : undefined,
  });

  // Org-wide roster for LABELS (TG9 fold-in): crews can include members outside the active
  // department filter, so name lookups (drop modal, ghost dialogs) must never be dept-scoped.
  // Cached separately from `roster`; columns keep the scoped list.
  const { data: orgRoster = [] } = useAssignableUsers();

  // ─── Event transformation (adapters → SchedulableEvent) ────────────────────

  const { scheduledEvents, bucketEvents, visibleBucketEvents, conflictIds } = useScheduleEvents({
    scheduledJobs,
    walkthroughLeads,
    unassignedJobs,
    unscheduledWalkthroughs,
    hiddenSidebarIds: planMode.hiddenSidebarIds,
    tz,
  });

  // Apply the pendingMove override so the event visually stays at the new position
  // during the confirmation dialog. The override carries the (unchanged) crew.
  const allEventsWithPending = useMemo<ScheduledBoardEvent[]>(() => {
    if (!pendingMove) return scheduledEvents;
    return scheduledEvents.map((e) =>
      e.id === pendingMove.eventId
        ? { ...e, start: pendingMove.newStart, end: pendingMove.newEnd, crew: pendingMove.crew }
        : e,
    );
  }, [scheduledEvents, pendingMove]);

  // Merge ghost events when plan mode is active (ghosts always carry real Dates).
  const ghostCalendarEvents = useMemo<ScheduledBoardEvent[]>(() => {
    if (!planMode.isActive) return [];
    return planMode.ghosts.map((g) => ({
      id: `ghost-${g.id}`,
      type: g.sourceType,
      number: ((g.raw.job_number ?? g.raw.lead_number) as string | undefined) ?? '',
      title: g.title,
      customer: g.customerName,
      crew: g.crew,
      ownerId: null,
      // g.start/g.end are real instants (see usePlanMode.ts) — this is a read boundary
      // exactly like eventAdapters.ts, converting into the org wall clock for the grid.
      start: toWallClock(new Date(g.start), tz),
      end: toWallClock(new Date(g.end), tz),
      isGhost: true,
      ghostId: g.id,
      raw: g.raw,
    }));
  }, [planMode.isActive, planMode.ghosts, tz]);

  const allEvents = useMemo<ScheduledBoardEvent[]>(
    () => [...allEventsWithPending, ...ghostCalendarEvents],
    [allEventsWithPending, ghostCalendarEvents],
  );

  // Events restricted to the active time window (Day/Week grid only). Without
  // this, react-big-calendar clamps out-of-window jobs to the top/bottom edge
  // as slivers. All-day events and Month view are unaffected.
  const windowedEvents = useMemo<ScheduledBoardEvent[]>(() => {
    if (timeWindow === 'full' || calendarView === Views.MONTH) return allEvents;
    const startMin = calendarMin.getHours() * 60 + calendarMin.getMinutes();
    const endMin = calendarMax.getHours() * 60 + calendarMax.getMinutes();
    return allEvents.filter((e) => {
      if (isAllDayEvent(e)) return true;
      const s = e.start.getHours() * 60 + e.start.getMinutes();
      const en = e.end.getHours() * 60 + e.end.getMinutes();
      return s < endMin && en > startMin;
    });
  }, [allEvents, timeWindow, calendarView, calendarMin, calendarMax]);

  const hasAllDayEvents = useMemo(
    () => allEvents.some((e) => isAllDayEvent(e)),
    [allEvents],
  );

  // ─── Resources (grouped view) ─────────────────────────

  /** Display names for a crew (user ids) — org-wide lookup so a department filter can
   *  never blank out names of crew members outside the active dept (TG9 fold-in). */
  const crewNamesFromRoster = (ids: string[]): string =>
    ids
      .map((id) => orgRoster.find((u) => u.id === id))
      .filter((u): u is AssignableUser => Boolean(u))
      .map((u) => `${u.first_name} ${u.last_name}`)
      .join(', ');

  // Member columns for BOTH member views. Department scoping happens server-side (the
  // assignable endpoint); the gear's Staff Filter stays a client-side role narrow.
  const boardMembers = roster.filter((u) => roleFilter === 'all' || u.role === roleFilter);

  // ─── Event styles ────────────────────────────────────

  const eventStyleGetter = useCallback((event: BoardEvent) => {
    const completed = isCompletedEvent(event);
    const status = event.raw?.status as string | undefined;

    // Ghost event styling - dashed border over the family's tinted surface. The
    // family must match the accent the CONFIRMED event of that type already uses
    // (see the type-accent block below: job=info, walkthrough=warning), so a
    // ghost previews the thing it will become rather than introducing a third
    // colour meaning at drop time.
    if (event.isGhost) {
      const ghostBase = event.type === 'walkthrough'
        ? {
            background: 'rgb(var(--warning-surface))',
            border: '2px dashed rgb(var(--warning-border))',
            color: 'rgb(var(--warning-text))',
          }
        : {
            background: 'rgb(var(--info-surface))',
            border: '2px dashed rgb(var(--info-border))',
            color: 'rgb(var(--info-text))',
          };
      return {
        style: {
          ...ghostBase,
          borderRadius: '6px',
          padding: '4px 8px',
          cursor: 'grab',
          opacity: 0.7,
        },
      };
    }

    // The two reds (D7 + §3.8 state 4) — `danger` token classes, never hexes; the `!`
    // (important) modifier outranks react-big-calendar's own .rbc-event colors.
    // Guard on raw (mirrors ScheduleEvent): the outside-drag preview stub
    // ({id,title,start,end}) has no crew/raw — eventDangerState would throw, and a
    // drag preview must never paint red.
    const dangerState = event.raw ? eventDangerState(event, conflictIds) : null;
    if (dangerState === 'needs-crew') {
      // Red FILL — timed but crew-less. Only the Standard views ever show these
      // (member columns are structurally crew-only), so this is THE state-4 surface.
      return {
        className: '!bg-danger !text-on-fill !border-0',
        style: {
          borderRadius: '6px',
          padding: '4px 8px',
          boxShadow: '0 1px 3px rgba(0,0,0,0.12)',
          cursor: 'grab',
        },
      };
    }
    if (dangerState === 'double-booked') {
      // Red OUTLINE — shares a crew member with an overlapping event.
      return {
        className: '!bg-surface-light !text-text-primary !border-2 !border-solid !border-danger',
        style: {
          borderRadius: '6px',
          padding: '4px 8px',
          boxShadow: '0 1px 3px rgba(0,0,0,0.12)',
          cursor: 'grab',
        },
      };
    }

    // Type accents - META tokens via `!` classes (job=info, walkthrough=warning), the
    // scheme the legend advertises; red fill/outline are reserved for the two reds above.
    // Completed / in-progress keep their treatments, re-tokened off the raw hexes
    // they used to carry: completed now reads `text-soft`, in-flight reads `info`.
    // This three-axis board treatment deliberately does not resolve through
    // STATUS_REGISTRY, for the reason recorded on `boardCardScheme` in scheduleModel.ts,
    // and it is listed in the `## Known survivors` section of the status-registry work
    // package doc.
    let className: string;
    if (completed) {
      className = '!bg-text-soft !text-on-fill !border-0';
    } else if (event.type === 'walkthrough') {
      className = '!bg-warning/10 !text-warning !border-0 !border-l-4 !border-l-warning !border-solid';
    } else if (IN_FLIGHT_STATUSES.has(status ?? '')) {
      className = '!bg-info !text-on-fill !border-0';
    } else {
      // SCHEDULED
      className = '!bg-info/10 !text-info !border-0 !border-l-4 !border-l-info !border-solid';
    }

    const isHighlighted = event.id === highlightedEventId;
    const boxShadow = '0 0 0 3px rgb(var(--primary) / 0.5)';
    const animation = 'search-highlight 1.5s ease-in-out infinite';
    return {
      className,
      style: {
        borderRadius: '6px',
        padding: '4px 8px',
        boxShadow: '0 1px 3px rgba(0,0,0,0.12)',
        cursor: completed ? 'default' : 'grab',
        ...(completed && { opacity: 0.6 }),
        ...(isHighlighted && { boxShadow, animation, zIndex: 10 }),
      },
    };
  }, [conflictIds, highlightedEventId]);

  // ─── Slot styles (off-hours dimming) ─────────────────

  const slotPropGetter = useCallback((date: Date) => {
    const hour = date.getHours();
    if (hour < 7 || hour >= 19) {
      return { style: { backgroundColor: 'rgb(var(--background-light))' } };
    }
    return {};
  }, []);

  // ─── Mutations ───────────────────────────────────────

  const assignMutation = useMutation<
    unknown,
    unknown,
    { jobId: string; crew: string[]; start: string; end: string; force?: boolean },
    { previous?: [readonly unknown[], unknown][] }
  >({
    mutationFn: async (payload) => {
      // REPLACE semantics: always the full crew array. [] is valid — crew ⟂ schedule,
      // a crew-less job can still be (re)scheduled (state 4).
      const { data } = await api.post(`/api/jobs/${payload.jobId}/assign`, {
        assignee_ids: payload.crew,
        scheduled_start: payload.start,
        scheduled_end: payload.end,
        ...(payload.force ? { force: true } : {}),
      });
      return data;
    },
    onMutate: async (payload) => {
      // Prefix-match (the TG10 crew-swap pattern) — the live key is
      // ['schedule-jobs', dateRange, departmentFilter]; an exact-key write would miss it.
      await queryClient.cancelQueries({ queryKey: ['schedule-jobs'] });
      const previous = queryClient.getQueriesData({ queryKey: ['schedule-jobs'] });
      // Optimistically move the event to its new time/crew immediately. Only the ids are
      // known here; names rehydrate on the invalidate-refetch a moment later.
      queryClient.setQueriesData<Record<string, unknown>[]>({ queryKey: ['schedule-jobs'] }, (old) =>
        (old ?? []).map((job) => {
          if (job.id !== payload.jobId) return job;
          return {
            ...job,
            scheduled_start: payload.start,
            scheduled_end: payload.end,
            assignees: payload.crew.map((id) => ({ user: { id } })),
          };
        }),
      );
      return { previous };
    },
    onSuccess: (_, payload) => {
      queryClient.invalidateQueries({ queryKey: ['schedule-jobs'] });
      queryClient.invalidateQueries({ queryKey: ['schedule-unassigned'] });
      queryClient.invalidateQueries({ queryKey: ['jobs'] });
      queryClient.invalidateQueries({ queryKey: ['job', payload.jobId] });
      setConflictToast(null);
    },
    onError: (err, payload, context) => {
      // Revert the optimistic update before showing conflict/error
      for (const [key, data] of context?.previous ?? []) queryClient.setQueryData(key, data);
      // Clear any lingering hover tooltip so it doesn't show under the conflict modal
        const axiosErr = err as { response?: { status?: number; data?: { error?: string; conflicts?: { type: 'job' | 'walkthrough'; id: string; number: string; start: string | Date; end: string | Date }[] } } };
      if (axiosErr.response?.status === 409) {
        setConflictToast({
          message: extractApiError(err, 'Scheduling conflict detected.'),
          conflicts: axiosErr.response.data?.conflicts,
          pendingPayload: { kind: 'job', jobId: payload.jobId, crew: payload.crew, start: payload.start, end: payload.end },
        });
      } else {
        setErrorToast(extractApiError(err, 'Failed to schedule job. Please try again.'));
      }
    },
  });

  const walkthroughRescheduleMutation = useMutation<
    unknown,
    unknown,
    { leadId: string; newStart: string; crew: string[]; durationMinutes: number; force?: boolean },
    { previous?: Record<string, unknown>[] }
  >({
    mutationFn: async (payload) => {
      // REPLACE semantics: always the full performer array. [] is valid (crew ⟂ schedule) —
      // and a reschedule/resize passes the CURRENT crew so it can never drop performers.
      await api.post(`/api/leads/${payload.leadId}/walkthrough/schedule`, {
        walkthrough_scheduled_at: payload.newStart,
        performer_ids: payload.crew,
        walkthrough_duration_minutes: payload.durationMinutes,
        force: payload.force ?? false,
      });
    },
    onMutate: async (payload) => {
      await queryClient.cancelQueries({ queryKey: ['schedule-walkthroughs', dateRange] });
      const previous = queryClient.getQueryData<Record<string, unknown>[]>(['schedule-walkthroughs', dateRange]);
      queryClient.setQueryData<Record<string, unknown>[]>(['schedule-walkthroughs', dateRange], (old) =>
        (old ?? []).map((lead) => {
          if (lead.id !== payload.leadId) return lead;
          return { ...lead, walkthrough_scheduled_at: payload.newStart };
        }),
      );
      return { previous };
    },
    onSuccess: (_, payload) => {
      queryClient.invalidateQueries({ queryKey: ['schedule-walkthroughs', dateRange] });
      queryClient.invalidateQueries({ queryKey: ['schedule-unscheduled-walkthroughs'] });
      queryClient.invalidateQueries({ queryKey: ['lead', payload.leadId] });
      setConflictToast(null);
    },
    onError: (err, payload, context) => {
      if (context?.previous !== undefined) {
        queryClient.setQueryData(['schedule-walkthroughs', dateRange], context.previous);
      }
      // 409 → the same "Schedule Anyway" conflict modal jobs get (TG9 fold-in — was a
      // generic error toast, leaving walkthroughs with no force path).
      const axiosErr = err as { response?: { status?: number; data?: { error?: string; conflicts?: { type: 'job' | 'walkthrough'; id: string; number: string; start: string | Date; end: string | Date }[] } } };
      if (axiosErr.response?.status === 409) {
        setConflictToast({
          message: extractApiError(err, 'Scheduling conflict detected.'),
          conflicts: axiosErr.response.data?.conflicts,
          pendingPayload: {
            kind: 'walkthrough',
            leadId: payload.leadId,
            newStart: payload.newStart,
            crew: payload.crew,
            durationMinutes: payload.durationMinutes,
          },
        });
      } else {
        setErrorToast(extractApiError(err, 'Failed to reschedule walkthrough.'));
      }
    },
  });

  // ─── TG10 — direct-drag crew swap (D2) + drag-to-unschedule (D6) ──────────
  // Cross-lane drag = crew-only REPLACE (no schedule write — the drop slot's time is
  // deliberately ignored; drag changes where/when + whole lanes, the editor changes who).
  // Optimistic: rewriting the M2M wrap rows with bare ids flips column membership
  // instantly (isOnBoardFor keys off ids); names rehydrate on the invalidate-refetch.
  // setQueriesData/getQueriesData prefix-match so the dept-filtered jobs key is covered.

  const jobCrewSwapMutation = useMutation<
    unknown,
    unknown,
    { jobId: string; crew: string[] },
    { previous?: [readonly unknown[], unknown][] }
  >({
    mutationFn: async ({ jobId, crew }) => {
      const { data } = await api.post(`/api/jobs/${jobId}/assignees`, { assignee_ids: crew });
      return data;
    },
    onMutate: async ({ jobId, crew }) => {
      await queryClient.cancelQueries({ queryKey: ['schedule-jobs'] });
      const previous = queryClient.getQueriesData({ queryKey: ['schedule-jobs'] });
      queryClient.setQueriesData<Record<string, unknown>[]>({ queryKey: ['schedule-jobs'] }, (old) =>
        (old ?? []).map((job) =>
          job.id === jobId ? { ...job, assignees: crew.map((id) => ({ user: { id } })) } : job,
        ),
      );
      return { previous };
    },
    onSuccess: (_, { jobId }) => {
      queryClient.invalidateQueries({ queryKey: ['schedule-jobs'] });
      queryClient.invalidateQueries({ queryKey: ['jobs'] });
      queryClient.invalidateQueries({ queryKey: ['job', jobId] });
    },
    onError: (err, _payload, context) => {
      for (const [key, data] of context?.previous ?? []) queryClient.setQueryData(key, data);
      setErrorToast(extractApiError(err, 'Failed to swap the crew. Please try again.'));
    },
  });

  const walkthroughCrewSwapMutation = useMutation<
    unknown,
    unknown,
    { leadId: string; crew: string[] },
    { previous?: [readonly unknown[], unknown][] }
  >({
    mutationFn: async ({ leadId, crew }) => {
      const { data } = await api.post(`/api/leads/${leadId}/walkthrough/performers`, {
        performer_ids: crew,
      });
      return data;
    },
    onMutate: async ({ leadId, crew }) => {
      await queryClient.cancelQueries({ queryKey: ['schedule-walkthroughs'] });
      const previous = queryClient.getQueriesData({ queryKey: ['schedule-walkthroughs'] });
      queryClient.setQueriesData<Record<string, unknown>[]>({ queryKey: ['schedule-walkthroughs'] }, (old) =>
        (old ?? []).map((lead) =>
          lead.id === leadId
            ? { ...lead, walkthrough_performers: crew.map((id) => ({ user: { id } })) }
            : lead,
        ),
      );
      return { previous };
    },
    onSuccess: (_, { leadId }) => {
      queryClient.invalidateQueries({ queryKey: ['schedule-walkthroughs'] });
      queryClient.invalidateQueries({ queryKey: ['lead', leadId] });
    },
    onError: (err, _payload, context) => {
      for (const [key, data] of context?.previous ?? []) queryClient.setQueryData(key, data);
      setErrorToast(extractApiError(err, 'Failed to swap the performers. Please try again.'));
    },
  });

  // D6 — clear the TIME, keep the crew (state 2 → 3). The card leaves the board and
  // reappears in its Unscheduled bucket with the crew remembered. No customer email.
  const unscheduleMutation = useMutation<unknown, unknown, SchedulableEvent>({
    mutationFn: async (ev) => {
      if (ev.type === 'walkthrough') {
        await api.post(`/api/leads/${ev.raw.id as string}/walkthrough/unschedule`);
      } else {
        await api.post(`/api/jobs/${ev.id}/unassign`);
      }
    },
    onSuccess: (_, ev) => {
      queryClient.invalidateQueries({ queryKey: ['schedule-jobs'] });
      queryClient.invalidateQueries({ queryKey: ['schedule-walkthroughs'] });
      queryClient.invalidateQueries({ queryKey: ['schedule-unassigned'] });
      queryClient.invalidateQueries({ queryKey: ['schedule-unscheduled-walkthroughs'] });
      if (ev.type === 'walkthrough') {
        queryClient.invalidateQueries({ queryKey: ['lead', ev.raw.id as string] });
      } else {
        queryClient.invalidateQueries({ queryKey: ['jobs'] });
        queryClient.invalidateQueries({ queryKey: ['job', ev.id] });
        queryClient.invalidateQueries({ queryKey: servicePlanKeys.bucket });
      }
      toast({ title: 'Unscheduled — crew kept', description: `${ev.number} is back in its bucket.` });
    },
    onError: (err) => setErrorToast(extractApiError(err, 'Failed to unschedule. Please try again.')),
  });

  // Board "Mark Complete" — one-click close-out, no completion-note modal.
  const completeMutation = useMutation<unknown, unknown, { jobId: string; number: string }>({
    mutationFn: async ({ jobId }) => api.post(`/api/jobs/${jobId}/complete`),
    onSuccess: (_, { number }) => {
      queryClient.invalidateQueries({ queryKey: ['schedule-jobs'] });
      queryClient.invalidateQueries({ queryKey: ['schedule-unassigned'] });
      queryClient.invalidateQueries({ queryKey: ['jobs'] });
      toast({ title: 'Job completed', description: `${number} marked complete.` });
    },
    onError: (err) => setErrorToast(extractApiError(err, 'Failed to complete. Please try again.')),
  });

  // ─── TG11 — Unassigned bucket stack seams ──────────────────────────────────
  // The component renders the buckets; the page owns the drag channels, the drag ref,
  // click routing, context menus, and the unschedule write.

  /** Bucket card drag-out: SAME channels the drop zones expect (job-id / bare-lead walkthrough-id). */
  const handleBucketCardDragStart = useCallback((ev: SchedulableEvent, e: React.DragEvent) => {
    document.body.classList.add('is-dragging');
    draggingJobIdRef.current = ev.id;
    if (ev.type === 'walkthrough') {
      e.dataTransfer.setData(WALKTHROUGH_ID, ev.raw.id as string); // bare lead id (codec restores wt-)
    } else {
      e.dataTransfer.setData(JOB_ID, ev.id);
    }
    e.dataTransfer.effectAllowed = 'move';
    // Compact number-chip drag image, tinted by type off the solid semantic fills
    // (walkthrough = warning, job = info) with the on-fill foreground token.
    const ghost = document.createElement('div');
    ghost.textContent = ev.number;
    const ghostFill = ev.type === 'walkthrough'
      ? 'rgb(var(--warning-strong))'
      : 'rgb(var(--info-strong))';
    ghost.style.cssText =
      `position:fixed;top:-100px;background:${ghostFill};color:rgb(var(--text-on-fill));` +
      'padding:4px 10px;border-radius:4px;font-size:12px;font-weight:600;white-space:nowrap;';
    document.body.appendChild(ghost);
    e.dataTransfer.setDragImage(ghost, ghost.offsetWidth / 2, 12);
    requestAnimationFrame(() => {
      if (document.body.contains(ghost)) document.body.removeChild(ghost);
    });
  }, []);

  const handleBucketCardDragEnd = useCallback(() => {
    document.body.classList.remove('is-dragging');
    draggingJobIdRef.current = null;
  }, []);

  /** TG12 — bucket cards open the same event editor as board cards (replaces the old
   *  per-type split: walkthrough → lead page, job → AssignJobDialog). */
  const handleBucketCardClick = useCallback(
    (ev: SchedulableEvent) => setEditorEventId(ev.id),
    [],
  );

  const handleBucketCardContextMenu = useCallback((ev: SchedulableEvent, e: React.MouseEvent) => {
    if (ev.type === 'service-plan') return; // the sidebar menu only knows jobs + walkthroughs
    e.preventDefault();
    setSidebarContextMenu({
      x: e.clientX,
      y: e.clientY,
      type: ev.type,
      id: ev.type === 'walkthrough' ? (ev.raw.id as string) : ev.id,
    });
  }, []);

  /**
   * The unschedule gate, shared by the D6 drag path and the editor's "Move to
   * Unscheduled" button. Jobs unschedule from any status since Spec B1 — the
   * backend no longer 400s. The walkthrough branch is a Lead, out of scope.
   *
   * Walkthrough-as-entity redesign, PR-C2: WALKTHROUGH_SCHEDULED left LeadStatus. This ALSO
   * fixes a latent PR-B2 regression - scheduleWalkthrough stopped writing that status value
   * once the guard moved onto the Walkthrough row's own status (D2), so `ev.raw.status ===
   * 'WALKTHROUGH_SCHEDULED'` had already gone permanently false for any walkthrough scheduled
   * after PR-B2 shipped, making every drag-to-unscheduled attempt fail with a false "already
   * happened". Reads the same current-visit-projected fields the detail page uses instead.
   * `useScheduleData`'s /api/leads query is list-mode, which does not carry
   * walkthrough_cancelled_at (detail-only), so a CANCELLED visit whose scheduled_at still falls
   * in the viewed date range (kept as D15 history) is indistinguishable here from a live
   * SCHEDULED one - same known limitation as LeadsPage.tsx's getWalkthroughDisplay.
   */
  const unscheduleGate = useCallback(
    (ev: SchedulableEvent): { ok: true } | { ok: false; reason: string } => {
      if (ev.type === 'walkthrough') {
        const scheduledAt = ev.raw.walkthrough_scheduled_at as string | null | undefined;
        const completedAt = ev.raw.walkthrough_completed_at as string | null | undefined;
        return scheduledAt && !completedAt
          ? { ok: true }
          : { ok: false, reason: 'This walkthrough already happened.' };
      }
      return { ok: true };
    },
    [],
  );

  /**
   * D6 drop seam — the component gates the channel (grid-event-id) + plan mode; the page
   * keeps the stale guard and pre-gates via unscheduleGate with a reason toast instead
   * of the confirm dialog.
   */
  const handleUnscheduleDrop = useCallback(
    (boardEventId: string) => {
      if (planMode.isActive) return; // defense in depth — the component already refuses the drop
      if (boardReadOnly) return; // D9 defense in depth — board cards aren't draggable for read-only
      const ev = scheduledEvents.find((s) => s.id === boardEventId);
      if (!ev) return; // ghost/stale drag — nothing live to unschedule
      const gate = unscheduleGate(ev);
      if (!gate.ok) {
        toast({ title: "Can't unschedule", description: `${ev.number} — ${gate.reason}` });
        return;
      }
      setUnscheduleConfirm(ev);
    },
    [planMode.isActive, scheduledEvents, unscheduleGate, boardReadOnly],
  );

  // ─── TG12 — event editor (the ONLY per-person crew path) ──────────────────
  // Clicking ANY live card (board or bucket, all three views) opens this editor.
  // Drags stay whole-lane swaps/reschedules; the D5 modal stays initial scheduling.

  /** The live editor event — re-derived from the query collections each render, so a
   *  save (crew/time/unschedule) refreshes the open editor in place. */
  const editorEvent = useMemo<SchedulableEvent | null>(
    () =>
      editorEventId
        ? ([...scheduledEvents, ...bucketEvents].find((e) => e.id === editorEventId) ?? null)
        : null,
    [editorEventId, scheduledEvents, bucketEvents],
  );

  // TG13 fold-in (TG12 review) — clear a STALE editor id: if the event vanished from the
  // live collections (cancelled/completed elsewhere, refetch dropped it) the dialog shows
  // nothing now, but a lingering id would pop the editor open the moment the event ever
  // re-enters a collection. Skip while an overlay (conflict / unschedule confirm) hides
  // the editor on purpose — it must reopen for the same event after the overlay closes.
  useEffect(() => {
    if (editorEventId && !editorEvent && !conflictToast && !unscheduleConfirm) {
      setEditorEventId(null);
    }
  }, [editorEventId, editorEvent, conflictToast, unscheduleConfirm]);

  const openEditorFor = useCallback((event: BoardEvent) => {
    if (event.isGhost) return; // ghosts keep their own context menu
    setEditorEventId(event.id);
  }, []);

  /** Status gate for the editor's "Move to Unscheduled" (timed events only). */
  const editorUnscheduleGate = editorEvent?.start ? unscheduleGate(editorEvent) : null;

  /** "Mark Complete" gate — a manager (not read-only) closing out a job from the board.
   *  Self-exclusion only (not ordering): re-completing an already-complete job is a no-op. */
  const editorCanComplete =
    !boardReadOnly &&
    editorEvent?.type === 'job' &&
    (editorEvent?.raw?.status as string | undefined) !== 'COMPLETED';

  /** Crew save → TG10's crew-only REPLACE mutations, by type. */
  const handleEditorSaveCrew = useCallback(
    (crew: string[]) => {
      if (boardReadOnly) return; // D9 defense in depth — the editor is view-only for read-only roles
      if (!editorEvent) return;
      const onUpdated = () => {
        toast({ title: 'Crew updated', description: `${editorEvent.number} — crew replaced.` });
        queryClient.invalidateQueries({ queryKey: ['schedule-jobs'] });
        queryClient.invalidateQueries({ queryKey: ['schedule-walkthroughs'] });
        queryClient.invalidateQueries({ queryKey: ['schedule-unassigned'] });
        queryClient.invalidateQueries({ queryKey: ['schedule-unscheduled-walkthroughs'] });
      };
      if (editorEvent.type === 'walkthrough') {
        walkthroughCrewSwapMutation.mutate(
          { leadId: editorEvent.raw.id as string, crew },
          { onSuccess: onUpdated },
        );
      } else {
        jobCrewSwapMutation.mutate({ jobId: editorEvent.id, crew }, { onSuccess: onUpdated });
      }
    },
    [editorEvent, jobCrewSwapMutation, walkthroughCrewSwapMutation, queryClient, boardReadOnly],
  );

  /** Time save → the existing schedule mutations with the CURRENT crew (crew ⟂ schedule);
   *  a 409 flows into the page-level conflict modal's force path. */
  const handleEditorSaveTime = useCallback(
    (start: WallClock, durationMin: number) => {
      if (boardReadOnly) return; // D9 defense in depth — the editor is view-only for read-only roles
      if (!editorEvent) return;
      if (editorEvent.type === 'walkthrough') {
        walkthroughRescheduleMutation.mutate({
          leadId: editorEvent.raw.id as string,
          newStart: wallClockToIso(start, tz),
          crew: editorEvent.crew,
          durationMinutes: durationMin,
        });
      } else {
        assignMutation.mutate({
          jobId: editorEvent.id,
          crew: editorEvent.crew,
          start: wallClockToIso(start, tz),
          end: wallClockToIso(addMsToWallClock(start, durationMin * 60_000), tz),
        });
      }
    },
    [editorEvent, assignMutation, walkthroughRescheduleMutation, boardReadOnly, tz],
  );

  // ─── D5 unified drop modal — open / change / confirm ──

  /** Org default anchor for day-granularity drops (member-week, standard-day). */
  const defaultStartMin = hhmmToMin(org?.default_schedule_start_time ?? '08:00');

  /** Open the modal for a bucket event, pre-filled by WHERE it was dropped. */
  const openDropModal = useCallback(
    (ev: SchedulableEvent, target: DropTarget) => {
      setDropModal({
        event: ev,
        draft: draftFromDrop(ev, target, {
          defaultStartMin: hhmmToMin(org?.default_schedule_start_time ?? '08:00'),
          defaultDurationMin:
            ev.type === 'walkthrough'
              ? (org?.default_walkthrough_duration_min ?? 60)
              : (org?.default_job_duration_min ?? 120),
        }),
      });
    },
    [org],
  );

  // Advisory conflict note — re-scanned as the draft changes; never blocks Confirm.
  const firstNameById = useMemo(
    () => new Map(orgRoster.map((u) => [u.id, u.first_name])),
    [orgRoster],
  );
  // Advisory only — scans the loaded date range; the backend 409 is the real guard.
  const dropConflictNote = useMemo(
    () => (dropModal ? conflictNoteFor(dropModal.draft, scheduledEvents, firstNameById) : null),
    [dropModal, scheduledEvents, firstNameById],
  );

  /** POST the draft through the existing mutations (the modal itself never posts). */
  const submitDropDraft = useCallback(
    (event: SchedulableEvent, draft: ScheduleDraft) => {
      const startIso = wallClockToIso(draft.start, tz);
      const endIso = wallClockToIso(addMsToWallClock(draft.start, draft.durationMin * 60_000), tz);
      const onScheduled = () => {
        queryClient.invalidateQueries({ queryKey: ['schedule-jobs'] });
        queryClient.invalidateQueries({ queryKey: ['schedule-walkthroughs'] });
        queryClient.invalidateQueries({ queryKey: ['schedule-unassigned'] });
        queryClient.invalidateQueries({ queryKey: ['schedule-unscheduled-walkthroughs'] });
        toast({
          title: 'Scheduled',
          description: `${event.number} — ${format(draft.start, 'EEE, MMM d · h:mm a')}`,
        });
      };
      // Draft-loss fix (TG10 fold-in): the modal closes optimistically below, so a
      // non-409 failure (500, network) must restore it — the user keeps their draft.
      // A 409 stays closed: it flows into the page-level conflict modal's force path.
      const restoreDraftOnNon409 = (err: unknown) => {
        if ((err as { response?: { status?: number } })?.response?.status !== 409) {
          setDropModal({ event, draft });
        }
      };
      if (event.type === 'walkthrough') {
        walkthroughRescheduleMutation.mutate(
          {
            leadId: event.raw.id as string,
            newStart: startIso,
            crew: draft.crew,
            durationMinutes: draft.durationMin,
          },
          { onSuccess: onScheduled, onError: restoreDraftOnNon409 },
        );
      } else {
        assignMutation.mutate(
          { jobId: event.id, crew: draft.crew, start: startIso, end: endIso },
          { onSuccess: onScheduled, onError: restoreDraftOnNon409 },
        );
      }
      // Close optimistically — a 409 surfaces through the page-level conflict modal.
      setDropModal(null);
      setNeedsCrewConfirm(false);
    },
    [assignMutation, walkthroughRescheduleMutation, queryClient, tz],
  );

  const handleDropModalConfirm = useCallback(() => {
    if (!dropModal) return;
    if (dropModal.draft.crew.length === 0) {
      // §3.8 state 4 is valid but deliberate — warn before saving a crew-less schedule.
      setNeedsCrewConfirm(true);
      return;
    }
    submitDropDraft(dropModal.event, dropModal.draft);
  }, [dropModal, submitDropDraft]);

  // ─── DnD Handlers ────────────────────────────────────

  const handleEventDrop = useCallback(
    ({
      event,
      start,
      end,
      isAllDay,
    }: {
      event: BoardEvent;
      start: Date | string;
      end: Date | string;
      isAllDay?: boolean;
    }) => {
      if (boardReadOnly) return; // D9 defense in depth — drags are disabled at the source too
      // Money, not status, freezes a job for rescheduling (Spec B1, B-2).
      if (!event.isGhost) {
        const gate = rescheduleGate(event);
        if (!gate.ok) {
          toast({ title: "Can't reschedule", description: `${event.number} — ${gate.reason}` });
          return;
        }
      }

      // RBC only ever hands back wall-clock-space values (it has no timezone concept — see
      // schedule-tz.ts) — these are WallClock, not a fresh browser-local instant.
      let startDate: WallClock = asWallClock(start instanceof Date ? start : new Date(start));
      let endDate: WallClock = asWallClock(end instanceof Date ? end : new Date(end));

      // All-day drop: normalize to midnight-to-midnight
      if (isAllDayEvent(event) || isAllDay) {
        startDate = asWallClock(startOfDay(startDate));
        endDate = addMsToWallClock(startDate, 24 * 60 * 60_000);
      }

      // If dragging a ghost event, update its position (crew rides along unchanged)
      if (event.isGhost && event.ghostId) {
        planMode.updateGhostPosition(event.ghostId, wallClockToIso(startDate, tz), wallClockToIso(endDate, tz));
        return;
      }

      // Plan Mode: create ghost instead of live mutation — the draft keeps the current crew
      if (planMode.isActive && !event.isGhost) {
        const customer = event.raw.customer as { first_name: string; last_name: string } | null;
        const location = event.raw.service_location as { address_line1?: string; city?: string; state?: string } | null;
        const customerName = customer ? customerDisplayName(customer, 'Unknown') : 'Unknown';
        const address = location ? [location.address_line1, location.city, location.state].filter(Boolean).join(', ') : '';

        planMode.addGhost({
          sourceId: event.type === 'job' ? event.id : (event.raw.id as string),
          sourceType: event.type === 'walkthrough' ? 'walkthrough' : 'job',
          isFromSidebar: false,
          isMovedConfirmed: false,
          start: wallClockToIso(startDate, tz),
          end: wallClockToIso(endDate, tz),
          crew: [...event.crew],
          title: event.title,
          customerName,
          address,
          raw: event.raw,
        });
        return;
      }

      // Crew ⟂ schedule: a standard-view drag moves TIME only. The confirm dialog then
      // POSTs the event's CURRENT crew (possibly [] — a timed, crew-less event is valid
      // and surfaces as state 4) with the new times, so a move can never drop crew.
      const oldStart = event.start;
      const oldEnd = event.end;
      if (!oldStart || !oldEnd) return; // unscheduled events can't be dragged on the calendar
      setPendingMove({ eventId: event.id, newStart: startDate, newEnd: endDate, crew: event.crew });
      setRescheduleConfirm({ event, oldStart, oldEnd, newStart: startDate, newEnd: endDate });
    },
    [planMode, boardReadOnly, tz],
  );

  const handleEventResize = useCallback(
    ({
      event,
      start,
      end,
    }: {
      event: BoardEvent;
      start: Date | string;
      end: Date | string;
    }) => {
      if (boardReadOnly) return; // D9 defense in depth — resizable is off for read-only roles
      // Money, not status, freezes a job for rescheduling (Spec B1, B-2).
      if (!event.isGhost) {
        const gate = rescheduleGate(event);
        if (!gate.ok) {
          toast({ title: "Can't reschedule", description: `${event.number} — ${gate.reason}` });
          return;
        }
      }

      // RBC only ever hands back wall-clock-space values — see handleEventDrop above.
      const startDate: WallClock = asWallClock(start instanceof Date ? start : new Date(start));
      const endDate: WallClock = asWallClock(end instanceof Date ? end : new Date(end));

      // Plan Mode: create ghost instead of live mutation — the draft keeps the current crew
      if (planMode.isActive && !event.isGhost) {
        const customer = event.raw.customer as { first_name: string; last_name: string } | null;
        const location = event.raw.service_location as { address_line1?: string; city?: string; state?: string } | null;
        const customerName = customer ? customerDisplayName(customer, 'Unknown') : 'Unknown';
        const address = location ? [location.address_line1, location.city, location.state].filter(Boolean).join(', ') : '';

        planMode.addGhost({
          sourceId: event.type === 'job' ? event.id : (event.raw.id as string),
          sourceType: event.type === 'walkthrough' ? 'walkthrough' : 'job',
          isFromSidebar: false,
          isMovedConfirmed: false,
          start: wallClockToIso(startDate, tz),
          end: wallClockToIso(endDate, tz),
          crew: [...event.crew],
          title: event.title,
          customerName,
          address,
          raw: event.raw,
        });
        return;
      }

      // Crew ⟂ schedule: resizing needs no crew — POST the CURRENT crew (possibly [])
      // with the new times so a resize can never drop assignees/performers.
      if (event.type === 'job') {
        assignMutation.mutate({
          jobId: event.id,
          crew: event.crew,
          start: wallClockToIso(startDate, tz),
          end: wallClockToIso(endDate, tz),
        });
      } else if (event.type === 'walkthrough') {
        walkthroughRescheduleMutation.mutate({
          leadId: event.raw.id as string,
          newStart: wallClockToIso(startDate, tz),
          crew: event.crew,
          durationMinutes: Math.round((endDate.getTime() - startDate.getTime()) / 60_000),
        });
      }
    },
    [assignMutation, walkthroughRescheduleMutation, planMode, boardReadOnly, tz],
  );

  // Drops from the sidebar onto the STANDARD calendar (the grouped views handle their own
  // drops via onDropJob). Plan-visit drops materialize directly and plan mode still ghosts;
  // every other bucket drop opens the D5 unified modal pre-filled by where it landed
  // (exact slot → standard-time; month cell / all-day strip → standard-day).
  const handleDropFromOutside = useCallback(
    ({ start, end, allDay }: { start: Date | string; end: Date | string; allDay?: boolean }) => {
      if (boardReadOnly) return; // D9 defense in depth — bucket cards aren't drag sources either
      const rawId = draggingJobIdRef.current;
      if (!rawId) return;
      draggingJobIdRef.current = null;

      // RBC only ever hands back wall-clock-space values — see handleEventDrop above.
      const startDate: WallClock = asWallClock(start instanceof Date ? start : new Date(start));
      const endDate: WallClock = asWallClock(end instanceof Date ? end : new Date(end));

      const parsed = parseBoardDragId(rawId);

      // ── Service-plan visit drop from sidebar (pv- prefix) ──
      // Lazily materialize the next visit: schedule-visit spawns a real visit-Job at
      // status SCHEDULED with the drop times but no crew (state 4 — needs crew).
      // Invalidate both the board and the unassigned bucket so the card appears immediately.
      if (parsed.kind === 'plan-visit') {
        scheduleVisitMutation.mutate(
          { id: parsed.entityId, scheduled_start: wallClockToIso(startDate, tz), scheduled_end: wallClockToIso(endDate, tz), assigned_to: null },
          {
            onSuccess: () => {
              queryClient.invalidateQueries({ queryKey: ['schedule-jobs'] });
              queryClient.invalidateQueries({ queryKey: ['schedule-unassigned'] });
            },
            onError: (err) => setErrorToast(extractApiError(err, 'Failed to schedule the plan visit.')),
          },
        );
        return;
      }

      const ev = bucketEvents.find((e) => e.id === rawId);
      if (!ev) {
        // Stale drag — the card left the bucket mid-drag (e.g. scheduled elsewhere).
        setErrorToast('That card is no longer in the Unscheduled bucket.');
        return;
      }

      // ── Plan mode: bucket drops become ghosts (flow unchanged) ──
      if (planMode.isActive) {
        if (parsed.kind === 'walkthrough') {
          planMode.addGhost({
            sourceId: parsed.entityId,
            sourceType: 'walkthrough',
            isFromSidebar: true,
            isMovedConfirmed: false,
            start: wallClockToIso(startDate, tz),
            end: wallClockToIso(endDate, tz),
            crew: [...ev.crew],
            title: ev.title,
            customerName: ev.customer,
            address: [ev.raw.service_address_line1, ev.raw.service_city, ev.raw.service_state]
              .filter(Boolean).join(', '),
            raw: ev.raw,
          });
        } else {
          const location = ev.raw.service_location as { address_line1?: string; city?: string; state?: string } | null;
          planMode.addGhost({
            sourceId: parsed.entityId,
            sourceType: 'job',
            isFromSidebar: true,
            isMovedConfirmed: false,
            start: wallClockToIso(startDate, tz),
            end: wallClockToIso(endDate, tz),
            crew: [...ev.crew],
            title: `${ev.number} — ${ev.customer}`,
            customerName: ev.customer,
            address: location
              ? [location.address_line1, location.city, location.state].filter(Boolean).join(', ')
              : '',
            raw: ev.raw,
          });
        }
        return;
      }

      // ── D5: the unified drop modal (replaces walkthrough direct-schedule + job AssignJobDialog) ──
      // rbc 1.19.4 never sets allDay:true from its DnD wrappers (both hardcode false).
      // All-day-strip drops arrive MIDNIGHT-anchored spanning a full day (WeekWrapper:
      // getDateForSlot → start + 1 'day'); timed-slot drops keep the 2h preview duration.
      // Calendar-day math, not raw ms (TG10 fold-in): the 23h spring-forward day broke the
      // old `spanMs >= 24h` check. The midnight anchor keeps late-evening timed drops
      // (22:00 + 2h touches/crosses midnight → calendar-day diff 1) classified as timed.
      const isAllDayStripDrop =
        Boolean(allDay) || // documented field kept as fallback for future rbc versions
        (differenceInCalendarDays(endDate, startDate) >= 1 &&
          startDate.getHours() === 0 &&
          startDate.getMinutes() === 0);
      const dayGranularity = calendarView === Views.MONTH || isAllDayStripDrop;
      openDropModal(
        ev,
        dayGranularity
          ? { kind: 'standard-day', date: asWallClock(startOfDay(startDate)) }
          : { kind: 'standard-time', start: startDate },
      );
    },
    [planMode, bucketEvents, scheduleVisitMutation, queryClient, calendarView, openDropModal, boardReadOnly, tz],
  );

  // ─── Slot select (click on empty slot) ───────────────

  const handleSelectSlot = useCallback(
    ({ start, end }: { start: Date | string; end: Date | string }) => {
      if (draggingJobIdRef.current) return;
      // RBC only ever hands back wall-clock-space values — see handleEventDrop above.
      const startDate: WallClock = asWallClock(start instanceof Date ? start : new Date(start));
      const endDate: WallClock = asWallClock(end instanceof Date ? end : new Date(end));
      // Month view: clicking a day opens that day's schedule (Day view) instead
      // of the create-job slot popover — easier to drill into a specific date.
      if (calendarView === Views.MONTH) {
        setCurrentDate(startDate);
        setCalendarView(Views.DAY);
        return;
      }
      // D9 — the slot popover only offers scheduling actions; read-only roles don't get it.
      if (boardReadOnly) return;
      setSlotPopover({
        x: lastMousePos.current.x,
        y: lastMousePos.current.y,
        start: wallClockToIso(startDate, tz),
        end: wallClockToIso(endDate, tz),
      });
    },
    [calendarView, boardReadOnly, tz],
  );

  // ─── Event select (click on event) ───────────────────
  // TG12 — all three views open the event editor (openEditorFor); the dead popup is gone.

  // Member-view drop, shared by Member·Day ({kind:'time'} — exact drop slot) and
  // Member·Week ({kind:'day'} — day granularity, no time). The views normalize every
  // payload channel to a BOARD id (dragChannels.resolveBoardDropId), so a bucket
  // walkthrough arrives as `wt-…` and can no longer misroute into AssignJobDialog.
  //   bucket event → D5 unified modal (member-day / member-week pre-fill)
  //   board event  → TG10 direct gestures: cross-lane = swap (slot time IGNORED),
  //                  same-lane = reschedule via the confirm flow (crew unchanged)
  //   plan mode    → bucket JOB cards ghost; everything else keeps its no-op
  const handleMemberBoardDrop = (
    droppedId: string,
    memberId: string,
    drop:
      | { kind: 'time'; start: WallClock; end: WallClock; fromMember: string | null }
      | { kind: 'day'; date: WallClock; fromMember: string | null },
  ) => {
    if (boardReadOnly) return; // D9 defense in depth — read-only roles never see member views
    const parsed = parseBoardDragId(droppedId);
    if (parsed.kind === 'plan-visit') return; // pv- cards only target the standard calendar

    // Day-granularity drops anchor at the org default start time (replaces the 08:00 stopgap).
    const anchoredStart = drop.kind === 'time' ? drop.start : atMinutes(drop.date, defaultStartMin);

    if (planMode.isActive) {
      // Only sidebar JOB cards materialize ghosts here (walkthrough/grid
      // drops keep their pre-existing no-op in plan mode).
      const ev = bucketEvents.find((e) => e.id === droppedId && e.type === 'job');
      if (!ev) return;
      const ghostEnd =
        drop.kind === 'time'
          ? drop.end
          : addMsToWallClock(anchoredStart, (org?.default_job_duration_min ?? 120) * 60_000);
      const location = ev.raw.service_location as { address_line1?: string; city?: string; state?: string } | null;
      planMode.addGhost({
        sourceId: droppedId,
        sourceType: 'job',
        isFromSidebar: true,
        isMovedConfirmed: false,
        start: wallClockToIso(anchoredStart, tz),
        end: wallClockToIso(ghostEnd, tz),
        crew: [memberId],
        title: `${ev.number} — ${ev.customer}`,
        customerName: ev.customer,
        address: location
          ? [location.address_line1, location.city, location.state].filter(Boolean).join(', ')
          : '',
        raw: ev.raw,
      });
      return;
    }

    const bucketEv = bucketEvents.find((e) => e.id === droppedId);
    if (bucketEv) {
      openDropModal(
        bucketEv,
        drop.kind === 'time'
          ? { kind: 'member-day', memberId, start: drop.start }
          : { kind: 'member-week', memberId, date: drop.date },
      );
      return;
    }

    // ── Already-scheduled BOARD card — TG10 direct gestures, no modal ──
    // (Replaces TG6's AssignJobDialog stopgap, which shed multi-crew and misrouted
    // walkthroughs.) The governing rule, encoded in classifyBoardDrop: cross-lane =
    // swap (crew change, time UNCHANGED); same-lane = reschedule (time change, crew
    // unchanged); same-lane same-day week cell / missing from-member = no-op.
    const boardEv = scheduledEvents.find((e) => e.id === droppedId);
    if (!boardEv || !boardEv.start || !boardEv.end) return; // stale drag — card left the board mid-drag
    const boardGate = rescheduleGate(boardEv); // money, not status, freezes a job (Spec B1, B-2)
    if (!boardGate.ok) {
      toast({ title: "Can't reschedule", description: `${boardEv.number} — ${boardGate.reason}` });
      return;
    }
    const oldStart = boardEv.start;
    const oldEnd = boardEv.end;

    const decision = classifyBoardDrop({
      fromMember: drop.fromMember,
      toMember: memberId,
      sameDay: isSameDay(oldStart, drop.kind === 'time' ? drop.start : drop.date),
      hasTime: drop.kind === 'time',
    });
    if (decision === 'noop') return;

    if (decision === 'swap') {
      // D2 — the drop-target member replaces the from-lane member, 1:1. Crew-only
      // REPLACE; the schedule is not touched (the slot's time/date is ignored).
      const res = swapCrew(boardEv.crew, drop.fromMember as string, memberId);
      if (res.kind === 'noop-not-on') return; // defensive — lane member left the crew mid-drag
      if (res.kind === 'noop-already-on') {
        toast({
          title: `${firstNameById.get(memberId) ?? 'That member'} is already on this ${
            boardEv.type === 'walkthrough' ? 'walkthrough' : 'job'
          }`,
        });
        return;
      }
      const fromFirst = firstNameById.get(drop.fromMember as string) ?? 'the previous member';
      const toFirst = firstNameById.get(memberId) ?? 'The new member';
      const onSwapped = () =>
        toast({
          title: `${toFirst} replaces ${fromFirst}`,
          description: `${boardEv.number} — crew updated, schedule unchanged.`,
        });
      if (boardEv.type === 'walkthrough') {
        walkthroughCrewSwapMutation.mutate(
          { leadId: boardEv.raw.id as string, crew: res.crew },
          { onSuccess: onSwapped },
        );
      } else {
        jobCrewSwapMutation.mutate({ jobId: boardEv.id, crew: res.crew }, { onSuccess: onSwapped });
      }
      return;
    }

    // Reschedule within the lane → the existing confirm flow (pendingMove +
    // RescheduleConfirmDialog), crew unchanged. Hour slots carry the new time; week
    // cells carry only the date — keep the event's time-of-day. Duration is kept.
    const durationMs = oldEnd.getTime() - oldStart.getTime();
    const newStart =
      drop.kind === 'time'
        ? drop.start
        : atMinutes(drop.date, oldStart.getHours() * 60 + oldStart.getMinutes());
    if (newStart.getTime() === oldStart.getTime()) return; // dropped back on its own slot — silent no-op
    const newEnd = addMsToWallClock(newStart, durationMs);
    setPendingMove({ eventId: boardEv.id, newStart, newEnd, crew: boardEv.crew });
    setRescheduleConfirm({ event: boardEv, oldStart, oldEnd, newStart, newEnd });
  };

  const isLoading = jobsLoading || walkthroughsLoading;

  // ─── Context value ────────────────────────────────────

  const scheduleCtxValue = useMemo<ScheduleContextValue>(() => ({
    onEventMouseEnter: handleEventMouseEnter,
    onEventMouseLeave: handleEventMouseLeave,
    onEventContextMenu: handleEventContextMenu,
    conflictIds,
  }), [handleEventMouseEnter, handleEventMouseLeave, handleEventContextMenu, conflictIds]);

  // ─── Render ──────────────────────────────────────────

  return (
    <ScheduleCtx.Provider value={scheduleCtxValue}>
      <div className="h-full flex min-h-0 rounded-xl overflow-hidden border border-border shadow-card bg-surface-light">

        {/* ── Collapsed rail: a thin strip with an "open panel" button ── */}
        {!sidebarOpen && (
          <div className="w-10 shrink-0 hidden lg:flex flex-col items-center border-r border-border bg-surface-light pt-2.5">
            {/* Colour matches ghost/subtle exactly, but the button sits at rounded-md
                (6px) and Button's own base always ships rounded-button (14px) with no
                radius-only prop to hold it at 6px - converting would need a call-site
                rounded-md override, which the zero-slack layering-guard hard-appearance
                ratchet forbids (the AddStepButton.tsx rail-trigger precedent). Left raw. */}
            <button
              type="button"
              title="Open panel"
              onClick={() => setSidebarOpen(true)}
              className="h-7 w-7 flex items-center justify-center rounded-md text-text-secondary hover:text-text-primary hover:bg-background-light transition-colors"
            >
              <PanelLeftOpen className="h-4 w-4" />
            </button>
          </div>
        )}

        {/* ── Left Sidebar: search + the Unassigned bucket stack (TG11/Q8) ── */}
        {/* The stack component is the D6 drag-to-UNSCHEDULE drop target (grid-event-id only,
            refused in plan mode); the page keeps the stale + status guards in handleUnscheduleDrop. */}
        <div
          className={`shrink-0 ${sidebarOpen ? 'hidden lg:flex' : 'hidden'} flex-col border-r border-border bg-surface-light overflow-hidden`}
          style={{ width: sidebarWidth }}
        >

          {/* ── Schedule search + collapse button ── */}
          <div className="p-2.5 border-b border-border shrink-0 flex items-center gap-2">
            <ScheduleSearch
              onSelect={handleSearchSelect}
              dateRange={dateRange}
              tz={tz}
              placeholder="Search schedule..."
              className="flex-1 min-w-0"
            />
            {/* Same corner-radius mismatch as the "Open panel" trigger above - left
                raw for the same reason. */}
            <button
              type="button"
              title="Collapse panel"
              onClick={() => setSidebarOpen(false)}
              className="h-7 w-7 shrink-0 flex items-center justify-center rounded-md text-text-secondary hover:text-text-primary hover:bg-background-light transition-colors"
            >
              <PanelLeftClose className="h-4 w-4" />
            </button>
          </div>

          <UnassignedBuckets
            events={visibleBucketEvents}
            members={orgRoster}
            onDragStartCard={handleBucketCardDragStart}
            onDragEndCard={handleBucketCardDragEnd}
            onUnscheduleDrop={handleUnscheduleDrop}
            onCardClick={handleBucketCardClick}
            onCardContextMenu={handleBucketCardContextMenu}
            unscheduleDropDisabled={planMode.isActive || boardReadOnly}
            dragDisabled={boardReadOnly}
            jobsError={unassignedError}
            hiddenTypes={hiddenBucketTypes}
            highlightedCardId={highlightedEventId}
            planCount={planBucket?.length ?? 0}
            planSlot={
              // Live pv- plan-visit cards (Service Plans PR A) — rendering + drags unchanged.
              canSeePlans ? (
                <>
                  {(planBucket?.length ?? 0) === 0 ? (
                    <div className="flex flex-col items-center justify-center py-6 text-center">
                      <CheckCircle2 className="h-5 w-5 text-success mb-1.5" />
                      <p className="text-[11px] text-text-secondary">No plan visits due</p>
                    </div>
                  ) : (
                    (planBucket ?? []).map((plan) => (
                      <PlanVisitCard
                        key={plan.id}
                        plan={plan}
                        dragging={draggingSidebarId === `pv-${plan.id}`}
                        dragDisabled={boardReadOnly}
                        highlighted={highlightedEventId === `pv-${plan.id}`}
                        onDragStart={() => {
                          document.body.classList.add('is-dragging');
                          draggingJobIdRef.current = `pv-${plan.id}`;
                          setDraggingSidebarId(`pv-${plan.id}`);
                        }}
                        onDragEnd={() => {
                          document.body.classList.remove('is-dragging');
                          draggingJobIdRef.current = null;
                          setDraggingSidebarId(null);
                        }}
                        onClick={() => navigate('/service-plans')}
                      />
                    ))
                  )}
                </>
              ) : undefined
            }
          />
        </div>

        {/* ── Sidebar resize handle (#193) — 6px hit-area straddling the sidebar's
            border-r via -3px margins on both sides, so it adds net-ZERO width to
            the flex row and layout at rest is pixel-identical. ── */}
        <div
          onMouseDown={startSidebarResize}
          aria-hidden="true"
          className={`${sidebarOpen ? 'hidden lg:block' : 'hidden'} relative z-10 -ml-[3px] -mr-[3px] w-[6px] shrink-0 cursor-col-resize transition-colors hover:bg-primary-subtle active:bg-ocean-700/20`}
        />

        {/* ── Main Canvas ── */}
        <div className="flex-1 flex flex-col min-w-0 overflow-hidden">

          {/* Header bar — split into two rows to reduce crowding */}
          <div className="flex flex-col gap-2 px-4 py-2.5 border-b border-border bg-surface-light shrink-0">

            {/* ── Row 1 — date nav (left), centered view toggle + plan mode, gear (top-right) ── */}
            <div ref={headerRow1Ref} className="relative flex items-center gap-3 min-h-[28px]">

              <div className="flex items-center gap-1">
                <Button size="sm" variant="outline" className="h-7 px-3 text-xs" onClick={handleNavigateToday}>
                  Today
                </Button>
                <Button size="sm" variant="ghost" className="h-7 w-7 p-0" onClick={handleNavigatePrev}>
                  <ChevronLeft className="h-4 w-4" />
                </Button>
                <Button size="sm" variant="ghost" className="h-7 w-7 p-0" onClick={handleNavigateNext}>
                  <ChevronRight className="h-4 w-4" />
                </Button>
                <span key={dateRangeLabel} className="text-sm font-semibold text-text-primary ml-1 min-w-[170px] schedule-popup-enter">
                  {dateRangeLabel}
                </span>
                {/* The board renders and writes in the ORG's timezone for every viewer, not
                    the browser's — this label is load-bearing, not polish. Without it, a
                    Manila viewer's workday reads as ~9 PM to 5 AM on their own screen (correct
                    for dispatch, disorienting without the label). */}
                <span
                  title={`Schedule times are shown in ${tz}, the organization's configured timezone — not your device's local time.`}
                  className="ml-1.5 shrink-0 rounded-full border border-border bg-background-light px-2 py-0.5 text-[11px] font-medium text-text-secondary"
                >
                  {tz}
                </span>
              </div>

              {/* Centered group — view toggle + Plan Mode, pinned to the middle of the page */}
              <div className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 flex items-center gap-3">

              {/* Standard / Member View toggle — D9: admin & dispatcher only (sales/tech
                  see no toggle and are pinned to Standard via effectiveGroupedView). */}
              {canMemberView && (
                <div ref={viewToggleRef} className="flex items-center gap-0.5 rounded-lg border border-border p-0.5 bg-background-light">
                  {/* Segmented Standard/Member View toggle group, not a Button-shaped
                      control - left raw per the program's non-Button-shape carve-out. */}
                  <button
                    onClick={() => setIsGroupedView(false)}
                    className={`h-6 px-2.5 rounded text-xs flex items-center gap-1.5 transition-colors font-medium
                      ${!isGroupedView ? 'bg-surface-light text-text-primary shadow-sm' : 'text-text-secondary hover:text-text-primary'}`}
                  >
                    <CalIcon className="h-3 w-3" />
                    Standard
                  </button>
                  <button
                    onClick={() => {
                      setIsGroupedView(true);
                      if (calendarView === Views.MONTH) setCalendarView(Views.WEEK);
                    }}
                    className={`h-6 px-2.5 rounded text-xs flex items-center gap-1.5 transition-colors font-medium
                      ${isGroupedView ? 'bg-surface-light text-text-primary shadow-sm' : 'text-text-secondary hover:text-text-primary'}`}
                  >
                    <Users className="h-3 w-3" />
                    Member View
                  </button>
                </div>
              )}

              {/* Plan Mode toggle — Admin & Dispatcher only */}
              {/* Two-state toggle pill (idle vs active-warning fill) with no matching
                  Button cell - left raw per the program's non-Button-shape carve-out. */}
              {canPlanMode && (
                <button
                  ref={planModeRef}
                  onClick={handlePlanModeToggle}
                  className={`h-7 px-3 rounded-lg text-xs font-medium flex items-center gap-1.5 transition-all border
                    ${planMode.isActive
                      ? 'bg-warning-strong text-on-fill border-warning-strong shadow-sm'
                      : 'bg-surface-light text-text-secondary border-border hover:text-text-primary hover:border-warning-border'
                    }`}
                >
                  {planMode.isActive ? (
                    <>
                      <span className="relative flex h-2 w-2">
                        <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-on-fill opacity-75" />
                        <span className="relative inline-flex rounded-full h-2 w-2 bg-on-fill" />
                      </span>
                      Planning
                    </>
                  ) : (
                    <>
                      <PenLine className="h-3 w-3" />
                      Plan Mode
                    </>
                  )}
                </button>
              )}
              </div>

              {/* Settings gear — top-right corner of the header */}
              <div className="ml-auto">
                <SettingsGearDropdown
                  roleFilter={roleFilter}
                  onRoleFilterChange={setRoleFilter}
                  isGroupedView={effectiveGroupedView}
                />
              </div>
            </div>

            {/* ── Row 2 — Day/Week/Month (left), centered department filter, time-of-day window (right) ── */}
            <div className="relative flex items-center gap-3 min-h-[28px]">

              {/* Day / Week / Month switcher — left side. Month hidden in grouped view. */}
              <div className="flex items-center gap-0.5 rounded-lg border border-border p-0.5 bg-background-light">
                {(effectiveGroupedView
                  ? [Views.DAY, Views.WEEK] as string[]
                  : [Views.DAY, Views.WEEK, Views.MONTH] as string[]
                ).map((v) => (
                  // Segmented Day/Week/Month toggle group, not a Button-shaped control -
                  // left raw per the program's non-Button-shape carve-out.
                  <button
                    key={v}
                    onClick={() => setCalendarView(v)}
                    className={`h-6 px-2.5 rounded text-xs capitalize font-medium transition-colors
                      ${calendarView === v ? 'bg-surface-light text-text-primary shadow-sm' : 'text-text-secondary hover:text-text-primary'}`}
                  >
                    {v}
                  </button>
                ))}
              </div>

              {/* Department filter — pinned to the gap between the Standard/Member
                  toggle and Plan Mode above it (deptShift measured in a layout effect). */}
              <div
                className="absolute left-1/2 top-1/2 w-fit"
                style={{ transform: `translate(calc(-50% + ${deptShift}px), -50%)` }}
                title="Filter schedule by department"
              >
                <SelectField
                  aria-label="Filter schedule by department"
                  value={departmentFilter}
                  onValueChange={(v) => {
                    if (v === '__add__') {
                      setAddDeptOpen(true);
                      return; // sentinel: open the modal, leave the active filter untouched
                    }
                    setDepartmentFilter(v);
                  }}
                  className="text-sm px-2 py-1 h-auto rounded-md border border-border bg-surface-light hover:bg-background-light"
                  options={[
                    { value: 'all', label: 'All departments' },
                    ...(departments?.map((d) => ({ value: d.id, label: d.name })) ?? []),
                    ...(canCreateDepartment ? [{ value: '__add__', label: '+ Add department' }] : []),
                  ]}
                />
              </div>

              {/* Time-of-day window — right side (ml-auto). Standard view, Day/Week only (Month has no hourly grid). */}
              {!effectiveGroupedView && calendarView !== Views.MONTH && (
                <div className="ml-auto flex items-center gap-0.5 rounded-lg border border-border p-0.5 bg-background-light">
                  {([
                    { key: 'full', label: 'Full day' },
                    { key: 'morning', label: 'Morning' },
                    { key: 'afternoon', label: 'Afternoon' },
                  ] as const).map((w) => (
                    // Segmented time-of-day-window toggle group, not a Button-shaped
                    // control - left raw per the program's non-Button-shape carve-out.
                    <button
                      key={w.key}
                      onClick={() => setTimeWindow(w.key)}
                      className={`h-6 px-2.5 rounded text-xs font-medium transition-colors
                        ${timeWindow === w.key ? 'bg-surface-light text-text-primary shadow-sm' : 'text-text-secondary hover:text-text-primary'}`}
                    >
                      {w.label}
                    </button>
                  ))}
                </div>
              )}
            </div>

          </div>

          {/* Plan Mode Banner. The amber ramp runs --amber-900 (dark stop) to
              --warning-strong (light stop). --amber-900 was added in phase 4a
              precisely for this: --warning/--amber-700 was the only amber the
              scale carried, so a ramp had nowhere to start and the gradient had
              collapsed to a flat band. */}
          {planMode.isActive && (
            <div className="flex items-center justify-between gap-3 px-4 py-2.5 shrink-0"
                 style={{
                   background: 'linear-gradient(135deg, rgb(var(--amber-900)), rgb(var(--warning-strong)))',
                   borderBottom: '2px solid rgb(var(--warning-strong))',
                 }}>
              <div className="flex items-center gap-2.5 text-on-fill text-sm font-medium">
                <span className="relative flex h-2.5 w-2.5">
                  <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-warning-on-dark opacity-75" />
                  <span className="relative inline-flex rounded-full h-2.5 w-2.5 bg-warning-on-dark" />
                </span>
                Plan Mode
                <span className="text-warning-on-dark font-normal">— {planMode.ghostCount} draft{planMode.ghostCount !== 1 ? 's' : ''}</span>
              </div>
              <div className="flex items-center gap-2">
                <Button
                  size="sm"
                  variant="onDark"
                  className="h-6 px-2.5 text-xs"
                  onClick={() => {
                    planMode.discardAll();
                    queryClient.invalidateQueries({ queryKey: ['schedule-unassigned'] });
                    queryClient.invalidateQueries({ queryKey: ['schedule-unscheduled-walkthroughs'] });
                  }}
                  disabled={planMode.ghostCount === 0}
                >
                  <Trash2 className="h-3 w-3 mr-1" />
                  Discard All
                </Button>
                <Button
                  size="sm"
                  className="h-6 px-2.5 text-xs bg-on-fill text-warning-text hover:bg-on-fill/90"
                  onClick={() => {
                    const visible = planMode.getGhostsForView(toInstant(dateRange.start, tz), toInstant(dateRange.end, tz));
                    if (visible.length === 0) return;
                    setShowConfirmAllDialog(true);
                  }}
                  disabled={planMode.ghostCount === 0}
                >
                  <CheckSquare className="h-3 w-3 mr-1" />
                  Confirm All
                </Button>
              </div>
            </div>
          )}

          {/* Calendar or TechnicianGridView or MemberWeekBoard */}
          {effectiveGroupedView ? (
            <div className={`flex-1 min-h-0 overflow-hidden ${planMode.isActive ? 'plan-mode-active' : ''}`}>
              {calendarView === Views.WEEK ? (
                <MemberWeekBoard
                  weekStart={asWallClock(startOfWeek(currentDate, { weekStartsOn: 0 }))}
                  staff={boardMembers}
                  events={allEvents}
                  conflictIds={conflictIds}
                  isLoading={isLoading}
                  tz={tz}
                  draggingJobIdRef={draggingJobIdRef}
                  onSelectEvent={openEditorFor}
                  onDropJob={(droppedId, memberId, date, fromMember) =>
                    // Day-granularity drop — the unified modal pre-fills the date and
                    // anchors the time at the org default (autoTime stays off).
                    handleMemberBoardDrop(droppedId, memberId, { kind: 'day', date, fromMember })
                  }
                  onGhostContextMenu={planMode.isActive ? handleGhostContextMenu : undefined}
                />
              ) : (
                <TechnicianGridView
                  date={currentDate}
                  members={boardMembers}
                  events={allEvents}
                  conflictIds={conflictIds}
                  isLoading={isLoading}
                  draggingJobIdRef={draggingJobIdRef}
                  onDropJob={(droppedId, memberId, start, end, fromMember) =>
                    handleMemberBoardDrop(droppedId, memberId, { kind: 'time', start, end, fromMember })
                  }
                  // TG12 — onEventClick covers ALL card types (walkthroughs included);
                  // onSelectJob stays as the component's job-only fallback path.
                  onEventClick={openEditorFor}
                  onSelectJob={(jobId) => setEditorEventId(jobId)}
                  onGhostContextMenu={planMode.isActive ? handleGhostContextMenu : undefined}
                />
              )}
            </div>
          ) : (
            <div
              className={`flex-1 relative min-h-0 schedule-cal overflow-hidden ${planMode.isActive ? 'plan-mode-active' : ''} ${hasAllDayEvents ? 'has-allday-events' : ''}`}
              data-focus-day={focusedDayIndex === null ? undefined : focusedDayIndex}
              onDoubleClick={handleCalendarDoubleClick}
            >
              {isLoading && (
                <div className="absolute inset-0 bg-surface-light/70 z-10 flex items-center justify-center">
                  <Loader2 className="h-8 w-8 animate-spin text-primary" />
                </div>
              )}
              {allEvents.length === 0 && !isLoading && (
                <div className="pointer-events-none absolute inset-0 flex items-center justify-center z-10">
                  <EmptyState
                    icon={CalendarX2}
                    title="No jobs scheduled this week"
                    description="Drag a job from the panel on the left to assign it"
                  />
                </div>
              )}
              {/* eslint-disable-next-line @typescript-eslint/no-explicit-any */}
              <DnDCalendar
                localizer={localizer}
                events={windowedEvents as unknown as object[]}
                view={calendarView as 'day' | 'week' | 'month' | 'agenda' | 'work_week'}
                onView={(v) => setCalendarView(v as string)}
                date={currentDate}
                onNavigate={(date: Date) => setCurrentDate(asWallClock(date))}
                onDrillDown={((date: Date) => {
                  // Month view: clicking a day's number jumps straight to that day's schedule
                  setCurrentDate(asWallClock(date));
                  setCalendarView(Views.DAY);
                }) as unknown as (date: object) => void}

                // windowedEvents is ScheduledBoardEvent[] (start/end narrowed to real Dates
                // by the scheduledEvents type predicate) — only the library-interface cast
                // remains. allDay derives from raw.
                startAccessor={((e: ScheduledBoardEvent) => e.start) as unknown as (event: object) => Date}
                endAccessor={((e: ScheduledBoardEvent) => e.end) as unknown as (event: object) => Date}
                allDayAccessor={((e: ScheduledBoardEvent) => isAllDayEvent(e)) as unknown as (event: object) => boolean}
                onSelectEvent={openEditorFor as unknown as (event: object) => void}
                onEventDrop={handleEventDrop as unknown as (args: object) => void}
                onEventResize={handleEventResize as unknown as (args: object) => void}
                onDropFromOutside={handleDropFromOutside as unknown as (args: object) => void}
                dragFromOutsideItem={() => {
                  // P0 fix: return null when not dragging, include start/end for drop preview
                  // Use a 2-hour duration anchored at midnight — the library uses the duration
                  // to size the preview, and the drop slot determines the actual position
                  const id = draggingJobIdRef.current;
                  if (!id) return null as unknown as object;
                  const base = nowWallClock(tz);
                  base.setHours(0, 0, 0, 0);
                  return { id, title: 'Drop to schedule', start: base, end: new Date(base.getTime() + 2 * 60 * 60 * 1000) } as unknown as object;
                }}
                eventPropGetter={eventStyleGetter as unknown as (event: object) => { className?: string; style?: React.CSSProperties }}
                slotPropGetter={slotPropGetter as unknown as (date: object) => { style?: React.CSSProperties }}
                draggableAccessor={(event: object) => {
                  if (boardReadOnly) return false; // D9 — technician board is view-only
                  // Money, not status, freezes a job for rescheduling (Spec B1, B-2).
                  const e = event as BoardEvent;
                  if (!e.isGhost && !rescheduleGate(e).ok) return false;
                  return true;
                }}
                resizable={!boardReadOnly}
                resizableAccessor={(event: object) => {
                  if (boardReadOnly) return false; // D9 — belt & braces with resizable above
                  // Money, not status, freezes a job for rescheduling (Spec B1, B-2).
                  const e = event as BoardEvent;
                  if (isAllDayEvent(e)) return false;
                  if (!e.isGhost && !rescheduleGate(e).ok) return false;
                  return true;
                }}
                selectable
                onSelectSlot={handleSelectSlot as unknown as (slotInfo: object) => void}
                components={calendarComponents as unknown as object}
                scrollToTime={scrollToTime}
                min={calendarMin}
                max={calendarMax}
                dayLayoutAlgorithm="no-overlap"
                style={{ height: '100%' }}
                popup
              />
            </div>
          )}
        </div>

        {/* Hover tooltip + click popup removed — the TG12 event editor opens on click */}

        {/* ── Right-Click Context Menu ── */}
        {contextMenu && (
          <ScheduleContextMenu
            event={contextMenu.event}
            x={contextMenu.x}
            y={contextMenu.y}
            readOnly={boardReadOnly}
            onClose={() => setContextMenu(null)}
            onOpenDetails={(e) => {
              setContextMenu(null);
              if (e.type === 'job') navigate(`/jobs/${e.id}`);
              else navigate(`/leads/${e.raw.id as string}`);
            }}
            onEdit={(e) => {
              setContextMenu(null);
              openEditorFor(e);
            }}
            onCancel={(e) => {
              setContextMenu(null);
              if (e.type === 'job') setCancelDialog({ open: true, jobId: e.id });
            }}
          />
        )}

        {/* ── Sidebar Card Context Menu ── */}
        {sidebarContextMenu && (
          <div
            className="fixed z-50 w-48 bg-surface-light border border-border rounded-xl shadow-hover py-1 overflow-hidden"
            style={{ left: sidebarContextMenu.x, top: sidebarContextMenu.y }}
            onClick={(ev) => ev.stopPropagation()}
          >
            {/* Custom context-menu item row, not a Button-shaped control - left raw
                per the program's non-Button-shape carve-out. */}
            <button
              onClick={() => {
                const path = sidebarContextMenu.type === 'walkthrough' ? 'leads' : 'jobs';
                navigate(`/${path}/${sidebarContextMenu.id}`);
                setSidebarContextMenu(null);
              }}
              className="w-full flex items-center gap-2.5 px-3 py-2 text-xs text-text-primary hover:bg-background-light transition-colors"
            >
              <ExternalLink className="h-3.5 w-3.5 text-text-secondary" />
              {sidebarContextMenu.type === 'walkthrough' ? 'View Lead' : 'View Job'}
            </button>
          </div>
        )}

        {/* ── Slot-Click Quick-Schedule Popover ── */}
        {slotPopover && (
          <QuickScheduleCard
            x={slotPopover.x}
            y={slotPopover.y}
            startTime={slotPopover.start}
            endTime={slotPopover.end}
            tz={tz}
            unassignedJobs={unassignedJobs ?? []}
            unscheduledWalkthroughs={unscheduledWalkthroughs ?? []}
            showWalkthroughs={leadsEnabled}
            onSelectJob={(jobId) => {
              setSlotPopover(null);
              setAssignDialog({
                open: true,
                jobId,
                defaultStart: slotPopover.start,
                defaultEnd: slotPopover.end,
              });
            }}
            onSelectWalkthrough={(leadId) => {
              setSlotPopover(null);
              walkthroughRescheduleMutation.mutate({
                leadId,
                newStart: slotPopover.start,
                crew: bucketEvents.find((e) => e.id === `wt-${leadId}`)?.crew ?? [],
                durationMinutes: org?.default_walkthrough_duration_min ?? 60,
              });
            }}
            onClose={() => setSlotPopover(null)}
            onTimeChange={(start, end) => setSlotPopover((prev) => (prev ? { ...prev, start, end } : prev))}
          />
        )}

        {allDaySlotPopover && (
          <QuickScheduleCard
            x={allDaySlotPopover.x}
            y={allDaySlotPopover.y}
            startTime={allDaySlotPopover.date}
            endTime={allDayEndIso(allDaySlotPopover.date, tz)}
            tz={tz}
            unassignedJobs={unassignedJobs ?? []}
            unscheduledWalkthroughs={unscheduledWalkthroughs ?? []}
            showWalkthroughs={leadsEnabled}
            onSelectJob={(jobId) => {
              setAllDaySlotPopover(null);
              setAssignDialog({
                open: true,
                jobId,
                defaultStart: allDaySlotPopover.date,
                defaultEnd: allDayEndIso(allDaySlotPopover.date, tz),
                defaultIsAllDay: true,
              });
            }}
            onSelectWalkthrough={(leadId) => {
              setAllDaySlotPopover(null);
              walkthroughRescheduleMutation.mutate({
                leadId,
                newStart: allDaySlotPopover.date,
                crew: bucketEvents.find((e) => e.id === `wt-${leadId}`)?.crew ?? [],
                durationMinutes: 1440,
              });
            }}
            onClose={() => setAllDaySlotPopover(null)}
          />
        )}

        {/* ── Ghost Context Menu ── */}
        {ghostContextMenu && (() => {
          const ghost = planMode.getGhostById(ghostContextMenu.ghostId);
          if (!ghost) return null;
          const mx = safeX(ghostContextMenu.x, 180);
          const my = safeY(ghostContextMenu.y, 100);
          return (
            <div
              className="fixed z-50 w-44 bg-surface-light border border-border rounded-xl shadow-hover py-1 overflow-hidden"
              style={{ left: mx, top: my }}
              onClick={(ev) => ev.stopPropagation()}
            >
              {/* Custom context-menu item rows (Confirm/Remove), not Button-shaped
                  controls - left raw per the program's non-Button-shape carve-out. */}
              <button
                onClick={() => {
                  setGhostContextMenu(null);
                  setShowConfirmDialog({ ghostId: ghost.id, ghost });
                }}
                className="w-full flex items-center gap-2.5 px-3 py-2 text-xs text-text-primary hover:bg-background-light transition-colors"
              >
                <CheckSquare className="h-3.5 w-3.5 text-success" />
                Confirm
              </button>
              <div className="my-0.5 border-t border-border" />
              <button
                onClick={() => {
                  setGhostContextMenu(null);
                  planMode.removeGhost(ghost.id);
                  if (ghost.isFromSidebar) {
                    queryClient.invalidateQueries({ queryKey: ['schedule-unassigned'] });
                    queryClient.invalidateQueries({ queryKey: ['schedule-unscheduled-walkthroughs'] });
                  }
                }}
                className="w-full flex items-center gap-2.5 px-3 py-2 text-xs text-danger-text hover:bg-danger-surface transition-colors"
              >
                <Trash2 className="h-3.5 w-3.5" />
                Remove
              </button>
              {/* TODO: Reassign option (skip for MVP) */}
            </div>
          );
        })()}

        {/* ── Ghost Confirm Dialog ── */}
        {showConfirmDialog && (() => {
          const { ghostId, ghost } = showConfirmDialog;
          const isConfirming = confirmingGhostIds.has(ghostId);
          // Crew-axis fallback — "Unassigned" retired from the schedule UI; an empty
          // crew here is the §3.8 "needs crew" condition, not the unscheduled state.
          const techName = crewNamesFromRoster(ghost.crew) || 'No crew';
          const customer = ghost.raw.customer as { first_name: string; last_name: string; email?: string } | null;
          const ghostStart = toWallClock(new Date(ghost.start), tz);

          return (
            <ConfirmDialog
              open
              onOpenChange={(o) => { if (!o) setShowConfirmDialog(null); }}
              icon={CheckSquare}
              title={`Schedule ${ghost.sourceType === 'job' ? 'Job' : 'Walkthrough'}?`}
              description={`${format(ghostStart, 'EEEE, MMMM d')} at ${format(ghostStart, 'h:mm a')}`}
              confirmLabel="Confirm & Schedule"
              isLoading={isConfirming}
              onConfirm={async () => {
                await handleConfirmGhost(ghostId);
                setShowConfirmDialog(null);
              }}
            >
              <div className="bg-background-light rounded-lg p-3 mb-4 space-y-1.5">
                <p className="text-xs text-text-secondary">
                  <span className="font-medium text-text-primary">Assign to:</span> {techName}
                </p>
                {customer && (
                  <p className="text-xs text-text-secondary">
                    <span className="font-medium text-text-primary">Customer:</span>{' '}
                    {customer.first_name} {customer.last_name}
                  </p>
                )}
                {ghost.address && (
                  <p className="text-xs text-text-secondary">
                    <span className="font-medium text-text-primary">Location:</span> {ghost.address}
                  </p>
                )}
              </div>
            </ConfirmDialog>
          );
        })()}

        {/* ── Confirm All Dialog ── */}
        {showConfirmAllDialog && (() => {
          const visible = planMode.getGhostsForView(toInstant(dateRange.start, tz), toInstant(dateRange.end, tz));
          return (
            <ConfirmDialog
              open
              onOpenChange={(o) => { if (!o) setShowConfirmAllDialog(false); }}
              icon={CheckSquare}
              title={`Confirm ${visible.length} Change${visible.length !== 1 ? 's' : ''}?`}
              description="This will schedule all draft events visible in the current view."
              confirmLabel={`Confirm ${visible.length} Change${visible.length !== 1 ? 's' : ''}`}
              isLoading={confirmingGhostIds.size > 0}
              onConfirm={handleConfirmAllGhosts}
            >
              <div className="bg-background-light rounded-lg p-3 mb-4 max-h-40 overflow-y-auto space-y-1">
                {visible.map((g) => (
                  <p key={g.id} className="text-xs text-text-secondary">
                    {g.title} — {crewNamesFromRoster(g.crew) || 'No crew'}
                  </p>
                ))}
              </div>
            </ConfirmDialog>
          );
        })()}

        {/* ── Plan Mode Exit Dialog ── */}
        {/* Modal (not ConfirmDialog) — three footer actions (Cancel / Discard & Exit /
            Confirm All & Exit), which ConfirmDialog's fixed Cancel+Confirm footer can't hold. */}
        <Modal
          open={showExitDialog}
          onClose={() => setShowExitDialog(false)}
          title={`You have ${planMode.ghostCount} unconfirmed change${planMode.ghostCount !== 1 ? 's' : ''}`}
          subtitle="Would you like to confirm or discard your draft changes before exiting plan mode?"
          footer={
            <>
              <Button variant="outline" onClick={() => setShowExitDialog(false)}>
                Cancel
              </Button>
              <Button
                variant="outline" tone="danger"
                onClick={() => {
                  planMode.forceDeactivate();
                  queryClient.invalidateQueries({ queryKey: ['schedule-unassigned'] });
                  queryClient.invalidateQueries({ queryKey: ['schedule-unscheduled-walkthroughs'] });
                  setShowExitDialog(false);
                }}
              >
                Discard & Exit
              </Button>
              <Button
                onClick={async () => {
                  await handleConfirmAllGhosts();
                  planMode.forceDeactivate();
                  setShowExitDialog(false);
                }}
                disabled={confirmingGhostIds.size > 0}
              >
                {confirmingGhostIds.size > 0
                  ? <><Loader2 className="mr-2 h-4 w-4 animate-spin" />Scheduling...</>
                  : 'Confirm All & Exit'}
              </Button>
            </>
          }
        >
          {null}
        </Modal>

        {/* Navigation warning handled via beforeunload (browser-level) */}

        {/* ── Conflict Modal ── */}
        {/* RESIDUAL — left as a plain overlay (not ConfirmDialog) by the overlay-consolidation
            pass. `conflictToast` is one of the states EventEditor's own `open` prop is gated
            against (`!conflictToast && !unscheduleConfirm`, see the comment at EventEditor
            below) specifically so a Radix dialog is never left stacked under this overlay. It
            can be set from INSIDE an already-open EventEditor (handleEditorSaveTime's mutation
            onError, on a live 409), so converting this to a Radix-based ConfirmDialog would make
            EventEditor's Dialog run its ~200ms exit animation (Presence keeps it mounted for the
            `animate-out`/`fade-out` classes in ui/dialog.tsx) at the same moment this dialog's
            Radix Dialog opens — a real overlap window, not just a stacked-forever case. That
            overlap is exactly the "stacking...fights its focus lock" failure this file's own
            gating was written to avoid (see the D5 `needsCrewConfirm` precedent below). No test
            coverage exists for this file to catch a live focus-lock regression, so this block —
            together with the Empty-crew warning and D6 unschedule confirm below, which share the
            identical EventEditor/UnifiedDropModal swap-on-the-same-tick risk — is intentionally
            left on its original hand-rolled markup rather than risk breaking scheduling. */}
        {conflictToast && (
          <div className="fixed inset-0 z-50 bg-scrim/30 backdrop-blur-sm flex items-center justify-center p-4">
            <div
              className="w-full max-w-md bg-surface-light rounded-xl border border-border p-6 shadow-2xl"
            >
              <div className="flex items-start gap-3 mb-4">
                <div className="shrink-0 w-9 h-9 rounded-full bg-warning-surface flex items-center justify-center">
                  <AlertTriangle className="h-5 w-5 text-warning-text" />
                </div>
                <div>
                  <p className="text-sm font-semibold text-text-primary">Scheduling Conflict</p>
                  <p className="mt-1 text-sm text-text-secondary leading-relaxed">{conflictToast.message}</p>
                </div>
              </div>
              {conflictToast.conflicts && conflictToast.conflicts.length > 0 && (
                <div className="mb-4 space-y-2">
                  {conflictToast.conflicts.map((c, i) => (
                    <div key={i} className="flex items-center gap-2 text-sm bg-warning-surface rounded-lg px-3 py-2 border border-warning-border">
                      {/* Walkthrough and job used to be cyan vs blue; both raw families map to
                          the one `info` semantic family, so the WT/JOB label now carries the
                          distinction on its own. */}
                      <span className="text-xs font-bold px-1.5 py-0.5 rounded bg-info-surface text-info-text">
                        {c.type === 'walkthrough' ? 'WT' : 'JOB'}
                      </span>
                      <span className="font-medium text-text-primary">{c.number}</span>
                      <span className="text-text-secondary">
                        {new Date(c.start).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZone: tz })}
                        {' – '}
                        {new Date(c.end).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZone: tz })}
                      </span>
                    </div>
                  ))}
                </div>
              )}
              <div className="flex justify-end gap-3">
                <Button variant="outline" onClick={() => setConflictToast(null)}>
                  Cancel
                </Button>
                <Button
                  onClick={() => {
                    const p = conflictToast.pendingPayload;
                    if (p.kind === 'walkthrough') {
                      walkthroughRescheduleMutation.mutate({
                        leadId: p.leadId,
                        newStart: p.newStart,
                        crew: p.crew,
                        durationMinutes: p.durationMinutes,
                        force: true,
                      });
                    } else {
                      assignMutation.mutate({ jobId: p.jobId, crew: p.crew, start: p.start, end: p.end, force: true });
                    }
                  }}
                  disabled={assignMutation.isPending || walkthroughRescheduleMutation.isPending}
                >
                  {(assignMutation.isPending || walkthroughRescheduleMutation.isPending)
                    ? <><Loader2 className="mr-2 h-4 w-4 animate-spin" />Scheduling…</>
                    : 'Schedule Anyway'}
                </Button>
              </div>
            </div>
          </div>
        )}

        {/* ── Error Toast ── */}
        {errorToast && (
          <div className="fixed bottom-6 right-6 z-50 max-w-sm rounded-xl border border-danger-border bg-danger-surface p-4 shadow-lg schedule-toast-enter">
            <div className="flex items-start gap-2">
              <AlertCircle className="h-4 w-4 text-danger-text mt-0.5 shrink-0" />
              <div className="flex-1">
                <p className="text-sm font-semibold text-danger-text">Error</p>
                <p className="mt-0.5 text-sm text-danger-text">{errorToast}</p>
              </div>
            </div>
            <div className="mt-3">
              <Button size="sm" variant="outline" onClick={() => setErrorToast(null)}>
                Dismiss
              </Button>
            </div>
          </div>
        )}

        {/* ── Reschedule Confirm Dialog ── */}
        {rescheduleConfirm && (() => {
          const rc = rescheduleConfirm;
          // A drag-reschedule changes TIME only — the crew rides along unchanged
          // (crew ⟂ schedule), so the dialog lists the whole crew once.
          const crewNames = crewPeopleOf(rc.event.type, rc.event.raw)
            .map(fullName)
            .filter((n): n is string => Boolean(n));
          return (
            <RescheduleConfirmDialog
              open={true}
              eventType={rc.event.type === 'walkthrough' ? 'walkthrough' : 'job'}
              eventNumber={rc.event.number}
              oldStart={rc.oldStart}
              oldEnd={rc.oldEnd}
              newStart={rc.newStart}
              newEnd={rc.newEnd}
              crewNames={crewNames}
              emailRecipients={[
                ...(rc.event.customer ? [`${rc.event.customer} (customer)`] : []),
                ...crewNames.map((n) => `${n} (technician)`),
              ]}
              onConfirm={() => {
                // Rule: a reschedule POSTs the event's CURRENT crew with the new times —
                // never an empty array unless the crew really is empty (crew ⟂ schedule).
                if (rc.event.type === 'job') {
                  assignMutation.mutate({
                    jobId: rc.event.id,
                    crew: rc.event.crew,
                    start: wallClockToIso(rc.newStart, tz),
                    end: wallClockToIso(rc.newEnd, tz),
                  });
                } else {
                  walkthroughRescheduleMutation.mutate({
                    leadId: rc.event.raw.id as string,
                    newStart: wallClockToIso(rc.newStart, tz),
                    crew: rc.event.crew,
                    durationMinutes: Math.round(
                      (rc.newEnd.getTime() - rc.newStart.getTime()) / 60_000,
                    ),
                  });
                }
                setRescheduleConfirm(null);
                setPendingMove(null);
              }}
              onCancel={() => {
                setRescheduleConfirm(null);
                setPendingMove(null);
              }}
              isLoading={assignMutation.isPending || walkthroughRescheduleMutation.isPending}
            />
          );
        })()}

        {/* ── Assign Dialog ── */}
        <AssignJobDialog
          open={assignDialog.open}
          onOpenChange={(o) => setAssignDialog((prev) => ({ ...prev, open: o }))}
          jobId={assignDialog.jobId}
          mode="schedule"
          defaultStart={assignDialog.defaultStart}
          defaultEnd={assignDialog.defaultEnd}
          defaultIsAllDay={assignDialog.defaultIsAllDay}
        />

        {/* ── Cancel Dialog ── */}
        <CancelJobDialog
          open={cancelDialog.open}
          onOpenChange={(o) => setCancelDialog((prev) => ({ ...prev, open: o }))}
          jobId={cancelDialog.jobId}
        />

        {/* ── Add-Department Dialog (from the "+ Add department" dropdown option) ── */}
        <Dialog
          open={addDeptOpen}
          onOpenChange={(o) => {
            if (!o) {
              setAddDeptOpen(false);
              setNewDeptName('');
            }
          }}
        >
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Create a new department</DialogTitle>
              <DialogDescription>
                The schedule will switch to filtering by the new department.
              </DialogDescription>
            </DialogHeader>
            <Input
              autoFocus
              placeholder="Department name"
              value={newDeptName}
              onChange={(e) => setNewDeptName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void submitCreateDepartment();
              }}
            />
            <DialogFooter>
              <Button
                variant="ghost"
                onClick={() => {
                  setAddDeptOpen(false);
                  setNewDeptName('');
                }}
              >
                Cancel
              </Button>
              <Button
                onClick={() => void submitCreateDepartment()}
                disabled={!newDeptName.trim() || createDept.isPending}
              >
                Create
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>

        {/* ── TG12 Event Editor — every live card click (board + bucket) ── */}
        {/* Hidden (id kept) while a plain overlay is up — the conflict modal or the
            unschedule confirm — stacking one over a Radix dialog fights its focus lock
            (the UnifiedDropModal/needsCrewConfirm precedent). It reopens after. */}
        <EventEditor
          open={Boolean(editorEvent) && !conflictToast && !unscheduleConfirm}
          event={editorEvent}
          members={orgRoster}
          readOnly={boardReadOnly}
          canUnschedule={editorUnscheduleGate?.ok ?? false}
          unscheduleDisabledReason={
            editorUnscheduleGate && !editorUnscheduleGate.ok ? editorUnscheduleGate.reason : undefined
          }
          canComplete={editorCanComplete}
          onSaveCrew={handleEditorSaveCrew}
          onSaveTime={handleEditorSaveTime}
          onUnschedule={() => {
            if (editorEvent) setUnscheduleConfirm(editorEvent); // page owns confirm + POST
          }}
          onComplete={() => {
            if (editorEvent) {
              // Page owns the POST — one-click close-out, no completion-note modal.
              completeMutation.mutate({ jobId: editorEvent.id, number: editorEvent.number });
              setEditorEventId(null);
            }
          }}
          onClose={() => setEditorEventId(null)}
        />

        {/* ── D5 Unified Drop Modal (every bucket → board drop) ── */}
        {/* Closed (draft state kept) while the needs-crew warning is up — "Back" reopens it. */}
        <UnifiedDropModal
          open={Boolean(dropModal) && !needsCrewConfirm}
          event={dropModal?.event ?? null}
          draft={dropModal?.draft ?? null}
          conflictNote={dropConflictNote}
          members={orgRoster}
          onChange={(patch) =>
            setDropModal((cur) => (cur ? { ...cur, draft: { ...cur.draft, ...patch } } : cur))
          }
          onConfirm={handleDropModalConfirm}
          onCancel={() => {
            setDropModal(null);
            setNeedsCrewConfirm(false);
          }}
        />

        {/* ── Empty-crew warning (D5 confirm gate — §3.8 state 4 is valid but deliberate) ── */}
        {/* RESIDUAL — kept as a plain overlay by the overlay-consolidation pass, for the same
            reason as the Conflict Modal above. This is in fact the ORIGINAL precedent the
            EventEditor comment references: UnifiedDropModal's `open` is gated `!needsCrewConfirm`
            expressly so its Radix dialog never sits open under this warning, and "Back" flips
            `needsCrewConfirm` false and reopens UnifiedDropModal on the very next render — a
            same-tick Radix-dialog swap in both directions. Converting this overlay to
            ConfirmDialog would put a second Radix Dialog's mount/open in the same tick as
            UnifiedDropModal's exit animation, risking the exact focus-lock fight this gating
            exists to avoid. Left on its original markup; see the Conflict Modal comment above
            for the full rationale (shared by this block and D6 unschedule confirm below). */}
        {needsCrewConfirm && dropModal && (
          <div className="fixed inset-0 z-[70] bg-scrim/30 backdrop-blur-sm flex items-center justify-center p-4">
            <div
              role="alertdialog"
              aria-modal="true"
              aria-label="Schedule with no crew?"
              className="w-full max-w-md bg-surface-light rounded-xl border border-border p-6 shadow-2xl"
            >
              <div className="flex items-start gap-3 mb-5">
                <div className="shrink-0 w-9 h-9 rounded-full bg-danger/10 flex items-center justify-center">
                  <AlertTriangle className="h-5 w-5 text-danger" />
                </div>
                <div>
                  <p className="text-sm font-semibold text-text-primary">Nobody is assigned</p>
                  <p className="mt-1 text-sm text-text-secondary">
                    <strong>{dropModal.event.number}</strong> will be scheduled with no crew — it saves
                    as <strong>"needs crew"</strong> (red flag, Standard view only). Confirm?
                  </p>
                </div>
              </div>
              <div className="flex justify-end gap-2">
                <Button variant="outline" onClick={() => setNeedsCrewConfirm(false)}>
                  Back
                </Button>
                <Button
                  variant="solid" tone="danger"
                  onClick={() => submitDropDraft(dropModal.event, dropModal.draft)}
                >
                  Schedule anyway
                </Button>
              </div>
            </div>
          </div>
        )}

        {/* ── D6 unschedule confirm (TG10 — board card dragged to the bucket) ── */}
        {/* Distinct from Cancel: no reason, no customer email; the crew is KEPT (state 3). */}
        {/* RESIDUAL — kept as a plain overlay by the overlay-consolidation pass; same rationale
            as the Conflict Modal comment above. `unscheduleConfirm` is set directly from
            EventEditor's `onUnschedule` (an action taken INSIDE the still-open editor) and gates
            EventEditor's own `open` prop (`!unscheduleConfirm`) — Cancel here flips it back to
            null and reopens EventEditor on the next render, a same-tick Radix-dialog swap in both
            directions. Converting to ConfirmDialog risks the same focus-lock fight. Left on its
            original markup. */}
        {unscheduleConfirm && (
          <div className="fixed inset-0 z-[70] bg-scrim/30 backdrop-blur-sm flex items-center justify-center p-4">
            <div
              className="w-full max-w-md bg-surface-light rounded-xl border border-border p-6 shadow-2xl"
            >
              <div className="flex items-start gap-3 mb-5">
                <div className="shrink-0 w-9 h-9 rounded-full bg-primary-subtle flex items-center justify-center">
                  <CalendarX2 className="h-5 w-5 text-primary" />
                </div>
                <div>
                  <p className="text-sm font-semibold text-text-primary">Move to Unscheduled?</p>
                  <p className="mt-1 text-sm text-text-secondary">
                    <strong>{unscheduleConfirm.number}</strong> goes back to its bucket. The crew is{' '}
                    <strong>kept</strong>; the customer is not notified. This is not a cancellation.
                  </p>
                </div>
              </div>
              <div className="flex justify-end gap-2">
                <Button variant="outline" onClick={() => setUnscheduleConfirm(null)}>
                  Cancel
                </Button>
                <Button
                  onClick={() => {
                    if (boardReadOnly) return; // D9 defense in depth — confirm can't write for read-only roles
                    unscheduleMutation.mutate(unscheduleConfirm);
                    setUnscheduleConfirm(null);
                    setEditorEventId(null); // editor-initiated unschedule is done — don't reopen
                  }}
                >
                  Unschedule
                </Button>
              </div>
            </div>
          </div>
        )}
      </div>
    </ScheduleCtx.Provider>
  );
}
