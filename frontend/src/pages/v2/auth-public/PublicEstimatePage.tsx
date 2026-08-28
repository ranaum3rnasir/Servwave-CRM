import { useState, useEffect, useRef, useCallback } from 'react';
import { useParams, useSearchParams } from 'react-router-dom';
import SignatureCanvas from 'react-signature-canvas';
import {
  CheckCircle2,
  XCircle,
  Clock,
  CreditCard,
  Landmark,
  Banknote,
  Wallet,
  AlertTriangle,
  ChevronLeft,
} from 'lucide-react';

// Two app primitives with no kit counterpart, both recorded in the gap ledger:
// the kit ships no link and no image primitive, and both the raw-`<a>` and the
// raw-`<img>` ratchets are at their floor.
import { ActionLink } from '@/components/ui/action-link';
import { Thumbnail } from '@/components/ui/thumbnail';
import { EstimateDocumentView } from '@/components/estimates/EstimateDocumentView';
import { ESTIMATE_STATUS } from '@/constants/estimateStatus';
import { formatCurrency, formatPhone } from '@/lib/utils';
import { safeHref } from '@/lib/safe-href';
import { customerDisplayName } from '@/lib/customer-name';
import { defaultBrandColor } from '@/lib/branding';

import { Button } from '@/ui-kit/components/ui/button';
import { Checkbox } from '@/ui-kit/components/ui/checkbox';
import { ConfirmDialog } from '@/ui-kit/components/ui/confirmDialog';
import { Label } from '@/ui-kit/components/ui/label';

import {
  PublicCard,
  PublicCardTitle,
  PublicColumn,
  PublicLoading,
  PublicNotice,
  PublicPage,
  PublicUnavailable,
} from './components/publicShell';

/* --- Types --- */

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
  terms_accepted?: boolean | null;
  terms_accepted_at?: string | null;
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

/* --- Helpers --- */

