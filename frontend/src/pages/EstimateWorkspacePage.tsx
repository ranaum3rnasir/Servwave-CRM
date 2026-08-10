import { useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  Loader2,
  Eye,
  Send,
  MoreHorizontal,
  ArrowLeft,
  Briefcase,
  Download,
  Copy,
  Archive,
  Trash2,
  Lock,
  History,
  FileText,
  Link2,
  FileCheck,
  Undo2,
  Redo2,
  ThumbsUp,
  ThumbsDown,
  ShieldOff,
  Receipt,
  MailWarning,
} from 'lucide-react';
import api from '@/lib/axios';
import { ESTIMATE_STATUS } from '@/constants/estimateStatus';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { EstimateNameTitle } from '@/features/estimate-workspace/components/EstimateNameTitle';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { toast } from '@/components/ui/use-toast';
import { CustomerHeader } from '@/features/estimate-workspace/components/CustomerHeader';
import { EstimateTabs } from '@/features/estimate-workspace/components/EstimateTabs';
// PanelEstimate's type is still needed: CustomerHeader.tsx takes a `PanelEstimate`-shaped prop,
// so RawEstimate below must stay assignable to it. The old `InfoPanel.tsx` component that
// originally declared this type is retired from this page (v12 §4 Estimate) and deleted
// (review M7) — see the "Totals" section below for its <EstimateReceiptCard>/
// <InternalCostsCard>/residual-info replacement.
import type { PanelEstimate } from '@/features/estimate-workspace/lib/panelEstimate';
import { HistoryPanel } from '@/features/estimate-workspace/components/HistoryPanel';
import { AttachmentsSignaturesCard } from '@/features/estimate-workspace/components/AttachmentsSignaturesCard';
import { NotesCard } from '@/features/estimate-workspace/components/NotesCard';
import { JobLeadTasksTab } from '@/components/tasks/JobLeadTasksTab';
import { useAppAbility } from '@/contexts/AbilityContext';
import { canSeePricing as canSeePricingAbility } from '@/lib/ability';
import { extractApiError } from '@/lib/utils';
import {
  deleteEstimate,
  setEstimateStatus,
  approveEstimateInternal,
  copyEstimateToInvoice,
  type EstimateLineItem,
  type Scope,
  type EstimateScopePhoto,
} from '@/lib/api/estimates';
import { useOrganization } from '@/lib/api/organization';
import { useLeadCommunications, findTransactionalEmail } from '@/lib/api/jobCommunications';
import { SectionCard } from '@/components/jobs/overview/SectionCard';
import { EstimateInternalCostsCard } from '@/components/estimates/EstimateInternalCostsCard';
import {
  EstimateLineItemsEditor,
  EstimateScopeOfWorkCard,
} from '@/components/estimates/EstimateLineItemsEditor';
import { EstimateReceiptCard } from '@/components/estimates/EstimateReceiptCard';
import { SendEstimateDialog } from '@/components/estimates/SendEstimateDialog';
import { RecordEstimatePaymentDialog } from '@/components/estimates/RecordEstimatePaymentDialog';
import { DuplicateEstimateDialog } from '@/components/estimates/DuplicateEstimateDialog';
import { CancelEstimateDialog } from '@/components/estimates/CancelEstimateDialog';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog';
import { WaiveDepositDialog } from '@/components/estimates/WaiveDepositDialog';
import { RefundDepositDialog } from '@/components/estimates/RefundDepositDialog';
import { PdfPreviewDialog } from '@/components/estimates/PdfPreviewDialog';
import { MarkSentDialog } from '@/components/estimates/MarkSentDialog';
import {
  EstimateStatusMenu,
  type EstimateStatusMenuProps,
} from '@/components/estimates/EstimateStatusMenu';
import { DeclineEstimateInternalDialog } from '@/components/estimates/DeclineEstimateInternalDialog';
import { VoidApprovalDialog } from '@/components/estimates/VoidApprovalDialog';
import { TagInput } from '@/components/leads/TagInput';
import { useConfirm } from '@/hooks/useConfirm';

type RawEstimate = PanelEstimate & {
  id: string;
  name?: string | null;
  scope_name?: string | null;
  scope_notes?: string | null;
  total_amount?: number | null;
  subtotal: number | string;
  tax_amount: number | string;
  public_token?: string | null;
  version: number;
  modified_after_send: boolean;
  superseded_by_id?: string | null;
  line_items: EstimateLineItem[];
  scopes: Scope[];
  /** R5f — flat array of every scope-of-work photo on this estimate; grouped by `scope_id`. */
  scope_photos?: EstimateScopePhoto[];
  /** SRVW-103 - hydrated by GET /api/estimates/:id only; absent on granular mutation responses. */
  tags?: { id: string; name: string; color: string }[];
  // R3 (2026-07-21) cost model (D2/D8) — staff-only, stripped for non-privileged viewers.
  labor_hours?: number | string | null;
  overhead_mode?: 'PERCENTAGE' | 'FIXED' | null;
  overhead_value?: number | string | null;
};

const fmtDate = (s?: string | null) =>
  s ? new Date(s).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : null;

/**
 * Residual "Estimate Info" card (v12 §4 Estimate) — number/created-by/dates/signature-thumbnail,
 * the one slice of the old three-way `InfoPanel.tsx` split with no v12 Card A/B equivalent. Kept
 * as its own small card (rather than folded into the hero) since hero/identity changes are
 * DEFERRED per the v12 plan §1.
 */
