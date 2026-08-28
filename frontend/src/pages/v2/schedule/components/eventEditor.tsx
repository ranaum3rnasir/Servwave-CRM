import { useId, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { format } from 'date-fns';
import { CalendarX2, CheckCircle2, ExternalLink, Phone, MessageSquare } from 'lucide-react';

import { MultiAssigneeSelect } from '@/components/crm/MultiAssigneeSelect';
import {
  EVENT_TYPE_META,
  STATE_META,
  deriveState,
  type SchedulableEvent,
} from '@/components/schedule/scheduleModel';
import { crewPeopleOf, ownerOf, fullName } from '@/components/schedule/eventPeople';
import type { AssignableUser } from '@/lib/api/users';
import { asWallClock, type WallClock } from '@/lib/schedule-tz';
import {
  durationMinutesOf,
  scheduleTimeFrom,
  startDateOf,
  type ScheduleTimeValue,
} from '@/components/schedule/scheduleTimeValue';

import { Button } from '@/ui-kit/components/ui/button';
import {
  Dialog, DialogBody, DialogContent, DialogDescription, DialogHeader, DialogTitle,
} from '@/ui-kit/components/ui/dialog';
import { EmptyState } from '@/ui-kit/components/data/emptyState';
import { Label } from '@/ui-kit/components/ui/label';
import { Separator } from '@/ui-kit/components/ui/separator';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/ui-kit/components/ui/select';
import { cn } from '@/ui-kit/lib/utils';

import { ScheduleTimeFields } from '../../_shared/scheduleTimeFields';
import { preferV2Path } from '../../uiV2';
import { EM, EN } from '../glyphs';

/** REPLACE semantics - order-insensitive equality ([] is a valid crew). */
const sameCrew = (a: string[], b: string[]): boolean =>
  a.length === b.length && a.every((id) => b.includes(id));

/**
 * Detail-page URL for an event: walkthroughs live on the lead, jobs on /jobs/:id.
 *
 * `preferV2Path` is applied to the PATH only and the query string is appended
 * after, because the v2 matcher compares path segments and a `?tab=` suffix
 * would make the last segment unmatchable and silently drop the user out of v2.
 */
export function detailUrlOf(event: SchedulableEvent): string {
  return event.type === 'walkthrough'
    ? `${preferV2Path(`/leads/${event.raw.id as string}`)}?tab=walkthrough`
    : preferV2Path(`/jobs/${event.parentId}`);
}

/**
 * Inline call / text affordances; renders nothing when there is no phone.
 *
 * The legacy pair are raw `tel:` and `sms:` anchors. The design-system raw-tag
 * ratchet for anchors sits at its floor, so a new file may not add one - these
 * are kit Buttons that set `window.location.href`, the same substitution the
 * Leads module made for its contact cell. Same destinations, same accessible
 * names. They still match `INTERACTIVE_SELECTOR` below (it lists `button`), so
 * the whole-popup click guard keeps treating them as controls rather than as
 * dead space that navigates.
 */
function ContactLinks({ phone, label }: { phone?: string | null; label: string }) {
  if (!phone?.trim()) return null;
  return (
    <span className="inline-flex shrink-0 items-center gap-1.5">
      <Button
        variant="ghost"
        size="icon-sm"
        aria-label={`Call ${label}`}
        className="size-6 text-subtle-foreground"
        onClick={(e) => { e.stopPropagation(); window.location.href = `tel:${phone}`; }}
      >
        <Phone className="h-3.5 w-3.5" />
      </Button>
      <Button
        variant="ghost"
        size="icon-sm"
        aria-label={`Text ${label}`}
        className="size-6 text-subtle-foreground"
        onClick={(e) => { e.stopPropagation(); window.location.href = `sms:${phone}`; }}
      >
        <MessageSquare className="h-3.5 w-3.5" />
      </Button>
    </span>
  );
}

/** SAVED crew (event.crew, not the draft) resolved to name + roster phone. */
function crewContactRowsOf(event: SchedulableEvent, members: AssignableUser[]) {
  const payloadById = new Map(
    crewPeopleOf(event.type, event.raw).map((p) => [p.id, fullName(p)] as const),
  );
  return event.crew.map((id) => {
    const m = members.find((u) => u.id === id);
    return {
      id,
      name: m ? `${m.first_name} ${m.last_name}` : (payloadById.get(id) ?? 'Unknown'),
      phone: m?.phone ?? null,
    };
  });
}

// Whole-popup click guard: clicks on any control keep their editing behaviour;
// only genuinely non-interactive areas navigate. Radix SelectContent portals to
// <body>, so dropdown clicks never bubble into the DialogContent handler.
const INTERACTIVE_SELECTOR =
  'button, a, input, select, textarea, label, [role="combobox"], [role="listbox"]';

export interface EventEditorProps {
  open: boolean;
  event: SchedulableEvent | null;
  /** Org-wide assignable roster - names must resolve beyond the dept-scoped columns. */
  members: AssignableUser[];
  /** Role-gating consumes this: crew as text, no save buttons, no unschedule. */
  readOnly?: boolean;
  /** Page-computed status gate (same logic as the drag-to-unschedule pre-gate). */
  canUnschedule: boolean;
  /** Why, when canUnschedule=false (timed events only). */
  unscheduleDisabledReason?: string;
  /** Job in an active status + caller may manage it - enables "Mark Complete". */
  canComplete?: boolean;
  onSaveCrew: (crew: string[]) => void;
  onSaveTime: (start: WallClock, durationMin: number) => void;
  /** The page owns the confirm dialog + the unschedule POST. */
  onUnschedule: () => void;
  /** The page owns the completion dialog + the /complete POST. */
  onComplete?: () => void;
  onClose: () => void;
}

/**
 * The event editor: the ONLY per-person crew path. Drags are whole-lane swaps
 * and the D5 modal is initial scheduling; this is where one person is added or
 * removed. Opens from every board and bucket card click.
 *
 * PURE controlled dialog. It stages crew and time drafts locally and EMITS
 * onSaveCrew / onSaveTime / onUnschedule / onComplete / onClose - it never
 * POSTs. The PAGE owns the mutations, the confirms and the toasts. The commission
 * owner is OFF-BOARD: a read-only field here, never an editable lane. None of
 * that changed.
 */
export function EventEditor({
  open,
  event,
  members,
  readOnly = false,
  canUnschedule,
  unscheduleDisabledReason,
  canComplete = false,
  onSaveCrew,
  onSaveTime,
  onUnschedule,
  onComplete,
  onClose,
}: EventEditorProps) {
  const navigate = useNavigate();
  if (!event) return null;
  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) onClose(); }}>
      {/* The whole popup is clickable: any click OUTSIDE a control opens the
          detail page. The guard keeps crew chips, selects, inputs, labels, the
          call/text buttons and the dialog X behaving as controls. */}
      <DialogContent
        className="cursor-pointer"
        onClick={(e) => {
          if ((e.target as HTMLElement).closest(INTERACTIVE_SELECTOR)) return;
          onClose();
          navigate(detailUrlOf(event));
        }}
      >
        {/* Keyed body: drafts reset whenever the dialog reopens (Radix unmounts
            closed content) or a different event opens - no sync effects needed. */}
        <EditorBody
          key={event.boardId}
          event={event}
          members={members}
          readOnly={readOnly}
          canUnschedule={canUnschedule}
          unscheduleDisabledReason={unscheduleDisabledReason}
          canComplete={canComplete}
          onSaveCrew={onSaveCrew}
          onSaveTime={onSaveTime}
          onUnschedule={onUnschedule}
          onComplete={onComplete}
          onClose={onClose}
        />
      </DialogContent>
    </Dialog>
  );
}

