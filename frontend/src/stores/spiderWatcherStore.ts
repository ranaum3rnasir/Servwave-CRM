import { create } from 'zustand';
import { useQuery } from '@tanstack/react-query';
import { useEffect } from 'react';
import api from '@/lib/axios';
import { customerDisplayName } from '@/lib/customer-name';

export type TimeUnit = 'Second' | 'Minute' | 'Hour' | 'Day';

export interface LeadStageConfig {
  id: string;
  label: string;
  fromStage: string;
  toStage: string;
  duration?: number;
  unit: TimeUnit;
}

export interface WatcherLead {
  id: string;
  leadNumber: string;
  serviceRequest: string;
  stageId: string;
  stageLabel: string;
  elapsedValue: number;
  elapsedUnit: TimeUnit;
  elapsedSeconds?: number;
  createdAt?: string;
  contactedAt?: string | null;
  walkthroughScheduledAt?: string | null;
  walkthroughCompletedAt?: string | null;
  status?: string;
}

export interface WatcherCustomer {
  id: string;
  name: string;
  company?: string;
  email?: string;
  phone?: string;
  leads: WatcherLead[];
}

export interface SpiderNotificationsConfig {
  email: boolean;
  sms: boolean;
  inApp: boolean;
  redFrame?: boolean;
}

export interface InAppNotification {
  id: string;
  contactName: string;
  companyName: string;
  inactiveDays: number;
  message: string;
  timeAgo: string;
  read: boolean;
  contactId: string;
  leadId?: string;
  leadStage?: string;
  serviceRequest?: string;
  isTriggered?: boolean;
}

/** Convert a duration + unit to seconds for comparison */
export function timeUnitToSeconds(duration: number | undefined | null, unit: TimeUnit): number {
  const d = duration !== undefined && duration !== null ? duration : 0;
  switch (unit) {
    case 'Second':
      return d;
    case 'Minute':
      return d * 60;
    case 'Hour':
      return d * 3600;
    case 'Day':
      return d * 86400;
    default:
      return d;
  }
}

/**
 * Format stage label to only display the current stage name (e.g. 'New', 'Contacted', 'Walkthrough')
 */
export function formatCurrentStageName(stageLabelOrId?: string): string {
  if (!stageLabelOrId) return 'New';
  const lower = stageLabelOrId.toLowerCase();
  if (lower.startsWith('new') || lower.includes('new →')) return 'New';
  if (lower.startsWith('contacted') || lower.includes('contacted →')) return 'Contacted';
  if (lower.startsWith('walkthrough') || lower.includes('walkthrough')) return 'Walkthrough';
  if (lower.startsWith('estimate') || lower.includes('estimate')) return 'Estimate';
  return stageLabelOrId;
}

/**
 * Calculates the current stage and actual time spent in that stage from real lead timestamps
 */
