import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { cancelLead } from '@/lib/api/leads';
import { extractApiError } from '@/lib/utils';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { FormField } from '@/components/patterns/FormField';

interface CancelLeadDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  leadId: string;
}

/**
 * Administratively cancels a lead (entity-redesign §3). Distinct from Mark-Lost:
 * cancel = an administrative void (e.g. duplicate, created in error), whereas
 * mark-lost captures sales analytics. Backend cancelLeadSchema requires a reason.
 */
export function CancelLeadDialog({ open, onOpenChange, leadId }: CancelLeadDialogProps) {
  const queryClient = useQueryClient();
  const [reason, setReason] = useState('');

  const mutation = useMutation({
    mutationFn: () => cancelLead(leadId, { cancelled_reason: reason }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['lead', leadId] });
      queryClient.invalidateQueries({ queryKey: ['leads'] });
      onOpenChange(false);
      setReason('');
    },
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle>Cancel Lead</DialogTitle>
          <DialogDescription>
            Administratively void this lead. Use this for duplicates or leads created in
            error. Please provide a reason.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <FormField label="Reason *">
            <Textarea
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              rows={3}
              placeholder="Why is this lead being cancelled?"
            />
          </FormField>

          {mutation.error && (
            <p className="text-sm text-danger">
              {extractApiError(mutation.error, 'Failed to cancel lead')}
            </p>
          )}

          <div className="flex justify-end gap-3">
            <Button variant="outline" onClick={() => onOpenChange(false)}>
              Close
            </Button>
            <Button
              variant="solid" tone="danger"
              onClick={() => mutation.mutate()}
              disabled={!reason.trim() || mutation.isPending}
            >
              {mutation.isPending ? 'Cancelling...' : 'Cancel Lead'}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
