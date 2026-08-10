import { useState, useEffect, useRef, type DragEvent as ReactDragEvent } from 'react';
import { useParams, useNavigate, useLocation, Link } from 'react-router-dom';
import { Skeleton } from '@/components/ui/skeleton';
import { UploadedImage } from '@/components/ui/uploaded-image';
import type { BreadcrumbItem } from '@/components/ui/breadcrumb';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import api from '@/lib/axios';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Heading } from '@/components/ui/heading';
import { EmptyState } from '@/components/ui/empty-state';
import { StatusBadge } from '@/components/data/status-badge';
import { TabsContent } from '@/components/ui/tabs';
import { Breadcrumb } from '@/components/ui/breadcrumb';
import { TabStrip } from '@/components/patterns/TabStrip';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  ChevronDown,
  Phone,
  MapPin,
  FileText,
  CalendarDays,
  CalendarPlus,
  CheckCircle2,
  RotateCcw,
  XCircle,
  Trash2,
  Copy,
  Wrench,
  Receipt,
  Pencil,
  AlertTriangle,
  ClipboardList,
  PlusCircle,
  ArrowUpRight,
  User,
} from 'lucide-react';
import { cn, formatCurrency, formatPhone, extractApiError, getInitials } from '@/lib/utils';
import { customerDisplayName } from '@/lib/customer-name';
import { useAuthStore } from '@/stores/auth.store';
import { useAppAbility } from '@/contexts/AbilityContext';
import { useModuleAccess } from '@/lib/entitlements';
import { canOnJob, canSeePricing as canSeePricingAbility, type AppAbility, type AppAction } from '@/lib/ability';
import { useTasksStore } from '@/stores/tasksStore';
import { reopenJob, getJobFinancials, getJobTaskSummary, listJobLines, listJobScopes, createEstimateFromJobItems } from '@/lib/api/jobs';
import { fetchStateTaxRates } from '@/lib/api/invoices';
import { selectInvoiceSentState } from '@/lib/jobs/invoiceSentState';
import { isPaidOff } from '@/lib/jobs/lifecycle';
import { useJobMaterialCost } from '@/lib/api/inventory';
import { useJobSubStatuses } from '@/lib/api/jobSubStatuses';
import { CreateTaskModal } from '@/components/tasks/CreateTaskModal';
import { servicePlanKeys } from '@/lib/api/service-plans';
import { AssignJobDialog } from '@/components/jobs/AssignJobDialog';
import { ViewWorkOrderDialog } from '@/components/jobs/ViewWorkOrderDialog';
import { useOrganization } from '@/lib/api/organization';
import { useScheduleTimezone, formatInstant, orgDayDiff } from '@/lib/schedule-tz';
import { CancelJobDialog } from '@/components/jobs/CancelJobDialog';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { EditJobLocationDialog } from '@/components/jobs/EditJobLocationDialog';
import { CreateJobInvoiceDialog } from '@/components/invoices/CreateJobInvoiceDialog';
import { AttachEstimateDialog } from '@/components/jobs/AttachEstimateDialog';
import { RecordPaymentDialog } from '@/components/invoices/RecordPaymentDialog';
import { IconRail } from '@/components/crm/IconRail';
import { VideoPreviewDialog } from '@/components/ui/VideoPreviewDialog';
import { TagInput } from '@/components/leads/TagInput';
import { JobLeadTasksTab } from '@/components/tasks/JobLeadTasksTab';
import { JobCommunicationsTab } from '@/components/communication/JobCommunicationsTab';
import { JobLifecycleBar } from '@/components/jobs/JobLifecycleBar';
import { TeamCard } from '@/components/jobs/TeamCard';
import { AiInsightsCard } from '@/components/jobs/AiInsightsCard';
import { AiJobAssistantBar } from '@/components/jobs/AiJobAssistantBar';
import { JobStagesSection } from '@/components/jobs/JobStagesSection';
import { LOList } from '@/components/inventory/lo/LOList';
import { LineItemsEditor, JobScopeOfWorkCard } from '@/components/jobs/items/LineItemsEditor';
import { InternalCostsCard } from '@/components/crm/InternalCostsCard';
import { ReceiptCard } from '@/components/jobs/items/ReceiptCard';
import type { InvoiceLineItem } from '@/lib/api/jobs';
import { CustomerContactCard } from '@/components/jobs/overview/CustomerContactCard';
import { SectionCard, SectionLabel } from '@/components/jobs/overview/SectionCard';
import { JobNotesPreview } from '@/components/jobs/overview/JobNotesPreview';
import { ExtraInfoPanel } from '@/components/custom-fields/ExtraInfoPanel';
import { JobFilesCard } from '@/components/jobs/overview/JobFilesCard';
import { PaymentsTab } from '@/components/jobs/PaymentsTab';
import { formatDistanceToNow } from 'date-fns';
import { StickyNote, Image as ImageIcon, FileText as FileTextIcon, Film, Upload } from 'lucide-react';
import { toast } from '@/components/ui/use-toast';
import { useDeleteJobAttachment } from '@/hooks/useDeleteJobAttachment';
import { useConfirm } from '@/hooks/useConfirm';
import { deleteAttachmentPrompt } from '@/lib/confirmPrompts';

// ─── Types ──────────────────────────────────────────

interface EstimateLineItem {
  id: string;
  sequence: number;
  description: string;
  quantity: number;
  unit_price: number;
  is_taxable: boolean;
  line_total: number;
  item_type?: string;
}

interface LeadWalkthrough {
  id: string;
  lead_number: string;
  status: string;
  walkthrough_scheduled_at: string | null;
  walkthrough_completed_at: string | null;
  walkthrough_notes: string | null;
  commission_owner?: { id: string; first_name: string; last_name: string; phone?: string | null; email?: string | null; role?: string | null; department?: { name?: string | null } | null } | null;
  walkthrough_performers: { user: { id: string; first_name: string; last_name: string } }[];
}

interface JobDetail {
  id: string;
  job_number: string;
  status: string;
  // Creation confers control (technician-ownership spec, Part C): canOnJob reads this to decide
  // whether to OFFER the creator-only actions - line items, assign/unassign, delete. Null on rows
  // written before creator tracking, which canOnJob treats as "not the creator".
  created_by_id?: string | null;
  // SRVW-112 - the org-defined label under `status`, always parented to the CURRENT status.
  sub_status?: { id: string; label: string; parent: string } | null;
  job_type?: string | null;
  amount_invoiced?: number | string;
  scope_notes: string | null;
  estimated_duration: number | null;
  completion_notes: string | null;
  scheduled_start: string | null;
  scheduled_end: string | null;
  is_all_day?: boolean;
  started_at: string | null;
  on_site_at: string | null;
  completed_at: string | null;
  cancelled_at: string | null;
  cancelled_reason: string | null;
  created_at: string;
  updated_at: string;
  signature_at: string | null;
  dispatcher?: { id: string; first_name: string; last_name: string; phone?: string | null; email?: string | null; role?: string | null; department?: { name?: string | null } | null } | null;
  customer: {
    id: string;
    first_name: string;
    last_name: string;
    company_name: string | null;
    email: string | null;
    phone: string;
  };
  // Job crew (M2M). Legacy single-assignee FK dropped in TG7.
  assignees: { user: { id: string; first_name: string; last_name: string; phone?: string | null; email?: string | null; role?: string | null; department?: { name?: string | null } | null } }[];
  service_location: {
    id: string;
    address_line1: string;
    address_line2: string | null;
    city: string;
    state: string;
    zip: string;
  } | null;
  estimate: {
    id: string;
    estimate_number: string;
    total_amount: number | string;
    status: string;
    lead_id: string | null;
    lead: LeadWalkthrough | null;
    deposit: { id: string; amount: number | string; status: string; paid_at: string | null } | null;
    line_items: EstimateLineItem[];
  } | null;
  invoices: Array<{ id: string; invoice_number: string; status: string; total_amount: number | string; amount_due: number | string; created_at: string }>;
  // SRVW-96 - estimates attached to this job (R6 EstimateJobLink) that are NOT the provenance
  // `estimate` above. Optional so existing fixtures that omit it still typecheck. total_amount is
  // optional too - stripJobPricingForRequester removes it for a price-blind requester.
  linked_estimates?: Array<{ id: string; estimate_number: string; total_amount?: number | string; status: string }>;
  tags: Array<{ id: string; name: string; color: string }>;
  // Service-plan provenance: when set, this job is a (non-billable) plan visit.
  source_plan_id: string | null;
  source_plan: { id: string; service_plan_number: string; name: string } | null;
  // R3b (2026-07-21) — cost model (D2/D8), staff-only (stripped for non-privileged viewers).
  labor_hours?: number | string | null;
  overhead_mode?: 'PERCENTAGE' | 'FIXED' | null;
  overhead_value?: number | string | null;
  // Custom fields (SRVW-114 slice 1) - { "<definition-uuid>": <scalar> }, TEXT only this slice.
  custom_fields?: Record<string, unknown> | null;
}

// ─── Helpers ────────────────────────────────────────

// Ability gates WHO; status gates WHEN. Spec B1 removes the status half — leave those
// conditions exactly as they are here so the two specs stay separable.
//
// Role strings are deliberately gone: a technician's authority now comes from the same CASL
// rules the API enforces, so the button set and the API can no longer disagree. Use canOnJob,
// never ability.can(verb, jobInstance) — see the comment on canOnJob for why.
function getAvailableActions(job: JobDetail, ability: AppAbility, userId: string) {
  const on = (verb: AppAction) => canOnJob(ability, verb, job, userId);

  return {
    // Status is no longer an ordering gate here (Spec B1) — ability gates who, not when.
    canAssign: on('assign'),
    canUnassign: on('unassign'),
    // Spec A's canOnJob('arrive', ...) has shipped now — no longer a same-tier placeholder.
    canArrive: on('arrive'),
    canStart: on('start'),
    // Self-exclusion, not an ordering rule: offering "Mark Complete" on an already-complete job
    // is a no-op that would re-stamp completed_at and re-arm the follow-up automation for nothing.
    canComplete: on('complete') && job.status !== 'COMPLETED',
    // Self-exclusion, not an ordering rule: cancelling an already-cancelled job is a no-op.
    canCancel: on('cancel') && job.status !== 'CANCELLED',
    // Invoice-only guard now (matches the backend's job.controller.ts delete guard, which blocks
    // on any invoice regardless of status — a voided-only invoice set no longer passes either).
    canDelete: on('delete') && job.invoices.length === 0,
    canReopen: ability.can('reopen', 'Job') && job.status === 'COMPLETED',
    canDuplicate: ability.can('create', 'Job'),
    // `update Job` is the API gate on POST /api/jobs/:id/notes, so the button now matches it.
    canAddNotes: on('update'),
    // The money surface follows CREATION, not assignment. Same per-instance question the backend
    // asks with canActOnRow(..., 'manage_lines'), so the buttons and the API agree.
    canManageLines: on('manage_lines'),
    // SRVW-112 - same `update Job` gate the API puts on POST /api/jobs/:id/sub-status.
    canSetSubStatus: on('update'),
    // Service-plan visit-jobs were paid upfront via the plan's kind=PLAN invoice — invoicing the
    // spawned visit would double-charge (the backend also blocks it). Hide the action for them.
    canCreateInvoice: ability.can('create', 'Invoice') && job.status !== 'CANCELLED' && !job.source_plan_id,
  };
}

