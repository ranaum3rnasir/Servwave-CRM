/**
 * recipients.ts — the audience resolver: the single source of truth for
 * "who does each recipient audience mean, for THIS record."
 *
 * The v2.1 recipient model is a multi-select over named audiences (customer,
 * assigned crew/performers, dispatcher, salesperson, creator, roles, a specific
 * person, a custom email). This module answers three questions and nothing else:
 *   • audiencesForEntity(entity) → which audiences are even offered here
 *   • audienceLabel(key, entity) → the plain-English name we show for one
 *   • resolveAudience(key, ctx)  → the concrete users/emails for one, per record
 *
 * CORRECTNESS CONTRACT: resolveAudience NEVER throws and NEVER silently sends to
 * nobody. Every empty path returns a plain-English `skipReason` (product copy —
 * it renders in the Activity tab), never an exception. Legacy stored configs may
 * still carry the old `'assigned_techs'` key; it is accepted as an exact alias of
 * `'assigned_team'`.
 *
 * Task 18 populates the ctx people from the ExecutionBundle; Task 19 wires this
 * into executeAction; Task 20 renders the multi-select from audiencesForEntity.
 */

import { prisma } from '../../lib/prisma';
import type { RecipientUser } from './executors';

export type RecipientKey =
  | 'customer'
  | 'assigned_team'
  | 'dispatcher'
  | 'salesperson'
  | 'creator'
  | 'all_admins'
  | 'all_dispatchers'
  | 'specific_user'
  | 'custom'
  /**
   * The person the triggering event removed — not derivable from the live
   * entity (they're off the crew/team by the time the automation runs), so
   * this resolves from ctx.eventRecipient rather than a DB lookup. Legal only
   * for the two REMOVED triggers (TECH_UNASSIGNED, WALKTHROUGH_PERFORMER_REMOVED) —
   * added there directly in catalog.ts's audiencesFor, not via audiencesForEntity,
   * since it's a trigger-specific offering, not an entity-wide one.
   */
  | 'removed_user'
  /**
   * The mirror of removed_user: the person the triggering event just added.
   * TECH_ASSIGNED / WALKTHROUGH_PERFORMER_ASSIGNED dispatch once PER newly-added
   * person, but `assigned_team` resolves to the live FULL crew/team — using it
   * here would re-notify everyone already on the job/walkthrough every time one
   * more person joins. Resolves from the same ctx.eventRecipient field as
   * removed_user (the field is generic; its meaning comes from which event
   * populated it). Legal only for the two ASSIGNED triggers (TECH_ASSIGNED,
   * WALKTHROUGH_PERFORMER_ASSIGNED) — see catalog.ts's audiencesFor.
   */
  | 'assigned_user';

/** Old stored/folded configs may still carry this — accepted as an alias of assigned_team. */
type LegacyRecipientKey = 'assigned_techs';

export type AudienceEntity = 'job' | 'estimate' | 'invoice' | 'lead';

/** Everything resolveAudience needs, built from the ExecutionBundle by Task 19. */
export interface AudienceContext {
  organizationId: string;
  entity: AudienceEntity;
  /**
   * `extra_emails` is the customer's secondary addresses ALREADY narrowed to the
   * opted-in ones (`receives_emails: true`) by the context.ts query. Filtering there
   * rather than here means an opted-out address cannot reach an executor even if some
   * future caller assembles this ctx by hand. Shape mirrors the Prisma row so
   * context.ts stays a pass-through.
   */
  customer?: { id: string; email: string | null; extra_emails?: { email: string }[] | null } | null;
  assignees: RecipientUser[]; // job crew OR walkthrough performers
  dispatcher?: RecipientUser | null;
  salesperson?: RecipientUser | null;
  creator?: RecipientUser | null;
  /** For 'removed_user' — sourced from the enrollment's event_payload (context.ts), not a live lookup. */
  eventRecipient?: RecipientUser | null;
  userId?: string; // for 'specific_user'
  customEmails?: string[]; // for 'custom'
}

export interface ResolvedAudience {
  users: RecipientUser[];
  emails: string[];
  skipReason?: string;
}

// ── which audiences each entity offers (per Ran's decisions) ────────────────
// `custom` is intentionally absent — it's added only for SEND_EMAIL, at
// validation time in Task 19, not here.
const AUDIENCES: Record<AudienceEntity, RecipientKey[]> = {
  job: ['customer', 'assigned_team', 'dispatcher', 'salesperson', 'all_admins', 'all_dispatchers', 'specific_user'],
  lead: ['customer', 'assigned_team', 'salesperson', 'all_admins', 'all_dispatchers', 'specific_user'],
  estimate: ['customer', 'creator', 'salesperson', 'all_admins', 'all_dispatchers', 'specific_user'],
  invoice: ['customer', 'all_admins', 'all_dispatchers', 'specific_user'],
};

