/**
 * WorkflowsHome — the Automations landing page. Templates are the front
 * door: a blank canvas is never shown. Composition (top to bottom):
 *   1. Hero header — title, subtitle, primary "New automation".
 *   2. Stat band — Active / Paused / Sent all-time, derived from useWorkflows().
 *   3. My automations — only rendered once any workflow exists.
 *   4. Templates gallery — grouped by category; always shown (the front door).
 */

import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Plus, Zap, CheckCircle2, PauseCircle, Send, MoreHorizontal, ExternalLink, Copy, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import { Skeleton } from '@/components/ui/skeleton';
import { KpiTile } from '@/components/data/KpiStrip';
import { Heading } from '@/components/ui/heading';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { formatDistanceToNow } from 'date-fns';
import {
  useWorkflows,
  useWorkflowCatalog,
  useToggleWorkflow,
  useDeleteWorkflow,
  useCreateWorkflow,
  type ApiWorkflow,
  type AutomationTemplate,
  type WorkflowCatalog,
} from '@/lib/api/workflows';
import { describeWorkflow, templateToWorkflowBody } from '@/lib/workflows/describeWorkflow';
import { FlowTrail, CATEGORY_META, CATEGORY_ORDER, WorkflowStatusPill } from '@/components/workflows/workflow-visuals';

const fmt = (n: number) => new Intl.NumberFormat('en-US').format(n);

