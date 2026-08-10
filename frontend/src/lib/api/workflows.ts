import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import api from '@/lib/axios';
import { toast } from '@/components/ui/use-toast';
import { extractApiError } from '@/lib/utils';
import type { AnchorKey } from '@/lib/workflows/anchors';

// ── types (mirror backend/src/controllers/workflow.controller.ts + Prisma) ───

export type AutomationTriggerType =
  | 'JOB_SCHEDULED' | 'JOB_RESCHEDULED' | 'TECH_ASSIGNED' | 'JOB_COMPLETED' | 'JOB_CANCELLED'
  | 'ESTIMATE_SENT' | 'ESTIMATE_APPROVED' | 'ESTIMATE_DECLINED'
  | 'INVOICE_SENT' | 'INVOICE_PAID' | 'LEAD_CREATED'
  | 'LEAD_ASSIGNED' | 'WALKTHROUGH_SCHEDULED' | 'WALKTHROUGH_RESCHEDULED'
  | 'WALKTHROUGH_COMPLETED' | 'WALKTHROUGH_CANCELLED' | 'WALKTHROUGH_PERFORMER_ASSIGNED'
  | 'WALKTHROUGH_PERFORMER_REMOVED' | 'TECH_UNASSIGNED' | 'JOB_EN_ROUTE'
  | 'JOB_SUB_STATUS_ENTERED'
  | 'BEFORE_JOB_START' | 'AFTER_JOB_COMPLETED' | 'INVOICE_OVERDUE' | 'ESTIMATE_FOLLOW_UP'
  | 'JOB_DATE_ANCHORED' | 'LEAD_DATE_ANCHORED' | 'INVOICE_DATE_ANCHORED' | 'ESTIMATE_DATE_ANCHORED';

export type AutomationActionType = 'SEND_EMAIL' | 'SEND_SMS' | 'NOTIFY_TEAM';
export type AutomationSendWindow = 'ANYTIME' | 'BUSINESS_HOURS';

export type WorkflowStepType = 'WAIT' | 'SEND_TEXT' | 'SEND_EMAIL' | 'NOTIFY_TEAM' | 'STOP_IF';
export type WorkflowStatus = 'DRAFT' | 'PUBLISHED';

export type RecipientKey =
  | 'customer' | 'assigned_techs' | 'all_admins' | 'all_dispatchers' | 'specific_user' | 'custom';

/**
 * v2.1 multi-select audience keys (mirrors backend/src/services/automations/
 * recipients.ts's `RecipientKey`) — the 9-member replacement for the legacy
 * 6-member `RecipientKey` above. Named distinctly (not reusing `RecipientKey`)
 * because the legacy type is still load-bearing here: `ActionDef.recipients`,
 * `AutomationTemplate.action_config.recipient` and the existing single-Select
 * forms (lib/workflows/recipients.ts, describeWorkflow.ts) all still speak the
 * old 6-member shape — rewiring those to the 9-member set is the multi-select
 * UI migration, a later task.
 */
export type AudienceKey =
  | 'customer'
  | 'assigned_team'
  | 'dispatcher'
  | 'salesperson'
  | 'creator'
  | 'all_admins'
  | 'all_dispatchers'
  | 'specific_user'
  | 'custom'
  /** Legal only on TECH_UNASSIGNED / WALKTHROUGH_PERFORMER_REMOVED — see catalog.ts's audiencesFor. */
  | 'removed_user'
  /** Legal only on TECH_ASSIGNED / WALKTHROUGH_PERFORMER_ASSIGNED — see catalog.ts's audiencesFor. */
  | 'assigned_user';

/** One legal recipient audience for a trigger+action pair, as served by the catalog. */
export interface AudienceOption {
  key: AudienceKey;
  label: string;
  /** Present only for the audiences that aren't guaranteed to resolve to anyone (e.g. salesperson). */
  hint?: string;
}

