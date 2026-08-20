import { useState, useEffect } from 'react';
import { useParams, useNavigate, useLocation, useSearchParams } from 'react-router-dom';
import type { BreadcrumbItem } from '@/components/ui/breadcrumb';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import api from '@/lib/axios';
import { useAppAbility } from '@/contexts/AbilityContext';
import { deleteLead } from '@/lib/api/leads';
import { Button } from '@/components/ui/button';
import { Heading } from '@/components/ui/heading';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { TabsContent } from '@/components/ui/tabs';
import { TabStrip } from '@/components/patterns/TabStrip';
import { StatusBadge } from '@/components/data/status-badge';
import { Breadcrumb } from '@/components/ui/breadcrumb';
import { AssignLeadPopover } from '@/components/leads/AssignLeadPopover';
import { MultiAssigneeSelect } from '@/components/crm/MultiAssigneeSelect';
import { MarkLostDialog } from '@/components/leads/MarkLostDialog';
import { CancelLeadDialog } from '@/components/leads/CancelLeadDialog';
import { CancelWalkthroughDialog } from '@/components/leads/CancelWalkthroughDialog';
import { CreateJobFromLeadDialog } from '@/components/leads/CreateJobFromLeadDialog';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { DateTimePicker } from '@/components/form/DateTimePicker';
import { TagInput } from '@/components/leads/TagInput';
import { IconRail } from '@/components/crm/IconRail';
import { AttachmentSection } from '@/components/crm/AttachmentSection';
import { EmptyState } from '@/components/ui/empty-state';
import { formatCurrency, formatPhone, extractApiError } from '@/lib/utils';
import { toast } from '@/components/ui/use-toast';
import { customerDisplayName } from '@/lib/customer-name';
import { useFeature } from '@/lib/entitlements';
import { requestCall } from '@/lib/communication/phoneTabHandoff';
import { LEAD_STATUSES } from '@/lib/filters/registries/leads';
import { useLeadStatusOverrides } from '@/lib/api/leadStatusOverrides';
import { ExtraInfoPanel } from '@/components/custom-fields/ExtraInfoPanel';
import { JobLeadTasksTab } from '@/components/tasks/JobLeadTasksTab';
import { useScheduleTimezone, pickerValueToIso, isoToPickerValue } from '@/lib/schedule-tz';
import { LeadCommunicationsTab } from '@/components/communication/LeadCommunicationsTab';
import {
  Pencil,
  User,
  MapPin,
  Phone,
  Mail,
  Calendar,
  AlertTriangle,
  FileText,
  ChevronDown,
  CheckCircle2,
  Clock,
  Paperclip,
  Ban,
  Trash2,
  Briefcase,
  MoreHorizontal,
} from 'lucide-react';

// ─── Types ────────────────────────────────────────────────────

interface Tag {
  id: string;
  name: string;
  color: string;
}

interface UserSummary {
  id: string;
  first_name: string;
  last_name: string;
}

// D14: `walkthrough_count`/`walkthrough_history` are full-detail-only fields
// (projectLegacyWalkthroughFields) - the raw Walkthrough rows for this lead, newest first.
type VisitHistoryRow = {
  id: string;
  status: string;
  scheduled_at: string | null;
  completed_at: string | null;
  cancelled_at: string | null;
  cancelled_reason: string | null;
  created_at: string;
};

// ─── Lead Status Config ───────────────────────────────────────

// Walkthrough-as-entity redesign, PR-C2: WALKTHROUGH_SCHEDULED/WALKTHROUGH_COMPLETED left
// LeadStatus, so LEAD_STATUSES is once again both the filterable AND the settable vocabulary -
// no more excluding a walkthrough-completion status from this page's own status dropdown.
const SETTABLE_LEAD_STATUSES = LEAD_STATUSES;

// ─── Helpers ──────────────────────────────────────────────────

function formatDate(date: string) {
  return new Date(date).toLocaleDateString('en-US', {
    month: 'short', day: 'numeric', year: 'numeric',
  });
}

function formatDateTime(date: string, timeZone: string) {
  return new Date(date).toLocaleString('en-US', {
    month: 'short', day: 'numeric', year: 'numeric',
    hour: 'numeric', minute: '2-digit',
    timeZone,
  });
}

// Walkthrough-as-entity redesign, PR-C2: WALKTHROUGH_SCHEDULED left LeadStatus, so "is the
// CURRENT visit actively scheduled" is derived from these three projected timestamps instead of
// lead.status. A CANCELLED visit keeps its scheduled_at set (kept as D15 history so the backend
// can still resolve it as "the most recent visit that happened"), so scheduledAt alone is not
// "still scheduled" - completedAt and cancelledAt must both be excluded first. Shared by
// WalkthroughDot, WalkthroughTabContent's isScheduled and the header-actions gate below, which
// all need this exact guard.
function isWalkthroughActive(scheduledAt: unknown, completedAt: unknown, cancelledAt: unknown): boolean {
  return Boolean(scheduledAt) && !completedAt && !cancelledAt;
}

// ─── Status Dropdown ──────────────────────────────────────────

