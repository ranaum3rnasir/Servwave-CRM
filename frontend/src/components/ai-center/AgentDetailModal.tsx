import { useState, useMemo, useEffect } from 'react';
import {
  Play,
  Check,
  Bell,
  Mail,
  MessageSquare,
  Clock,
  Users,
  Search,
  ChevronDown,
  AlertTriangle,
  CheckCircle2,
  Layers,
  Save,
  Plus,
  Minus,
  Square,
} from 'lucide-react';
import { useQuery } from '@tanstack/react-query';
import { VisuallyHidden } from '@radix-ui/react-visually-hidden';
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { Button } from '@/components/ui/button';
import { Heading } from '@/components/ui/heading';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { useToast } from '@/components/ui/use-toast';
import { cn } from '@/lib/utils';
import api from '@/lib/axios';
import { customerDisplayName } from '@/lib/customer-name';
import type { AIAgent } from '@/lib/ai-center/agents';
import { comingSoonPillCls } from './comingSoonPill';
import { TranscriberModal } from '@/components/transcriber/TranscriberModal';
import {
  useSpiderWatcherStore,
  type TimeUnit,
  type WatcherCustomer,
  type WatcherLead,
  type SpiderNotificationsConfig,
  type LeadStageConfig,
  DEFAULT_WATCHER_CUSTOMERS,
  isLeadOverdue,
  resolveLeadStageAndElapsedTime,
  formatCurrentStageName,
  buildWatcherCustomersFromLive,
} from '@/stores/spiderWatcherStore';

interface AgentDetailModalProps {
  agent: AIAgent | null;
  onOpenChange: (open: boolean) => void;
  onBook: (agent: AIAgent) => void;
}

const TIME_UNITS: TimeUnit[] = ['Second', 'Minute', 'Hour', 'Day'];

interface SpiderWatcherConfigProps {
  notifications: SpiderNotificationsConfig;
  setNotifications: React.Dispatch<React.SetStateAction<SpiderNotificationsConfig>>;
  leadStages: LeadStageConfig[];
  updateLeadStage: (id: string, updates: Partial<LeadStageConfig>) => void;
  selectedCustomerIds: string[];
  selectedLeadIds: string[];
  toggleCustomerSelection: (customerId: string, leadIdsForCustomer: string[]) => void;
  toggleLeadSelection: (
    leadId: string,
    customerId: string,
    allLeadIdsForCustomer: string[]
  ) => void;
  selectAllCustomers: () => void;
  deselectAllCustomers: () => void;
  storeCustomers: WatcherCustomer[];
}

