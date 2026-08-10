import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { StatusBadge } from '@/components/data/status-badge';
import { EmptyState } from '@/components/ui/empty-state';
import { formatCurrency } from '@/lib/utils';
import { Briefcase, FileText } from 'lucide-react';

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

export function CreateJobFromLeadDialog({
  open,
  onOpenChange,
  leadId,
  estimates,
  canCreateEstimate,
  preselectEstimateId,
  isConverting,
  onConvert,
}: Props) {
  const navigate = useNavigate();
  const convertible = estimates.filter((e) => e.status === 'WON' && !e.job);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    const pre = preselectEstimateId != null && convertible.some((e) => e.id === preselectEstimateId);
    if (pre && preselectEstimateId) setSelectedId(preselectEstimateId);
    else if (convertible.length === 1) setSelectedId(convertible[0]?.id ?? null);
    else setSelectedId(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, preselectEstimateId, estimates]);

  function goCreateEstimate() {
    onOpenChange(false);
    navigate(`/estimates/new?lead_id=${leadId}`);
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Create job from estimate</DialogTitle>
          <DialogDescription>
            Pick an approved estimate to convert into a job. Only approved estimates can be converted.
          </DialogDescription>
        </DialogHeader>

        {estimates.length === 0 ? (
          <EmptyState density="compact" icon={FileText} title="No estimates yet." />
        ) : (
          <>
            <div className="space-y-1.5 max-h-72 overflow-y-auto">
              {estimates.map((est) => {
                const isConvertible = est.status === 'WON' && !est.job;
                const isSelected = selectedId === est.id;
                return (
                  <div
                    key={est.id}
                    className={[
                      'flex items-center justify-between rounded-lg border px-3 py-2',
                      isConvertible ? 'cursor-pointer' : 'opacity-70',
                      isSelected ? 'border-primary bg-primary-subtle' : 'border-border',
                    ].join(' ')}
                    onClick={isConvertible ? () => setSelectedId(est.id) : undefined}
                  >
                    <div className="flex items-center gap-2 min-w-0">
                      {isConvertible && (
                        <span
                          className={[
                            'h-4 w-4 rounded-full border shrink-0',
                            isSelected ? 'border-primary bg-primary' : 'border-border',
                          ].join(' ')}
                          aria-hidden
                        />
                      )}
                      <span className="font-medium text-primary">{est.estimate_number}</span>
                      <StatusBadge domain="estimate" status={est.status} />
                    </div>
                    <div className="flex items-center gap-2 shrink-0">
                      {est.job ? (
                        // Idle-secondary, always-underlined text link - no minted link/brand
                        // cell reproduces this (link/brand is idle text-primary, underline
                        // only on hover). Deferred.
                        <button
                          type="button"
                          className="text-xs text-text-secondary underline"
                          onClick={(e) => {
                            e.stopPropagation();
                            onOpenChange(false);
                            navigate(`/jobs/${est.job!.id}`);
                          }}
                        >
                          {est.job.job_number} →
                        </button>
                      ) : (
                        <span className="tabular-nums text-sm">{formatCurrency(est.total_amount)}</span>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
            {convertible.length === 0 && (
              <p className="text-xs text-text-secondary">
                No approved estimate to convert yet. Approve an estimate first
                {canCreateEstimate ? ', or create a new one below.' : '.'}
              </p>
            )}
          </>
        )}

        <div className="flex items-center justify-between gap-3 pt-2">
          {canCreateEstimate ? (
            <Button variant="outline" size="sm" onClick={goCreateEstimate}>
              <FileText className="mr-2 h-4 w-4" /> New estimate
            </Button>
          ) : (
            <span />
          )}
          <div className="flex gap-2">
            <Button variant="outline" size="sm" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button
              variant="solid" tone="business"
              size="sm"
              disabled={!selectedId || isConverting}
              onClick={() => selectedId && onConvert(selectedId)}
            >
              <Briefcase className="mr-2 h-4 w-4" />
              {isConverting ? 'Creating…' : 'Create job'}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