export function resolveLeadStageAndElapsedTime(lead: {
  id?: string;
  created_at?: string | Date | null;
  contacted_at?: string | Date | null;
  walkthrough_scheduled_at?: string | Date | null;
  walkthrough_completed_at?: string | Date | null;
  status?: string | null;
  estimates?: any[] | null;
  updated_at?: string | Date | null;
  elapsedValue?: number;
  elapsedUnit?: TimeUnit;
  stageId?: string;
  stageLabel?: string;
}): {
  stageId: string;
  stageLabel: string;
  elapsedSeconds: number;
  elapsedValue: number;
  elapsedUnit: TimeUnit;
} {
  const now = Date.now();

  const createdAt = lead.created_at ? new Date(lead.created_at).getTime() : now;
  const contactedAt = lead.contacted_at ? new Date(lead.contacted_at).getTime() : null;
  const scheduledAt = lead.walkthrough_scheduled_at
    ? new Date(lead.walkthrough_scheduled_at).getTime()
    : null;
  const completedAt = lead.walkthrough_completed_at
    ? new Date(lead.walkthrough_completed_at).getTime()
    : null;
  const hasEstimates = Array.isArray(lead.estimates) && lead.estimates.length > 0;
  const status = (lead.status || '').toUpperCase();

  let stageId = 'new-contacted';
  let stageLabel = 'New → Contacted';
  let stageStartTime = createdAt;

  // Determine stage based on actual progression timestamps (3 stages)
  if (
    scheduledAt ||
    completedAt ||
    status === 'WALKTHROUGH_SCHEDULED' ||
    status === 'WALKTHROUGH_COMPLETED' ||
    (hasEstimates && status === 'ESTIMATED')
  ) {
    stageId = 'walkthrough-scheduled-estimate';
    stageLabel = 'Walkthrough Scheduled → Estimate';
    stageStartTime =
      scheduledAt ||
      completedAt ||
      (lead.updated_at ? new Date(lead.updated_at).getTime() : createdAt);
  } else if (contactedAt || status === 'CONTACTED') {
    stageId = 'contacted-walkthrough-scheduled';
    stageLabel = 'Contacted → Walkthrough Scheduled';
    stageStartTime =
      contactedAt || (lead.updated_at ? new Date(lead.updated_at).getTime() : createdAt);
  } else {
    stageId = 'new-contacted';
    stageLabel = 'New → Contacted';
    stageStartTime = createdAt;
  }

  // If fallback explicit elapsedValue was given without real created_at
  if (!lead.created_at && lead.elapsedValue !== undefined && lead.elapsedUnit !== undefined) {
    const elapsedSeconds = timeUnitToSeconds(lead.elapsedValue, lead.elapsedUnit);
    return {
      stageId: lead.stageId || stageId,
      stageLabel: lead.stageLabel || stageLabel,
      elapsedSeconds,
      elapsedValue: lead.elapsedValue,
      elapsedUnit: lead.elapsedUnit,
    };
  }

  const elapsedMs = Math.max(0, now - stageStartTime);
  const elapsedSeconds = Math.floor(elapsedMs / 1000);

  let elapsedValue = elapsedSeconds;
  let elapsedUnit: TimeUnit = 'Second';

  if (elapsedSeconds >= 86400) {
    elapsedValue = Math.floor(elapsedSeconds / 86400);
    elapsedUnit = 'Day';
  } else if (elapsedSeconds >= 3600) {
    elapsedValue = Math.floor(elapsedSeconds / 3600);
    elapsedUnit = 'Hour';
  } else if (elapsedSeconds >= 60) {
    elapsedValue = Math.floor(elapsedSeconds / 60);
    elapsedUnit = 'Minute';
  } else {
    elapsedValue = Math.max(1, elapsedSeconds);
    elapsedUnit = 'Second';
  }

  return {
    stageId,
    stageLabel,
    elapsedSeconds,
    elapsedValue,
    elapsedUnit,
  };
}

/** Check whether a lead has exceeded the stage threshold */
export function isLeadOverdue(lead: WatcherLead, stageConfigs: LeadStageConfig[]): boolean {
  const config = stageConfigs.find((s) => s.id === lead.stageId || s.label === lead.stageLabel);
  if (!config || config.duration === undefined || config.duration === null || isNaN(config.duration)) {
    return false;
  }

  const leadSeconds =
    lead.elapsedSeconds !== undefined
      ? lead.elapsedSeconds
      : timeUnitToSeconds(lead.elapsedValue, lead.elapsedUnit);
  const thresholdSeconds = timeUnitToSeconds(config.duration, config.unit);

  return leadSeconds >= thresholdSeconds;
}

// Default 3 Lead Stages: New → Contacted, Contacted → Walkthrough Scheduled, Walkthrough Scheduled → Estimate
export const DEFAULT_LEAD_STAGES: LeadStageConfig[] = [
  {
    id: 'new-contacted',
    label: 'New → Contacted',
    fromStage: 'New',
    toStage: 'Contacted',
    duration: undefined,
    unit: 'Second',
  },
  {
    id: 'contacted-walkthrough-scheduled',
    label: 'Contacted → Walkthrough Scheduled',
    fromStage: 'Contacted',
    toStage: 'Walkthrough Scheduled',
    duration: undefined,
    unit: 'Second',
  },
  {
    id: 'walkthrough-scheduled-estimate',
    label: 'Walkthrough Scheduled → Estimate',
    fromStage: 'Walkthrough Scheduled',
    toStage: 'Estimate',
    duration: undefined,
    unit: 'Second',
  },
];

