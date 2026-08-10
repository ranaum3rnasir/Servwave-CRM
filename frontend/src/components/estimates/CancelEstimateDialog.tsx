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

interface CancelEstimateDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  estimateId: string;
}

export function CancelEstimateDialog({ open, onOpenChange, estimateId }: CancelEstimateDialogProps) {
  const queryClient = useQueryClient();
  const [reason, setReason] = useState('');

  const mutation = useMutation({
    mutationFn: async () => {
      const { data } = await api.post(`/api/estimates/${estimateId}/cancel`, { cancelled_reason: reason });
      return data;
    },
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
          {/* D14 (2026-07-21) — relabeled "Archive" (was "Cancel"). The endpoint
              (POST .../cancel), the cancelled_reason field, and the estimate.cancelled verb are
              unchanged — this is copy-only. */}
          <DialogTitle>Archive Estimate</DialogTitle>
          <DialogDescription>
            This action cannot be undone. Please provide a reason.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <FormField label="Reason *">
            <Textarea
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              rows={3}
              placeholder="Why is this estimate being archived?"
            />
          </FormField>

          {mutation.error && (
            <p className="text-sm text-danger">
              {extractApiError(mutation.error, 'Failed to archive estimate')}
            </p>
          )}

          <div className="flex justify-end gap-3">
            <Button variant="outline" onClick={() => onOpenChange(false)}>
              Keep Open
            </Button>
            <Button
              variant="solid" tone="danger"
              onClick={() => mutation.mutate()}
              disabled={!reason.trim() || mutation.isPending}
            >
              {mutation.isPending ? 'Archiving...' : 'Archive Estimate'}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
