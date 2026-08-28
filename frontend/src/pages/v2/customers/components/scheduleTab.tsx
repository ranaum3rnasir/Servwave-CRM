import { CalendarClock } from 'lucide-react';

import { Badge } from '@/ui-kit/components/ui/badge';
import {
  Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter,
  DialogHeader, DialogIcon, DialogTitle,
} from '@/ui-kit/components/ui/dialog';
import { Button } from '@/ui-kit/components/ui/button';
import { EmptyState } from '@/ui-kit/components/data/emptyState';
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '@/ui-kit/components/ui/table';

import type { JobSummary, LeadSummary } from './detailTabs';

// --- Shapes ------------------------------------------------------------------

/**
 * Exactly what `GET /api/calendar-entries?customer_id=` nests per participant
 * (backend/src/lib/calendar-entries/participants.ts's `EnrichedParticipant`) -
 * `user_id`/`customer_id` are omitted here, this tab never needs them, only
 * the resolved display fields.
 */
export interface CalendarEntryParticipantSummary {
  id: string;
  kind: 'USER' | 'CUSTOMER';
  first_name: string | null;
  last_name: string | null;
  name: string | null;
  email: string | null;
}

/** One row of `GET /api/calendar-entries?customer_id=` (calendar_entry_.SELECT, slice 02/10). */
export interface CalendarEntrySummary {
  id: string;
  title: string;
  description: string;
  start: string;
  end: string;
  is_all_day: boolean;
  participants: CalendarEntryParticipantSummary[];
}

export type ScheduleRowKind = 'job' | 'walkthrough' | 'event';

export interface ScheduleRow {
  key: string;
  kind: ScheduleRowKind;
  id: string;
  /** J00041 / L00012 - blank for an event, which carries no record number. */
  number: string;
  title: string;
  /** ISO instant, or null for an unscheduled job - sorts last, see buildScheduleRows. */
  start: string | null;
  /** The source row, for the Event click handler to open without a second fetch. */
  raw: JobSummary | LeadSummary | CalendarEntrySummary;
}

const KIND_META: Record<ScheduleRowKind, { label: string; variant: 'softBlue' | 'softAmber' | 'softNeutral' }> = {
  job: { label: 'Job', variant: 'softBlue' },
  walkthrough: { label: 'Walkthrough', variant: 'softAmber' },
  // Muted on purpose (spec §3's "muted card" note carried over to this vocabulary): an Event
  // names nothing about crew availability, so it must never read with the same weight as a Job.
  event: { label: 'Event', variant: 'softNeutral' },
};

/**
 * Merges the customer's jobs, walkthroughs (leads holding a scheduled walkthrough visit) and
 * Events into one time-ordered list.
 *
 * `leads` is the SAME `GET /api/leads?customer_id=` response the Leads tab already reads
 * (LeadSummary, extended with the `walkthrough_scheduled_at` legacy-shaped field every list
 * response already carries - projectLeadWalkthroughFields on the backend). A lead with no live
 * walkthrough (never booked, or its only visit was cancelled) contributes no row: this tab shows
 * what is actually booked, not every lead that could someday get one.
 *
 * Unscheduled jobs (no `scheduled_start`) sort LAST, in their existing order, rather than being
 * dropped - the row still says "this job exists for this customer", it just cannot be time-sorted
 * against something that has no time.
 */
export function buildScheduleRows(
  jobs: JobSummary[],
  leads: LeadSummary[],
  calendarEntries: CalendarEntrySummary[],
): ScheduleRow[] {
  const jobRows: ScheduleRow[] = jobs.map((j) => ({
    key: `job-${j.id}`,
    kind: 'job',
    id: j.id,
    number: j.job_number,
    title: j.scope_notes?.trim() || 'Job',
    start: j.scheduled_start ?? null,
    raw: j,
  }));

  const walkthroughRows: ScheduleRow[] = leads
    .filter((l) => Boolean(l.walkthrough_scheduled_at))
    .map((l) => ({
      key: `walkthrough-${l.id}`,
      kind: 'walkthrough',
      id: l.id,
      number: l.lead_number ?? '',
      // The lead's own service request, not a bare "Walkthrough" - the type chip already says
      // that, and repeating it in the title column would be the two nearest cells on the row
      // reading identically for no reason.
      title: l.service_request?.trim() || 'Walkthrough',
      start: l.walkthrough_scheduled_at as string,
      raw: l,
    }));

  const eventRows: ScheduleRow[] = calendarEntries.map((e) => ({
    key: `event-${e.id}`,
    kind: 'event',
    id: e.id,
    number: '',
    title: e.title,
    start: e.start,
    raw: e,
  }));

  return [...jobRows, ...walkthroughRows, ...eventRows].sort((a, b) => {
    if (a.start === null && b.start === null) return 0;
    if (a.start === null) return 1;
    if (b.start === null) return -1;
    return new Date(a.start).getTime() - new Date(b.start).getTime();
  });
}