const NOW = Date.now();
const MIN = 60 * 1000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

export const DEFAULT_WATCHER_CUSTOMERS: WatcherCustomer[] = [
  {
    id: 'c1',
    name: 'John Smith',
    company: 'Apex Plumbing Co.',
    email: 'john@apexplumbing.com',
    phone: '+1 (555) 234-5678',
    leads: [
      {
        id: 'l1',
        leadNumber: 'LD-101',
        serviceRequest: 'Main Line Leak & Pipe Replacement',
        stageId: 'new-contacted',
        stageLabel: 'New → Contacted',
        elapsedValue: 4,
        elapsedUnit: 'Day',
        elapsedSeconds: 4 * 86400,
        createdAt: new Date(NOW - 4 * DAY).toISOString(),
      },
      {
        id: 'l2',
        leadNumber: 'LD-102',
        serviceRequest: 'Commercial Water Heater Installation',
        stageId: 'contacted-walkthrough-scheduled',
        stageLabel: 'Contacted → Walkthrough Scheduled',
        elapsedValue: 6,
        elapsedUnit: 'Day',
        elapsedSeconds: 6 * 86400,
        createdAt: new Date(NOW - 10 * DAY).toISOString(),
        contactedAt: new Date(NOW - 6 * DAY).toISOString(),
      },
      {
        id: 'l3',
        leadNumber: 'LD-103',
        serviceRequest: 'Backflow Valve Annual Testing',
        stageId: 'walkthrough-scheduled-estimate',
        stageLabel: 'Walkthrough Scheduled → Estimate',
        elapsedValue: 12,
        elapsedUnit: 'Hour',
        elapsedSeconds: 12 * 3600,
        createdAt: new Date(NOW - 5 * DAY).toISOString(),
        walkthroughScheduledAt: new Date(NOW - 12 * HOUR).toISOString(),
      },
    ],
  },
  {
    id: 'c2',
    name: 'Sarah Johnson',
    company: 'Metro HVAC Services',
    email: 'sarah.j@metrohvac.com',
    phone: '+1 (555) 345-6789',
    leads: [
      {
        id: 'l4',
        leadNumber: 'LD-201',
        serviceRequest: 'Central AC Rooftop Unit Overhaul',
        stageId: 'contacted-walkthrough-scheduled',
        stageLabel: 'Contacted → Walkthrough Scheduled',
        elapsedValue: 8,
        elapsedUnit: 'Day',
        elapsedSeconds: 8 * 86400,
        createdAt: new Date(NOW - 12 * DAY).toISOString(),
        contactedAt: new Date(NOW - 8 * DAY).toISOString(),
      },
      {
        id: 'l5',
        leadNumber: 'LD-202',
        serviceRequest: 'Ductwork System Sanitization & Sealing',
        stageId: 'walkthrough-scheduled-estimate',
        stageLabel: 'Walkthrough Scheduled → Estimate',
        elapsedValue: 3,
        elapsedUnit: 'Day',
        elapsedSeconds: 3 * 86400,
        createdAt: new Date(NOW - 7 * DAY).toISOString(),
        walkthroughScheduledAt: new Date(NOW - 3 * DAY).toISOString(),
      },
    ],
  },
  {
    id: 'c3',
    name: 'Michael Brown',
    company: 'Citywide Electric',
    email: 'mbrown@citywide.com',
    phone: '+1 (555) 456-7890',
    leads: [
      {
        id: 'l6',
        leadNumber: 'LD-301',
        serviceRequest: '400A Main Electrical Panel Upgrade',
        stageId: 'new-contacted',
        stageLabel: 'New → Contacted',
        elapsedValue: 5,
        elapsedUnit: 'Hour',
        elapsedSeconds: 5 * 3600,
        createdAt: new Date(NOW - 5 * HOUR).toISOString(),
      },
      {
        id: 'l7',
        leadNumber: 'LD-302',
        serviceRequest: 'Level 3 Dual EV Charger Installation',
        stageId: 'walkthrough-scheduled-estimate',
        stageLabel: 'Walkthrough Scheduled → Estimate',
        elapsedValue: 2,
        elapsedUnit: 'Day',
        elapsedSeconds: 2 * 86400,
        createdAt: new Date(NOW - 4 * DAY).toISOString(),
        walkthroughScheduledAt: new Date(NOW - 2 * DAY).toISOString(),
      },
    ],
  },
  {
    id: 'c4',
    name: 'Emily Davis',
    company: 'Highland Builders',
    email: 'edavis@highland.com',
    phone: '+1 (555) 567-8901',
    leads: [
      {
        id: 'l8',
        leadNumber: 'LD-401',
        serviceRequest: 'Custom Home Framing Structural Inspection',
        stageId: 'walkthrough-scheduled-estimate',
        stageLabel: 'Walkthrough Scheduled → Estimate',
        elapsedValue: 4,
        elapsedUnit: 'Day',
        elapsedSeconds: 4 * 86400,
        createdAt: new Date(NOW - 6 * DAY).toISOString(),
        walkthroughScheduledAt: new Date(NOW - 4 * DAY).toISOString(),
      },
      {
        id: 'l9',
        leadNumber: 'LD-402',
        serviceRequest: 'Multi-Level Deck Construction',
        stageId: 'new-contacted',
        stageLabel: 'New → Contacted',
        elapsedValue: 5,
        elapsedUnit: 'Day',
        elapsedSeconds: 5 * 86400,
        createdAt: new Date(NOW - 5 * DAY).toISOString(),
      },
    ],
  },
  {
    id: 'c5',
    name: 'Robert Wilson',
    company: 'Summit Property Management',
    email: 'rwilson@summitpm.com',
    phone: '+1 (555) 678-9012',
    leads: [
      {
        id: 'l10',
        leadNumber: 'LD-501',
        serviceRequest: 'Multi-Unit HVAC & Boiler Seasonal Assessment',
        stageId: 'contacted-walkthrough-scheduled',
        stageLabel: 'Contacted → Walkthrough Scheduled',
        elapsedValue: 6,
        elapsedUnit: 'Day',
        elapsedSeconds: 6 * 86400,
        createdAt: new Date(NOW - 9 * DAY).toISOString(),
        contactedAt: new Date(NOW - 6 * DAY).toISOString(),
      },
    ],
  },
];