/**
 * A messaging step's config in the v2.1 multi-select shape (mirrors backend
 * workflowValidation.ts's `MessagingConfig`, post-normalization). `WorkflowStep.
 * config` below stays `Record<string, unknown>` — a step can be any of five
 * types, and stored/draft configs may still carry the legacy singular
 * `recipient`/`custom_email`/`user_id` — this is the typed shape for a
 * SEND_TEXT/SEND_EMAIL/NOTIFY_TEAM config once you already know which one.
 */
export interface MessagingStepConfig {
  recipients: AudienceKey[];
  body: string;
  subject?: string;
  custom_emails?: string[];
  user_ids?: string[];
}

/** A step as returned by the API — always has an id once persisted. */
export interface WorkflowStep {
  id?: string;
  position: number;
  step_type: WorkflowStepType;
  config: Record<string, unknown>;
}

/** A step as sent to create/patch — the server renumbers positions from array order. */
export interface WorkflowStepInput {
  step_type: WorkflowStepType;
  config: Record<string, unknown>;
}

export interface ValidationIssue {
  step_index: number; // -1 for workflow-level issues
  path: string;
  message: string;
}

/**
 * A date-anchored trigger's (JOB/LEAD/INVOICE/ESTIMATE_DATE_ANCHORED) timing —
 * anchor + direction + offset instead of a bare offset. Mirrors backend
 * workflowValidation.ts's DateAnchorTriggerConfig (Task A4).
 */
export interface DateAnchorTriggerConfig {
  anchor: AnchorKey;
  direction: 'before' | 'after';
  offset_minutes: number;
}

/** A JOB_SUB_STATUS_ENTERED trigger's config (SRVW-113) — mirrors backend
 *  workflowValidation.ts's SubStatusTriggerConfig. */
export interface SubStatusTriggerConfig {
  sub_status_id: string;
}

export interface ApiWorkflow {
  id: string;
  name: string;
  status: WorkflowStatus;
  is_enabled: boolean;
  trigger_type: AutomationTriggerType;
  trigger_config: { offset_minutes: number } | DateAnchorTriggerConfig | SubStatusTriggerConfig | null;
  send_window: AutomationSendWindow;
  template_key: string | null;
  legacy_rule_id: string | null;
  published_at: string | null;
  last_triggered_at: string | null;
  trigger_count: number;
  created_at: string;
  updated_at: string;
  steps: WorkflowStep[];
  issues: ValidationIssue[];
  has_unpublished_changes: boolean;
  published_version: { version: number; published_at: string } | null;
}

export interface WorkflowInput {
  name: string;
  trigger_type: AutomationTriggerType;
  trigger_config?: { offset_minutes: number } | DateAnchorTriggerConfig | SubStatusTriggerConfig | null;
  send_window?: AutomationSendWindow;
  template_key?: string;
  steps?: WorkflowStepInput[];
}

export type PatchWorkflowInput = Partial<WorkflowInput>;

export interface TriggerDef {
  label: string;
  description: string;
  category: 'events' | 'timed' | 'date';
  entity: 'job' | 'estimate' | 'invoice' | 'lead';
  timeBased: boolean;
  defaultOffsetMinutes?: number;
  mergeFields: string[];
}

export interface ActionDef {
  label: string;
  description: string;
  recipients: RecipientKey[];
  requiresSubject: boolean;
}

export interface AutomationTemplate {
  key: string;
  name: string;
  description: string;
  category: 'customer' | 'team' | 'money';
  trigger_type: AutomationTriggerType;
  trigger_config?: { offset_minutes: number };
  action_type: AutomationActionType;
  action_config: {
    recipient: RecipientKey;
    subject?: string;
    body: string;
    custom_email?: string;
    user_id?: string;
  };
  /**
   * Optional full step sequence for multi-step recipes (e.g. an anchored WAIT
   * before a SEND_EMAIL). When present, `templateToWorkflowBody` uses it
   * verbatim instead of folding `action_type`/`action_config` into one step.
   */
  steps?: WorkflowStepInput[];
  send_window: AutomationSendWindow;
}

