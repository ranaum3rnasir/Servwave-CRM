/**
 * Multi-visit S2: the job's visit list, v2 chrome.
 *
 * The only renderer of the job's visits. It consumes `lib/useJobVisits` and `lib/visits` rather
 * than deriving rows itself, so the lead surfaces that share those modules cannot drift away from
 * it (#1551). A v1 twin at components/jobs/VisitsCard.tsx used to render the same list; it went
 * with the v1 job page.
 *
 * Times render through `formatInstant` on the ORG clock, never `toLocaleString(undefined, ...)`:
 * the hero tile directly above shows the same instants, and a browser-zone render would put two
 * contradictory times on one screen for every non-Eastern viewer.
 */
import { useState } from 'react';

import { Button } from '@/ui-kit/components/ui/button';
import { ConfirmDialog } from '@/ui-kit/components/ui/confirmDialog';
import { Label } from '@/ui-kit/components/ui/label';
import { Textarea } from '@/ui-kit/components/ui/textarea';

import { formatInstant, useScheduleTimezone } from '@/lib/schedule-tz';
import { availableActions, crewMemberName, isLiveVisit, latestVisitStamp, type JobVisitRow, type VisitVerb } from '@/lib/visits';
import { useVisitLifecycle } from '@/lib/useVisitLifecycle';
import { STATUS_REGISTRY, STATUS_INTENT_FILL } from '@/design-system/status-registry';

import { VisitScheduleDialog } from './visitScheduleDialog';

/** With the year: this list sits beside a hero showing the same instants, and a visit list that
 *  spans a year boundary is exactly the case where "Sep 5" alone is ambiguous. */
const VISIT_FORMAT: Intl.DateTimeFormatOptions = {
  month: 'short',
  day: 'numeric',
  year: 'numeric',
  hour: 'numeric',
  minute: '2-digit',
};

/**
 * S4: the visit's REAL status, read through the shared registry.
 *
 * This card previously collapsed every live status to the word "Scheduled" - so from S4, when a
 * job visit can actually reach EN_ROUTE / ON_SITE / IN_PROGRESS, a crew standing in the customer's
 * driveway read as a booking nobody had left for yet. The registry's `job` block already carries a
 * label and an intent for all six VisitStatus values, so this is a lookup rather than a fourth
 * copy of the mapping.
 */
function statusLabel(v: JobVisitRow): string {
  return STATUS_REGISTRY.job[v.status]?.label ?? v.status;
}

function statusDotClass(status: string): string {
  const intent = STATUS_REGISTRY.job[status]?.intent;
  return intent ? STATUS_INTENT_FILL[intent] : 'bg-muted';
}

export interface VisitsCardProps {
  jobId: string;
  visits: JobVisitRow[];
  isLoading?: boolean;
  /** False for a principal without `reschedule Job` - the same gate the API enforces. */
  canSchedule?: boolean;
  /**
   * S5's rule, finally enforced HERE too: the list being empty says nothing when the fetch
   * failed. useJobVisits has exposed `visitsUnknown` since S5 and the lifecycle rail consumes
   * it, but this card rendered "No visits booked yet." for an errored query - a definitive
   * claim it had no evidence for, with no recovery short of a full reload (the visits query
   * lives at page level, so switching tabs never remounts it, and refetchOnWindowFocus is off).
   */
  visitsUnknown?: boolean;
  /** Refetch for the unknown state's Retry - the page owns the query, so it supplies the verb. */
  onRetry?: () => void;
  /**
   * S3: naming crew needs `assign Job`, which the two visit routes now check PER INSTANCE on top
   * of their subject-level `reschedule Job` gate. Gates the crew picker inside the dialog only -
   * never the dialog, never Save. Defaults true so every other caller is unaffected.
   */
  canAssignCrew?: boolean;
  /**
   * S4 (D7a): which lifecycle verbs may this principal drive? One flag PER VERB, because the four
   * routes are gated on three different abilities - see VISIT_ACTIONS above, and for the limit
   * none of them can express. Absent means no, so a caller that passes nothing offers nothing.
   */
  visitAbilities?: Partial<Record<VisitVerb, boolean>>;
  /** D23: the dialog has to name who it is about to email, so the identity comes from the page. */
  customerName?: string | null;
  customerEmail?: string | null;
}

