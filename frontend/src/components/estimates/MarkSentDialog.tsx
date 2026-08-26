import { useEffect, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { markEstimateSent } from '@/lib/api/estimates';
import { toast } from '@/components/ui/use-toast';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Checkbox } from '@/components/ui/checkbox';
import { Loader2, FileCheck } from 'lucide-react';
import { formatCurrency, extractApiError } from '@/lib/utils';
import { useOrganization, type PaymentMethod } from '@/lib/api/organization';
import { PAYMENT_METHOD_LABELS, PAYMENT_METHOD_ORDER } from '@/lib/payment-methods';
import { resolveDeposit, type DepositType } from '@/lib/deposit';

interface MarkSentDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  estimateId: string;
  estimateNumber: string;
  totalAmount: number;
  // The estimate's own deposit override (Receipt Card). markSent() runs the same commitFirstSend
  // ceremony as send(), so it charges resolveDepositAmount's answer - which prefers this over the
  // org defaults. The preview has to read it or it shows one number and bills another.
  depositType?: DepositType | null;
  depositValue?: number | string | null;
  onSuccess: () => void;
}

const CC_SURCHARGE_RATE = 0.035;

/**
 * R4 (2026-07-21) — port-plan §3.2's `marksent`/`domarksent`: the estimate was delivered outside
 * the app (in person, a phone call, a printed copy), so this stamps SENT and starts the deposit
 * clock without emailing anything. Body shape mirrors `send()` exactly (deposit_required/
 * payment_methods/message_body) because the backend runs the identical commitFirstSend ceremony —
 * deliberately NOT a lighter form, so the deposit policy can't be dodged by picking this over Send.
 */
export function MarkSentDialog({
  open,
  onOpenChange,
  estimateId,
  estimateNumber,
  totalAmount,
  depositType,
  depositValue,
  onSuccess,
}: MarkSentDialogProps) {
  const queryClient = useQueryClient();
  const { data: org } = useOrganization();
  const orgAcceptedMethods: PaymentMethod[] =
    (org?.accepted_payment_methods as PaymentMethod[] | undefined) ?? [];

  const resolvedDeposit = resolveDeposit(
    { deposit_type: depositType, deposit_value: depositValue, total_amount: totalAmount },
    org,
  );

  const [depositRequired, setDepositRequired] = useState(true);
  const [enabledMethods, setEnabledMethods] = useState<Set<PaymentMethod>>(
    new Set(orgAcceptedMethods),
  );
  const [note, setNote] = useState('');

  useEffect(() => {
    setEnabledMethods(new Set(orgAcceptedMethods));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [org?.accepted_payment_methods?.join('|')]);

  const depositAmount = resolvedDeposit.amount;
  const ccTotal = depositAmount * (1 + CC_SURCHARGE_RATE);
  const ccFee = ccTotal - depositAmount;

  const toggleMethod = (key: PaymentMethod) => {
    setEnabledMethods((prev) => {
      const next = new Set(prev);
      if (next.has(key)) {
        next.delete(key);
      } else {
        next.add(key);
      }
      return next;
    });
  };

  const canSubmit = !depositRequired || enabledMethods.size > 0;

  const mutation = useMutation({
    mutationFn: () =>
      markEstimateSent(estimateId, {
        deposit_required: depositRequired,
        payment_methods: Array.from(enabledMethods),
        ...(note.trim() ? { message_body: note.trim() } : {}),
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['estimate', estimateId] });
      queryClient.invalidateQueries({ queryKey: ['estimates'] });
      onOpenChange(false);
      onSuccess();
      toast({ title: 'Marked sent', description: `${estimateNumber} is now Sent — no email was delivered.` });
    },
    onError: (err: unknown) => {
      toast({ title: 'Could not mark as sent', description: extractApiError(err, 'Failed to mark estimate as sent'), variant: 'destructive', duration: Infinity });
    },
  });

  // The mutation outlives any one opening of the dialog, so a failed attempt leaves `mutation.error`
  // set and the next open renders last time's refusal as if it were about this attempt.
  useEffect(() => {
    if (open) mutation.reset();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Mark {estimateNumber} as Sent</DialogTitle>
          <DialogDescription>
            Use this when the estimate was delivered outside the app — no email goes out.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="space-y-1.5">
            <Label>Note (internal)</Label>
            <Textarea
              value={note}
              onChange={(e) => setNote(e.target.value)}
              rows={2}
              placeholder="How was it delivered? (optional)"
            />
          </div>

          <div className="space-y-3 border-t pt-4">
            <div className="flex items-center justify-between">
              <Label htmlFor="mark-sent-deposit-toggle" className="text-sm font-semibold">
                Require deposit
              </Label>
              <Switch
                id="mark-sent-deposit-toggle"
                checked={depositRequired}
                onCheckedChange={setDepositRequired}
              />
            </div>

            {depositRequired && (
              <>
                <p className="text-sm text-text-secondary">
                  {resolvedDeposit.percent}% ={' '}
                  <span className="font-medium tabular-nums text-text-primary">
                    {formatCurrency(depositAmount)}
                  </span>
                </p>

                <div className="space-y-2">
                  <Label className="text-xs uppercase tracking-wide">
                    Payment methods
                  </Label>

                  {PAYMENT_METHOD_ORDER
                    .filter((key) => orgAcceptedMethods.includes(key))
                    .map((key) => (
                      <div key={key} className="space-y-0.5">
                        <div className="flex items-center gap-2">
                          <Checkbox
                            id={`mark-sent-pm-${key}`}
                            checked={enabledMethods.has(key)}
                            onCheckedChange={() => toggleMethod(key)}
                          />
                          {/* Checkbox-row label (sits beside, not above, its control) - not a
                              FormField-shape site, left raw. */}
                          <label
                            htmlFor={`mark-sent-pm-${key}`}
                            className="text-sm font-medium cursor-pointer select-none"
                          >
                            {PAYMENT_METHOD_LABELS[key]}
                          </label>
                        </div>
                        {key === 'CARD' && enabledMethods.has('CARD') && (
                          <p className="ml-6 text-xs text-text-secondary tabular-nums">
                            {formatCurrency(ccTotal)} (incl. {formatCurrency(ccFee)} processing fee)
                          </p>
                        )}
                      </div>
                    ))}

                  {orgAcceptedMethods.length === 0 && (
                    <p className="text-xs text-danger">
                      No payment methods accepted by your organization. Update them in Organization Settings.
                    </p>
                  )}
                  {orgAcceptedMethods.length > 0 && enabledMethods.size === 0 && (
                    <p className="text-xs text-danger">Select at least one payment method</p>
                  )}
                </div>
              </>
            )}
          </div>

          {mutation.isError && (
            <p className="text-sm text-danger">
              {extractApiError(mutation.error, 'Failed to mark estimate as sent')}
            </p>
          )}

          <div className="flex justify-end gap-3 border-t pt-4">
            <Button variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button
              onClick={() => mutation.mutate()}
              disabled={!canSubmit || mutation.isPending}
            >
              {mutation.isPending ? (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              ) : (
                <FileCheck className="mr-2 h-4 w-4" />
              )}
              {mutation.isPending ? 'Marking...' : 'Mark as Sent'}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