export interface WorkflowCatalog {
  triggers: Record<AutomationTriggerType, TriggerDef>;
  actions: Record<AutomationActionType, ActionDef>;
  /** Legal v2.1 audiences per trigger+action pair, channel-constrained + entity-narrowed. */
  audiences: Record<AutomationTriggerType, Record<AutomationActionType, AudienceOption[]>>;
  /** Legal anchor options per entity, for the builder's date-anchored trigger + anchored WAIT UI. */
  anchors: Record<'job' | 'estimate' | 'invoice' | 'lead', Array<{ key: AnchorKey; label: string }>>;
  merge_field_labels: Record<string, string>;
  sample_context: Record<string, string>;
  templates: AutomationTemplate[];
  stop_if: { conditions: Record<string, string[]>; labels: Record<string, string> };
  /** Per-org feature availability — e.g. whether the "Send text" step can be authored. */
  capabilities: { sms_available: boolean };
}

export interface DryRunStep {
  step_index: number;
  step_type: WorkflowStepType;
  outcome: 'would_send' | 'would_wait' | 'would_check' | 'needs_setup';
  detail?: string;
  rendered?: { subject?: string | null; body: string };
}

export interface TestWorkflowResult {
  steps: DryRunStep[];
  delivered: string[];
}

export interface ActivityRow {
  id: string;
  source: 'workflow' | 'legacy';
  when: string;
  step_index: number;
  step_type: WorkflowStepType;
  status: 'PENDING' | 'SENT' | 'SKIPPED' | 'FAILED' | 'STOPPED' | 'CONTINUED';
  recipient_summary: string | null;
  detail: string | null;
  entity_label: string | null;
}

export interface WorkflowActivityResult {
  rows: ActivityRow[];
}

// ── functions ─────────────────────────────────────────────────────────────────

export function listWorkflows(): Promise<ApiWorkflow[]> {
  return api.get('/api/workflows').then((r) => r.data);
}

export function getWorkflow(id: string): Promise<ApiWorkflow> {
  return api.get(`/api/workflows/${id}`).then((r) => r.data);
}

export function createWorkflow(body: WorkflowInput): Promise<ApiWorkflow> {
  return api.post('/api/workflows', body).then((r) => r.data);
}

export function patchWorkflow(id: string, body: PatchWorkflowInput): Promise<ApiWorkflow> {
  return api.patch(`/api/workflows/${id}`, body).then((r) => r.data);
}

export function publishWorkflow(id: string, body?: { enable?: boolean }): Promise<ApiWorkflow> {
  return api.post(`/api/workflows/${id}/publish`, body ?? {}).then((r) => r.data);
}

export function toggleWorkflow(id: string, is_enabled: boolean): Promise<ApiWorkflow> {
  return api.post(`/api/workflows/${id}/toggle`, { is_enabled }).then((r) => r.data);
}

export function deleteWorkflow(id: string): Promise<void> {
  return api.delete(`/api/workflows/${id}`).then((r) => r.data);
}

export function testWorkflow(id: string, body: { send_to_me?: boolean }): Promise<TestWorkflowResult> {
  return api.post(`/api/workflows/${id}/test`, body).then((r) => r.data);
}

export function getWorkflowActivity(id: string, limit?: number): Promise<WorkflowActivityResult> {
  return api.get(`/api/workflows/${id}/activity`, { params: { limit } }).then((r) => r.data);
}

export function getWorkflowCatalog(): Promise<WorkflowCatalog> {
  return api.get('/api/workflows/catalog').then((r) => r.data);
}

// ── hooks ─────────────────────────────────────────────────────────────────────

