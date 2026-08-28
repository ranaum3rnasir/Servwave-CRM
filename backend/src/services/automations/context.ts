/**
 * context.ts — entity loading + merge-context building for automation runs.
 *
 * One org-scoped fetch per entity type, producing:
 *  - the ExecutionBundle the executor consumes (customer, assignees, merge ctx)
 *  - an EntityState snapshot the engine's staleness checks read
 * All dates render in the ORG's timezone; money in the org's currency, full
 * comma-grouped (design-system rule — never k/M abbreviations).
 */

import { prisma } from '../../lib/prisma';
import { env } from '../../config/env';
import { DEFAULT_TIMEZONE } from '../../lib/timezone';
import { isLiveVisit } from '../../lib/visit-status';
import { resolveCurrentWalkthrough, resolveNextJobVisit } from '../walkthrough.service';
import type { ExecutionBundle, RecipientUser } from './executors';

export interface EntityState {
  jobStatus?: string;
  jobScheduledStart?: Date | null;
  jobCompletedAt?: Date | null;
  invoiceStatus?: string;
  invoiceAmountDue?: number;
  invoiceDueDate?: Date | null;
  estimateStatus?: string;
  estimateValidUntil?: Date | null;
  leadStatus?: string;
  leadWalkthroughScheduledAt?: Date | null;
  // Walkthrough-as-entity redesign, PR-B2: the CURRENT visit's (D15) own status - REQUESTED |
  // SCHEDULED | COMPLETED | CANCELLED. terminalStale.ts's WALKTHROUGH_SCHEDULED/_RESCHEDULED
  // and LEAD_DATE_ANCHORED('before') staleness guards key off THIS, not leadStatus - after
  // this redesign, scheduleWalkthrough only ever advances a NEW lead to CONTACTED (D5), so
  // lead.status is no longer a reliable "is a visit currently scheduled" signal.
  leadVisitStatus?: string | null;
  // ── Lead stage clocks (spec #1751 D8) ────────────────────────────────────
  // Read by anchorDateFor for the three new lead anchors, and by terminalStale's
  // "…and it still has not happened" guard, which needs the NEXT clock along to decide whether
  // the thing the owner was waiting for has since occurred. Both halves have to see the same
  // snapshot, which is why they are loaded here rather than re-queried at either site.
  leadCreatedAt?: Date | null;
  leadContactedAt?: Date | null;
  leadWalkthroughFirstBookedAt?: Date | null;
  leadLastVisitCompletedAt?: Date | null;
  leadFirstEstimateSentAt?: Date | null;
}

export interface LoadedExecution {
  bundle: ExecutionBundle;
  state: EntityState;
}

interface OrgRow {
  name: string;
  phone: string | null;
  timezone: string | null;
  currency: string;
  logo_url: string | null;
  brand_color: string;
}

function money(amount: unknown, currency: string): string {
  const n = Number(amount ?? 0);
  return new Intl.NumberFormat('en-US', { style: 'currency', currency }).format(n);
}

function fmtDate(date: Date | null | undefined, timeZone: string): string {
  if (!date) return '';
  try {
    return new Intl.DateTimeFormat('en-US', {
      weekday: 'short', month: 'short', day: 'numeric', timeZone,
    }).format(date);
  } catch {
    return new Intl.DateTimeFormat('en-US', {
      weekday: 'short', month: 'short', day: 'numeric', timeZone: DEFAULT_TIMEZONE,
    }).format(date);
  }
}

function fmtTime(date: Date | null | undefined, timeZone: string): string {
  if (!date) return '';
  try {
    return new Intl.DateTimeFormat('en-US', { hour: 'numeric', minute: '2-digit', timeZone }).format(date);
  } catch {
    return new Intl.DateTimeFormat('en-US', { hour: 'numeric', minute: '2-digit', timeZone: DEFAULT_TIMEZONE }).format(date);
  }
}