/** The shape bare `toLocaleString('en-US')` produced on the lifecycle stamps below
 *  ("8/5/2026, 9:00:00 PM"), spelled out so forcing the org zone does not also restyle them. */
const FULL_DATE_TIME: Intl.DateTimeFormatOptions = {
  year: 'numeric', month: 'numeric', day: 'numeric',
  hour: 'numeric', minute: '2-digit', second: '2-digit',
};

/** Relative schedule hint: "Today", "Tomorrow", "in N days", or date string.
 *  "Today" means today on the COMPANY's calendar - an evening job is still today for the
 *  whole crew, including a dispatcher whose own date has already rolled over. */
function scheduleHint(dateStr: string, tz: string): string {
  const dayDiff = orgDayDiff(dateStr, tz);
  if (dayDiff === 0) return 'Today';
  if (dayDiff === 1) return 'Tomorrow';
  if (dayDiff > 1) return `in ${dayDiff} days`;
  return formatInstant(dateStr, tz, { year: 'numeric', month: 'numeric', day: 'numeric' });
}

// ─── Attachments Tab Body ───────────────────────────

interface AttachmentItem {
  id: string;
  file_name: string;
  file_url: string;
  file_type: string;
  display_name: string;
  description?: string | null;
  context?: string | null;
  source?: string | null;
}

function AttachmentTile({
  att,
  onDelete,
  deleting,
}: {
  att: AttachmentItem;
  onDelete?: (att: AttachmentItem) => void;
  deleting?: boolean;
}) {
  const isImage = att.file_type.startsWith('image/');
  const isVideo = att.file_type.startsWith('video/');
  const [videoUrl, setVideoUrl] = useState<string | null>(null);
  return (
    <>
      {/* `group` + `relative` live on this wrapper, not on the `<a>`, so the delete control is a
          SIBLING of the link rather than a button nested inside an anchor (invalid interactive
          nesting, and its click would have to fight the link's own navigation). */}
      <div className="group relative overflow-hidden rounded-xl border border-border bg-surface-light transition-all hover:border-primary/40 hover:shadow-card">
        <a
          href={att.file_url}
          target="_blank"
          rel="noopener noreferrer"
          download={isImage ? undefined : att.file_name || att.display_name}
          className="block"
          onClick={(e) => {
            if (isVideo) {
              e.preventDefault();
              setVideoUrl(att.file_url);
            }
          }}
        >
          {isImage ? (
            <UploadedImage
              src={att.file_url}
              alt={att.display_name}
              backdrop
              className="h-28 w-full"
              imgClassName="transition-transform duration-200 group-hover:scale-[1.03]"
            />
          ) : (
            <div className="flex h-28 w-full items-center justify-center bg-background-light text-text-secondary">
              {isVideo ? <Film className="h-6 w-6" /> : <FileTextIcon className="h-6 w-6" />}
            </div>
          )}
          {(att.source === 'WALKTHROUGH' || att.context === 'WALKTHROUGH') && (
            <span className="absolute left-1 top-1 rounded-full bg-info/10 px-1.5 py-0.5 text-[9px] font-semibold uppercase text-info">
              Walkthrough
            </span>
          )}
          <div className="px-2 py-1.5">
            <p className="text-[11px] font-medium text-text-primary truncate">{att.display_name}</p>
            {att.description && (
              <p className="text-[10px] text-text-secondary truncate" title={att.description}>
                {att.description}
              </p>
            )}
          </div>
        </a>
        {onDelete && (
          // The pill chrome and the hover-reveal live on this WRAPPER, not in the Button's
          // className: per the layering guard, a primitive's appearance is decided inside the
          // primitive. The chrome belongs to the wrapper anyway - it exists to lift the control
          // off the photo underneath it, which is a property of the tile, not of the button.
          <div className="absolute right-1 top-1 overflow-hidden rounded-full bg-surface-light/90 opacity-0 shadow ring-1 ring-border transition-opacity focus-within:opacity-100 group-hover:opacity-100">
            <Button
              variant="ghost"
              tone="danger"
              revealOnHover
              size="icon"
              disabled={deleting}
              onClick={() => onDelete(att)}
              aria-label={`Delete ${att.display_name}`}
              title="Delete attachment"
              className="h-6 w-6"
            >
              <Trash2 className="h-3.5 w-3.5" />
            </Button>
          </div>
        )}
      </div>
      <VideoPreviewDialog url={videoUrl} onClose={() => setVideoUrl(null)} />
    </>
  );
}

export function AttachmentsTabBody({
  jobId,
  attachments,
}: {
  jobId: string;
  attachments: AttachmentItem[] | undefined;
}) {
  const queryClient = useQueryClient();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const dropZoneInputRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);
  const [isDragging, setIsDragging] = useState(false);
  const deleteAttachment = useDeleteJobAttachment(jobId);
  const { confirm, confirmDialog } = useConfirm();

  const handleDelete = async (att: AttachmentItem) => {
    if (await confirm(deleteAttachmentPrompt(att.display_name))) {
      deleteAttachment.mutate(att.id);
    }
  };

  const handleUpload = async (files: FileList | null) => {
    if (!files || files.length === 0) return;
    setUploading(true);
    try {
      for (const file of Array.from(files)) {
        const formData = new FormData();
        formData.append('file', file);
        formData.append('display_name', file.name.replace(/\.[^/.]+$/, ''));
        formData.append('description', '');
        formData.append('context', 'JOB_WORK');
        await api.post(`/api/attachments/job/${jobId}`, formData, {
          headers: { 'Content-Type': 'multipart/form-data' },
        });
      }
      queryClient.invalidateQueries({ queryKey: ['job-attachments-wt', jobId] });
      queryClient.invalidateQueries({ queryKey: ['attachments', 'JOB', jobId] });
    } catch (err) {
      toast({
        variant: 'destructive',
        title: 'Upload failed',
        description: extractApiError(err as Error, 'Could not upload the file. Please try again.'),
      });
    } finally {
      setUploading(false);
      if (fileInputRef.current) fileInputRef.current.value = '';
      if (dropZoneInputRef.current) dropZoneInputRef.current.value = '';
    }
  };

  const handleDrop = (e: ReactDragEvent) => {
    e.preventDefault();
    setIsDragging(false);
    handleUpload(e.dataTransfer.files);
  };

  const all = attachments ?? [];

  const photos = all.filter(
    (a) => a.file_type.startsWith('image/') && a.source !== 'WALKTHROUGH' && a.context !== 'WALKTHROUGH'
  );
  const walkthroughPhotos = all.filter(
    (a) => a.file_type.startsWith('image/') && (a.source === 'WALKTHROUGH' || a.context === 'WALKTHROUGH')
  );
  const docs = all.filter(
    (a) => !a.file_type.startsWith('image/') && a.source !== 'WALKTHROUGH' && a.context !== 'WALKTHROUGH'
  );
  const walkthroughDocs = all.filter(
    (a) => !a.file_type.startsWith('image/') && (a.source === 'WALKTHROUGH' || a.context === 'WALKTHROUGH')
  );

  const walkthrough = [...walkthroughPhotos, ...walkthroughDocs];

  const uploadControl = (
    <>
      <input
        ref={fileInputRef}
        type="file"
        multiple
        className="hidden"
        id="attachments-tab-upload"
        onChange={(e) => handleUpload(e.target.files)}
      />
      {/* Not a FormField target: this label wraps a Button trigger for a hidden
          file input, not description text for a visible field - no hint/error/
          required concept applies, same shape as the drop-zone label below. */}
      <label htmlFor="attachments-tab-upload">
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={uploading}
          className="cursor-pointer"
          onClick={() => fileInputRef.current?.click()}
        >
          <Upload className="h-3.5 w-3.5 mr-1.5" />
          {uploading ? 'Uploading…' : 'Upload'}
        </Button>
      </label>
    </>
  );

  if (all.length === 0) {
    return (
      <SectionCard
        title="Attachments"
        icon={<ImageIcon className="h-4 w-4 text-text-secondary" />}
        meta={uploadControl}
      >
        {/* Self-contained drop-zone: its own hidden input (implicit label
            association — no htmlFor) so the header Upload button + its input
            keep working independently, with no duplicate DOM ids. */}
        <label
          onDragOver={(e) => {
            e.preventDefault();
            setIsDragging(true);
          }}
          onDragLeave={() => setIsDragging(false)}
          onDrop={handleDrop}
          className={cn(
            'flex cursor-pointer flex-col items-center rounded-lg border-2 border-dashed py-12 text-center transition-colors',
            isDragging
              ? 'border-primary bg-primary-subtle'
              : 'border-border hover:border-primary/50 hover:bg-background-light'
          )}
        >
          <input
            ref={dropZoneInputRef}
            type="file"
            multiple
            className="hidden"
            id="attachments-empty-drop-zone-upload"
            onChange={(e) => handleUpload(e.target.files)}
          />
          <ImageIcon className="mb-2 h-8 w-8 text-text-secondary/30" />
          <p className="text-sm font-medium text-text-primary">
            Drag &amp; drop files here, or click to upload
          </p>
          <p className="mt-1 text-xs text-text-secondary">
            {uploading ? 'Uploading…' : 'No attachments yet'}
          </p>
        </label>
      </SectionCard>
    );
  }

  return (
    <SectionCard
      title="Attachments"
      icon={<ImageIcon className="h-4 w-4 text-text-secondary" />}
      meta={uploadControl}
      bodyClassName="space-y-6"
    >
      {photos.length > 0 && docs.length > 0 ? (
        // Both present → Photos and Documents sit side-by-side to save vertical
        // space (instead of two stacked full-width rows). Each column scrolls the
        // whole set — nothing is capped, so 20+ items all render.
        <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
          <div>
            <SectionLabel>Photos ({photos.length})</SectionLabel>
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
              {photos.map((a) => (
                <AttachmentTile key={a.id} att={a} onDelete={handleDelete} deleting={deleteAttachment.isPending} />
              ))}
            </div>
          </div>
          <div>
            <SectionLabel>Documents ({docs.length})</SectionLabel>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              {docs.map((a) => (
                <AttachmentTile key={a.id} att={a} onDelete={handleDelete} deleting={deleteAttachment.isPending} />
              ))}
            </div>
          </div>
        </div>
      ) : (
        <>
          {photos.length > 0 && (
            <div>
              <SectionLabel>Photos ({photos.length})</SectionLabel>
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4">
                {photos.map((a) => (
                  <AttachmentTile key={a.id} att={a} onDelete={handleDelete} deleting={deleteAttachment.isPending} />
                ))}
              </div>
            </div>
          )}
          {docs.length > 0 && (
            <div>
              <SectionLabel>Documents ({docs.length})</SectionLabel>
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4">
                {docs.map((a) => (
                  <AttachmentTile key={a.id} att={a} onDelete={handleDelete} deleting={deleteAttachment.isPending} />
                ))}
              </div>
            </div>
          )}
        </>
      )}

      {walkthrough.length > 0 && (
        <div>
          <SectionLabel>From walkthrough ({walkthrough.length})</SectionLabel>
          {/* No `onDelete` here on purpose: these files belong to the LEAD and are only forwarded
              in via `include_walkthrough=true`, so deleting one from the job would remove it from
              the lead too. They stay deletable on the lead, where they actually live. */}
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4">
            {walkthrough.map((a) => (
              <AttachmentTile key={a.id} att={a} />
            ))}
          </div>
        </div>
      )}
      {confirmDialog}
    </SectionCard>
  );
}

