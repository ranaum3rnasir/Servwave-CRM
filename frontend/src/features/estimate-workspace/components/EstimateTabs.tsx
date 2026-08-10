import { useNavigate } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Plus, Loader2, Copy, FilePlus } from 'lucide-react';
import api from '@/lib/axios';
import { cn } from '@/lib/utils';
import { useAppAbility } from '@/contexts/AbilityContext';
import { createEstimate, duplicateEstimate } from '@/lib/api/estimates';
import { invalidateEstimateLists } from '../lib/newEstimate';
import { toast } from '@/components/ui/use-toast';
import { extractApiError } from '@/lib/utils';
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubTrigger,
  DropdownMenuSubContent,
} from '@/components/ui/dropdown-menu';

/** One estimate on the lead, as the tab strip needs it. */
interface SiblingEstimate {
  id: string;
  estimate_number: string;
  name?: string | null;
  status: string;
  created_at: string;
}

interface EstimateTabsProps {
  leadId: string;
  activeEstimateId: string;
}

/**
 * Per-lead estimate tab strip for the unified workspace.
 *
 * Lists every estimate sharing this lead (re-quotes / Good-Better-Best options),
 * lets you switch between them, and adds a new one — blank (empty) or copied from
 * an existing estimate. Tabs show the estimate's custom name when set, else
 * "Estimate N" by creation order. Renaming is done from the title; deleting from
 * the top-bar Actions (⋯) menu.
 */
export function EstimateTabs({ leadId, activeEstimateId }: EstimateTabsProps) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const ability = useAppAbility();
  const canCreate = ability.can('create', 'Estimate');
  const canDuplicate = ability.can('duplicate', 'Estimate');

  const { data: siblings } = useQuery<SiblingEstimate[]>({
    queryKey: ['estimates', { lead_id: leadId }],
    queryFn: async () => {
      const { data } = await api.get('/api/estimates', {
        params: { lead_id: leadId, limit: 50 },
      });
      return data.estimates as SiblingEstimate[];
    },
    enabled: Boolean(leadId),
  });

  // Creation order so positions stay stable ("Estimate 1" is always the oldest).
  const tabs = [...(siblings ?? [])].sort(
    (a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime(),
  );
  const labelFor = (est: SiblingEstimate, i: number) => est.name?.trim() || `Estimate ${i + 1}`;

  // After a blank/copy create, refresh the strip + the list page, then land on it.
  function goToNewEstimate(newId: string) {
    invalidateEstimateLists(queryClient);
    navigate(`/estimates/${newId}`);
  }

  const addBlank = useMutation({
    // A "blank" estimate is genuinely empty — no line items — so it starts from
    // scratch on this lead. (The backend allows an empty DRAFT.)
    mutationFn: () => createEstimate({ lead_id: leadId }),
    onSuccess: (data) => data?.estimate?.id && goToNewEstimate(data.estimate.id),
    onError: (err) =>
      toast({
        title: 'Could not add estimate',
        description: extractApiError(err, 'Failed to create a new estimate'),
        variant: 'destructive',
      }),
  });

  const addCopy = useMutation({
    mutationFn: (sourceId: string) => duplicateEstimate(sourceId),
    onSuccess: (data) => data?.estimate?.id && goToNewEstimate(data.estimate.id),
    onError: (err) =>
      toast({
        title: 'Could not copy estimate',
        description: extractApiError(err, 'Failed to copy the estimate'),
        variant: 'destructive',
      }),
  });

  const busy = addBlank.isPending || addCopy.isPending;

  return (
    <div className="flex items-center gap-1 border-b border-border">
      <div className="flex items-center gap-1 overflow-x-auto">
        {tabs.map((est, i) => {
          const isActive = est.id === activeEstimateId;
          return (
            // Tab-strip item (segmented toggle) - not Button-shaped. Deferred.
            <button
              key={est.id}
              type="button"
              onClick={() => !isActive && navigate(`/estimates/${est.id}`)}
              aria-current={isActive ? 'page' : undefined}
              className={cn(
                'whitespace-nowrap border-b-2 px-3 pb-2 pt-1 text-sm font-semibold transition-colors',
                isActive
                  ? 'border-primary text-text-primary'
                  : 'border-transparent text-text-secondary hover:text-text-primary',
              )}
            >
              {labelFor(est, i)}
            </button>
          );
        })}
      </div>

      {canCreate && (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            {/* Tab-strip-integrated "add" trigger (shares the tabs' px-3 pb-2 pt-1
                baseline) - no ghost/brand cell is minted to reproduce its always-on
                text-primary + hover:text-ocean-800. Deferred. */}
            <button
              type="button"
              disabled={busy}
              className="ml-1 flex items-center gap-1 whitespace-nowrap px-3 pb-2 pt-1 text-sm font-semibold text-primary hover:text-ocean-800 disabled:opacity-60"
            >
              {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />}
              Add estimate
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start">
            <DropdownMenuItem onSelect={() => addBlank.mutate()}>
              <FilePlus className="mr-2 h-4 w-4" />
              Start blank
            </DropdownMenuItem>
            {canDuplicate && tabs.length > 0 && (
              <>
                <DropdownMenuSeparator />
                <DropdownMenuSub>
                  <DropdownMenuSubTrigger>
                    <Copy className="mr-2 h-4 w-4" />
                    Copy from…
                  </DropdownMenuSubTrigger>
                  <DropdownMenuSubContent>
                    {tabs.map((est, i) => (
                      <DropdownMenuItem key={est.id} onSelect={() => addCopy.mutate(est.id)}>
                        {labelFor(est, i)}
                      </DropdownMenuItem>
                    ))}
                  </DropdownMenuSubContent>
                </DropdownMenuSub>
              </>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
      )}
    </div>
  );
}
