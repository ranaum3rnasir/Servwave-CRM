/**
 * Multi-visit S2: book a new visit on a job, or move an existing one.
 *
 * Deliberately NOT AssignJobDialog. That one POSTs /assign, which fires the customer
 * scheduled/rescheduled email, applies milestoneClears and syncs PlanVisit - none of which belongs
 * on a visit write in S2.
 *
 * The four-field ScheduleTimeValue is the state of record and is seeded WHOLE from the visit's ISO
 * start and end. Never derive the fields back out of a narrower combined string: that is the exact
 * bug #1535 was spent undoing, where every half-filled edit collapsed to '' and the state never
 * accumulated. Conversion happens only at the API seam, through the ORG zone.
 */
import { useMemo, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';

import api from '@/lib/axios';
import { extractApiError } from '@/lib/utils';
import { dayAndTimeToIso, isoToOrgDay, isoToOrgTime, toWallClock, useScheduleTimezone } from '@/lib/schedule-tz';
import { jobVisitsQueryKey } from '@/lib/useJobVisits';
import {
  allDayRange, EMPTY_SCHEDULE_TIME, isInvertedRange, lastDayOf, type ScheduleTimeValue,
} from '@/components/schedule/scheduleTimeValue';
import type { JobVisitRow } from '@/lib/visits';
import { MultiAssigneeSelect } from '@/components/crm/MultiAssigneeSelect';
import { EMPTY_NOTIFY, notifyBlocked, notifyVisitBodyShown, seedNotify, type NotifyCompose } from '@/lib/notifyCompose';

import { Button } from '@/ui-kit/components/ui/button';
import { Checkbox } from '@/ui-kit/components/ui/checkbox';
import { Label } from '@/ui-kit/components/ui/label';
import {
  Dialog, DialogBody, DialogContent, DialogFooter, DialogHeader, DialogTitle,
} from '@/ui-kit/components/ui/dialog';
import { toast } from '@/ui-kit/components/ui/sonner';

// The v2 chrome. A v2 page may not import the v1 twin (components/schedule/ScheduleTimeFields);
// the two share their brain (scheduleTimeValue) and not their body.
import { ScheduleTimeFields } from '@/pages/v2/_shared/scheduleTimeFields';
import { NotifyComposeFields } from '@/pages/v2/_shared/notifyComposeFields';

export interface VisitScheduleDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  jobId: string;
  /** Present when moving an existing trip; absent when booking a new one. */
  visit?: JobVisitRow | null;
  /**
   * S3: naming crew is an `assign Job` fact, and BOTH visit routes now enforce it per instance on
   * top of the subject-level `reschedule Job` route gate. False hides the picker ONLY - never the
   * dialog and never Save, or plain drag-to-reschedule breaks for exactly the reschedule-only
   * grantees that route gate was written to keep working. Frontend gates on the same ability the
   * API enforces, per CLAUDE.md's Roles rule.
   */
  canAssignCrew?: boolean;
  /** D23: the dialog has to STATE who will be emailed, so it needs the identity to name. */
  customerName?: string | null;
  customerEmail?: string | null;
}

/** Seed the WHOLE four-field value in one go, from the row's own instants. */
function seedFrom(visit: JobVisitRow | null | undefined, tz: string): ScheduleTimeValue {
  if (!visit?.scheduled_at) return EMPTY_SCHEDULE_TIME;
  return {
    date: isoToOrgDay(visit.scheduled_at, tz),
    startTime: isoToOrgTime(visit.scheduled_at, tz),
    endDate: isoToOrgDay(visit.scheduled_end ?? visit.scheduled_at, tz),
    endTime: isoToOrgTime(visit.scheduled_end ?? visit.scheduled_at, tz),
  };
}

