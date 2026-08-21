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
  DEFAULT_WATCHER_CUSTOMERS,
  isLeadOverdue,
  resolveLeadStageAndElapsedTime,
} from '@/stores/spiderWatcherStore';

interface AgentDetailModalProps {
  agent: AIAgent | null;
  onOpenChange: (open: boolean) => void;
  onBook: (agent: AIAgent) => void;
}

const TIME_UNITS: TimeUnit[] = ['Second', 'Minute', 'Hour', 'Day'];

/** Dedicated UI for Spider (AI Lead Manager) Watcher configuration */
function SpiderWatcherConfig() {
  const notifications = useSpiderWatcherStore((s) => s.notifications);
  const setNotifications = useSpiderWatcherStore((s) => s.setNotifications);
  const leadStages = useSpiderWatcherStore((s) => s.leadStages);
  const updateLeadStage = useSpiderWatcherStore((s) => s.updateLeadStage);
  const storeCustomers = useSpiderWatcherStore((s) => s.customers);
  const setCustomers = useSpiderWatcherStore((s) => s.setCustomers);
  const selectedCustomerIds = useSpiderWatcherStore((s) => s.selectedCustomerIds);
  const selectedLeadIds = useSpiderWatcherStore((s) => s.selectedLeadIds);
  const toggleCustomerSelection = useSpiderWatcherStore((s) => s.toggleCustomerSelection);
  const toggleLeadSelection = useSpiderWatcherStore((s) => s.toggleLeadSelection);
  const selectAllCustomers = useSpiderWatcherStore((s) => s.selectAllCustomers);
  const deselectAllCustomers = useSpiderWatcherStore((s) => s.deselectAllCustomers);

  const [search, setSearch] = useState('');
  const [expandedCustomerId, setExpandedCustomerId] = useState<string | null>(null);

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
    if (apiLeads && apiLeads.length > 0) {
      const customerMap = new Map<string, WatcherCustomer>();

      for (const rawLead of apiLeads) {
        const custId = rawLead.customer?.id || rawLead.customer_id || `cust-${rawLead.id}`;
        const stageMetrics = resolveLeadStageAndElapsedTime(rawLead);

        const watcherLead: WatcherLead = {
          id: rawLead.id,
          leadNumber: rawLead.lead_number || `LD-${rawLead.id.slice(-4)}`,
          serviceRequest: rawLead.service_request || 'General Service Request',
          stageId: stageMetrics.stageId,
          stageLabel: stageMetrics.stageLabel,
          elapsedValue: stageMetrics.elapsedValue,
          elapsedUnit: stageMetrics.elapsedUnit,
          elapsedSeconds: stageMetrics.elapsedSeconds,
          createdAt: rawLead.created_at,
          contactedAt: rawLead.contacted_at,
          walkthroughScheduledAt: rawLead.walkthrough_scheduled_at,
          walkthroughCompletedAt: rawLead.walkthrough_completed_at,
          status: rawLead.status,
        };

        if (!customerMap.has(custId)) {
          const cust = rawLead.customer || {};
          customerMap.set(custId, {
            id: custId,
            name: customerDisplayName(cust, cust.company_name || 'Customer'),
            company: cust.company_name,
            email: cust.email,
            phone: cust.phone,
            leads: [watcherLead],
          });
        } else {
          customerMap.get(custId)!.leads.push(watcherLead);
        }
      }

      if (apiCustomers && apiCustomers.length > 0) {
        for (const cust of apiCustomers) {
          if (!customerMap.has(cust.id)) {
            customerMap.set(cust.id, {
              id: cust.id,
              name: customerDisplayName(cust, cust.company_name || 'Customer'),
              company: cust.company_name,
              email: cust.email,
              phone: cust.phone,
              leads: [],
            });
          }
        }
      }

      setCustomers(Array.from(customerMap.values()));
    }
  }, [apiLeads, apiCustomers, setCustomers]);

  // Use store customers (either default or synced with live leads)
  const customersList: WatcherCustomer[] = useMemo(() => {
    const base = storeCustomers && storeCustomers.length > 0 ? storeCustomers : DEFAULT_WATCHER_CUSTOMERS;
    return base.map((c) => ({
      ...c,
      leads: c.leads.map((l) => {
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
    customersList.every((c) => selectedCustomerIds.includes(c.id));

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

                  {/* Parallel Time Period & Unit Inputs */}
                  <div className="flex items-center gap-2 shrink-0">
                    <input
                      type="number"
                      min="0"
                      value={stage.duration !== undefined ? stage.duration : 0}
                      onChange={(e) => {
                        const val = parseInt(e.target.value, 10);
                        if (!isNaN(val) && val >= 0) {
                          updateLeadStage(stage.id, { duration: val });
                        } else if (e.target.value === '') {
                          updateLeadStage(stage.id, { duration: 0 });
                        }
                      }}
                      className="w-14 rounded-md border border-border bg-surface-light px-2 py-1 text-xs font-bold text-text-primary text-center outline-none focus-visible:ring-2 focus-visible:ring-ai-500"
                      placeholder="0"
                      aria-label={`Time period for ${stage.label}`}
                    />
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

            <p className="text-[11px] text-text-soft leading-tight pt-1">
              Spider watches for leads remaining in each stage longer than the configured period.
            </p>
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
              const isCustomerChecked = selectedCustomerIds.includes(customer.id);
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
                        checked={isCustomerChecked}
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
                      <button
                        type="button"
                        aria-label={`Toggle leads for ${customer.name}`}
                        aria-expanded={isDropdownOpen}
                        onClick={(e) => {
                          e.stopPropagation();
                          setExpandedCustomerId(
                            expandedCustomerId === customer.id ? null : customer.id
                          );
                        }}
                        className="rounded p-1 text-text-soft hover:text-text-primary hover:bg-background-light cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ai-500"
                      >
                        <ChevronDown
                          className={cn(
                            'h-4 w-4 text-text-soft transition-transform duration-200',
                            isDropdownOpen && 'rotate-180 text-ai-600'
                          )}
                        />
                      </button>
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
                            const overdue = isLeadOverdue(lead, leadStages);
                            const stageConfig = leadStages.find(
                              (s) => s.id === lead.stageId || s.label === lead.stageLabel
                            );

                            return (
                              <div
                                key={lead.id}
                                className={cn(
                                  'flex flex-col sm:flex-row sm:items-center justify-between gap-2 rounded-md p-2 border transition-colors',
                                  isLeadChecked
                                    ? overdue
                                      ? 'border-danger-border bg-danger-surface/50 hover:bg-danger-surface/70'
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
                                      <span className="rounded bg-ai-50 border border-ai-200 px-1.5 py-0.2 text-[10px] font-bold text-ai-strong">
                                        {lead.stageLabel}
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

                                  {isLeadChecked && overdue ? (
                                    <span className="flex items-center gap-1 rounded-full bg-danger text-on-fill px-2 py-0.5 text-[10px] font-bold shadow-xs">
                                      <AlertTriangle className="h-3 w-3" />
                                      Alert Active ({lead.elapsedValue} {lead.elapsedUnit}s ≥{' '}
                                      {stageConfig?.duration ?? 0} {stageConfig?.unit || 'Second'}s)
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
                  <SpiderWatcherConfig />
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
                <div className="flex items-center gap-3">
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