/** Dedicated UI for Spider (AI Lead Manager) Watcher configuration */
function SpiderWatcherConfig({
  notifications,
  setNotifications,
  leadStages,
  updateLeadStage,
  selectedCustomerIds,
  selectedLeadIds,
  toggleCustomerSelection,
  toggleLeadSelection,
  selectAllCustomers,
  deselectAllCustomers,
  storeCustomers,
}: SpiderWatcherConfigProps) {
  const [search, setSearch] = useState('');
  const [expandedCustomerId, setExpandedCustomerId] = useState<string | null>(null);

  // Use live store customers
  const customersList: WatcherCustomer[] = useMemo(() => {
    return (storeCustomers || []).map((c) => ({
      ...c,
      leads: (c.leads || []).map((l) => {
        const m = resolveLeadStageAndElapsedTime(l);
        return {
          ...l,
          stageId: m.stageId,
          stageLabel: m.stageLabel,
          elapsedValue: m.elapsedValue,
          elapsedUnit: m.elapsedUnit,
          elapsedSeconds: m.elapsedSeconds,
        };
      }),
    }));
  }, [storeCustomers]);

  // Filter customers and their leads by search string
  const filteredCustomers = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return customersList;

    return customersList.filter((c) => {
      const matchCustomer =
        c.name.toLowerCase().includes(q) ||
        (c.company && c.company.toLowerCase().includes(q)) ||
        (c.email && c.email.toLowerCase().includes(q));

      const matchLeads = c.leads.some(
        (l) =>
          l.leadNumber.toLowerCase().includes(q) ||
          l.serviceRequest.toLowerCase().includes(q) ||
          l.stageLabel.toLowerCase().includes(q)
      );

      return matchCustomer || matchLeads;
    });
  }, [customersList, search]);

  // Compute total active triggered leads across all monitored customers
  const totalTriggeredCount = useMemo(() => {
    let count = 0;
    for (const customer of customersList) {
      for (const lead of customer.leads) {
        if (selectedLeadIds.includes(lead.id) && isLeadOverdue(lead, leadStages)) {
          count++;
        }
      }
    }
    return count;
  }, [customersList, selectedLeadIds, leadStages]);

  const allSelected =
    customersList.length > 0 &&
    customersList.every((c) => selectedCustomerIds.includes(c.id)) &&
    customersList.every((c) =>
      c.leads.every((l) => selectedLeadIds.includes(l.id))
    );

  return (
    <div className="space-y-4">
      {/* Top Section — Notifications (Left: 4 cols) & Distance / Lead Stages (Right: 8 cols) */}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-12">
        {/* Left Section — Notifications */}
        <div className="flex flex-col rounded-card border border-border bg-surface-light p-4 shadow-card lg:col-span-4">
          <div className="mb-3 border-b border-border/60 pb-2">
            <Heading level={3} scale="sm" weight="bold" className="flex items-center gap-2">
              <Bell className="h-4 w-4 text-ai-600 shrink-0" />
              Notifications
            </Heading>
          </div>
          <div className="space-y-2.5 flex-1">
            <div
              className="flex items-center gap-3 rounded-lg p-2 transition-colors hover:bg-background-light cursor-pointer"
              onClick={() =>
                setNotifications((prev) => ({ ...prev, email: !prev.email }))
              }
            >
              <Checkbox
                checked={notifications.email}
                onCheckedChange={(checked) =>
                  setNotifications((prev) => ({ ...prev, email: !!checked }))
                }
              />
              <div className="flex items-center gap-2 text-xs font-semibold text-text-primary">
                <Mail className="h-3.5 w-3.5 text-text-soft" />
                <span>Email</span>
              </div>
            </div>

            <div
              className="flex items-center gap-3 rounded-lg p-2 transition-colors hover:bg-background-light cursor-pointer"
              onClick={() =>
                setNotifications((prev) => ({ ...prev, sms: !prev.sms }))
              }
            >
              <Checkbox
                checked={notifications.sms}
                onCheckedChange={(checked) =>
                  setNotifications((prev) => ({ ...prev, sms: !!checked }))
                }
              />
              <div className="flex items-center gap-2 text-xs font-semibold text-text-primary">
                <MessageSquare className="h-3.5 w-3.5 text-text-soft" />
                <span>SMS</span>
              </div>
            </div>

            <div
              className="flex items-center gap-3 rounded-lg p-2 transition-colors hover:bg-background-light cursor-pointer"
              onClick={() =>
                setNotifications((prev) => ({ ...prev, inApp: !prev.inApp }))
              }
            >
              <Checkbox
                checked={notifications.inApp}
                onCheckedChange={(checked) =>
                  setNotifications((prev) => ({ ...prev, inApp: !!checked }))
                }
              />
              <div className="flex items-center gap-2 text-xs font-semibold text-text-primary">
                <Bell className="h-3.5 w-3.5 text-ai-600" />
                <span>In-app Message</span>
              </div>
            </div>

            <div
              className="flex items-center gap-3 rounded-lg p-2 transition-colors hover:bg-background-light cursor-pointer"
              onClick={() =>
                setNotifications((prev) => ({ ...prev, redFrame: !prev.redFrame }))
              }
            >
              <Checkbox
                checked={notifications.redFrame}
                onCheckedChange={(checked) =>
                  setNotifications((prev) => ({ ...prev, redFrame: !!checked }))
                }
              />
              <div className="flex items-center gap-2 text-xs font-semibold text-text-primary">
                <Square className="h-3.5 w-3.5 text-[#800000]" />
                <span>Red Frame</span>
              </div>
            </div>
          </div>
        </div>

        {/* Right Section — Distance (Lead Stages & Parallel Time Periods with Expanded Width) */}
        <div className="flex flex-col rounded-card border border-border bg-surface-light p-4 shadow-card lg:col-span-8">
          <div className="mb-3 border-b border-border/60 pb-2 flex items-center justify-between">
            <Heading level={3} scale="sm" weight="bold" className="flex items-center gap-2">
              <Clock className="h-4 w-4 text-ai-600 shrink-0" />
              Distance
            </Heading>
            <span className="text-[10px] font-semibold text-ai-600 bg-ai-50 border border-ai-200 px-2 py-0.5 rounded-full uppercase tracking-wider">
              Lead Stages
            </span>
          </div>

          {/* Lead Stages rows — spacious and fully visible without cutting off long names */}
          <div className="flex flex-col justify-between flex-1 space-y-2">
            <div className="space-y-2">
              {leadStages.map((stage) => (
                <div
                  key={stage.id}
                  className="flex flex-col sm:flex-row sm:items-center justify-between gap-2.5 p-2 rounded-lg border border-border/60 bg-background-light/40 hover:bg-background-light transition-colors"
                >
                  {/* Stage Label — clearly visible with full stage names without truncation */}
                  <div className="min-w-0 flex-1 pr-2">
                    <span
                      className="block text-xs font-semibold text-text-primary whitespace-normal leading-relaxed"
                    >
                      {stage.label}
                    </span>
                  </div>

                  {/* Parallel Time Period Stepper & Unit Inputs */}
                  <div className="flex items-center gap-1.5 shrink-0">
                    {/* Decrement Button */}
                    <Button
                      type="button"
                      variant="outline"
                      size="icon"
                      onClick={() => {
                        const currentVal =
                          stage.duration && stage.duration >= 1 ? stage.duration : 0;
                        const nextVal = currentVal - 1;
                        updateLeadStage(stage.id, {
                          duration: nextVal >= 1 ? nextVal : undefined,
                        });
                      }}
                      disabled={!stage.duration || stage.duration < 1}
                      className="h-7 w-7 text-text-secondary disabled:opacity-40"
                      aria-label={`Decrement time period for ${stage.label}`}
                    >
                      <Minus className="h-3 w-3" />
                    </Button>

                    {/* Numeric Input */}
                    <input
                      type="number"
                      min="1"
                      value={stage.duration && stage.duration >= 1 ? stage.duration : ''}
                      onChange={(e) => {
                        const raw = e.target.value.trim();
                        if (raw === '') {
                          updateLeadStage(stage.id, { duration: undefined });
                          return;
                        }
                        const val = parseInt(raw, 10);
                        if (!isNaN(val) && val >= 1) {
                          updateLeadStage(stage.id, { duration: val });
                        } else {
                          updateLeadStage(stage.id, { duration: undefined });
                        }
                      }}
                      className="w-12 h-7 rounded-md border border-border bg-surface-light px-1 text-xs font-bold text-text-primary text-center outline-none focus-visible:ring-2 focus-visible:ring-ai-500"
                      placeholder=""
                      aria-label={`Time period for ${stage.label}`}
                    />

                    {/* Increment Button */}
                    <Button
                      type="button"
                      variant="outline"
                      size="icon"
                      onClick={() => {
                        const currentVal =
                          stage.duration && stage.duration >= 1 ? stage.duration : 0;
                        updateLeadStage(stage.id, { duration: currentVal + 1 });
                      }}
                      className="h-7 w-7 text-text-secondary"
                      aria-label={`Increment time period for ${stage.label}`}
                    >
                      <Plus className="h-3 w-3" />
                    </Button>

                    {/* Unit Select */}
                    <Select
                      value={stage.unit}
                      onValueChange={(val) =>
                        updateLeadStage(stage.id, { unit: val as TimeUnit })
                      }
                    >
                      <SelectTrigger
                        className="w-24 h-7 text-xs font-semibold px-2 py-0.5"
                        aria-label={`Time unit for ${stage.label}`}
                      >
                        <SelectValue placeholder={stage.unit} />
                      </SelectTrigger>
                      <SelectContent>
                        {TIME_UNITS.map((unit) => (
                          <SelectItem key={unit} value={unit} className="text-xs">
                            {unit}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                </div>
              ))}
            </div>

            <div className="pt-2 border-t border-border/40">
              <p className="text-[11px] text-text-soft leading-tight">
                Spider watches for leads remaining in each stage longer than the configured period.
              </p>
            </div>
          </div>
        </div>
      </div>

      {/* Bottom Section — Contacts for Watchers */}
      <div className="rounded-card border border-border bg-surface-light p-4 shadow-card">
        <div className="mb-3 border-b border-border/60 pb-2 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2">
          <div>
            <Heading level={3} scale="sm" weight="bold" className="flex items-center gap-2">
              <Users className="h-4 w-4 text-ai-600 shrink-0" />
              Contacts for Watchers
            </Heading>
            <p className="text-[11px] text-text-soft mt-0.5">
              Customers and leads monitored for stage thresholds ({filteredCustomers.length} customers,{' '}
              <span className={cn(totalTriggeredCount > 0 ? 'text-danger-strong font-semibold' : '')}>
                {totalTriggeredCount} active trigger{totalTriggeredCount === 1 ? '' : 's'}
              </span>
              )
            </p>
          </div>

          {/* Quick select / deselect buttons */}
          <div className="flex items-center gap-2 shrink-0">
            <span
              role="button"
              tabIndex={0}
              onClick={allSelected ? deselectAllCustomers : selectAllCustomers}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  allSelected ? deselectAllCustomers() : selectAllCustomers();
                }
              }}
              className="cursor-pointer text-[11px] font-semibold text-ai-600 hover:text-ai-strong transition-colors"
            >
              {allSelected ? 'Deselect all' : 'Select all'}
            </span>
          </div>
        </div>

        {/* Search bar */}
        <div className="relative mb-3">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-text-soft" />
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search customers or leads by name, company, lead # or service..."
            className="w-full rounded-md border border-border bg-surface-light py-1.5 pl-9 pr-3 text-xs text-text-primary outline-none placeholder:text-text-soft focus-visible:ring-2 focus-visible:ring-ai-500"
          />
        </div>

        {/* Customers & Multi-Lead Dropdown List */}
        <div className="max-h-72 overflow-y-auto space-y-2 pr-1">
          {filteredCustomers.length === 0 ? (
            <div className="py-6 text-center text-xs text-text-soft">
              No contacts or leads found matching your search.
            </div>
          ) : (
            filteredCustomers.map((customer) => {
              const allCustomerLeadIds = customer.leads.map((l) => l.id);
              const allLeadsSelected =
                customer.leads.length > 0 &&
                customer.leads.every((l) => selectedLeadIds.includes(l.id));
              const someLeadsSelected =
                customer.leads.length > 0 &&
                customer.leads.some((l) => selectedLeadIds.includes(l.id)) &&
                !allLeadsSelected;

              const customerCheckedState: boolean | 'indeterminate' = someLeadsSelected
                ? 'indeterminate'
                : selectedCustomerIds.includes(customer.id);
              const isDropdownOpen = expandedCustomerId === customer.id;

              const triggeredLeadsForCustomer = customer.leads.filter(
                (l) => selectedLeadIds.includes(l.id) && isLeadOverdue(l, leadStages)
              );

              return (
                <div
                  key={customer.id}
                  className="rounded-lg border border-border/70 bg-surface-light transition-all shadow-xs"
                >
                  {/* Customer Row Header */}
                  <div
                    className={cn(
                      'flex items-center gap-3 p-2.5 transition-colors cursor-pointer rounded-lg hover:bg-background-light',
                      isDropdownOpen && 'bg-background-light/70 rounded-b-none border-b border-border/40'
                    )}
                    onClick={() => {
                      setExpandedCustomerId(
                        expandedCustomerId === customer.id ? null : customer.id
                      );
                    }}
                  >
                    {/* Customer Checkbox for Watcher selection */}
                    <div
                      className="shrink-0"
                      onClick={(e) => e.stopPropagation()}
                    >
                      <Checkbox
                        checked={customerCheckedState}
                        onCheckedChange={() =>
                          toggleCustomerSelection(customer.id, allCustomerLeadIds)
                        }
                        aria-label={`Select customer ${customer.name} for watcher`}
                      />
                    </div>

                    <Avatar className="h-7 w-7 shrink-0">
                      <AvatarFallback tone="subtle" className="text-[11px] font-bold">
                        {customer.name[0]}
                      </AvatarFallback>
                    </Avatar>

                    {/* Customer info */}
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <p className="truncate text-xs font-bold text-text-primary">
                          {customer.name}
                        </p>
                        {customer.company && customer.company !== customer.name && (
                          <span className="hidden sm:inline-block truncate text-[11px] text-text-soft">
                            · {customer.company}
                          </span>
                        )}
                      </div>
                      {customer.email && (
                        <p className="truncate text-[11px] font-mono text-text-soft">
                          {customer.email}
                        </p>
                      )}
                    </div>

                    {/* Customer stats & dropdown trigger */}
                    <div className="flex items-center gap-2 shrink-0">
                      {/* Active alert indicator if any lead is triggered */}
                      {triggeredLeadsForCustomer.length > 0 && (
                        <span className="flex items-center gap-1 rounded-full bg-danger-surface border border-danger-border px-2 py-0.5 text-[10px] font-bold text-danger-strong animate-pulse">
                          <AlertTriangle className="h-3 w-3" />
                          {triggeredLeadsForCustomer.length} Triggered
                        </span>
                      )}

                      {/* Lead count badge */}
                      <span className="flex items-center gap-1 rounded-full bg-ai-50 border border-ai-200 px-2 py-0.5 text-[10px] font-semibold text-ai-strong">
                        <Layers className="h-3 w-3" />
                        {customer.leads.length} lead{customer.leads.length === 1 ? '' : 's'}
                      </span>

                      {/* Expand / Dropdown toggle button (Click-only) */}
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        aria-label={`Toggle leads for ${customer.name}`}
                        aria-expanded={isDropdownOpen}
                        onClick={(e) => {
                          e.stopPropagation();
                          setExpandedCustomerId(
                            expandedCustomerId === customer.id ? null : customer.id
                          );
                        }}
                        className="h-6 w-6 p-0 text-text-soft hover:text-text-primary"
                      >
                        <ChevronDown
                          className={cn(
                            'h-4 w-4 text-text-soft transition-transform duration-200',
                            isDropdownOpen && 'rotate-180 text-ai-600'
                          )}
                        />
                      </Button>
                    </div>
                  </div>

                  {/* Dropdown displaying all leads belonging to this customer */}
                  {isDropdownOpen && (
                    <div className="p-2.5 bg-background-light/40 space-y-2 border-t border-border/40">
                      <div className="flex items-center justify-between px-1">
                        <span className="text-[11px] font-bold uppercase tracking-wider text-text-secondary">
                          Leads for {customer.name}
                        </span>
                        <span className="text-[10px] text-text-soft">
                          Select individual leads for Spider alerts
                        </span>
                      </div>

                      {customer.leads.length === 0 ? (
                        <p className="text-xs text-text-soft py-2 px-1">
                          No active leads found for this customer.
                        </p>
                      ) : (
                        <div className="space-y-1.5">
                          {customer.leads.map((lead) => {
                            const isLeadChecked = selectedLeadIds.includes(lead.id);
                            const stageConfig = leadStages.find(
                              (s) => s.id === lead.stageId || s.label === lead.stageLabel
                            );
                            const hasThreshold =
                              stageConfig?.duration !== undefined &&
                              stageConfig?.duration !== null &&
                              !isNaN(stageConfig?.duration);
                            const overdue = hasThreshold && isLeadOverdue(lead, leadStages);

                            return (
                              <div
                                key={lead.id}
                                className={cn(
                                  'flex flex-col sm:flex-row sm:items-center justify-between gap-2 rounded-md p-2 border transition-colors',
                                  isLeadChecked
                                    ? overdue
                                      ? 'border-danger-border bg-danger-surface/50 hover:bg-danger-surface/70'
                                      : !hasThreshold
                                      ? 'border-border/60 bg-background-light/40 hover:bg-background-light'
                                      : 'border-ai-200 bg-ai-50/40 hover:bg-ai-50/60'
                                    : 'border-border/60 bg-surface-light/60 opacity-65 hover:opacity-100'
                                )}
                              >
                                {/* Left: Lead Checkbox, Number & Service description */}
                                <div className="flex items-center gap-2.5 min-w-0">
                                  <Checkbox
                                    checked={isLeadChecked}
                                    onCheckedChange={() =>
                                      toggleLeadSelection(lead.id, customer.id, allCustomerLeadIds)
                                    }
                                    aria-label={`Select lead ${lead.leadNumber} for notifications`}
                                  />
                                  <div className="min-w-0">
                                    <div className="flex items-center gap-2">
                                      <span className="font-mono text-xs font-bold text-text-primary">
                                        {lead.leadNumber}
                                      </span>
                                      <span className="rounded bg-ai-50 border border-ai-200 px-1.5 py-0.5 text-[10px] font-bold text-ai-strong">
                                        {formatCurrentStageName(lead.stageLabel || lead.stageId)}
                                      </span>
                                    </div>
                                    <p className="truncate text-[11px] text-text-secondary font-medium">
                                      {lead.serviceRequest}
                                    </p>
                                  </div>
                                </div>

                                {/* Right: Stage Duration & Notification Trigger Status */}
                                <div className="flex items-center gap-2 shrink-0 pl-6 sm:pl-0">
                                  <span className="text-[10px] font-medium text-text-soft">
                                    {lead.elapsedValue} {lead.elapsedUnit}
                                    {lead.elapsedValue > 1 ? 's' : ''} in stage
                                  </span>

                                  {isLeadChecked && !hasThreshold ? (
                                    <span className="rounded-full bg-surface-light border border-border px-2 py-0.5 text-[10px] font-medium text-text-soft">
                                      none threshold set
                                    </span>
                                  ) : isLeadChecked && overdue ? (
                                    <span className="flex items-center gap-1 rounded-full bg-danger text-on-fill px-2 py-0.5 text-[10px] font-bold shadow-xs">
                                      <AlertTriangle className="h-3 w-3" />
                                      Alert Active ({lead.elapsedValue} {lead.elapsedUnit}s ≥{' '}
                                      {stageConfig?.duration} {stageConfig?.unit || 'Second'}s)
                                    </span>
                                  ) : isLeadChecked ? (
                                    <span className="flex items-center gap-1 rounded-full bg-ai-50 text-ai-strong border border-ai-200 px-2 py-0.5 text-[10px] font-semibold">
                                      <CheckCircle2 className="h-3 w-3 text-ai-600" />
                                      Within limit
                                    </span>
                                  ) : (
                                    <span className="rounded-full bg-surface-light border border-border px-2 py-0.5 text-[10px] font-medium text-text-soft">
                                      Not Monitored
                                    </span>
                                  )}
                                </div>
                              </div>
                            );
                          })}
                        </div>
                      )}
                    </div>
                  )}
                </div>
              );
            })
          )}
        </div>
      </div>
    </div>
  );
}