// ─── Notes Tab Body ──────────────────────────────────

interface NoteItem {
  id: string;
  content: string;
  created_at: string;
  creator: { id: string; first_name: string; last_name: string };
  source?: string | null;
}

function NotesTabBody({
  jobId,
  notes,
}: {
  jobId: string;
  notes: NoteItem[] | undefined;
}) {
  const queryClient = useQueryClient();
  const [noteContent, setNoteContent] = useState('');

  const addNoteMutation = useMutation({
    mutationFn: async (content: string) => {
      const { data } = await api.post(`/api/jobs/${jobId}/notes`, { content });
      return data.note;
    },
    onSuccess: () => {
      setNoteContent('');
      queryClient.invalidateQueries({ queryKey: ['job-notes-wt', jobId] });
      queryClient.invalidateQueries({ queryKey: ['notes', 'JOB', jobId] });
    },
  });

  const allNotes = [...(notes ?? [])].sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());

  return (
    <div className="p-5 space-y-5">
      {/* Composer */}
      <SectionCard title="Add note" icon={<StickyNote className="h-4 w-4 text-text-secondary" />}>
        <div className="space-y-2">
          <textarea
            value={noteContent}
            onChange={(e) => setNoteContent(e.target.value)}
            onKeyDown={(e) => {
              if (
                (e.metaKey || e.ctrlKey) &&
                e.key === 'Enter' &&
                noteContent.trim() &&
                !addNoteMutation.isPending
              ) {
                e.preventDefault();
                addNoteMutation.mutate(noteContent.trim());
              }
            }}
            placeholder="Write a note…"
            rows={3}
            className="w-full rounded-lg border border-border bg-surface-light px-3 py-2 text-sm text-text-primary placeholder:text-text-secondary/60 focus:outline-none focus:ring-2 focus:ring-primary/40 resize-none"
          />
          <div className="flex items-center justify-between">
            <span className="text-[11px] text-text-secondary/70">⌘↵ to add</span>
            <Button
              variant="solid" tone="business"
              size="sm"
              disabled={!noteContent.trim() || addNoteMutation.isPending}
              onClick={() => addNoteMutation.mutate(noteContent.trim())}
            >
              {addNoteMutation.isPending ? 'Adding…' : 'Add Note'}
            </Button>
          </div>
          {addNoteMutation.error && <p className="text-xs text-danger">Failed to add note</p>}
        </div>
      </SectionCard>

      {/* Full notes feed */}
      <SectionCard
        title="Notes"
        titleSuffix={<span className="ml-1 font-normal text-text-secondary">({allNotes.length})</span>}
        bodyClassName="p-0"
      >
        {allNotes.length === 0 ? (
          <EmptyState icon={StickyNote} title="No notes yet" />
        ) : (
          <div className="divide-y divide-border">
            {allNotes.map((note) => (
              <div key={note.id} className="flex gap-3 px-5 py-4">
                <span className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-primary-subtle text-[11px] font-bold text-primary">
                  {getInitials(`${note.creator.first_name} ${note.creator.last_name}`)}
                </span>
                <div className="min-w-0 flex-1">
                  <div className="mb-1 flex items-center gap-2">
                    <span className="text-sm font-semibold text-text-primary">
                      {note.creator.first_name} {note.creator.last_name}
                    </span>
                    {note.source === 'WALKTHROUGH' && (
                      <span className="rounded-full bg-info/10 px-1.5 py-0.5 text-[10px] font-medium text-info">
                        From Walkthrough
                      </span>
                    )}
                    <span className="ml-auto whitespace-nowrap text-[11px] text-text-secondary">
                      {formatDistanceToNow(new Date(note.created_at), { addSuffix: true })}
                    </span>
                  </div>
                  <p className="whitespace-pre-wrap break-words text-sm leading-relaxed text-text-primary">
                    {note.content}
                  </p>
                </div>
              </div>
            ))}
          </div>
        )}
      </SectionCard>
    </div>
  );
}

function toNum(v: number | string | null | undefined): number {
  if (v == null) return 0;
  const n = typeof v === 'string' ? parseFloat(v) : v;
  return Number.isNaN(n) ? 0 : n;
}

/** Net-of-line-discount revenue for one job line — mirrors InvoiceReceiptCard's/InternalCostsCard's own `netOf`. */
function netOf(line: InvoiceLineItem): number {
  return Math.max(0, toNum(line.line_total) - toNum(line.discount_amount));
}

// ─── Component ──────────────────────────────────────

