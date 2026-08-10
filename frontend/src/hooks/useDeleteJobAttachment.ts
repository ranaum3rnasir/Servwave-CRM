/**
 * useDeleteJobAttachment - shared delete mutation for the two job attachment surfaces
 * (`JobFilesCard` on the Overview tab and `AttachmentsTabBody` on the Attachments tab).
 *
 * Both render the SAME `['job-attachments-wt', jobId]` query, so a delete from either has to
 * invalidate both that key and `['attachments', 'JOB', jobId]` - exactly the pair their existing
 * upload handlers already invalidate. Extracted rather than duplicated so the two surfaces cannot
 * drift on which keys they refresh.
 *
 * Walkthrough-sourced files are deliberately NOT deletable from a job: they belong to the lead and
 * are only forwarded in via `include_walkthrough=true`, so deleting one here would silently remove
 * it from the lead too. Callers gate on `isDeletableFromJob` before rendering a delete control.
 */
import { useMutation, useQueryClient } from '@tanstack/react-query';
import api from '@/lib/axios';
import { toast } from '@/components/ui/use-toast';
import { extractApiError } from '@/lib/utils';

/** The walkthrough marker can arrive on either field depending on the list endpoint. */
export function isDeletableFromJob(att: { context?: string | null; source?: string | null }): boolean {
  return att.source !== 'WALKTHROUGH' && att.context !== 'WALKTHROUGH';
}

export function useDeleteJobAttachment(jobId: string) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (attachmentId: string) => {
      await api.delete(`/api/attachments/job/${jobId}/${attachmentId}`);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['job-attachments-wt', jobId] });
      queryClient.invalidateQueries({ queryKey: ['attachments', 'JOB', jobId] });
    },
    onError: (err) => {
      toast({
        variant: 'destructive',
        title: 'Delete failed',
        description: extractApiError(err as Error, 'Could not delete the file. Please try again.'),
      });
    },
  });
}
