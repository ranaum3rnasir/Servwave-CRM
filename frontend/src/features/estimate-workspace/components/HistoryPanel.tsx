import { useQuery } from '@tanstack/react-query';
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription } from '@/components/ui/sheet';
import { Skeleton } from '@/components/ui/skeleton';
import { getEstimateHistory } from '@/lib/api/estimates';

interface AuditEvent {
  id: string;
  action: string;
  actor_email?: string | null;
  metadata?: Record<string, unknown> | null;
  created_at: string;
}

// action -> a short, human sentence. Falls back to the raw action string for anything unlisted.
const ACTION_LABELS: Record<string, string> = {
  'estimate.created': 'Estimate created',
  'estimate.updated': 'Estimate updated',
  'estimate.sent': 'Sent to customer',
  'estimate.approved': 'Approved by customer',
  'estimate.declined': 'Declined by customer',
  'estimate.deposit_paid': 'Deposit paid',
  'estimate.deposit_waived': 'Deposit waived',
  // R4 (2026-07-21) — lifecycle verbs (port-plan §3.2/§10.3).
  'estimate.marked_sent': 'Marked sent (delivered outside the app)',
  'estimate.status_corrected': 'Status corrected',
  'estimate.approved_internal': 'Approved internally (verbal win)',
  'estimate.declined_internal': 'Declined internally',
  'estimate.approval_voided': 'Approval voided',
  'estimate.modified_after_send': 'Modified after send — flagged, re-send required',
  'estimate.superseded': 'Superseded by a revision',
  'estimate.revised_from': 'Created as a revision',
  'estimate.scope_preset_saved': 'Scope saved as a reusable preset',
  'estimate.ai_scope_drafted': 'AI scope-of-work draft generated',
  'estimate.deleted': 'Deleted',
};

/** §G — History tab: field-level diffs from the real audit_logs trail (PR #295), read-only. */
export function HistoryPanel({ open, onClose, estimateId }: { open: boolean; onClose: () => void; estimateId: string }) {
  const { data, isLoading } = useQuery<{ events: AuditEvent[] }>({
    queryKey: ['estimate-history', estimateId],
    queryFn: () => getEstimateHistory(estimateId),
    enabled: open && !!estimateId,
  });

  return (
    <Sheet open={open} onOpenChange={(o) => !o && onClose()}>
      <SheetContent className="w-full sm:max-w-md">
        <SheetHeader>
          <SheetTitle>History</SheetTitle>
          <SheetDescription className="sr-only">Audit history for this estimate</SheetDescription>
        </SheetHeader>
        <div className="mt-4 space-y-3">
          {isLoading && (
            <>
              <Skeleton className="h-12 w-full" />
              <Skeleton className="h-12 w-full" />
              <Skeleton className="h-12 w-full" />
            </>
          )}
          {!isLoading && (data?.events.length ?? 0) === 0 && (
            <p className="text-sm text-text-secondary">No activity recorded yet.</p>
          )}
          {(data?.events ?? []).map((ev) => (
            <div key={ev.id} className="border-b border-border pb-2.5">
              <p className="text-sm font-semibold text-text-primary">{ACTION_LABELS[ev.action] ?? ev.action}</p>
              <p className="text-xs text-text-secondary">
                {new Date(ev.created_at).toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' })}
                {ev.actor_email && ` · ${ev.actor_email}`}
              </p>
            </div>
          ))}
        </div>
      </SheetContent>
    </Sheet>
  );
}