function EstimateInfoCard({ estimate }: { estimate: RawEstimate }) {
  return (
    <SectionCard title="Estimate Info" icon={<FileText className="h-4 w-4 text-text-secondary" />}>
      <div className="flex flex-col gap-1 text-sm">
        <div className="flex items-center justify-between">
          <span className="text-text-secondary">Number</span>
          <span className="text-text-primary">{estimate.estimate_number}</span>
        </div>
        {estimate.creator && (
          <div className="flex items-center justify-between">
            <span className="text-text-secondary">Created by</span>
            <span className="text-text-primary">
              {estimate.creator.first_name} {estimate.creator.last_name}
            </span>
          </div>
        )}
        {fmtDate(estimate.created_at) && (
          <div className="flex items-center justify-between">
            <span className="text-text-secondary">Created</span>
            <span className="text-text-primary">{fmtDate(estimate.created_at)}</span>
          </div>
        )}
        {fmtDate(estimate.sent_at) && (
          <div className="flex items-center justify-between">
            <span className="text-text-secondary">Sent</span>
            <span className="text-text-primary">{fmtDate(estimate.sent_at)}</span>
          </div>
        )}
        {fmtDate(estimate.approved_at) && (
          <div className="flex items-center justify-between">
            <span className="text-text-secondary">Approved</span>
            <span className="text-text-primary">{fmtDate(estimate.approved_at)}</span>
          </div>
        )}
        {fmtDate(estimate.declined_at) && (
          <div className="flex items-center justify-between">
            <span className="text-text-secondary">Declined</span>
            <span className="text-text-primary">{fmtDate(estimate.declined_at)}</span>
          </div>
        )}
        {fmtDate(estimate.cancelled_at) && (
          <div className="flex items-center justify-between">
            <span className="text-text-secondary">Cancelled</span>
            <span className="text-text-primary">{fmtDate(estimate.cancelled_at)}</span>
          </div>
        )}
        {estimate.signature_data && (
          <img
            src={estimate.signature_data}
            alt="Signature"
            className="mt-2 h-12 rounded border border-border"
          />
        )}
      </div>
    </SectionCard>
  );
}