const METHOD_LABELS: Record<string, string> = {
  CARD: 'Credit/Debit Card',
  EXTERNAL_CARD: 'Credit/Debit Card', // collapsed to one customer-facing label
  CHECK: 'Check',
  BANK_TRANSFER: 'Bank Transfer (ACH)',
  CASH: 'Cash',
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

// The public page collapses CARD + EXTERNAL_CARD into a single Credit Card
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

/** The backend error string an axios-shaped rejection carries, if any. */
function backendError(err: unknown): string {
  const shaped = err as { response?: { data?: { error?: string } } };
  return shaped?.response?.data?.error ?? (err as Error).message;
}

/* --- Component --- */

/**
 * /v2/p/estimates/:id - the CRM-kit rebuild of `pages/PublicEstimatePage.tsx`.
 *
 * UNAUTHENTICATED. Every request is a bare `fetch()` against
 * `GET|POST /api/estimates/:id/...?token=`; the axios instance and its Bearer
 * interceptor are never used, no Supabase session is required, and nothing on
 * this page reads the auth store, the ability context or the organization
 * query. The `?token=` in the URL is the only credential the customer has.
 *
 * `formatCurrency` therefore falls back to its built-in default, because
 * `setOrgFormattingPrefs` only runs inside an app layout. That is correct and
 * must not be "fixed" with `useOrganization()` - it would fire an authed call
 * from a page a homeowner is looking at.
 *
 * `EstimateDocumentView` is rendered unchanged. It is shared with the authed
 * estimate workspace preview and asserted by
 * `src/__tests__/estimate-detail-preview.test.tsx`; restyling it here would
 * change three surfaces from one module. Recorded in the gap ledger.
 */
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
  // Card service fee - display-only preview computed server-side, off the deposit total.
  const [serviceFeePreview, setServiceFeePreview] = useState(0);

  /* --- Fetch estimate --- */

  const fetchEstimate = useCallback(async () => {
    if (!token) return;
    try {
      const res = await fetch(
        `${import.meta.env.VITE_API_URL || ''}/api/estimates/${id}/public?token=${encodeURIComponent(token)}`,
      );
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
      // eslint-disable-next-line react-hooks/set-state-in-effect -- one-shot mount validation of the URL token; there is no external system to sync with
      setError('Invalid link - token missing');
      setLoading(false);
      return;
    }

    fetchEstimate().finally(() => setLoading(false));
  }, [token, fetchEstimate]);

  // Handle Stripe return params
  useEffect(() => {
    if (!paymentParam) return;
    if (paymentParam === 'success') {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- reads the Stripe return param out of the URL once, then clears it; the URL IS the external system here
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

  /* --- Loading / fatal states --- */

  if (loading) return <PublicLoading />;

  if (error && !estimate) {
    return <PublicUnavailable title="Unavailable" message={error} />;
  }

  if (!estimate) return null;

  /* --- Derived state --- */

  const isActionable = estimate.status === 'SENT' && !isExpired;
  const isPending = estimate.status === 'PENDING';
  const isApproved = estimate.status === ESTIMATE_STATUS.WON;
  const isDeclined = estimate.status === 'DECLINED';
  const isCancelled = estimate.status === ESTIMATE_STATUS.ARCHIVED;
  const depositInvoice = estimate.invoices?.[0];
  const depositRequired = !!(estimate.send_config?.deposit_required && depositInvoice);
  const depositAmount = estimate.send_config?.deposit_amount
    ? Number(estimate.send_config.deposit_amount)
    : depositInvoice
      ? Number(depositInvoice.total_amount)
      : 0;
  const availableMethods = estimate.send_config?.payment_methods || [];
  const needsPayment = depositRequired && sigDrawn;
  const approveDisabled =
    !sigDrawn || (!!estimate?.organization?.estimate_terms && !termsAgreed) || actionLoading;

  const org = estimate?.organization;
  // CSS-only consumer, so it can read the colour straight off the token layer.
  const headerBg = org?.brand_color || defaultBrandColor();

  /* --- Actions --- */

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
      body.terms_accepted = termsAgreed; // server requires this when terms exist

      const res = await fetch(
        `${import.meta.env.VITE_API_URL || ''}/api/estimates/${id}/approve?token=${encodeURIComponent(token!)}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        },
      );
      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || 'Action failed');
      }
      const data = await res.json();

      // If Stripe checkout URL returned, redirect
      if (data.checkout_url) {
        // eslint-disable-next-line react-hooks/immutability -- deliberate full-page handoff to Stripe hosted Checkout; leaving the SPA is the intent
        window.location.href = data.checkout_url;
        return;
      }

      setEstimate((prev) => ({ ...data.estimate, organization: prev?.organization ?? null }));
      setSelectedMethod(null);
    } catch (err) {
      // Map the card-unavailable 400 to friendly homeowner copy instead of the
      // raw backend string; the generic fallback also stops any other raw
      // backend string from leaking to the homeowner.
      const msg = backendError(err);
      const orgName = estimate?.organization?.name ?? 'This business';
      setError(
        /card payments? (are|is) not/i.test(msg)
          ? `${orgName} isn't accepting card payments right now - choose another payment method or contact us.`
          : 'Something went wrong starting your payment. Please try again or contact us.',
      );
    } finally {
      setActionLoading(false);
    }
  };

  const handleDecline = async () => {
    setActionLoading(true);
    try {
      const res = await fetch(
        `${import.meta.env.VITE_API_URL || ''}/api/estimates/${id}/decline?token=${encodeURIComponent(token!)}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
        },
      );
      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || 'Action failed');
      }
      const data = await res.json();
      setEstimate((prev) => ({ ...data.estimate, organization: prev?.organization ?? null }));
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setActionLoading(false);
      setConfirmDecline(false);
    }
  };

  const handlePaymentMethodSelect = (method: string) => {
    // CARD takes the immediate-Stripe path; EXTERNAL_CARD behaves like
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

  /* --- Render helpers --- */

  const renderPaymentMethodButtons = () => (
    <PublicCard>
      {selectedMethod ? (
        // Instructions for the selected non-Stripe method
        <div className="flex flex-col gap-4">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="w-fit gap-1 px-0"
            onClick={() => setSelectedMethod(null)}
          >
            <ChevronLeft /> Back to payment methods
          </Button>
          <PublicCardTitle>
            Pay by {formatMethodLabel(selectedMethod)} - {formatCurrency(depositAmount)}
          </PublicCardTitle>
          {/* EXTERNAL_CARD shows the call-us block, matching the
              CHECK/BANK_TRANSFER instructions pattern. CARD never reaches this
              branch (handlePaymentMethodSelect short-circuits to Stripe). */}
          {selectedMethod === 'EXTERNAL_CARD' ? (
            <div className="bg-muted rounded-lg border p-3 text-sm">
              To pay by credit card, please call our office
              {org?.phone ? ` at ${formatPhone(org.phone)}` : ''}.
            </div>
          ) : (
            paymentInstructions[INSTRUCTION_KEYS[selectedMethod] || ''] && (
              <div className="bg-muted whitespace-pre-wrap rounded-lg border p-3 text-sm">
                {paymentInstructions[INSTRUCTION_KEYS[selectedMethod] || '']}
              </div>
            )
          )}
          <Button className="w-full" size="lg" isLoading={actionLoading} onClick={handleConfirmNonStripe}>
            <CheckCircle2 />
            Confirm &amp; Approve
          </Button>
        </div>
      ) : (
        // All payment method buttons
        <div className="flex flex-col gap-3">
          <PublicCardTitle>Select Payment Method</PublicCardTitle>
          {collapseCardMethods(availableMethods).map((method) => {
            const Icon = METHOD_ICONS[method] || Wallet;
            const isCard = method === 'CARD' || method === 'EXTERNAL_CARD';
            // CARD redirects to Stripe immediately (no reveal step on this
            // page), so the fee preview surfaces here, before the customer
            // commits. Display only.
            const showFee = method === 'CARD' && serviceFeePreview > 0;
            return (
              <Button
                key={method}
                variant="outline"
                className="h-auto w-full justify-between py-3"
                disabled={actionLoading}
                // eslint-disable-next-line react-hooks/refs -- this only PASSES the handler; the signature-canvas ref inside it is read at click time, not during render
                onClick={() => handlePaymentMethodSelect(method)}
              >
                <span className="flex items-center gap-2">
                  <Icon />
                  Pay {isCard ? 'with' : 'by'} {formatMethodLabel(method)}
                </span>
                <span className="text-right">
                  <span className="block font-semibold">{formatCurrency(depositAmount)}</span>
                  {showFee && (
                    <span className="text-subtle-foreground block text-xs">
                      +{formatCurrency(serviceFeePreview)} service fee
                    </span>
                  )}
                </span>
              </Button>
            );
          })}
          <Button
            variant="outline"
            className="w-full"
            size="lg"
            disabled={actionLoading}
            onClick={() => setConfirmDecline(true)}
          >
            <XCircle /> Decline Estimate
          </Button>
        </div>
      )}
    </PublicCard>
  );

  const renderStatusBanner = () => {
    // Payment return banners take priority
    if (paymentBanner) {
      const isSuccess = paymentBanner.type === 'success';
      return (
        <PublicNotice
          tone={isSuccess ? 'success' : 'warning'}
          icon={isSuccess ? <CheckCircle2 /> : <AlertTriangle />}
        >
          <p className="font-medium">{paymentBanner.message}</p>
        </PublicNotice>
      );
    }

    if (isExpired) {
      return (
        <PublicNotice tone="warning" icon={<Clock />}>
          <p className="font-medium">Estimate Expired</p>
          <p className="text-xs">
            This estimate has expired. Please contact your sales representative for a new estimate.
          </p>
        </PublicNotice>
      );
    }

    if (isCancelled) {
      return (
        <PublicNotice tone="neutral" icon={<XCircle />}>
          <p className="font-medium">Estimate Cancelled</p>
          <p className="text-xs">This estimate has been cancelled. Please contact us for assistance.</p>
        </PublicNotice>
      );
    }

    if (isDeclined) {
      return (
        <PublicNotice tone="neutral" icon={<XCircle />}>
          <p className="font-medium">Estimate Declined</p>
          <p className="text-xs">
            You declined this estimate on{' '}
            {estimate.declined_at ? new Date(estimate.declined_at).toLocaleString() : '-'}.
          </p>
        </PublicNotice>
      );
    }

    if (isApproved) {
      return (
        <PublicNotice tone="success" icon={<CheckCircle2 />}>
          <p className="font-medium">Estimate Approved</p>
          <p className="text-xs">
            Approved on{' '}
            {estimate.approved_at ? new Date(estimate.approved_at).toLocaleString() : '-'}
          </p>
          {depositInvoice?.status === 'PAID' && (
            <p className="mt-1 text-xs">Deposit of {formatCurrency(depositAmount)} received.</p>
          )}
        </PublicNotice>
      );
    }

    if (isPending) {
      return (
        <PublicNotice tone="info" icon={<Clock />}>
          {/* PENDING means this customer HAS approved and signed - lead with
              that, so the page never implies we are still waiting on their
              decision. Only the deposit is open. */}
          <p className="font-medium">Approved - Deposit Pending</p>
          <div className="mt-1 flex flex-col gap-1 text-xs">
            {/* signature_at, not approved_at: approved_at is only stamped when
                the estimate reaches WON (deposit settled), so it is still null
                here. signature_at is when the customer actually accepted. */}
            {estimate.signature_at && (
              <p>You approved this estimate on {new Date(estimate.signature_at).toLocaleString()}.</p>
            )}
            <p>Deposit amount: {formatCurrency(depositAmount)}</p>
            {serviceFeePreview > 0 && (
              <p>Paying by card adds a {formatCurrency(serviceFeePreview)} service fee.</p>
            )}
          </div>
          <p className="mt-2 text-xs">Once we receive your deposit, we&apos;ll schedule your job.</p>
          {/* Card lane: the customer may have closed the checkout tab before
              paying. Without this they would be stranded - the estimate is no
              longer SENT, so the sign-and-pay form is gone. Re-running approve
              on a PENDING estimate re-opens checkout and leaves the stored
              signature untouched. */}
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
        </PublicNotice>
      );
    }

    // Fallback for any other non-actionable status
    if (!isActionable) {
      return (
        <PublicNotice tone="warning">
          <p>This estimate is currently not available for action.</p>
        </PublicNotice>
      );
    }

    return null;
  };

  /* --- Main render --- */

  return (
    <PublicPage>
      {/* Org branding header. The brand colour is org data, so it rides an
          inline style - a token cannot express a per-tenant value. */}
      <div
        style={{ backgroundColor: headerBg }}
        className="flex w-full items-center justify-between gap-4 px-4 py-4"
      >
        {org?.logo_url ? (
          // The app's Thumbnail, not a raw <img>: the kit ships no image
          // primitive and the raw-<img> ratchet is at its floor. Every class
          // here is layout, so the primitive keeps owning its own appearance.
          <Thumbnail
            src={org.logo_url}
            alt={org.name}
            className="h-auto max-h-10 w-auto object-contain"
          />
        ) : (
          <span className="text-on-fill text-lg font-bold">{org?.name || 'ServWave'}</span>
        )}
        {token && estimate && (
          <ActionLink
            variant="outline"
            href={`/api/estimates/${estimate.id}/public/pdf?token=${encodeURIComponent(token)}`}
            target="_blank"
            rel="noopener noreferrer"
          >
            Download PDF
          </ActionLink>
        )}
      </div>

      <PublicColumn>
        {/* Error banner (non-fatal) */}
        {error && estimate && (
          <PublicNotice tone="danger">
            <p>{error}</p>
          </PublicNotice>
        )}

        {/* The customer document. Shared with the authed preview - not
            restyled here, see the file header. */}
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

        {/* Deposit info line */}
        {depositRequired && (
          <PublicNotice tone="info">
            <p>
              <span className="font-medium">Deposit required:</span> {formatCurrency(depositAmount)}
              {estimate.send_config?.deposit_percentage != null && (
                <span> ({estimate.send_config.deposit_percentage}% of total)</span>
              )}
            </p>
          </PublicNotice>
        )}

        {/* Status banner */}
        {renderStatusBanner()}

        {/* Post-approval signature display */}
        {estimate.signature_data && (isApproved || isPending) && (
          <PublicCard>
            <p className="text-muted-foreground mb-2 text-xs font-medium">Customer Signature</p>
            <div className="rounded border">
              <Thumbnail
                src={estimate.signature_data}
                alt="Signature"
                className="h-28 w-full object-contain"
              />
            </div>
            {estimate.signature_at && (
              <p className="text-subtle-foreground mt-1 text-xs">
                Signed {new Date(estimate.signature_at).toLocaleString()}
              </p>
            )}
          </PublicCard>
        )}

        {/* Terms and conditions */}
        {org?.estimate_terms && isActionable && (
          <PublicCard>
            <PublicCardTitle>Terms &amp; Conditions</PublicCardTitle>
            <div className="bg-muted text-muted-foreground mb-1 mt-2 whitespace-pre-wrap rounded border p-2 text-xs">
              {org.estimate_terms.length > 200
                ? `${org.estimate_terms.slice(0, 200)}...`
                : org.estimate_terms}
            </div>
            <p className="text-subtle-foreground mb-3 text-xs">See attached PDF for full terms</p>
            <div className="flex items-center gap-2">
              <Checkbox
                id="terms-agreed"
                checked={termsAgreed}
                onCheckedChange={(v) => setTermsAgreed(!!v)}
              />
              <Label htmlFor="terms-agreed" className="cursor-pointer font-normal">
                I agree to the terms and conditions
              </Label>
            </div>
          </PublicCard>
        )}

        {/* Signature pad. The <canvas> react-signature-canvas renders is the
            only canvas on the page, which is how the e2e specs find it. */}
        {isActionable && (
          <PublicCard>
            <PublicCardTitle>
              Signature <span className="text-destructive">*</span>
            </PublicCardTitle>
            <div
              ref={sigContainerRef}
              className="bg-kit-card mt-2 overflow-hidden rounded-lg border"
            >
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
              size="sm"
              variant="ghost"
              className="mt-1 px-0"
              onClick={() => {
                sigCanvasRef.current?.clear();
                setSigDrawn(false);
              }}
            >
              Clear
            </Button>
          </PublicCard>
        )}

        {/* SENT, no deposit required */}
        {isActionable && !needsPayment && (
          <PublicCard>
            <div className="flex flex-col gap-3 sm:flex-row">
              <Button
                className="flex-1"
                size="lg"
                disabled={approveDisabled}
                isLoading={actionLoading}
                onClick={() => handleApprove(null)}
              >
                <CheckCircle2 /> Approve Estimate
              </Button>
              <Button
                variant="outline"
                className="flex-1"
                size="lg"
                onClick={() => setConfirmDecline(true)}
              >
                <XCircle /> Decline
              </Button>
            </div>
            {!sigDrawn && (
              <p className="text-subtle-foreground mt-2 text-center text-xs">
                Please sign above to approve
              </p>
            )}
          </PublicCard>
        )}

        {/* SENT, deposit required, signature done */}
        {isActionable && needsPayment && renderPaymentMethodButtons()}

        {/* Deposit required but not yet signed */}
        {isActionable && depositRequired && !sigDrawn && (
          <PublicCard>
            <p className="text-subtle-foreground text-center text-xs">
              Please sign above to proceed to payment
            </p>
            <div className="mt-3">
              <Button
                variant="outline"
                className="w-full"
                size="lg"
                onClick={() => setConfirmDecline(true)}
              >
                <XCircle /> Decline Estimate
              </Button>
            </div>
          </PublicCard>
        )}

        <ConfirmDialog
          open={confirmDecline}
          onOpenChange={setConfirmDecline}
          title="Decline Estimate"
          description="Are you sure you want to decline this estimate? The contractor will be notified."
          destructive
          cancelLabel="Go Back"
          confirmLabel="Yes, Decline"
          onConfirm={handleDecline}
          isPending={actionLoading}
        />

        {/* Org footer */}
        {org && (org.name || org.email || org.website) && (
          <div className="text-subtle-foreground flex flex-col gap-1 border-t pb-2 pt-4 text-center text-xs">
            {org.name && <p className="text-muted-foreground font-medium">{org.name}</p>}
            {org.email && <p>{org.email}</p>}
            {org.website && (
              <p>
                <ActionLink href={safeHref(org.website)} target="_blank" rel="noopener noreferrer">
                  {org.website}
                </ActionLink>
              </p>
            )}
          </div>
        )}
      </PublicColumn>
    </PublicPage>
  );
}