export function useWorkflows() {
  return useQuery<ApiWorkflow[]>({
    queryKey: ['workflows'],
    queryFn: listWorkflows,
  });
}

export function useWorkflow(id: string | undefined) {
  return useQuery<ApiWorkflow>({
    queryKey: ['workflows', id],
    queryFn: () => getWorkflow(id as string),
    enabled: Boolean(id),
  });
}

export function useWorkflowCatalog() {
  return useQuery<WorkflowCatalog>({
    queryKey: ['workflows', 'catalog'],
    queryFn: getWorkflowCatalog,
    staleTime: 10 * 60 * 1000, // static vocabulary — no need to refetch per navigation
  });
}

export function useWorkflowActivity(id: string | undefined, limit?: number) {
  return useQuery<WorkflowActivityResult>({
    queryKey: ['workflows', id, 'activity', limit],
    queryFn: () => getWorkflowActivity(id as string, limit),
    enabled: Boolean(id),
  });
}

export function useCreateWorkflow() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data: WorkflowInput) => createWorkflow(data),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['workflows'] }),
    onError: (err) =>
      toast({
        title: 'Could not create automation',
        description: extractApiError(err, 'Something went wrong saving the automation'),
        variant: 'destructive',
      }),
  });
}

export function usePatchWorkflow() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, data }: { id: string; data: PatchWorkflowInput }) => patchWorkflow(id, data),
    onSuccess: (_workflow, variables) => {
      qc.invalidateQueries({ queryKey: ['workflows'] });
      qc.invalidateQueries({ queryKey: ['workflows', variables.id] });
    },
    onError: (err) =>
      toast({
        title: 'Could not save automation',
        description: extractApiError(err, 'Something went wrong saving the automation'),
        variant: 'destructive',
      }),
  });
}

export function usePublishWorkflow() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, enable }: { id: string; enable?: boolean }) => publishWorkflow(id, { enable }),
    onSuccess: (_workflow, variables) => {
      qc.invalidateQueries({ queryKey: ['workflows'] });
      qc.invalidateQueries({ queryKey: ['workflows', variables.id] });
    },
    onError: (err) =>
      toast({
        title: 'Could not publish automation',
        description: extractApiError(err, 'Something went wrong publishing the automation'),
        variant: 'destructive',
      }),
  });
}

export function useToggleWorkflow() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, is_enabled }: { id: string; is_enabled: boolean }) => toggleWorkflow(id, is_enabled),
    onSuccess: (workflow, variables) => {
      qc.invalidateQueries({ queryKey: ['workflows'] });
      qc.invalidateQueries({ queryKey: ['workflows', variables.id] });
      toast({
        title: workflow.is_enabled ? 'Automation turned on' : 'Automation paused',
        description: workflow.name,
      });
    },
    onError: (err) =>
      toast({
        title: 'Could not update automation',
        description: extractApiError(err, 'Something went wrong'),
        variant: 'destructive',
      }),
  });
}

export function useDeleteWorkflow() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => deleteWorkflow(id),
    onSuccess: (_void, id) => {
      qc.invalidateQueries({ queryKey: ['workflows'] });
      qc.invalidateQueries({ queryKey: ['workflows', id] });
      toast({ title: 'Automation deleted' });
    },
    onError: (err) =>
      toast({
        title: 'Could not delete automation',
        description: extractApiError(err, 'Something went wrong'),
        variant: 'destructive',
      }),
  });
}

export function useTestWorkflow() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, send_to_me }: { id: string; send_to_me?: boolean }) => testWorkflow(id, { send_to_me }),
    onSuccess: (_result, variables) => {
      qc.invalidateQueries({ queryKey: ['workflows'] });
      qc.invalidateQueries({ queryKey: ['workflows', variables.id] });
    },
    onError: (err) =>
      toast({
        title: 'Test failed',
        description: extractApiError(err, 'Could not send the test'),
        variant: 'destructive',
      }),
  });
}
