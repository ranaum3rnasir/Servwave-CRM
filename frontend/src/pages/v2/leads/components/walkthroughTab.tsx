import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, Ban, Calendar, CalendarClock, CheckCircle2, ChevronDown } from 'lucide-react';

import api from '@/lib/axios';
import { extractApiError } from '@/lib/utils';
import { AttachmentSection } from '@/components/crm/AttachmentSection';
import { MultiAssigneeSelect } from '@/components/crm/MultiAssigneeSelect';
import { Badge } from '@/ui-kit/components/ui/badge';
import { Button } from '@/ui-kit/components/ui/button';
import { Label } from '@/ui-kit/components/ui/label';
import { Textarea } from '@/ui-kit/components/ui/textarea';
import {
  EMPTY_SCHEDULE_TIME,
  durationMinutesOf,
  isInvertedRange,
  withDurationMinutes,
  type ScheduleTimeValue,
} from '@/components/schedule/scheduleTimeValue';
import {
  dayAndTimeToIso, isoToOrgDay, isoToOrgTime, useScheduleTimezone,
} from '@/lib/schedule-tz';

import { ScheduleTimeFields } from '../../_shared/scheduleTimeFields';
import { formatDateTime, isWalkthroughActive, type UserSummary, type VisitHistoryRow } from './leadShared';
import { otherVisits } from '@/lib/visits';
import type { ScheduleConflictItem as ScheduleConflict } from '@/pages/v2/_shared/scheduleConflict';

/** What a walkthrough lasts when nothing says otherwise - a seed and a post-time fallback. */
const DEFAULT_WALKTHROUGH_MINUTES = 60;

// `ScheduleConflict` (the local alias kept below, so every existing use site in this file is
// unchanged) used to be its own copy of this shape - COPY-PASTED in five places across this file
// and SchedulePage.tsx, which is exactly how BE-routes's additive `crew` / `customer_name` fields
// would land in four of the five and be forgotten in the fifth (Q6, RATIFIED). It is now the one
// shared `ScheduleConflictItem` from `pages/v2/_shared/scheduleConflict.ts` - `_shared/`, not
// `schedule/`, because this file lives in the `leads/` module and the v2 module-isolation guard
// (pages/v2/__tests__/moduleIsolation.test.ts) forbids one module importing another's folder.
// This file's own render of the conflict list does not use the two new fields - that is out of
// this contract's scope - but importing the shared type keeps this copy from drifting out of
// sync again.

/** The stored start + duration, back as the four fields the scheduling form edits. */
function seedWtTime(scheduledAt: string | null, durationMinutes: number | null, tz: string): ScheduleTimeValue {
  const date = isoToOrgDay(scheduledAt, tz);
  const startTime = isoToOrgTime(scheduledAt, tz);
  if (!date || !startTime) return EMPTY_SCHEDULE_TIME;
  return withDurationMinutes(
    { date, startTime, endDate: date, endTime: '' },
    durationMinutes ?? DEFAULT_WALKTHROUGH_MINUTES,
  );
}

/**
 * The resync signature: the page passes this as the component's `key`, so the
 * editable local state below is re-seeded exactly when the legacy effect would
 * have re-run - when the lead's scheduled-at, duration, performers or notes
 * change.
 */
export function walkthroughSyncKey(lead: Record<string, unknown>): string {
  const performers = (lead.walkthrough_performers as { user: { id: string } }[] | undefined) ?? [];
  return [
    lead.walkthrough_scheduled_at ?? '',
    lead.walkthrough_duration_minutes ?? '',
    performers.map((p) => p.user.id).join(','),
    lead.walkthrough_notes ?? '',
  ].join('|');
}

/**
 * v2 walkthrough tab.
 *
 * Endpoints, payloads, invalidations, the four mutually exclusive states and
 * their precedence are the legacy tab's. `AttachmentSection` and
 * `MultiAssigneeSelect` are reused rather than rebuilt - both own non-trivial
 * behaviour (multipart upload with progress; department-grouped roster) that
 * belongs to shared infrastructure, not to this module.
 */