export default function EstimateWorkspacePage() {
  const { confirm, confirmDialog } = useConfirm();
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const ability = useAppAbility();

  // Action dialogs (mirror EstimateDetailPage).
  const [sendOpen, setSendOpen] = useState(false);
  const [previewOpen, setPreviewOpen] = useState(false);
  const [recordPaymentOpen, setRecordPaymentOpen] = useState(false);
  const [duplicateOpen, setDuplicateOpen] = useState(false);
  const [cancelOpen, setCancelOpen] = useState(false);
  const [waiveOpen, setWaiveOpen] = useState(false);
  const [refundOpen, setRefundOpen] = useState(false);
  const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  // R4 (2026-07-21) — lifecycle verbs (port-plan §3.2/§10.3).
  const [markSentOpen, setMarkSentOpen] = useState(false);
  const [declineInternalOpen, setDeclineInternalOpen] = useState(false);
  const [voidApprovalOpen, setVoidApprovalOpen] = useState(false);
  const [linkCopied, setLinkCopied] = useState(false);

  const { data: estimate, isLoading } = useQuery<RawEstimate>({
    queryKey: ['estimate', id],
    queryFn: async () => {
      const res = await api.get(`/api/estimates/${id}`);
      return res.data.estimate;
    },
    enabled: !!id,
  });

  const { data: org } = useOrganization();

  // Delivery fact (slice 5) — Email carries no estimate_id column to join on
  // directly, so this reads the SAME lead-scoped comm timeline the Lead
  // page's Communication tab already renders (a lead-anchored estimate's send
  // stamps lead_id on the Email row, see lib/email.ts's
  // sendEstimateEmail/sendEstimateWithDepositEmail call sites) and picks out
  // THIS estimate's own send by its deterministic subject prefix
  // (`Estimate ${estimateNumber} ...`, unique per org). Declared before the
  // isLoading/!estimate early return below, same rule as every other hook on
  // this page — enabled:false-equivalent via leadId undefined until the
  // estimate loads. Customer-anchored (lead-less) estimates have no
  // equivalent lookup today; see the slice-5 report for that known gap.
  const { data: leadComms } = useLeadCommunications(estimate?.lead_id ?? undefined);
  const estimateSendItem = estimate
    ? findTransactionalEmail(leadComms, `Estimate ${estimate.estimate_number}`)
    : undefined;
  const hardBounced = estimateSendItem?.deliveryStatus === 'BOUNCED' && estimateSendItem?.bounceKind === 'HARD';

  // §A1/D12 — lock policy: PAID deposit is always locked; otherwise SENT and PENDING alike are
  // locked only when the org's lock_on_send toggle is ON. D12 (2026-07-21) supersedes the earlier
  // D6 rule that hard-locked every PENDING estimate: a material edit to an UNLOCKED PENDING
  // estimate is now allowed by the backend — it voids the customer's signature and reverts the
  // estimate to SENT (forcing an explicit re-send) rather than being blocked outright. DRAFT and
  // terminal states are handled by their own gates.
  //
  // This MUST stay in lockstep with the backend's `isEstimateLocked`
  // (backend/src/controllers/estimate.controller.ts) — that helper is the authority, and this is
  // its presentation mirror. A divergence here does not merely mis-render: it offers the user an
  // edit affordance the server will reject, or hides one the server would allow.
  const status = estimate?.status ?? 'DRAFT';
  const depositInvoice = estimate?.invoices?.find((inv) => inv.kind === 'DEPOSIT');
  const depositPaid = depositInvoice?.status === 'PAID';
  const lockOnSend = org?.lock_on_send ?? false;
  const isSigned = status === 'PENDING';
  // R4 (2026-07-21) — Revise (clone → new DRAFT) is retired from the UI (§14.4): backtodraft is
  // the same-row recall that replaces it as the escape hatch out of a locked SENT/PENDING estimate
  // — the backend's PATCH /:id/status doesn't gate the transition on lock state, only on `status`.
  const isSentLike = status === 'SENT' || isSigned;
  const locked = depositPaid || (isSentLike && lockOnSend);
  const isTerminal = [ESTIMATE_STATUS.WON, 'DECLINED', 'EXPIRED', ESTIMATE_STATUS.ARCHIVED, 'SUPERSEDED'].includes(status);
  // §A1/A3/D12 — editable in place unless locked or in a terminal/read-only state. PENDING is now
  // included alongside DRAFT/SENT — editing an unlocked PENDING estimate is the D12 signature-
  // invalidation path, not a blocked action.
  const canEditNow = !locked && !isTerminal && (status === 'DRAFT' || isSentLike);
  // v12 §4 Estimate: the single ability gating every granular line/scope mutation (no manage_lines
  // split like Invoice — Estimate mirrors Job's precedent; see estimate-lines.controller.ts).
  const canManageLines = canEditNow && ability.can('update', 'Estimate');
  // Cost/margin visibility for <InternalCostsCard> — shared with the backend's canSeePricing
  // gate (SRVW-140), see lib/ability.ts.
  const canSeePricing = canSeePricingAbility(ability);
  // #590 — writing INTO the catalog is a separate, admin-grantable ability; editing estimate
  // lines must not imply catalog-write rights.
  const canSaveToPriceBook = ability.can('create', 'PriceBook');

  // Download the estimate PDF via the authed axios client.
  const [downloading, setDownloading] = useState(false);
  async function handleDownloadPdf() {
    if (!id) return;
    setDownloading(true);
    try {
      const res = await api.get(`/api/estimates/${id}/pdf`, { responseType: 'blob' });
      const url = URL.createObjectURL(res.data as Blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `Estimate-${estimate?.estimate_number ?? id}.pdf`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch (err) {
      toast({
        title: 'Download failed',
        description: extractApiError(err, 'Could not download the estimate PDF.'),
        variant: 'destructive',
      });
    } finally {
      setDownloading(false);
    }
  }

  // R4 (2026-07-21) — copy-link, rebuilt from InvoiceDetailPage's live pattern (the estimate's own
  // implementation was deleted with EstimateDetailPage.tsx in R0).
  function handleCopyLink() {
    if (estimate?.public_token) {
      const url = `${window.location.origin}/p/estimates/${estimate.id}?token=${estimate.public_token}`;
      navigator.clipboard.writeText(url);
      setLinkCopied(true);
      setTimeout(() => setLinkCopied(false), 2000);
    }
  }

  // ── Lifecycle mutations ─────────────────────────────────────────────────
  const deleteMutation = useMutation({
    mutationFn: async () => deleteEstimate(id!),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['estimates'] });
      navigate('/estimates');
    },
    onError: (err: unknown) =>
      toast({ title: 'Delete failed', description: extractApiError(err, 'Failed to delete estimate'), variant: 'destructive' }),
  });

  // R4 (2026-07-21) — lifecycle verbs (port-plan §3.2/§10.3). backtodraft/backtosent replace
  // Revise as the same-row correction path; approve-internal records a verbal/off-platform win.
  const backToDraftMutation = useMutation({
    mutationFn: async () => setEstimateStatus(id!, 'backtodraft'),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['estimate', id] });
      queryClient.invalidateQueries({ queryKey: ['estimates'] });
      toast({ title: 'Recalled to Draft', description: "The customer's link is now invalid — edit and re-send when ready." });
    },
    onError: (err: unknown) =>
      toast({ title: 'Recall failed', description: extractApiError(err, 'Failed to recall estimate to draft'), variant: 'destructive' }),
  });

  const backToSentMutation = useMutation({
    mutationFn: async () => setEstimateStatus(id!, 'backtosent'),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['estimate', id] });
      queryClient.invalidateQueries({ queryKey: ['estimates'] });
      toast({ title: 'Moved back to Sent' });
    },
    onError: (err: unknown) =>
      toast({ title: 'Update failed', description: extractApiError(err, 'Failed to move estimate back to sent'), variant: 'destructive' }),
  });

  const approveInternalMutation = useMutation({
    mutationFn: async () => approveEstimateInternal(id!),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['estimate', id] });
      queryClient.invalidateQueries({ queryKey: ['estimates'] });
      toast({ title: 'Marked approved', description: 'Recorded as a verbal/off-platform win.' });
    },
    onError: (err: unknown) =>
      toast({ title: 'Approve failed', description: extractApiError(err, 'Failed to approve estimate'), variant: 'destructive' }),
  });

  const createJobMutation = useMutation({
    mutationFn: async () => {
      const { data } = await api.post('/api/jobs', { estimate_id: id });
      return data.job as { id: string };
    },
    onSuccess: (job) => {
      queryClient.invalidateQueries({ queryKey: ['estimate', id] });
      queryClient.invalidateQueries({ queryKey: ['estimates'] });
      queryClient.invalidateQueries({ queryKey: ['jobs'] });
      queryClient.invalidateQueries({ queryKey: ['schedule-unassigned'] });
      queryClient.invalidateQueries({ queryKey: ['schedule-jobs'] });
      navigate(`/jobs/${job.id}`);
    },
    onError: (err: unknown) =>
      toast({ title: 'Create job failed', description: extractApiError(err, 'Failed to create job'), variant: 'destructive' }),
  });

  // Copy-to-Invoice — converts the estimate directly into a standalone Invoice, independent of
  // the Job pipeline. Mirrors createJobMutation's shape (bare POST, no confirmation dialog,
  // navigate straight to the result). Gating (job/standardInvoice checks) lives on the trigger,
  // not here — the backend 409s regardless as its own guard.
  const copyToInvoiceMutation = useMutation({
    mutationFn: async () => copyEstimateToInvoice(id!),
    onSuccess: ({ invoice }) => {
      queryClient.invalidateQueries({ queryKey: ['estimate', id] });
      queryClient.invalidateQueries({ queryKey: ['estimates'] });
      queryClient.invalidateQueries({ queryKey: ['invoices'] });
      navigate(`/invoices/${invoice.id}`);
    },
    onError: (err: unknown) =>
      toast({ title: 'Copy to invoice failed', description: extractApiError(err, 'Failed to copy estimate to invoice'), variant: 'destructive' }),
  });

  if (isLoading || !estimate) {
    return (
      <div className="w-full space-y-4 p-6">
        <Skeleton className="h-12 w-full" />
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-[1fr_320px]">
          <Skeleton className="h-96 w-full" />
          <Skeleton className="h-96 w-full" />
        </div>
      </div>
    );
  }

  // ── Derived permission gates (exact parity with EstimateDetailPage) ──
  const isDraft = status === 'DRAFT';
  const isSent = status === 'SENT';
  const isApproved = status === ESTIMATE_STATUS.WON;
  const canSend = ability.can('send', 'Estimate');
  const canCancelEstimate = ability.can('cancel', 'Estimate');
  const canDeleteEstimate = ability.can('delete', 'Estimate');
  const canRecordPayment = ability.can('record_payment', 'Estimate');
  const canCreateJob = ability.can('create', 'Job');
  // Copy-to-Invoice — gated on `create Invoice` (NOT on isApproved/WON status; the backend
  // allows any estimate status). standardInvoice/estimate.job existence disable the action with
  // an informative tooltip instead of letting the backend's 409 surface as a raw error toast.
  const canCopyToInvoice = ability.can('create', 'Invoice');
  const standardInvoice = estimate.invoices?.find((inv) => inv.kind === 'STANDARD' && inv.status !== 'VOIDED');
  // SRVW-86 - "this estimate has a job by either pointer" (provenance `job` or R6 attachment
  // `job_id`), stated once for the three call sites in this file that gate on it.
  const hasJob = !!(estimate.job || estimate.job_id);
  const canWaiveDeposit = ability.can('waive_deposit', 'Estimate');
  const canRefundDeposit = ability.can('refund', 'Invoice');
  const canDuplicate = ability.can('duplicate', 'Estimate');
  // R4 (2026-07-21) — lifecycle verbs (port-plan §3.2/§10.3). mark-sent reuses the `send` grant
  // (same population, same "deliver the document" intent). void_approval has no non-admin grant
  // row (D13) — `ability.can` resolves false for everyone else without a round-trip.
  const canMarkSent = canSend && isDraft;
  const canSetStatus = ability.can('update', 'Estimate');
  const canBackToDraft = canSetStatus && isSentLike;
  const canBackToSent = canSetStatus && isSigned;
  const canApproveInternal = ability.can('approve', 'Estimate') && isSentLike;
  const canDeclineInternal = ability.can('decline', 'Estimate') && isSentLike;
  const canVoidApproval = ability.can('void_approval', 'Estimate') && isApproved;
  const canArchive = canCancelEstimate && (isDraft || isSent);
  const canCopyLink = !!estimate.public_token;

  // Lifecycle handlers, named once so the status pill's dropdown and the Actions menu below invoke
  // the IDENTICAL confirm copy + mutation. Two call sites for the same verb is exactly how the two
  // surfaces would drift apart otherwise.
  const confirmRecallToDraft = async () => {
    const ok = await confirm({
      title: `Recall ${estimate.estimate_number} to Draft?`,
      description: `The customer's current link will stop working${isSigned ? ' and their signature will be cleared' : ''}.`,
      confirmLabel: 'Recall to Draft',
      tone: 'danger',
    });
    if (ok) backToDraftMutation.mutate();
  };
  const confirmBackToSent = async () => {
    const ok = await confirm({
      title: `Move ${estimate.estimate_number} back to Sent?`,
      confirmLabel: 'Move to Sent',
    });
    if (ok) backToSentMutation.mutate();
  };
  const confirmApproveInternal = async () => {
    const ok = await confirm({
      title: `Record ${estimate.estimate_number} as approved?`,
      description: 'Verbal or off-platform win. No signature will be captured.',
      confirmLabel: 'Record as approved',
    });
    if (ok) approveInternalMutation.mutate();
  };

  // Which statuses the pill's dropdown offers. Each entry mirrors the capability + status gate its
  // Actions-menu twin already uses; `reason` is what the disabled row explains. See
  // EstimateStatusMenu for why PENDING is absent entirely.
  const statusTargets: EstimateStatusMenuProps['targets'] = {
    [ESTIMATE_STATUS.DRAFT]: {
      enabled: canBackToDraft,
      reason: 'You do not have permission to change this estimate',
      onSelect: confirmRecallToDraft,
    },
    [ESTIMATE_STATUS.SENT]: {
      // Two different routes to SENT: forward from DRAFT (mark-sent), back from PENDING.
      enabled: canMarkSent || canBackToSent,
      reason: isDraft
        ? 'You do not have permission to send this estimate'
        : 'You do not have permission to change this estimate',
      onSelect: canMarkSent ? () => setMarkSentOpen(true) : confirmBackToSent,
    },
    [ESTIMATE_STATUS.PENDING]: {
      enabled: false,
      reason: 'Pending is set only when the customer signs the estimate',
    },
    [ESTIMATE_STATUS.WON]: {
      enabled: canApproveInternal,
      reason: isSentLike ? 'You do not have permission to approve estimates' : 'Send the estimate before marking it Won',
      onSelect: confirmApproveInternal,
    },
    [ESTIMATE_STATUS.DECLINED]: {
      enabled: canDeclineInternal,
      reason: isSentLike ? 'You do not have permission to decline estimates' : 'Send the estimate before marking it Declined',
      onSelect: () => setDeclineInternalOpen(true),
    },
    [ESTIMATE_STATUS.ARCHIVED]: {
      enabled: canArchive,
      reason: isDraft || isSent ? 'You do not have permission to archive estimates' : 'Only a draft or sent estimate can be archived',
      onSelect: () => setCancelOpen(true),
    },
  };

  const sc = estimate.send_config;
  const depPayment = depositInvoice?.payments?.[0];
  const depMethod = depPayment?.method ?? null;
  const hasStripePayment = Boolean(depPayment?.stripe_payment_intent_id);
  // SERV10X-61 - an estimate reaches its customer through the lead when it is lead-anchored, and
  // through its own direct relation when it is customer-anchored (lead-less). Read both, in the
  // same order the backend's send() and CustomerHeader already use; reading only `lead.customer`
  // leaves every lead-less estimate with no recipient to pre-fill.
  const customer = estimate.lead?.customer ?? estimate.customer ?? null;
  const customerEmail = customer?.email ?? '';
  const customerId = (customer as { id?: string } | null)?.id ?? estimate.customer_id ?? null;
  const totalAmount = estimate.total_amount ?? 0;
  const showWaive = canWaiveDeposit && !!depositInvoice && ['DRAFT', 'SENT'].includes(depositInvoice.status);
  const showRefund =
    canRefundDeposit && !!depositInvoice && ['PAID', 'PARTIALLY_REFUNDED'].includes(depositInvoice.status);

  // Full-bleed, matching JobDetailPage/InvoiceDetailPage — the old max-w-7xl cap left the
  // line-items grid squeezed into roughly half a wide screen while the right money rail kept its
  // fixed 320px, wrapping long item names one word per line.
  return (
    <div className="w-full p-4 lg:p-6">
      {/* Top bar (§E-2): back · title · status pill … secondaries … one sage primary · Actions */}
      <div className="mb-1 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-center gap-3">
          {/* icon-only 32px back button, hover:bg-primary-subtle - no matching Button variant/tone cell
              (ghost cells hover to bg-background-light, not primary-subtle) and no 32px size rung - left raw */}
          <button
            type="button"
            onClick={() => navigate('/estimates')}
            className="flex h-8 w-8 items-center justify-center rounded-md text-text-secondary hover:bg-primary-subtle"
            aria-label="Back to estimates"
          >
            <ArrowLeft className="h-4 w-4" />
          </button>
          <EstimateNameTitle
            estimateId={id!}
            leadId={estimate.lead_id ?? ''}
            name={estimate.name}
            estimateNumber={estimate.estimate_number}
            canEdit={ability.can('update', 'Estimate')}
          />
          <EstimateStatusMenu
            status={status}
            // A terminal or locked estimate has no reachable target, so the pill stays a pill
            // rather than a dropdown of six dead rows.
            readOnly={isTerminal || locked}
            targets={statusTargets}
          />
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {['DRAFT', 'SENT', 'PENDING'].includes(status) && canRecordPayment && (
            <Button variant="solid" tone="business" onClick={() => setRecordPaymentOpen(true)}>
              Record Payment
            </Button>
          )}

          {/* Two different job links, and both have to be clear before offering a conversion:
              `job` is PROVENANCE (a Job created FROM this estimate, i.e. Job.estimate_id points
              back), `job_id` is the ANCHOR (this estimate was written against an existing job).
              A job-anchored estimate has job_id with NO Job pointing back, so gating on `job`
              alone still offered "Create Job" on it - and the backend now 400s that ("already
              attached to a job"), because converting it used to re-point the estimate off its
              anchor, costing that job the estimate's paid deposit credit and re-billing its
              lines on a second job. */}
          {isApproved && !estimate.job && !estimate.job_id && canCreateJob &&
            (depositInvoice && !['PAID', 'VOIDED'].includes(depositInvoice.status) ? (
              <Button variant="solid" tone="business" disabled title="Deposit must be paid or waived before creating a job">
                <Briefcase className="mr-1 h-4 w-4" />
                Create Job
              </Button>
            ) : (
              <Button
                variant="solid" tone="business"
                onClick={() => createJobMutation.mutate()}
                disabled={createJobMutation.isPending}
              >
                {createJobMutation.isPending ? (
                  <Loader2 className="mr-1 h-4 w-4 animate-spin" />
                ) : (
                  <Briefcase className="mr-1 h-4 w-4" />
                )}
                Create Job
              </Button>
            ))}

          {/* D11 (2026-07-21) — Send never disappears: available in every status, gated only on
              !isTerminal (locked no longer excludes it — sending never edits money-affecting
              content, so a locked-but-unlocked-to-send distinction doesn't apply here). A terminal
              estimate gets "Send a copy" — same endpoint, but the backend skips the status change
              and timeline entry a real (re)send would normally write. */}
          {canSend && !isTerminal && (
            <Button variant="solid" tone="business" onClick={() => setSendOpen(true)}>
              <Send className="mr-1 h-4 w-4" />
              {isDraft ? 'Send' : 'Resend'}
            </Button>
          )}
          {canSend && isTerminal && (
            <Button variant="outline" onClick={() => setSendOpen(true)}>
              <Send className="mr-1 h-4 w-4" />
              Send a copy
            </Button>
          )}

          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="outline" aria-label="Actions">
                Actions
                <MoreHorizontal className="ml-1 h-4 w-4" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-56">
              {/* "View job" used to live here, unlabelled and reachable only by opening this
                  menu, while a lead-anchored estimate advertised its lead in the hero instead.
                  Both now live in ONE place - the hero's "Attached to" strip (CustomerHeader),
                  which names the record and carries its status. */}
              {standardInvoice && (
                <DropdownMenuItem onClick={() => navigate(`/invoices/${standardInvoice.id}`)}>
                  <Receipt className="mr-2 h-4 w-4" />
                  View invoice
                </DropdownMenuItem>
              )}
              <DropdownMenuItem onClick={() => setPreviewOpen(true)}>
                <Eye className="mr-2 h-4 w-4" />
                Preview
              </DropdownMenuItem>
              <DropdownMenuItem onClick={handleDownloadPdf} disabled={downloading}>
                {downloading ? (
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                ) : (
                  <Download className="mr-2 h-4 w-4" />
                )}
                Download
              </DropdownMenuItem>
              {canCopyLink && (
                <DropdownMenuItem onClick={handleCopyLink}>
                  <Link2 className="mr-2 h-4 w-4" />
                  {linkCopied ? 'Copied!' : 'Copy Link'}
                </DropdownMenuItem>
              )}
              <DropdownMenuItem onClick={() => setHistoryOpen(true)}>
                <History className="mr-2 h-4 w-4" />
                History
              </DropdownMenuItem>

              {/* R4 (2026-07-21) — lifecycle verbs (port-plan §3.2/§10.3). backtodraft/backtosent
                  replace Revise as the same-row correction path (§14.4); approve-internal/
                  decline-internal record a verbal/off-platform outcome; void-approval is D13's
                  guarded unwind, admin-only. Deliberately NOT a standalone "EstimateStatusControl"
                  component or a cross-entity shared ReasonDialog — every other lifecycle verb on
                  this page (Archive/Duplicate/Waive) already lives in this same Actions dropdown,
                  and consolidating the 9 existing free-text reason dialogs (Cancel/MarkLost/Void/
                  Refund/...) into one shared component is unrelated scope this PR doesn't touch. */}
              {(canMarkSent || canApproveInternal || canDeclineInternal || canBackToDraft || canBackToSent || canVoidApproval) && (
                <DropdownMenuSeparator />
              )}
              {canMarkSent && (
                <DropdownMenuItem onClick={() => setMarkSentOpen(true)}>
                  <FileCheck className="mr-2 h-4 w-4" />
                  Mark Sent
                </DropdownMenuItem>
              )}
              {canApproveInternal && (
                <DropdownMenuItem onClick={confirmApproveInternal}>
                  <ThumbsUp className="mr-2 h-4 w-4" />
                  Approve (Verbal)
                </DropdownMenuItem>
              )}
              {canDeclineInternal && (
                <DropdownMenuItem onClick={() => setDeclineInternalOpen(true)}>
                  <ThumbsDown className="mr-2 h-4 w-4" />
                  Decline
                </DropdownMenuItem>
              )}
              {canBackToDraft && (
                <DropdownMenuItem onClick={confirmRecallToDraft}>
                  <Undo2 className="mr-2 h-4 w-4" />
                  Recall to Draft
                </DropdownMenuItem>
              )}
              {canBackToSent && (
                <DropdownMenuItem onClick={confirmBackToSent}>
                  <Redo2 className="mr-2 h-4 w-4" />
                  Move back to Sent
                </DropdownMenuItem>
              )}
              {canVoidApproval && (
                <DropdownMenuItem onClick={() => setVoidApprovalOpen(true)} variant="destructive">
                  <ShieldOff className="mr-2 h-4 w-4" />
                  Void Approval
                </DropdownMenuItem>
              )}

              {/* Copy-to-Invoice — converts this estimate directly into a standalone Invoice,
                  independent of the Job pipeline. Available in every estimate status (backend
                  imposes no status gate); disabled with an informative tooltip rather than a
                  raw 409 toast once a Job exists or the estimate was already copied. */}
              {canCopyToInvoice && <DropdownMenuSeparator />}
              {canCopyToInvoice && (
                <DropdownMenuItem
                  disabled={!!standardInvoice || hasJob || copyToInvoiceMutation.isPending}
                  title={
                    standardInvoice
                      ? `Already copied to Invoice ${standardInvoice.invoice_number}`
                      : hasJob
                        ? 'This estimate already has a Job — invoice through the Job instead'
                        : undefined
                  }
                  onClick={() => copyToInvoiceMutation.mutate()}
                >
                  {copyToInvoiceMutation.isPending ? (
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  ) : (
                    <Receipt className="mr-2 h-4 w-4" />
                  )}
                  Copy to Invoice
                </DropdownMenuItem>
              )}

              {canDuplicate && <DropdownMenuSeparator />}
              {canDuplicate && (
                <DropdownMenuItem onClick={() => setDuplicateOpen(true)}>
                  <Copy className="mr-2 h-4 w-4" />
                  Duplicate
                </DropdownMenuItem>
              )}

              {(canArchive || (canDeleteEstimate && isDraft)) && (
                <DropdownMenuSeparator />
              )}
              {/* D14 (2026-07-21) — relabeled "Archive" (was "Cancel"); the internal action id
                  (ability.can('cancel', 'Estimate')) and the estimate.cancelled verb/permission
                  grant are UNCHANGED — this is copy-only, so no permission backfill or revocation
                  risk. */}
              {canArchive && (
                <DropdownMenuItem onClick={() => setCancelOpen(true)} variant="destructive">
                  <Archive className="mr-2 h-4 w-4" />
                  Archive
                </DropdownMenuItem>
              )}
              {canDeleteEstimate && isDraft && (
                <DropdownMenuItem onClick={() => setDeleteConfirmOpen(true)} variant="destructive">
                  <Trash2 className="mr-2 h-4 w-4" />
                  Delete
                </DropdownMenuItem>
              )}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>

      <div className="mb-3">
        <TagInput entityType="ESTIMATE" entityId={id!} tags={estimate.tags ?? []} />
      </div>

      {/* "Modified after send" — a server field, independent of any save-status chip. Every edit
          on this page now persists immediately via its own granular endpoint (line/scope
          mutations) or an immediate whole-document PATCH (discount/tax/deposit, on blur) — v12's
          shared stack has no debounced page-level autosave to report on, matching Job/Invoice's
          own UX (no "Saving…/✓ Saved" chip there either).
          R1 (2026-07-21, §3.4b) — was a passive pill with no way to act on it; now an actionable
          banner with an inline Resend, matching the locked/SUPERSEDED banners' visual language. */}
      {estimate.modified_after_send && canSend && !isTerminal && (
        <div className="mb-4 flex items-center justify-between gap-2 rounded-card border border-warning/30 bg-warning/10 px-4 py-2.5 text-sm text-warning">
          <span className="font-semibold">This estimate changed since it was last sent — the customer hasn't seen the update.</span>
          <Button variant="outline" size="sm" onClick={() => setSendOpen(true)}>
            <Send className="mr-1 h-4 w-4" />
            Resend
          </Button>
        </div>
      )}

      {/* Delivery fact, HARD BOUNCE only (slice 5) — "Delivered and Bounced are
          shown as fact"; a hard bounce means the address is dead, so this is
          the one delivery state that must never sit as a quiet pill in a list.
          Same actionable-banner shape as the modified_after_send banner above,
          in danger tone. SOFT bounces/DEFERRED/FAILED/etc. read through the
          Lead page's own Communication tab pill (same EmailDeliveryPill) —
          only a HARD bounce is worth an actionable banner here. */}
      {hardBounced && canSend && !isTerminal && (
        <div className="mb-4 flex items-center justify-between gap-2 rounded-card border border-danger/30 bg-danger/10 px-4 py-2.5 text-sm text-danger">
          <span className="flex items-center gap-2 font-semibold">
            <MailWarning className="h-4 w-4 shrink-0" />
            This estimate's email bounced — the customer likely never received it.
            {estimateSendItem?.deliveryStatusReason && (
              <span className="font-normal text-danger/80">({estimateSendItem.deliveryStatusReason})</span>
            )}
          </span>
          <Button variant="outline" size="sm" onClick={() => setSendOpen(true)}>
            <Send className="mr-1 h-4 w-4" />
            Resend
          </Button>
        </div>
      )}

      {locked && (
        <div className="mb-4 flex items-center gap-2 rounded-card border border-border bg-background-light px-4 py-2.5 text-sm text-text-secondary">
          <Lock className="h-4 w-4 shrink-0" />
          {depositPaid
            ? 'This estimate is locked — the deposit is paid. Recall it to Draft (Actions menu) to make changes.'
            : isSigned
              ? 'This estimate is locked (lock on send is ON for this org) — the customer approved and signed it, but the deposit is still outstanding. Recall it to Draft (Actions menu) to make changes.'
              : 'This estimate is locked (lock on send is ON for this org). Recall it to Draft (Actions menu) to make changes.'}
        </div>
      )}
      {status === 'SUPERSEDED' && (
        <div className="mb-4 flex items-center gap-2 rounded-card border border-border bg-background-light px-4 py-2.5 text-sm text-text-secondary">
          <History className="h-4 w-4 shrink-0" />
          Superseded{estimate.superseded_by_id && (
            <Button
              type="button"
              variant="link"
              size={null}
              onClick={() => navigate(`/estimates/${estimate.superseded_by_id}`)}
            >
              — view the current revision
            </Button>
          )}
        </div>
      )}

      {/* Per-lead estimate tabs — switch between siblings, or add blank/copy. */}
      {estimate.lead_id && id && (
        <div className="mb-4">
          <EstimateTabs leadId={estimate.lead_id} activeEstimateId={id} />
        </div>
      )}

      {/* Client information banner (Workiz-style) */}
      <div className="mb-4">
        <CustomerHeader estimate={estimate} />
      </div>

      {/* Body: canvas + right money rail (v12 §01's target 1fr+rail shape — already this shape
          pre-migration; kept as-is, the full cross-surface layout reflow is its own later slice) */}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-[1fr_320px]">
        <div className="space-y-4">
          <EstimateScopeOfWorkCard estimate={estimate} canManage={canManageLines} canSeePricing={canSeePricing} />
          <EstimateLineItemsEditor
            estimate={estimate}
            canManage={canManageLines}
            canSeePricing={canSeePricing}
            canSaveToPriceBook={canSaveToPriceBook}
          />
        </div>

        <aside className="lg:sticky lg:top-4 lg:self-start">
          <div className="flex flex-col gap-4">
            <EstimateReceiptCard estimate={estimate} canEditNow={canEditNow} />
            {canSeePricing && (
              <EstimateInternalCostsCard
                estimate={{
                  id: estimate.id,
                  line_items: estimate.line_items ?? [],
                  scopes: estimate.scopes ?? [],
                  labor_hours: estimate.labor_hours,
                  overhead_mode: estimate.overhead_mode,
                  overhead_value: estimate.overhead_value,
                  discountedSubtotal: Number(estimate.subtotal ?? 0) - Number(estimate.discount_amount ?? 0),
                }}
                orgLaborRate={org?.labor_rate ?? 0}
                orgOverheadMode={org?.overhead_mode ?? 'PERCENTAGE'}
                orgOverheadValue={org?.overhead_value ?? 0}
                canEditNow={canEditNow}
              />
            )}
            <EstimateInfoCard estimate={estimate} />
            {(showWaive || showRefund) && (
              <div className="rounded-card border border-border bg-surface-light p-4 shadow-card">
                {/* eyebrow style, no matching Heading variant - left raw */}
                <h4 className="mb-2 text-xs font-bold uppercase tracking-wide text-text-secondary">
                  Deposit Actions
                </h4>
                <div className="flex flex-col gap-2">
                  {showWaive && (
                    <Button variant="outline" size="sm" onClick={() => setWaiveOpen(true)}>
                      Waive deposit
                    </Button>
                  )}
                  {showRefund && (
                    <Button variant="outline" size="sm" onClick={() => setRefundOpen(true)}>
                      Refund deposit
                    </Button>
                  )}
                </div>
              </div>
            )}
            {id && <NotesCard estimateId={id} />}
          </div>
        </aside>
      </div>

      <AttachmentsSignaturesCard estimateId={id!} signatureData={estimate.signature_data} signatureAt={estimate.signature_at} />

      <div className="mt-4">
        <JobLeadTasksTab entity={{ type: 'ESTIMATE', id: id!, label: estimate.estimate_number }} />
      </div>

      <PdfPreviewDialog
        open={previewOpen}
        onOpenChange={setPreviewOpen}
        pdfUrl={`/api/estimates/${id}/pdf`}
        downloadFilename={`Estimate-${estimate.estimate_number}.pdf`}
        title={`Estimate ${estimate.estimate_number}`}
      />
      <MarkSentDialog
        open={markSentOpen}
        onOpenChange={setMarkSentOpen}
        estimateId={id!}
        estimateNumber={estimate.estimate_number}
        totalAmount={totalAmount}
        depositType={estimate.deposit_type ?? null}
        depositValue={estimate.deposit_value ?? null}
        onSuccess={() => queryClient.invalidateQueries({ queryKey: ['estimate', id] })}
      />
      <DeclineEstimateInternalDialog
        open={declineInternalOpen}
        onOpenChange={setDeclineInternalOpen}
        estimateId={id!}
        estimateNumber={estimate.estimate_number}
      />
      <VoidApprovalDialog
        open={voidApprovalOpen}
        onOpenChange={setVoidApprovalOpen}
        estimateId={id!}
        estimateNumber={estimate.estimate_number}
        jobNumber={estimate.job?.job_number ?? null}
      />
      <SendEstimateDialog
        open={sendOpen}
        onOpenChange={setSendOpen}
        estimateId={id!}
        estimateNumber={estimate.estimate_number}
        totalAmount={totalAmount}
        customerEmail={customerEmail}
        alreadySent={isSent}
        sentAt={estimate.sent_at}
        depositType={estimate.deposit_type ?? null}
        depositValue={estimate.deposit_value ?? null}
        depositFrozen={Boolean(sc)}
        existingDepositAmount={sc?.deposit_amount ?? null}
        existingDepositPercentage={sc?.deposit_percentage ?? null}
        onSuccess={() => queryClient.invalidateQueries({ queryKey: ['estimate', id] })}
      />
      <RecordEstimatePaymentDialog
        open={recordPaymentOpen}
        onOpenChange={setRecordPaymentOpen}
        estimateId={id!}
        estimateNumber={estimate.estimate_number}
        totalAmount={totalAmount}
        depositType={estimate.deposit_type ?? null}
        depositValue={estimate.deposit_value ?? null}
        existingDepositAmount={sc?.deposit_amount ?? null}
        existingDepositPercentage={sc?.deposit_percentage ?? null}
      />
      <DuplicateEstimateDialog
        open={duplicateOpen}
        onOpenChange={setDuplicateOpen}
        estimateId={id!}
        currentLeadId={estimate.lead_id ?? null}
        customerId={customerId}
      />
      <CancelEstimateDialog open={cancelOpen} onOpenChange={setCancelOpen} estimateId={id!} />
      <Dialog open={deleteConfirmOpen} onOpenChange={setDeleteConfirmOpen}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>Delete this estimate?</DialogTitle>
            <DialogDescription>
              This permanently removes the estimate and its line items. The lead's other
              estimates are renumbered. This cannot be undone.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeleteConfirmOpen(false)}>
              Cancel
            </Button>
            <Button
              variant="solid" tone="danger"
              disabled={deleteMutation.isPending}
              onClick={() => deleteMutation.mutate()}
            >
              {deleteMutation.isPending ? 'Deleting…' : 'Delete estimate'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      {depositInvoice && (
        <>
          <WaiveDepositDialog
            open={waiveOpen}
            onOpenChange={setWaiveOpen}
            estimateId={id!}
            estimateStatus={status}
            paymentMethod={depMethod}
          />
          <RefundDepositDialog
            open={refundOpen}
            onOpenChange={setRefundOpen}
            estimateId={id!}
            depositInvoiceId={depositInvoice.id}
            depositAmount={Number(depositInvoice.total_amount ?? 0)}
            hasStripePayment={hasStripePayment}
          />
        </>
      )}
      <HistoryPanel open={historyOpen} onClose={() => setHistoryOpen(false)} estimateId={id!} />
      {confirmDialog}
    </div>
  );
}