/**
 * Multi-visit D18: the merge fields a VISIT-scoped occurrence overrides on its parent job.
 *
 * The job branch below renders `job.scheduled_date` / `job.scheduled_time` off
 * Job.scheduled_start, which under D14 is a MIRROR of the job's next upcoming visit - so a
 * workflow enrolled by visit 3 would tell the customer visit 2's date, and `technician.names`
 * would name the job-level union rather than the crew going on that trip. The enrollment is
 * visit-scoped (dedupe.ts); this is what makes what it SENDS visit-scoped too.
 *
 * Written by the dispatching controller into event_payload.mergeFields, which is persisted on the
 * enrollment and re-applied on EVERY step load - so the override survives however many WAIT steps
 * sit before the send. The same channel `event.reason` already travels on.
 *
 * NOT the whole of D18: EntityState (and so the BEFORE_JOB_START anchored wait) is still resolved
 * per ENTITY, so a per-visit wait still anchors on the job's OWN next-live-visit resolution
 * (S8 §2 / A4: resolveNextJobVisit over the live set below), never the triggering visit. That
 * half needs the visit id persisted on the enrollment and is deliberately not smuggled in
 * through a string bag.
 */
export function visitMergeFields(
  visit: { scheduled_at?: Date | null },
  crew: { first_name: string; last_name: string }[],
  timeZone: string,
): Record<string, string> {
  const names = crew.map((u) => `${u.first_name} ${u.last_name}`.trim()).filter(Boolean);
  return {
    'job.scheduled_date': fmtDate(visit.scheduled_at ?? null, timeZone),
    'job.scheduled_time': fmtTime(visit.scheduled_at ?? null, timeZone),
    'technician.first_name': crew[0]?.first_name ?? '',
    // Matches the hard-coded email path (job.controller.ts sendJobVisitScheduledEmail /
    // lead.controller.ts): an empty crew says "our team" rather than naming nobody, so a
    // seeded template's "Who's coming: {{technician.names}}." never renders "coming: .".
    'technician.names': names.join(', ') || 'Our team',
  };
}

interface CustomerRow {
  id: string;
  first_name: string | null;
  last_name: string | null;
  email: string | null;
  phone: string | null;
  /** Opted-in secondary addresses only — narrowed by CUSTOMER_INCLUDE, see below. */
  extra_emails?: { email: string }[];
}

/**
 * The customer include shared by every entity branch below. `extra_emails` is narrowed
 * to the addresses opted in to automated mail (`customer_emails.receives_emails`) — the
 * opt-out is enforced HERE, in the query, so an opted-out address can never reach an
 * executor no matter what the downstream code does with the bundle.
 * -> recipients.ts, the `customer` audience.
 */
const CUSTOMER_INCLUDE = {
  include: { extra_emails: { where: { receives_emails: true }, select: { email: true } } },
};

function customerCtx(c: CustomerRow | null | undefined): Record<string, string> {
  if (!c) return { 'customer.first_name': '', 'customer.last_name': '', 'customer.full_name': '' };
  const full = [c.first_name, c.last_name].filter(Boolean).join(' ');
  return {
    'customer.first_name': c.first_name ?? '',
    'customer.last_name': c.last_name ?? '',
    'customer.full_name': full,
  };
}

/**
 * Anything the triggering event captured that the live entity can't reproduce
 * later — persisted on the enrollment as event_payload, read back in on
 * EVERY step (so it survives a WAIT of any length, unlike a one-time entity
 * load). `mergeFields` are free-form (e.g. `event.reason`); `recipient` feeds
 * ExecutionBundle.eventRecipient for the removed_user audience (recipients.ts).
 */
export interface EventPayload {
  mergeFields?: Record<string, string>;
  recipient?: RecipientUser | null;
}

