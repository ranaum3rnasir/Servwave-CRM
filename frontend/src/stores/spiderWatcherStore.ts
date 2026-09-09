import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { useQuery } from '@tanstack/react-query';
import { useEffect } from 'react';
import api from '@/lib/axios';
import { customerDisplayName } from '@/lib/customer-name';
import { dispatchSpiderAlertApi } from '@/lib/api/spider';

export type TimeUnit = 'Second' | 'Minute' | 'Hour' | 'Day';

export interface LeadStageConfig {
  id: string;
  label: string;
  fromStage: string;
  toStage: string;
  duration?: number;
  unit: TimeUnit;
  enabled?: boolean;
}

export interface WatcherLead {
  id: string;
  leadNumber: string;
  serviceRequest?: string;
  serviceLocation?: string;
  service_location_id?: string | null;
  service_location?: any;
  service_address_line1?: string | null;
  service_address_line2?: string | null;
  service_city?: string | null;
  service_state?: string | null;
  service_zip?: string | null;
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
  // Lead Owner (Assigned To)
  assigned_to?: string | null;
  assigned_to_user_id?: string | null;
  owner_id?: string | null;
  commission_owner_id?: string | null;
  commission_owner?: any;
  assigned_to_user?: any;
  owner?: any;
  assignedToName?: string | null;
}

export interface WatcherCustomer {
  id: string;
  name: string;
  company?: string;
  email?: string;
  phone?: string;
  service_locations?: any[];
  leads: WatcherLead[];
}

export interface SystemRoleItem {
  id: string;
  label: string;
  description?: string;
}

export interface AssignmentUserItem {
  id: string;
  name: string;
  email?: string;
  role: string;
  roleLabel?: string;
  avatar_url?: string | null;
}

export interface SpiderAssignmentsConfig {
  adminRoles: string[];
  owner: boolean;
  users: string[];
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
  leadNumber?: string;
  leadStage?: string;
  serviceRequest?: string;
  serviceLocation?: string;
  contactedAt?: string | null;
  createdAt?: string | null;
  lastCommunication?: string | null;
  isTriggered?: boolean;
  assignedTo?: string | null;
  assignedToId?: string | null;
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
  contactedAt?: string | Date | null;
}): {
  stageId: string;
  stageLabel: string;
  elapsedSeconds: number;
  elapsedValue: number;
  elapsedUnit: TimeUnit;
  contactedAt?: string | null;
} {
  const now = Date.now();

  const createdAt = lead.created_at ? new Date(lead.created_at).getTime() : now;
  const rawContactedAt = lead.contacted_at || lead.contactedAt;
  const contactedAt = rawContactedAt ? new Date(rawContactedAt).getTime() : null;
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
    // For leads in the Contacted stage, elapsed time strictly begins from the last communication / contacted timestamp
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
      contactedAt: rawContactedAt ? String(rawContactedAt) : null,
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
    contactedAt: rawContactedAt ? String(rawContactedAt) : null,
  };
}

/** Check whether a lead has exceeded the stage threshold */
export function isLeadOverdue(lead: WatcherLead, stageConfigs: LeadStageConfig[]): boolean {
  const config = stageConfigs.find((s) => s.id === lead.stageId || s.label === lead.stageLabel);
  if (
    !config ||
    config.enabled === false ||
    config.duration === undefined ||
    config.duration === null ||
    isNaN(config.duration)
  ) {
    return false;
  }

  const leadSeconds =
    lead.elapsedSeconds !== undefined
      ? lead.elapsedSeconds
      : timeUnitToSeconds(lead.elapsedValue, lead.elapsedUnit);
  const thresholdSeconds = timeUnitToSeconds(config.duration, config.unit);

  return leadSeconds >= thresholdSeconds;
}

/**
 * Resolves the user-facing functional title for a stage
 */
export function getStageFunctionalTitle(stage: LeadStageConfig): string {
  const id = (stage.id || '').toLowerCase();
  const label = (stage.label || '').toLowerCase();
  if (id.includes('new') || label.includes('new')) {
    return 'Time to First Contact';
  }
  if (id.includes('walkthrough-scheduled-estimate') || (label.includes('walkthrough') && label.includes('estimate'))) {
    return 'Time to Deliver Estimate';
  }
  if (id.includes('walkthrough') || label.includes('walkthrough')) {
    return 'Time to Schedule Walkthrough';
  }
  return stage.label;
}

/**
 * Returns the pipeline transition flow (e.g. "New → Contacted")
 */
export function getStagePipelineFlow(stage: LeadStageConfig): string {
  if (stage.fromStage && stage.toStage) {
    return `${stage.fromStage} → ${stage.toStage}`;
  }
  return stage.label;
}

/**
 * Provides a sensible default fallback duration when enabling a stage
 */