/** Modal-on-modal: the agent's tagline, feature video, and 7-bullet story (or custom watcher UI for Spider). */
export function AgentDetailModal({ agent, onOpenChange, onBook }: AgentDetailModalProps) {
  const [transcriberOpen, setTranscriberOpen] = useState(false);
  const isSpider = agent?.id === 'spider' || agent?.name.toLowerCase() === 'spider';
  const { toast } = useToast();
  const [isSaved, setIsSaved] = useState(false);

  // Read store state for initial draft
  const storeNotifications = useSpiderWatcherStore((s) => s.notifications);
  const storeLeadStages = useSpiderWatcherStore((s) => s.leadStages);
  const storeCustomers = useSpiderWatcherStore((s) => s.customers);
  const storeSelectedCustomerIds = useSpiderWatcherStore((s) => s.selectedCustomerIds);
  const storeSelectedLeadIds = useSpiderWatcherStore((s) => s.selectedLeadIds);
  const setStoreCustomers = useSpiderWatcherStore((s) => s.setCustomers);

  // Local draft state for Spider Watcher settings
  const [draftNotifications, setDraftNotifications] = useState<SpiderNotificationsConfig>(storeNotifications);
  const [draftLeadStages, setDraftLeadStages] = useState<LeadStageConfig[]>(storeLeadStages);
  const [draftSelectedCustomerIds, setDraftSelectedCustomerIds] = useState<string[]>(storeSelectedCustomerIds);
  const [draftSelectedLeadIds, setDraftSelectedLeadIds] = useState<string[]>(storeSelectedLeadIds);
  const [hasDraftModifiedSelection, setHasDraftModifiedSelection] = useState<boolean>(false);

  // Fetch actual real leads from the Leads API
  const { data: apiLeads } = useQuery({
    queryKey: ['spider-watcher-leads-real'],
    queryFn: async () => {
      try {
        const res = await api.get('/api/leads', { params: { limit: 100 } });
        return res.data?.leads || [];
      } catch {
        return [];
      }
    },
    staleTime: 30_000,
  });

  // Fetch actual customers from API
  const { data: apiCustomers } = useQuery({
    queryKey: ['spider-watcher-customers-real'],
    queryFn: async () => {
      try {
        const res = await api.get('/api/customers', { params: { limit: 100 } });
        return res.data?.customers || [];
      } catch {
        return [];
      }
    },
    staleTime: 30_000,
  });

  // Sync store when real API leads arrive
  useEffect(() => {
    if (
      (Array.isArray(apiLeads) && apiLeads.length > 0) ||
      (Array.isArray(apiCustomers) && apiCustomers.length > 0)
    ) {
      const live = buildWatcherCustomersFromLive(apiLeads || [], apiCustomers || []);
      setStoreCustomers(live);
    }
  }, [apiLeads, apiCustomers, setStoreCustomers]);

  // Reset draft state from store whenever modal opens / agent changes
  useEffect(() => {
    if (agent && isSpider) {
      const storeState = useSpiderWatcherStore.getState();
      setDraftNotifications({ ...storeState.notifications });
      setDraftLeadStages(storeState.leadStages.map((s) => ({ ...s })));
      setDraftSelectedCustomerIds([...storeState.selectedCustomerIds]);
      setDraftSelectedLeadIds([...storeState.selectedLeadIds]);
      setHasDraftModifiedSelection(storeState.hasUserModifiedSelection);
      setIsSaved(false);
    }
  }, [agent, isSpider]);

  // If customers exist and user has not modified selection, ensure all are selected in draft
  useEffect(() => {
    if (
      isSpider &&
      storeCustomers.length > 0 &&
      draftSelectedCustomerIds.length === 0 &&
      !hasDraftModifiedSelection
    ) {
      setDraftSelectedCustomerIds(storeCustomers.map((c) => c.id));
      setDraftSelectedLeadIds(storeCustomers.flatMap((c) => c.leads.map((l) => l.id)));
    }
  }, [isSpider, storeCustomers, draftSelectedCustomerIds.length, hasDraftModifiedSelection]);

  const updateDraftLeadStage = (id: string, updates: Partial<LeadStageConfig>) => {
    setDraftLeadStages((prev) =>
      prev.map((stage) => (stage.id === id ? { ...stage, ...updates } : stage))
    );
  };

  const toggleCustomerSelection = (customerId: string, leadIdsForCustomer: string[]) => {
    setHasDraftModifiedSelection(true);
    const allLeadsSelected =
      leadIdsForCustomer.length > 0 &&
      leadIdsForCustomer.every((id) => draftSelectedLeadIds.includes(id));
    const isSelected =
      draftSelectedCustomerIds.includes(customerId) &&
      (leadIdsForCustomer.length === 0 || allLeadsSelected);

    let newCustomerIds: string[];
    let newLeadIds: string[];

    if (isSelected) {
      newCustomerIds = draftSelectedCustomerIds.filter((id) => id !== customerId);
      newLeadIds = draftSelectedLeadIds.filter((id) => !leadIdsForCustomer.includes(id));
    } else {
      newCustomerIds = Array.from(new Set([...draftSelectedCustomerIds, customerId]));
      newLeadIds = Array.from(new Set([...draftSelectedLeadIds, ...leadIdsForCustomer]));
    }

    setDraftSelectedCustomerIds(newCustomerIds);
    setDraftSelectedLeadIds(newLeadIds);
  };

  const toggleLeadSelection = (
    leadId: string,
    customerId: string,
    allLeadIdsForCustomer: string[]
  ) => {
    setHasDraftModifiedSelection(true);
    const isLeadSelected = draftSelectedLeadIds.includes(leadId);
    let newLeadIds: string[];

    if (isLeadSelected) {
      newLeadIds = draftSelectedLeadIds.filter((id) => id !== leadId);
    } else {
      newLeadIds = [...draftSelectedLeadIds, leadId];
    }

    const hasAnySelectedLead = allLeadIdsForCustomer.some((id) => newLeadIds.includes(id));
    let newCustomerIds = draftSelectedCustomerIds;

    if (hasAnySelectedLead && !draftSelectedCustomerIds.includes(customerId)) {
      newCustomerIds = [...draftSelectedCustomerIds, customerId];
    } else if (!hasAnySelectedLead && draftSelectedCustomerIds.includes(customerId)) {
      newCustomerIds = draftSelectedCustomerIds.filter((id) => id !== customerId);
    }

    setDraftSelectedLeadIds(newLeadIds);
    setDraftSelectedCustomerIds(newCustomerIds);
  };

  const selectAllCustomers = () => {
    setHasDraftModifiedSelection(true);
    setDraftSelectedCustomerIds(storeCustomers.map((c) => c.id));
    setDraftSelectedLeadIds(storeCustomers.flatMap((c) => c.leads.map((l) => l.id)));
  };

  const deselectAllCustomers = () => {
    setHasDraftModifiedSelection(true);
    setDraftSelectedCustomerIds([]);
    setDraftSelectedLeadIds([]);
  };

  const handleSave = () => {
    useSpiderWatcherStore.setState({
      notifications: draftNotifications,
      leadStages: draftLeadStages,
      selectedCustomerIds: draftSelectedCustomerIds,
      selectedLeadIds: draftSelectedLeadIds,
      hasUserModifiedSelection: true,
      days:
        draftLeadStages[0]?.duration !== undefined
          ? String(draftLeadStages[0].duration)
          : '',
    });

    setIsSaved(true);
    toast({
      title: 'Spider Agent Settings Saved',
      description:
        'Notification preferences, distance thresholds, and contact watchers have been successfully applied.',
      duration: 3000,
    });
    setTimeout(() => setIsSaved(false), 2000);
  };

  return (
    <>
      <Dialog open={!!agent} onOpenChange={onOpenChange}>
        <DialogContent
          overlayClassName="bg-ocean-900/40"
          className={cn(
            'flex max-h-[88vh] w-[94vw] flex-col gap-0 overflow-hidden p-0',
            isSpider ? 'max-w-4xl' : 'max-w-2xl'
          )}
        >
          {agent && (
            <>
              <VisuallyHidden>
                <DialogTitle>
                  {agent.name} — {agent.role}
                </DialogTitle>
              </VisuallyHidden>

              {/* Header — Preserved for Spider & all agents */}
              <div className="flex items-start gap-4 border-b border-border bg-surface-light p-6 pr-14">
                <Avatar ring="ai" className="h-16 w-16 shrink-0">
                  {agent.image && (
                    <AvatarImage src={agent.image} alt={agent.name} className="object-cover" />
                  )}
                  <AvatarFallback
                    tone="custom"
                    style={{ backgroundColor: agent.avatarColor }}
                    className="text-lg font-bold"
                  >
                    {agent.name[0]}
                  </AvatarFallback>
                </Avatar>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <Heading level={2} scale="xl" weight="bold">
                      {agent.name}
                    </Heading>
                    {agent.isNew && (
                      <span className="rounded-full border border-ai-200 bg-ai-50 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-ai-600">
                        New
                      </span>
                    )}
                  </div>
                  <p className="text-sm font-semibold uppercase tracking-wide text-ai-600">
                    {agent.role}
                  </p>
                  <span className={cn(comingSoonPillCls, 'mt-1.5 inline-block')}>
                    Coming soon
                  </span>
                </div>
              </div>

              {/* Body */}
              <div className="flex-1 overflow-y-auto p-6">
                {isSpider ? (
                  <SpiderWatcherConfig
                    notifications={draftNotifications}
                    setNotifications={setDraftNotifications}
                    leadStages={draftLeadStages}
                    updateLeadStage={updateDraftLeadStage}
                    selectedCustomerIds={draftSelectedCustomerIds}
                    selectedLeadIds={draftSelectedLeadIds}
                    toggleCustomerSelection={toggleCustomerSelection}
                    toggleLeadSelection={toggleLeadSelection}
                    selectAllCustomers={selectAllCustomers}
                    deselectAllCustomers={deselectAllCustomers}
                    storeCustomers={storeCustomers}
                  />
                ) : (
                  <>
                    {/* Feature-video placeholder */}
                    <div className="relative mb-5 flex aspect-video w-full items-center justify-center overflow-hidden rounded-xl bg-gradient-to-br from-ocean-900 to-ocean-800">
                      <div
                        className="absolute inset-0 opacity-50"
                        style={{
                          background:
                            'radial-gradient(circle at 30% 35%, rgb(var(--ai-600) / 0.45), transparent 60%)',
                        }}
                      />
                      <div className="relative flex flex-col items-center gap-2">
                        <span className="flex h-12 w-12 items-center justify-center rounded-full bg-on-fill/15 backdrop-blur">
                          <Play className="h-5 w-5 fill-on-fill text-on-fill" />
                        </span>
                        <span className="text-xs font-medium text-on-fill/70">
                          Feature video · 90 sec
                        </span>
                      </div>
                    </div>

                    <p className="mb-4 text-base font-bold italic text-ai-600">{agent.tagline}</p>

                    <ul className="space-y-3">
                      {agent.longDescription.map((line, i) => (
                        <li
                          key={i}
                          className="flex gap-2.5 text-sm leading-relaxed text-text-secondary"
                        >
                          <Check className="mt-0.5 h-4 w-4 shrink-0 text-ai-600" />
                          <span>{line}</span>
                        </li>
                      ))}
                    </ul>
                  </>
                )}
              </div>

              {/* Footer CTA */}
              <div className="border-t border-border bg-surface-light p-4">
                <div className="flex items-center gap-3 w-full">
                  {isSpider ? (
                    <>
                      <Button
                        variant="solid"
                        tone="ai"
                        className="flex-[4] min-w-0"
                        style={{ width: '80%' }}
                        onClick={() => onBook(agent)}
                      >
                        Book a call about {agent.name}
                      </Button>
                      <Button
                        type="button"
                        variant="solid"
                        onClick={handleSave}
                        className={cn(
                          'flex-[1] min-w-0 transition-all shadow-xs flex items-center justify-center gap-1.5',
                          isSaved
                            ? 'bg-success-600 hover:bg-success-700 text-on-fill'
                            : 'bg-ai-600 hover:bg-ai-700 text-on-fill'
                        )}
                        style={{ width: '20%' }}
                        aria-label="Save configured Spider agent settings"
                      >
                        {isSaved ? (
                          <>
                            <Check className="h-4 w-4 mr-1" />
                            Saved
                          </>
                        ) : (
                          <>
                            <Save className="h-4 w-4 mr-1" />
                            Save
                          </>
                        )}
                      </Button>
                    </>
                  ) : (
                    <>
                      <Button
                        variant="solid"
                        tone="ai"
                        className="flex-1"
                        onClick={() => onBook(agent)}
                      >
                        Book a call about {agent.name}
                      </Button>
                      {agent.name.toLowerCase() === 'owl' && (
                        <Button
                          id="transcriber-start-btn"
                          variant="outline"
                          className="shrink-0"
                          onClick={() => setTranscriberOpen(true)}
                        >
                          Start
                        </Button>
                      )}
                    </>
                  )}
                </div>
              </div>
            </>
          )}
        </DialogContent>
      </Dialog>

      {/* Transcriber modal — separate portal, does not nest inside the agent dialog */}
      <TranscriberModal open={transcriberOpen} onOpenChange={setTranscriberOpen} />
    </>
  );
}
