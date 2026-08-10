import { useState, useEffect, useRef, useCallback } from 'react';
import { useParams, useSearchParams } from 'react-router-dom';
import SignatureCanvas from 'react-signature-canvas';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { Heading } from '@/components/ui/heading';
import {
  CheckCircle2,
  XCircle,
  Loader2,
  Clock,
  CreditCard,
  Landmark,
  Banknote,
  Wallet,
  AlertTriangle,
  ChevronLeft,
} from 'lucide-react';
import { formatCurrency, formatPhone } from '@/lib/utils';
import { safeHref } from '@/lib/safe-href';
import { customerDisplayName } from '@/lib/customer-name';
import { defaultBrandColor } from '@/lib/branding';
import { EstimateDocumentView } from '@/components/estimates/EstimateDocumentView';
import { ESTIMATE_STATUS } from '@/constants/estimateStatus';

// ─── Types ──────────────────────────────────────────

interface PublicLineItem {
  id: string;
  sequence: number;
  description: string;
  quantity: number;
  unit_price: number;
  is_taxable: boolean;
  line_total: number;
  item_type?: string;
  discount_type?: string | null;
  discount_value?: number | null;
  discount_amount?: number | null;
  price_book_item?: { image_url?: string | null };
}

interface PublicInvoice {
  id: string;
  status: string;
  total_amount: number;
  amount_due: number;
  public_token?: string | null;
}

interface PublicOrganization {
  name: string;
  logo_url?: string | null;
  brand_color?: string | null;
  email?: string | null;
  phone?: string | null;
  website?: string | null;
  estimate_terms?: string | null;
}

interface PublicEstimate {
  id: string;
  estimate_number: string;
  status: string;
  scope_notes?: string;
  tax_rate: number;
  subtotal: number;
  tax_amount: number;
  total_amount: number;
  discount_type?: string | null;
  discount_value?: number | null;
  discount_name?: string | null;
  discount_amount?: number | null;
  valid_until?: string;
  sent_at?: string;
  approved_at?: string;
  declined_at?: string;
  signature_data?: string | null;
  signature_at?: string | null;
  invoices?: PublicInvoice[];
  terms_accepted?: boolean | null;   // #21
  terms_accepted_at?: string | null; // #21
  send_config?: {
    deposit_required: boolean;
    deposit_percentage?: number;
    deposit_amount?: number;
    payment_methods: string[];
    message_body?: string | null;
  } | null;
  lead: {
    customer: { first_name: string; last_name: string; company_name?: string | null };
  } | null;
  customer?: { first_name: string; last_name: string; company_name?: string | null } | null;
  line_items: PublicLineItem[];
  organization?: PublicOrganization | null;
}

// ─── Helpers ────────────────────────────────────────

const METHOD_LABELS: Record<string, string> = {
  CARD: 'Credit/Debit Card',
  EXTERNAL_CARD: 'Credit/Debit Card',  // collapsed to one customer-facing label
  CHECK: 'Check',
  BANK_TRANSFER: 'Bank Transfer (ACH)',
  CASH: 'Cash',
  // R5b (2026-07-22) — D3.
  ZELLE: 'Zelle',
  VENMO: 'Venmo',
  CASH_APP: 'Cash App',
  OTHER: 'Other',
};

const METHOD_ICONS: Record<string, typeof CreditCard> = {
  CARD: CreditCard,
  EXTERNAL_CARD: CreditCard,
  CHECK: Banknote,
  BANK_TRANSFER: Landmark,
  CASH: Wallet,
  // R5b — peer-to-peer apps share Wallet, same "collapse to one icon" precedent as CARD above.
  ZELLE: Wallet,
  VENMO: Wallet,
  CASH_APP: Wallet,
  OTHER: Wallet,
};

const INSTRUCTION_KEYS: Record<string, string> = {
  CHECK: 'check',
  BANK_TRANSFER: 'bank_transfer',
  CASH: 'cash',
};

function formatMethodLabel(method: string): string {
  return METHOD_LABELS[method] || method;
}

