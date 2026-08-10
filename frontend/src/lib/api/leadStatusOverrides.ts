import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import api from '@/lib/axios';
import { toast } from '@/components/ui/use-toast';
import { extractApiError } from '@/lib/utils';

/**
 * SRVW-111 (label-override shape) - per-org display overrides for the FIXED LeadStatus enum.
 * All 6 enum values are always present in the response (merged with any stored override server-
 * side), so this is never empty the way useJobSubStatuses() can be for a fresh org.
 */
export interface LeadStatusOverride {
  status: string;
  /** null = no rename; the caller falls back to STATUS_REGISTRY.lead[status]'s own label. */
  label: string | null;
  sort_order: number;
  is_default: boolean;
  hidden: boolean;
}

export function useLeadStatusOverrides() {
  return useQuery<LeadStatusOverride[]>({
    queryKey: ['lead-status-overrides'],
    queryFn: () => api.get('/api/lead-status-overrides').then((r) => r.data.lead_status_overrides ?? []),
  });
}

export function useUpdateLeadStatusOverride() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ status, label, hidden }: { status: string; label?: string | null; hidden?: boolean }) =>
      api.patch(`/api/lead-status-overrides/${status}`, { label, hidden }).then((r) => r.data),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['lead-status-overrides'] }),
    onError: (err) =>
      toast({
        title: 'Could not update lead status',
        description: extractApiError(err, 'Failed to update lead status'),
        variant: 'destructive',
      }),
  });
}

export function useSetDefaultLeadStatus() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (status: string) => api.post(`/api/lead-status-overrides/${status}/default`).then((r) => r.data),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['lead-status-overrides'] }),
    onError: (err) =>
      toast({
        title: 'Could not set default lead status',
        description: extractApiError(err, 'Failed to set default lead status'),
        variant: 'destructive',
      }),
  });
}

export function useReorderLeadStatusOverrides() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (ordered_statuses: string[]) =>
      api.post('/api/lead-status-overrides/reorder', { ordered_statuses }).then((r) => r.data),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['lead-status-overrides'] }),
    onError: (err) =>
      toast({
        title: 'Could not reorder lead statuses',
        description: extractApiError(err, 'Failed to reorder lead statuses'),
        variant: 'destructive',
      }),
  });
}
