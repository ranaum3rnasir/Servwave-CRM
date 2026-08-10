import { useEffect, useRef, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import api from '@/lib/axios';
import { toast } from '@/components/ui/use-toast';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Checkbox } from '@/components/ui/checkbox';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { Loader2, Send, AlertTriangle, X, Lock } from 'lucide-react';
import { formatCurrency, extractApiError } from '@/lib/utils';
import { useOrganization, type PaymentMethod } from '@/lib/api/organization';
import { PAYMENT_METHOD_LABELS, PAYMENT_METHOD_ORDER } from '@/lib/payment-methods';
import { StripePaymentsBanner } from '@/components/payments/StripePaymentsBanner';
import { FormField } from '@/components/patterns/FormField';
import {
  resolveDeposit,
  amountFromPercent,
  percentFromAmount,
  round2,
  type DepositType,
} from '@/lib/deposit';

interface SendEstimateDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  estimateId: string;
  estimateNumber: string;
  totalAmount: number;
  customerEmail: string;
  alreadySent: boolean;
  sentAt?: string | null;
  // The estimate's own deposit override (Receipt Card). The send CHARGES this in preference to the
  // org defaults (backend resolveDepositAmount), so the preview has to read it or it shows one
  // number and bills another.
  depositType?: DepositType | null;
  depositValue?: number | string | null;
  // True once a send_config exists, i.e. the deposit has been billed and can no longer move.
  // Deliberately NOT derived from `alreadySent` (which is status === 'SENT'): a PENDING or WON
  // estimate is equally past its first send, and the Receipt Card gates on send_config too.
  depositFrozen?: boolean;
  // The deposit actually billed (send_config). Displayed verbatim once frozen - the real charged
  // figure outranks anything recomputed from the estimate's current totals.
  existingDepositAmount?: number | null;
  existingDepositPercentage?: number | null;
  onSuccess: () => void;
}

const DEFAULT_MESSAGE =
  'Thank you for your recent service inquiry with us. Click the link below to view your estimate.';