export function VisitScheduleDialog({
  open, onOpenChange, jobId, visit, canAssignCrew = true, customerName, customerEmail,
}: VisitScheduleDialogProps) {
  const tz = useScheduleTimezone();
  const queryClient = useQueryClient();
  // Seeded ONCE, at mount. The caller remounts this component whenever it opens (see the `key`
  // on both call sites), so Reschedule always opens holding the slot it is about to move rather
  // than whatever was last edited - without a setState-inside-an-effect re-seed.
  const [value, setValue] = useState<ScheduleTimeValue>(() => seedFrom(visit, tz));
  // Same seed-once-at-mount rule as the window above, for the same reason: the caller remounts
  // this component whenever it opens, so Reschedule opens holding the crew already on that trip
  // rather than an empty picker the dispatcher has to refill.
  const [crew, setCrew] = useState<string[]>(() => (visit?.assignees ?? []).map((a) => a.user_id));
  // Same seed-once-at-mount rule again: Reschedule on an all-day visit opens with the box already
  // ticked and `value`'s exclusive end already round-trips through ScheduleTimeFields' `allDay`
  // mode (lastDayOf), so no separate inclusive-date state is needed here.
  const [isAllDay, setIsAllDay] = useState<boolean>(() => visit?.is_all_day ?? false);
  // Seeded ONCE at mount, from the same remount the window and the crew rely on - pure, never in
  // an effect. The wall clock is built through the ORG zone, so the sentence the admin reads
  // names the same hour the row above it shows (#1551's second defect was a browser-zone seed).
  const [notify, setNotify] = useState<NotifyCompose>(() => ({ ...EMPTY_NOTIFY, to: customerEmail ?? '' }));
  // ...and re-derived from the fields as they are edited, until the dispatcher writes their own.
  // A mount-only seed names the trip's OLD slot, while the server appends the NEW date and time
  // under the same message - one email naming two different appointments. The board host has
  // never had this problem: it seeds with the start the drag produced, which is already the new
  // one. Derived rather than stored, so there is no effect that could clobber typed text.
  const composedMessage = useMemo(() => {
    // RESCHEDULE only. The wording is "We've moved your appointment to ...", which is a lie about
    // a trip being booked for the first time - that path leaves the box empty and lets the
    // server's own first-booking wording stand, exactly as it did before this was derived.
    if (!visit) return '';
    if (!value.date || !value.startTime) return '';
    const iso = dayAndTimeToIso(value.date, value.startTime, tz);
    if (!iso) return '';
    return seedNotify({ type: 'job' }, toWallClock(new Date(iso), tz)).message;
  }, [visit, value.date, value.startTime, tz]);
  const [messageEdited, setMessageEdited] = useState(false);
  // What the composer shows AND what the request sends - one value, so they cannot disagree.
  const effectiveNotify: NotifyCompose =
    messageEdited || !composedMessage ? notify : { ...notify, message: composedMessage };

  function changeNotify(next: NotifyCompose) {
    // Typing in the Message box is what pins it; editing To, CC or the tick is not.
    if (next.message !== effectiveNotify.message) setMessageEdited(true);
    setNotify(next);
  }

  // Complete AND ordered. Every other consumer of these four fields blocks on isInvertedRange
  // too (AssignJobDialog, the lead page, the walkthrough tab) - the field group shows its own
  // inline warning, but only the button can stop the write. A zero-length or negative window is
  // not cosmetic: the backend mirrors it onto the job, and detectCrewConflicts' overlap test
  // (`start < end AND end > start`) can no longer match that job, so double-booking checks on it
  // quietly stop finding anything.
  const complete =
    Boolean(value.date && value.startTime && value.endDate && value.endTime) && !isInvertedRange(value);

  const save = useMutation({
    mutationFn: async () => {
      const body = {
        scheduled_start: dayAndTimeToIso(value.date, value.startTime, tz),
        scheduled_end: dayAndTimeToIso(value.endDate, value.endTime, tz),
        // Sent explicitly on every save, unlike crew or the notify tick below - the checkbox is
        // always rendered and its state is always a decision made in front of the user, so there
        // is no "untouched" case for rescheduleJobVisitSchema's omitted-means-unchanged reading to
        // apply to. Omitting it here would read as "unchanged" on a PATCH but as "false" on the
        // POST default, two different meanings for the one gesture of never touching the box.
        is_all_day: isAllDay,
        // Only when the picker is actually present. A principal who may reschedule but not assign
        // sends NO key at all, so the backend's "omitted means unchanged" contract does the right
        // thing rather than this dialog racing it with an empty array.
        ...(canAssignCrew ? { assignee_ids: crew } : {}),
        // The NESTED shape the visit routes take, never the flat one /assign takes. Q1
        // (RATIFIED): this dialog's composer is ALWAYS rendered (below, unconditionally) while
        // it is open, so an unticked box is a decision made in front of the user, not silence -
        // `notifyVisitBodyShown` sends `notify_customer: false` for it rather than `{}`.
        ...notifyVisitBodyShown(effectiveNotify),
      };
      if (visit) {
        await api.patch(`/api/jobs/${jobId}/visits/${visit.id}`, body);
      } else {
        await api.post(`/api/jobs/${jobId}/visits`, body);
      }
    },
    onSuccess: () => {
      // Both: the list AND the mirrored hero, which the backend rewrote in the same transaction.
      queryClient.invalidateQueries({ queryKey: jobVisitsQueryKey(jobId) });
      queryClient.invalidateQueries({ queryKey: ['job', jobId] });
      // A per-visit crew write changes the DERIVED UNION on the job, so two more surfaces go
      // stale: ['jobs'] backs the list's crew column and its CSV export, and ['schedule-jobs']
      // backs the board's crew avatars. Same four-key set AssignJobCrewPopover already uses -
      // not a new one invented here.
      queryClient.invalidateQueries({ queryKey: ['jobs'] });
      queryClient.invalidateQueries({ queryKey: ['schedule-jobs'] });
      onOpenChange(false);
    },
    onError: (err) => toast.error(extractApiError(err, 'Failed to save visit')),
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{visit ? `Reschedule Visit ${visit.visit_seq}` : 'Add Visit'}</DialogTitle>
        </DialogHeader>
        <DialogBody>
          {/* Not paired with Label/htmlFor: aria-label matches NotifyComposeFields' own checkbox
              row directly below, the v2 pattern for a label-beside-control row. */}
          <label className="flex cursor-pointer items-center gap-2 py-1">
            <Checkbox
              checked={isAllDay}
              onCheckedChange={(next) => {
                const checked = next === true;
                setIsAllDay(checked);
                if (checked && value.date) setValue(allDayRange(value.date, lastDayOf(value)));
              }}
              aria-label="All Day"
            />
            <span className="text-text-primary text-sm">All Day</span>
          </label>
          <ScheduleTimeFields value={value} onChange={setValue} idPrefix="job-visit" allDay={isAllDay} />
          {canAssignCrew && (
            <div className="mt-4 space-y-2">
              <Label htmlFor="job-visit-crew">Crew</Label>
              <MultiAssigneeSelect id="job-visit-crew" value={crew} onChange={setCrew} enabled={open} />
            </div>
          )}
          <NotifyComposeFields
            notify={effectiveNotify}
            onChange={changeNotify}
            customerName={customerName}
            customerEmail={customerEmail}
            idPrefix="job-visit-notify"
          />
        </DialogBody>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button
            isLoading={save.isPending}
            onClick={() => save.mutate()}
            disabled={!complete || notifyBlocked(effectiveNotify) || save.isPending}
          >
            {/* The save awaits the customer notify email server-side, which can run seconds -
                the label has to change too, not just grey out, or a slow send reads as stuck. */}
            {save.isPending ? (visit ? 'Saving...' : 'Booking...') : (visit ? 'Save visit' : 'Book visit')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export default VisitScheduleDialog;