/** Build customer + leads structure from live API records */
export function buildWatcherCustomersFromLive(
  apiLeads: any[] = [],
  apiCustomers: any[] = []
): WatcherCustomer[] {
  if ((!apiLeads || apiLeads.length === 0) && (!apiCustomers || apiCustomers.length === 0)) {
    return DEFAULT_WATCHER_CUSTOMERS;
  }

  const customerMap = new Map<string, WatcherCustomer>();

  if (Array.isArray(apiLeads) && apiLeads.length > 0) {
    for (const rawLead of apiLeads) {
      const custId = rawLead.customer?.id || rawLead.customer_id || `cust-${rawLead.id}`;
      const stageMetrics = resolveLeadStageAndElapsedTime(rawLead);

      const watcherLead: WatcherLead = {
        id: rawLead.id,
        leadNumber: rawLead.lead_number || `LD-${String(rawLead.id).slice(-4)}`,
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
  }

  if (Array.isArray(apiCustomers)) {
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
      } else {
        const existing = customerMap.get(cust.id)!;
        if (existing.name === 'Customer' || !existing.email || !existing.company) {
          existing.name = customerDisplayName(cust, cust.company_name || existing.name);
          existing.company = cust.company_name || existing.company;
          existing.email = cust.email || existing.email;
          existing.phone = cust.phone || existing.phone;
        }
      }
    }
  }

  const result = Array.from(customerMap.values());
  return result.length > 0 ? result : DEFAULT_WATCHER_CUSTOMERS;
}