function EditorBody({
  event,
  members,
  readOnly,
  canUnschedule,
  unscheduleDisabledReason,
  canComplete,
  onSaveCrew,
  onSaveTime,
  onUnschedule,
  onComplete,
  onClose,
}: Omit<EventEditorProps, 'open' | 'event' | 'readOnly'> & {
  event: SchedulableEvent;
  readOnly: boolean;
}) {
  const uid = useId();
  const navigate = useNavigate();

  const meta = EVENT_TYPE_META[event.type];
  const state = deriveState(event);
  const stateMeta = STATE_META[state];
  const ownerName = fullName(ownerOf(event.type, event.raw));

  // Crew draft. REPLACE semantics; [] is allowed, crew and schedule are
  // independent axes.
  const [draftCrew, setDraftCrew] = useState<string[]>(() => [...event.crew]);
  const crewDirty = !sameCrew(draftCrew, event.crew);

  // Time draft (timed events only). One value for the whole start/end pair - the same
  // shape every other scheduling surface edits (ScheduleTimeFields). `onSaveTime` still
  // speaks start + duration, so the page's mutation is untouched: the duration is
  // DERIVED here from the two ends rather than picked from a control.
  const originalDuration =
    event.start && event.end
      ? Math.round((event.end.getTime() - event.start.getTime()) / 60_000)
      : null;
  const originalTime = event.start ? scheduleTimeFrom(event.start, originalDuration ?? 0) : null;
  const [draftTime, setDraftTime] = useState<ScheduleTimeValue | null>(() => originalTime);
  const draftStart = draftTime ? startDateOf(draftTime) : null;
  const draftDuration = draftTime ? durationMinutesOf(draftTime) : null;
  const timeDirty =
    originalTime !== null &&
    draftTime !== null &&
    draftStart !== null &&
    draftDuration !== null &&
    (draftTime.date !== originalTime.date ||
      draftTime.startTime !== originalTime.startTime ||
      draftTime.endDate !== originalTime.endDate ||
      draftTime.endTime !== originalTime.endTime);

  const detailUrl = detailUrlOf(event);
  const customerPhone = (event.raw.customer as { phone?: string | null } | undefined)?.phone;
  const crewRows = crewContactRowsOf(event, members);

  return (
    <>
      {/* Open-full-page trigger, beside the kit dialog's built-in close X
          (which sits at right-3 top-3). */}
      <Button
        variant="ghost"
        size="icon-sm"
        aria-label="Open full page"
        className="absolute right-12 top-3 z-10 text-subtle-foreground"
        onClick={() => {
          onClose();
          navigate(detailUrl);
        }}
      >
        <ExternalLink />
      </Button>
      <DialogHeader>
        {/* The kit's DialogHeader is a flex ROW, so everything textual is one child. */}
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            {/* The type chip carries the same accent the calendar paints and the
                legend advertises for this event type - shared, not restyled. */}
            <span
              className={cn(
                'rounded-full border-l-[3px] px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide',
                meta.accent,
                meta.soft,
                meta.text,
              )}
            >
              {meta.label}
            </span>
            <span className="text-[11px] font-semibold text-subtle-foreground">{event.number}</span>
          </div>
          <DialogTitle>{event.title}</DialogTitle>
          <DialogDescription className="flex items-center gap-2">
            {event.customer}
            <ContactLinks phone={customerPhone} label={event.customer} />
          </DialogDescription>
        </div>
      </DialogHeader>

      <DialogBody className="space-y-4 pb-5">
        {/* State chip - where the event lives and why */}
        <div className="flex items-center gap-2 rounded-lg bg-muted px-2.5 py-1.5 text-[11px]">
          <span className="font-bold">{stateMeta.label}</span>
          <span className="text-muted-foreground">{stateMeta.hint}</span>
        </div>

        {/* Owner is OFF-BOARD - a field, never a lane (hidden when there is none) */}
        {ownerName && (
          <div className="flex items-center justify-between rounded-lg border px-2.5 py-1.5">
            <span className="text-[10px] font-bold uppercase tracking-wide text-subtle-foreground">
              Owner (off-board)
            </span>
            <span className="text-xs font-semibold text-muted-foreground">{ownerName}</span>
          </div>
        )}

        {/* Crew - THE per-person edit path. Explicit save; drags never do this. */}
        <div className="flex flex-col gap-1.5">
          <Label>Crew (performers)</Label>
          {readOnly ? (
            crewRows.length === 0 ? (
              <EmptyState title="No crew" />
            ) : (
              <div className="space-y-1">
                {crewRows.map((r) => (
                  <p key={r.id} className="flex items-center gap-2 text-[13px] text-muted-foreground">
                    {r.name}
                    <ContactLinks phone={r.phone} label={r.name} />
                  </p>
                ))}
              </div>
            )
          ) : (
            <>
              <MultiAssigneeSelect
                value={draftCrew}
                onChange={setDraftCrew}
                placeholder="Add member..."
              />
              {crewDirty && (
                <div className="mt-1 flex justify-end">
                  <Button size="sm" onClick={() => onSaveCrew(draftCrew)}>
                    Save crew
                  </Button>
                </div>
              )}
              {/* Contact rows for the SAVED crew members that have a phone. */}
              {crewRows.some((r) => r.phone) && (
                <div className="mt-1 space-y-1">
                  {crewRows.filter((r) => r.phone).map((r) => (
                    <p key={r.id} className="flex items-center gap-2 text-xs text-muted-foreground">
                      {r.name}
                      <ContactLinks phone={r.phone} label={r.name} />
                    </p>
                  ))}
                </div>
              )}
            </>
          )}
        </div>

        {/* Schedule - time edits for timed events; unscheduled events state it plainly */}
        {event.start && draftTime ? (
          <div className="flex flex-col gap-1.5">
            <Label>Schedule</Label>
            {readOnly ? (
              <p className="text-[13px] text-muted-foreground">
                {format(event.start, 'EEE, MMM d · h:mm a')}
                {event.end ? ` ${EN} ${format(event.end, 'h:mm a')}` : ''}
              </p>
            ) : (
              <>
                <ScheduleTimeFields
                  idPrefix={uid}
                  value={draftTime}
                  onChange={setDraftTime}
                />
                {timeDirty && draftStart && draftDuration !== null && (
                  <div className="mt-2 flex justify-end">
                    <Button size="sm" onClick={() => onSaveTime(asWallClock(draftStart), draftDuration)}>
                      Save time
                    </Button>
                  </div>
                )}
              </>
            )}
          </div>
        ) : (
          <p className="text-[13px] italic text-muted-foreground">Unscheduled {EM} {stateMeta.hint}</p>
        )}

        {/* Mark Complete - close out an active job directly from the board (jobs only). */}
        {event.type === 'job' && canComplete && !readOnly && onComplete && (
          <>
            <Separator />
            <Button size="sm" className="w-full" onClick={onComplete}>
              <CheckCircle2 /> Mark Complete
            </Button>
          </>
        )}

        <Separator />

        {/* Footer: unschedule (timed only - clears TIME, keeps crew) + detail nav */}
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            {event.start && !readOnly && (
              <>
                <Button
                  size="sm"
                  variant="ghost"
                  className="text-destructive"
                  disabled={!canUnschedule}
                  onClick={onUnschedule}
                >
                  <CalendarX2 /> Move to Unscheduled
                </Button>
                {!canUnschedule && unscheduleDisabledReason && (
                  <p className="mt-1 text-[11px] text-subtle-foreground">{unscheduleDisabledReason}</p>
                )}
              </>
            )}
          </div>
          <Button
            size="sm"
            variant="link"
            className="shrink-0"
            onClick={() => {
              onClose();
              navigate(detailUrl);
            }}
          >
            View details →
          </Button>
        </div>
      </DialogBody>
    </>
  );
}
