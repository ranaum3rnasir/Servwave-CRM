import { useState, useEffect } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import api from '@/lib/axios';
import { extractApiError } from '@/lib/utils';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { DatePicker } from '@/components/form/DatePicker';
import { DateTimePicker } from '@/components/form/DateTimePicker';
import { MultiAssigneeSelect } from '@/components/crm/MultiAssigneeSelect';
import { useScheduleTimezone, pickerValueToIso, isoToPickerValue } from '@/lib/schedule-tz';
import { Loader2 } from 'lucide-react';

type AssignJobDialogMode = 'assign' | 'schedule';

interface AssignJobDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  jobId: string;
  /** 'assign' (crew-focused copy) vs 'schedule' (date/time-focused copy). The dialog body
   *  is identical either way — only the header/submit-button wording changes to match
   *  what the caller actually triggered. Defaults to 'assign'. */
  mode?: AssignJobDialogMode;
  /** Current crew (drives the Assign/Reassign copy and seeds the picker). */
  currentAssigneeIds?: string[] | null;
  /** Whether the job already has a schedule (drives Schedule/Reschedule copy in 'schedule' mode). */
  isScheduled?: boolean;
  defaultStart?: string;    // ISO string — pre-fills scheduled start from calendar drop
  defaultEnd?: string;      // ISO string — pre-fills scheduled end from calendar drop
  defaultTechId?: string;   // pre-selects technician (for grouped-by-tech calendar drop)
  defaultIsAllDay?: boolean;
}

