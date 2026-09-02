/**
 * spiderAlerts.ts — Backend service for resolving Spider Agent alert recipients.
 *
 * Routing rules for Spider Agent Watcher:
 * 1. If Admin roles are selected, alerts are sent to all users with those selected roles.
 * 2. If Owner is selected, alerts are sent to the owner of the lead selected in the Watcher section.
 * 3. If both Admin roles and Owner are selected, the alert is sent to both (union & de-duplicated).
 * 4. If explicit user IDs are specified, they are also included in the recipient set.
 */

export interface SpiderAssignmentSettings {
  adminRoles?: string[]; // e.g. ['ADMIN', 'SALES', 'DISPATCHER', 'TECHNICIAN']
  owner?: boolean; // toggle to notify assigned lead owner
  users?: string[]; // specific user IDs
}

export interface SpiderLeadEntity {
  id: string;
  assigned_to?: string | null;
  assigned_to_user_id?: string | null;
  owner_id?: string | null;
  commission_owner_id?: string | null;
  lead_number?: string | null;
}

export interface SpiderRoleHolders {
  ADMIN: string[];
  SALES: string[];
  DISPATCHER: string[];
  TECHNICIAN: string[];
  [customRole: string]: string[];
}

export interface ResolveSpiderRecipientsOptions {
  assignments: SpiderAssignmentSettings;
  lead: SpiderLeadEntity;
  roleHolders: SpiderRoleHolders;
}

/**
 * Resolves the final de-duplicated list of recipient user IDs for a Spider alert.
 */
export function resolveSpiderAlertRecipients(options: ResolveSpiderRecipientsOptions): string[] {
  const { assignments, lead, roleHolders } = options;
  const recipients = new Set<string>();

  // 1. Admin roles: Include all users holding the selected roles
  if (Array.isArray(assignments.adminRoles) && assignments.adminRoles.length > 0) {
    for (const roleKey of assignments.adminRoles) {
      const usersInRole = roleHolders[roleKey] || [];
      for (const userId of usersInRole) {
        if (userId) recipients.add(userId);
      }
    }
  }

  // Explicit user IDs if any
  if (Array.isArray(assignments.users) && assignments.users.length > 0) {
    for (const userId of assignments.users) {
      if (userId) recipients.add(userId);
    }
  }

  // 2. Owner: Include the owner of the lead
  if (assignments.owner) {
    const ownerId =
      lead.assigned_to ||
      lead.assigned_to_user_id ||
      lead.owner_id ||
      lead.commission_owner_id;

    if (ownerId) {
      recipients.add(ownerId);
    }
  }

  // 3. If both are selected, Set automatically holds the union of both
  return Array.from(recipients);
}