export function VisitsCard({
  jobId, visits, isLoading, canSchedule = true, canAssignCrew = true, visitAbilities = {},
  customerName, customerEmail, visitsUnknown = false, onRetry,
}: VisitsCardProps) {
  const tz = useScheduleTimezone();
  const lifecycle = useVisitLifecycle(jobId);
  const [addOpen, setAddOpen] = useState(false);
  const [editing, setEditing] = useState<JobVisitRow | null>(null);
  // D19: the trip being called off, and the reason the route requires. Held here rather than in a
  // dialog of its own so the card stays the single place a visit's controls live.
  const [cancelling, setCancelling] = useState<JobVisitRow | null>(null);
  const [cancelReason, setCancelReason] = useState('');

  const dialogs = canSchedule && (
    <>
      {/* Keyed so the dialog REMOUNTS each time it opens: its four-field value is seeded once at
          mount, which keeps the seeding out of an effect. */}
      <VisitScheduleDialog
        key={addOpen ? 'add-open' : 'add-closed'}
        open={addOpen} onOpenChange={setAddOpen}
        jobId={jobId} canAssignCrew={canAssignCrew}
        customerName={customerName} customerEmail={customerEmail}
      />
      <VisitScheduleDialog
        key={editing ? `edit-${editing.id}` : 'edit-closed'}
        open={editing !== null}
        onOpenChange={(next) => { if (!next) setEditing(null); }}
        jobId={jobId} canAssignCrew={canAssignCrew}
        customerName={customerName} customerEmail={customerEmail}
        visit={editing}
      />
      {/* D19: the reason box rides the app's OWN confirm primitive - the same one every other
          destructive flow uses - rather than a fourth hand-rolled modal. Confirm stays disabled
          until a reason exists, because cancelVisitSchema requires one and a blank POST would
          come back 400 with nothing on screen to explain it. */}
      <ConfirmDialog
        open={cancelling !== null}
        onOpenChange={(next) => { if (!next) { setCancelling(null); setCancelReason(''); } }}
        destructive
        title={`Cancel visit ${cancelling?.visit_seq ?? ''}?`}
        description="The visit stays on the list as cancelled and keeps its number. The job itself is not cancelled."
        confirmLabel="Cancel visit"
        cancelLabel="Keep visit"
        isPending={lifecycle.isPending}
        confirmDisabled={cancelReason.trim().length === 0}
        onConfirm={() => {
          if (!cancelling || cancelReason.trim().length === 0) return;
          lifecycle.mutate(
            { visitId: cancelling.id, action: 'cancel', cancelled_reason: cancelReason.trim() },
            { onSuccess: () => { setCancelling(null); setCancelReason(''); } },
          );
        }}
      >
        <div className="space-y-1.5">
          <Label htmlFor="visit-cancel-reason">Reason</Label>
          <Textarea
            id="visit-cancel-reason"
            rows={3}
            value={cancelReason}
            onChange={(e) => setCancelReason(e.target.value)}
            placeholder="Why is this visit being called off?"
          />
        </div>
      </ConfirmDialog>
    </>
  );

  const header = canSchedule && (
    <div className="flex justify-end">
      <Button size="sm" variant="outline" onClick={() => setAddOpen(true)}>Add visit</Button>
    </div>
  );

  if (isLoading) return <p className="text-muted-foreground text-sm">Loading visits...</p>;

  // Not loading and still unknown = the fetch failed. Say so instead of claiming the job
  // holds no trips, and offer the retry the page otherwise has no way to reach.
  if (visitsUnknown) {
    return (
      <div className="flex items-center gap-3">
        <p className="text-muted-foreground text-sm">Couldn&apos;t load this job&apos;s visits.</p>
        {onRetry && (
          <Button size="sm" variant="outline" onClick={onRetry}>Retry</Button>
        )}
      </div>
    );
  }

  if (visits.length === 0) {
    return (
      <div className="flex flex-col gap-3">
        {header}
        <p className="text-muted-foreground text-sm">No visits booked yet.</p>
        {dialogs}
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3">
    {header}
    <ul className="flex flex-col gap-2">
      {visits.map((v) => (
        <li key={v.id} className="flex items-start gap-2.5 rounded-lg border p-3 text-sm">
          <span
            className={['mt-1.5 inline-block size-1.5 shrink-0 rounded-full', statusDotClass(v.status)].join(' ')}
          />
          <div className="min-w-0 flex-1">
            {/* Not a heading: the raw-tag ratchet sits at its floor, and this is a list row
                label rather than a document section. */}
            <p className="font-medium">Visit {v.visit_seq}</p>
            <p className={isLiveVisit(v) ? '' : 'text-muted-foreground'}>
              {statusLabel(v)}{' '}
              {v.is_all_day
                ? `${formatInstant(v.scheduled_at, tz, { month: 'short', day: 'numeric', year: 'numeric' })} (all day)`
                : formatInstant(v.scheduled_at, tz, VISIT_FORMAT)}
            </p>
            {/* S3 (D6): who is on THIS trip. Named rather than counted - the dispatcher's
                question is "who is going", and the job-level Team card cannot answer it per
                visit, because from S3 that card shows the derived UNION across every visit. */}
            {/* S4: the latest thing that actually HAPPENED to this trip, on the ORG clock through
                formatInstant - never toLocaleString, which would render in the viewer's zone two
                lines from a hero rendering the same job on the org's. */}
            {latestVisitStamp(v) && (
              <p className="text-muted-foreground mt-0.5 text-xs">
                {formatInstant(latestVisitStamp(v), tz, VISIT_FORMAT)}
              </p>
            )}
            {/* S7 (user story 40): the office's receipt. "What did we tell them, and when" is
                answered on the surface that sent it, on the ORG clock like everything else here. */}
            {v.customer_email_sent_at && (
              <p className="text-muted-foreground mt-0.5 text-xs">
                Customer notified {formatInstant(v.customer_email_sent_at, tz, VISIT_FORMAT)}
              </p>
            )}
            {(v.assignees?.length ?? 0) > 0 && (
              <p className="text-muted-foreground mt-0.5 text-xs">
                {v.assignees!.map(crewMemberName).filter(Boolean).join(', ')}
              </p>
            )}
            {v.status === 'CANCELLED' && v.cancelled_reason && (
              <p className="text-muted-foreground mt-0.5 text-xs">{v.cancelled_reason}</p>
            )}
          </div>
          {isLiveVisit(v) && availableActions(v.status, visitAbilities).length > 0 && (
            <div className="flex shrink-0 gap-1">
              {availableActions(v.status, visitAbilities).map((a) => (
                <Button
                  key={a.action}
                  size="sm"
                  variant="ghost"
                  disabled={lifecycle.isPending}
                  onClick={() => lifecycle.mutate({ visitId: v.id, action: a.action })}
                >
                  {a.label}
                </Button>
              ))}
            </div>
          )}
          {canSchedule && isLiveVisit(v) && (
            // Only a still-coming trip can be moved. A completed or cancelled row is history
            // (D19) - it is kept and readable, never edited.
            <Button size="sm" variant="ghost" onClick={() => setEditing(v)}>Reschedule</Button>
          )}
          {/* D19: calling ONE trip off. Gated on canSchedule - the `reschedule Job` ability -
              because that is what POST .../cancel is gated on (job.routes.ts), NOT on the crew
              verbs the four milestone buttons above ride. Same live-only rule as Reschedule:
              history is readable, never actionable. */}
          {canSchedule && isLiveVisit(v) && (
            <Button
              size="sm"
              variant="ghost"
              onClick={() => { setCancelReason(''); setCancelling(v); }}
            >
              Cancel
            </Button>
          )}
        </li>
      ))}
    </ul>
    {dialogs}
    </div>
  );
}

export default VisitsCard;