export async function loadExecutionBundle(args: {
  entityType: string;
  entityId: string;
  entityLabel?: string | null;
  organizationId: string;
  dedupeKey: string;
  eventPayload?: EventPayload | null;
}): Promise<LoadedExecution | null> {
  const loaded = await loadEntityBundle(args);
  if (!loaded) return null;
  return {
    ...loaded,
    bundle: {
      ...loaded.bundle,
      eventRecipient: args.eventPayload?.recipient ?? null,
      mergeCtx: { ...loaded.bundle.mergeCtx, ...args.eventPayload?.mergeFields },
    },
  };
}

async function loadEntityBundle(args: {
  entityType: string;
  entityId: string;
  entityLabel?: string | null;
  organizationId: string;
  dedupeKey: string;
}): Promise<LoadedExecution | null> {
  const org = (await prisma.organization.findUnique({
    where: { id: args.organizationId },
    select: { name: true, phone: true, timezone: true, currency: true, logo_url: true, brand_color: true },
  })) as OrgRow | null;
  if (!org) return null;

  const tz = org.timezone || DEFAULT_TIMEZONE;
  const orgCtx: Record<string, string> = {
    'org.name': org.name,
    'org.phone': org.phone ?? '',
  };

  const base: Omit<ExecutionBundle, 'entityRef' | 'customer' | 'assignees' | 'mergeCtx' | 'jobRef'> = {
    organizationId: args.organizationId,
    org: { name: org.name, timezone: tz, logo_url: org.logo_url, brand_color: org.brand_color },
    dedupeKey: args.dedupeKey,
  };

  switch (args.entityType) {
    case 'job': {
      const job = await prisma.job.findFirst({
        where: { id: args.entityId, organization_id: args.organizationId },
        include: {
          customer: CUSTOMER_INCLUDE,
          service_location: true,
          sub_status: { select: { label: true } },
          // S8 (D6): crew through the trips.
          visits: { include: { assignees: { include: { user: { select: { id: true, email: true, first_name: true, last_name: true } } } } } },
          dispatcher: { select: { id: true, email: true, first_name: true, last_name: true } },
          salesperson: { select: { id: true, email: true, first_name: true, last_name: true } },
          // Salesperson fallback path (job.salesperson_id unset): job → estimate → lead → commission_owner.
          estimate: {
            select: {
              lead: {
                select: { commission_owner: { select: { id: true, email: true, first_name: true, last_name: true } } },
              },
            },
          },
        },
      });
      if (!job) return null;
      // S8 (D6): deduped union across the job's trips - a person on two trips is one recipient.
      const seen = new Set<string>();
      const assignees: RecipientUser[] = [];
      for (const v of job.visits ?? []) {
        for (const a of v.assignees ?? []) {
          if (seen.has(a.user.id)) continue;
          seen.add(a.user.id);
          assignees.push(a.user);
        }
      }
      // S8 §2 (A4, RATIFIED): the anchored-WAIT resolver moves OFF the Job.scheduled_start
      // mirror and onto the same LIVE-visit resolution syncJobFromVisits uses to WRITE that
      // mirror (walkthrough.service.ts's resolveNextJobVisit, called on the isLiveVisit subset -
      // exactly as syncJobFromVisits itself does), so anchorDateFor() and the
      // job.scheduled_date/_time merge fields below read the job's next upcoming live visit
      // fresh rather than trusting a column that is only ever correct between writes.
      // context.ts has no per-visit context on the enrollment (see visitMergeFields above), so
      // this stays a per-JOB resolution, not the specific visit that triggered enrollment.
      // A job with no live visits (none booked, all cancelled, or - per resolveNextJobVisit's
      // own fallback - all elapsed and unactioned) resolves nextVisit to null exactly like the
      // mirror does once D16's collapse applies.
      const nextVisit = resolveNextJobVisit((job.visits ?? []).filter(isLiveVisit));
      const loc = job.service_location;
      const address = loc ? [loc.address_line1, loc.city, loc.state].filter(Boolean).join(', ') : '';
      const techNames = assignees.map((u) => [u.first_name, u.last_name].filter(Boolean).join(' ')).join(', ');
      return {
        bundle: {
          ...base,
          entityRef: { type: 'job', id: job.id, label: job.job_number },
          customer: job.customer,
          assignees,
          dispatcher: job.dispatcher ?? null,
          salesperson: job.salesperson ?? job.estimate?.lead?.commission_owner ?? null,
          jobRef: { id: job.id, label: job.job_number },
          mergeCtx: {
            ...orgCtx,
            ...customerCtx(job.customer),
            'job.number': job.job_number,
            'job.scheduled_date': fmtDate(nextVisit?.scheduled_at ?? null, tz),
            'job.scheduled_time': fmtTime(nextVisit?.scheduled_at ?? null, tz),
            'job.address': address,
            'job.type': job.job_type ?? '',
            'job.scope_notes': job.scope_notes ?? '',
            'technician.first_name': assignees[0]?.first_name ?? '',
            // Same fallback as visitMergeFields above / the hard-coded email path: no
            // assignees on the job's trips must say "our team", not render a bare "".
            'technician.names': techNames || 'Our team',
            'job.sub_status': job.sub_status?.label ?? '',
          },
        },
        state: { jobStatus: job.status, jobScheduledStart: nextVisit?.scheduled_at ?? null, jobCompletedAt: job.completed_at },
      };
    }

    case 'estimate': {
      const estimate = await prisma.estimate.findFirst({
        where: { id: args.entityId, organization_id: args.organizationId },
        include: {
          // SERV10X-61 - direct anchor (R6) so a lead-less estimate resolves its customer for
          // automation merge fields; falls back through the lead for lead-anchored rows.
          customer: CUSTOMER_INCLUDE,
          lead: {
            include: {
              customer: CUSTOMER_INCLUDE,
              commission_owner: { select: { id: true, email: true, first_name: true, last_name: true } },
            },
          },
          creator: { select: { id: true, email: true, first_name: true, last_name: true } },
        },
      });
      if (!estimate) return null;
      const customer = estimate.lead?.customer ?? estimate.customer ?? null;
      const link = estimate.public_token
        ? `${env.FRONTEND_URL}/p/estimates/${estimate.id}?token=${estimate.public_token}`
        : '';
      return {
        bundle: {
          ...base,
          entityRef: { type: 'estimate', id: estimate.id, label: estimate.estimate_number },
          customer,
          assignees: [],
          creator: estimate.creator ?? null,
          salesperson: estimate.lead?.commission_owner ?? null,
          jobRef: null,
          mergeCtx: {
            ...orgCtx,
            ...customerCtx(customer),
            'estimate.number': estimate.estimate_number,
            'estimate.total': money(estimate.total_amount, org.currency),
            'estimate.link': link,
          },
        },
        state: { estimateStatus: estimate.status, estimateValidUntil: estimate.valid_until ?? null },
      };
    }

    case 'invoice': {
      const invoice = await prisma.invoice.findFirst({
        where: { id: args.entityId, organization_id: args.organizationId },
        include: { customer: CUSTOMER_INCLUDE, job: { select: { id: true, job_number: true } } },
      });
      if (!invoice) return null;
      const link = invoice.public_token
        ? `${env.FRONTEND_URL}/p/invoices/${invoice.id}?token=${invoice.public_token}`
        : '';
      return {
        bundle: {
          ...base,
          entityRef: { type: 'invoice', id: invoice.id, label: invoice.invoice_number },
          customer: invoice.customer,
          assignees: [],
          jobRef: invoice.job ? { id: invoice.job.id, label: invoice.job.job_number } : null,
          mergeCtx: {
            ...orgCtx,
            ...customerCtx(invoice.customer),
            'invoice.number': invoice.invoice_number,
            'invoice.total': money(invoice.total_amount, org.currency),
            'invoice.due_date': fmtDate(invoice.due_date, tz),
            'invoice.link': link,
          },
        },
        state: { invoiceStatus: invoice.status, invoiceAmountDue: Number(invoice.amount_due), invoiceDueDate: invoice.due_date ?? null },
      };
    }

    case 'lead': {
      const lead = await prisma.lead.findFirst({
        where: { id: args.entityId, organization_id: args.organizationId },
        include: {
          customer: CUSTOMER_INCLUDE,
          // Walkthrough-as-entity redesign, PR-B2 (D15): merge fields lead.walkthrough_date/
          // _time/performer_names, and the leadWalkthroughScheduledAt staleness state, resolve
          // against the lead's CURRENT visit - the next upcoming SCHEDULED one; else the most
          // recent one that happened (completed or cancelled) - not the legacy flat columns,
          // which mixed data across visits once a lead could have more than one.
          visits: {
            select: {
              id: true, status: true, scheduled_at: true, duration_minutes: true,
              completed_at: true, cancelled_at: true, cancelled_reason: true, cancelled_by: true,
              customer_email_sent_at: true, notes: true, created_at: true,
              assignees: {
                include: { user: { select: { id: true, email: true, first_name: true, last_name: true } } },
              },
            },
          },
          commission_owner: { select: { id: true, email: true, first_name: true, last_name: true } },
          service_location: true,
        },
      });
      if (!lead) return null;
      const customerName = lead.customer
        ? [lead.customer.first_name, lead.customer.last_name].filter(Boolean).join(' ')
        : '';
      const request = (lead.service_request ?? '').slice(0, 60);
      const currentVisit = resolveCurrentWalkthrough(lead.visits);
      const assignees: RecipientUser[] = (currentVisit?.assignees ?? []).map(
        (p: { user: RecipientUser }) => p.user,
      );
      const performerNames = assignees.map((u) => [u.first_name, u.last_name].filter(Boolean).join(' ')).join(', ');
      return {
        bundle: {
          ...base,
          entityRef: { type: 'lead', id: lead.id, label: lead.lead_number },
          customer: lead.customer,
          assignees,
          salesperson: lead.commission_owner ?? null,
          jobRef: null,
          mergeCtx: {
            ...orgCtx,
            ...customerCtx(lead.customer),
            'lead.name': request ? `${customerName} — ${request}` : customerName,
            'lead.number': lead.lead_number,
            // Same shape as job.address — the walkthrough emails these automations
            // replace told the customer where to be.
            'lead.address': lead.service_location
              ? [lead.service_location.address_line1, lead.service_location.city, lead.service_location.state]
                  .filter(Boolean)
                  .join(', ')
              : '',
            'lead.walkthrough_date': fmtDate(currentVisit?.scheduled_at ?? null, tz),
            'lead.walkthrough_time': fmtTime(currentVisit?.scheduled_at ?? null, tz),
            'lead.performer_names': performerNames,
          },
        },
        state: {
          leadStatus: lead.status,
          leadWalkthroughScheduledAt: currentVisit?.scheduled_at ?? null,
          leadVisitStatus: currentVisit?.status ?? null,
          // Straight off the lead row (this loader uses `include`, so every scalar is already
          // here). Note these are the STORED clocks, not the current-visit projection above:
          // leadWalkthroughScheduledAt moves both ways with the visit set by design, whereas
          // leadLastVisitCompletedAt only ever moves FORWARD and only when a trip is actually
          // completed - booking, moving or cancelling a visit never touches it. That difference
          // is the whole point of D3.
          leadCreatedAt: lead.created_at,
          leadContactedAt: lead.contacted_at,
          leadWalkthroughFirstBookedAt: lead.walkthrough_first_booked_at,
          leadLastVisitCompletedAt: lead.last_visit_completed_at,
          leadFirstEstimateSentAt: lead.first_estimate_sent_at,
        },
      };
    }

    default:
      return null;
  }
}