export function SendEstimateDialog({
  open,
  onOpenChange,
  estimateId,
  estimateNumber,
  totalAmount,
  customerEmail,
  alreadySent,
  sentAt,
  depositType,
  depositValue,
  depositFrozen = false,
  existingDepositAmount,
  existingDepositPercentage,
  onSuccess,
}: SendEstimateDialogProps) {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const { data: org } = useOrganization();
  const orgAcceptedMethods: PaymentMethod[] =
    (org?.accepted_payment_methods as PaymentMethod[] | undefined) ?? [];

  // #61/B8: the deposit the send will actually charge - the estimate's own deposit_type/
  // deposit_value override first, org defaults only as a fallback. This used to read the org
  // columns ALONE, so an estimate the Receipt Card had set to 70% under a 50% org default
  // previewed half of what it went on to bill.
  const resolvedDeposit = resolveDeposit(
    { deposit_type: depositType, deposit_value: depositValue, total_amount: totalAmount },
    org,
  );

  // The deposit is frozen at FIRST send: commitFirstSend writes send_config + the deposit invoice
  // once and a resend never revisits them. Editing on a resend would silently do nothing, so the
  // fields go read-only there rather than lying about being editable.
  const depositEditable = !depositFrozen;

  // What the two boxes start at: the billed figure when there is one, the resolved figure otherwise.
  const seedPercent = existingDepositPercentage ?? resolvedDeposit.percent;
  const seedAmount = round2(existingDepositAmount ?? resolvedDeposit.amount);

  const [messageBody, setMessageBody] = useState(DEFAULT_MESSAGE);
  const [depositRequired, setDepositRequired] = useState(true);
  // Editable deposit, seeded from the resolved figure. Raw strings so a cleared box stays cleared;
  // the two mirror each other on every parseable edit (see handleDepositPercentChange).
  const [depositPercent, setDepositPercent] = useState<string>(String(seedPercent));
  const [depositAmountInput, setDepositAmountInput] = useState<string>(String(seedAmount));
  const [depositMode, setDepositMode] = useState<DepositType>(resolvedDeposit.type);
  // §4.5 — pre-fill from org defaults. Dispatcher can only narrow this set.
  const [enabledMethods, setEnabledMethods] = useState<Set<PaymentMethod>>(
    new Set(orgAcceptedMethods),
  );

  // When org data loads after the dialog mounts, sync the pre-fill.
  useEffect(() => {
    setEnabledMethods(new Set(orgAcceptedMethods));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [org?.accepted_payment_methods?.join('|')]);
  const [ccEmails, setCcEmails] = useState<string[]>([]);
  const [ccInput, setCcInput] = useState<string>('');
  const [ccError, setCcError] = useState<string | null>(null);

  const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  const MAX_CC = 5;

  // One-off recipient (editable "To"). Seeded from the customer's saved email; the override is
  // request-scoped (sent as recipient_override) and never overwrites the saved customer record.
  const [recipientEmail, setRecipientEmail] = useState(customerEmail);
  useEffect(() => {
    setRecipientEmail(customerEmail);
  }, [customerEmail]);
  const recipientValid = EMAIL_RE.test(recipientEmail.trim());

  // Every open starts a fresh compose. The dialog stays mounted while closed, so without this a
  // cancelled edit survives: reopening still showed the one-off address typed the time before,
  // and since an override is only threaded when it DIFFERS from the saved customer email, that
  // stale value reads as the customer's own address while quietly addressing someone else.
  //
  // Adjusted during render rather than in an effect - React's documented way to reset state when
  // a prop changes. An effect would re-render the stale compose once before clearing it, which is
  // what `react-hooks/set-state-in-effect` (enforced on changed lines in CI) is guarding against.
  const [wasOpen, setWasOpen] = useState(open);
  if (open !== wasOpen) {
    setWasOpen(open);
    if (open) {
      setRecipientEmail(customerEmail);
      setCcEmails([]);
      setCcInput('');
      setCcError(null);
      setMessageBody(DEFAULT_MESSAGE);
      setDepositRequired(true);
      setDepositPercent(String(seedPercent));
      setDepositAmountInput(String(seedAmount));
      setDepositMode(resolvedDeposit.type);
      setEnabledMethods(new Set(orgAcceptedMethods));
    }
  }

  // Radix focuses the first tabbable child on open, which is the "Via SMS" lock - a non-feature
  // whose tooltip then opens on focus and covers the "To" label. Send the caret to the recipient
  // field instead: it is the first thing worth acting on, and it keeps the SMS explanation
  // reachable by Tab rather than deleting the affordance.
  const recipientInputRef = useRef<HTMLInputElement>(null);
  // Only thread an override when the user edited the address away from the saved customer email.
  const recipientOverride =
    recipientEmail.trim().toLowerCase() !== customerEmail.trim().toLowerCase()
      ? recipientEmail.trim()
      : undefined;

  const tryAddCc = (raw: string) => {
    const candidate = raw.trim().replace(/,$/, '').trim();
    if (!candidate) return;
    if (!EMAIL_RE.test(candidate)) {
      setCcError('Invalid email address');
      return;
    }
    if (ccEmails.includes(candidate) || candidate.toLowerCase() === customerEmail.toLowerCase()) {
      setCcError('Email already added');
      return;
    }
    if (ccEmails.length >= MAX_CC) {
      setCcError(`Maximum ${MAX_CC} CC emails`);
      return;
    }
    setCcEmails([...ccEmails, candidate]);
    setCcInput('');
    setCcError(null);
  };

  const removeCc = (email: string) => {
    setCcEmails(ccEmails.filter((e) => e !== email));
    setCcError(null);
  };

  // The % and the $ describe one deposit, so each edit mirrors into the other. Which box was
  // edited also decides how the deposit is STORED: a typed % stays a PERCENTAGE (it re-derives if
  // the line items change), a typed dollar figure stays FIXED. Persisting one mode for both would
  // silently flip the estimate's deposit type behind the Receipt Card that shows it.
  const handleDepositPercentChange = (raw: string) => {
    setDepositPercent(raw);
    setDepositMode('PERCENTAGE');
    const pct = parseFloat(raw);
    if (!Number.isNaN(pct)) setDepositAmountInput(String(amountFromPercent(totalAmount, pct)));
  };

  const handleDepositAmountChange = (raw: string) => {
    setDepositAmountInput(raw);
    setDepositMode('FIXED');
    const amt = parseFloat(raw);
    if (!Number.isNaN(amt)) setDepositPercent(String(percentFromAmount(totalAmount, amt)));
  };

  const depositAmount = round2(parseFloat(depositAmountInput) || 0);
  // Only write when the figure actually moved off what the estimate already resolves to - an
  // untouched dialog must not rewrite the estimate's deposit_type as a side effect of sending.
  const depositChanged = depositAmount !== resolvedDeposit.amount;
  // A deposit larger than the estimate, or a non-positive one, is not something the backend will
  // charge coherently - block the send rather than let it through to a confusing failure.
  const depositValid =
    !depositRequired || !depositEditable || (depositAmount > 0 && depositAmount <= round2(totalAmount));

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

  const canSend = (!depositRequired || enabledMethods.size > 0) && recipientValid && depositValid;

  const mutation = useMutation({
    mutationFn: async () => {
      // Persist the deposit BEFORE sending, through the same PATCH the Receipt Card uses. The send
      // endpoint takes no deposit argument - it re-derives the charge from the estimate row - so
      // the row is the single source of truth and this has to land first. A failure here throws
      // into onError and the send never happens: better a blocked send than one that bills a
      // different deposit than the one on screen.
      if (depositEditable && depositRequired && depositChanged) {
        await api.patch(`/api/estimates/${estimateId}`, {
          deposit_type: depositMode,
          deposit_value: depositMode === 'FIXED' ? depositAmount : parseFloat(depositPercent),
        });
      }

      const { data } = await api.post(`/api/estimates/${estimateId}/send`, {
        deposit_required: depositRequired,
        payment_methods: Array.from(enabledMethods),
        message_body: messageBody,
        ...(ccEmails.length > 0 ? { cc_emails: ccEmails } : {}),
        ...(recipientOverride ? { recipient_override: recipientOverride } : {}),
      });
      return data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['estimate', estimateId] });
      queryClient.invalidateQueries({ queryKey: ['estimates'] });
      onOpenChange(false);
      onSuccess();
      toast({ title: 'Estimate sent', description: `${estimateNumber} has been emailed to the customer.` });
    },
    onError: (err: unknown) => {
      const msg = (err as { response?: { data?: { error?: string } } })?.response?.data?.error || 'Failed to send estimate';
      toast({ title: 'Estimate not sent', description: msg, variant: 'destructive', duration: Infinity });
    },
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="max-w-md max-h-[90vh] overflow-y-auto"
        onOpenAutoFocus={(e) => {
          e.preventDefault();
          recipientInputRef.current?.focus();
        }}
      >
        <DialogHeader>
          <DialogTitle>Send Estimate</DialogTitle>
        </DialogHeader>

        <StripePaymentsBanner onSetup={() => navigate('/settings/payments')} />

        {/* Resend warning */}
        {alreadySent && (
          <div className="flex items-start gap-2 rounded-lg border border-warning-border bg-warning-surface p-3 text-sm text-warning-text">
            <AlertTriangle className="h-4 w-4 mt-0.5 shrink-0" />
            <span>
              This estimate was already sent
              {sentAt && ` on ${new Date(sentAt).toLocaleDateString('en-US')}`}.
              Sending again will deliver a new email to the customer.
            </span>
          </div>
        )}

        <Tabs defaultValue="email">
          <TabsList className="w-full">
            <TabsTrigger value="email" className="flex-1">
              Via Email
            </TabsTrigger>
            {/* R4 (2026-07-21) — SMS lock upgraded to the AddStepButton pattern (workflows/
                AddStepButton.tsx): greyed + a "Coming soon" badge + an explanatory tooltip on
                hover/focus, instead of a bare disabled tab with no reason given. A plain element,
                not a real TabsPrimitive.Trigger — Radix's `disabled` sets pointer-events:none
                (tabs.tsx's `disabled:pointer-events-none`), which would silently kill the hover
                that the tooltip depends on. There's no TabsContent for "sms" to switch to yet. */}
            <TooltipProvider>
              <Tooltip>
                <TooltipTrigger asChild>
                  <div
                    role="tab"
                    aria-disabled="true"
                    aria-selected="false"
                    tabIndex={0}
                    className="-mb-px inline-flex flex-1 cursor-not-allowed items-center justify-center gap-1.5 whitespace-nowrap border-b-2 border-transparent pb-2.5 text-sm font-semibold text-text-secondary opacity-60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2"
                  >
                    Via SMS
                    <span className="inline-flex items-center gap-1 rounded-pill bg-background-light px-1.5 py-0.5 text-[10px] font-semibold text-text-secondary">
                      <Lock className="h-2.5 w-2.5" aria-hidden />
                      Coming Soon
                    </span>
                  </div>
                </TooltipTrigger>
                <TooltipContent side="bottom">
                  Sending estimates by text is coming soon — you&apos;ll be able to deliver this one over SMS once it&apos;s available.
                </TooltipContent>
              </Tooltip>
            </TooltipProvider>
          </TabsList>

          <TabsContent value="email" className="space-y-4 mt-4">
            {/* To (editable — one-off recipient, not saved to the customer) */}
            <div className="space-y-1.5">
              <Label htmlFor="recipient-email">To</Label>
              <Input
                id="recipient-email"
                ref={recipientInputRef}
                type="email"
                value={recipientEmail}
                onChange={(e) => setRecipientEmail(e.target.value)}
              />
              {!recipientValid && (
                <p className="text-xs text-danger">Enter a valid email address</p>
              )}
            </div>

            {/* CC (one-time recipients, not saved) */}
            <div className="space-y-1.5">
              <Label htmlFor="cc-emails">
                CC{' '}
                <span className="text-xs font-normal text-text-secondary">
                  (optional, not saved to customer)
                </span>
              </Label>
              {ccEmails.length > 0 && (
                <div className="flex flex-wrap gap-1.5">
                  {ccEmails.map((email) => (
                    <span
                      key={email}
                      className="inline-flex items-center gap-1 rounded-full bg-neutral-surface px-2.5 py-1 text-xs text-text-primary"
                    >
                      {email}
                      {/* chip close-X affordance - not Button-shaped, left raw. */}
                      <button
                        type="button"
                        onClick={() => removeCc(email)}
                        className="text-text-secondary hover:text-text-primary"
                        aria-label={`Remove ${email}`}
                      >
                        <X className="h-3 w-3" />
                      </button>
                    </span>
                  ))}
                </div>
              )}
              <Input
                id="cc-emails"
                type="email"
                placeholder="Add email and press Enter"
                value={ccInput}
                onChange={(e) => {
                  const v = e.target.value;
                  setCcError(null);
                  if (v.endsWith(',')) {
                    tryAddCc(v);
                  } else {
                    setCcInput(v);
                  }
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === 'Tab') {
                    if (ccInput.trim()) {
                      e.preventDefault();
                      tryAddCc(ccInput);
                    }
                  } else if (e.key === 'Backspace' && !ccInput && ccEmails.length > 0) {
                    const last = ccEmails[ccEmails.length - 1];
                    if (last) removeCc(last);
                  }
                }}
                onBlur={() => {
                  if (ccInput.trim()) tryAddCc(ccInput);
                }}
                disabled={ccEmails.length >= MAX_CC}
              />
              {ccError && <p className="text-xs text-danger">{ccError}</p>}
            </div>

            {/* Message */}
            <div className="space-y-1.5">
              <Label>Message</Label>
              <Textarea
                value={messageBody}
                onChange={(e) => setMessageBody(e.target.value)}
                rows={3}
              />
            </div>

            {/* Deposit settings */}
            <div className="space-y-3 border-t pt-4">
              <div className="flex items-center justify-between">
                <Label htmlFor="deposit-toggle" className="text-sm font-semibold">
                  Require deposit
                </Label>
                <Switch
                  id="deposit-toggle"
                  checked={depositRequired}
                  onCheckedChange={setDepositRequired}
                />
              </div>

              {depositRequired && (
                <>
                  <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                    <FormField label="Deposit %" htmlFor="send-deposit-pct">
                      <Input
                        id="send-deposit-pct"
                        type="number"
                        min={0}
                        max={100}
                        step="0.5"
                        value={depositPercent}
                        disabled={!depositEditable}
                        onChange={(e) => handleDepositPercentChange(e.target.value)}
                      />
                    </FormField>
                    <FormField
                      label="Deposit amount"
                      htmlFor="send-deposit-amount"
                      hint={
                        depositEditable
                          ? `Total estimate: ${formatCurrency(totalAmount)}`
                          : 'Set when this estimate was first sent'
                      }
                    >
                      <Input
                        id="send-deposit-amount"
                        type="number"
                        min={0}
                        step="0.01"
                        value={depositAmountInput}
                        disabled={!depositEditable}
                        onChange={(e) => handleDepositAmountChange(e.target.value)}
                      />
                    </FormField>
                  </div>

                  {depositEditable && !depositValid && (
                    <p className="text-sm text-danger">
                      Enter a deposit between {formatCurrency(0.01)} and {formatCurrency(totalAmount)}.
                    </p>
                  )}

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
                              id={`pm-${key}`}
                              checked={enabledMethods.has(key)}
                              onCheckedChange={() => toggleMethod(key)}
                            />
                            {/* Checkbox-row label (sits beside, not above, its control) - not a
                                FormField-shape site, left raw. */}
                            <label
                              htmlFor={`pm-${key}`}
                              className="text-sm font-medium cursor-pointer select-none"
                            >
                              {PAYMENT_METHOD_LABELS[key]}
                            </label>
                          </div>
                        </div>
                      ))}

                    {orgAcceptedMethods.length === 0 && (
                      <p className="text-xs text-danger">
                        No payment methods accepted by your organization. Update
                        them in Organization Settings.
                      </p>
                    )}

                    {orgAcceptedMethods.length > 0 && enabledMethods.size === 0 && (
                      <p className="text-xs text-danger">
                        Select at least one payment method
                      </p>
                    )}
                  </div>
                </>
              )}
            </div>

            {/* Error */}
            {mutation.isError && (
              <p className="text-sm text-danger">
                {extractApiError(mutation.error, 'Failed to send estimate')}
              </p>
            )}

            {/* Actions */}
            <div className="flex justify-end gap-3 border-t pt-4">
              <Button variant="outline" onClick={() => onOpenChange(false)}>
                Cancel
              </Button>
              <Button
                onClick={() => mutation.mutate()}
                disabled={!canSend || mutation.isPending}
              >
                {mutation.isPending ? (
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                ) : (
                  <Send className="mr-2 h-4 w-4" />
                )}
                {mutation.isPending
                  ? 'Sending...'
                  : alreadySent
                    ? `Resend ${estimateNumber}`
                    : `Send ${estimateNumber}`}
              </Button>
            </div>
          </TabsContent>
        </Tabs>
      </DialogContent>
    </Dialog>
  );
}