function formatRowDate(iso: string | null): string {
  if (!iso) return 'Unscheduled';
  return new Date(iso).toLocaleString('en-US', {
    month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit',
  });
}

export interface ScheduleTabProps {
  jobs: JobSummary[];
  leads: LeadSummary[];
  /** Already resolved to [] by the caller when the viewer lacks `read CalendarEntry`. */
  calendarEntries: CalendarEntrySummary[];
  onNavigateJob: (id: string) => void;
  onNavigateWalkthrough: (leadId: string) => void;
  onOpenEvent: (entry: CalendarEntrySummary) => void;
}

/**
 * §6's combined Schedule tab: jobs, walkthroughs and Events for this customer, one time-ordered
 * list. Read-only aggregation - a row link out to the record it represents; no create/edit
 * affordance lives here (that is slice 04's Event dialog, not yet built).
 */
export function ScheduleTab({
  jobs, leads, calendarEntries, onNavigateJob, onNavigateWalkthrough, onOpenEvent,
}: ScheduleTabProps) {
  const rows = buildScheduleRows(jobs, leads, calendarEntries);

  if (rows.length === 0) {
    return <EmptyState icon={<CalendarClock />} title="Nothing scheduled yet." />;
  }

  function handleClick(row: ScheduleRow) {
    if (row.kind === 'job') onNavigateJob(row.id);
    else if (row.kind === 'walkthrough') onNavigateWalkthrough(row.id);
    else onOpenEvent(row.raw as CalendarEntrySummary);
  }

  return (
    <Table>
      <TableHeader>
        <TableRow className="hover:bg-transparent">
          <TableHead>Type</TableHead>
          <TableHead>Reference</TableHead>
          <TableHead>Title</TableHead>
          <TableHead>Date</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((row) => {
          const meta = KIND_META[row.kind];
          return (
            <TableRow key={row.key} className="cursor-pointer" onClick={() => handleClick(row)}>
              <TableCell><Badge variant={meta.variant} size="pill">{meta.label}</Badge></TableCell>
              <TableCell>
                <span className="text-muted-foreground font-mono text-xs">{row.number || '-'}</span>
              </TableCell>
              <TableCell><span className="block truncate">{row.title}</span></TableCell>
              <TableCell>
                <span className={row.start ? undefined : 'text-muted-foreground italic'}>
                  {formatRowDate(row.start)}
                </span>
              </TableCell>
            </TableRow>
          );
        })}
      </TableBody>
    </Table>
  );
}

// --- Event detail (read-only) -------------------------------------------------

/**
 * A minimal, ALWAYS-read-only view of one Event - no edit, no delete, no participants field.
 * This stands in for slice 04's create/edit Event dialog, which this slice does not build (out
 * of scope - see the slice doc's scope discipline note). Once slice 04 ships its dialog, an
 * update-capable viewer should open THAT instead of this one; until then every viewer, update
 * grant or not, sees this same read-only view.
 */
export function EventDetailDialog({
  entry, open, onOpenChange,
}: {
  entry: CalendarEntrySummary | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogIcon><CalendarClock /></DialogIcon>
          <div>
            <DialogTitle>{entry?.title ?? 'Event'}</DialogTitle>
            <DialogDescription>
              {entry ? `${formatRowDate(entry.start)} - ${formatRowDate(entry.end)}` : ''}
            </DialogDescription>
          </div>
        </DialogHeader>
        <DialogBody className="flex flex-col gap-3">
          {entry?.description && (
            <p className="text-sm whitespace-pre-wrap">{entry.description}</p>
          )}
          {entry && entry.participants.length > 0 && (
            <div className="flex flex-col gap-1.5">
              <p className="text-muted-foreground text-xs font-semibold uppercase tracking-wide">
                Participants
              </p>
              <div className="flex flex-wrap gap-1.5">
                {entry.participants.map((p) => (
                  <Badge key={p.id} variant="softNeutral" size="sm">
                    {p.kind === 'USER' ? `${p.first_name ?? ''} ${p.last_name ?? ''}`.trim() : p.name}
                  </Badge>
                ))}
              </div>
            </div>
          )}
        </DialogBody>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>Close</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
