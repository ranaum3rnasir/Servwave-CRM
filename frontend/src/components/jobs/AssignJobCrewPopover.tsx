import { type ReactNode } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import api from '@/lib/axios';
import { jobVisitsQueryKey } from '@/lib/useJobVisits';
import { AssignTeamPopover } from '@/components/crm/AssignTeamPopover';

interface AssignJobCrewPopoverProps {
  jobId: string;
  currentAssigneeIds?: string[] | null;
  trigger: ReactNode;
}

/**
 * Job-crew assign popover (#361). Crew REPLACE semantics via the crew-only endpoint
 * POST /api/jobs/:id/assignees — never touches schedule or status (the Schedule
 * Job / Reschedule modal owns those).
 */
export function AssignJobCrewPopover({ jobId, currentAssigneeIds, trigger }: AssignJobCrewPopoverProps) {
  const queryClient = useQueryClient();

  return (
    <AssignTeamPopover
      mode="multi"
      channels={['in_app', 'email']}
      initialSelected={currentAssigneeIds ?? []}
      trigger={trigger}
      onAssign={async (ids, notify) => {
        await api.post(`/api/jobs/${jobId}/assignees`, {
          assignee_ids: ids,
          notify: { in_app: notify.in_app, email: notify.email },
        });
        queryClient.invalidateQueries({ queryKey: ['job', jobId] });
        queryClient.invalidateQueries({ queryKey: ['jobs'] });
        queryClient.invalidateQueries({ queryKey: ['job-timeline', jobId] });
        queryClient.invalidateQueries({ queryKey: ['schedule-jobs'] });
        queryClient.invalidateQueries({ queryKey: ['schedule-unassigned'] });
        // Since S3 the crew lives on visit_assignees (setJobCrewOnCurrentVisit), and the
        // Visits card names each trip's crew - so the visits query is stale after a
        // crew replace even though "schedule" was untouched.
        queryClient.invalidateQueries({ queryKey: jobVisitsQueryKey(jobId) });
      }}
    />
  );
}
