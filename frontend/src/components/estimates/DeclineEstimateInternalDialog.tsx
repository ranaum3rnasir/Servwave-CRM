import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { setEstimateStatusTo } from '@/lib/api/estimates';
import { ESTIMATE_STATUS } from '@/constants/estimateStatus';
import { extractApiError } from '@/lib/utils';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { FormField } from '@/components/patterns/FormField';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';

// R4 (2026-07-21) — port-plan §3.2's `markdeclined`/`doreason`. Unlike the public decline route
// (free-text, optional), a staff-recorded internal decline requires a real LostReason enum value —
// the report/conversion-funnel breakdown (estimate-conversion-data.ts) reads this field, so a
// staff decline with no reason would silently under-count every category but "no data".
const LOST_REASON_LABELS: Record<string, string> = {
  PRICE: 'Price',
  TIMING: 'Timing',
  COMPETITOR: 'Went with a competitor',
  NO_RESPONSE: 'Customer stopped responding',
  OTHER: 'Other',
};

interface DeclineEstimateInternalDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  estimateId: string;
  estimateNumber: string;
}

export function DeclineEstimateInternalDialog({
  open,
  onOpenChange,
  estimateId,
  estimateNumber,
}: DeclineEstimateInternalDialogProps) {
  const queryClient = useQueryClient();
  const [reason, setReason] = useState<string>('');

  const mutation = useMutation({
    // Spec B1 — routes through the free status setter, not POST /decline-internal. That endpoint
    // still gates on SENT/PENDING, so declining a won estimate (legal now) would 400 there. The
    // setter raises the same `estimate.declined` verb and fires the same ESTIMATE_DECLINED
    // automation trigger, and it clears the stamps of whichever status is being left.
    mutationFn: () => setEstimateStatusTo(estimateId, ESTIMATE_STATUS.DECLINED, { lost_reason: reason }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['estimate', estimateId] });
      queryClient.invalidateQueries({ queryKey: ['estimates'] });
      onOpenChange(false);
      setReason('');
    },
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle>Decline {estimateNumber}</DialogTitle>
          <DialogDescription>
            Record a verbal or off-platform loss. This does not notify the customer.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          {/* Render prop, not a plain element child: FormField's cloneElement
              path would hand the generated id to `Select` (Radix's Root),
              which renders no DOM node of its own and drops it - leaving the
              label's htmlFor pointing at nothing. The trigger is the real
              labelable control, so it takes the id. This is FormField's
              documented compound-control escape hatch, no new prop. */}
          <FormField label="Reason *">
            {(fieldProps) => (
              <Select value={reason} onValueChange={setReason}>
                <SelectTrigger {...fieldProps}>
                  <SelectValue placeholder="Why did this estimate lose?" />
                </SelectTrigger>
                <SelectContent>
                  {Object.entries(LOST_REASON_LABELS).map(([value, label]) => (
                    <SelectItem key={value} value={value}>
                      {label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
          </FormField>

          {mutation.error && (
            <p className="text-sm text-danger">
              {extractApiError(mutation.error, 'Failed to decline estimate')}
            </p>
          )}

          <div className="flex justify-end gap-3">
            <Button variant="outline" onClick={() => onOpenChange(false)}>
              Keep Open
            </Button>
            <Button
              variant="solid" tone="danger"
              onClick={() => mutation.mutate()}
              disabled={!reason || mutation.isPending}
            >
              {mutation.isPending ? 'Declining...' : 'Decline Estimate'}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