const ALL_CUSTOMER_IDS = DEFAULT_WATCHER_CUSTOMERS.map((c) => c.id);
const ALL_LEAD_IDS = DEFAULT_WATCHER_CUSTOMERS.flatMap((c) => c.leads.map((l) => l.id));

interface SpiderWatcherState {
  notifications: SpiderNotificationsConfig;
  days: string;
  leadStages: LeadStageConfig[];
  customers: WatcherCustomer[];
  selectedCustomerIds: string[];
  selectedLeadIds: string[];
  hasUserModifiedSelection: boolean;
  inAppNotifications: InAppNotification[];
  readNotificationIds: string[];
  isRedBorderActive: boolean;
  activeNotificationId: string | null;
  isWindowOpen: boolean;

  setNotifications: (
    updater:
      | SpiderNotificationsConfig
      | ((prev: SpiderNotificationsConfig) => SpiderNotificationsConfig)
  ) => void;
  setInAppNotification: (enabled: boolean) => void;
  setRedFrameNotification: (enabled: boolean) => void;
  setDays: (days: string) => void;
  setLeadStages: (stages: LeadStageConfig[]) => void;
  updateLeadStage: (id: string, updates: Partial<LeadStageConfig>) => void;
  setCustomers: (customers: WatcherCustomer[]) => void;

  toggleCustomerSelection: (customerId: string, leadIdsForCustomer: string[]) => void;
  toggleLeadSelection: (
    leadId: string,
    customerId: string,
    allLeadIdsForCustomer: string[]
  ) => void;
  selectAllCustomers: () => void;
  deselectAllCustomers: () => void;

  markRead: (id: string) => void;
  markAllRead: () => void;
  markLeadNotificationsRead: (leadId: string) => void;
  selectNotification: (id: string) => void;
  setIsRedBorderActive: (active: boolean) => void;
  setIsWindowOpen: (open: boolean) => void;
  toggleRedBorder: () => void;
  clearRedBorder: () => void;

  getComputedNotifications: () => InAppNotification[];
}