export function AssignJobDialog({ open, onOpenChange, jobId, mode = 'assign', currentAssigneeIds, isScheduled, defaultStart, defaultEnd, defaultTechId, defaultIsAllDay }: AssignJobDialogProps) {
  const queryClient = useQueryClient();
  // The picker values below are zoneless wall clock and mean the ORG's clock. This dialog
  // is reached from BOTH the scheduler board and the job detail page, so before this it was
  // the one place where dragging a card and pressing Assign produced different stored times.
  const timezone = useScheduleTimezone();
  const [techIds, setTechIds] = useState<string[]>([]);
  const [scheduledStart, setScheduledStart] = useState('');
  const [scheduledEnd, setScheduledEnd] = useState('');
  const [isAllDay, setIsAllDay] = useState(false);
  const [conflictMessage, setConflictMessage] = useState<string | null>(null);
  const [pendingForce, setPendingForce] = useState<{ techIds: string[]; start: string; end: string } | null>(null);
  const isReassign = Boolean(currentAssigneeIds && currentAssigneeIds.length > 0);

  /** The day after `day` ('YYYY-MM-DD'), as pure calendar arithmetic. Deliberately NOT
   *  `instant + 24h`, which is wrong by an hour on either DST transition. */
  const nextDay = (day: string): string => {
    const [y, m, d] = day.split('-').map(Number);
    return new Date(Date.UTC(y!, m! - 1, d! + 1)).toISOString().slice(0, 10);
  };

  // Reset state when dialog opens, apply defaults. Seed the crew from a calendar
  // drop (defaultTechId) or the job's current crew (currentAssigneeIds).
  useEffect(() => {
    if (open) {
      setTechIds(defaultTechId ? [defaultTechId] : (currentAssigneeIds ?? []));
      setScheduledStart(defaultStart ? isoToPickerValue(defaultStart, timezone) : '');
      setScheduledEnd(defaultEnd ? isoToPickerValue(defaultEnd, timezone) : '');
      setIsAllDay(defaultIsAllDay ?? false);
      setConflictMessage(null);
      setPendingForce(null);
    }
    // currentAssigneeIds intentionally omitted: only seed on open, not on every parent re-render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, defaultStart, defaultEnd, defaultTechId, defaultIsAllDay, timezone]);

  const mutation = useMutation({
    mutationFn: async () => {
      const { data } = await api.post(`/api/jobs/${jobId}/assign`, {
        assignee_ids: techIds,
        scheduled_start: pickerValueToIso(scheduledStart, timezone),
        scheduled_end: pickerValueToIso(scheduledEnd, timezone),
        is_all_day: isAllDay,
      });
      return data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['job', jobId] });
      queryClient.invalidateQueries({ queryKey: ['jobs'] });
      queryClient.invalidateQueries({ queryKey: ['job-timeline', jobId] });
      queryClient.invalidateQueries({ queryKey: ['schedule-unassigned'] });
      queryClient.invalidateQueries({ queryKey: ['schedule-jobs'] });
      onOpenChange(false);
    },
    onError: (err: unknown) => {
      const axiosErr = err as { response?: { status?: number; data?: { error?: string } } };
      if (axiosErr.response?.status === 409) {
        const msg = extractApiError(err, 'Scheduling conflict detected.');
        setConflictMessage(msg);
        setPendingForce({
          techIds,
          start: pickerValueToIso(scheduledStart, timezone) ?? '',
          end: pickerValueToIso(scheduledEnd, timezone) ?? '',
        });
      }
    },
  });

  const forceMutation = useMutation({
    mutationFn: async () => {
      if (!pendingForce) return;
      const { data } = await api.post(`/api/jobs/${jobId}/assign`, {
        assignee_ids: pendingForce.techIds,
        scheduled_start: pendingForce.start || undefined,
        scheduled_end: pendingForce.end || undefined,
        force: true,
      });
      return data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['job', jobId] });
      queryClient.invalidateQueries({ queryKey: ['jobs'] });
      queryClient.invalidateQueries({ queryKey: ['job-timeline', jobId] });
      queryClient.invalidateQueries({ queryKey: ['schedule-unassigned'] });
      queryClient.invalidateQueries({ queryKey: ['schedule-jobs'] });
      setConflictMessage(null);
      setPendingForce(null);
      onOpenChange(false);
    },
  });

  const mutationErrorMsg = mutation.error ? extractApiError(mutation.error, 'Failed to assign job') : null;

  const title = mode === 'schedule'
    ? (isScheduled ? 'Reschedule Job' : 'Schedule Job')
    : (isReassign ? 'Reassign Technician' : 'Assign Technician');
  const description = mode === 'schedule'
    ? 'Set the date, time and crew for this job.'
    : (isReassign ? 'Select a different technician for this job.' : 'Select a technician and optionally set schedule.');
  const submitLabel = mode === 'schedule'
    ? (isScheduled ? 'Reschedule' : 'Schedule')
    : (isReassign ? 'Reassign' : 'Assign');
  const submitBusyLabel = mode === 'schedule' ? 'Scheduling...' : 'Assigning...';

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div>
            <Label>Crew *</Label>
            <MultiAssigneeSelect
              value={techIds}
              onChange={setTechIds}
              placeholder="Add member..."
              enabled={open}
            />
          </div>

          <div className="flex items-center gap-2 py-1">
            {/* Not converted to FormField: a checkbox row (label sits beside the control, not
                above it) - out of FormField's label-above-a-single-control shape. */}
            <input
              type="checkbox"
              id="all-day-toggle"
              checked={isAllDay}
              onChange={(e) => {
                setIsAllDay(e.target.checked);
                if (e.target.checked && scheduledStart) {
                  const day = scheduledStart.slice(0, 10);
                  setScheduledStart(`${day}T00:00`);
                  setScheduledEnd(`${nextDay(day)}T00:00`);
                }
              }}
              className="rounded border-border"
            />
            <label htmlFor="all-day-toggle" className="text-sm text-text-primary cursor-pointer">All Day</label>
          </div>

          {isAllDay ? (
            <div>
              <Label>Date</Label>
              <DatePicker
                value={scheduledStart ? (scheduledStart.split('T')[0] ?? '') : ''}
                onChange={(dateStr) => {
                  if (dateStr) {
                    setScheduledStart(`${dateStr}T00:00`);
                    setScheduledEnd(`${nextDay(dateStr)}T00:00`);
                  }
                }}
              />
            </div>
          ) : (
            <>
              <div>
                <Label>Scheduled Start</Label>
                <DateTimePicker value={scheduledStart} onChange={setScheduledStart} />
              </div>

              <div>
                <Label>Scheduled End</Label>
                <DateTimePicker value={scheduledEnd} onChange={setScheduledEnd} />
              </div>
            </>
          )}

          {conflictMessage && (
            <div className="rounded-md border border-warning-border bg-warning-surface p-3 text-sm text-warning-text">
              <p className="font-medium mb-1">⚠ Scheduling Conflict</p>
              <p>{conflictMessage}</p>
              <div className="flex gap-2 mt-2">
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => { setConflictMessage(null); setPendingForce(null); }}
                >
                  Cancel
                </Button>
                <Button
                  size="sm"
                  onClick={() => forceMutation.mutate()}
                  disabled={forceMutation.isPending}
                >
                  {forceMutation.isPending ? 'Scheduling...' : 'Schedule Anyway'}
                </Button>
              </div>
            </div>
          )}

          {mutationErrorMsg && (
            <p className="text-sm text-danger">{mutationErrorMsg}</p>
          )}

          <div className="flex justify-end gap-3">
            <Button variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button
              onClick={() => mutation.mutate()}
              disabled={techIds.length === 0 || mutation.isPending || Boolean(conflictMessage)}
            >
              {mutation.isPending ? (
                <><Loader2 className="mr-2 h-4 w-4 animate-spin" /> {submitBusyLabel}</>
              ) : (
                submitLabel
              )}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
