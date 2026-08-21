import { create } from 'zustand';

export type TimeUnit = 'Second' | 'Minute' | 'Hour' | 'Day';

export interface LeadStageConfig {
  id: string;
  label: string;
  fromStage: string;
  toStage: string;
  duration: number;
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
export function timeUnitToSeconds(duration: number, unit: TimeUnit): number {
  switch (unit) {
    case 'Second':
      return duration;
    case 'Minute':
      return duration * 60;
    case 'Hour':
      return duration * 3600;
    case 'Day':
      return duration * 86400;
    default:
      return duration;
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
  if (!config) return false;

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
    duration: 0,
    unit: 'Second',
  },
  {
    id: 'contacted-walkthrough-scheduled',
    label: 'Contacted → Walkthrough Scheduled',
    fromStage: 'Contacted',
    toStage: 'Walkthrough Scheduled',
    duration: 0,
    unit: 'Second',
  },
  {
    id: 'walkthrough-scheduled-estimate',
    label: 'Walkthrough Scheduled → Estimate',
    fromStage: 'Walkthrough Scheduled',
    toStage: 'Estimate',
    duration: 0,
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
  {
    id: 'c6',
    name: 'Jessica Taylor',
    company: 'Pinnacle Roofing & Solar',
    email: 'jtaylor@pinnacle.com',
    phone: '+1 (555) 789-0123',
    leads: [
      {
        id: 'l11',
        leadNumber: 'LD-601',
        serviceRequest: 'Commercial TPO Roofing & Solar Integration',
        stageId: 'walkthrough-scheduled-estimate',
        stageLabel: 'Walkthrough Scheduled → Estimate',
        elapsedValue: 3,
        elapsedUnit: 'Day',
        elapsedSeconds: 3 * 86400,
        createdAt: new Date(NOW - 5 * DAY).toISOString(),
        walkthroughScheduledAt: new Date(NOW - 3 * DAY).toISOString(),
      },
    ],
  },
  {
    id: 'c7',
    name: 'David Miller',
    company: 'Valley Maintenance',
    email: 'dmiller@valleymaintenance.com',
    phone: '+1 (555) 890-1234',
    leads: [
      {
        id: 'l12',
        leadNumber: 'LD-701',
        serviceRequest: 'Facility Routine Preventative Maintenance',
        stageId: 'new-contacted',
        stageLabel: 'New → Contacted',
        elapsedValue: 2,
        elapsedUnit: 'Hour',
        elapsedSeconds: 2 * 3600,
        createdAt: new Date(NOW - 2 * HOUR).toISOString(),
      },
    ],
  },
];

interface SpiderWatcherState {
  notifications: SpiderNotificationsConfig;
  days: string;
  leadStages: LeadStageConfig[];
  customers: WatcherCustomer[];
  selectedCustomerIds: string[];
  selectedLeadIds: string[];
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
  selectNotification: (id: string) => void;
  setIsRedBorderActive: (active: boolean) => void;
  setIsWindowOpen: (open: boolean) => void;
  toggleRedBorder: () => void;
  clearRedBorder: () => void;

  getComputedNotifications: () => InAppNotification[];
}

const ALL_CUSTOMER_IDS = DEFAULT_WATCHER_CUSTOMERS.map((c) => c.id);
const ALL_LEAD_IDS = DEFAULT_WATCHER_CUSTOMERS.flatMap((c) => c.leads.map((l) => l.id));

export const useSpiderWatcherStore = create<SpiderWatcherState>((set, get) => ({
  notifications: {
    email: true,
    sms: true,
    inApp: true,
  },
  days: '0',
  leadStages: DEFAULT_LEAD_STAGES,
  customers: DEFAULT_WATCHER_CUSTOMERS,
  selectedCustomerIds: ALL_CUSTOMER_IDS,
  selectedLeadIds: ALL_LEAD_IDS,
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

  setDays: (days) => set({ days }),

  setLeadStages: (stages) => set({ leadStages: stages }),

  updateLeadStage: (id, updates) =>
    set((state) => {
      const updatedStages = state.leadStages.map((stage) =>
        stage.id === id ? { ...stage, ...updates } : stage
      );
      const firstStage = updatedStages[0];
      const newDays = firstStage ? String(firstStage.duration) : state.days;
      return { leadStages: updatedStages, days: newDays };
    }),

  setCustomers: (customers) => set({ customers }),

  toggleCustomerSelection: (customerId, leadIdsForCustomer) =>
    set((state) => {
      const isSelected = state.selectedCustomerIds.includes(customerId);
      let newCustomerIds: string[];
      let newLeadIds: string[];

      if (isSelected) {
        newCustomerIds = state.selectedCustomerIds.filter((id) => id !== customerId);
        newLeadIds = state.selectedLeadIds.filter((id) => !leadIdsForCustomer.includes(id));
      } else {
        newCustomerIds = [...state.selectedCustomerIds, customerId];
        newLeadIds = Array.from(new Set([...state.selectedLeadIds, ...leadIdsForCustomer]));
      }

      return {
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
        selectedLeadIds: newLeadIds,
        selectedCustomerIds: newCustomerIds,
      };
    }),

  selectAllCustomers: () =>
    set((state) => ({
      selectedCustomerIds: state.customers.map((c) => c.id),
      selectedLeadIds: state.customers.flatMap((c) => c.leads.map((l) => l.id)),
    })),

  deselectAllCustomers: () =>
    set({
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

  selectNotification: (id) =>
    set((state) => {
      const plainId = id.replace(/^notif-/, '');
      const fullNotifId = `notif-${plainId}`;
      return {
        activeNotificationId: id,
        isRedBorderActive: true,
        readNotificationIds: Array.from(
          new Set([...state.readNotificationIds, id, fullNotifId, plainId])
        ),
      };
    }),

  setIsRedBorderActive: (active) => set({ isRedBorderActive: active }),
  setIsWindowOpen: (open) => set({ isWindowOpen: open }),
  toggleRedBorder: () => set((state) => ({ isRedBorderActive: !state.isRedBorderActive })),
  clearRedBorder: () => set({ isRedBorderActive: false }),

  getComputedNotifications: () => {
    const state = get();
    const result: InAppNotification[] = [];

    // Evaluate real-time stage notifications dynamically from monitored customers and leads
    // Read notifications are filtered out so clicked/read notifications disappear from the list
    for (const customer of state.customers) {
      for (const lead of customer.leads) {
        const isSelected = state.selectedLeadIds.includes(lead.id);
        const overdue = isLeadOverdue(lead, state.leadStages);
        const notifId = `notif-${lead.id}`;
        const isRead =
          state.readNotificationIds.includes(notifId) ||
          state.readNotificationIds.includes(lead.id);

        if (isSelected && overdue && !isRead) {
          const config = state.leadStages.find(
            (s) => s.id === lead.stageId || s.label === lead.stageLabel
          );

          const leadSecs =
            lead.elapsedSeconds !== undefined
              ? lead.elapsedSeconds
              : timeUnitToSeconds(lead.elapsedValue, lead.elapsedUnit);

          const currentStage = formatCurrentStageName(lead.stageLabel || lead.stageId || config?.fromStage);

          result.push({
            id: notifId,
            contactName: customer.name,
            companyName: customer.company || customer.name,
            inactiveDays: Math.max(1, Math.round(leadSecs / 86400)),
            message: `Lead ${lead.leadNumber} (${lead.serviceRequest}) in stage "${currentStage}" for ${lead.elapsedValue} ${lead.elapsedUnit}${lead.elapsedValue > 1 ? 's' : ''} (threshold: ${config?.duration ?? 0} ${config?.unit || 'Second'}${config && config.duration > 1 ? 's' : ''}).`,
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