export function audiencesForEntity(entity: AudienceEntity): RecipientKey[] {
  // Fresh copy so callers can't mutate the shared source of truth.
  return [...AUDIENCES[entity]];
}

// ── plain-English label for one audience (differs per entity where it matters) ─
export function audienceLabel(key: RecipientKey, entity: AudienceEntity): string {
  switch (key) {
    case 'customer':
      return 'the customer';
    case 'assigned_team':
      return entity === 'lead' ? 'the walkthrough team' : 'the assigned crew';
    case 'dispatcher':
      return 'the dispatcher';
    case 'salesperson':
      return 'the salesperson';
    case 'creator':
      return 'the creator';
    case 'all_admins':
      return 'all admins';
    case 'all_dispatchers':
      return 'all dispatchers';
    case 'specific_user':
      return 'a specific person';
    case 'custom':
      return 'a custom email';
    case 'removed_user':
      return entity === 'lead' ? 'the removed performer' : 'the removed technician';
    case 'assigned_user':
      return entity === 'lead' ? 'the assigned performer' : 'the assigned technician';
  }
}

// ── resolve one audience to concrete users/emails for THIS record ───────────
export async function resolveAudience(
  key: RecipientKey | LegacyRecipientKey,
  ctx: AudienceContext,
): Promise<ResolvedAudience> {
  // Fold the legacy alias so everything downstream sees the canonical key.
  const k: RecipientKey = key === 'assigned_techs' ? 'assigned_team' : key;

  switch (k) {
    case 'customer': {
      // Primary first, then each opted-in secondary address. Deduped on a trimmed,
      // lower-cased key (the same address can legitimately be typed into both the
      // primary field and an extra row) while the ORIGINAL casing is what we send to.
      const seen = new Set<string>();
      const emails: string[] = [];
      for (const raw of [ctx.customer?.email, ...(ctx.customer?.extra_emails ?? []).map((e) => e.email)]) {
        const value = raw?.trim();
        if (!value) continue;
        const key = value.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        emails.push(value);
      }
      return emails.length > 0
        ? { users: [], emails }
        : { users: [], emails: [], skipReason: 'The customer has no email address on file' };
    }

    case 'assigned_team': {
      if (ctx.assignees.length > 0) return { users: ctx.assignees, emails: [] };
      return {
        users: [],
        emails: [],
        skipReason:
          ctx.entity === 'lead' ? 'No walkthrough team is assigned yet' : 'No one is assigned to this job yet',
      };
    }

    case 'dispatcher':
      return ctx.dispatcher
        ? { users: [ctx.dispatcher], emails: [] }
        : { users: [], emails: [], skipReason: 'No dispatcher is assigned to this job' };

    case 'salesperson':
      return ctx.salesperson
        ? { users: [ctx.salesperson], emails: [] }
        : { users: [], emails: [], skipReason: 'No salesperson is assigned' };

    case 'creator':
      return ctx.creator
        ? { users: [ctx.creator], emails: [] }
        : { users: [], emails: [], skipReason: 'This record has no creator on file' };

    case 'all_admins':
    case 'all_dispatchers': {
      const role = k === 'all_admins' ? 'ADMIN' : 'DISPATCHER';
      const users = await prisma.user.findMany({
        where: { organization_id: ctx.organizationId, role, is_active: true },
        select: { id: true, email: true, first_name: true, last_name: true },
      });
      if (users.length === 0) {
        return {
          users: [],
          emails: [],
          skipReason: `No active ${role === 'ADMIN' ? 'admins' : 'dispatchers'} to notify`,
        };
      }
      return { users, emails: [] };
    }

    case 'specific_user': {
      if (!ctx.userId) return { users: [], emails: [], skipReason: 'No team member was chosen' };
      const user = await prisma.user.findFirst({
        where: { id: ctx.userId, organization_id: ctx.organizationId, is_active: true },
        select: { id: true, email: true, first_name: true, last_name: true },
      });
      return user
        ? { users: [user], emails: [] }
        : { users: [], emails: [], skipReason: 'That team member is no longer available' };
    }

    case 'custom': {
      const emails = ctx.customEmails ?? [];
      return emails.length > 0
        ? { users: [], emails }
        : { users: [], emails: [], skipReason: 'No email address was configured' };
    }

    case 'removed_user':
      return ctx.eventRecipient
        ? { users: [ctx.eventRecipient], emails: [] }
        : { users: [], emails: [], skipReason: 'No removed team member was captured for this run' };

    case 'assigned_user':
      return ctx.eventRecipient
        ? { users: [ctx.eventRecipient], emails: [] }
        : { users: [], emails: [], skipReason: 'No assigned team member was captured for this run' };
  }
}