export default function WorkflowsHome() {
  const navigate = useNavigate();
  const { data: workflows, isLoading: workflowsLoading, isError: workflowsError, refetch: refetchWorkflows } =
    useWorkflows();
  const { data: catalog, isLoading: catalogLoading, isError: catalogError, refetch: refetchCatalog } =
    useWorkflowCatalog();
  const createWorkflow = useCreateWorkflow();
  const [deleteTarget, setDeleteTarget] = useState<ApiWorkflow | null>(null);

  const hasWorkflows = Boolean(workflows && workflows.length > 0);
  const activeCount = (workflows ?? []).filter((w) => w.status === 'PUBLISHED' && w.is_enabled).length;
  const pausedCount = (workflows ?? []).filter((w) => w.status === 'PUBLISHED' && !w.is_enabled).length;
  const sentAllTime = (workflows ?? []).reduce((sum, w) => sum + w.trigger_count, 0);

  async function useTemplate(template: AutomationTemplate) {
    const created = await createWorkflow.mutateAsync(templateToWorkflowBody(template));
    navigate(`/automations/${created.id}`);
  }

  async function duplicate(workflow: ApiWorkflow) {
    const created = await createWorkflow.mutateAsync({
      name: `${workflow.name} (copy)`,
      trigger_type: workflow.trigger_type,
      trigger_config: workflow.trigger_config,
      // send_window deliberately NOT copied: duplicating one of the few legacy
      // BUSINESS_HOURS rows would otherwise mint a brand-new automation with a
      // deferral rule no screen can show. Copies start ANYTIME like everything
      // else the builder creates.
      steps: workflow.steps.map((s) => ({ step_type: s.step_type, config: s.config })),
    });
    navigate(`/automations/${created.id}`);
  }

  return (
    <div className="space-y-6">
      {/* Hero header */}
      <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div className="flex items-start gap-3">
          <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-ic bg-primary-subtle">
            <Zap className="h-6 w-6 text-primary" aria-hidden />
          </div>
          <div>
            {/* tracking-tight dropped: no Heading prop carries letter-spacing, and the
                className residual must stay layout-only for the layering guard. */}
            <Heading level={1} scale="2xl" weight="bold">Automations</Heading>
            <p className="mt-0.5 max-w-xl text-sm text-text-secondary">
              Put reminders, follow-ups and team alerts on autopilot — start from a recipe below.
            </p>
          </div>
        </div>
        <Button onClick={() => navigate('/automations/new')}>
          <Plus className="mr-1.5 h-4 w-4" aria-hidden />
          New automation
        </Button>
      </div>

      {/* Stat band */}
      {workflowsLoading ? (
        <div className="grid grid-cols-3 gap-3">
          <Skeleton className="h-[76px] w-full" />
          <Skeleton className="h-[76px] w-full" />
          <Skeleton className="h-[76px] w-full" />
        </div>
      ) : (
        hasWorkflows && (
          <div className="grid grid-cols-3 gap-3">
            <KpiTile icon={CheckCircle2} tone="success" label="Active" value={fmt(activeCount)} />
            <KpiTile icon={PauseCircle} tone="neutral" label="Paused" value={fmt(pausedCount)} />
            <KpiTile icon={Send} tone="primary" label="Runs all-time" value={fmt(sentAllTime)} />
          </div>
        )
      )}

      {/* My automations */}
      {workflowsError ? (
        <ErrorBanner message="Could not load your automations." onRetry={refetchWorkflows} />
      ) : workflowsLoading ? (
        <div className="space-y-3">
          <Skeleton className="h-[92px] w-full" />
          <Skeleton className="h-[92px] w-full" />
        </div>
      ) : (
        hasWorkflows && (
          <div className="space-y-3">
            {/* tracking-tight dropped: no Heading prop carries letter-spacing (also
                dropped at the other two <h2> sites and the <h3> below in this file). */}
            <Heading level={2} scale="sm" weight="semibold">My automations</Heading>
            <div className="space-y-3">
              {(workflows ?? []).map((workflow) => (
                <WorkflowRow
                  key={workflow.id}
                  workflow={workflow}
                  catalog={catalog}
                  onOpen={() => navigate(`/automations/${workflow.id}`)}
                  onDuplicate={() => duplicate(workflow)}
                  onDeleteRequest={() => setDeleteTarget(workflow)}
                />
              ))}
            </div>
          </div>
        )
      )}

      {/* Templates gallery — the front door */}
      <div className="space-y-8">
        {!hasWorkflows && !workflowsLoading && !workflowsError && (
          <div className="flex items-center justify-between">
            <Heading level={2} scale="sm" weight="semibold">Start from a recipe</Heading>
            <Button variant="outline" size="sm" onClick={() => navigate('/automations/new')}>
              Start from scratch
            </Button>
          </div>
        )}

        {catalogError ? (
          <ErrorBanner message="Could not load the templates gallery." onRetry={refetchCatalog} />
        ) : catalogLoading ? (
          <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
            <Skeleton className="h-[180px] w-full" />
            <Skeleton className="h-[180px] w-full" />
            <Skeleton className="h-[180px] w-full" />
          </div>
        ) : (
          CATEGORY_ORDER.map((category) => {
            // Texting templates are hidden until this org can actually text — a
            // locked step must not be able to enter a workflow via any door.
            const smsAvailable = Boolean(catalog?.capabilities?.sms_available);
            const group = (catalog?.templates ?? []).filter(
              (t) => t.category === category && !(!smsAvailable && t.action_type === 'SEND_SMS'),
            );
            if (group.length === 0) return null;
            const meta = CATEGORY_META[category];
            const Icon = meta.icon;
            return (
              <section key={category}>
                <div className="mb-3 flex items-center gap-2.5">
                  <div className={`flex h-8 w-8 items-center justify-center rounded-ic ${meta.tileBg}`}>
                    <Icon className={`h-4 w-4 ${meta.tileText}`} aria-hidden />
                  </div>
                  <div>
                    <Heading level={2} scale="sm" weight="semibold">{meta.title}</Heading>
                    <p className="text-xs text-text-secondary">{meta.blurb}</p>
                  </div>
                </div>
                <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
                  {group.map((template) => (
                    <TemplateCard
                      key={template.key}
                      template={template}
                      catalog={catalog}
                      onUse={() => useTemplate(template)}
                      busy={createWorkflow.isPending}
                    />
                  ))}
                </div>
              </section>
            );
          })
        )}
      </div>

      {/* Delete confirmation */}
      <Dialog open={Boolean(deleteTarget)} onOpenChange={(open) => !open && setDeleteTarget(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete "{deleteTarget?.name}"?</DialogTitle>
            <DialogDescription>Its activity history is removed too. This can't be undone.</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeleteTarget(null)}>
              Cancel
            </Button>
            <DeleteButton workflow={deleteTarget} onDone={() => setDeleteTarget(null)} />
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function DeleteButton({ workflow, onDone }: { workflow: ApiWorkflow | null; onDone: () => void }) {
  const remove = useDeleteWorkflow();
  return (
    <Button
      variant="solid" tone="danger"
      disabled={!workflow || remove.isPending}
      onClick={() => {
        if (!workflow) return;
        remove.mutate(workflow.id, { onSuccess: onDone });
      }}
    >
      <Trash2 className="mr-1.5 h-4 w-4" aria-hidden />
      Delete
    </Button>
  );
}

function ErrorBanner({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div className="flex items-center justify-between rounded-card border border-danger/20 bg-danger/5 px-4 py-3 text-sm text-danger">
      <span>{message}</span>
      <Button variant="outline" size="sm" onClick={onRetry}>
        Retry
      </Button>
    </div>
  );
}

function WorkflowRow({
  workflow,
  catalog,
  onOpen,
  onDuplicate,
  onDeleteRequest,
}: {
  workflow: ApiWorkflow;
  catalog: WorkflowCatalog | undefined;
  onOpen: () => void;
  onDuplicate: () => void;
  onDeleteRequest: () => void;
}) {
  const toggle = useToggleWorkflow();
  const isDraft = workflow.status !== 'PUBLISHED';
  const sentence = describeWorkflow(workflow.trigger_type, workflow.trigger_config, workflow.steps, catalog);
  const runsLabel = `Ran ${fmt(workflow.trigger_count)} ${workflow.trigger_count === 1 ? 'time' : 'times'}`;
  const lastRunLabel = workflow.last_triggered_at
    ? ` · last ${formatDistanceToNow(new Date(workflow.last_triggered_at), { addSuffix: true })}`
    : '';

  const switchEl = (
    <Switch
      checked={workflow.is_enabled}
      disabled={isDraft || toggle.isPending}
      onCheckedChange={(checked) => toggle.mutate({ id: workflow.id, is_enabled: checked })}
      aria-label={workflow.is_enabled ? `Pause ${workflow.name}` : `Turn on ${workflow.name}`}
    />
  );

  return (
    <div className="group flex items-center gap-4 rounded-card border border-border bg-surface-light p-4 shadow-card transition-all hover:border-primary/30 hover:shadow-hover">
      {/* full-row card click target, not a button shape - left raw */}
      <button
        type="button"
        onClick={onOpen}
        className="flex min-w-0 flex-1 items-center gap-4 rounded text-left"
      >
        {/* No aria-label here on purpose — the sentence/name/stats text below IS
            the button's accessible name; an aria-label would silently swallow it
            from screen readers. */}
        <FlowTrail steps={workflow.steps} />
        <div className="min-w-0 flex-1 space-y-1">
          <p className="truncate text-sm font-semibold tracking-tight text-text-primary">{sentence}</p>
          <p className="truncate text-xs text-text-secondary">{workflow.name}</p>
          <p className="text-xs text-text-secondary">
            {runsLabel}
            {lastRunLabel}
          </p>
        </div>
      </button>

      <div className="flex shrink-0 items-center gap-2">
        <WorkflowStatusPill status={workflow.status} is_enabled={workflow.is_enabled} />
        {isDraft ? (
          <TooltipProvider>
            <Tooltip>
              <TooltipTrigger asChild>
                <span tabIndex={0} className="inline-flex">
                  {switchEl}
                </span>
              </TooltipTrigger>
              <TooltipContent>Publish first</TooltipContent>
            </Tooltip>
          </TooltipProvider>
        ) : (
          switchEl
        )}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="icon" className="h-11 w-11" aria-label={`Actions for ${workflow.name}`}>
              <MoreHorizontal className="h-4 w-4" aria-hidden />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem onClick={onOpen}>
              <ExternalLink className="mr-2 h-4 w-4" aria-hidden /> Open
            </DropdownMenuItem>
            <DropdownMenuItem onClick={onDuplicate}>
              <Copy className="mr-2 h-4 w-4" aria-hidden /> Duplicate
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem variant="destructive" onClick={onDeleteRequest}>
              <Trash2 className="mr-2 h-4 w-4" aria-hidden /> Delete
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </div>
  );
}

function TemplateCard({
  template,
  catalog,
  onUse,
  busy,
}: {
  template: AutomationTemplate;
  catalog: WorkflowCatalog | undefined;
  onUse: () => void;
  busy: boolean;
}) {
  const stepType = template.action_type === 'SEND_SMS' ? 'SEND_TEXT' : template.action_type;
  const sentence = describeWorkflow(
    template.trigger_type,
    template.trigger_config ?? null,
    [{ step_type: stepType, config: template.action_config }],
    catalog,
  );

  return (
    <div className="group flex flex-col rounded-card border border-border bg-surface-light p-4 shadow-card transition-all hover:border-primary/30 hover:shadow-hover">
      <FlowTrail steps={[{ step_type: stepType }]} />
      {/* This raw h3 carried no explicit font size class, inheriting the page's ~16px
          default (Tailwind preflight resets heading font-size to `inherit`) -
          scale="base" is the closest Heading key to that rendered size.
          tracking-tight dropped: no Heading prop carries letter-spacing. */}
      <Heading level={3} scale="base" weight="semibold" className="mt-3">{template.name}</Heading>
      <p className="mt-1 flex-1 text-[13px] text-text-secondary">{template.description}</p>
      <p className="mt-2 text-xs text-text-secondary">{sentence}</p>
      <Button variant="solid" tone="business" size="sm" className="mt-3 self-start" onClick={onUse} disabled={busy}>
        Use this
      </Button>
    </div>
  );
}
