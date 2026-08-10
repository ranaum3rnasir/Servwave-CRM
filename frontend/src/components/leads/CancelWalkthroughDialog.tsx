import { useState } from 'react';
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
import { Textarea } from '@/components/ui/textarea';
import { FormField } from '@/components/patterns/FormField';

interface CancelWalkthroughDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  leadId: string;
}

export function CancelWalkthroughDialog({ open, onOpenChange, leadId }: CancelWalkthroughDialogProps) {
  const queryClient = useQueryClient();
  const [reason, setReason] = useState('');

  const mutation = useMutation({
    mutationFn: async () => {
      const { data } = await api.post(`/api/leads/${leadId}/walkthrough/cancel`, {
        cancelled_reason: reason.trim(),
      });
      return data;
    },
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
          <DialogTitle>Cancel Walkthrough</DialogTitle>
          <DialogDescription>
            This will cancel the scheduled walkthrough. Please provide a reason.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          {/* The Textarea's own `mt-1` seam is gone: FormField owns the
              label-to-control gap now (its default 1.5 / 6px), so keeping a
              margin here would stack on top of it. */}
          <FormField label="Reason *">
            <Textarea
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              rows={3}
              placeholder="Why is this walkthrough being cancelled?"
            />
          </FormField>

          {mutation.error && (
            <p className="text-sm text-danger">
              {extractApiError(mutation.error, 'Failed to cancel walkthrough')}
            </p>
          )}

          <div className="flex justify-end gap-3">
            <Button variant="outline" onClick={() => onOpenChange(false)}>
              Back
            </Button>
            <Button
              variant="solid" tone="danger"
              onClick={() => mutation.mutate()}
              disabled={!reason.trim() || mutation.isPending}
            >
              {mutation.isPending ? 'Cancelling...' : 'Cancel Walkthrough'}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