export const useSpiderWatcherStore = create<SpiderWatcherState>((set, get) => ({
  notifications: {
    email: true,
    sms: true,
    inApp: true,
    redFrame: true,
  },
  days: '',
  leadStages: DEFAULT_LEAD_STAGES,
  customers: DEFAULT_WATCHER_CUSTOMERS,
  selectedCustomerIds: ALL_CUSTOMER_IDS,
  selectedLeadIds: ALL_LEAD_IDS,
  hasUserModifiedSelection: false,
  inAppNotifications: [],
  readNotificationIds: [],
  isRedBorderActive: false,
  activeNotificationId: null,
  isWindowOpen: false,

  setNotifications: (updater) =>
    set((state) => ({
      notifications: typeof updater === 'function' ? updater(state.notifications) : updater,
    })),

  setInAppNotification: (enabled) =>
    set((state) => ({
      notifications: { ...state.notifications, inApp: enabled },
    })),

  setRedFrameNotification: (enabled) =>
    set((state) => ({
      notifications: { ...state.notifications, redFrame: enabled },
    })),

  setDays: (days) => set({ days }),

  setLeadStages: (stages) => set({ leadStages: stages }),

  updateLeadStage: (id, updates) =>
    set((state) => {
      const updatedStages = state.leadStages.map((stage) =>
        stage.id === id ? { ...stage, ...updates } : stage
      );
      const firstStage = updatedStages[0];
      const newDays = firstStage && firstStage.duration !== undefined ? String(firstStage.duration) : '';
      return { leadStages: updatedStages, days: newDays };
    }),

  setCustomers: (customers) =>
    set((state) => {
      const allCustomerIds = customers.map((c) => c.id);
      const allLeadIds = customers.flatMap((c) => c.leads.map((l) => l.id));

      // If user has not manually customized selection, select ALL customers and ALL nested leads by default
      if (!state.hasUserModifiedSelection) {
        return {
          customers,
          selectedCustomerIds: allCustomerIds,
          selectedLeadIds: allLeadIds,
        };
      }

      // Preserve valid customer and lead selections if customized by the user
      const validCustomerIds = state.selectedCustomerIds.filter((id) =>
        allCustomerIds.includes(id)
      );
      const validLeadIds = state.selectedLeadIds.filter((id) =>
        allLeadIds.includes(id)
      );

      return {
        customers,
        selectedCustomerIds: validCustomerIds,
        selectedLeadIds: validLeadIds,
      };
    }),

  toggleCustomerSelection: (customerId, leadIdsForCustomer) =>
    set((state) => {
      const allLeadsSelected =
        leadIdsForCustomer.length > 0 &&
        leadIdsForCustomer.every((id) => state.selectedLeadIds.includes(id));
      const isSelected =
        state.selectedCustomerIds.includes(customerId) &&
        (leadIdsForCustomer.length === 0 || allLeadsSelected);

      let newCustomerIds: string[];
      let newLeadIds: string[];

      if (isSelected) {
        newCustomerIds = state.selectedCustomerIds.filter((id) => id !== customerId);
        newLeadIds = state.selectedLeadIds.filter((id) => !leadIdsForCustomer.includes(id));
      } else {
        newCustomerIds = Array.from(new Set([...state.selectedCustomerIds, customerId]));
        newLeadIds = Array.from(new Set([...state.selectedLeadIds, ...leadIdsForCustomer]));
      }

      return {
        hasUserModifiedSelection: true,
        selectedCustomerIds: newCustomerIds,
        selectedLeadIds: newLeadIds,
      };
    }),

  toggleLeadSelection: (leadId, customerId, allLeadIdsForCustomer) =>
    set((state) => {
      const isLeadSelected = state.selectedLeadIds.includes(leadId);
      let newLeadIds: string[];

      if (isLeadSelected) {
        newLeadIds = state.selectedLeadIds.filter((id) => id !== leadId);
      } else {
        newLeadIds = [...state.selectedLeadIds, leadId];
      }

      const hasAnySelectedLead = allLeadIdsForCustomer.some((id) => newLeadIds.includes(id));
      let newCustomerIds = state.selectedCustomerIds;

      if (hasAnySelectedLead && !state.selectedCustomerIds.includes(customerId)) {
        newCustomerIds = [...state.selectedCustomerIds, customerId];
      } else if (!hasAnySelectedLead && state.selectedCustomerIds.includes(customerId)) {
        newCustomerIds = state.selectedCustomerIds.filter((id) => id !== customerId);
      }

      return {
        hasUserModifiedSelection: true,
        selectedLeadIds: newLeadIds,
        selectedCustomerIds: newCustomerIds,
      };
    }),

  selectAllCustomers: () =>
    set((state) => ({
      hasUserModifiedSelection: true,
      selectedCustomerIds: state.customers.map((c) => c.id),
      selectedLeadIds: state.customers.flatMap((c) => c.leads.map((l) => l.id)),
    })),

  deselectAllCustomers: () =>
    set({
      hasUserModifiedSelection: true,
      selectedCustomerIds: [],
      selectedLeadIds: [],
    }),

  markRead: (id) =>
    set((state) => {
      const plainId = id.replace(/^notif-/, '');
      const fullNotifId = `notif-${plainId}`;
      return {
        readNotificationIds: Array.from(
          new Set([...state.readNotificationIds, id, fullNotifId, plainId])
        ),
      };
    }),

  markAllRead: () =>
    set((state) => {
      const allIds = get().getComputedNotifications().map((n) => n.id);
      const allPlainIds = allIds.map((id) => id.replace(/^notif-/, ''));
      return {
        readNotificationIds: Array.from(
          new Set([...state.readNotificationIds, ...allIds, ...allPlainIds])
        ),
      };
    }),

  markLeadNotificationsRead: (leadId) =>
    set((state) => {
      const plainId = leadId.replace(/^notif-/, '');
      const fullNotifId = `notif-${plainId}`;
      return {
        readNotificationIds: Array.from(
          new Set([...state.readNotificationIds, leadId, fullNotifId, plainId])
        ),
      };
    }),

  selectNotification: (id) =>
    set({
      activeNotificationId: id,
      isRedBorderActive: true,
      // Note: Clicking or opening a notification does NOT mark it as read.
      // Notifications are only marked as read when a message is successfully dispatched to the lead.
    }),

  setIsRedBorderActive: (active) => set({ isRedBorderActive: active }),
  setIsWindowOpen: (open) => set({ isWindowOpen: open }),
  toggleRedBorder: () => set((state) => ({ isRedBorderActive: !state.isRedBorderActive })),
  clearRedBorder: () => set({ isRedBorderActive: false }),

  getComputedNotifications: () => {
    const state = get();
    const result: InAppNotification[] = [];

    // Strictly return empty if no customer or lead is selected or no customers exist
    if (
      !state.customers ||
      state.customers.length === 0 ||
      !state.selectedLeadIds ||
      state.selectedLeadIds.length === 0
    ) {
      return result;
    }

    // Evaluate real-time stage notifications dynamically from monitored customers and selected leads
    // Read notifications are filtered out so clicked/read notifications disappear from the list
    for (const customer of state.customers) {
      if (!customer.leads || customer.leads.length === 0) continue;
      for (const lead of customer.leads) {
        const isSelected = state.selectedLeadIds.includes(lead.id);
        if (!isSelected) continue;

        const overdue = isLeadOverdue(lead, state.leadStages);
        const notifId = `notif-${lead.id}`;
        const isRead =
          state.readNotificationIds.includes(notifId) ||
          state.readNotificationIds.includes(lead.id);

        if (overdue && !isRead) {
          const config = state.leadStages.find(
            (s) => s.id === lead.stageId || s.label === lead.stageLabel
          );

          const leadSecs =
            lead.elapsedSeconds !== undefined
              ? lead.elapsedSeconds
              : timeUnitToSeconds(lead.elapsedValue, lead.elapsedUnit);

          const currentStage = formatCurrentStageName(
            lead.stageLabel || lead.stageId || config?.fromStage
          );

          const thresholdDuration = config?.duration ?? 0;
          result.push({
            id: notifId,
            contactName: customer.name,
            companyName: customer.company || customer.name,
            inactiveDays: Math.max(1, Math.round(leadSecs / 86400)),
            message: `Lead ${lead.leadNumber} (${lead.serviceRequest}) in stage "${currentStage}" for ${lead.elapsedValue} ${lead.elapsedUnit}${lead.elapsedValue > 1 ? 's' : ''} (threshold: ${thresholdDuration} ${config?.unit || 'Second'}${thresholdDuration > 1 ? 's' : ''}).`,
            timeAgo: `${lead.elapsedValue} ${lead.elapsedUnit.toLowerCase()}${lead.elapsedValue > 1 ? 's' : ''} in stage`,
            read: false,
            contactId: customer.id,
            leadId: lead.id,
            leadStage: currentStage,
            serviceRequest: lead.serviceRequest,
            isTriggered: true,
          });
        }
      }
    }

    return result;
  },
}));

/** Hook to sync real live API customers and leads into the Spider Watcher store */
export function useSyncSpiderWatcherLive() {
  const setCustomers = useSpiderWatcherStore((s) => s.setCustomers);

  const { data: leads } = useQuery({
    queryKey: ['spider-watcher-leads-real'],
    queryFn: async () => {
      try {
        const res = await api.get('/api/leads', { params: { limit: 100 } });
        return res.data?.leads || [];
      } catch {
        return [];
      }
    },
    staleTime: 15_000,
  });

  const { data: customers } = useQuery({
    queryKey: ['spider-watcher-customers-real'],
    queryFn: async () => {
      try {
        const res = await api.get('/api/customers', { params: { limit: 100 } });
        return res.data?.customers || [];
      } catch {
        return [];
      }
    },
    staleTime: 15_000,
  });

  useEffect(() => {
    if (leads || customers) {
      const live = buildWatcherCustomersFromLive(leads || [], customers || []);
      setCustomers(live);
    }
  }, [leads, customers, setCustomers]);
}