function StatusDropdown({
  currentStatus,
  onStatusChange,
  disabled,
}: {
  currentStatus: string;
  onStatusChange: (status: string) => void;
  disabled: boolean;
}) {
  // SRVW-111 (label-override shape) - org-renamed/reordered/hidden LeadStatus display. Before the
  // query resolves (or for a fresh org with no rows), `overrides` is empty, which falls back to
  // every status unhidden in enum order - the same thing the merged response says explicitly.
  const { data: overridesData } = useLeadStatusOverrides();
  const overrides = overridesData ?? [];
  const labelFor = (status: string) => overrides.find((o) => o.status === status)?.label ?? undefined;
  const visibleStatuses =
    overrides.length > 0
      ? [...overrides]
          // A lead already AT a hidden status must still be able to keep it selected - never
          // drop the CURRENT status from the list, only other hidden ones.
          .filter((o) => !o.hidden || o.status === currentStatus)
          .sort((a, b) => a.sort_order - b.sort_order)
          .map((o) => o.status)
      : SETTABLE_LEAD_STATUSES;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild disabled={disabled}>
        {/* compound badge+chevron pill, no bg at rest, text-xs font-medium - no matching Button variant/tone/size cell - left raw */}
        <button
          className="inline-flex items-center gap-1.5 rounded-md border border-border px-2.5 py-1 text-xs font-medium hover:bg-background-light transition-colors disabled:opacity-50"
          disabled={disabled}
        >
          <StatusBadge domain="lead" status={currentStatus} labelOverride={labelFor(currentStatus)} neutral />
          {!disabled && <ChevronDown className="h-3 w-3 text-text-secondary" />}
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-52 max-h-60 overflow-auto py-1">
        {visibleStatuses.map(status => (
          <DropdownMenuItem
            key={status}
            className="gap-2 px-3 py-1.5 text-xs"
            onClick={() => onStatusChange(status)}
          >
            <StatusBadge domain="lead" status={status} labelOverride={labelFor(status)} neutral />
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

// ─── Walkthrough Status Dot ────────────────────────────────────

// Walkthrough-as-entity redesign, PR-C2: WALKTHROUGH_SCHEDULED left LeadStatus, so this can no
// longer key off lead.status at all - it reads the CURRENT visit's own projected fields instead
// (D15: next upcoming SCHEDULED; else most recent COMPLETED/CANCELLED - resolved server-side by
// projectLegacyWalkthroughFields, so a multi-visit lead still reads correctly here).
//
// The ORDER of the three guards below is load-bearing: completedAt must be checked before
// scheduledAt. A CANCELLED visit keeps its scheduled_at set (kept as history so D15 can still
// pick it as "the most recent visit that happened" - see cancelWalkthroughRow), so scheduledAt
// alone is not "still scheduled"; both completedAt and cancelledAt must be excluded before
// scheduledAt reads as an active, upcoming visit.
//
// This mapping stays local rather than joining STATUS_REGISTRY: the registry's inclusion
// rule (c) requires the same mapping spelled in two or more places, and this dot has one
// declaration and one call site. It also diverges from the registry, which files
// WALKTHROUGH_SCHEDULED under the warning intent while this dot reads it as informational;
// the known-survivors table records that divergence.
function WalkthroughDot({
  scheduledAt,
  completedAt,
  cancelledAt,
}: {
  scheduledAt: string | null;
  completedAt: string | null;
  cancelledAt: string | null;
}) {
  if (completedAt) {
    return <span data-testid="walkthrough-dot" className="inline-block h-2 w-2 rounded-full bg-success-strong" />;
  }
  if (isWalkthroughActive(scheduledAt, completedAt, cancelledAt)) {
    return <span data-testid="walkthrough-dot" className="inline-block h-2 w-2 rounded-full bg-info-strong" />;
  }
  return <span data-testid="walkthrough-dot" className="inline-block h-2 w-2 rounded-full bg-neutral-border" />;
}

// ─── Walkthrough Tab Content ───────────────────────────────────

function WalkthroughTabContent({
  lead,
  leadId,
  canPerformWalkthrough,
  canScheduleWalkthrough,
}: {
  lead: Record<string, unknown>;
  leadId: string;
  // `perform_walkthrough Lead` — gates recording notes + completing (POST /walkthrough,
  // /walkthrough/complete). A strict TECHNICIAN holds this but NOT `update Lead`.
  canPerformWalkthrough: boolean;
  // `schedule_walkthrough Lead` — gates the scheduling form (POST /walkthrough/schedule).
  canScheduleWalkthrough: boolean;
}) {
  // Scheduling values mean the ORG's clock, never the viewer's browser.
  const timezone = useScheduleTimezone();
  const queryClient = useQueryClient();
  const [wtScheduled, setWtScheduled] = useState('');
  const [wtDuration, setWtDuration] = useState('60');
  const [wtPerformers, setWtPerformers] = useState<string[]>([]);
  const [wtNotes, setWtNotes] = useState('');
  const [historyOpen, setHistoryOpen] = useState(false);

  // Seed the walkthrough form from the lead, re-seeding whenever the lead's own values change -
  // or when the org-timezone query lands after mount, which is why `timezone` is in the key.
  //
  // Adjusted during render rather than in an effect: React's documented way to reset state when a
  // prop changes, and what `react-hooks/set-state-in-effect` (enforced on changed lines in CI)
  // requires. Same `lastSeed` sentinel as RecordEstimatePaymentDialog. Seeded to `null` rather
  // than the first key so the seed still runs on mount, the way the effect it replaces did.
  const wtPerformerIds = ((lead.walkthrough_performers as { user: { id: string } }[] | undefined) ?? []).map((p) => p.user.id);
  const wtSeedKey = [
    (lead.walkthrough_scheduled_at as string | null) ?? '',
    (lead.walkthrough_duration_minutes as number | null) ?? '',
    wtPerformerIds.join(','),
    (lead.walkthrough_notes as string | null) ?? '',
    timezone,
  ].join('|');
  const [lastWtSeed, setLastWtSeed] = useState<string | null>(null);
  if (wtSeedKey !== lastWtSeed) {
    setLastWtSeed(wtSeedKey);
    setWtScheduled(isoToPickerValue(lead.walkthrough_scheduled_at as string | null, timezone));
    setWtDuration(String((lead.walkthrough_duration_minutes as number | null) ?? 60));
    setWtPerformers(wtPerformerIds);
    setWtNotes((lead.walkthrough_notes as string) || '');
  }

  const isCompleted = Boolean(lead.walkthrough_completed_at);
  const isCancelled = Boolean(lead.walkthrough_cancelled_at);
  const isScheduled = isWalkthroughActive(
    lead.walkthrough_scheduled_at,
    lead.walkthrough_completed_at,
    lead.walkthrough_cancelled_at,
  );
  const completedAt = lead.walkthrough_completed_at as string | null;
  const cancelledAt = lead.walkthrough_cancelled_at as string | null;
  const cancelledReason = lead.walkthrough_cancelled_reason as string | null;
  const performers = (lead.walkthrough_performers as { user: UserSummary }[] | undefined) ?? [];
  const performerLabel = performers.length > 0
    ? performers.map((p) => `${p.user.first_name} ${p.user.last_name}`).join(', ')
    : null;

  // D14: the tab shows the CURRENT visit (above) with a visit count + history behind it,
  // rather than branching on the retired lead-status values. History excludes whichever row the
  // state-specific content below is already describing as the "current" one.
  const visitCount = (lead.walkthrough_count as number | undefined) ?? 0;
  const visitHistory = (lead.walkthrough_history as VisitHistoryRow[] | undefined) ?? [];
  const pastVisits = visitHistory.filter((w) => {
    if (isCompleted) return !(w.status === 'COMPLETED' && w.completed_at === completedAt);
    if (isCancelled) return !(w.status === 'CANCELLED' && w.cancelled_at === cancelledAt);
    if (isScheduled) return w.status !== 'SCHEDULED';
    return w.status !== 'REQUESTED';
  });

  const visitHistorySection = visitCount > 1 && (
    <div>
      {/* eyebrow-style plain-text disclosure toggle, no hover-bg - no matching Button variant/tone cell - left raw */}
      <button
        type="button"
        onClick={() => setHistoryOpen((open) => !open)}
        className="flex items-center gap-1.5 text-xs font-semibold text-text-secondary uppercase tracking-wide hover:text-text-primary transition-colors"
      >
        <ChevronDown className={`h-3.5 w-3.5 transition-transform ${historyOpen ? '' : '-rotate-90'}`} />
        {visitCount} Visits Total
      </button>
      {historyOpen && (
        <div className="mt-2 space-y-2">
          {pastVisits.length === 0 ? (
            <p className="text-xs text-text-secondary">No earlier visits.</p>
          ) : (
            pastVisits.map((w) => (
              <div key={w.id} className="flex items-start gap-2.5 rounded-lg border border-border p-2.5 text-sm">
                <span
                  className={`mt-1 inline-block h-1.5 w-1.5 shrink-0 rounded-full ${
                    w.status === 'COMPLETED'
                      ? 'bg-success-strong'
                      : w.status === 'CANCELLED'
                        ? 'bg-danger-strong'
                        : 'bg-neutral-border'
                  }`}
                />
                <div className="min-w-0">
                  <p className="font-medium">
                    {w.status === 'COMPLETED' && w.completed_at
                      ? `Completed ${formatDateTime(w.completed_at, timezone)}`
                      : w.status === 'CANCELLED' && w.cancelled_at
                        ? `Cancelled ${formatDateTime(w.cancelled_at, timezone)}`
                        : w.scheduled_at
                          ? `Scheduled ${formatDateTime(w.scheduled_at, timezone)}`
                          : 'Requested'}
                  </p>
                  {w.status === 'CANCELLED' && w.cancelled_reason && (
                    <p className="text-xs text-text-secondary mt-0.5">{w.cancelled_reason}</p>
                  )}
                </div>
              </div>
            ))
          )}
        </div>
      )}
    </div>
  );

  // (The walkthrough form is seeded during render, above — see `wtSeedKey`.)

  // Schedule walkthrough mutation
  const scheduleMutation = useMutation({
    mutationFn: async () => {
      await api.post(`/api/leads/${leadId}/walkthrough/schedule`, {
        walkthrough_scheduled_at: pickerValueToIso(wtScheduled, timezone),
        performer_ids: wtPerformers,
        walkthrough_duration_minutes: Number(wtDuration),
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['lead', leadId] });
    },
  });

  // Complete walkthrough mutation
  const completeMutation = useMutation({
    mutationFn: async () => {
      await api.post(`/api/leads/${leadId}/walkthrough/complete`);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['lead', leadId] });
    },
  });

  // Save walkthrough notes
  const saveNotesMutation = useMutation({
    mutationFn: async () => {
      await api.post(`/api/leads/${leadId}/walkthrough`, {
        walkthrough_notes: wtNotes || null,
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['lead', leadId] });
    },
  });

  // Completed state
  if (isCompleted) {
    return (
      <div className="p-6 space-y-6">
        {/* Completed banner */}
        <div className="rounded-lg bg-success-surface border border-success-border p-4 flex items-center gap-3">
          <CheckCircle2 className="h-5 w-5 text-success-text shrink-0" />
          <div>
            <p className="text-sm font-semibold text-success-text">
              Completed on {formatDateTime(completedAt!, timezone)}
            </p>
            {performerLabel && (
              <p className="text-xs text-success-text mt-0.5">
                by {performerLabel}
              </p>
            )}
          </div>
        </div>

        {/* Schedule Info (read-only) */}
        <div>
          {/* eyebrow style, no matching Heading variant - left raw */}
          <h3 className="text-xs font-semibold text-text-secondary uppercase tracking-wide mb-3">
            Schedule Info
          </h3>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 text-sm">
            <div>
              <span className="text-text-secondary">Scheduled: </span>
              <span>{lead.walkthrough_scheduled_at ? formatDateTime(lead.walkthrough_scheduled_at as string, timezone) : '—'}</span>
            </div>
            <div>
              <span className="text-text-secondary">Duration: </span>
              <span>{(lead.walkthrough_duration_minutes as number | null) ?? 60} min</span>
            </div>
            <div>
              <span className="text-text-secondary">Performer: </span>
              <span>{performerLabel ?? '—'}</span>
            </div>
          </div>
        </div>

        {visitHistorySection}

        {/* Notes */}
        <div>
          {/* eyebrow style, no matching Heading variant - left raw */}
          <h3 className="text-xs font-semibold text-text-secondary uppercase tracking-wide mb-3">
            Notes
          </h3>
          <Textarea
            value={wtNotes}
            onChange={(e) => setWtNotes(e.target.value)}
            rows={4}
            placeholder="Walkthrough notes..."
            disabled={!canPerformWalkthrough}
          />
          {canPerformWalkthrough && wtNotes !== ((lead.walkthrough_notes as string) || '') && (
            <Button
              size="sm"
              className="mt-2"
              onClick={() => saveNotesMutation.mutate()}
              disabled={saveNotesMutation.isPending}
            >
              {saveNotesMutation.isPending ? 'Saving...' : 'Save Notes'}
            </Button>
          )}
        </div>

        {/* Attachments */}
        <div>
          {/* eyebrow style, no matching Heading variant - left raw */}
          <h3 className="text-xs font-semibold text-text-secondary uppercase tracking-wide mb-3">
            Attachments
          </h3>
          <AttachmentSection
            entityType="LEAD"
            entityId={leadId}
            context="WALKTHROUGH"
          />
        </div>
      </div>
    );
  }

  // Scheduled state
  if (isScheduled) {
    return (
      <div className="p-6 space-y-6">
        {/* Schedule Info (read-only) */}
        <div>
          {/* eyebrow style, no matching Heading variant - left raw */}
          <h3 className="text-xs font-semibold text-text-secondary uppercase tracking-wide mb-3">
            Schedule Info
          </h3>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 text-sm">
            <div>
              <span className="text-text-secondary">Scheduled: </span>
              <span className="font-medium">{lead.walkthrough_scheduled_at ? formatDateTime(lead.walkthrough_scheduled_at as string, timezone) : '—'}</span>
            </div>
            <div>
              <span className="text-text-secondary">Duration: </span>
              <span className="font-medium">{(lead.walkthrough_duration_minutes as number | null) ?? 60} min</span>
            </div>
            <div>
              <span className="text-text-secondary">Performer: </span>
              <span className="font-medium">{performerLabel ?? '—'}</span>
            </div>
          </div>
        </div>

        {visitHistorySection}

        {/* Notes */}
        <div>
          {/* eyebrow style, no matching Heading variant - left raw */}
          <h3 className="text-xs font-semibold text-text-secondary uppercase tracking-wide mb-3">
            Notes
          </h3>
          <Textarea
            value={wtNotes}
            onChange={(e) => setWtNotes(e.target.value)}
            rows={4}
            placeholder="Walkthrough notes..."
            disabled={!canPerformWalkthrough}
          />
          {canPerformWalkthrough && wtNotes !== ((lead.walkthrough_notes as string) || '') && (
            <Button
              size="sm"
              className="mt-2"
              onClick={() => saveNotesMutation.mutate()}
              disabled={saveNotesMutation.isPending}
            >
              {saveNotesMutation.isPending ? 'Saving...' : 'Save Notes'}
            </Button>
          )}
          {saveNotesMutation.error && (
            <p className="text-sm text-danger mt-1">Failed to save notes</p>
          )}
        </div>

        {/* Attachments */}
        <div>
          {/* eyebrow style, no matching Heading variant - left raw */}
          <h3 className="text-xs font-semibold text-text-secondary uppercase tracking-wide mb-3">
            Attachments
          </h3>
          <AttachmentSection
            entityType="LEAD"
            entityId={leadId}
            context="WALKTHROUGH"
          />
        </div>

        {/* Action button */}
        {canPerformWalkthrough && (
          <div>
            <Button
              onClick={() => completeMutation.mutate()}
              disabled={completeMutation.isPending}
            >
              <CheckCircle2 className="mr-2 h-4 w-4" />
              {completeMutation.isPending ? 'Completing...' : 'Complete Walkthrough'}
            </Button>
            {completeMutation.error && (
              <p className="text-sm text-danger mt-2">
                {extractApiError(completeMutation.error, 'Failed to complete walkthrough')}
              </p>
            )}
          </div>
        )}
      </div>
    );
  }

  // Default: no active visit - show the scheduling form for the next one. Covers both a fresh
  // REQUESTED-only lead and D12's "cancelled with nothing rebooked" case (a cancelled visit
  // always leaves a fresh REQUESTED row behind, which is exactly this branch).
  return (
    <div className="p-6 space-y-6">
      {isCancelled && (
        <div className="rounded-lg bg-danger-surface border border-danger-border p-4 flex items-center gap-3">
          <Ban className="h-5 w-5 text-danger-text shrink-0" />
          <div>
            <p className="text-sm font-semibold text-danger-text">
              Last visit cancelled {cancelledAt ? formatDateTime(cancelledAt, timezone) : ''}
            </p>
            {cancelledReason && (
              <p className="text-xs text-danger-text mt-0.5">{cancelledReason}</p>
            )}
          </div>
        </div>
      )}

      {visitHistorySection}

      {/* Schedule Info (editable) */}
      <div>
        {/* eyebrow style, no matching Heading variant - left raw */}
        <h3 className="text-xs font-semibold text-text-secondary uppercase tracking-wide mb-3">
          Schedule Info
        </h3>
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
          <div>
            <Label className="text-xs">Date &amp; Time</Label>
            <DateTimePicker
              value={wtScheduled}
              onChange={setWtScheduled}
              className="mt-1"
              disabled={!canScheduleWalkthrough}
            />
          </div>
          <div>
            <Label className="text-xs">Duration</Label>
            <Select value={wtDuration} onValueChange={setWtDuration} disabled={!canScheduleWalkthrough}>
              <SelectTrigger className="mt-1">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="30">30 minutes</SelectItem>
                <SelectItem value="60">1 hour</SelectItem>
                <SelectItem value="90">1.5 hours</SelectItem>
                <SelectItem value="120">2 hours</SelectItem>
                <SelectItem value="180">3 hours</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div>
            <Label className="text-xs">Performers</Label>
            <div className="mt-1">
              <MultiAssigneeSelect
                value={wtPerformers}
                onChange={setWtPerformers}
                placeholder="Add performer..."
                disabled={!canScheduleWalkthrough}
              />
            </div>
          </div>
        </div>
      </div>

      {/* Notes */}
      <div>
        {/* eyebrow style, no matching Heading variant - left raw */}
        <h3 className="text-xs font-semibold text-text-secondary uppercase tracking-wide mb-3">
          Notes
        </h3>
        <Textarea
          value={wtNotes}
          onChange={(e) => setWtNotes(e.target.value)}
          rows={4}
          placeholder="Walkthrough notes..."
          disabled={!canPerformWalkthrough}
        />
      </div>

      {/* Attachments */}
      <div>
        {/* eyebrow style, no matching Heading variant - left raw */}
        <h3 className="text-xs font-semibold text-text-secondary uppercase tracking-wide mb-3">
          Attachments
        </h3>
        <AttachmentSection
          entityType="LEAD"
          entityId={leadId}
          context="WALKTHROUGH"
        />
      </div>

      {/* Action button */}
      {canScheduleWalkthrough && (
        <div>
          <Button
            onClick={() => scheduleMutation.mutate()}
            disabled={!wtScheduled || wtPerformers.length === 0 || scheduleMutation.isPending}
          >
            <Calendar className="mr-2 h-4 w-4" />
            {scheduleMutation.isPending ? 'Scheduling...' : 'Schedule Walkthrough'}
          </Button>
          {scheduleMutation.error && (
            <p className="text-sm text-danger mt-2">
              {extractApiError(scheduleMutation.error, 'Failed to schedule walkthrough')}
            </p>
          )}
        </div>
      )}
    </div>
  );
}

// ─── Main Component ───────────────────────────────────────────

export default function LeadDetailPage() {
  // Scheduling values mean the ORG's clock, never the viewer's browser.
  const timezone = useScheduleTimezone();
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const location = useLocation();
  const queryClient = useQueryClient();
  const ability = useAppAbility();
  // In-app call entry (E2): comms-enabled org + create Communication → the
  // phone link routes into the /phone tab with lead attribution (Task B4
  // cross-tab handoff); else native tel:.
  const canAccessComms = useFeature('phone');
  const canPlaceCall = canAccessComms && ability.can('create', 'Communication');
  const incomingBreadcrumbs: BreadcrumbItem[] | undefined = location.state?.breadcrumbs;

  const [lostOpen, setLostOpen] = useState(false);
  const [cancelOpen, setCancelOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [cancelWtOpen, setCancelWtOpen] = useState(false);
  const [createJobOpen, setCreateJobOpen] = useState(false);
  const [assignOpen, setAssignOpen] = useState(false);
  const [preselectEstimateId, setPreselectEstimateId] = useState<string | null>(null);
  const [searchParams, setSearchParams] = useSearchParams();
  const [activeTab, setActiveTab] = useState('overview');

  useEffect(() => {
    const cj = searchParams.get('createJob');
    if (!cj) return;
    setPreselectEstimateId(cj);
    setCreateJobOpen(true);
    const next = new URLSearchParams(searchParams);
    next.delete('createJob');
    setSearchParams(next, { replace: true });
  }, [searchParams, setSearchParams]);

  // Deep-link from Spider Notification, Leads list or other entry points:
  // Whitelisted to valid tabs so an arbitrary ?tab= can't select an invalid tab.
  useEffect(() => {
    const tab = searchParams.get('tab');
    if (!tab) return;
    if (tab === 'walkthrough' || tab === 'communication' || tab === 'estimates' || tab === 'tasks' || tab === 'overview') {
      setActiveTab(tab);
      const next = new URLSearchParams(searchParams);
      next.delete('tab');
      setSearchParams(next, { replace: true });
    }
  }, [searchParams, setSearchParams]);
  const { data: leadAttachments } = useQuery({
    queryKey: ['attachments', 'LEAD', id],
    queryFn: async () => {
      const { data } = await api.get(`/api/attachments/lead/${id}`);
      return (data.attachments ?? []) as Array<{ context: string }>;
    },
    enabled: Boolean(id),
  });
  const attachmentCount = (leadAttachments ?? []).filter((a) => a.context === 'OTHER').length;

  const { data: lead, isLoading } = useQuery({
    queryKey: ['lead', id],
    queryFn: async () => {
      const { data } = await api.get(`/api/leads/${id}`);
      return data.lead;
    },
    enabled: Boolean(id),
  });

  // Status change mutation
  const statusMutation = useMutation({
    mutationFn: async (status: string) => {
      await api.patch(`/api/leads/${id}`, { status });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['lead', id] });
      queryClient.invalidateQueries({ queryKey: ['leads'] });
    },
    // lib/axios.ts only intercepts 401/429/402, so without this a rejected status
    // (e.g. a value that is not a LeadStatus) closed the menu and did nothing at all.
    onError: (err: unknown) => {
      toast({
        title: 'Could not update the lead status',
        description: extractApiError(err, 'The status change was not saved'),
        variant: 'destructive',
      });
    },
  });

  // SRVW-114 slice 3 - Extra Info panel's custom-field values, riding the lead's existing
  // PATCH the same way JobDetailPage's customFieldsMutation rides the job's.
  const customFieldsMutation = useMutation({
    mutationFn: (body: Record<string, unknown>) => api.patch(`/api/leads/${id}`, body),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['lead', id] }),
    onError: (err: unknown) => {
      toast({ title: extractApiError(err, 'Could not save'), variant: 'destructive' });
    },
  });

  // Hard-delete (only enabled when the lead has no estimates).
  const deleteMutation = useMutation({
    mutationFn: () => deleteLead(id!),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['leads'] });
      navigate('/leads');
    },
  });

  // Convert to Job — mirrors EstimateDetailPage's createJobMutation: the backend
  // turns the WON estimate into a job via POST /api/jobs { estimate_id }.
  const createJobMutation = useMutation({
    mutationFn: async (estimateId: string) => {
      const { data } = await api.post('/api/jobs', { estimate_id: estimateId });
      return data.job;
    },
    onSuccess: (job) => {
      queryClient.invalidateQueries({ queryKey: ['jobs'] });
      navigate(`/jobs/${job.id}`);
    },
    onError: (err: unknown) => {
      // The Create-Job modal stays open on error; surface the failure
      // (e.g. deposit not collected) as a toast rather than inline text.
      toast({
        title: 'Could not convert to job',
        description: extractApiError(err, 'Failed to create job from this estimate'),
        variant: 'destructive',
      });
    },
  });

  // Action-button visibility is gated on CASL ability (not role literals) so the
  // UI tracks the grant catalog + per-user overrides — see #238. Each flag maps to
  // the exact (action, subject) its backend route enforces (PATCH /leads/:id =
  // `update Lead` for both edit and status change).
  const canEdit = ability.can('update', 'Lead');
  // Walkthrough capabilities are split from `update Lead` to mirror the backend
  // routes: POST /walkthrough + /walkthrough/complete = `perform_walkthrough`,
  // POST /walkthrough/schedule = `schedule_walkthrough`. A strict TECHNICIAN holds
  // `perform_walkthrough` (record notes + complete) but NOT `update`/`schedule` — so
  // gating these on `update Lead` would lock a tech out of their core job (#232/#238).
  const canPerformWalkthrough = ability.can('perform_walkthrough', 'Lead');
  const canScheduleWalkthrough = ability.can('schedule_walkthrough', 'Lead');
  const canChangeStatus = ability.can('update', 'Lead');
  const canAssign = ability.can('assign', 'Lead');
  const canReadComms = ability.can('read', 'Communication');
  const isNotTerminal = lead && lead.status !== 'WON' && lead.status !== 'LOST' && lead.status !== 'CANCELLED';
  const canMarkLost = isNotTerminal && ability.can('mark_lost', 'Lead');
  // Cancel is the administrative-void counterpart to mark-lost; same terminal guard.
  const canCancel = isNotTerminal && ability.can('cancel', 'Lead');
  const isTerminal = lead && ['WON', 'LOST', 'CANCELLED'].includes(lead.status);
  const canCreateEstimate = ability.can('create', 'Estimate') && !isTerminal;
  const isWalkthroughScheduled = isWalkthroughActive(
    lead?.walkthrough_scheduled_at,
    lead?.walkthrough_completed_at,
    lead?.walkthrough_cancelled_at,
  );

  // Derived KPI values
  const estimates = (lead?.estimates ?? []) as Array<{
    id: string; estimate_number: string; status: string;
    total_amount: string; created_at: string;
    creator?: { id: string; first_name: string; last_name: string };
    deposit?: { id: string; status: string; amount: number | string } | null;
    job?: { id: string; job_number: string; status: string } | null;
  }>;
  const estimateTotal = estimates.reduce((sum, e) => sum + parseFloat(String(e.total_amount || '0')), 0);
  const estimateCount = estimates.length;
  // Convert-to-Job gate (bug #12): same capability EstimateDetailPage uses to show
  // "Create Job" (`create Job`), plus a WON estimate.
  const approvedEstimate = estimates.find((e) => e.status === 'WON');
  const canConvertToJob = ability.can('create', 'Job');
  const daysOpen = lead ? Math.floor((Date.now() - new Date(lead.created_at).getTime()) / (1000 * 60 * 60 * 24)) : 0;
  // Delete is available only with zero estimates, and gated by ability.
  const canDelete = ability.can('delete', 'Lead') && estimateCount === 0;

  const hasHeaderActions =
    canCreateEstimate || canEdit || canAssign ||
    canConvertToJob || (isWalkthroughScheduled && canEdit) ||
    canMarkLost || canCancel || canDelete;

  // Polymorphic tags (replaces old lead_tags shape)
  const tags: Tag[] = (lead?.tags ?? []) as Tag[];

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-12">
        <div className="h-8 w-8 animate-spin rounded-full border-4 border-primary border-t-transparent" />
      </div>
    );
  }

  if (!lead) {
    return (
      <div className="rounded-xl bg-surface-light p-6 shadow-card border border-border text-center">
        <p className="text-text-secondary">Lead not found.</p>
        <Button variant="outline" className="mt-4" onClick={() => navigate('/leads')}>
          Back to Leads
        </Button>
      </div>
    );
  }

  const customer = lead.customer as {
    id: string; first_name: string; last_name: string;
    company_name?: string; email?: string; phone: string; phone_ext?: string;
    service_locations?: Array<{
      id: string; address_line1: string; address_line2?: string | null;
      city: string; state: string; zip: string; is_primary: boolean;
    }>;
  };

  // Lead owner = the SINGLE commission_owner (scheduler redesign).
  const assignedUser = lead.commission_owner as UserSummary | null;
  const walkthroughPerformersList = (lead.walkthrough_performers as { user: UserSummary }[] | undefined) ?? [];
  const walkthroughPerformerLabel = walkthroughPerformersList.length > 0
    ? walkthroughPerformersList.map((p) => `${p.user.first_name} ${p.user.last_name}`).join(', ')
    : null;

  // Build breadcrumb trail for child navigation (Lead -> Estimate)
  const customerLabel = customerDisplayName(customer);
  const leadBreadcrumbs: BreadcrumbItem[] = incomingBreadcrumbs
    ? [...incomingBreadcrumbs, { label: `Lead from ${customerLabel}`, href: `/leads/${id}` }]
    : [{ label: 'Leads', href: '/leads' }, { label: `Lead from ${customerLabel}`, href: `/leads/${id}` }];
  const navWithBreadcrumbs = (path: string) =>
    navigate(path, { state: { breadcrumbs: leadBreadcrumbs } });

  return (
    <IconRail entityType="LEAD" entityId={id!}>
    <div className="space-y-4">
      {/* Breadcrumb */}
      <Breadcrumb items={
        incomingBreadcrumbs
          ? [...incomingBreadcrumbs, { label: `Lead from ${customerLabel}` }]
          : [{ label: 'Leads', href: '/leads' }, { label: `Lead from ${customerLabel}` }]
      } />

      {/* Single Unified Card */}
      <div className="rounded-xl bg-surface-light shadow-card border border-border overflow-hidden">

        {/* Header */}
        <div className="p-5">
          <div className="flex items-start justify-between gap-4">
            <div>
              <div className="flex items-center gap-2">
                <Heading>
                  {lead.lead_number as string} – {customerLabel}
                </Heading>
                <StatusDropdown
                  currentStatus={lead.status}
                  onStatusChange={(s) => statusMutation.mutate(s)}
                  disabled={!canChangeStatus || statusMutation.isPending}
                />
              </div>
              <div className="flex items-center gap-3 mt-1 text-xs text-text-secondary">
                {customer.company_name && <span>{customer.company_name}</span>}
                <span>Created {formatDate(lead.created_at)}</span>
              </div>
              <div className="mt-2">
                <TagInput leadId={id!} tags={tags} />
              </div>
            </div>

            <div className="flex items-center justify-end">
              {hasHeaderActions && (
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button variant="outline" size="sm" aria-label="Lead actions">
                      <MoreHorizontal className="h-4 w-4" />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent
                    align="end"
                    onCloseAutoFocus={(e) => {
                      // Assign opens a follow-up popover; keep focus with it instead of
                      // restoring focus to this trigger (which would dismiss the popover).
                      if (assignOpen) e.preventDefault();
                    }}
                  >
                    {canCreateEstimate && (
                      <DropdownMenuItem onClick={() => navWithBreadcrumbs(`/estimates/new?lead_id=${id}`)}>
                        <FileText className="mr-2 h-4 w-4" /> Create Estimate
                      </DropdownMenuItem>
                    )}
                    {canEdit && (
                      <DropdownMenuItem onClick={() => navigate(`/leads/${id}/edit`)}>
                        <Pencil className="mr-2 h-4 w-4" /> Edit
                      </DropdownMenuItem>
                    )}
                    {canAssign && (
                      <DropdownMenuItem onSelect={() => setAssignOpen(true)}>
                        <User className="mr-2 h-4 w-4" /> Assign
                      </DropdownMenuItem>
                    )}
                    {canConvertToJob && (
                      <DropdownMenuItem onClick={() => setCreateJobOpen(true)}>
                        <Briefcase className="mr-2 h-4 w-4" /> Convert to job
                      </DropdownMenuItem>
                    )}
                    {isWalkthroughScheduled && canEdit && (
                      <DropdownMenuItem onClick={() => setCancelWtOpen(true)} variant="destructive">
                        Cancel Walkthrough
                      </DropdownMenuItem>
                    )}
                    {canMarkLost && (
                      <DropdownMenuItem onClick={() => setLostOpen(true)} variant="destructive">
                        <AlertTriangle className="mr-2 h-4 w-4" /> Mark Lost
                      </DropdownMenuItem>
                    )}
                    {canCancel && (
                      <DropdownMenuItem onClick={() => setCancelOpen(true)} variant="destructive">
                        <Ban className="mr-2 h-4 w-4" /> Cancel Lead
                      </DropdownMenuItem>
                    )}
                    {canDelete && (
                      <DropdownMenuItem onClick={() => setDeleteOpen(true)} variant="destructive">
                        <Trash2 className="mr-2 h-4 w-4" /> Delete
                      </DropdownMenuItem>
                    )}
                  </DropdownMenuContent>
                </DropdownMenu>
              )}
              {canAssign && (
                <AssignLeadPopover
                  leadId={id!}
                  currentAssignedTo={(lead.commission_owner as { id: string } | null)?.id ?? null}
                  open={assignOpen}
                  onOpenChange={setAssignOpen}
                  trigger={<span aria-hidden="true" tabIndex={-1} className="pointer-events-none h-0 w-0" />}
                />
              )}
            </div>
          </div>
        </div>

        {/* KPI Strip */}
        <div className="border-t border-border flex divide-x divide-border">
          <div className="flex-1 px-5 py-4">
            <p className="text-[10px] font-semibold uppercase tracking-widest text-text-secondary">Estimated Value</p>
            <p className="text-xl font-bold text-text-primary mt-0.5">
              {estimateTotal > 0 ? formatCurrency(estimateTotal) : '\u2014'}
            </p>
          </div>
          <div className="flex-1 px-5 py-4">
            <p className="text-[10px] font-semibold uppercase tracking-widest text-text-secondary">Estimates</p>
            <p className="text-xl font-bold text-text-primary mt-0.5">{estimateCount}</p>
          </div>
          <div className="flex-1 px-5 py-4">
            <p className="text-[10px] font-semibold uppercase tracking-widest text-text-secondary">Days Open</p>
            <p className="text-xl font-bold text-text-primary mt-0.5">{daysOpen}</p>
          </div>
          <div className="flex-1 px-5 py-4">
            <p className="text-[10px] font-semibold uppercase tracking-widest text-text-secondary">Source</p>
            <p className="text-xl font-bold text-text-primary mt-0.5">{(lead.customer as { ad_source?: string | null })?.ad_source || '\u2014'}</p>
          </div>
        </div>

        {/* Tabs. Phase 11.6 retired DetailPageShell's `railWrapperClassName`/
            `listClassName` - TabStrip has no equivalent. `railWrapperClassName=
            "border-t border-border"` becomes this outer div, wrapping the whole
            TabStrip instead of just the rail: since the rail is TabStrip's own
            FIRST rendered element, the top border on the outer wrapper lands at
            the identical position the same border on a rail-only wrapper would
            have. `listClassName="h-auto w-full justify-start p-0"` is dropped
            without a replacement - every one of those tokens is a redundant
            no-op given TabStrip's own defaults (no padding prop passed means no
            padding class either way; a block-level flex TabsList already fills
            its container's width without `w-full`; `justify-start` matches the
            browser's own default `justify-content` for a flex row). */}
        <div className="border-t border-border">
        <TabStrip
          active={activeTab}
          onChange={setActiveTab}
          triggerVariant="underline"
          triggerClassName="px-5 py-3"
          tabs={[
            { value: 'overview', label: 'Overview' },
            {
              value: 'walkthrough',
              label: (
                <span className="flex items-center gap-2">
                  <WalkthroughDot
                    scheduledAt={lead.walkthrough_scheduled_at as string | null}
                    completedAt={lead.walkthrough_completed_at as string | null}
                    cancelledAt={lead.walkthrough_cancelled_at as string | null}
                  />
                  Walkthrough
                </span>
              ),
            },
            { value: 'estimates', label: `Estimates (${estimateCount})` },
            {
              value: 'attachments',
              label: (
                <span className="flex items-center gap-2">
                  <Paperclip className="h-3.5 w-3.5" />
                  Attachments ({attachmentCount})
                </span>
              ),
            },
            ...(canReadComms ? [{ value: 'communication', label: 'Communication' }] : []),
            { value: 'tasks', label: 'Tasks' },
          ]}
        >
          {/* ── Overview Tab ──────────────────────────────── */}
          <TabsContent value="overview" className="mt-0">
            <div className="flex flex-col lg:flex-row">
              {/* LEFT COLUMN (~65%) */}
              <div className="flex-[65] min-w-0">
                {/* Service Request */}
                <div className="p-5">
                  {/* eyebrow style, no matching Heading variant - left raw */}
                  <h2 className="text-xs font-semibold text-text-secondary uppercase tracking-wide mb-3">Service Request</h2>
                  <p className="text-sm whitespace-pre-wrap">{lead.service_request as string}</p>

                  {(lead.notes as string) && (
                    <div className="mt-3">
                      <Label className="text-xs">Lead Notes</Label>
                      <p className="mt-1 text-sm whitespace-pre-wrap text-text-secondary">{lead.notes as string}</p>
                    </div>
                  )}

                  <div className="flex gap-6 text-sm mt-3">
                    <div>
                      <span className="text-text-secondary">Source: </span>
                      <span className="font-medium">{(lead.customer as { ad_source?: string | null })?.ad_source || '\u2014'}</span>
                    </div>
                    <div>
                      <span className="text-text-secondary">Lead Type: </span>
                      <span className="font-medium">{(lead.lead_type as string) || '\u2014'}</span>
                    </div>
                  </div>

                  <div className="flex gap-6 text-sm mt-2">
                    <div>
                      <span className="text-text-secondary">Job Type: </span>
                      <span className="font-medium">{(lead.job_type as string) || '\u2014'}</span>
                    </div>
                    <div>
                      <span className="text-text-secondary">Created: </span>
                      <span className="font-medium">{formatDate(lead.created_at)}</span>
                    </div>
                  </div>

                  {((lead.scheduled_start as string) || (lead.scheduled_end as string)) && (
                    <div className="flex gap-6 text-sm mt-2">
                      {(lead.scheduled_start as string) && (
                        <div>
                          <span className="text-text-secondary">Scheduled Start: </span>
                          <span>{new Date(lead.scheduled_start as string).toLocaleString('en-US')}</span>
                        </div>
                      )}
                      {(lead.scheduled_end as string) && (
                        <div>
                          <span className="text-text-secondary">End: </span>
                          <span>{new Date(lead.scheduled_end as string).toLocaleString('en-US')}</span>
                        </div>
                      )}
                    </div>
                  )}

                  {(lead.status as string) === 'LOST' && (lead.lost_reason as string) && (
                    <div className="mt-3 rounded-lg bg-danger/5 border border-danger/20 p-3">
                      <p className="text-xs font-semibold text-danger">Lost Reason</p>
                      <p className="mt-1 text-sm">{lead.lost_reason as string}</p>
                      {(lead.lost_at as string) && (
                        <p className="mt-1 text-xs text-text-secondary">
                          Lost on {formatDate(lead.lost_at as string)}
                        </p>
                      )}
                    </div>
                  )}
                </div>

                {/* Walkthrough Summary Strip */}
                <div className="border-t border-border p-5">
                  {/* eyebrow style, no matching Heading variant - left raw */}
                  <h2 className="text-xs font-semibold text-text-secondary uppercase tracking-wide mb-3 flex items-center gap-2">
                    <Calendar className="h-3.5 w-3.5" />
                    Walkthrough
                  </h2>
                  {/* full-width card click target, not a button shape - left raw */}
                  <button
                    className="w-full text-left rounded-lg border border-border p-3 hover:bg-background-light/50 transition-colors"
                    onClick={() => setActiveTab('walkthrough')}
                  >
                    {isWalkthroughScheduled ? (
                      <div className="flex items-center gap-3">
                        <Clock className="h-4 w-4 text-info-text shrink-0" />
                        <div>
                          <p className="text-sm font-medium">
                            Scheduled for {formatDateTime(lead.walkthrough_scheduled_at as string, timezone)}
                          </p>
                          {walkthroughPerformerLabel && (
                            <p className="text-xs text-text-secondary mt-0.5">
                              with {walkthroughPerformerLabel}
                            </p>
                          )}
                        </div>
                      </div>
                    ) : lead.walkthrough_completed_at ? (
                      <div className="flex items-center gap-3">
                        <CheckCircle2 className="h-4 w-4 text-success-text shrink-0" />
                        <div>
                          <p className="text-sm font-medium">
                            Completed {formatDateTime(lead.walkthrough_completed_at as string, timezone)}
                          </p>
                          {walkthroughPerformerLabel && (
                            <p className="text-xs text-text-secondary mt-0.5">
                              by {walkthroughPerformerLabel}
                            </p>
                          )}
                        </div>
                      </div>
                    ) : (
                      <div className="flex items-center gap-3">
                        <Calendar className="h-4 w-4 text-text-secondary shrink-0" />
                        <p className="text-sm text-text-secondary">No walkthrough scheduled yet — click to schedule</p>
                      </div>
                    )}
                  </button>
                </div>
              </div>

              {/* RIGHT COLUMN (~35%) */}
              <div className="flex-[35] min-w-0 border-t lg:border-t-0 lg:border-l border-border">
                {/* Customer Contact */}
                <div className="p-5 space-y-2">
                  {/* bracket font size text-[10px], no matching scale key - left raw */}
                  <h2 className="text-[10px] font-semibold uppercase tracking-widest text-text-secondary mb-2">Customer</h2>
                  <Button
                    variant="link"
                    size={null}
                    className="block"
                    onClick={() => navWithBreadcrumbs(`/customers/${customer.id}`)}
                  >
                    {customer.first_name} {customer.last_name}
                  </Button>
                  {customer.company_name && (
                    <p className="text-xs text-text-secondary">{customer.company_name}</p>
                  )}
                  <div className="flex items-center gap-2 text-sm">
                    <Phone className="h-3.5 w-3.5 text-text-secondary shrink-0" />
                    {canPlaceCall ? (
                      // inherited-color-to-primary hover, no bg/underline - no matching Button variant/tone cell - left raw
                      <button
                        type="button"
                        onClick={() =>
                          requestCall(customer.phone, {
                            leadId: id!,
                            leadLabel: lead.lead_number as string,
                            customerId: customer.id,
                            customerName: customerLabel,
                          })
                        }
                        className="text-left hover:text-primary transition-colors"
                      >
                        {formatPhone(customer.phone)}{customer.phone_ext ? ` ext. ${customer.phone_ext}` : ''}
                      </button>
                    ) : (
                      <a href={`tel:${customer.phone}`} className="hover:text-primary transition-colors">
                        {formatPhone(customer.phone)}{customer.phone_ext ? ` ext. ${customer.phone_ext}` : ''}
                      </a>
                    )}
                  </div>
                  {customer.email && (
                    <div className="flex items-center gap-2 text-sm">
                      <Mail className="h-3.5 w-3.5 text-text-secondary shrink-0" />
                      <a href={`mailto:${customer.email}`} className="hover:text-primary transition-colors truncate">
                        {customer.email}
                      </a>
                    </div>
                  )}
                </div>

                {/* Assigned To */}
                <div className="border-t border-border p-5">
                  {/* bracket font size text-[10px], no matching scale key - left raw */}
                  <h2 className="text-[10px] font-semibold uppercase tracking-widest text-text-secondary mb-3">Assigned To</h2>
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2 text-sm">
                      <User className="h-4 w-4 text-text-secondary" />
                      <span className="font-medium">
                        {assignedUser
                          ? `${assignedUser.first_name} ${assignedUser.last_name}`
                          : 'Unassigned'}
                      </span>
                    </div>
                    {canAssign && (
                      <AssignLeadPopover
                        leadId={id!}
                        currentAssignedTo={(lead.commission_owner as { id: string } | null)?.id ?? null}
                        trigger={
                          <Button variant="outline" size="sm" className="h-7 text-xs">
                            Reassign
                          </Button>
                        }
                      />
                    )}
                  </div>
                </div>

                {/* Service Locations */}
                {(customer.service_locations?.length ?? 0) > 0 && (
                  <div className="border-t border-border p-5">
                    {/* bracket font size text-[10px], no matching scale key - left raw */}
                    <h2 className="text-[10px] font-semibold uppercase tracking-widest text-text-secondary mb-3">
                      Service Locations
                    </h2>
                    <div className="space-y-3">
                      {customer.service_locations!.map(loc => (
                        <div key={loc.id} className="flex items-start gap-2">
                          <MapPin className={`mt-0.5 h-4 w-4 shrink-0 ${loc.is_primary ? 'text-primary' : 'text-text-secondary'}`} />
                          <div className="flex-1 min-w-0">
                            <p className="text-sm leading-snug">
                              {loc.address_line1}{loc.address_line2 ? `, ${loc.address_line2}` : ''}
                            </p>
                            <p className="text-xs text-text-secondary">{loc.city}, {loc.state} {loc.zip}</p>
                            {loc.is_primary && (
                              <span className="inline-block mt-0.5 text-[9px] font-semibold uppercase tracking-wider text-primary border border-primary/40 rounded px-1.5 py-0.5">
                                Primary
                              </span>
                            )}
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {/* Org-defined custom fields. Renders nothing at all unless this org has
                    defined at least one LEAD-scoped field, so the column is unchanged for
                    everyone else. */}
                <ExtraInfoPanel
                  entityType="LEAD"
                  entityId={id!}
                  values={(lead.custom_fields as Record<string, unknown>) ?? {}}
                  onSave={(patch) => customFieldsMutation.mutateAsync({ custom_fields: patch })}
                  variant="plain"
                />
              </div>
            </div>
          </TabsContent>

          {/* ── Walkthrough Tab ────────────────────────────── */}
          <TabsContent value="walkthrough" className="mt-0">
            <WalkthroughTabContent lead={lead} leadId={id!} canPerformWalkthrough={canPerformWalkthrough} canScheduleWalkthrough={canScheduleWalkthrough} />
          </TabsContent>

          {/* ── Attachments Tab ────────────────────────────── */}
          <TabsContent value="attachments" className="mt-0">
            <div className="p-5">
              <AttachmentSection
                entityType="LEAD"
                entityId={id!}
                context="OTHER"
              />
            </div>
          </TabsContent>

          {/* ── Estimates Tab ──────────────────────────────── */}
          <TabsContent value="estimates" className="mt-0">
            <div className="p-5">
              <div className="flex items-center justify-between mb-4">
                {/* eyebrow style, no matching Heading variant - left raw */}
                <h2 className="text-xs font-semibold text-text-secondary uppercase tracking-wide">
                  Estimates ({estimateCount})
                </h2>
                {canCreateEstimate && (
                  <Button variant="solid" tone="business" size="sm" onClick={() => navWithBreadcrumbs(`/estimates/new?lead_id=${id}`)}>
                    + New Estimate
                  </Button>
                )}
              </div>

              {estimates.length === 0 ? (
                <EmptyState
                  icon={FileText}
                  title="No estimates yet."
                  description="Create one to get started."
                 
                />
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b border-border text-left text-xs uppercase tracking-wide text-text-secondary">
                        <th className="pb-2 pr-4 font-medium">Number</th>
                        <th className="pb-2 pr-4 font-medium">Status</th>
                        <th className="pb-2 pr-4 font-medium">Deposit</th>
                        <th className="pb-2 pr-4 font-medium">Created By</th>
                        <th className="pb-2 pr-4 font-medium">Date</th>
                        <th className="pb-2 pr-4 font-medium text-right">Total</th>
                        <th className="pb-2 w-8" />
                      </tr>
                    </thead>
                    <tbody>
                      {estimates.map(est => (
                        <tr
                          key={est.id}
                          className="group border-b border-border/50 hover:bg-background-light/50 cursor-pointer transition-colors"
                          onClick={() => navWithBreadcrumbs(`/estimates/${est.id}`)}
                        >
                          <td className="py-2 pr-4 font-medium text-primary">{est.estimate_number}</td>
                          <td className="py-2 pr-4"><StatusBadge domain="estimate" status={est.status} /></td>
                          <td className="py-2 pr-4">
                            {est.deposit
                              ? <StatusBadge domain="deposit" status={est.deposit.status} />
                              : <span className="text-text-secondary">—</span>}
                          </td>
                          <td className="py-2 pr-4 text-text-secondary">
                            {est.creator ? `${est.creator.first_name} ${est.creator.last_name}` : '\u2014'}
                          </td>
                          <td className="py-2 pr-4 text-text-secondary">{formatDateTime(est.created_at, timezone)}</td>
                          <td className="py-2 pr-4 tabular-nums text-right font-medium">{formatCurrency(est.total_amount)}</td>
                          <td className="py-2 w-8 text-right">
                            <Pencil className="h-3.5 w-3.5 text-text-secondary opacity-0 group-hover:opacity-100 transition-opacity inline-block" />
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          </TabsContent>

          {/* ── Tasks Tab ───────────────────────────── */}
          <TabsContent value="tasks" className="mt-0">
            <JobLeadTasksTab
              entity={{
                type: 'LEAD',
                id: lead.id,
                label: `Lead from ${customerDisplayName(customer)}`,
              }}
              jobType={(lead.job_type as string | null) ?? undefined}
            />
          </TabsContent>

          {/* ── Communication Tab (lead union — lead_id-linked ∪ customer-linked
                 rows via GET /api/leads/:id/communications; gated on read
                 Communication) ── */}
          {canReadComms && (
            <TabsContent value="communication" className="mt-0">
              <div className="p-5">
                <LeadCommunicationsTab
                  leadId={lead.id as string}
                  leadLabel={lead.lead_number as string}
                  customerId={customer.id}
                  customerName={customerLabel}
                  customerPhone={customer.phone}
                />
              </div>
            </TabsContent>
          )}
        </TabStrip>
        </div>
      </div>

      {/* Dialogs */}
      <MarkLostDialog
        open={lostOpen}
        onOpenChange={setLostOpen}
        leadId={id!}
      />
      <CancelLeadDialog
        open={cancelOpen}
        onOpenChange={setCancelOpen}
        leadId={id!}
      />
      <Dialog open={deleteOpen} onOpenChange={setDeleteOpen}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>Delete Lead</DialogTitle>
            <DialogDescription>
              Permanently delete this lead? This is only possible because it has no
              estimates. This cannot be undone.
            </DialogDescription>
          </DialogHeader>
          {deleteMutation.error && (
            <p className="text-sm text-danger">
              {extractApiError(deleteMutation.error, 'Failed to delete lead')}
            </p>
          )}
          <div className="flex justify-end gap-3">
            <Button variant="outline" onClick={() => setDeleteOpen(false)}>
              Cancel
            </Button>
            <Button
              variant="solid" tone="danger"
              onClick={() => deleteMutation.mutate()}
              disabled={deleteMutation.isPending}
            >
              {deleteMutation.isPending ? 'Deleting...' : 'Delete'}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
      <CancelWalkthroughDialog
        open={cancelWtOpen}
        onOpenChange={setCancelWtOpen}
        leadId={id!}
      />
      <CreateJobFromLeadDialog
        open={createJobOpen}
        onOpenChange={(open) => {
          setCreateJobOpen(open);
          // Clear the deep-link preselect on close so a later manual open
          // starts from a clean selection, not the previously-linked estimate.
          if (!open) setPreselectEstimateId(null);
        }}
        leadId={id!}
        estimates={estimates}
        canCreateEstimate={canCreateEstimate}
        preselectEstimateId={preselectEstimateId}
        isConverting={createJobMutation.isPending}
        onConvert={(estimateId) => createJobMutation.mutate(estimateId)}
      />
    </div>
    </IconRail>
  );
}