export function getDefaultFallbackDuration(stageId?: string, unit: TimeUnit = 'Minute'): number {
  return 1;
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

// Default System Roles from Settings > Roles & Permissions
export const DEFAULT_SYSTEM_ROLES: SystemRoleItem[] = [
  {
    id: 'ADMIN',
    label: 'Administrator (Owner)',
    description: 'Full access to system and alert management',
  },
  {
    id: 'SALES',
    label: 'Sales',
    description: 'Lead pipelines, estimates, and customer communications',
  },
  {
    id: 'DISPATCHER',
    label: 'Dispatcher',
    description: 'Scheduling, job dispatch, and technician routing',
  },
  {
    id: 'TECHNICIAN',
    label: 'Technician',
    description: 'Field service execution and job completion',
  },
];

// Fallback users for local tests and initial hydration
export const DEFAULT_ASSIGNMENT_USERS: AssignmentUserItem[] = [
  {
    id: 'u-admin-1',
    name: 'Alex Morgan',
    email: 'alex@example.com',
    role: 'ADMIN',
    roleLabel: 'Administrator (Owner)',
  },
  {
    id: 'u-admin-2',
    name: 'Sarah Connor',
    email: 'sarah@example.com',
    role: 'ADMIN',
    roleLabel: 'Administrator (Owner)',
  },
  {
    id: 'u-sales-1',
    name: 'Michael Scott',
    email: 'michael@example.com',
    role: 'SALES',
    roleLabel: 'Sales',
  },
  {
    id: 'u-sales-2',
    name: 'Jim Halpert',
    email: 'jim@example.com',
    role: 'SALES',
    roleLabel: 'Sales',
  },
  {
    id: 'u-disp-1',
    name: 'Pam Beesly',
    email: 'pam@example.com',
    role: 'DISPATCHER',
    roleLabel: 'Dispatcher',
  },
  {
    id: 'u-tech-1',
    name: 'Dwight Schrute',
    email: 'dwight@example.com',
    role: 'TECHNICIAN',
    roleLabel: 'Technician',
  },
];

export const DEFAULT_ASSIGNMENTS_CONFIG: SpiderAssignmentsConfig = {
  adminRoles: ['ADMIN', 'SALES', 'DISPATCHER', 'TECHNICIAN'],
  owner: true,
  users: ['u-admin-1', 'u-admin-2', 'u-sales-1', 'u-sales-2', 'u-disp-1', 'u-tech-1'],
};

export function normalizeAssignments(raw: any): SpiderAssignmentsConfig {
  if (!raw || typeof raw !== 'object') return DEFAULT_ASSIGNMENTS_CONFIG;
  if (Array.isArray(raw.adminRoles)) {
    return {
      adminRoles: Array.isArray(raw.adminRoles) ? raw.adminRoles : DEFAULT_ASSIGNMENTS_CONFIG.adminRoles,
      owner: typeof raw.owner === 'boolean' ? raw.owner : true,
      users: Array.isArray(raw.users) ? raw.users : DEFAULT_ASSIGNMENTS_CONFIG.users,
    };
  }
  return DEFAULT_ASSIGNMENTS_CONFIG;
}

/**
 * Resolves the lead owner ID from a lead record (e.g. commission_owner, assigned_to user)
 */
export function getSpiderLeadOwnerId(lead: Partial<WatcherLead> | Record<string, any> | undefined | null): string | null {
  if (!lead) return null;
  return (
    lead.commission_owner_id ||
    (typeof lead.commission_owner === 'object' && lead.commission_owner?.id) ||
    lead.assigned_to_user_id ||
    (typeof lead.assigned_to_user === 'object' && lead.assigned_to_user?.id) ||
    (typeof lead.owner === 'object' && lead.owner?.id) ||
    lead.owner_id ||
    (typeof lead.assigned_to === 'string' ? lead.assigned_to : (lead.assigned_to?.id || null)) ||
    null
  );
}

/**
 * Resolves the lead owner display name from a lead record
 */
export function getSpiderLeadOwnerName(lead: Partial<WatcherLead> | Record<string, any> | undefined | null): string | null {
  if (!lead) return null;
  if (lead.assignedToName) return lead.assignedToName;
  const ownerObj =
    lead.commission_owner ||
    lead.assigned_to_user ||
    lead.owner ||
    (typeof lead.assigned_to === 'object' ? lead.assigned_to : null);
  if (ownerObj) {
    const fullName = `${ownerObj.first_name || ''} ${ownerObj.last_name || ''}`.trim();
    if (fullName) return fullName;
    if (ownerObj.name) return ownerObj.name;
    if (ownerObj.email) return ownerObj.email;
  }
  return null;
}

/**
 * Resolves recipients for a Spider Alert based on Assignment rules:
 * 1. If Admin roles are selected, alerts are sent to those selected roles.
 * 2. If User is selected, alerts are sent directly to those specific users.
 * 3. If Owner is selected, alerts are sent strictly to the owner of that specific lead.
 */
export function resolveSpiderAlertRecipients(params: {
  assignments: SpiderAssignmentsConfig;
  lead: Partial<WatcherLead>;
  allUsers?: AssignmentUserItem[];
}): string[] {
  const { assignments, lead, allUsers = DEFAULT_ASSIGNMENT_USERS } = params;
  const recipients = new Set<string>();

  // 1. Admin roles: Include all users matching the selected Admin roles
  if (Array.isArray(assignments.adminRoles) && assignments.adminRoles.length > 0) {
    const matchingUsers = allUsers.filter((u) => assignments.adminRoles.includes(u.role));
    matchingUsers.forEach((u) => recipients.add(u.id));
  }

  // 2. Explicit user IDs if any
  if (Array.isArray(assignments.users) && assignments.users.length > 0) {
    assignments.users.forEach((userId) => recipients.add(userId));
  }

  // 3. Lead Owner: If Owner is checked, strictly include the owner of this specific lead
  if (assignments.owner) {
    const ownerId = getSpiderLeadOwnerId(lead);
    if (ownerId) {
      recipients.add(ownerId);
    }
  }

  // Union & de-duplicated
  return Array.from(recipients);
}

/**
 * Check if a given user is an assigned recipient for a lead alert based on Assignment settings:
 * 1. If Admin roles are selected, users holding those roles receive alerts.
 * 2. If specific users are selected, those users receive alerts.
 * 3. If Owner is selected, the owner of this specific lead strictly receives alerts.
 * 4. If nothing is selected (or no role/user/owner matches the user), the user receives NO alert.
 */
export function isUserAssignedToSpiderAlert(
  assignments: SpiderAssignmentsConfig | undefined | null,
  lead: Partial<WatcherLead>,
  user?: { id?: string; role?: string; email?: string; first_name?: string; last_name?: string } | null
): boolean {
  if (!assignments) return false;

  const hasAdminRoles = Array.isArray(assignments.adminRoles) && assignments.adminRoles.length > 0;
  const hasUsers = Array.isArray(assignments.users) && assignments.users.length > 0;
  const hasOwner = !!assignments.owner;

  // If nothing is selected in Admin role, User, or Owner, NO alert is sent to anyone
  if (!hasAdminRoles && !hasUsers && !hasOwner) {
    return false;
  }

  // If no user context is passed (e.g. general count/server view), return true as long as there is an active target configuration
  if (!user) {
    return hasAdminRoles || hasUsers || hasOwner;
  }

  // 1. Check if user's role is in the selected Admin roles
  if (user.role && hasAdminRoles && assignments.adminRoles.includes(user.role)) {
    return true;
  }

  // 2. Check if user is explicitly in the selected users list
  if (user.id && hasUsers && assignments.users.includes(user.id)) {
    return true;
  }

  // 3. Check if Owner is enabled and user is the assigned lead owner of this specific lead
  if (hasOwner) {
    const leadOwnerId = getSpiderLeadOwnerId(lead);
    if (leadOwnerId && user.id && (leadOwnerId === user.id || String(leadOwnerId) === String(user.id))) {
      return true;
    }

    // Also match by email or name if commission_owner object is attached
    const ownerObj = lead.commission_owner || lead.assigned_to_user || lead.owner;
    if (ownerObj) {
      if (ownerObj.id && user.id && String(ownerObj.id) === String(user.id)) {
        return true;
      }
      if (ownerObj.email && user.email && ownerObj.email.toLowerCase() === user.email.toLowerCase()) {
        return true;
      }
    }
  }

  return false;
}

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
        serviceLocation: '9462 Highland Ave, Suite 414, Paterson, NJ 07501',
        stageId: 'new-contacted',
        stageLabel: 'New → Contacted',
        elapsedValue: 4,
        elapsedUnit: 'Day',
        elapsedSeconds: 4 * 86400,
        createdAt: new Date(NOW - 4 * DAY).toISOString(),
        assigned_to: 'u-admin-1',
        commission_owner_id: 'u-admin-1',
        assignedToName: 'Alex Morgan',
        commission_owner: { id: 'u-admin-1', first_name: 'Alex', last_name: 'Morgan', email: 'alex@example.com' },
      },
      {
        id: 'l2',
        leadNumber: 'LD-102',
        serviceRequest: 'Commercial Water Heater Installation',
        serviceLocation: '1048 Industrial Pkwy, Suite 300, Portland, OR 97201',
        stageId: 'contacted-walkthrough-scheduled',
        stageLabel: 'Contacted → Walkthrough Scheduled',
        elapsedValue: 6,
        elapsedUnit: 'Day',
        elapsedSeconds: 6 * 86400,
        createdAt: new Date(NOW - 10 * DAY).toISOString(),
        contactedAt: new Date(NOW - 6 * DAY).toISOString(),
        assigned_to: 'u-sales-1',
        commission_owner_id: 'u-sales-1',
        assignedToName: 'Michael Scott',
        commission_owner: { id: 'u-sales-1', first_name: 'Michael', last_name: 'Scott', email: 'michael@example.com' },
      },
      {
        id: 'l3',
        leadNumber: 'LD-103',
        serviceRequest: 'Backflow Valve Annual Testing',
        serviceLocation: '520 Commercial St, Suite 100, Salem, OR 97301',
        stageId: 'walkthrough-scheduled-estimate',
        stageLabel: 'Walkthrough Scheduled → Estimate',
        elapsedValue: 12,
        elapsedUnit: 'Hour',
        elapsedSeconds: 12 * 3600,
        createdAt: new Date(NOW - 5 * DAY).toISOString(),
        walkthroughScheduledAt: new Date(NOW - 12 * HOUR).toISOString(),
        assigned_to: 'u-disp-1',
        commission_owner_id: 'u-disp-1',
        assignedToName: 'Pam Beesly',
        commission_owner: { id: 'u-disp-1', first_name: 'Pam', last_name: 'Beesly', email: 'pam@example.com' },
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
        serviceLocation: '880 Skyline Blvd, Suite 200, Denver, CO 80202',
        stageId: 'contacted-walkthrough-scheduled',
        stageLabel: 'Contacted → Walkthrough Scheduled',
        elapsedValue: 8,
        elapsedUnit: 'Day',
        elapsedSeconds: 8 * 86400,
        createdAt: new Date(NOW - 12 * DAY).toISOString(),
        contactedAt: new Date(NOW - 8 * DAY).toISOString(),
        assigned_to: 'u-tech-1',
        commission_owner_id: 'u-tech-1',
        assignedToName: 'Dwight Schrute',
        commission_owner: { id: 'u-tech-1', first_name: 'Dwight', last_name: 'Schrute', email: 'dwight@example.com' },
      },
      {
        id: 'l5',
        leadNumber: 'LD-202',
        serviceRequest: 'Ductwork System Sanitization & Sealing',
        serviceLocation: '4120 Enterprise Way, Suite 150, Aurora, CO 80011',
        stageId: 'walkthrough-scheduled-estimate',
        stageLabel: 'Walkthrough Scheduled → Estimate',
        elapsedValue: 3,
        elapsedUnit: 'Day',
        elapsedSeconds: 3 * 86400,
        createdAt: new Date(NOW - 7 * DAY).toISOString(),
        walkthroughScheduledAt: new Date(NOW - 3 * DAY).toISOString(),
        assigned_to: 'u-sales-2',
        commission_owner_id: 'u-sales-2',
        assignedToName: 'Jim Halpert',
        commission_owner: { id: 'u-sales-2', first_name: 'Jim', last_name: 'Halpert', email: 'jim@example.com' },
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
        serviceLocation: '1500 Market St, Suite 400, Austin, TX 78701',
        stageId: 'new-contacted',
        stageLabel: 'New → Contacted',
        elapsedValue: 5,
        elapsedUnit: 'Hour',
        elapsedSeconds: 5 * 3600,
        createdAt: new Date(NOW - 5 * HOUR).toISOString(),
        assigned_to: 'u-admin-2',
        commission_owner_id: 'u-admin-2',
        assignedToName: 'Sarah Connor',
        commission_owner: { id: 'u-admin-2', first_name: 'Sarah', last_name: 'Connor', email: 'sarah@example.com' },
      },
      {
        id: 'l7',
        leadNumber: 'LD-302',
        serviceRequest: 'Level 3 Dual EV Charger Installation',
        serviceLocation: '2301 Congress Ave, Suite 250, Austin, TX 78704',
        stageId: 'walkthrough-scheduled-estimate',
        stageLabel: 'Walkthrough Scheduled → Estimate',
        elapsedValue: 2,
        elapsedUnit: 'Day',
        elapsedSeconds: 2 * 86400,
        createdAt: new Date(NOW - 4 * DAY).toISOString(),
        walkthroughScheduledAt: new Date(NOW - 2 * DAY).toISOString(),
        assigned_to: 'u-admin-1',
        commission_owner_id: 'u-admin-1',
        assignedToName: 'Alex Morgan',
        commission_owner: { id: 'u-admin-1', first_name: 'Alex', last_name: 'Morgan', email: 'alex@example.com' },
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
        serviceLocation: '920 Mountain View Rd, Boulder, CO 80302',
        stageId: 'walkthrough-scheduled-estimate',
        stageLabel: 'Walkthrough Scheduled → Estimate',
        elapsedValue: 4,
        elapsedUnit: 'Day',
        elapsedSeconds: 4 * 86400,
        createdAt: new Date(NOW - 6 * DAY).toISOString(),
        walkthroughScheduledAt: new Date(NOW - 4 * DAY).toISOString(),
        assigned_to: 'u-sales-1',
        commission_owner_id: 'u-sales-1',
        assignedToName: 'Michael Scott',
        commission_owner: { id: 'u-sales-1', first_name: 'Michael', last_name: 'Scott', email: 'michael@example.com' },
      },
      {
        id: 'l9',
        leadNumber: 'LD-402',
        serviceRequest: 'Multi-Level Deck Construction',
        serviceLocation: '345 Pinecrest Dr, Suite 50, Boulder, CO 80304',
        stageId: 'new-contacted',
        stageLabel: 'New → Contacted',
        elapsedValue: 5,
        elapsedUnit: 'Day',
        elapsedSeconds: 5 * 86400,
        createdAt: new Date(NOW - 5 * DAY).toISOString(),
        assigned_to: 'u-tech-1',
        commission_owner_id: 'u-tech-1',
        assignedToName: 'Dwight Schrute',
        commission_owner: { id: 'u-tech-1', first_name: 'Dwight', last_name: 'Schrute', email: 'dwight@example.com' },
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
        serviceLocation: '1200 Grand Ave, Suite 310, Phoenix, AZ 85007',
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

/** Format a timestamp into human-readable relative time (e.g., '6 Days ago', '2 Hours ago') */
export function formatLastCommunicationTimestamp(
  contactedAt?: string | Date | null
): string | null {
  if (!contactedAt) return null;
  const timeMs = new Date(contactedAt).getTime();
  if (isNaN(timeMs)) return null;
  const elapsedSeconds = Math.max(0, Math.floor((Date.now() - timeMs) / 1000));

  if (elapsedSeconds >= 86400) {
    const days = Math.floor(elapsedSeconds / 86400);
    return `${days} Day${days === 1 ? '' : 's'} ago`;
  }
  if (elapsedSeconds >= 3600) {
    const hours = Math.floor(elapsedSeconds / 3600);
    return `${hours} Hour${hours === 1 ? '' : 's'} ago`;
  }
  if (elapsedSeconds >= 60) {
    const mins = Math.floor(elapsedSeconds / 60);
    return `${mins} Minute${mins === 1 ? '' : 's'} ago`;
  }
  return `${Math.max(1, elapsedSeconds)}s ago`;
}

/** Format lead communication status string (e.g. 'Last communication: 6 Days ago') */
export function formatLeadLastCommunication(
  contactedAt?: string | Date | null,
  createdAt?: string | Date | null
): string {
  const commStr = formatLastCommunicationTimestamp(contactedAt);
  if (commStr) {
    return `Last communication: ${commStr}`;
  }
  const createdStr = formatLastCommunicationTimestamp(createdAt);
  if (createdStr) {
    return `No communication recorded yet (Lead created ${createdStr})`;
  }
  return 'No communication recorded yet';
}

/** Helper to format address components into a clean single-line address */
export function formatAddressParts(
  line1?: string | null,
  line2?: string | null,
  city?: string | null,
  state?: string | null,
  zip?: string | null
): string | null {
  const streetParts = [line1?.trim(), line2?.trim()].filter(Boolean);
  const street = streetParts.join(', ');
  const stateZip = [state?.trim(), zip?.trim()].filter(Boolean).join(' ');
  const cityStateZip = [city?.trim(), stateZip].filter(Boolean).join(', ');
  const fullParts = [street, cityStateZip].filter(Boolean);
  const full = fullParts.join(', ');
  return full.trim() || null;
}

/** Extract complete formatted service location string (street address, unit, city, state, zip) from lead data */
export function formatLeadServiceLocation(rawLead: any, rawCustomer?: any): string {
  if (!rawLead && !rawCustomer) return 'Service location not specified';

  // 1. Check nested service_location relation object with street address
  const loc = rawLead?.service_location || rawLead?.serviceLocation;
  if (loc && typeof loc === 'object') {
    const fromLoc = formatAddressParts(
      loc.address_line1,
      loc.address_line2,
      loc.city,
      loc.state,
      loc.zip
    );
    if (fromLoc && loc.address_line1) return fromLoc;
  }

  // 2. Check lead address scalars with street address
  const fromScalars = formatAddressParts(
    rawLead?.service_address_line1,
    rawLead?.service_address_line2,
    rawLead?.service_city,
    rawLead?.service_state,
    rawLead?.service_zip
  );
  if (fromScalars && rawLead?.service_address_line1) return fromScalars;

  // 3. Check customer service locations (from rawLead.customer or rawCustomer)
  const cust = rawLead?.customer || rawCustomer;
  const custLocs = cust?.service_locations || rawCustomer?.service_locations || rawLead?.customer_service_locations;
  if (Array.isArray(custLocs) && custLocs.length > 0) {
    // 3a. Matching service_location_id if present
    if (rawLead?.service_location_id) {
      const match = custLocs.find((l: any) => l.id === rawLead.service_location_id);
      if (match && match.address_line1) {
        const fromMatch = formatAddressParts(
          match.address_line1,
          match.address_line2,
          match.city,
          match.state,
          match.zip
        );
        if (fromMatch) return fromMatch;
      }
    }

    // 3b. Primary service location with street address
    const primary = custLocs.find((l: any) => l.is_primary) || custLocs[0];
    if (primary && primary.address_line1) {
      const fromPrimary = formatAddressParts(
        primary.address_line1,
        primary.address_line2,
        primary.city,
        primary.state,
        primary.zip
      );
      if (fromPrimary) return fromPrimary;
    }

    // 3c. Any location with address_line1
    for (const l of custLocs) {
      if (l && l.address_line1) {
        const fromAny = formatAddressParts(
          l.address_line1,
          l.address_line2,
          l.city,
          l.state,
          l.zip
        );
        if (fromAny) return fromAny;
      }
    }
  }

  // 4. Check customer billing address if street exists
  if (cust && typeof cust === 'object') {
    const fromBilling = formatAddressParts(
      cust.billing_address_line1,
      cust.billing_address_line2,
      cust.billing_city,
      cust.billing_state,
      cust.billing_zip
    );
    if (fromBilling && cust.billing_address_line1) return fromBilling;
  }

  // 5. If explicit serviceLocation string exists with complete street details (contains street numbers)
  if (typeof rawLead?.serviceLocation === 'string' && rawLead.serviceLocation.trim()) {
    const trimmed = rawLead.serviceLocation.trim();
    if (
      trimmed !== 'Service location not specified' &&
      trimmed !== 'No service location specified' &&
      /\d+/.test(trimmed)
    ) {
      return trimmed;
    }
  }

  // 6. Partial fallbacks if street address was not found anywhere
  if (loc && typeof loc === 'object') {
    const fromLoc = formatAddressParts(
      loc.address_line1,
      loc.address_line2,
      loc.city,
      loc.state,
      loc.zip
    );
    if (fromLoc) return fromLoc;
    if (loc.name) return loc.name;
  }
  if (fromScalars) return fromScalars;

  if (Array.isArray(custLocs) && custLocs.length > 0) {
    const primary = custLocs.find((l: any) => l.is_primary) || custLocs[0];
    if (primary) {
      const fromCustLoc = formatAddressParts(
        primary.address_line1,
        primary.address_line2,
        primary.city,
        primary.state,
        primary.zip
      );
      if (fromCustLoc) return fromCustLoc;
      if (primary.name) return primary.name;
    }
  }

  if (typeof rawLead?.serviceLocation === 'string' && rawLead.serviceLocation.trim()) {
    const trimmed = rawLead.serviceLocation.trim();
    if (trimmed !== 'Service location not specified' && trimmed !== 'No service location specified') {
      return trimmed;
    }
  }

  if (typeof rawLead?.service_location_name === 'string' && rawLead.service_location_name.trim()) {
    return rawLead.service_location_name.trim();
  }

  return 'Service location not specified';
}

/** Build customer + leads structure from live API records */
export function buildWatcherCustomersFromLive(
  apiLeads: any[] = [],
  apiCustomers: any[] = []
): WatcherCustomer[] {
  if ((!apiLeads || apiLeads.length === 0) && (!apiCustomers || apiCustomers.length === 0)) {
    return DEFAULT_WATCHER_CUSTOMERS;
  }

  const customerMap = new Map<string, WatcherCustomer>();

  // Map of full customer records for enriched location lookup
  const customersById = new Map<string, any>();
  if (Array.isArray(apiCustomers)) {
    for (const c of apiCustomers) {
      if (c && c.id) {
        customersById.set(c.id, c);
      }
    }
  }

  if (Array.isArray(apiLeads) && apiLeads.length > 0) {
    for (const rawLead of apiLeads) {
      const custId = rawLead.customer?.id || rawLead.customer_id || `cust-${rawLead.id}`;
      const matchedCustomer = customersById.get(custId) || rawLead.customer;
      const stageMetrics = resolveLeadStageAndElapsedTime(rawLead);
      const contactedTimestamp = rawLead.contacted_at || rawLead.contactedAt || null;

      const ownerObj =
        rawLead.commission_owner ||
        rawLead.assigned_to_user ||
        rawLead.owner ||
        (typeof rawLead.assigned_to === 'object' ? rawLead.assigned_to : null);

      const ownerId =
        rawLead.commission_owner_id ||
        (rawLead.commission_owner && typeof rawLead.commission_owner === 'object' ? rawLead.commission_owner.id : null) ||
        rawLead.assigned_to_user_id ||
        (rawLead.assigned_to_user && typeof rawLead.assigned_to_user === 'object' ? rawLead.assigned_to_user.id : null) ||
        rawLead.owner_id ||
        (typeof rawLead.assigned_to === 'string' ? rawLead.assigned_to : null) ||
        null;

      const ownerName = ownerObj
        ? `${ownerObj.first_name || ''} ${ownerObj.last_name || ''}`.trim() || ownerObj.name || ownerObj.email || null
        : null;

      const watcherLead: WatcherLead = {
        id: rawLead.id,
        leadNumber: rawLead.lead_number || `LD-${String(rawLead.id).slice(-4)}`,
        serviceRequest: rawLead.service_request || 'General Service Request',
        serviceLocation: formatLeadServiceLocation(rawLead, matchedCustomer),
        service_location_id: rawLead.service_location_id || null,
        service_location: rawLead.service_location || matchedCustomer?.service_locations?.[0] || null,
        service_address_line1: rawLead.service_address_line1 || null,
        service_address_line2: rawLead.service_address_line2 || null,
        service_city: rawLead.service_city || null,
        service_state: rawLead.service_state || null,
        service_zip: rawLead.service_zip || null,
        stageId: stageMetrics.stageId,
        stageLabel: stageMetrics.stageLabel,
        elapsedValue: stageMetrics.elapsedValue,
        elapsedUnit: stageMetrics.elapsedUnit,
        elapsedSeconds: stageMetrics.elapsedSeconds,
        createdAt: rawLead.created_at,
        contactedAt: contactedTimestamp,
        walkthroughScheduledAt: rawLead.walkthrough_scheduled_at,
        walkthroughCompletedAt: rawLead.walkthrough_completed_at,
        status: rawLead.status,
        assigned_to: ownerId,
        assigned_to_user_id: ownerId,
        commission_owner_id: ownerId,
        commission_owner: ownerObj,
        assigned_to_user: ownerObj,
        owner: ownerObj,
        assignedToName: ownerName,
      };

      if (!customerMap.has(custId)) {
        const cust = matchedCustomer || rawLead.customer || {};
        customerMap.set(custId, {
          id: custId,
          name: customerDisplayName(cust, cust.company_name || 'Customer'),
          company: cust.company_name,
          email: cust.email,
          phone: cust.phone,
          service_locations: cust.service_locations || [],
          leads: [watcherLead],
        });
      } else {
        const existing = customerMap.get(custId)!;
        existing.leads.push(watcherLead);
        if (matchedCustomer) {
          if (existing.name === 'Customer' || !existing.email || !existing.company) {
            existing.name = customerDisplayName(matchedCustomer, matchedCustomer.company_name || existing.name);
            existing.company = matchedCustomer.company_name || existing.company;
            existing.email = matchedCustomer.email || existing.email;
            existing.phone = matchedCustomer.phone || existing.phone;
          }
          if ((!existing.service_locations || existing.service_locations.length === 0) && matchedCustomer.service_locations) {
            existing.service_locations = matchedCustomer.service_locations;
          }
        }
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
          service_locations: cust.service_locations || [],
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
        if ((!existing.service_locations || existing.service_locations.length === 0) && cust.service_locations) {
          existing.service_locations = cust.service_locations;
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
  assignments: SpiderAssignmentsConfig;
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
  setAssignments: (
    updater:
      | SpiderAssignmentsConfig
      | ((prev: SpiderAssignmentsConfig) => SpiderAssignmentsConfig)
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
  dispatchedAlertKeys: string[];
  dispatchOverdueAlerts: () => Promise<void>;

  getComputedNotifications: (user?: { id?: string; role?: string } | null) => InAppNotification[];
}

export const useSpiderWatcherStore = create<SpiderWatcherState>()(
  persist(
    (set, get) => ({
      notifications: {
        email: true,
        sms: true,
        inApp: true,
        redFrame: true,
      },
      assignments: DEFAULT_ASSIGNMENTS_CONFIG,
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

      setAssignments: (updater) =>
        set((state) => ({
          assignments: typeof updater === 'function' ? updater(state.assignments) : updater,
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
          if (!customers || customers.length === 0) return {};
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
          const validCustomerIds =
            state.selectedCustomerIds.length > 0
              ? state.selectedCustomerIds
              : allCustomerIds;
          const validLeadIds =
            state.selectedLeadIds.length > 0
              ? state.selectedLeadIds
              : allLeadIds;

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
        }),

      setIsRedBorderActive: (active) => set({ isRedBorderActive: active }),
      setIsWindowOpen: (open) => set({ isWindowOpen: open }),
      toggleRedBorder: () => set((state) => ({ isRedBorderActive: !state.isRedBorderActive })),
      clearRedBorder: () => set({ isRedBorderActive: false }),

      getComputedNotifications: (user) => {
        const state = get();
        const result: InAppNotification[] = [];

        if (
          !state.customers ||
          state.customers.length === 0 ||
          !state.selectedLeadIds ||
          state.selectedLeadIds.length === 0
        ) {
          return result;
        }

        const assignments = state.assignments;
        const hasAdminRoles = Array.isArray(assignments?.adminRoles) && assignments.adminRoles.length > 0;
        const hasUsers = Array.isArray(assignments?.users) && assignments.users.length > 0;
        const hasOwner = !!assignments?.owner;

        // If nothing is selected in Admin role, User, or Owner, NO notifications are generated
        if (!hasAdminRoles && !hasUsers && !hasOwner) {
          return result;
        }

        for (const customer of state.customers) {
          if (!customer.leads || customer.leads.length === 0) continue;
          for (const lead of customer.leads) {
            const isSelected = state.selectedLeadIds.includes(lead.id);
            if (!isSelected) continue;

            // Check if user is an assigned recipient for this lead's notification
            const isAssigned = isUserAssignedToSpiderAlert(assignments, lead, user);
            if (!isAssigned) continue;

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

              let timeAgoStr = `${lead.elapsedValue} ${lead.elapsedUnit}${lead.elapsedValue > 1 ? 's' : ''}`;
              if (leadSecs >= 86400) {
                timeAgoStr = `${Math.floor(leadSecs / 86400)}d ago`;
              } else if (leadSecs >= 3600) {
                timeAgoStr = `${Math.floor(leadSecs / 3600)}h ago`;
              } else if (leadSecs >= 60) {
                timeAgoStr = `${Math.floor(leadSecs / 60)}m ago`;
              } else {
                timeAgoStr = `${leadSecs}s ago`;
              }

              const stageName = formatCurrentStageName(lead.stageLabel || lead.stageId);
              const dynamicLocation = formatLeadServiceLocation(lead, customer);
              const resolvedLoc =
                dynamicLocation && dynamicLocation !== 'Service location not specified'
                  ? dynamicLocation
                  : (lead.serviceLocation || 'Service location not specified');
              const lastCommMessage = formatLeadLastCommunication(lead.contactedAt, lead.createdAt);

              result.push({
                id: notifId,
                contactName: customer.name,
                companyName: customer.company || customer.name,
                inactiveDays: Math.floor(leadSecs / 86400),
                message: lastCommMessage,
                timeAgo: timeAgoStr,
                read: false,
                contactId: customer.id,
                leadId: lead.id,
                leadNumber: lead.leadNumber,
                leadStage: stageName,
                serviceRequest: lead.serviceRequest,
                serviceLocation: resolvedLoc,
                contactedAt: lead.contactedAt || null,
                createdAt: lead.createdAt || null,
                lastCommunication: lastCommMessage,
                isTriggered: true,
                assignedTo: lead.assignedToName || getSpiderLeadOwnerName(lead) || null,
                assignedToId: getSpiderLeadOwnerId(lead) || null,
              });
            }
          }
        }

        return result;
      },

      dispatchedAlertKeys: [],

      dispatchOverdueAlerts: async () => {
        const state = get();
        const {
          notifications,
          assignments,
          leadStages,
          customers,
          selectedLeadIds,
          readNotificationIds,
          dispatchedAlertKeys,
        } = state;

        if (!notifications.email && !notifications.sms) {
          return;
        }

        const newDispatchedKeys: string[] = [];

        for (const customer of customers) {
          if (!customer.leads || customer.leads.length === 0) continue;
          for (const lead of customer.leads) {
            if (!selectedLeadIds.includes(lead.id)) continue;

            const overdue = isLeadOverdue(lead, leadStages);
            const notifId = `notif-${lead.id}`;
            const isRead =
              readNotificationIds.includes(notifId) || readNotificationIds.includes(lead.id);

            if (overdue && !isRead) {
              const stageName = formatCurrentStageName(lead.stageLabel || lead.stageId);
              // Cooldown bucket (30 minutes)
              const bucket = Math.floor(Date.now() / 1800000);
              const dispatchKey = `${lead.id}:${stageName}:${bucket}`;

              if (
                dispatchedAlertKeys.includes(dispatchKey) ||
                newDispatchedKeys.includes(dispatchKey)
              ) {
                continue;
              }

              newDispatchedKeys.push(dispatchKey);

              // Background dispatch
              dispatchSpiderAlertApi({
                leadId: lead.id,
                stageLabel: stageName,
                elapsedValue: lead.elapsedValue,
                elapsedUnit: lead.elapsedUnit,
                elapsedSeconds: lead.elapsedSeconds,
                assignments: {
                  adminRoles: assignments.adminRoles || [],
                  users: assignments.users || [],
                  owner: !!assignments.owner,
                },
                notifications: {
                  email: !!notifications.email,
                  sms: !!notifications.sms,
                  inApp: !!notifications.inApp,
                  redFrame: !!notifications.redFrame,
                },
              }).catch((err) =>
                console.warn('[Spider Watcher] Dispatch error:', err)
              );
            }
          }
        }

        if (newDispatchedKeys.length > 0) {
          set({
            dispatchedAlertKeys: [...dispatchedAlertKeys, ...newDispatchedKeys].slice(-200),
          });
        }
      },
    }),
    {
      name: 'servwave_spider_watcher_settings',
      partialize: (state) => ({
        notifications: state.notifications,
        assignments: state.assignments,
        leadStages: state.leadStages,
        customers: state.customers,
        selectedCustomerIds: state.selectedCustomerIds,
        selectedLeadIds: state.selectedLeadIds,
        hasUserModifiedSelection: state.hasUserModifiedSelection,
        days: state.days,
        inAppNotifications: state.inAppNotifications,
        readNotificationIds: state.readNotificationIds,
        activeNotificationId: state.activeNotificationId,
        isRedBorderActive: state.isRedBorderActive,
      }),
    }
  )
);

/** Hook to sync real live API customers and leads into the Spider Watcher store */
export function useSyncSpiderWatcherLive() {
  const setCustomers = useSpiderWatcherStore((s) => s.setCustomers);
  const dispatchOverdueAlerts = useSpiderWatcherStore((s) => s.dispatchOverdueAlerts);

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
    if ((leads && leads.length > 0) || (customers && customers.length > 0)) {
      const live = buildWatcherCustomersFromLive(leads || [], customers || []);
      if (live && live.length > 0 && live !== DEFAULT_WATCHER_CUSTOMERS) {
        setCustomers(live);
      }
    }
  }, [leads, customers, setCustomers]);

  // Periodic alert check & dispatch for Email/SMS when enabled
  useEffect(() => {
    dispatchOverdueAlerts();
    const interval = setInterval(() => {
      dispatchOverdueAlerts();
    }, 60_000);
    return () => clearInterval(interval);
  }, [dispatchOverdueAlerts]);
}