export function WalkthroughTabContent({
  lead, leadId, canPerformWalkthrough, canScheduleWalkthrough,
}: {
  lead: Record<string, unknown>;
  leadId: string;
  /** `perform_walkthrough Lead` - notes + completing. A strict TECHNICIAN holds this but NOT `update Lead`. */
  canPerformWalkthrough: boolean;
  /** `schedule_walkthrough Lead` - the scheduling form. */
  canScheduleWalkthrough: boolean;
}) {
  const queryClient = useQueryClient();
  // The legacy tab kept these in sync with the lead through an effect. Here they
  // are seeded once per mount, and the page re-keys this component whenever the
  // underlying lead fields change - same resync points, no state written from an
  // effect.
  // Scheduling values mean the ORG's clock, never the viewer's browser - the same rule the
  // job form and the scheduler board already follow.
  const timezone = useScheduleTimezone();
  // The four picker fields ARE the state of record, held exactly as ScheduleTimeFields
  // edits them. Storing a combined 'YYYY-MM-DDTHH:mm' string instead loses every partial
  // edit - a date picked before its time collapses the whole value to '', so the fields
  // never accumulate and Schedule Walkthrough stays disabled.
  const [wtTime, setWtTime] = useState<ScheduleTimeValue>(
    () => seedWtTime(
      lead.walkthrough_scheduled_at as string | null,
      lead.walkthrough_duration_minutes as number | null,
      timezone,
    ),
  );
  const [wtPerformers, setWtPerformers] = useState<string[]>(
    () => ((lead.walkthrough_performers as { user: { id: string } }[] | undefined) ?? []).map((p) => p.user.id),
  );
  const [wtNotes, setWtNotes] = useState(() => (lead.walkthrough_notes as string) || '');
  const [historyOpen, setHistoryOpen] = useState(false);
  // A reschedule is the SAME visit at a new time, not a second booking: POST /walkthrough/schedule
  // reuses the lead's live visit row (walkthrough.service.ts, scheduleActiveWalkthrough). So this
  // flag only decides whether the booking form is on screen - the request it sends is the request
  // this tab already sends.
  const [isRescheduling, setIsRescheduling] = useState(false);
  // Held apart from the mutation's own error so the override can re-post the identical payload
  // with `force`, and so editing the fields can drop a verdict that no longer describes them.
  const [conflicts, setConflicts] = useState<ScheduleConflict[] | null>(null);

  // The page re-keys this component when the LEAD's values change, but the org-timezone
  // query can land after mount - and the same wall clock read against a different zone is
  // a different instant, so the fields must be re-seeded when it does. Adjusted during
  // render rather than in an effect: React's documented way to reset state on a changed
  // input, and what `react-hooks/set-state-in-effect` (enforced on changed lines in CI)
  // requires.
  const [lastTz, setLastTz] = useState(timezone);
  if (timezone !== lastTz) {
    setLastTz(timezone);
    setWtTime(seedWtTime(
      lead.walkthrough_scheduled_at as string | null,
      lead.walkthrough_duration_minutes as number | null,
      timezone,
    ));
  }

  // A walkthrough STORES a start + a duration, so both are derived from the fields at the
  // API seam rather than kept alongside them.
  const wtScheduledIso = dayAndTimeToIso(wtTime.date, wtTime.startTime, timezone);

  // A walkthrough STORES a start + a duration, so the end is that start plus that duration.
  // Derived here instead of shown as a raw minute count: the summary then answers the same
  // question the form asks, and a visit running past midnight names the day it really ends on.
  const scheduledAtIso = lead.walkthrough_scheduled_at as string | null;
  const durationMinutes = (lead.walkthrough_duration_minutes as number | null) ?? DEFAULT_WALKTHROUGH_MINUTES;
  const endsAtIso = scheduledAtIso
    ? new Date(new Date(scheduledAtIso).getTime() + durationMinutes * 60_000).toISOString()
    : null;

  // A conflict verdict describes the fields that produced it. Editing either half retires it,
  // rather than leaving the previous slot's clash sitting under a slot nobody has tested yet.
  const editTime = (next: ScheduleTimeValue) => { setWtTime(next); setConflicts(null); };
  const editPerformers = (next: string[]) => { setWtPerformers(next); setConflicts(null); };

  const isCompleted = Boolean(lead.walkthrough_completed_at);
  const isCancelled = Boolean(lead.walkthrough_cancelled_at);
  const isScheduled = isWalkthroughActive(
    lead.walkthrough_scheduled_at,
    lead.walkthrough_completed_at,
    lead.walkthrough_cancelled_at,
  );
  const completedAt = lead.walkthrough_completed_at as string | null;
  const cancelledAt = lead.walkthrough_cancelled_at as string | null;
  const cancelledReason = lead.walkthrough_cancelled_reason as string | null;
  const performers = (lead.walkthrough_performers as { user: UserSummary }[] | undefined) ?? [];
  const performerLabel = performers.length > 0
    ? performers.map((p) => `${p.user.first_name} ${p.user.last_name}`).join(', ')
    : null;

  // The tab shows the CURRENT visit with a visit count + history behind it.
  // History excludes whichever row the state-specific content already describes.
  const visitCount = (lead.walkthrough_count as number | undefined) ?? 0;
  const visitHistory = (lead.walkthrough_history as VisitHistoryRow[] | undefined) ?? [];
  // Multi-visit S1: excluded by row IDENTITY via the shared module, not by status class - see
  // lib/visits.ts. It stays in that module rather than being inlined here: the v1 lead page that
  // used to hold the second copy is deleted, but #1551 is what a second copy cost, and the job
  // trees still read the same module.
  const pastVisits = otherVisits(visitHistory);

  const visitHistorySection = visitCount > 1 && (
    <div>
      <Button variant="ghost" size="sm" className="-ms-2" onClick={() => setHistoryOpen((open) => !open)}>
        <ChevronDown className={historyOpen ? '' : '-rotate-90'} />
        {visitCount} Visits Total
      </Button>
      {historyOpen && (
        <div className="mt-2 flex flex-col gap-2">
          {pastVisits.length === 0 ? (
            <p className="text-muted-foreground text-xs">No earlier visits.</p>
          ) : (
            pastVisits.map((w) => (
              <div key={w.id} className="flex items-start gap-2.5 rounded-lg border p-2.5 text-sm">
                <span
                  className={[
                    'mt-1 inline-block size-1.5 shrink-0 rounded-full',
                    w.status === 'COMPLETED' ? 'bg-status-green'
                      : w.status === 'CANCELLED' ? 'bg-status-red' : 'bg-muted',
                  ].join(' ')}
                />
                <div className="min-w-0">
                  {/* D13/D19 - the job surface has always numbered its trips here and the
                      lead surface did not, so a cancelled lead visit was visible but
                      unnamed and could not be matched to the customer's own email. */}
                  {w.visit_seq != null && (
                    <p className="text-muted-foreground text-xs font-medium">Visit {w.visit_seq}</p>
                  )}
                  <p className="font-medium">
                    {w.status === 'COMPLETED' && w.completed_at
                      ? `Completed ${formatDateTime(w.completed_at, timezone)}`
                      : w.status === 'CANCELLED' && w.cancelled_at
                        ? `Cancelled ${formatDateTime(w.cancelled_at, timezone)}`
                        : w.scheduled_at
                          ? `Scheduled ${formatDateTime(w.scheduled_at, timezone)}`
                          : 'Requested'}
                  </p>
                  {w.status === 'CANCELLED' && w.cancelled_reason && (
                    <p className="text-muted-foreground mt-0.5 text-xs">{w.cancelled_reason}</p>
                  )}
                </div>
              </div>
            ))
          )}
        </div>
      )}
    </div>
  );

  // `force` re-posts the identical payload past a 409. The backend, not this component, decides
  // what clashes; booking and rescheduling send the same body, because the endpoint reuses the
  // live visit row either way.
  const scheduleMutation = useMutation({
    mutationFn: async (force: boolean) => {
      await api.post(`/api/leads/${leadId}/walkthrough/schedule`, {
        walkthrough_scheduled_at: wtScheduledIso,
        performer_ids: wtPerformers,
        walkthrough_duration_minutes: durationMinutesOf(wtTime) ?? DEFAULT_WALKTHROUGH_MINUTES,
        ...(force ? { force: true } : {}),
      });
    },
    onSuccess: () => {
      setConflicts(null);
      // The page re-keys this component off the lead's own values, so a moved visit remounts
      // back into its read-only summary. Closed here too for the reschedule that lands on the
      // time already stored, which changes no key.
      setIsRescheduling(false);
      queryClient.invalidateQueries({ queryKey: ['lead', leadId] });
    },
    onError: (err) => {
      const res = (err as { response?: { status?: number; data?: { conflicts?: ScheduleConflict[] } } }).response;
      // An empty list still means "the API refused this slot", so a 409 is captured by STATUS
      // rather than by the list being non-empty - otherwise the override never appears.
      setConflicts(res?.status === 409 ? (res.data?.conflicts ?? []) : null);
    },
  });

  const completeMutation = useMutation({
    mutationFn: async () => { await api.post(`/api/leads/${leadId}/walkthrough/complete`); },
    onSuccess: () => { queryClient.invalidateQueries({ queryKey: ['lead', leadId] }); },
  });

  const saveNotesMutation = useMutation({
    mutationFn: async () => {
      await api.post(`/api/leads/${leadId}/walkthrough`, { walkthrough_notes: wtNotes || null });
    },
    onSuccess: () => { queryClient.invalidateQueries({ queryKey: ['lead', leadId] }); },
  });

  const notesBlock = (showError: boolean) => (
    <div>
      <p className="text-muted-foreground mb-3 text-xs font-semibold uppercase">Notes</p>
      <Textarea
        value={wtNotes}
        onChange={(e) => setWtNotes(e.target.value)}
        rows={4}
        placeholder="Walkthrough notes..."
        disabled={!canPerformWalkthrough}
      />
      {canPerformWalkthrough && wtNotes !== ((lead.walkthrough_notes as string) || '') && (
        <Button
          size="sm"
          className="mt-2"
          onClick={() => saveNotesMutation.mutate()}
          disabled={saveNotesMutation.isPending}
        >
          {saveNotesMutation.isPending ? 'Saving...' : 'Save Notes'}
        </Button>
      )}
      {showError && saveNotesMutation.error && (
        <p className="text-destructive mt-1 text-sm">Failed to save notes</p>
      )}
    </div>
  );

  const attachmentsBlock = (
    <div>
      <p className="text-muted-foreground mb-3 text-xs font-semibold uppercase">Attachments</p>
      <AttachmentSection entityType="LEAD" entityId={leadId} context="WALKTHROUGH" />
    </div>
  );

  // The booked visit, read-only. Start and end are both stamped with their DATE: a walkthrough
  // that crosses midnight ends on a different day, and a bare end time would not say so.
  const scheduleSummary = (
    <div className="grid grid-cols-1 gap-4 text-sm sm:grid-cols-3">
      <p>
        <span className="text-muted-foreground">Starts: </span>
        <span className="font-medium">{scheduledAtIso ? formatDateTime(scheduledAtIso, timezone) : '-'}</span>
      </p>
      <p>
        <span className="text-muted-foreground">Ends: </span>
        <span className="font-medium">{endsAtIso ? formatDateTime(endsAtIso, timezone) : '-'}</span>
      </p>
      <p>
        <span className="text-muted-foreground">Performer: </span>
        <span className="font-medium">{performerLabel ?? '-'}</span>
      </p>
    </div>
  );

  // ONE form for booking and for rescheduling. Two copies would be two things to keep in step,
  // and the fields are the same fields because the endpoint behind them is the same endpoint.
  const scheduleFieldsBlock = (
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
      {/* A walkthrough STORES a duration, not an end - so the end here is derived on the way in
          and converted back to minutes on the way out. The person booking it sees exactly the
          fields the scheduler board and the job form show. */}
      <div className="sm:col-span-2">
        <ScheduleTimeFields
          idPrefix="v2-wt"
          value={wtTime}
          onChange={editTime}
          disabled={!canScheduleWalkthrough}
        />
      </div>
      <div className="flex flex-col gap-1.5">
        <Label>Performers</Label>
        <MultiAssigneeSelect
          value={wtPerformers}
          onChange={editPerformers}
          placeholder="Add performer..."
          disabled={!canScheduleWalkthrough}
        />
      </div>
    </div>
  );

  // Nothing to post: no start, nobody to send, or an end the fields already show as before the
  // start. Never a reason a person cannot read off the form itself.
  const scheduleBlocked = !wtScheduledIso || wtPerformers.length === 0 || isInvertedRange(wtTime);

  // Backing out re-seeds from the STORED booking rather than just hiding the form: the fields are
  // this component's state, so abandoned edits would otherwise still be sitting in them the next
  // time Reschedule is opened.
  const cancelReschedule = () => {
    setIsRescheduling(false);
    setConflicts(null);
    setWtTime(seedWtTime(scheduledAtIso, durationMinutes, timezone));
    setWtPerformers(performers.map((p) => p.user.id));
  };

  // A clash is the backend's verdict, so it is reported rather than pre-empted - with the way
  // through it, since a reschedule collides far more often than a first booking does.
  const conflictBlock = conflicts !== null && (
    <div className="bg-status-amber-subtle flex flex-col gap-3 rounded-lg border p-4">
      <div className="flex items-start gap-3">
        <AlertTriangle className="text-status-amber size-5 shrink-0" />
        <div>
          <p className="text-sm font-semibold">Scheduling conflict</p>
          <p className="text-muted-foreground mt-0.5 text-xs">
            {conflicts.length > 0
              ? 'A performer is already booked over this slot.'
              : 'The API refused this slot.'}
          </p>
        </div>
      </div>
      {conflicts.length > 0 && (
        <div className="flex flex-col gap-2">
          {conflicts.map((c) => (
            <div key={`${c.type}-${c.id}-${String(c.start)}`} className="flex items-center gap-2 rounded-lg border bg-kit-card px-3 py-2 text-[13px]">
              {/* Both kinds share one accent, so the WT/JOB label carries the distinction. */}
              <Badge variant="softBlue" size="sm">{c.type === 'walkthrough' ? 'WT' : 'JOB'}</Badge>
              <span className="font-semibold">{c.number}</span>
              <span className="text-muted-foreground">
                {formatDateTime(String(c.start), timezone)} - {formatDateTime(String(c.end), timezone)}
              </span>
            </div>
          ))}
        </div>
      )}
      <div>
        <Button
          size="sm"
          variant="outline"
          onClick={() => scheduleMutation.mutate(true)}
          disabled={scheduleBlocked || scheduleMutation.isPending}
        >
          {scheduleMutation.isPending ? 'Scheduling...' : 'Schedule anyway'}
        </Button>
      </div>
    </div>
  );

  // The generic error is for everything a conflict is NOT - a 409 is already spelled out above,
  // and printing both would say the same refusal twice.
  const scheduleErrorBlock = conflicts === null && scheduleMutation.error && (
    <p className="text-destructive mt-2 text-sm">
      {extractApiError(scheduleMutation.error, 'Failed to schedule walkthrough')}
    </p>
  );

  if (isCompleted) {
    return (
      <div className="flex flex-col gap-6 p-6">
        <div className="bg-status-green-subtle flex items-center gap-3 rounded-lg border p-4">
          <CheckCircle2 className="text-status-green-emphasis size-5 shrink-0" />
          <div>
            <p className="text-status-green-emphasis text-sm font-semibold">
              Completed on {formatDateTime(completedAt!, timezone)}
            </p>
            {performerLabel && (
              <p className="text-status-green-emphasis mt-0.5 text-xs">by {performerLabel}</p>
            )}
          </div>
        </div>

        <div>
          <p className="text-muted-foreground mb-3 text-xs font-semibold uppercase">Schedule Info</p>
          {scheduleSummary}
        </div>

        {visitHistorySection}
        {notesBlock(false)}
        {attachmentsBlock}
      </div>
    );
  }

  if (isScheduled) {
    return (
      <div className="flex flex-col gap-6 p-6">
        <div>
          <div className="mb-3 flex items-center justify-between gap-4">
            <p className="text-muted-foreground text-xs font-semibold uppercase">Schedule Info</p>
            {/* Gated on the same ability the booking form is: moving a visit and booking one are
                the one permission, because they are the one endpoint. */}
            {canScheduleWalkthrough && !isRescheduling && (
              <Button variant="outline" size="sm" onClick={() => setIsRescheduling(true)}>
                <CalendarClock />
                Reschedule
              </Button>
            )}
          </div>

          {isRescheduling ? (
            <div className="flex flex-col gap-4">
              {scheduleFieldsBlock}
              {conflictBlock}
              <div className="flex items-center gap-2">
                <Button
                  onClick={() => scheduleMutation.mutate(false)}
                  disabled={scheduleBlocked || scheduleMutation.isPending}
                >
                  <Calendar />
                  {scheduleMutation.isPending ? 'Rescheduling...' : 'Save New Time'}
                </Button>
                <Button variant="ghost" onClick={cancelReschedule} disabled={scheduleMutation.isPending}>
                  Cancel
                </Button>
              </div>
              {scheduleErrorBlock}
            </div>
          ) : (
            scheduleSummary
          )}
        </div>

        {visitHistorySection}
        {notesBlock(true)}
        {attachmentsBlock}

        {canPerformWalkthrough && (
          <div>
            <Button onClick={() => completeMutation.mutate()} disabled={completeMutation.isPending}>
              <CheckCircle2 />
              {completeMutation.isPending ? 'Completing...' : 'Complete Walkthrough'}
            </Button>
            {completeMutation.error && (
              <p className="text-destructive mt-2 text-sm">
                {extractApiError(completeMutation.error, 'Failed to complete walkthrough')}
              </p>
            )}
          </div>
        )}
      </div>
    );
  }

  // Default: no active visit - show the scheduling form for the next one. Covers
  // both a fresh REQUESTED-only lead and "cancelled with nothing rebooked".
  return (
    <div className="flex flex-col gap-6 p-6">
      {isCancelled && (
        <div className="bg-status-red-subtle flex items-center gap-3 rounded-lg border p-4">
          <Ban className="text-destructive size-5 shrink-0" />
          <div>
            <p className="text-destructive text-sm font-semibold">
              Last visit cancelled {cancelledAt ? formatDateTime(cancelledAt, timezone) : ''}
            </p>
            {cancelledReason && <p className="text-destructive mt-0.5 text-xs">{cancelledReason}</p>}
          </div>
        </div>
      )}

      {visitHistorySection}

      <div>
        <p className="text-muted-foreground mb-3 text-xs font-semibold uppercase">Schedule Info</p>
        {scheduleFieldsBlock}
      </div>

      <div>
        <p className="text-muted-foreground mb-3 text-xs font-semibold uppercase">Notes</p>
        <Textarea
          value={wtNotes}
          onChange={(e) => setWtNotes(e.target.value)}
          rows={4}
          placeholder="Walkthrough notes..."
          disabled={!canPerformWalkthrough}
        />
      </div>

      {attachmentsBlock}

      {canScheduleWalkthrough && (
        <div className="flex flex-col gap-4">
          {conflictBlock}
          <div>
            <Button
              onClick={() => scheduleMutation.mutate(false)}
              disabled={scheduleBlocked || scheduleMutation.isPending}
            >
              <Calendar />
              {scheduleMutation.isPending ? 'Scheduling...' : 'Schedule Walkthrough'}
            </Button>
            {scheduleErrorBlock}
          </div>
        </div>
      )}
    </div>
  );
}