export default function JobDetailPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const location = useLocation();
  const queryClient = useQueryClient();
  const user = useAuthStore((s) => s.user);
  // Every time on this page is the COMPANY's clock, not the viewer's. Prod job 698675 read
  // 9:00 PM to its New York owner and 9:00 AM to its Manila dispatcher off one stored instant.
  const timezone = useScheduleTimezone();
  const ability = useAppAbility();
  // Cost/margin visibility for <InternalCostsCard> — shared with the backend's canSeePricing
  // gate (SRVW-140), see lib/ability.ts.
  const canSeePricing = canSeePricingAbility(ability);
  // D15 — the material-cost endpoint 403s without read PurchaseOrder (inv-po.routes
  // gate); the enabled guard below prevents the fetch for Sales/Technician rather
  // than swallowing errors.
  //
  // useModuleAccess, not ability.can: inv-po.routes also carries
  // requireFeature('inventory'), and CASL alone lets an admin on a sub-Scale plan
  // through - the fetch then 402s. Inventory is a Scale module; Jobs is not, and
  // must not be degraded by it.
  const canReadPO = useModuleAccess('inventory', 'read', 'PurchaseOrder');
  // Logistics (Logistic Orders + job stages) is entirely inventory-module surface.
  const canUseInventory = useModuleAccess('inventory', 'read', 'Inventory');
  const incomingBreadcrumbs: BreadcrumbItem[] | undefined = location.state?.breadcrumbs;

  // Tab state (controlled so CustomerContactCard's "View All" can switch to communication)
  const [activeTab, setActiveTab] = useState('overview');

  // Dialog states
  const [assignOpen, setAssignOpen] = useState(false);
  // Drives AssignJobDialog's copy: 'assign' from the crew-focused triggers (Actions >
  // Assign, TeamCard), 'schedule' from the date/time-focused ones (Actions > Schedule
  // Job/Reschedule, the schedule tile, the timeline node) - same dialog body either way.
  const [assignMode, setAssignMode] = useState<'assign' | 'schedule'>('assign');
  const openAssignDialog = (mode: 'assign' | 'schedule') => { setAssignMode(mode); setAssignOpen(true); };
  const [cancelOpen, setCancelOpen] = useState(false);
  const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false);
  const [editLocationOpen, setEditLocationOpen] = useState(false);
  const [createInvoiceOpen, setCreateInvoiceOpen] = useState(false);
  const [newTaskOpen, setNewTaskOpen] = useState(false);
  const [workOrderOpen, setWorkOrderOpen] = useState(false);
  const [editingServiceType, setEditingServiceType] = useState(false);
  const [invoiceSentOpen, setInvoiceSentOpen] = useState(false);
  const [attachEstimateOpen, setAttachEstimateOpen] = useState(false);
  const [paymentReceivedOpen, setPaymentReceivedOpen] = useState(false);
  const { data: org } = useOrganization();

  // ─── Queries ────────────────────────────────────

  const { data: job, isLoading } = useQuery({
    queryKey: ['job', id],
    queryFn: async () => {
      const { data } = await api.get(`/api/jobs/${id}`);
      return data.job as JobDetail;
    },
  });

  const { data: financials } = useQuery({
    queryKey: ['job-financials', id],
    queryFn: () => getJobFinancials(id!),
    enabled: !!id,
  });

  const { data: taskSummary } = useQuery({
    queryKey: ['job-task-summary', id],
    queryFn: () => getJobTaskSummary(id!),
    enabled: !!id,
  });

  // SERV10X-38: job-owned line items + the running billing preview (Total/Invoiced/Remaining)
  // for JobBillingSummary. Shares its queryKey with LineItemsEditor's own fetch (Items tab),
  // so mounting both only issues one network request.
  const { data: jobLineItemsData } = useQuery({
    queryKey: ['job-line-items', id],
    queryFn: () => listJobLines(id!),
    enabled: !!id,
  });

  // The page already fetches this for JobBillingSummary — reuse it, do not add a second query.
  const billableLineCount = jobLineItemsData?.lines?.length ?? 0;
  const invoiceSent = selectInvoiceSentState(financials, billableLineCount);
  // Final-review fix: once the job is fully paid off, Payment Received must stop being
  // clickable — there is no "view" action for it (unlike invoice_sent's State 1), so leaving it
  // interactive only invites an accidental extra RecordPaymentDialog payment. Reuse
  // computeLifecycle's own isPaidOff signal directly rather than re-deriving the
  // hasTotals/fallback logic here.
  const jobPaidOff = isPaidOff(financials);
  // Conservative deposit check (Task 7): a paid DEPOSIT invoice means credit may still be
  // unspent, and the composite create-then-pay path would consume it. The precise "unspent"
  // figure needs the fenced customer-credit work; a paid deposit at all is the safe proxy.
  const hasUnspentDeposit = (financials?.invoices ?? []).some(
    (i) => i.kind === 'DEPOSIT' && i.status === 'PAID',
  );

  // Scope-of-work blocks for <InternalCostsCard>'s cost/margin rollup. Shares its queryKey with
  // <JobScopeOfWorkCard>'s own fetch (same convention as jobLineItemsData/LineItemsEditor above),
  // so mounting both only issues one network request.
  const { data: jobScopesData } = useQuery({
    queryKey: ['job-scopes', id],
    queryFn: () => listJobScopes(id!),
    enabled: !!id,
  });

  // D15 — PO material actuals for <InternalCostsCard>'s additive display row.
  const { data: materialCost } = useJobMaterialCost(id, canSeePricing && canReadPO);

  // E1 (job-owns-tax-discount) - jurisdiction options for the Items tab's Tax rate row, editable
  // when the requester can manage the job and see pricing (see canManageJob below).
  const { data: jobTaxRates = [] } = useQuery({
    queryKey: ['state-tax-rates'],
    queryFn: fetchStateTaxRates,
    enabled: canSeePricing,
    staleTime: 60 * 60 * 1000,
  });

  // ─── Invalidate job-task-summary after any task mutation ────────────────
  // Derive a stable fingerprint from the slice of tasks linked to this job:
  // a sorted comma-joined string of "<id>:<status>:<updated_at>" tuples.
  // This changes only when tasks are added, removed, or their status/update
  // changes — never when an unrelated task is mutated — and avoids the
  // infinite-loop that array-identity comparison (.filter() → always new ref)
  // would cause on every re-render.
  const jobTasksFingerprint = useTasksStore((s) =>
    s.tasks
      .filter((t) => t.linked_entity?.id === id)
      .map((t) => `${t.id}:${t.status}:${t.updated_at}`)
      .sort()
      .join(','),
  );
  const prevFingerprintRef = useRef<string | undefined>(undefined);
  useEffect(() => {
    // Skip the very first render (prevFingerprintRef is undefined on mount)
    if (prevFingerprintRef.current === undefined) {
      prevFingerprintRef.current = jobTasksFingerprint;
      return;
    }
    if (prevFingerprintRef.current !== jobTasksFingerprint && id) {
      queryClient.invalidateQueries({ queryKey: ['job-task-summary', id] });
    }
    prevFingerprintRef.current = jobTasksFingerprint;
  }, [jobTasksFingerprint, id, queryClient]);

  // Overview tab: attachments (with walkthrough) for JobFilesCard + AiInsightsCard
  const { data: attachmentsData } = useQuery({
    queryKey: ['job-attachments-wt', id],
    queryFn: () =>
      api
        .get(`/api/attachments/JOB/${id}?include_walkthrough=true`)
        .then((r) => r.data.attachments as Array<{ id: string; file_name: string; file_url: string; file_type: string; display_name: string; description?: string | null; context?: string | null; source?: string | null }>),
    enabled: !!id,
  });

  // Overview tab: notes (with walkthrough) for JobNotesPreview
  const { data: notesData } = useQuery({
    queryKey: ['job-notes-wt', id],
    queryFn: () =>
      api
        .get(`/api/jobs/${id}/notes?include_walkthrough=true`)
        .then((r) => r.data.notes as Array<{ id: string; content: string; created_at: string; creator: { id: string; first_name: string; last_name: string }; source?: string | null }>),
    enabled: !!id,
  });

  // SRVW-112 - the org's sub-status catalog. Called unconditionally (hook rules); the header
  // filters it down to the labels parented to this job's CURRENT status.
  const { data: subStatuses } = useJobSubStatuses();

  // ─── Mutations ──────────────────────────────────

  const invalidateJob = () => {
    queryClient.invalidateQueries({ queryKey: ['job', id] });
    queryClient.invalidateQueries({ queryKey: ['jobs'] });
    queryClient.invalidateQueries({ queryKey: ['job-timeline', id] });
    queryClient.invalidateQueries({ queryKey: ['job-task-summary', id] });
    queryClient.invalidateQueries({ queryKey: servicePlanKeys.bucket });
    queryClient.invalidateQueries({ queryKey: ['job-financials', id] });
    queryClient.invalidateQueries({ queryKey: ['job-line-items', id] });
  };

  const deleteMutation = useMutation({
    mutationFn: async () => {
      await api.delete(`/api/jobs/${id}`);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['jobs'] });
      navigate('/jobs');
    },
  });

  const reopenMutation = useMutation({
    mutationFn: async () => reopenJob(id!),
    onSuccess: invalidateJob,
  });

  // One-click close-out — no completion-note modal (a note isn't required to complete).
  const completeMutation = useMutation({
    mutationFn: async () => api.post(`/api/jobs/${id}/complete`),
    onSuccess: () => {
      invalidateJob();
    },
    onError: (err) => {
      toast({ title: extractApiError(err, 'Failed to complete job'), variant: 'destructive' });
    },
  });

  // Lifecycle bar node clicks (Spec B1 Task 8).
  const arriveMutation = useMutation({
    mutationFn: async () => api.post(`/api/jobs/${id}/arrive`),
    onSuccess: invalidateJob,
    onError: (err) => {
      toast({ title: extractApiError(err, 'Failed to mark on site'), variant: 'destructive' });
    },
  });

  const startMutation = useMutation({
    mutationFn: async () => api.post(`/api/jobs/${id}/start`),
    onSuccess: invalidateJob,
    onError: (err) => {
      toast({ title: extractApiError(err, 'Failed to start job'), variant: 'destructive' });
    },
  });

  // Navigate to a freshly-created invoice, carrying the job breadcrumb trail.
  // Shared by both Create-Invoice paths: the one-click (estimate snapshot) mutation
  // and the from-scratch line-authoring dialog (jobs with no estimate). (#224 restores 78305e4d)
  const goToInvoice = (invoiceId: string) => {
    queryClient.invalidateQueries({ queryKey: ['job', id] });
    navigate(`/invoices/${invoiceId}`, {
      state: {
        breadcrumbs: [
          { label: 'Jobs', href: '/jobs' },
          { label: job!.job_number, href: `/jobs/${id}` },
        ],
      },
    });
  };

  const duplicateMutation = useMutation({
    mutationFn: () => api.post(`/api/jobs/${id}/duplicate`).then((r) => r.data),
    onSuccess: (data: { job: { id: string } }) => {
      queryClient.invalidateQueries({ queryKey: ['jobs'] });
      navigate(`/jobs/${data.job.id}`);
    },
    onError: (err) => {
      toast({ title: extractApiError(err, 'Failed to duplicate job'), variant: 'destructive' });
    },
  });

  const updateJobTypeMutation = useMutation({
    mutationFn: (job_type: string) => api.patch(`/api/jobs/${id}`, { job_type }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['job', id] });
      setEditingServiceType(false);
    },
    onError: (err) => {
      toast({ title: extractApiError(err, 'Failed to update service type'), variant: 'destructive' });
    },
  });

  // SRVW-112 - set or clear the sub-status. Its own door (POST /:id/sub-status), not a PATCH key.
  const subStatusMutation = useMutation({
    mutationFn: (sub_status_id: string | null) =>
      api.post(`/api/jobs/${id}/sub-status`, { sub_status_id }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['job', id] }),
    onError: (err) => {
      toast({ title: extractApiError(err, 'Failed to set sub-status'), variant: 'destructive' });
    },
  });

  // R3b (2026-07-21) — cost model (D2/D8). Same PATCH /api/jobs/:id shape as updateJobTypeMutation.
  const costMutation = useMutation({
    mutationFn: (body: Record<string, unknown>) => api.patch(`/api/jobs/${id}`, body),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['job', id] }),
    onError: (err) => {
      toast({ title: extractApiError(err, 'Could not save'), variant: 'destructive' });
    },
  });

  // E1/E2 (job-owns-tax-discount) - same PATCH /api/jobs/:id door as costMutation, but the
  // Items tab's rendered tax/discount figures come from the SEPARATE job-line-items billing
  // endpoint (jobLineItemsData.billing), so this also invalidates that query - costMutation
  // doesn't need to since labor_hours/overhead never feed that response.
  const taxDiscountMutation = useMutation({
    mutationFn: (body: Record<string, unknown>) => api.patch(`/api/jobs/${id}`, body),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['job', id] });
      queryClient.invalidateQueries({ queryKey: ['job-line-items', id] });
    },
    onError: (err) => {
      toast({ title: extractApiError(err, 'Could not save'), variant: 'destructive' });
    },
  });

  // SRVW-114 slice 1 - Extra Info panel's custom-field values. Same generic-body PATCH
  // shape as taxDiscountMutation/costMutation.
  const customFieldsMutation = useMutation({
    mutationFn: (body: Record<string, unknown>) => api.patch(`/api/jobs/${id}`, body),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['job', id] }),
    onError: (err) => {
      toast({ title: extractApiError(err, 'Could not save'), variant: 'destructive' });
    },
  });

  // SERV10X-60 Part B (job-items-estimate-parity) - copies the job's OWN line items/scopes into
  // a NEW job-anchored estimate; tax/discount are server-derived (D1/D2), no dialog input needed.
  // Navigates straight to the new estimate, same as clicking "View estimate" on an existing one.
  const createEstimateMutation = useMutation({
    mutationFn: () => createEstimateFromJobItems(id!),
    onSuccess: ({ estimate }) => {
      queryClient.invalidateQueries({ queryKey: ['job', id] });
      toast({ title: `Estimate ${estimate.estimate_number} created` });
      navigate(`/estimates/${estimate.id}`);
    },
    onError: (err) => {
      toast({ title: extractApiError(err, 'Failed to create estimate'), variant: 'destructive' });
    },
  });

  // ─── Loading / Error States ─────────────────────

  if (isLoading) {
    return (
      <div className="space-y-4">
        <div className="flex items-center gap-1.5">
          <Skeleton className="h-4 w-4" />
          <Skeleton className="h-4 w-12" />
          <Skeleton className="h-3 w-3" />
          <Skeleton className="h-4 w-28" />
        </div>
        <Card padding="sm">
          <div className="flex items-start justify-between">
            <div className="space-y-2">
              <div className="flex items-center gap-3">
                <Skeleton className="h-7 w-32" />
                <Skeleton shape="circle" className="h-5 w-20" />
              </div>
              <Skeleton className="h-4 w-64" />
            </div>
            <div className="flex items-center gap-2">
              <Skeleton className="h-9 w-28" />
              <Skeleton className="h-8 w-8" />
            </div>
          </div>
          <div className="grid grid-cols-4 gap-3 mt-4">
            {Array.from({ length: 4 }).map((_, i) => (
              <Skeleton key={i} className="h-[104px]" />
            ))}
          </div>
        </Card>
        <Card padding="none">
          <div className="flex gap-1 border-b border-border px-4 pt-2">
            {['Overview', 'Items', 'Estimates', 'Attachments'].map((t) => (
              <div key={t} className="px-3 py-2.5">
                <Skeleton className="h-4 w-16" />
              </div>
            ))}
          </div>
          <div className="p-4 space-y-3">
            {Array.from({ length: 4 }).map((_, i) => (
              <Skeleton key={i} className="h-5 w-full" />
            ))}
          </div>
        </Card>
      </div>
    );
  }

  if (!job) {
    return <div className="text-text-secondary py-12 text-center">Job not found</div>;
  }

  const actions = getAvailableActions(job, ability, user?.id || '');

  // SRVW-112 - only labels parented to the CURRENT status are offerable; the API 400s a mismatch.
  const subStatusOptions = (subStatuses ?? []).filter((s) => s.parent === job.status);

  // Service-location edit: managers only. The status condition is gone — the backend's
  // "Cannot update a {status} job" guard was removed with the other ordering guards (Spec B1).
  const canEditLocation = user?.role === 'ADMIN' || user?.role === 'DISPATCHER';

  // Inline service-type edit: managers only. Same removal as canEditLocation above — the
  // backend's PATCH no longer 400s by status (Spec B1).
  const canEditServiceType = user?.role === 'ADMIN' || user?.role === 'DISPATCHER';

  // View Work Order is the backing estimate document — gated so no user hits a 403.
  const canViewWorkOrder = Boolean(job.estimate) && ability.can('read', 'Estimate');

  // Amount-invoiced vs the estimate total (un-billed remaining).
  const estimateTotal = job.estimate ? Number(job.estimate.total_amount) : 0;
  const amountInvoiced = Number(job.amount_invoiced ?? 0);
  const remainingUnbilled = Math.max(estimateTotal - amountInvoiced, 0);
  void remainingUnbilled; // referenced by C6

  // SRVW-96 - `linked_estimates` (the R6 EstimateJobLink attachment) includes both the job anchor
  // and a multi-estimate conversion; dedupe against the provenance `job.estimate`, which already
  // renders in its own card above.
  const attachedEstimates = (job.linked_estimates ?? []).filter((e) => e.id !== job.estimate?.id);

  // E1/E2 (job-owns-tax-discount) - the job owns its own tax_rate/discount now, editable here.
  // `manage_lines Job`, NOT `update Job`: tax_rate/discount_* ride PATCH /api/jobs/:id alongside
  // harmless fields, so the backend enforces them with a FIELD-LEVEL check inside the handler
  // (technician-ownership spec, Part C). This mirrors that check, not the route guard - a
  // requester with `update Job` alone may still PATCH the job, just not its money. The backend's
  // own canSeePricing check inside the handler is mirrored by the existing canSeePricing above.
  // canOnJob, NOT ability.can: a subject-level check is true for EVERY technician now that the role
  // holds a creator-conditioned `manage_lines Job`, so it would render the tax and discount editors
  // on every job a technician can open and 403 the moment they were used.
  const canManageJob = actions.canManageLines;

  const customerName = customerDisplayName(job.customer);
  const loc = job.service_location;

  // A linked estimate whose own status has taken it out of play carries no contract value.
  const DEAD_ESTIMATE_STATUSES = ['DECLINED', 'EXPIRED', 'ARCHIVED', 'SUPERSEDED'];

  // Contract value from the R6 EstimateJobLink attachment, for a job that has no provenance
  // estimate. `attachedEstimates` is already deduped against `job.estimate`, so this only fires
  // where the legacy fallback below has nothing to offer. Summed rather than [0]: a multi-estimate
  // conversion attaches several estimates that together make up the one contract.
  const attachedContractValue = (() => {
    const live = attachedEstimates.filter((e) => !DEAD_ESTIMATE_STATUSES.includes(e.status));
    if (!live.length) return null;
    return live.reduce((sum, e) => sum + Number(e.total_amount ?? 0), 0);
  })();

  // Financials: total from final invoice, else the provenance estimate, else the linked estimates.
  // The third arm is what an estimate-anchored job (jobs.estimate_id null, Estimate.job_id set)
  // has - without it the masthead rendered "No contract yet" on a job that plainly had one.
  const financialsTotal =
    financials?.final_invoice != null
      ? Number(financials.final_invoice.total_amount)
      : job.estimate != null
        ? Number(job.estimate.total_amount)
        : attachedContractValue;

  // Build one-line service location address
  const serviceAddressLine = loc
    ? [loc.address_line1, loc.city && loc.state ? `${loc.city}, ${loc.state} ${loc.zip}` : '']
        .filter(Boolean)
        .join(', ')
    : null;

  // ── Masthead money summary — all derived from real financials (no fabricated
  // values). Contract = final-invoice total or estimate total; paid = sum of
  // recorded payments; deposit = payments applied to a DEPOSIT-kind invoice.
  const contractValue = financialsTotal;
  const jobPayments = financials?.payments ?? [];
  // #948 — exclude the synthetic DEPOSIT-CREDIT mirror payment a deposit's drawdown writes on
  // the STANDARD invoice: it's the same cash as the deposit's own payment, not new money.
  const totalPaid = jobPayments
    .filter((p) => p.reference_number !== 'DEPOSIT-CREDIT')
    .reduce((sum, p) => sum + Number(p.amount), 0);
  const depositPaid = jobPayments
    .filter((p) => p.invoice_kind === 'DEPOSIT')
    .reduce((sum, p) => sum + Number(p.amount), 0);
  const balanceDue = contractValue != null ? Math.max(contractValue - totalPaid, 0) : null;
  const pctCollected =
    contractValue && contractValue > 0
      ? Math.min(Math.round((totalPaid / contractValue) * 100), 100)
      : 0;
  const isPlanVisit = !!job.source_plan;

  // Schedule KPI tile inner content — shared between the static (read-only) and the
  // clickable-to-reschedule (AC4) wrappers so the content is authored once.
  const scheduleTileInner = (
    <>
      <div className="mb-1.5 flex items-center gap-2">
        <span className="flex h-7 w-7 items-center justify-center rounded-full bg-background-light text-text-secondary">
          <CalendarDays className="h-3.5 w-3.5" />
        </span>
        <p className="text-[11px] font-semibold uppercase tracking-widest text-text-secondary">Schedule</p>
      </div>
      <p className="text-base font-bold leading-snug text-text-primary">
        {job.scheduled_start ? formatInstant(job.scheduled_start, timezone) : 'Not scheduled'}
      </p>
      {job.scheduled_start && (
        <p className="text-xs text-text-secondary">{scheduleHint(job.scheduled_start, timezone)}</p>
      )}
    </>
  );

  return (
    <IconRail entityType="JOB" entityId={id!} panels={['activity']}>
    <div className="space-y-4">
      {/* Breadcrumb */}
      <Breadcrumb items={
        incomingBreadcrumbs
          ? [...incomingBreadcrumbs, { label: job.job_number }]
          : [{ label: 'Jobs', href: '/jobs' }, { label: job.job_number }]
      } />

      {/* ── Command Center Header ──────────────────────────────── */}
      <Card className="space-y-4">
        {/* Top row: identity + action cluster */}
        <div className="flex items-start justify-between gap-4">
          {/* Left: job identity — "J00051 · Customer Name" reads the customer as the subject */}
          <div className="min-w-0">
            <div className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-1">
              {/* dropped delta: original also carried `leading-tight` - Heading has no
                  line-height axis to express it. Weight/tone are Heading's defaults
                  (semibold/neutral) but every child below sets its own explicit
                  font-weight and colour, so the rendered look is unchanged there. */}
              <Heading level={1} scale="2xl" className="flex min-w-0 items-baseline gap-x-2">
                <span className="shrink-0 font-semibold text-text-secondary">{job.job_number}</span>
                <span aria-hidden="true" className="shrink-0 text-text-soft">·</span>
                <Link
                  to={`/customers/${job.customer.id}`}
                  className="max-w-full truncate font-bold text-text-primary hover:underline"
                >
                  {customerName}
                </Link>
              </Heading>
              <span className="self-center"><StatusBadge domain="job" status={job.status} /></span>
              {/* SRVW-112 - sub-status sits BESIDE the parent badge, as a sibling of the Heading
                  (not inside it), so no new DOM-nesting warning. */}
              {actions.canSetSubStatus && subStatusOptions.length > 0 ? (
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button variant="outline" tone="neutral" size="3xs" className="self-center">
                      {job.sub_status?.label ?? 'Set sub-status'}
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="start">
                    {subStatusOptions.map((option) => (
                      <DropdownMenuItem
                        key={option.id}
                        onClick={() => subStatusMutation.mutate(option.id)}
                      >
                        {option.label}
                      </DropdownMenuItem>
                    ))}
                    <DropdownMenuSeparator />
                    <DropdownMenuItem onClick={() => subStatusMutation.mutate(null)}>
                      None
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              ) : job.sub_status ? (
                <span className="self-center"><Badge variant="secondary">{job.sub_status.label}</Badge></span>
              ) : null}
              {job.source_plan && (
                <span
                  title="This job is a service-plan visit — the plan was billed upfront, so it is non-billable."
                  className="self-center inline-flex items-center rounded-full border border-sage-200 bg-sage-50 px-2 py-0.5 text-xs font-medium text-sage-700"
                >
                  Plan Visit
                </span>
              )}
            </div>
            {job.customer.company_name && (
              <p className="mt-0.5 truncate text-sm text-text-secondary">{job.customer.company_name}</p>
            )}
          </div>

          {/* Right: action cluster */}
          <div className="flex items-center gap-2 shrink-0 flex-wrap justify-end">
            <Button variant="outline" onClick={() => setNewTaskOpen(true)}>
              <PlusCircle className="mr-2 h-4 w-4" /> New Task
            </Button>
            {actions.canCreateInvoice && (
              <Button variant="solid" tone="business" onClick={() => setCreateInvoiceOpen(true)}>
                <Receipt className="mr-2 h-4 w-4" /> Create Invoice
              </Button>
            )}
            {(actions.canDuplicate || actions.canReopen || actions.canCancel || actions.canDelete ||
              actions.canAssign || actions.canComplete || canViewWorkOrder) && (
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button variant="outline">Actions <ChevronDown className="ml-2 h-4 w-4" /></Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  {actions.canAssign && (
                    <DropdownMenuItem onClick={() => openAssignDialog('assign')}>
                      <User className="mr-2 h-4 w-4" /> Assign
                    </DropdownMenuItem>
                  )}
                  {actions.canAssign && (
                    <DropdownMenuItem onClick={() => openAssignDialog('schedule')}>
                      {job.scheduled_start ? (
                        <><CalendarDays className="mr-2 h-4 w-4" /> Reschedule</>
                      ) : (
                        <><CalendarPlus className="mr-2 h-4 w-4" /> Schedule Job</>
                      )}
                    </DropdownMenuItem>
                  )}
                  {actions.canComplete && (
                    <DropdownMenuItem
                      onClick={() => completeMutation.mutate()}
                      disabled={completeMutation.isPending}
                    >
                      <CheckCircle2 className="mr-2 h-4 w-4" /> Mark Complete
                    </DropdownMenuItem>
                  )}
                  {canViewWorkOrder && (
                    <DropdownMenuItem onClick={() => setWorkOrderOpen(true)}>
                      <FileText className="mr-2 h-4 w-4" /> View Work Order
                    </DropdownMenuItem>
                  )}

                  {(actions.canAssign || actions.canComplete || canViewWorkOrder) &&
                    (actions.canDuplicate || actions.canReopen) && <DropdownMenuSeparator />}

                  {actions.canDuplicate && (
                    <DropdownMenuItem
                      onClick={() => duplicateMutation.mutate()}
                      disabled={duplicateMutation.isPending}
                    >
                      <Copy className="mr-2 h-4 w-4" /> Duplicate Job
                    </DropdownMenuItem>
                  )}
                  {actions.canReopen && (
                    <DropdownMenuItem
                      onClick={() => reopenMutation.mutate()}
                      disabled={reopenMutation.isPending}
                    >
                      <RotateCcw className="mr-2 h-4 w-4" /> Reopen Job
                    </DropdownMenuItem>
                  )}

                  {(actions.canCancel || actions.canDelete) &&
                    (actions.canAssign || actions.canComplete || canViewWorkOrder ||
                      actions.canDuplicate || actions.canReopen) && <DropdownMenuSeparator />}

                  {actions.canCancel && (
                    <DropdownMenuItem onClick={() => setCancelOpen(true)} variant="destructive">
                      <XCircle className="mr-2 h-4 w-4" /> Cancel
                    </DropdownMenuItem>
                  )}
                  {actions.canDelete && (
                    <DropdownMenuItem onClick={() => setDeleteConfirmOpen(true)} variant="destructive">
                      <Trash2 className="mr-2 h-4 w-4" /> Delete
                    </DropdownMenuItem>
                  )}
                </DropdownMenuContent>
              </DropdownMenu>
            )}
          </div>
        </div>

        {/* Reopen error — surfaces the no-issued-invoice 400 gracefully */}
        {reopenMutation.error && (
          <p className="text-xs text-danger">
            {extractApiError(reopenMutation.error, 'Cannot reopen this job')}
          </p>
        )}

        {/* ── Task at-risk strip — only when overdue or at-risk tasks exist ── */}
        {taskSummary && (taskSummary.overdue > 0 || taskSummary.at_risk > 0) && (
          <div
            data-testid="task-at-risk-strip"
            className="flex items-center gap-2 rounded-lg border border-warning/40 bg-warning/10 px-3 py-2 text-sm text-warning"
          >
            <AlertTriangle className="h-4 w-4 shrink-0" />
            <span>
              {taskSummary.overdue > 0
                ? `${taskSummary.overdue} overdue task${taskSummary.overdue !== 1 ? 's' : ''} on this job`
                : `${taskSummary.at_risk} at-risk task${taskSummary.at_risk !== 1 ? 's' : ''} on this job`}
            </span>
          </div>
        )}

        {/* ── Info band: contact · schedule+service · money (Technician lives in the Team card) ── */}
        <div className="grid grid-cols-1 items-start gap-x-8 gap-y-4 lg:grid-cols-[minmax(0,1.1fr)_minmax(0,1fr)_auto]">
          {/* Zone A — contact: address, phone (tap-to-call), estimate link, +Tag */}
          <div className="min-w-0 space-y-1.5">
            {serviceAddressLine && (
              <p className="flex items-center gap-1.5 text-[15px] text-text-primary">
                <MapPin className="h-4 w-4 shrink-0 text-text-soft" />
                <span className="min-w-0">{serviceAddressLine}</span>
                {canEditLocation && (
                  <button
                    type="button"
                    onClick={() => setEditLocationOpen(true)}
                    className="shrink-0 text-text-soft transition-colors hover:text-primary"
                    aria-label="Edit service location"
                  >
                    <Pencil className="h-3.5 w-3.5" />
                  </button>
                )}
              </p>
            )}
            {!serviceAddressLine && canEditLocation && (
              <button
                type="button"
                onClick={() => setEditLocationOpen(true)}
                className="flex w-fit items-center gap-1 text-sm text-text-secondary transition-colors hover:text-primary"
                aria-label="Edit service location"
              >
                <MapPin className="h-3.5 w-3.5" /> No service address
                <Pencil className="ml-1 h-3.5 w-3.5" />
              </button>
            )}
            {job.customer.phone && (
              <p className="flex items-center gap-1.5 text-[15px] text-text-secondary">
                <Phone className="h-4 w-4 shrink-0 text-text-soft" />
                <a href={`tel:${job.customer.phone}`} className="rounded hover:text-primary hover:underline">
                  {formatPhone(job.customer.phone)}
                </a>
              </p>
            )}
            {job.estimate && (
              <Link
                to={`/estimates/${job.estimate.id}`}
                state={{ breadcrumbs: [{ label: 'Jobs', href: '/jobs' }, { label: job.job_number, href: `/jobs/${id}` }] }}
                className="block text-sm text-primary hover:underline"
              >
                View Estimate ({job.estimate.estimate_number})
              </Link>
            )}
            {job.source_plan && (
              <Link to="/service-plans" className="block text-sm text-primary hover:underline">
                Service Plan ({job.source_plan.service_plan_number})
              </Link>
            )}
            {/* + Tag sits below the View Estimate link */}
            <div className="pt-1">
              <TagInput entityType="JOB" entityId={id!} tags={job.tags ?? []} />
            </div>
          </div>

          {/* Zone B — Schedule + Service tiles */}
          <div className="grid min-w-0 grid-cols-2 gap-3">
            {actions.canAssign ? (
              <button
                type="button"
                onClick={() => openAssignDialog('schedule')}
                aria-label="Reschedule job"
                className="w-full rounded-xl border border-border bg-surface-light p-3.5 text-left transition-colors hover:border-primary"
              >
                {scheduleTileInner}
              </button>
            ) : (
              <div className="rounded-xl border border-border bg-surface-light p-3.5">
                {scheduleTileInner}
              </div>
            )}
            <div className="rounded-xl border border-border bg-surface-light p-3.5">
              <div className="mb-1.5 flex items-center gap-2">
                <span className="flex h-7 w-7 items-center justify-center rounded-full bg-background-light text-text-secondary">
                  <Wrench className="h-3.5 w-3.5" />
                </span>
                <p className="text-[11px] font-semibold uppercase tracking-widest text-text-secondary">Service</p>
              </div>
              {editingServiceType ? (
                <div className="flex items-center gap-1.5">
                  <Select value={job.job_type ?? undefined} onValueChange={(v) => updateJobTypeMutation.mutate(v)}>
                    <SelectTrigger className="h-8"><SelectValue placeholder="Select..." /></SelectTrigger>
                    <SelectContent>
                      {(org?.job_type_options ?? []).length > 0
                        ? (org?.job_type_options ?? []).map((t) => <SelectItem key={t} value={t}>{t}</SelectItem>)
                        : <SelectItem value="__none__" disabled>No options — add in Settings</SelectItem>}
                    </SelectContent>
                  </Select>
                  <button
                    type="button"
                    onClick={() => setEditingServiceType(false)}
                    className="shrink-0 text-text-soft transition-colors hover:text-primary"
                    aria-label="Cancel service type edit"
                  >
                    <XCircle className="h-3.5 w-3.5" />
                  </button>
                </div>
              ) : (
                <p className="flex items-center gap-1.5 text-base font-bold leading-snug text-text-primary">
                  {job.job_type ?? '—'}
                  {canEditServiceType && (
                    <button
                      type="button"
                      onClick={() => setEditingServiceType(true)}
                      className="shrink-0 text-text-soft transition-colors hover:text-primary"
                      aria-label="Edit service type"
                    >
                      <Pencil className="h-3.5 w-3.5" />
                    </button>
                  )}
                </p>
              )}
            </div>
          </div>

          {/* Zone C — money block (real financials) */}
          <div className="w-full rounded-card border border-border bg-primary-subtle/40 p-4 lg:w-[260px] lg:justify-self-end">
            {isPlanVisit ? (
              <>
                <p className="text-[11px] font-semibold uppercase tracking-widest text-text-secondary">Billing</p>
                <p className="mt-0.5 text-base font-bold text-text-primary">Plan visit</p>
                <p className="mt-1 text-[11px] text-text-secondary">Billed upfront — non-billable.</p>
              </>
            ) : contractValue != null ? (
              <>
                <p className="text-[11px] font-semibold uppercase tracking-widest text-text-secondary">Balance due</p>
                <p className="mt-0.5 text-3xl font-extrabold leading-none tracking-tight text-text-primary tabular-nums">
                  {formatCurrency(balanceDue ?? 0)}
                </p>
                <div className="mt-2.5 h-1.5 w-full overflow-hidden rounded-full bg-surface-light">
                  <div className="h-full rounded-full bg-sage-500" style={{ width: `${pctCollected}%` }} />
                </div>
                <div className="mt-2 flex items-center justify-between gap-2 text-xs tabular-nums">
                  <span className="text-text-secondary">
                    Contract <span className="font-semibold text-text-primary">{formatCurrency(contractValue)}</span>
                  </span>
                  {depositPaid > 0 && (
                    <span className="font-medium text-sage-700">Deposit {formatCurrency(depositPaid)}</span>
                  )}
                </div>
                <p className="mt-1 text-[11px] text-text-secondary">{pctCollected}% collected</p>
              </>
            ) : (
              <>
                <p className="text-[11px] font-semibold uppercase tracking-widest text-text-secondary">Balance</p>
                <p className="mt-0.5 text-base font-bold text-text-primary">No contract yet</p>
                <p className="mt-1 text-[11px] text-text-secondary">Add an estimate or invoice to track payment.</p>
              </>
            )}
          </div>
        </div>

        {/* ── Task Signal Chips ─────────────────────────── */}
        {taskSummary && (
          <div className="flex flex-wrap items-center gap-3 text-sm">
            {/* Open */}
            <div data-testid="task-chip-open" className="flex items-center gap-1.5 rounded-full border border-border bg-background-light px-3 py-1 text-text-secondary">
              <ClipboardList className="h-3.5 w-3.5" />
              <span className="font-medium text-text-primary">{taskSummary.open}</span>
              <span>Open</span>
            </div>

            {/* Overdue */}
            <div
              data-testid="task-chip-overdue"
              className={cn(
                'flex items-center gap-1.5 rounded-full border px-3 py-1',
                taskSummary.overdue > 0
                  ? 'border-danger/40 bg-danger/10 text-danger'
                  : 'border-border bg-background-light text-text-secondary'
              )}
            >
              <AlertTriangle className="h-3.5 w-3.5" />
              <span className="font-medium">{taskSummary.overdue}</span>
              <span>Overdue</span>
            </div>

            {/* Next Due */}
            <div data-testid="task-chip-next-due" className="flex items-center gap-1.5 rounded-full border border-border bg-background-light px-3 py-1 text-text-secondary">
              <CalendarDays className="h-3.5 w-3.5" />
              <span>Next due:</span>
              <span className="font-medium text-text-primary">
                {taskSummary.next_due_at
                  ? formatInstant(taskSummary.next_due_at, timezone, { month: 'short', day: 'numeric' })
                  : '—'}
              </span>
            </div>
          </div>
        )}

        {/* ── Lifecycle Progress Bar ─────────────────────── */}
        <JobLifecycleBar
          job={job}
          financials={financials}
          tz={timezone}
          can={{
            scheduled: actions.canAssign,
            on_site: actions.canArrive,
            started: actions.canStart,
            completed: actions.canComplete,
            // Spec A D4: per-user capabilities, never technician role defaults. A bare technician
            // sees both nodes display-only, matching 4 of the 6 benchmarked FSMs.
            //
            // Gated per STATE, not by a single OR: States 3/4 create (needing `create Invoice`),
            // State 2 only sends (needing `send Invoice`). A send-only user given a create path
            // 403s at job.routes.ts, and a create-only user 403s on the send.
            //
            // Service-plan visits are excluded: the plan was paid upfront, so
            // POST /api/jobs/:id/invoices 400s them (job.controller.ts:3101-3106). A clickable
            // node that 400s is exactly the dead end this spec forbids.
            invoice_sent:
              !job.source_plan_id &&
              (invoiceSent.state === 1
                ? true
                : invoiceSent.state === 2
                  ? ability.can('send', 'Invoice')
                  : ability.can('create', 'Invoice') && ability.can('send', 'Invoice')),
            payment_received:
              !jobPaidOff &&
              ability.can('record_payment', 'Invoice') &&
              // The composite path creates an invoice, so it needs create too — but only when
              // there is no invoice to pay.
              (financials?.final_invoice != null ||
                (!job.source_plan_id && ability.can('create', 'Invoice'))),
          }}
          busy={arriveMutation.isPending || startMutation.isPending || completeMutation.isPending}
          onNodeClick={(key) => {
            if (key === 'scheduled') { openAssignDialog('schedule'); return; }
            if (key === 'on_site') { arriveMutation.mutate(); return; }
            if (key === 'completed') { completeMutation.mutate(); return; }
            if (key === 'invoice_sent') {
              // State 1 — already sent: open the invoice rather than a dialog.
              if (invoiceSent.state === 1 && invoiceSent.invoice) {
                navigate(`/invoices/${invoiceSent.invoice.id}`);
                return;
              }
              setInvoiceSentOpen(true);
              return;
            }
            if (key === 'payment_received') { setPaymentReceivedOpen(true); }
          }}
          onStartClick={() => startMutation.mutate()}
        />
      </Card>

      {/* ── 8-Tab Scaffold ──────────────────────────────── */}
      {/* Phase 11.6 retired DetailPageShell's `tabsSurface`/`railWrapperClassName`/
          `listClassName`/`contentWrapperClassName` - TabStrip has no equivalent, so
          this page owns its own card + content-tint markup now.
          `tabsSurface="card"` + `railWrapperClassName="rounded-t-card bg-surface-light"`
          become this one outer div, replicating the exact `SURFACE.card` classes
          `<Tabs surface="card">` used to render (tabs.tsx's own SURFACE constant) -
          the inner rail wrapper's own `rounded-t-card bg-surface-light` was a
          redundant duplicate of the SAME colour and top rounding the outer surface
          already provided, since neither TabsList nor TabsTrigger paints a
          background of its own. `contentWrapperClassName="rounded-b-card
          bg-primary-subtle/50"` becomes a plain wrapping `<div>` around every
          `<TabsContent>` below, passed as TabStrip's own `children` - a byte-exact
          re-creation of the old shared wrapper, not an approximation. It is
          deliberately a raw `<div>` here rather than a className added directly to
          each `<TabsContent>`: `TabsContent` is exported from `components/ui`, one
          of `layering-guard.test.ts`'s governed directories, and a literal radius
          or background colour className handed straight to a governed primitive
          is exactly the call-site appearance override that guard ratchets to zero
          - tripped once, in an earlier revision of this migration, confirming it
          is live. A plain div is not a governed component and carries no such
          rule.
          `overflow-x-auto` on the rail (the one axis of `listClassName` that was
          not a no-op) has no home on TabStrip's prop surface and is the one
          disclosed, unreproduced piece - up to 9 tabs will no longer scroll
          horizontally on their own on a narrow viewport. */}
      <div className="rounded-card border border-border bg-surface-light shadow-card">
      <TabStrip
        active={activeTab}
        onChange={setActiveTab}
        triggerVariant="underline"
        triggerClassName="px-5 py-3"
        tabs={[
          { value: 'overview', label: 'Overview' },
          { value: 'items', label: 'Items' },
          ...(canUseInventory ? [{ value: 'logistics', label: 'Logistics' }] : []),
          ...(ability.can('read', 'Estimate') ? [{ value: 'estimates', label: 'Estimates' }] : []),
          { value: 'attachments', label: 'Attachments' },
          ...(ability.can('read', 'Communication') ? [{ value: 'communication', label: 'Communication' }] : []),
          {
            value: 'tasks',
            label: (
              <>
                Tasks
                {taskSummary?.open ? (
                  <span className="ml-1.5 text-xs text-text-secondary">({taskSummary.open})</span>
                ) : null}
              </>
            ),
          },
          { value: 'notes', label: 'Notes' },
          ...(ability.can('read', 'Invoice') ? [{ value: 'payments', label: 'Payments' }] : []),
        ]}
      >
        <div className="rounded-b-card bg-primary-subtle/50">
        {/* ── Overview Tab ──────────────────────────────── */}
        <TabsContent value="overview" className="mt-0 p-5">
          {/* Command-center grid: 4 true columns on desktop, stacked on mobile */}
          <div className="grid grid-cols-1 xl:grid-cols-[1.15fr_1.72fr_1fr_1fr] gap-4">

            {/* Col 1 — Customer & Contact */}
            <div className="space-y-4">
              <CustomerContactCard job={job} onViewAllCommunications={() => setActiveTab('communication')} />
            </div>

            {/* Col 2 — Details (scope / completion / linked docs) + Documents & Photos + Job Notes */}
            <div className="space-y-4">
              <SectionCard title="Details" bodyClassName="space-y-4">
                {/* Scope Notes */}
                {job.scope_notes && (
                  <div>
                    <SectionLabel>Scope Notes</SectionLabel>
                    <p className="text-sm text-text-primary whitespace-pre-wrap">{job.scope_notes}</p>
                  </div>
                )}

                {/* Completion Notes (compact) */}
                {job.completion_notes && (
                  <div>
                    <SectionLabel>Completion Notes</SectionLabel>
                    <p className="text-sm text-text-primary whitespace-pre-wrap">{job.completion_notes}</p>
                    {job.completed_at && (
                      <p className="text-xs text-text-secondary mt-1">Completed {formatInstant(job.completed_at, timezone, FULL_DATE_TIME)}</p>
                    )}
                  </div>
                )}

                {/* Cancellation */}
                {job.cancelled_reason && (
                  <div className="rounded-lg bg-danger/5 border border-danger/20 p-3">
                    <p className="text-xs font-semibold text-danger mb-1">Cancellation Reason</p>
                    <p className="text-sm text-text-primary whitespace-pre-wrap">{job.cancelled_reason}</p>
                    {job.cancelled_at && (
                      <p className="text-xs text-text-secondary mt-1">Cancelled {formatInstant(job.cancelled_at, timezone, FULL_DATE_TIME)}</p>
                    )}
                  </div>
                )}

                {/* Linked Estimate */}
                {job.estimate && (
                  <div>
                    <SectionLabel>Linked Estimate</SectionLabel>
                    <Link
                      to={`/estimates/${job.estimate.id}`}
                      state={{ breadcrumbs: [{ label: 'Jobs', href: '/jobs' }, { label: job.job_number, href: `/jobs/${id}` }] }}
                      className="text-sm text-primary hover:underline"
                    >
                      {job.estimate.estimate_number}
                    </Link>
                  </div>
                )}

                {/* Originating Lead (#585 — direct Job->Lead traceability) */}
                {job.estimate?.lead && (
                  <div>
                    <SectionLabel>Originating Lead</SectionLabel>
                    <Link
                      to={`/leads/${job.estimate.lead.id}`}
                      state={{ breadcrumbs: [{ label: 'Jobs', href: '/jobs' }, { label: job.job_number, href: `/jobs/${id}` }] }}
                      className="text-sm text-primary hover:underline"
                    >
                      {job.estimate.lead.lead_number}
                    </Link>
                  </div>
                )}

                {/* Invoices */}
                {job.invoices && job.invoices.length > 0 && (
                  <div>
                    <SectionLabel>
                      {job.invoices.length === 1 ? 'Invoice' : `Invoices (${job.invoices.length})`}
                    </SectionLabel>
                    <div className="space-y-2 text-sm">
                      {job.invoices.map((inv: { id: string; invoice_number: string; status: string; total_amount: number | string }) => (
                        <div key={inv.id} className="flex items-center justify-between gap-2">
                          <Link
                            to={`/invoices/${inv.id}`}
                            state={{ breadcrumbs: [{ label: 'Jobs', href: '/jobs' }, { label: job.job_number, href: `/jobs/${id}` }] }}
                            className="text-primary hover:underline font-medium"
                          >
                            {inv.invoice_number}
                          </Link>
                          <StatusBadge domain="invoice" status={inv.status} />
                          <span className="font-medium text-text-primary">{formatCurrency(Number(inv.total_amount))}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </SectionCard>

              <JobFilesCard jobId={id!} attachments={attachmentsData} onViewAll={() => setActiveTab('attachments')} />
              <JobNotesPreview jobId={id!} notes={notesData} />
              <ExtraInfoPanel
                entityType="JOB"
                entityId={id!}
                values={job.custom_fields ?? {}}
                onSave={(patch) => customFieldsMutation.mutateAsync({ custom_fields: patch })}
              />
            </div>

            {/* Col 3 — Team */}
            <div className="space-y-4">
              <TeamCard job={job} onAssign={actions.canAssign ? () => openAssignDialog('assign') : undefined} />
            </div>

            {/* Col 4 — AI Operations Insights */}
            <div className="space-y-4">
              <AiInsightsCard job={job} attachments={attachmentsData} financials={financials} />
            </div>
          </div>

          {/* AI Job Assistant — full-width teaser (coming soon) */}
          <div id="ai-job-assistant" className="mt-4">
            <AiJobAssistantBar
              jobNumber={job.job_number}
              customerName={customerName}
              service={job.job_type}
              status={job.status}
            />
          </div>
        </TabsContent>

        {/* ── Items Tab — job-owned billing lines (SERV10X-38), tracked before any invoice ─── */}
        <TabsContent value="items" className="mt-0 p-5">
          <div className="space-y-5">
            <JobScopeOfWorkCard jobId={id!} canManage={actions.canManageLines} />
            <LineItemsEditor jobId={id!} canManage={actions.canManageLines} />
            <ReceiptCard
              variant="job"
              lineItemsSubtotal={(jobLineItemsData?.lines ?? []).reduce((sum, l) => sum + netOf(l), 0)}
              scopeSubtotal={(jobScopesData?.scopes ?? [])
                .filter((s) => s.flat_price != null)
                .reduce((sum, s) => sum + toNum(s.flat_price), 0)}
              // E1/E2 (job-owns-tax-discount): the job owns its own tax_rate/discount now - both
              // editable here, same PATCH /api/jobs/:id door canManageJob + canSeePricing already
              // gate for labor_hours/overhead below. Every figure is still server-authoritative
              // from computeJobBilling; the mutation only sends the raw input, never the resolved
              // discount_amount (the server resolves that against the job's current subtotal).
              subtotal={jobLineItemsData?.billing?.subtotal ?? 0}
              discountAmount={jobLineItemsData?.billing?.discount_amount ?? 0}
              onDiscountChange={
                canManageJob && canSeePricing
                  ? (amount, mode) => taxDiscountMutation.mutate({ discount_type: mode ?? 'FIXED_AMOUNT', discount_value: amount })
                  : undefined
              }
              taxRate={jobLineItemsData?.billing?.tax_rate ?? 0}
              taxAmount={jobLineItemsData?.billing?.tax_amount ?? 0}
              onTaxRateChange={
                canManageJob && canSeePricing
                  ? (rate) => taxDiscountMutation.mutate({ tax_rate: rate })
                  : undefined
              }
              // One flag for BOTH tax props (mirrors Estimate/Invoice's identical convention):
              // taxRates without onTaxRateChange would render an inert jurisdiction select, so
              // the two must never drift apart.
              taxRates={canManageJob && canSeePricing ? jobTaxRates : undefined}
              taxStateCode={job.service_location?.state ?? null}
              total={jobLineItemsData?.billing?.total ?? 0}
            />
            {canSeePricing && (
              <InternalCostsCard
                lineItems={jobLineItemsData?.lines ?? []}
                scopes={jobScopesData?.scopes ?? []}
                laborHours={job.labor_hours}
                overheadMode={job.overhead_mode}
                overheadValue={job.overhead_value}
                discountedSubtotal={jobLineItemsData?.billing?.total ?? 0}
                orgLaborRate={org?.labor_rate ?? 0}
                orgOverheadMode={org?.overhead_mode ?? 'PERCENTAGE'}
                orgOverheadValue={org?.overhead_value ?? 0}
                canEditNow={job.status !== 'CANCELLED'}
                onCommitLaborHours={(hours) => costMutation.mutate({ labor_hours: hours })}
                onCommitOverhead={(mode, value) => costMutation.mutate({ overhead_mode: mode, overhead_value: value })}
                materialsPurchased={
                  canReadPO && materialCost && materialCost.lineCount > 0
                    ? { amount: materialCost.materialCost, lineCount: materialCost.lineCount }
                    : null
                }
              />
            )}
          </div>
        </TabsContent>

        {/* ── Logistics Tab — Logistic Orders (top) + staging & fulfillment ───
            Guarded as well as its trigger: LOList/JobStagesSection fetch from the
            Scale-gated /api/inventory/* routes, so an unentitled mount is a 402.
            Radix already unmounts inactive content, but that is a rendering
            detail - keep the invariant local to the thing that fetches. */}
        {canUseInventory && (
        <TabsContent value="logistics" className="mt-0 p-5">
          <div className="space-y-5">
            {/* H3 (spec §14) — one-line notice while legacy SYNCED lines still deduct stock
                on this job, so a new LO won't silently double-count them. */}
            {(() => {
              const syncedLines = (jobLineItemsData?.lines ?? []).filter(
                (l) => l.stock_status === 'SYNCED',
              );
              if (syncedLines.length === 0) return null;
              return (
                <div className="flex items-start gap-2 rounded-control border border-warning/20 bg-warning/10 px-3 py-2 text-xs text-warning">
                  <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                  <span>
                    Legacy synced line{syncedLines.length === 1 ? '' : 's'} still deducting stock on
                    this job: {syncedLines.map((l) => l.description).join(', ')}. New logistic orders
                    won&apos;t double-count them.
                  </span>
                </div>
              );
            })()}
            <LOList jobId={id!} />
            <JobStagesSection jobId={id!} />
          </div>
        </TabsContent>
        )}

        {/* ── Estimates Tab (carried over) ─────────────────── */}
        <TabsContent value="estimates" className="mt-0 p-5 space-y-4">
          {/* Workiz parity (behavioral-validation §6 gap 5, continuity map §2.1): a job can ALWAYS
              take another estimate - Workiz puts no line-item constraint on its job Estimates tab's
              "+ Add estimate", because adding an estimate and copying items into one are two
              separate mechanisms there (their item copy is the explicit "Sync to job"). "Add
              estimate" is therefore ungated; "from items" is the extra, and only has anything to
              copy once the job HAS items. */}
          {ability.can('create', 'Estimate') || ability.can('update', 'Estimate') ? (
            <div className="flex flex-wrap justify-end gap-2">
              {ability.can('update', 'Estimate') && (
                <Button type="button" variant="outline" size="sm" onClick={() => setAttachEstimateOpen(true)}>
                  <FileText className="h-4 w-4" aria-hidden /> Attach estimate
                </Button>
              )}
              {ability.can('create', 'Estimate') && billableLineCount > 0 && (
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={createEstimateMutation.isPending}
                  onClick={() => createEstimateMutation.mutate()}
                >
                  <PlusCircle className="h-4 w-4" aria-hidden /> Create estimate from items
                </Button>
              )}
              {ability.can('create', 'Estimate') && (
                // `/estimates/new?job_id=` mints an empty DRAFT anchored to this job (numbered into
                // the job's own J00007-1 container) and lands on the workspace. The route has read
                // `job_id` since SERV10X-61 §5.4 - nothing in the app passed it until now.
                <Button
                  type="button"
                  variant="solid"
                  tone="business"
                  size="sm"
                  onClick={() =>
                    navigate(`/estimates/new?job_id=${id}`, {
                      state: { breadcrumbs: [{ label: 'Jobs', href: '/jobs' }, { label: job.job_number, href: `/jobs/${id}` }] },
                    })
                  }
                >
                  <PlusCircle className="h-4 w-4" aria-hidden /> Add estimate
                </Button>
              )}
            </div>
          ) : null}
          {job.estimate ? (
            <SectionCard
              title="Estimate"
              icon={<FileText className="h-4 w-4 text-text-secondary" />}
              meta={
                <Link
                  to={`/estimates/${job.estimate.id}`}
                  state={{ breadcrumbs: [{ label: 'Jobs', href: '/jobs' }, { label: job.job_number, href: `/jobs/${id}` }] }}
                  className="inline-flex items-center gap-1 text-xs font-medium text-primary hover:underline"
                >
                  View estimate <ArrowUpRight className="h-3.5 w-3.5" />
                </Link>
              }
            >
              <Link
                to={`/estimates/${job.estimate.id}`}
                state={{ breadcrumbs: [{ label: 'Jobs', href: '/jobs' }, { label: job.job_number, href: `/jobs/${id}` }] }}
                className="text-base font-bold text-text-primary hover:underline"
              >
                {job.estimate.estimate_number}
              </Link>
              <div className="mt-1.5 flex items-center gap-3">
                <StatusBadge domain="estimate" status={job.estimate.status} />
                <span className="text-sm font-semibold tabular-nums text-text-primary">
                  {formatCurrency(Number(job.estimate.total_amount))}
                </span>
              </div>
              {job.estimate.deposit && (
                <div className="mt-4">
                  <SectionLabel>Deposit</SectionLabel>
                  <div className="flex flex-wrap items-center gap-2 text-sm">
                    <span className="font-medium tabular-nums text-text-primary">
                      {formatCurrency(Number(job.estimate.deposit.amount))}
                    </span>
                    <span className="rounded-full bg-background-light px-2 py-0.5 text-[11px] font-medium capitalize text-text-secondary">
                      {job.estimate.deposit.status.replace(/_/g, ' ').toLowerCase()}
                    </span>
                    {job.estimate.deposit.paid_at && (
                      <span className="text-xs text-text-secondary">
                        paid {formatInstant(job.estimate.deposit.paid_at, timezone, { year: 'numeric', month: 'numeric', day: 'numeric' })}
                      </span>
                    )}
                  </div>
                </div>
              )}
            </SectionCard>
          ) : attachedEstimates.length === 0 ? (
            <SectionCard title="Estimate" icon={<FileText className="h-4 w-4 text-text-secondary" />}>
              <EmptyState icon={FileText} title="No linked estimate" />
            </SectionCard>
          ) : null}
          {attachedEstimates.length > 0 && (
            <SectionCard title="Attached estimates" icon={<FileText className="h-4 w-4 text-text-secondary" />}>
              <p className="mb-3 text-xs text-text-secondary">
                Attached to this job. A paid deposit on any of these is credited against this
                job&apos;s invoices, which are billed from the job&apos;s own line items.
              </p>
              <div className="space-y-3">
                {attachedEstimates.map((e) => (
                  <div key={e.id} className="flex items-center justify-between gap-3">
                    <Link
                      to={`/estimates/${e.id}`}
                      state={{ breadcrumbs: [{ label: 'Jobs', href: '/jobs' }, { label: job.job_number, href: `/jobs/${id}` }] }}
                      className="text-sm font-bold text-text-primary hover:underline"
                    >
                      {e.estimate_number}
                    </Link>
                    <div className="flex items-center gap-3">
                      <StatusBadge domain="estimate" status={e.status} />
                      {e.total_amount != null && (
                        <span className="text-sm font-semibold tabular-nums text-text-primary">
                          {formatCurrency(Number(e.total_amount))}
                        </span>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            </SectionCard>
          )}
        </TabsContent>

        {/* ── Attachments Tab (C6 + C8gap) ─────────────────── */}
        <TabsContent value="attachments" className="mt-0 p-5">
          <AttachmentsTabBody jobId={id!} attachments={attachmentsData} />
        </TabsContent>

        {/* ── Communication Tab (dual CASL guard — carried over) ── */}
        {ability.can('read', 'Communication') && (
          <TabsContent value="communication" className="mt-0">
            <JobCommunicationsTab
              jobId={id!}
              jobNumber={job.job_number}
              customerId={job.customer.id}
              customerName={customerName}
              customerEmail={job.customer.email ?? undefined}
              customerPhone={job.customer.phone || undefined}
            />
          </TabsContent>
        )}

        {/* ── Tasks Tab (carried over) ─────────────────────── */}
        <TabsContent value="tasks" className="mt-0">
          <JobLeadTasksTab
            entity={{
              type: 'JOB',
              id: job.id,
              label: `${job.job_number} — ${customerName}`,
            }}
          />
        </TabsContent>

        {/* ── Notes Tab (C6) ──────────────────────────────── */}
        <TabsContent value="notes" className="mt-0">
          <NotesTabBody jobId={id!} notes={notesData} />
        </TabsContent>

        {/* ── Payments Tab (C6) ───────────────────────────── */}
        <TabsContent value="payments" className="mt-0">
          <PaymentsTab financials={financials} jobId={id!} />
        </TabsContent>
        </div>
      </TabStrip>
      </div>

      {/* Dialogs */}
      <CreateTaskModal
        open={newTaskOpen}
        onOpenChange={setNewTaskOpen}
        presetEntity={{ type: 'JOB', id: job.id, label: `${job.job_number} — ${customerName}` }}
      />
      <AssignJobDialog
        open={assignOpen}
        onOpenChange={setAssignOpen}
        jobId={id!}
        mode={assignMode}
        currentAssigneeIds={job.assignees?.map((a) => a.user.id)}
        isScheduled={Boolean(job.scheduled_start)}
        // Seed the pickers with the schedule the job already has, so Reschedule opens on the
        // current slot to edit rather than two empty fields the user has to retype from memory.
        defaultStart={job.scheduled_start ?? undefined}
        defaultEnd={job.scheduled_end ?? undefined}
        defaultIsAllDay={job.is_all_day}
      />
      {job.estimate && (
        <ViewWorkOrderDialog
          open={workOrderOpen}
          onOpenChange={setWorkOrderOpen}
          estimateId={job.estimate.id}
          customerName={customerName}
          companyName={job.customer.company_name}
        />
      )}
      <CancelJobDialog
        open={cancelOpen}
        onOpenChange={setCancelOpen}
        jobId={id!}
      />
      <ConfirmDialog
        open={deleteConfirmOpen}
        onOpenChange={setDeleteConfirmOpen}
        icon={Trash2}
        variant="destructive"
        title="Delete this job?"
        // Inventory P1 §4: job delete auto-returns SYNCED lines server-side.
        description={
          (jobLineItemsData?.lines ?? []).some((l) => l.stock_status === 'SYNCED')
            ? 'Synced inventory items on this job will be returned to stock.'
            : undefined
        }
        confirmLabel="Delete"
        onConfirm={() => deleteMutation.mutate()}
        isLoading={deleteMutation.isPending}
      />
      <EditJobLocationDialog
        open={editLocationOpen}
        onOpenChange={setEditLocationOpen}
        jobId={id!}
        customerId={job.customer.id}
        currentLocation={job.service_location}
      />
      <AttachEstimateDialog
        open={attachEstimateOpen}
        onOpenChange={setAttachEstimateOpen}
        jobId={id!}
        customerId={job.customer.id}
      />
      <CreateJobInvoiceDialog
        open={createInvoiceOpen}
        onOpenChange={setCreateInvoiceOpen}
        jobId={job.id}
        jobNumber={job.job_number}
        onCreated={goToInvoice}
      />
      <CreateJobInvoiceDialog
        open={invoiceSentOpen}
        onOpenChange={setInvoiceSentOpen}
        jobId={job.id}
        jobNumber={job.job_number}
        sendAfterCreate
        existingDraft={invoiceSent.state === 2 ? invoiceSent.invoice : null}
        initialMode={invoiceSent.state === 3 ? 'ITEMIZED' : 'AMOUNT'}
        onCreated={() => invalidateJob()}
      />
      <RecordPaymentDialog
        open={paymentReceivedOpen}
        onOpenChange={setPaymentReceivedOpen}
        invoiceId={financials?.final_invoice?.id ?? null}
        invoiceNumber={financials?.final_invoice?.invoice_number ?? ''}
        amountDue={Number(financials?.final_invoice?.amount_due ?? 0)}
        jobId={job.id}
        hasUnspentDeposit={hasUnspentDeposit}
        onSuccess={() => { invalidateJob(); setPaymentReceivedOpen(false); }}
      />
    </div>
    </IconRail>
  );
}
