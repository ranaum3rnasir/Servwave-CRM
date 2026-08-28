import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Briefcase, FileText } from 'lucide-react';

import { formatCurrency } from '@/lib/utils';
import { EmptyState } from '@/ui-kit/components/data/emptyState';
import { Button } from '@/ui-kit/components/ui/button';
import {
  Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter,
  DialogHeader, DialogIcon, DialogTitle,
} from '@/ui-kit/components/ui/dialog';

import { StatusChip } from '../../_shared/statusChip';
import { preferV2Path } from '../../uiV2';

export interface CreateJobEstimate {
  id: string;
  estimate_number: string;
  status: string;
  total_amount: string;
  created_at: string;
  job?: { id: string; job_number: string; status: string } | null;
}

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  leadId: string;
  estimates: CreateJobEstimate[];
  canCreateEstimate: boolean;
  preselectEstimateId?: string | null;
  isConverting: boolean;
  onConvert: (estimateId: string) => void;
}

/**
 * v2 port of `components/leads/CreateJobFromLeadDialog`. Selection rules
 * unchanged: a valid preselect wins, else a lone convertible estimate
 * auto-selects, else nothing.
 *
 * The legacy version seeded that selection from an effect keyed on `open`. Here
 * the body is a child that only exists while the dialog is open, so the same
 * rule runs as a lazy initialiser on mount - no state written from an effect.
 */
function CreateJobFromLeadDialog({
  open, onOpenChange, leadId, estimates, canCreateEstimate,
  preselectEstimateId, isConverting, onConvert,
}: Props) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <CreateJobDialogBody
          onOpenChange={onOpenChange}
          leadId={leadId}
          estimates={estimates}
          canCreateEstimate={canCreateEstimate}
          preselectEstimateId={preselectEstimateId}
          isConverting={isConverting}
          onConvert={onConvert}
        />
      </DialogContent>
    </Dialog>
  );
}

function CreateJobDialogBody({
  onOpenChange, leadId, estimates, canCreateEstimate, preselectEstimateId, isConverting, onConvert,
}: Omit<Props, 'open'>) {
  const navigate = useNavigate();
  const convertible = estimates.filter((e) => e.status === 'WON' && !e.job);
  const [selectedId, setSelectedId] = useState<string | null>(() => {
    if (preselectEstimateId != null && convertible.some((e) => e.id === preselectEstimateId)) {
      return preselectEstimateId;
    }
    if (convertible.length === 1) return convertible[0]?.id ?? null;
    return null;
  });

  return (
    <>
        <DialogHeader>
          <DialogIcon><Briefcase /></DialogIcon>
          <div>
            <DialogTitle>Create job from estimate</DialogTitle>
            <DialogDescription>
              Pick an approved estimate to convert into a job. Only approved estimates can be converted.
            </DialogDescription>
          </div>
        </DialogHeader>

        <DialogBody>
          {estimates.length === 0 ? (
            <EmptyState icon={<FileText />} title="No estimates yet." />
          ) : (
            <>
              <div className="flex max-h-72 flex-col gap-1.5 overflow-y-auto">
                {estimates.map((est) => {
                  const isConvertible = est.status === 'WON' && !est.job;
                  const isSelected = selectedId === est.id;
                  return (
                    <div
                      key={est.id}
                      className={[
                        'flex items-center justify-between rounded-lg border px-3 py-2',
                        isConvertible ? 'cursor-pointer' : 'opacity-70',
                        isSelected ? 'border-brand bg-brand-subtle' : '',
                      ].join(' ')}
                      onClick={isConvertible ? () => setSelectedId(est.id) : undefined}
                    >
                      <div className="flex min-w-0 items-center gap-2">
                        {isConvertible && (
                          <span
                            className={[
                              'size-4 shrink-0 rounded-full border',
                              isSelected ? 'border-brand bg-brand' : '',
                            ].join(' ')}
                            aria-hidden
                          />
                        )}
                        <span className="text-brand font-medium">{est.estimate_number}</span>
                        <StatusChip domain="estimate" status={est.status} />
                      </div>
                      <div className="flex shrink-0 items-center gap-2">
                        {est.job ? (
                          <Button
                            variant="link"
                            size="sm"
                            className="h-auto px-0"
                            onClick={(e) => {
                              e.stopPropagation();
                              onOpenChange(false);
                              navigate(preferV2Path(`/jobs/${est.job!.id}`));
                            }}
                          >
                            {est.job.job_number} →
                          </Button>
                        ) : (
                          <span className="text-sm tabular-nums">{formatCurrency(est.total_amount)}</span>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
              {convertible.length === 0 && (
                <p className="text-muted-foreground mt-2 text-xs">
                  No approved estimate to convert yet. Approve an estimate first
                  {canCreateEstimate ? ', or create a new one below.' : '.'}
                </p>
              )}
            </>
          )}
        </DialogBody>

        <DialogFooter className="justify-between">
          {canCreateEstimate ? (
            <Button
              variant="outline"
              size="sm"
              onClick={() => { onOpenChange(false); navigate(preferV2Path(`/estimates/new?lead_id=${leadId}`)); }}
            >
              <FileText />
              New estimate
            </Button>
          ) : (
            <span />
          )}
          <div className="flex gap-2">
            <Button variant="outline" size="sm" onClick={() => onOpenChange(false)}>Cancel</Button>
            <Button
              size="sm"
              disabled={!selectedId || isConverting}
              onClick={() => selectedId && onConvert(selectedId)}
            >
              <Briefcase />
              {isConverting ? 'Creating…' : 'Create job'}
            </Button>
          </div>
        </DialogFooter>
    </>
  );
}

export { CreateJobFromLeadDialog };