// §4.5 — public page collapses CARD + EXTERNAL_CARD into a single Credit Card
// button. CARD always wins when both are present; the surviving token is what
// the controller routes on (Stripe vs call-us).
function collapseCardMethods(methods: string[]): string[] {
  const out: string[] = [];
  let seenCard = false;
  for (const m of methods) {
    if (m === 'CARD' || m === 'EXTERNAL_CARD') {
      if (seenCard) continue;
      seenCard = true;
      out.push(methods.includes('CARD') ? 'CARD' : 'EXTERNAL_CARD');
    } else {
      out.push(m);
    }
  }
  return out;
}

// ─── Component ──────────────────────────────────────

export default function PublicEstimatePage() {
  const { id } = useParams<{ id: string }>();
  const [searchParams, setSearchParams] = useSearchParams();
  const token = searchParams.get('token');
  const paymentParam = searchParams.get('payment');

  // Core state
  const [estimate, setEstimate] = useState<PublicEstimate | null>(null);
  const [termsAgreed, setTermsAgreed] = useState(false);
  const sigCanvasRef = useRef<SignatureCanvas>(null);
  const sigContainerRef = useRef<HTMLDivElement>(null);
  const [canvasDims, setCanvasDims] = useState({ width: 600, height: 128 });
  const [sigDrawn, setSigDrawn] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [actionLoading, setActionLoading] = useState(false);

  // Deposit / payment state
  const [paymentInstructions, setPaymentInstructions] = useState<Record<string, string>>({});
  const [isExpired, setIsExpired] = useState(false);
  const [selectedMethod, setSelectedMethod] = useState<string | null>(null);
  const [confirmDecline, setConfirmDecline] = useState(false);
  const [paymentBanner, setPaymentBanner] = useState<{ type: 'success' | 'warning'; message: string } | null>(null);
  // Slice 4 (card service fee) — display-only preview computed server-side (D8), off the deposit total.
  const [serviceFeePreview, setServiceFeePreview] = useState(0);

  // ─── Fetch estimate ───────────────────────────────

  const fetchEstimate = useCallback(async () => {
    if (!token) return;
    try {
      const res = await fetch(`${import.meta.env.VITE_API_URL || ''}/api/estimates/${id}/public?token=${encodeURIComponent(token)}`);
      if (!res.ok) throw new Error('Estimate not found');
      const data = await res.json();
      setEstimate({ ...data.estimate, organization: data.organization ?? null });
      setPaymentInstructions(data.payment_instructions || {});
      setIsExpired(data.expired || false);
      setServiceFeePreview(Number(data.service_fee_preview) || 0);
    } catch {
      setError('This estimate is no longer available.');
    }
  }, [id, token]);

  useEffect(() => {
    if (!token) {
      setError('Invalid link — token missing');
      setLoading(false);
      return;
    }

    fetchEstimate().finally(() => setLoading(false));
  }, [token, fetchEstimate]);

  // Handle Stripe return params
  useEffect(() => {
    if (!paymentParam) return;
    if (paymentParam === 'success') {
      setPaymentBanner({ type: 'success', message: 'Payment received! Your estimate has been approved.' });
      fetchEstimate();
    } else if (paymentParam === 'cancelled') {
      setPaymentBanner({ type: 'warning', message: 'Payment was not completed. You can try again below.' });
      fetchEstimate();
    }
    // Clear the query param so refresh doesn't re-trigger
    const newParams = new URLSearchParams(searchParams);
    newParams.delete('payment');
    setSearchParams(newParams, { replace: true });
  }, [paymentParam]); // eslint-disable-line react-hooks/exhaustive-deps

  // Sync canvas pixel buffer to rendered container size
  useEffect(() => {
    const container = sigContainerRef.current;
    if (!container) return;

    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (!entry) return;
      const { width } = entry.contentRect;
      if (width <= 0) return;
      const ratio = window.devicePixelRatio || 1;
      setCanvasDims({
        width: Math.floor(width * ratio),
        height: Math.floor(128 * ratio),
      });
      setSigDrawn(false);
    });

    observer.observe(container);
    return () => observer.disconnect();
  }, []);

  // ─── Derived state ────────────────────────────────

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background-light">
        <Loader2 className="h-8 w-8 animate-spin text-text-soft" />
      </div>
    );
  }

  if (error && !estimate) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background-light">
        <Card padding="lg" className="max-w-md text-center">
          <XCircle className="h-12 w-12 text-text-soft mx-auto mb-4" />
          <Heading level={2} scale="lg" className="mb-2">Unavailable</Heading>
          <p className="text-sm text-text-secondary">{error}</p>
        </Card>
      </div>
    );
  }

  if (!estimate) return null;

  const isActionable = estimate.status === 'SENT' && !isExpired;
  const isPending = estimate.status === 'PENDING';
  const isApproved = estimate.status === ESTIMATE_STATUS.WON;
  const isDeclined = estimate.status === 'DECLINED';
  const isCancelled = estimate.status === ESTIMATE_STATUS.ARCHIVED;
  const depositInvoice = estimate.invoices?.[0];
  const depositRequired = !!(estimate.send_config?.deposit_required && depositInvoice);
  const depositAmount = estimate.send_config?.deposit_amount
    ? Number(estimate.send_config.deposit_amount)
    : (depositInvoice ? Number(depositInvoice.total_amount) : 0);
  const availableMethods = estimate.send_config?.payment_methods || [];
  const needsPayment = depositRequired && sigDrawn;
  const approveDisabled = !sigDrawn || (!!(estimate?.organization?.estimate_terms) && !termsAgreed) || actionLoading;

  // ─── Actions ──────────────────────────────────────

  const handleApprove = async (paymentMethod: string | null) => {
    if (sigCanvasRef.current?.isEmpty()) {
      setError('Please draw your signature before approving.');
      return;
    }
    setActionLoading(true);
    try {
      const signatureData = sigCanvasRef.current?.toDataURL('image/png');
      const body: Record<string, unknown> = { payment_method: paymentMethod };
      if (signatureData && sigDrawn) {
        body.signature_data = signatureData;
      }
      body.terms_accepted = termsAgreed;   // #21 — server now requires this when terms exist

      const res = await fetch(`${import.meta.env.VITE_API_URL || ''}/api/estimates/${id}/approve?token=${encodeURIComponent(token!)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || 'Action failed');
      }
      const data = await res.json();

      // If Stripe checkout URL returned, redirect
      if (data.checkout_url) {
        window.location.href = data.checkout_url;
        return;
      }

      setEstimate(prev => ({ ...data.estimate, organization: prev?.organization ?? null }));
      setSelectedMethod(null);
    } catch (err) {
      // §6.8 — map the card-unavailable 400 to friendly homeowner copy instead of the
      // raw backend string; the generic fallback also stops any other raw backend
      // string from leaking to the homeowner.
      const msg = (err as any)?.response?.data?.error ?? (err as Error).message;
      const orgName = estimate?.organization?.name ?? 'This business';
      setError(/card payments? (are|is) not/i.test(msg)
        ? `${orgName} isn't accepting card payments right now — choose another payment method or contact us.`
        : 'Something went wrong starting your payment. Please try again or contact us.');
    } finally {
      setActionLoading(false);
    }
  };

  const handleDecline = async () => {
    setActionLoading(true);
    try {
      const res = await fetch(`${import.meta.env.VITE_API_URL || ''}/api/estimates/${id}/decline?token=${encodeURIComponent(token!)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      });
      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || 'Action failed');
      }
      const data = await res.json();
      setEstimate(prev => ({ ...data.estimate, organization: prev?.organization ?? null }));
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setActionLoading(false);
      setConfirmDecline(false);
    }
  };

  const handlePaymentMethodSelect = (method: string) => {
    // §4.5 — CARD takes the immediate-Stripe path; EXTERNAL_CARD behaves like
    // CHECK/BANK_TRANSFER (click expands to inline "call our office" block and
    // the customer confirms approval explicitly).
    if (method === 'CARD') {
      handleApprove('CARD');
    } else {
      setSelectedMethod(method);
    }
  };

  const handleConfirmNonStripe = () => {
    if (!selectedMethod) return;
    handleApprove(selectedMethod);
  };

  // ─── Render helpers ───────────────────────────────

  const renderPaymentMethodButtons = () => {
    return (
      <Card padding="sm">
        {selectedMethod ? (
          // Show instructions for selected non-Stripe method
          <div className="space-y-4">
            {/* ghost/subtle matches the idle text-text-secondary and hover:text-text-primary exactly
                (this is its documented "back buttons" use case). gap-1 restores the raw's exact icon
                gap over Button's base gap-2. One disclosed, not-restored delta: ghost/subtle also
                adds a hover:bg-background-light highlight that the raw button didn't have. */}
            <Button
              type="button"
              variant="ghost"
              tone="subtle"
              size={null}
              className="gap-1"
              onClick={() => setSelectedMethod(null)}
            >
              <ChevronLeft className="h-4 w-4" /> Back to payment methods
            </Button>
            <Heading level={3}>
              Pay by {formatMethodLabel(selectedMethod)} — {formatCurrency(depositAmount)}
            </Heading>
            {/* §4.5 — EXTERNAL_CARD shows the call-us block, matching the
                CHECK/BANK_TRANSFER instructions pattern. CARD never reaches
                this branch (handlePaymentMethodSelect short-circuits to
                Stripe immediately). */}
            {selectedMethod === 'EXTERNAL_CARD' ? (
              <div className="bg-neutral-surface border rounded-lg p-3 text-sm text-text-primary">
                To pay by credit card, please call our office
                {org?.phone ? ` at ${formatPhone(org.phone)}` : ''}.
              </div>
            ) : (
              paymentInstructions[INSTRUCTION_KEYS[selectedMethod] || ''] && (
                <div className="bg-neutral-surface border rounded-lg p-3 text-sm text-text-primary whitespace-pre-wrap">
                  {paymentInstructions[INSTRUCTION_KEYS[selectedMethod] || '']}
                </div>
              )
            )}
            <Button
              className="w-full"
              size="lg"
              disabled={actionLoading}
              onClick={handleConfirmNonStripe}
            >
              {actionLoading && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              <CheckCircle2 className="mr-2 h-5 w-5" />
              Confirm & Approve
            </Button>
          </div>
        ) : (
          // Show all payment method buttons
          <div className="space-y-3">
            <Heading level={3}>Select Payment Method</Heading>
            {collapseCardMethods(availableMethods).map((method) => {
              const Icon = METHOD_ICONS[method] || Wallet;
              const isCard = method === 'CARD' || method === 'EXTERNAL_CARD';
              const amount = depositAmount;
              // Slice 4 — CARD redirects to Stripe immediately (no reveal step on this page), so
              // the fee preview surfaces right here, before the customer commits (D8, display only).
              const showFee = method === 'CARD' && serviceFeePreview > 0;
              return (
                <div key={method}>
                  <Button
                    variant="outline"
                    className="w-full justify-between h-auto py-3"
                    disabled={actionLoading}
                    onClick={() => handlePaymentMethodSelect(method)}
                  >
                    <span className="flex items-center gap-2">
                      <Icon className="h-5 w-5" />
                      Pay {isCard ? 'with' : 'by'} {formatMethodLabel(method)}
                    </span>
                    <span className="text-right">
                      <span className="font-semibold block">{formatCurrency(amount)}</span>
                      {showFee && (
                        <span className="text-xs text-text-soft block">
                          +{formatCurrency(serviceFeePreview)} service fee
                        </span>
                      )}
                    </span>
                  </Button>
                </div>
              );
            })}
            <Button
              variant="outline" tone="danger"
              className="w-full"
              size="lg"
              disabled={actionLoading}
              onClick={() => setConfirmDecline(true)}
            >
              <XCircle className="mr-2 h-5 w-5" /> Decline Estimate
            </Button>
          </div>
        )}
      </Card>
    );
  };

  const renderStatusBanner = () => {
    // Payment return banners take priority
    if (paymentBanner) {
      const isSuccess = paymentBanner.type === 'success';
      return (
        <Card padding="sm" tone={isSuccess ? 'success' : 'warning'}>
          <div className="flex items-center gap-3">
            {isSuccess
              ? <CheckCircle2 className="h-5 w-5 text-success-text" />
              : <AlertTriangle className="h-5 w-5 text-warning-text" />}
            <p className={`font-medium ${isSuccess ? 'text-success-text' : 'text-warning-text'}`}>
              {paymentBanner.message}
            </p>
          </div>
        </Card>
      );
    }

    if (isExpired) {
      return (
        <Card padding="sm" tone="warning">
          <div className="flex items-center gap-3">
            <Clock className="h-5 w-5 text-warning-text" />
            <div>
              <p className="font-medium text-warning-text">Estimate Expired</p>
              <p className="text-xs text-warning-text">
                This estimate has expired. Please contact your sales representative for a new estimate.
              </p>
            </div>
          </div>
        </Card>
      );
    }

    if (isCancelled) {
      return (
        <Card padding="sm" tone="neutral">
          <div className="flex items-center gap-3">
            <XCircle className="h-5 w-5 text-text-soft" />
            <div>
              <p className="font-medium text-text-primary">Estimate Cancelled</p>
              <p className="text-xs text-text-secondary">
                This estimate has been cancelled. Please contact us for assistance.
              </p>
            </div>
          </div>
        </Card>
      );
    }

    if (isDeclined) {
      return (
        <Card padding="sm" tone="neutral">
          <div className="flex items-center gap-3">
            <XCircle className="h-5 w-5 text-text-soft" />
            <div>
              <p className="font-medium text-text-primary">Estimate Declined</p>
              <p className="text-xs text-text-secondary">
                You declined this estimate on {estimate.declined_at ? new Date(estimate.declined_at).toLocaleString('en-US') : '—'}.
              </p>
            </div>
          </div>
        </Card>
      );
    }

    if (isApproved) {
      return (
        <Card padding="sm" tone="success">
          <div className="flex items-center gap-3">
            <CheckCircle2 className="h-5 w-5 text-success-text" />
            <div>
              <p className="font-medium text-success-text">Estimate Approved</p>
              <p className="text-xs text-success-text">
                Approved on {estimate.approved_at ? new Date(estimate.approved_at).toLocaleString('en-US') : '—'}
              </p>
              {depositInvoice?.status === 'PAID' && (
                <p className="text-xs text-success-text mt-1">
                  Deposit of {formatCurrency(depositAmount)} received.
                </p>
              )}
            </div>
          </div>
        </Card>
      );
    }

    if (isPending) {
      return (
        <Card padding="sm" tone="info">
          <div className="flex items-center gap-3">
            <Clock className="h-5 w-5 text-info-text" />
            <div className="flex-1">
              {/* D6: PENDING means this customer HAS approved and signed — lead with that, so the
                  page never implies we are still waiting on their decision. Only the deposit is open. */}
              <p className="font-medium text-info-text">Approved — Deposit Pending</p>
              <div className="text-xs text-info-text mt-1 space-y-1">
                {/* signature_at, not approved_at: approved_at is only stamped when the estimate
                    reaches WON (deposit settled), so it is still null here. signature_at is the
                    moment the customer actually accepted. */}
                {estimate.signature_at && (
                  <p>You approved this estimate on {new Date(estimate.signature_at).toLocaleString('en-US')}.</p>
                )}
                <p>Deposit amount: {formatCurrency(depositAmount)}</p>
                {serviceFeePreview > 0 && (
                  <p className="text-info-text">
                    Paying by card adds a {formatCurrency(serviceFeePreview)} service fee.
                  </p>
                )}
              </div>
              <p className="text-xs text-info-text mt-2">
                Once we receive your deposit, we'll schedule your job.
              </p>
              {/* Card lane: the customer may have closed the checkout tab before paying. Without
                  this they would be stranded — the estimate is no longer SENT, so the sign-and-pay
                  form is gone. Re-running approve on a PENDING estimate re-opens checkout and
                  leaves the stored signature untouched. */}
              {availableMethods.includes('CARD') && (
                <Button
                  className="mt-3"
                  size="sm"
                  disabled={actionLoading}
                  onClick={() => handleApprove('CARD')}
                >
                  {actionLoading ? 'Opening checkout…' : 'Complete deposit payment'}
                </Button>
              )}
            </div>
          </div>
        </Card>
      );
    }

    // Fallback for any other non-actionable status
    if (!isActionable) {
      return (
        <Card padding="sm" tone="warning">
          <p className="text-sm text-warning-text">
            This estimate is currently not available for action.
          </p>
        </Card>
      );
    }

    return null;
  };

  // ─── Main render ──────────────────────────────────

  const org = estimate?.organization;
  // CSS-only consumer, so it can read the colour straight off the token layer.
  const headerBg = org?.brand_color || defaultBrandColor();

  return (
    <div className="fixed inset-0 bg-background-light overflow-y-auto">
      {/* Org branding header */}
      <div style={{ backgroundColor: headerBg }} className="w-full px-4 py-4 flex items-center justify-between">
        <div>
          {org?.logo_url ? (
            <img src={org.logo_url} alt={org.name} style={{ maxHeight: '40px' }} />
          ) : (
            <span className="text-on-fill font-bold text-lg">{org?.name || 'ServWave'}</span>
          )}
        </div>
        {token && estimate && (
          <a
            href={`/api/estimates/${estimate.id}/public/pdf?token=${encodeURIComponent(token)}`}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-2 border border-on-fill/60 text-on-fill text-sm font-medium px-3 py-1.5 rounded-lg hover:bg-on-fill/10 transition-colors"
          >
            Download PDF
          </a>
        )}
      </div>
      <div className="py-8 px-4">
      <div className="max-w-2xl mx-auto space-y-6">
        {/* Error banner (non-fatal) */}
        {error && estimate && (
          <Card padding="sm" tone="danger">
            <p className="text-sm text-danger-text">{error}</p>
          </Card>
        )}

        {/* Estimate document */}
        <EstimateDocumentView
          estimateNumber={estimate.estimate_number}
          customerName={customerDisplayName(estimate.customer ?? estimate.lead?.customer, '')}
          companyName={(estimate.customer ?? estimate.lead?.customer)?.company_name}
          scopeNotes={estimate.scope_notes}
          lineItems={estimate.line_items}
          subtotal={Number(estimate.subtotal)}
          taxRate={Number(estimate.tax_rate)}
          taxAmount={Number(estimate.tax_amount)}
          totalAmount={Number(estimate.total_amount)}
          discountType={estimate.discount_type}
          discountValue={estimate.discount_value != null ? Number(estimate.discount_value) : null}
          discountName={estimate.discount_name}
          discountAmount={estimate.discount_amount != null ? Number(estimate.discount_amount) : null}
        />

        {/* Deposit info line on estimate document */}
        {depositRequired && (
          <Card padding="sm" tone="info">
            <p className="text-sm text-text-primary">
              <span className="font-medium">Deposit required:</span>{' '}
              {formatCurrency(depositAmount)}
              {estimate.send_config?.deposit_percentage != null && (
                <span className="text-text-secondary"> ({estimate.send_config.deposit_percentage}% of total)</span>
              )}
            </p>
          </Card>
        )}

        {/* Status banner */}
        {renderStatusBanner()}

        {/* Post-approval signature display */}
        {estimate.signature_data && (isApproved || isPending) && (
          <Card padding="sm">
            <p className="text-xs font-medium text-text-secondary mb-2">Customer Signature</p>
            <img src={estimate.signature_data} alt="Signature" className="w-full max-h-28 object-contain border rounded" />
            {estimate.signature_at && (
              <p className="text-xs text-text-soft mt-1">
                Signed {new Date(estimate.signature_at).toLocaleString('en-US')}
              </p>
            )}
          </Card>
        )}

        {/* Terms & Conditions */}
        {org?.estimate_terms && isActionable && (
          <Card padding="sm">
            <Heading level={3} className="mb-2">Terms & Conditions</Heading>
            <div className="text-xs text-text-secondary whitespace-pre-wrap mb-1 border rounded p-2 bg-neutral-surface">
              {org.estimate_terms.length > 200
                ? `${org.estimate_terms.slice(0, 200)}...`
                : org.estimate_terms}
            </div>
            <p className="text-xs text-text-soft mb-3">See attached PDF for full terms</p>
            {/* Checkbox row (label wraps its control) - not a FormField-shape site, left raw. */}
            <label className="flex items-center gap-2 text-sm cursor-pointer">
              <Checkbox checked={termsAgreed} onCheckedChange={(v) => setTermsAgreed(!!v)} />
              I agree to the terms and conditions
            </label>
          </Card>
        )}

        {/* Signature pad */}
        {isActionable && (
          <Card padding="sm">
            <Heading level={3} className="mb-2">
              Signature <span className="text-danger-text">*</span>
            </Heading>
            <div ref={sigContainerRef} className="border rounded-lg overflow-hidden bg-surface-light">
              <SignatureCanvas
                ref={sigCanvasRef}
                canvasProps={{
                  width: canvasDims.width,
                  height: canvasDims.height,
                  style: { width: '100%', height: '128px' },
                }}
                backgroundColor="white"
                onEnd={() => setSigDrawn(true)}
              />
            </div>
            <Button
              size="sm" variant="ghost" className="mt-1 text-xs"
              onClick={() => { sigCanvasRef.current?.clear(); setSigDrawn(false); }}
            >
              Clear
            </Button>
          </Card>
        )}

        {/* Action buttons — SENT, no deposit required */}
        {isActionable && !needsPayment && (
          <Card padding="sm">
            <div className="flex flex-col sm:flex-row gap-3">
              <Button
                variant="solid" tone="business"
                className="flex-1"
                size="lg"
                disabled={approveDisabled}
                onClick={() => handleApprove(null)}
              >
                {actionLoading && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                <CheckCircle2 className="mr-2 h-5 w-5" /> Approve Estimate
              </Button>
              <Button
                variant="outline"
                className="flex-1"
                size="lg"
                onClick={() => setConfirmDecline(true)}
              >
                <XCircle className="mr-2 h-5 w-5" /> Decline
              </Button>
            </div>
            {!sigDrawn && (
              <p className="text-xs text-text-soft mt-2 text-center">Please sign above to approve</p>
            )}
          </Card>
        )}

        {/* Action buttons — SENT, deposit required, signature done */}
        {isActionable && needsPayment && renderPaymentMethodButtons()}

        {/* Action hint when deposit required but not yet signed */}
        {isActionable && depositRequired && !sigDrawn && (
          <Card padding="sm">
            <p className="text-xs text-text-soft text-center">
              Please sign above to proceed to payment
            </p>
            <div className="mt-3">
              <Button
                variant="outline" tone="danger"
                className="w-full"
                size="lg"
                onClick={() => setConfirmDecline(true)}
              >
                <XCircle className="mr-2 h-5 w-5" /> Decline Estimate
              </Button>
            </div>
          </Card>
        )}

        {/* Decline confirmation dialog */}
        <ConfirmDialog
          open={confirmDecline}
          onOpenChange={setConfirmDecline}
          title="Decline Estimate"
          description="Are you sure you want to decline this estimate? The contractor will be notified."
          variant="destructive"
          cancelLabel="Go Back"
          confirmLabel="Yes, Decline"
          onConfirm={handleDecline}
          isLoading={actionLoading}
        />

        {/* Org footer */}
        {org && (org.name || org.email || org.website) && (
          <div className="pt-4 pb-2 border-t border-border text-center text-xs text-text-soft space-y-1">
            {org.name && <p className="font-medium text-text-secondary">{org.name}</p>}
            {org.email && <p>{org.email}</p>}
            {org.website && (
              <p>
                <a href={safeHref(org.website)} target="_blank" rel="noopener noreferrer" className="hover:underline">
                  {org.website}
                </a>
              </p>
            )}
          </div>
        )}
      </div>
    </div>
    </div>
  );
}
