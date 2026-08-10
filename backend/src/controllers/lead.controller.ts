import { Request, Response } from 'express';
import { z } from 'zod';
import { LeadStatus, Prisma } from '@prisma/client';
import { prisma } from '../lib/prisma';
import { ESTIMATE_STATUS } from '../constants/estimateStatus';
import { logger } from '../lib/logger';
import { parsePagination, buildPaginationMeta, parseSortParams, respondInvalidSort } from '../lib/pagination';
import { LEAD_SORT_FIELDS } from '../lib/sortFields';
import { applyFilters } from '../lib/query/filterEngine';
import { leadFacets } from '../lib/query/registries/lead.filters';
import { tenantWhere } from '../lib/tenant';
import { allocateNumber } from '../lib/numbering';
// Creator tracking (audit only) - stamped at every create, never read for authorization here.
import { createdByUser } from '../lib/created-by';
import { withRequiredCustomerFields } from '../lib/customer-create';
import { findDuplicateCustomer } from '../lib/customer-duplicate';
import { optionalCustomerEmail, hasPhoneOrEmail, CONTACT_REQUIRED_MSG } from '../lib/email-schema';
import { optionalCustomerPhone } from '../lib/phone-schema';
import { hasNameOrCompany } from '../lib/customer-kind';
import { accreteContactMethods } from '../lib/customer-accretion';
import { resolveDefaultLeadStatus } from '../lib/lead-status-override';
import { phoneSearchClauses, phoneRelationSearchClauses } from '../lib/phone-search';
import { loadTagsByEntity, loadTagsForEntity, type TagSummary } from '../lib/tags';
import {
  resolveOrAccreteLocation,
  buildLocationTaxWarning,
  LocationResolutionError,
  type LocationAddress,
} from '../lib/service-location';
import type { Subject } from '../lib/permissions/catalog';
import { isOwnerEligible } from '../lib/permissions/assignableRoles';
import { scopeWhereForReq, canAccessRow } from '../lib/permissions/enforce';
import { emit } from '../services/notifications/notificationService';
import { dispatchAutomationEvent } from '../services/automations/dispatch';
import { rearmAnchoredWaits } from '../services/automations/enrollment';
import { addOrFilter } from '../lib/permissions/whereCompose';
import { logAudit } from '../lib/audit';
import { mergeCustomFields, validateCustomFieldValues, CustomFieldValidationError } from '../lib/custom-fields';
import {
  projectLeadWalkthroughFields,
  walkthroughSnapshotSelect,
  mergeWalkthroughsSome,
  replaceWalkthroughPerformers,
  validatePerformers,
  detectPerformerConflicts,
  findActiveWalkthrough,
  findScheduledWalkthrough,
  findCurrentWalkthroughForLead,
  scheduleActiveWalkthrough,
  unscheduleWalkthroughRow,
  completeWalkthroughRow,
  cancelWalkthroughRow,
  autoCancelScheduledWalkthroughOnLeadExit,
  type PerformerMember,
  type WalkthroughSnapshotRow,
} from '../services/walkthrough.service';

// ─── Select Objects ────────────────────────────────────

const leadListSelect = {
  id: true,
  lead_number: true,
  customer_id: true,
  status: true,
  service_request: true,
  job_type: true,
  scheduled_start: true,
  scheduled_end: true,
  service_city: true,
  service_state: true,
  notes: true,
  created_at: true,
  updated_at: true,
  // Walkthrough-as-entity redesign, PR-B2: walkthrough_scheduled_at/completed_at/
  // duration_minutes are no longer selected as raw legacy columns - projectLeadWalkthroughFields
  // (called from withTagsMany/exportAll) sources them from this relation instead, resolving
  // D15's "current visit" so they stay coherent under multiple visits.
  walkthroughs: { select: walkthroughSnapshotSelect },
  contacted_at: true,
  customer: { select: { id: true, customer_number: true, first_name: true, last_name: true, company_name: true, phone: true, ad_source: true, service_locations: { where: { is_primary: true }, take: 1, select: { city: true, state: true } } } },
  // Scheduler redesign: the SINGLE owner (commission_owner) + the MULTI performer set.
  commission_owner: { select: { id: true, first_name: true, last_name: true } },
  lead_assignees: { select: { user_id: true, user: { select: { id: true, first_name: true, last_name: true } } } },
  walkthrough_performers: { select: { user: { select: { id: true, first_name: true, last_name: true } } } },
  estimates: {
    select: { id: true, total_amount: true },
  },
};

const leadDetailSelect = {
  id: true,
  lead_number: true,
  customer_id: true,
  status: true,
  service_request: true,
  job_type: true,
  scheduled_start: true,
  scheduled_end: true,
  service_address_line1: true,
  service_address_line2: true,
  service_city: true,
  service_state: true,
  service_zip: true,
  // Walkthrough-as-entity redesign, PR-B2: every walkthrough_* field below is no longer a raw
  // legacy column read - projectLeadWalkthroughFields (called from withTags) sources them from
  // this relation, resolving D15's "current visit" so they stay coherent under multiple visits
  // (the raw columns' old incoherence bug - e.g. rescheduling never clearing
  // walkthrough_completed_at - is what this structurally fixes).
  walkthroughs: { select: walkthroughSnapshotSelect },
  contacted_at: true,
  contacted_note: true,
  notes: true,
  lost_at: true,
  lost_reason: true,
  cancelled_at: true,
  cancelled_reason: true,
  // SRVW-114 slice 3 - { "<CustomFieldDefinition-uuid>": <scalar> }. ExtraInfoPanel reads this
  // bag off the detail payload; without it the panel renders every field blank.
  custom_fields: true,
  created_at: true,
  updated_at: true,
  customer: {
    select: {
      id: true,
      first_name: true,
      last_name: true,
      company_name: true,
      email: true,
      phone: true,
      phone_ext: true,
      ad_source: true,
      service_locations: {
        select: {
          id: true,
          address_line1: true,
          address_line2: true,
          city: true,
          state: true,
          zip: true,
          is_primary: true,
        },
        orderBy: { is_primary: 'desc' as const },
      },
    },
  },
  // walkthrough_canceller (the old direct Lead -> User relation) is superseded by the
  // `canceller` nested inside walkthroughs above - walkthrough_cancelled_by's PROJECTED value
  // now sources from the CURRENT visit's own canceller, not necessarily the lead's last-ever one.
  // Scheduler redesign: the SINGLE owner (commission_owner + the mirrored lead_assignees row)
  // and the MULTI walkthrough performer set.
  commission_owner: { select: { id: true, first_name: true, last_name: true, email: true } },
  lead_assignees: { select: { user_id: true, user: { select: { id: true, first_name: true, last_name: true } } } },
  walkthrough_performers: { select: { user_id: true, user: { select: { id: true, first_name: true, last_name: true, email: true } } } },
  estimates: {
    select: {
      id: true, estimate_number: true, status: true, total_amount: true, created_at: true,
      creator: { select: { id: true, first_name: true, last_name: true } },
      job: { select: { id: true, job_number: true, status: true } },
    },
    orderBy: { created_at: 'desc' as const },
  },
};

// ─── Zod Schemas ───────────────────────────────────────

const locationSchema = z.object({
  address_line1: z.string().min(1).max(200),
  address_line2: z.string().max(200).optional().nullable(),
  city: z.string().min(1).max(100),
  state: z.string().min(2).max(2),
  zip: z.string().min(5).max(10),
});

const newCustomerSchema = z.object({
  first_name: z.string().max(100).optional(),
  // Last name + company are optional; the customer needs a first name OR a company
  // name (unified-client-creation §2), and at least one of phone/email (SERV10X-35).
  last_name: z.string().max(100).optional(),
  company_name: z.string().max(200).optional(),
  email: optionalCustomerEmail,
  phone: optionalCustomerPhone,
  // #530 - the New Lead form's optional "Ext" beside Phone. Mirrors the
  // customer-controller shape so both create paths persist it identically.
  phone_ext: z.string().max(10).optional().nullable(),
  secondary_phone: optionalCustomerPhone,
  ad_source: z.string().max(100).optional().nullable(),
  location: locationSchema.optional(),
}).refine(hasNameOrCompany, {
  message: 'Provide a first name or a company name',
  path: ['first_name'],
}).refine(hasPhoneOrEmail, {
  message: CONTACT_REQUIRED_MSG,
  path: ['phone'],
});

const leadExtraFields = {
  job_type: z.string().max(100).optional().nullable(),
  ad_source: z.string().max(100).optional().nullable(),
  scheduled_start: z.string().datetime().optional().nullable(),
  scheduled_end: z.string().datetime().optional().nullable(),
  // Entity-redesign §3: anchor the lead to one of the customer's ServiceLocations.
  // Precedence: service_location_id > new_location > legacy service_address_*.
  service_location_id: z.string().uuid().optional().nullable(),
  new_location: locationSchema.optional(),
  // Legacy denormalized address (backward-compat; dropped in Phase D).
  service_address_line1: z.string().max(200).optional().nullable(),
  service_address_line2: z.string().max(200).optional().nullable(),
  service_city: z.string().max(100).optional().nullable(),
  service_state: z.string().max(2).optional().nullable(),
  service_zip: z.string().max(10).optional().nullable(),
};

export const createLeadSchema = z
  .object({
    customer_id: z.string().uuid().optional(),
    new_customer: newCustomerSchema.optional(),
    // Existing-customer accretion (§5.3): a phone/email typed while linking to an
    // existing customer is added as a new secondary contact method, never overwriting
    // the primary. Only meaningful alongside customer_id; ignored on the new_customer path.
    phone: optionalCustomerPhone,
    email: optionalCustomerEmail,
    // Owner chosen at creation by a non-SALES creator (SALES always self-assigns).
    assigned_to: z.string().uuid().optional().nullable(),
    service_request: z.string().min(1).max(2000),
    notes: z.string().max(5000).optional(),
    ...leadExtraFields,
  })
  .refine(
    (data) => Boolean(data.customer_id) !== Boolean(data.new_customer),
    { message: 'Provide either customer_id or new_customer, not both' }
  );

export const updateLeadSchema = z.object({
  service_request: z.string().min(1).max(2000).optional(),
  notes: z.string().max(5000).optional().nullable(),
  status: z.nativeEnum(LeadStatus).optional(),
  ...leadExtraFields,
  // SRVW-114 slice 3 - ExtraInfoPanel's save patch, keyed by CustomFieldDefinition uuid, same
  // shape the job PATCH already accepts. Deliberately `unknown` per value: which values are
  // legal depends on the org's own definitions, so it is enforced downstream by
  // validateCustomFieldValues rather than by this schema. An explicit null clears a key
  // (see mergeCustomFields).
  custom_fields: z.record(z.string().uuid(), z.unknown()).optional(),
});

// Lead owner is SINGLE (Decision: Ran). `null` clears the owner. Mirrored to
// commission_owner_id + exactly one lead_assignees row. (Walkthrough performers + job
// crews are MULTI; the owner is the off-board single picker.)
export const assignLeadSchema = z.object({
  assigned_to: z.string().uuid().nullable(),
  // #361: the assign popover's channel toggle. in_app:false suppresses ONLY the lead.assigned
  // emit to the new owner; lead.reassigned_away stays unconditional. Omitted → today's behavior.
  notify: z.object({ in_app: z.boolean().optional() }).optional(),
});

export const walkthroughSchema = z.object({
  walkthrough_scheduled_at: z.string().datetime().optional().nullable(),
  walkthrough_completed_at: z.string().datetime().optional().nullable(),
  walkthrough_notes: z.string().max(5000).optional().nullable(),
  walkthrough_duration_minutes: z.number().int().min(15).max(480).optional().nullable(),
});

export const markLostSchema = z.object({
  lost_reason: z.string().min(1).max(2000),
});

// contactLeadSchema removed with contactLead (D6, PR-B2) - contacted_at is inferred from
// outbound activity, never set by hand.

// Walkthrough performers are MULTI (REPLACE semantics, like job crew). Crew ⟂ schedule:
// scheduling sets the time + the visit's own SCHEDULED status; performers are independent.
export const scheduleWalkthroughSchema = z.object({
  walkthrough_scheduled_at: z.string().datetime(),
  performer_ids: z.array(z.string().uuid()),
  walkthrough_duration_minutes: z.number().int().min(15).max(480).default(60),
  send_email: z.boolean().optional().default(true),
  force: z.boolean().optional().default(false),
});

// Performer-only REPLACE (no status/time change). See setPerformers().
export const setPerformersSchema = z.object({
  performer_ids: z.array(z.string().uuid()),
});

export const completeWalkthroughSchema = z.object({});

export const cancelWalkthroughSchema = z.object({
  cancelled_reason: z.string().min(1).max(2000),
});

export const cancelLeadSchema = z.object({
  cancelled_reason: z.string().min(1).max(2000),
});

// ─── Helpers ───────────────────────────────────────────

function param(req: Request, name: string): string {
  return req.params[name] as string;
}

/**
 * Build a LocationAddress from a new_location object or the legacy
 * service_address_* fields (precedence: new_location > legacy). Returns null when
 * neither carries a usable address (line1 + zip).
 */
function pickLocationAddress(body: {
  new_location?: LocationAddress | null;
  service_address_line1?: string | null;
  service_address_line2?: string | null;
  service_city?: string | null;
  service_state?: string | null;
  service_zip?: string | null;
}): LocationAddress | null {
  if (body.new_location && body.new_location.address_line1 && body.new_location.zip) {
    return body.new_location;
  }
  if (body.service_address_line1 && body.service_zip) {
    return {
      address_line1: body.service_address_line1,
      address_line2: body.service_address_line2 ?? null,
      city: body.service_city ?? '',
      state: body.service_state ?? '',
      zip: body.service_zip,
    };
  }
  return null;
}

/**
 * Entity-redesign §8/§10 cascade: void UNPAID kind=DEPOSIT Invoices on the given
 * estimates. "Unpaid" = InvoiceStatus ∈ {DRAFT, SENT} with no non-voided Payment.
 * A deposit invoice carrying real money (any non-voided Payment) is NOT voided —
 * its money routes through refund (§8), never cancel.
 */
async function voidUnpaidDepositInvoices(req: Request, estimateIds: string[]): Promise<void> {
  if (estimateIds.length === 0) return;
  const depInvoices = await prisma.invoice.findMany({
    where: {
      ...tenantWhere(req),
      estimate_id: { in: estimateIds },
      kind: 'DEPOSIT',
      status: { in: ['DRAFT', 'SENT'] },
    },
    select: { id: true, payments: { where: { voided_at: null }, select: { id: true } } },
  });
  const voidIds = depInvoices.filter(i => i.payments.length === 0).map(i => i.id);
  if (voidIds.length > 0) {
    await prisma.invoice.updateMany({
      where: { id: { in: voidIds } },
      data: { status: 'VOIDED', voided_at: new Date() },
    });
  }
}

/** True when the request body attempts to change the lead's service location. */
function requestsLocationChange(body: {
  service_location_id?: unknown;
  new_location?: unknown;
  service_address_line1?: unknown;
  service_address_line2?: unknown;
  service_city?: unknown;
  service_state?: unknown;
  service_zip?: unknown;
}): boolean {
  return (
    body.service_location_id !== undefined ||
    body.new_location !== undefined ||
    body.service_address_line1 !== undefined ||
    body.service_address_line2 !== undefined ||
    body.service_city !== undefined ||
    body.service_state !== undefined ||
    body.service_zip !== undefined
  );
}

// Walkthrough-as-entity redesign, PR-B2: withTags/withTagsMany are the universal last-mile
// funnel every lead-returning handler already routes through, so this is where
// projectLeadWalkthroughFields runs - sourcing the walkthrough_* JSON fields from the lead's
// `walkthroughs` relation (D15's current visit) instead of the raw legacy columns, while keeping
// the response field NAMES unchanged. withTags always carries a leadDetailSelect-shaped row
// (full field set); withTagsMany is list()'s leadListSelect-shaped rows (narrower set).
async function withTags<T extends { id: string; walkthroughs?: WalkthroughSnapshotRow[] }>(
  req: Request,
  lead: T,
): Promise<Omit<T, 'walkthroughs'> & { tags: TagSummary[] }> {
  const tags = await loadTagsForEntity(req, 'LEAD', lead.id);
  return { ...projectLeadWalkthroughFields(lead, { full: true }), tags };
}

async function withTagsMany<T extends { id: string; walkthroughs?: WalkthroughSnapshotRow[] }>(
  req: Request,
  leads: T[],
): Promise<Array<Omit<T, 'walkthroughs'> & { tags: TagSummary[] }>> {
  const grouped = await loadTagsByEntity(req, 'LEAD', leads.map((l) => l.id));
  return leads.map((l) => ({ ...projectLeadWalkthroughFields(l, { full: false }), tags: grouped.get(l.id) ?? [] }));
}

// #233 / audit F-012: monetary summary fields embedded on a lead's estimate(s). Stripped
// in-place from the lead-detail payload when the requester cannot `read Estimate`, so a
// walkthrough-only technician sees an estimate exists (id/number/status) but not its dollars.
// (leadDetailSelect only selects total_amount today; the rest are guarded defensively in case
// the sub-select grows — and no estimate line items are embedded, so there's nothing per-line.)
const ESTIMATE_MONETARY_FIELDS = ['total_amount', 'subtotal', 'tax_amount', 'discount_amount', 'deposit_amount'] as const;

function stripEstimateMonetaryFields(lead: { estimates?: Array<Record<string, unknown>> | null }): void {
  for (const estimate of lead.estimates ?? []) {
    for (const field of ESTIMATE_MONETARY_FIELDS) {
      delete estimate[field];
    }
  }
}

/**
 * #233 / audit F-012, extended by the technician-ownership spec (2026-08-05, live QA): TECHNICIAN
 * and SALES both hold a CONDITIONAL `read Estimate` grant (OWN_ESTIMATE_VIA_LEAD_OR_CREATOR), so
 * `req.ability!.can('read', 'Estimate')` is a SUBJECT-level CASL check - it is true whenever the
 * role holds ANY read grant, regardless of whether THIS row matches it. A lead's embedded
 * estimates are always lead-anchored (their `lead_id` is this lead's id), so only the
 * lead-anchored arm of that condition (`lead.lead_assignees.some`) can ever apply - the
 * lead-less/creator arm is structurally impossible here.
 *
 * For SALES this is a no-op: its Lead-read condition (OWN_LEAD) is the SAME `lead_assignees`
 * relation the estimate condition checks, so a lead SALES can read always satisfies it too. For
 * TECHNICIAN it is NOT a no-op: its Lead-read condition (OWN_WALKTHROUGH) is a DIFFERENT relation
 * (walkthrough performer) - a walkthrough-only technician can read a lead they are not a
 * lead_assignee on, and without this per-lead check they would see that lead's estimate dollars
 * too, purely because the subject-level ability check can't tell the rows apart.
 */
async function canSeeLeadEstimateMoney(
  req: Request,
  lead: { lead_assignees?: Array<{ user_id: string }> | null },
): Promise<boolean> {
  if (!req.ability!.can('read', 'Estimate' as Subject)) return false;
  const scope = await scopeWhereForReq(req, 'Estimate');
  if (Object.keys(scope).length === 0) return true; // ADMIN / unconditional reader
  return lead.lead_assignees?.some((a) => a.user_id === req.user?.id) ?? false;
}

async function stripEstimateMoneyUnlessVisible(
  req: Request,
  lead: { lead_assignees?: Array<{ user_id: string }> | null; estimates?: Array<Record<string, unknown>> | null },
): Promise<void> {
  if (!(await canSeeLeadEstimateMoney(req, lead))) stripEstimateMonetaryFields(lead);
}

// Walkthrough-as-entity redesign, PR-B2: replaceWalkthroughPerformers / validatePerformers /
// detectPerformerConflicts moved to services/walkthrough.service.ts, now keyed by walkthrough_id
// instead of lead_id (a lead can have many walkthroughs, each with its own crew) — imported
// above. PerformerMember is re-exported from there too.

// ─── Handlers ──────────────────────────────────────────

/**
 * Build the `where` clause (and the underlying grant-driven `scopeWhere`) for the lead
 * list/export. Extracted from `list()` so the unpaginated `exportAll` applies the IDENTICAL
 * tenant scope + CASL row-scope + filters. Returns `scopeWhere` too because `list()` reuses it
 * for the stats counts.
 */
export async function buildLeadListWhere(req: Request): Promise<{ where: Record<string, unknown>; scopeWhere: Record<string, unknown> }> {
  const search = (req.query.search as string) || '';

  // #106: grant-DRIVEN row-scope (replaces the fail-open hand-rolled SALES-only block,
  // which let every other non-ADMIN role see the whole org). scopeWhereForReq resolves the
  // requesting role's Lead read grant → {} (ADMIN/unconditional), the owner/team/location
  // condition, or MATCH_NOTHING (no read grant = fail-closed). It is the OUTERMOST spread so
  // a per-request filter can't overwrite its keys (e.g. the MATCH_NOTHING `id`).
  const scopeWhere: Record<string, unknown> = await scopeWhereForReq(req, 'Lead');

  // Build where clause (org-scoped + grant-scoped). tenant first, scope outermost — so a
  // per-request filter can't overwrite the scope keys (e.g. MATCH_NOTHING's id). Matches the
  // spread order in the other 3 controllers.
  const where: Record<string, unknown> = { ...tenantWhere(req), ...scopeWhere };

  // Walkthrough-as-entity redesign, PR-B2: repointed from the legacy walkthrough_scheduled_at
  // column onto the relation. SECURITY: `scopeWhere.walkthroughs` may already be set here (a
  // TECHNICIAN's OWN_WALKTHROUGH read condition — see defaultGrants.ts). Assigning a fresh
  // `where.walkthroughs` would silently CLOBBER that row-scope (RBAC bypass), so this merges
  // into the SAME `some` clause instead of overwriting the key — which is also the semantically
  // correct read: "my own walkthrough that is ALSO in this date range", not two independent
  // `some` checks. Mirrors the `assigned_to` facet's clobber-guard in lead.filters.ts.
  const walkthroughAfter  = req.query.walkthrough_after  as string | undefined;
  const walkthroughBefore = req.query.walkthrough_before as string | undefined;
  if (walkthroughAfter || walkthroughBefore) {
    where.walkthroughs = mergeWalkthroughsSome(where, {
      scheduled_at: {
        ...(walkthroughAfter  ? { gte: new Date(walkthroughAfter)  } : {}),
        ...(walkthroughBefore ? { lte: new Date(walkthroughBefore) } : {}),
      },
    });
  }

  // Generalized filter engine (Task 4): status (enum-validated), job_type, ad_source
  // (Customer relation), walkthrough_status (synthetic — Walkthrough-as-entity redesign, PR-B2:
  // no longer touches `status` at all, so unlike before it has no ordering dependency on the
  // `status` facet above), assigned_to (scope-guarded — see lead.filters.ts), customer_id,
  // created_after/before, and estimates_min/estimates_max (countRange). leadFacets is a function of
  // scopeWhere so the assigned_to facet can enforce its RBAC no-op gate without any change to
  // the shared filterEngine.ts.
  await applyFilters(where, req, leadFacets(scopeWhere));

  if (search) {
    // Clobber-safe: a multi-read user's row-scope can itself be an `OR` (spread in above from
    // scopeWhereForReq). Assigning `where.OR` directly would silently drop it (row-scope LEAK),
    // so AND-merge the search OR onto any existing scope OR. See lib/permissions/whereCompose.
    addOrFilter(where, [
      // The Lead # rendered in the list must be typeable back into the search box. Every other
      // list controller already matches its own number (customer_number/job_number/
      // estimate_number/invoice_number), and global search matches lead_number since #1234 -
      // this list was the last surface where a number the user can plainly see returned nothing.
      { lead_number: { contains: search, mode: 'insensitive' } },
      { service_request: { contains: search, mode: 'insensitive' } },
      { customer: { first_name: { contains: search, mode: 'insensitive' } } },
      { customer: { last_name: { contains: search, mode: 'insensitive' } } },
      { customer: { company_name: { contains: search, mode: 'insensitive' } } },
      // #352 — digit-normalized phone search on BOTH the legacy scalar Customer.phone
      // and the phones[] relation (CustomerPhone), matching customer.controller.ts /
      // global search parity (#350/#460). Both helpers return [] for digit-less terms,
      // so non-phone searches add no clauses.
      ...phoneSearchClauses(search).map((c) => ({ customer: c })),
      ...phoneRelationSearchClauses(search).map((c) => ({ customer: c })),
    ]);
  }

  return { where, scopeWhere };
}

export async function list(req: Request, res: Response) {
  try {
    const { page, limit, skip } = parsePagination(req.query as { page?: string; limit?: string });
    const sort = parseSortParams(req.query as any, LEAD_SORT_FIELDS);
    if (!sort.ok) {
      respondInvalidSort(res, sort);
      return;
    }
    const orderBy: Prisma.LeadOrderByWithRelationInput[] = sort.orderBy;

    const { where, scopeWhere } = await buildLeadListWhere(req);

    // Date boundaries for stats / "New This Week" (matches the client's created_after preset).
    const now = new Date();
    const startOfWeek = new Date(now);
    startOfWeek.setDate(now.getDate() - now.getDay());
    startOfWeek.setHours(0, 0, 0, 0);

    const [leads, total, statTotal, statNewThisWeek, statUnassigned, statWon, statLost] = await Promise.all([
      prisma.lead.findMany({
        where,
        select: leadListSelect,
        orderBy,
        skip,
        take: limit,
      }),
      prisma.lead.count({ where }),
      prisma.lead.count({ where: { ...tenantWhere(req), ...scopeWhere } }),
      prisma.lead.count({ where: { ...tenantWhere(req), ...scopeWhere, created_at: { gte: startOfWeek } } }),
      prisma.lead.count({ where: { ...tenantWhere(req), ...scopeWhere, AND: [{ lead_assignees: { none: {} } }] } }),
      prisma.lead.count({ where: { ...tenantWhere(req), ...scopeWhere, status: 'WON' } }),
      prisma.lead.count({ where: { ...tenantWhere(req), ...scopeWhere, status: 'LOST' } }),
    ]);

    // #233 / audit F-012: leadListSelect embeds estimates { id, total_amount }. A requester
    // who can read these leads (e.g. a walkthrough-only TECHNICIAN via OWN_WALKTHROUGH) but
    // has NO `read Estimate` grant must NOT see the estimate's dollars. Same ABILITY-driven
    // gate + helper as getById (never a role literal). Per-lead, not per-request: a conditional
    // reader's Estimate scope depends on THIS lead's own assignees (canSeeLeadEstimateMoney).
    for (const lead of leads) {
      await stripEstimateMoneyUnlessVisible(req, lead);
    }

    res.json({
      leads: await withTagsMany(req, leads),
      pagination: buildPaginationMeta(total, { page, limit, skip }),
      stats: {
        total: statTotal,
        new_this_week: statNewThisWeek,
        unassigned: statUnassigned,
        won: statWon,
        lost: statLost,
      },
    });
  } catch (err) {
    logger.error('List leads error:', err);
    res.status(500).json({ error: 'Failed to list leads' });
  }
}

const EXPORT_ROW_CAP = 50_000;

/**
 * Export every lead matching the active filters (unpaginated, capped). Reuses the list's
 * `where` (tenant + CASL row-scope + filters), `select`, and default `orderBy` so the CSV
 * the frontend builds is column-identical to the list and row-level security holds.
 */
export async function exportAll(req: Request, res: Response) {
  try {
    const { where } = await buildLeadListWhere(req);
    const leads = await prisma.lead.findMany({
      where,
      select: leadListSelect,
      orderBy: { created_at: 'desc' },
      take: EXPORT_ROW_CAP,
    });
    if (leads.length === EXPORT_ROW_CAP) {
      logger.warn(`Lead export hit row cap (${EXPORT_ROW_CAP}) for org ${req.user?.organization_id}`);
    }
    // #233 / audit F-012: same embedded-estimate leak as list() — the export shares
    // leadListSelect, so strip estimate monetary fields from the CSV payload when the
    // requester can't `read Estimate` (ABILITY-driven, never a role literal). Per-lead - see
    // canSeeLeadEstimateMoney for why a subject-level check alone is not enough.
    for (const lead of leads) {
      await stripEstimateMoneyUnlessVisible(req, lead);
    }
    void logAudit({ req, action: 'lead.exported', resourceType: 'Lead', resourceId: null });
    // Walkthrough-as-entity redesign, PR-B2: exportAll bypasses withTagsMany (no tag
    // enrichment on the CSV path), so it needs its own projectLeadWalkthroughFields call to
    // source the walkthrough_* columns from the relation rather than the raw legacy ones.
    res.json({ leads: leads.map((lead) => projectLeadWalkthroughFields(lead, { full: false })) });
  } catch (err) {
    logger.error('Export leads error:', err);
    res.status(500).json({ error: 'Failed to export leads' });
  }
}

export async function create(req: Request, res: Response) {
  try {
    const {
      customer_id, new_customer, service_request, notes,
      job_type, ad_source, scheduled_start, scheduled_end,
      service_location_id, new_location,
      service_address_line1, service_address_line2, service_city, service_state, service_zip,
      phone, email,
    } = req.body;

    // Sales auto-assign to self; all other roles may pick an owner via the body.
    // SALES NEVER honors a body value and skips the eligibility guard (SALES is
    // owner-eligible by definition). bodyAssignee gates the guard so it runs ONLY
    // on a non-SALES, owner-supplied request — no extra DB read otherwise.
    const bodyAssignee = req.user?.role === 'SALES' ? null : (req.body.assigned_to ?? null);
    const assigned_to = req.user?.role === 'SALES' ? req.user.id : (bodyAssignee ?? undefined);

    if (bodyAssignee) {
      const targetUser = await prisma.user.findUnique({
        where: { id: bodyAssignee, ...tenantWhere(req) },
        select: { id: true, role: true, is_active: true },
      });
      if (!targetUser || !targetUser.is_active) {
        res.status(400).json({ error: 'Target user not found or inactive' });
        return;
      }
      if (!isOwnerEligible(targetUser.role)) {
        res.status(400).json({ error: 'This user is not eligible to be assigned as a lead owner' });
        return;
      }
    }

    // ad_source is NOT included here — it belongs on the customer row, not the lead
    const extraData = {
      job_type: job_type || null,
      scheduled_start: scheduled_start ? new Date(scheduled_start) : null,
      scheduled_end: scheduled_end ? new Date(scheduled_end) : null,
      service_address_line1: service_address_line1 || null,
      service_address_line2: service_address_line2 || null,
      service_city: service_city || null,
      service_state: service_state || null,
      service_zip: service_zip || null,
    };

    // Address resolved from new_location > legacy service_address_* (for accretion).
    const addressForResolve = pickLocationAddress(req.body);

    let finalCustomerId = customer_id;
    const orgId = req.user!.organization_id;
    // SRVW-111 (label-override shape) - Lead.status keeps its DB @default(NEW) as the safety
    // net, but this is set explicitly so an org that has moved new leads to a different default
    // (POST /api/lead-status-overrides/:status/default) doesn't have to manually re-triage every one.
    const defaultLeadStatus = await resolveDefaultLeadStatus(prisma, orgId);

    if (new_customer) {
      // Duplicate-customer guard (Fixes #42) — same check as POST /api/customers.
      // Runs before the transaction; `?override=true` bypasses it.
      const override = req.query.override === 'true';
      const duplicateMatch = await findDuplicateCustomer(prisma, orgId, {
        email: new_customer.email,
        phone: new_customer.phone,
      });
      if (duplicateMatch && !override) {
        res.status(409).json({ error: 'duplicate', existing: duplicateMatch });
        return;
      }

      // Inline customer creation via transaction
      // ad_source from new_customer schema is written to the customer row directly
      const result = await prisma.$transaction(async (tx) => {
        const { location, email, ad_source: newCustomerSource, ...customerData } = new_customer;
        // customer_number/kind/segment are NOT-NULL with no DB default — the shared
        // helper guarantees them (and organization_id) so this path can't drift
        // from POST /api/customers and silently 500 on a missing required column.
        const customer = await tx.customer.create({
          data: {
            ...(await withRequiredCustomerFields(tx, orgId, {
              ...customerData,
              // Email is optional — omitted/blank persists as NULL.
              email: email?.trim() || null,
              ad_source: newCustomerSource || ad_source || null,
            })),
            // Location is OPTIONAL — only seed a primary ServiceLocation when an address was given.
            ...(location ? { service_locations: { create: { ...location, is_primary: true } } } : {}),
            // Audit: the user who filed the lead also authored the customer this path mints. LAST
            // so it wins over the body-derived spread above.
            ...createdByUser(req),
          },
          select: { id: true, service_locations: { where: { is_primary: true }, take: 1, select: { id: true } } },
        });

        // On an override-create, record the bypassed duplicate on a CUSTOMER_CREATED
        // timeline event — the only forward audit trail for #42 (no merge tool yet).
        // Mirrors POST /api/customers; emitted only when a match was actually bypassed.
        if (override && duplicateMatch) {
          await tx.timelineEvent.create({
            data: {
              organization_id: orgId,
              entity_type: 'CUSTOMER',
              entity_id: customer.id,
              event_type: 'CUSTOMER_CREATED',
              description: `Customer created (duplicate of ${duplicateMatch.customer_number} bypassed)`,
              metadata: {
                duplicate_override: true,
                matched_customer_id: duplicateMatch.id,
                matched_customer_number: duplicateMatch.customer_number,
              },
              created_by: req.user!.id,
            },
          });
        }

        // The freshly-created primary location is the lead's service_location_id.
        const primaryLocationId = customer.service_locations[0]?.id ?? null;

        const leadNumber = await allocateNumber(tx, 'lead', orgId);
        const lead = await tx.lead.create({
          data: {
            lead_number: leadNumber,
            status: defaultLeadStatus,
            customer_id: customer.id,
            service_request,
            notes: notes || null,
            // Write the SINGLE owner into the M2M spine (commission_owner_id + one
            // lead_assignees row) so the Owned-scope key is correct from creation.
            ...(assigned_to ? { commission_owner_id: assigned_to, lead_assignees: { create: { user_id: assigned_to, organization_id: orgId } } } : {}),
            organization_id: orgId,
            service_location_id: primaryLocationId,
            ...extraData,
            // Keep legacy denormalized address in sync from the primary location.
            service_address_line1: extraData.service_address_line1 ?? location?.address_line1 ?? null,
            service_address_line2: extraData.service_address_line2 ?? location?.address_line2 ?? null,
            service_city: extraData.service_city ?? location?.city ?? null,
            service_state: extraData.service_state ?? location?.state ?? null,
            service_zip: extraData.service_zip ?? location?.zip ?? null,
            // Audit: the user who filed the lead. LAST in the object on purpose - it must win over
            // the ...extraData spread above, which is body-derived.
            ...createdByUser(req),
          },
          select: leadDetailSelect,
        });

        // Walkthrough-as-entity redesign, PR-B2: seed the default bucket entry. Every new lead
        // used to appear in the "needs scheduling" bucket for free via
        // `walkthrough_needed @default(true)` + `walkthrough_scheduled_at` defaulting to null;
        // now that the bucket is `Walkthrough.status = REQUESTED`, a lead has ZERO walkthrough
        // rows until one is explicitly created, so create() must seed one to keep that default
        // behavior (every new lead needs a visit until told otherwise).
        await tx.walkthrough.create({
          data: { organization_id: orgId, lead_id: lead.id, status: 'REQUESTED' },
        });

        return lead;
      });

      // #233 / audit F-012: defense-in-depth (a new lead has no estimates yet → no-op);
      // same ability-gated strip as the other lead-returning handlers.
      await stripEstimateMoneyUnlessVisible(req, result);

      // Emit unassigned_created only when the new lead has no owner.
      if (!result.commission_owner) {
        await emit({
          verb: 'lead.unassigned_created',
          organizationId: orgId,
          actorId: req.user?.id ?? null,
          object: { type: 'LEAD', id: result.id, label: result.lead_number },
          entity: {},
          data: { object_label: result.lead_number },
        });
      }

      // Automation Center — fires for EVERY new lead (the in-app verb only
      // covers unowned leads; automations cover the assigned path too).
      dispatchAutomationEvent({
        type: 'LEAD_CREATED',
        organizationId: req.user!.organization_id,
        entity: { type: 'lead', id: result.id, label: result.lead_number },
        actorId: req.user?.id ?? null,
      });
      if (assigned_to) {
        dispatchAutomationEvent({
          type: 'LEAD_ASSIGNED',
          organizationId: req.user!.organization_id,
          entity: { type: 'lead', id: result.id, label: result.lead_number },
          occurrenceKey: assigned_to,
          actorId: req.user?.id ?? null,
        });
      }
      void logAudit({ req, action: 'lead.created', resourceType: 'Lead', resourceId: result.id, metadata: { lead_number: result.lead_number } });
      res.status(201).json({ lead: await withTags(req, result) });
      return;
    }

    // Existing customer — verify it exists in the requesting org
    const customer = await prisma.customer.findUnique({ where: { id: finalCustomerId, ...tenantWhere(req) } });
    if (!customer) {
      res.status(400).json({ error: 'Customer not found' });
      return;
    }

    // Cross-customer accretion guard (#800 follow-up): a typed phone/email that belongs to a
    // DIFFERENT customer must not be silently accreted onto the linked one. Same 409 as the
    // new_customer path; `?override=true` (Create anyway → accrete onto the linked customer)
    // bypasses it. The linked customer is EXCLUDED so its own prefilled primary/secondary
    // never trips this — that same-customer case is deduped inside accreteContactMethods.
    if (phone || email) {
      const override = req.query.override === 'true';
      const crossMatch = await findDuplicateCustomer(prisma, orgId, { phone, email }, finalCustomerId);
      if (crossMatch && !override) {
        res.status(409).json({ error: 'duplicate', existing: crossMatch });
        return;
      }
    }

    let lead;
    try {
      lead = await prisma.$transaction(async (tx) => {
        // Update the customer's source if a new one was provided
        if (ad_source !== undefined) {
          await tx.customer.update({
            where: { id: finalCustomerId },
            data: { ad_source: ad_source || null },
          });
        }

        // Workiz-style accretion (spec §3/§5.3): a typed phone/email adds a new
        // secondary contact method on the customer; the primary is never touched.
        await accreteContactMethods(tx, finalCustomerId, { phone, email });

        // Resolve the lead's service location: explicit id > new_location > legacy.
        let resolvedLocationId: string | null = null;
        if (service_location_id || addressForResolve) {
          const resolved = await resolveOrAccreteLocation(tx, {
            customerId: finalCustomerId,
            orgId,
            service_location_id: service_location_id ?? null,
            address: addressForResolve,
          });
          resolvedLocationId = resolved.id;
        }

        if (!resolvedLocationId) {
          // Lead service location is OPTIONAL. Prefer the customer's primary location
          // when one exists (e.g. Servy creating a lead by customer name); otherwise
          // leave it null — a lead may have no location. A JOB still requires one.
          const primaryLocation = await tx.serviceLocation.findFirst({
            where: { customer_id: finalCustomerId },
            orderBy: [{ is_primary: 'desc' }, { created_at: 'asc' }],
            select: { id: true },
          });
          resolvedLocationId = primaryLocation?.id ?? null;
        }

        const leadNumber = await allocateNumber(tx, 'lead', orgId);
        const created = await tx.lead.create({
          data: {
            lead_number: leadNumber,
            status: defaultLeadStatus,
            customer_id: finalCustomerId,
            service_request,
            notes: notes || null,
            // Write the SINGLE owner into the M2M spine (see new-customer path).
            ...(assigned_to ? { commission_owner_id: assigned_to, lead_assignees: { create: { user_id: assigned_to, organization_id: orgId } } } : {}),
            organization_id: orgId,
            service_location_id: resolvedLocationId,
            ...extraData,
            // Audit: the user who filed the lead (see the new-customer path for why this is last).
            ...createdByUser(req),
          },
          select: leadDetailSelect,
        });

        // Walkthrough-as-entity redesign, PR-B2: seed the default bucket entry (see the
        // new-customer path above for the full rationale).
        await tx.walkthrough.create({
          data: { organization_id: orgId, lead_id: created.id, status: 'REQUESTED' },
        });

        return created;
      });
    } catch (e) {
      if (e instanceof LocationResolutionError) {
        res.status(400).json({ error: e.message });
        return;
      }
      throw e;
    }

    // #233 / audit F-012: defense-in-depth (a new lead has no estimates yet, so this is a
    // no-op today) — keep the same ability-gated strip as the other lead-returning handlers.
    await stripEstimateMoneyUnlessVisible(req, lead);

    // Emit unassigned_created only when the new lead has no owner.
    if (!lead.commission_owner) {
      await emit({
        verb: 'lead.unassigned_created',
        organizationId: orgId,
        actorId: req.user?.id ?? null,
        object: { type: 'LEAD', id: lead.id, label: lead.lead_number },
        entity: {},
        data: { object_label: lead.lead_number },
      });
    }

    // Automation Center — fires for EVERY new lead (see note on the other path).
    dispatchAutomationEvent({
      type: 'LEAD_CREATED',
      organizationId: req.user!.organization_id,
      entity: { type: 'lead', id: lead.id, label: lead.lead_number },
      actorId: req.user?.id ?? null,
    });
    if (assigned_to) {
      dispatchAutomationEvent({
        type: 'LEAD_ASSIGNED',
        organizationId: req.user!.organization_id,
        entity: { type: 'lead', id: lead.id, label: lead.lead_number },
        occurrenceKey: assigned_to,
        actorId: req.user?.id ?? null,
      });
    }
    void logAudit({ req, action: 'lead.created', resourceType: 'Lead', resourceId: lead.id, metadata: { lead_number: lead.lead_number } });
    res.status(201).json({ lead: await withTags(req, lead) });
  } catch (err) {
    logger.error('Create lead error:', err);
    res.status(500).json({ error: 'Failed to create lead' });
  }
}

export async function getById(req: Request, res: Response) {
  try {
    const lead = await prisma.lead.findUnique({
      where: { id: param(req, 'id'), ...tenantWhere(req) },
      select: leadDetailSelect,
    });

    if (!lead) {
      res.status(404).json({ error: 'Lead not found' });
      return;
    }

    // #106 P1: SQL-based per-instance scope (nested-safe) — see update(). req.ability.can()
    // THROWS on a nested Team/Location read condition → 500; canAccessRow probes via findFirst.
    if (!(await canAccessRow(req, 'Lead', prisma.lead, param(req, 'id')))) {
      res.status(403).json({ error: 'Insufficient permissions' });
      return;
    }

    // #233 / audit F-012: a requester who can read this lead (e.g. a walkthrough-only
    // TECHNICIAN via OWN_WALKTHROUGH) but has NO `read Estimate` grant must NOT see the
    // embedded estimate's dollar value. Gate is ABILITY-driven (never a role literal): strip
    // the monetary summary fields when the requester can't actually see THIS lead's estimate
    // (canSeeLeadEstimateMoney - never a role literal, and not a subject-level ability check
    // alone, since a conditional grant like TECHNICIAN's is true for the role on every row).
    // Non-monetary fields (id / estimate_number / status) stay so the FE still shows it exists.
    await stripEstimateMoneyUnlessVisible(req, lead);

    res.json({ lead: await withTags(req, lead) });
  } catch (err) {
    logger.error('Get lead error:', err);
    res.status(500).json({ error: 'Failed to get lead' });
  }
}

export async function update(req: Request, res: Response) {
  try {
    const existing = await prisma.lead.findUnique({
      where: { id: param(req, 'id'), ...tenantWhere(req) },
    });
    if (!existing) {
      res.status(404).json({ error: 'Lead not found' });
      return;
    }

    // #106 P1: SQL-based per-instance scope (nested-safe). req.ability.can() THROWS on a
    // nested Team/Location condition (lead_assignees.some.user.department_id) → 500; the
    // scoped findFirst compiles to SQL instead. Owner → match → proceed; non-owner → 403.
    if (!(await canAccessRow(req, 'Lead', prisma.lead, param(req, 'id')))) {
      res.status(403).json({ error: 'Insufficient permissions' });
      return;
    }

    // Strip status from Sales — they can't change status directly
    const data = { ...req.body };
    if (req.user?.role === 'SALES') {
      delete data.status;
    }

    // Extract ad_source — it belongs on the customer, not the lead row.
    // Extract the location-change inputs — they go through resolveOrAccreteLocation,
    // never directly into the lead.update data (besides the legacy address sync).
    // SRVW-114 slice 3 - custom_fields is pulled out of the generic spread on purpose. `rest`
    // flows straight into prisma.lead.update, so leaving it in would write an arbitrary
    // caller-supplied bag over the stored one: no validation, and every untouched key lost.
    const { ad_source, service_location_id, new_location, custom_fields, ...rest } = data;
    const leadData = { ...rest };

    if (custom_fields !== undefined) {
      try {
        await validateCustomFieldValues(req.user!.organization_id, 'LEAD', custom_fields);
      } catch (err) {
        if (err instanceof CustomFieldValidationError) {
          res.status(400).json({ error: err.message });
          return;
        }
        throw err;
      }
      leadData.custom_fields = mergeCustomFields(
        existing.custom_fields as Record<string, unknown> | null,
        custom_fields,
      );
    }

    // Entity-redesign §10 EDIT-FREEZE: once any estimate exists, customer_id and
    // service_location_id freeze. A location change on a lead with ≥1 estimate is
    // rejected. Detail/scope edits (service_request, notes, …) are always allowed.
    const wantsLocationChange = requestsLocationChange(data);
    if (wantsLocationChange) {
      const estimateCount = await prisma.estimate.count({
        where: { ...tenantWhere(req), lead_id: param(req, 'id') },
      });
      if (estimateCount > 0) {
        res.status(400).json({ error: 'Location locked — lead has estimates' });
        return;
      }
    }

    // Resolve a location change on an OPEN lead (no estimate). Surface a tax-warning
    // when the new location's state differs from the lead's current location state.
    let resolvedLocationId: string | null | undefined;
    let taxWarning: ReturnType<typeof buildLocationTaxWarning> = null;
    const addressForResolve = pickLocationAddress(data);

    const explicitLocationChange = service_location_id !== undefined || new_location !== undefined ||
      data.service_address_line1 !== undefined || data.service_zip !== undefined;

    const runLeadUpdate = async (tx: typeof prisma) => {
      if (wantsLocationChange && explicitLocationChange && (service_location_id || addressForResolve)) {
        const resolved = await resolveOrAccreteLocation(tx as never, {
          customerId: existing.customer_id,
          orgId: req.user!.organization_id,
          service_location_id: service_location_id ?? null,
          address: addressForResolve,
        });
        resolvedLocationId = resolved.id;
        leadData.service_location_id = resolvedLocationId;
        // The resolved location's state drives the tax-warning — covering the
        // pick-from-existing (id) path, where no inbound address state exists.
        const newState = resolved.state ?? addressForResolve?.state ?? data.service_state;
        taxWarning = buildLocationTaxWarning(existing.service_state, newState);
      }
      return tx.lead.update({
        where: { id: param(req, 'id') },
        data: leadData,
        select: leadDetailSelect,
      });
    };

    let lead;
    try {
      if (ad_source !== undefined) {
        // Atomic: update customer source + lead in one transaction
        lead = await prisma.$transaction(async (tx) => {
          await tx.customer.update({
            where: { id: existing.customer_id, ...tenantWhere(req) },
            data: { ad_source: ad_source || null },
          });
          return runLeadUpdate(tx as never);
        });
      } else if (explicitLocationChange) {
        // Location resolution needs a tx (accretion is a create).
        lead = await prisma.$transaction(async (tx) => runLeadUpdate(tx as never));
      } else {
        lead = await prisma.lead.update({
          where: { id: param(req, 'id') },
          data: leadData,
          select: leadDetailSelect,
        });
      }
    } catch (e) {
      if (e instanceof LocationResolutionError) {
        res.status(400).json({ error: e.message });
        return;
      }
      throw e;
    }

    // #233 / audit F-012: same write-path leak as getById. A walkthrough-only
    // TECHNICIAN reaches PATCH /:id via OWN_WALKTHROUGH (`update Lead`) but has no
    // `read Estimate` grant → strip the estimate's monetary fields before responding.
    // `lead` is response-bound only here (taxWarning is computed inside the tx, not from
    // estimate dollars), so this in-place strip is safe.
    await stripEstimateMoneyUnlessVisible(req, lead);

    const payload = await withTags(req, lead);
    void logAudit({ req, action: 'lead.updated', resourceType: 'Lead', resourceId: param(req, 'id'), metadata: { fields: Object.keys(leadData) } });
    res.json(taxWarning ? { lead: payload, tax_warning: taxWarning } : { lead: payload });
  } catch (err) {
    logger.error('Update lead error:', err);
    res.status(500).json({ error: 'Failed to update lead' });
  }
}

// ─── Casual Delete ───────────────────────────────────
//
// Entity-redesign §10: low-friction hard-delete, allowed ONLY when the lead has
// NO estimate AND no Payment anywhere in its subtree. NEVER cascades (the guards
// guarantee a childless lead). Force-purge (purgeLeadSubtree) is the separate
// admin-only audited path, not this.

export async function remove(req: Request, res: Response) {
  try {
    const id = param(req, 'id');
    const existing = await prisma.lead.findUnique({
      where: { id, ...tenantWhere(req) },
      include: {
        lead_assignees: { select: { user_id: true } },
        walkthrough_performers: { select: { user_id: true } },
      },
    });
    if (!existing) {
      res.status(404).json({ error: 'Lead not found' });
      return;
    }

    // #106 P1: SQL-based per-instance scope (nested-safe) — see update().
    if (!(await canAccessRow(req, 'Lead', prisma.lead, id))) {
      res.status(403).json({ error: 'Insufficient permissions' });
      return;
    }

    // Guard 1: no estimate on the lead.
    const estimateCount = await prisma.estimate.count({
      where: { ...tenantWhere(req), lead_id: id },
    });
    if (estimateCount > 0) {
      res.status(400).json({ error: 'Lead has estimates — cancel or mark lost instead' });
      return;
    }

    // Guard 2: no Payment anywhere in the lead subtree (invoices anchored by the
    // lead's estimates OR by jobs on those estimates).
    const paymentCount = await prisma.payment.count({
      where: {
        voided_at: null,
        invoice: {
          ...tenantWhere(req),
          OR: [
            { estimate: { lead_id: id } },
            { job: { estimate: { lead_id: id } } },
          ],
        },
      },
    });
    if (paymentCount > 0) {
      res.status(400).json({ error: 'Lead has recorded payments — cannot delete' });
      return;
    }

    await prisma.lead.delete({ where: { id } });
    void logAudit({ req, action: 'lead.deleted', resourceType: 'Lead', resourceId: id });
    res.status(204).send();
  } catch (err) {
    logger.error('Delete lead error:', err);
    res.status(500).json({ error: 'Failed to delete lead' });
  }
}

// Lead owner is SINGLE (Ran). `assigned_to` is one id (or null to clear). The owner is
// mirrored to BOTH commission_owner_id AND exactly one lead_assignees row (the Owned-scope
// key). NO owner↔performer auto-sync — walkthrough performers are an independent MULTI set.
export async function assign(req: Request, res: Response) {
  try {
    const id = param(req, 'id');
    const existing = await prisma.lead.findUnique({ where: { id, ...tenantWhere(req) } });
    if (!existing) {
      res.status(404).json({ error: 'Lead not found' });
      return;
    }

    // GAP-4: per-instance scope (nested-safe), mirroring update/contact/cancel/etc. The
    // route guard (canDo('assign','Lead')) is a BARE-subject check and does NOT bind the
    // row, so a row-scoped principal holding `assign` could otherwise reassign a lead it
    // cannot access. ADMIN/unconditional → fast-path true (no query).
    if (!(await canAccessRow(req, 'Lead', prisma.lead, id))) {
      res.status(403).json({ error: 'Insufficient permissions' });
      return;
    }

    const { assigned_to, notify } = req.body as {
      assigned_to: string | null;
      notify?: { in_app?: boolean };
    };

    // assigned_to === null clears the owner (commission_owner_id + all lead_assignees rows).
    if (assigned_to !== null) {
      const targetUser = await prisma.user.findUnique({
        where: { id: assigned_to, ...tenantWhere(req) },
        select: { id: true, role: true, is_active: true, organization_id: true },
      });

      if (!targetUser || !targetUser.is_active) {
        res.status(400).json({ error: 'Target user not found or inactive' });
        return;
      }

      if (!isOwnerEligible(targetUser.role)) {
        res.status(400).json({ error: 'This user is not eligible to be assigned as a lead owner' });
        return;
      }
    }

    const orgId = req.user!.organization_id;
    // Capture old owner BEFORE the update so lead.reassigned_away can reference it.
    const previousOwnerId = existing.commission_owner_id ?? null;
    const lead = await prisma.$transaction(async (tx) => {
      // Mirror the SINGLE owner into lead_assignees: drop all, then create exactly one.
      await tx.leadAssignee.deleteMany({ where: { lead_id: id } });
      if (assigned_to !== null) {
        await tx.leadAssignee.create({ data: { lead_id: id, user_id: assigned_to, organization_id: orgId } });
      }
      return tx.lead.update({
        where: { id },
        data: {
          commission_owner_id: assigned_to,
        },
        select: leadDetailSelect,
      });
    });

    // #233 / audit F-012: ability-gated strip before responding (no-op for estimate-readers).
    await stripEstimateMoneyUnlessVisible(req, lead);

    // Emit after the transaction commits.
    // #361: notify.in_app:false suppresses ONLY the new-owner notification; the outgoing
    // owner should always learn they were unassigned (lead.reassigned_away below).
    if (assigned_to !== null && notify?.in_app !== false) {
      await emit({
        verb: 'lead.assigned',
        organizationId: orgId,
        actorId: req.user?.id ?? null,
        object: { type: 'LEAD', id, label: existing.lead_number },
        entity: { commission_owner_id: assigned_to },
        data: { object_label: existing.lead_number },
      });
    }
    if (previousOwnerId !== null && previousOwnerId !== assigned_to) {
      await emit({
        verb: 'lead.reassigned_away',
        organizationId: orgId,
        actorId: req.user?.id ?? null,
        object: { type: 'LEAD', id, label: existing.lead_number },
        entity: { previous_owner_id: previousOwnerId },
        data: { object_label: existing.lead_number },
      });
    }

    // ─── Automation Center — post-commit, fire-and-forget (#271) ─────────────
    if (assigned_to !== null) {
      dispatchAutomationEvent({
        type: 'LEAD_ASSIGNED',
        organizationId: orgId,
        entity: { type: 'lead', id, label: existing.lead_number },
        occurrenceKey: assigned_to,
        actorId: req.user?.id ?? null,
      });
    }

    // #585 — record the sold-by (commission owner) change on the lead timeline. Written
    // OUTSIDE the tx, mirroring contactLead's precedent (top-level timelineEvent.create).
    if (previousOwnerId !== assigned_to) {
      const ownerName = lead.commission_owner
        ? `${lead.commission_owner.first_name} ${lead.commission_owner.last_name}`
        : null;
      await prisma.timelineEvent.create({
        data: {
          organization_id: orgId,
          entity_type: 'LEAD',
          entity_id: id,
          event_type: 'OWNER_CHANGED',
          description: assigned_to === null
            ? `Sold-by cleared on ${existing.lead_number}`
            : `${ownerName ?? 'New owner'} set as sold-by on ${existing.lead_number}`,
          created_by: req.user!.id,
        },
      });
    }

    res.json({ lead: await withTags(req, lead) });
  } catch (err) {
    logger.error('Assign lead error:', err);
    res.status(500).json({ error: 'Failed to assign lead' });
  }
}

// Walkthrough-as-entity redesign, PR-D2: writes the CURRENT visit's (D15) own notes/
// duration_minutes fields - the legacy Lead.walkthrough_notes/walkthrough_duration_minutes
// columns this handler used to dual-write are dropped, so the Walkthrough row is now the sole
// target.
export async function updateWalkthrough(req: Request, res: Response) {
  try {
    const id = param(req, 'id');
    const existing = await prisma.lead.findUnique({ where: { id, ...tenantWhere(req) } });
    if (!existing) {
      res.status(404).json({ error: 'Lead not found' });
      return;
    }

    // #106 P1: SQL-based per-instance scope (nested-safe) — see update().
    if (!(await canAccessRow(req, 'Lead', prisma.lead, id))) {
      res.status(403).json({ error: 'Insufficient permissions' });
      return;
    }

    // This endpoint now only handles notes and duration updates
    // Scheduling/completion/cancellation use dedicated endpoints
    const { walkthrough_notes, walkthrough_duration_minutes } = req.body;

    const current = await findCurrentWalkthroughForLead(req, id);

    const lead = await prisma.$transaction(async (tx) => {
      const updatedLead = await tx.lead.update({
        where: { id },
        data: {},
        select: leadDetailSelect,
      });
      if (current) {
        await tx.walkthrough.update({
          where: { id: current.id },
          data: {
            notes: walkthrough_notes ?? undefined,
            duration_minutes: walkthrough_duration_minutes ?? undefined,
          },
        });
      }
      return updatedLead;
    });

    // #233 / audit F-012: a walkthrough-only TECHNICIAN reaches this endpoint via
    // OWN_WALKTHROUGH (`update Lead`) but has no `read Estimate` grant → strip the
    // estimate's monetary fields before responding. Mirrors getById.
    await stripEstimateMoneyUnlessVisible(req, lead);

    res.json({ lead: await withTags(req, lead) });
  } catch (err) {
    logger.error('Update walkthrough error:', err);
    res.status(500).json({ error: 'Failed to update walkthrough' });
  }
}

// contactLead removed (D6, PR-B2) - contacted_at is inferred from outbound activity, never set
// by hand. Its route (POST /:id/contact) was also deleted (lead.routes.ts).

// ─── Schedule Walkthrough ────────────────────────────

/**
 * Dispatch WALKTHROUGH_PERFORMER_REMOVED for each removed performer, carrying
 * their identity as eventPayload.recipient — by the time an automation fires
 * they're already off the walkthrough, so nothing downstream can re-derive
 * who they were. Never throws: a lookup failure must not turn an otherwise-
 * successful performer change into a 500 (mirrors job.controller.ts's
 * dispatchTechUnassigned).
 */
async function dispatchWalkthroughPerformerRemoved(
  req: Request,
  removedIds: string[],
  lead: { id: string; label: string },
  orgId: string,
): Promise<void> {
  if (removedIds.length === 0) return;
  let removedUsers: { id: string; email: string | null; first_name: string; last_name: string }[] = [];
  try {
    removedUsers = (await prisma.user.findMany({
      where: { id: { in: removedIds }, ...tenantWhere(req) },
      select: { id: true, email: true, first_name: true, last_name: true },
    })) ?? [];
  } catch (err) {
    logger.warn('Failed to resolve removed performers for WALKTHROUGH_PERFORMER_REMOVED — dispatching without a recipient', err);
  }
  for (const uid of removedIds) {
    const u = removedUsers.find((x) => x.id === uid);
    dispatchAutomationEvent({
      type: 'WALKTHROUGH_PERFORMER_REMOVED',
      organizationId: orgId,
      entity: { type: 'lead', id: lead.id, label: lead.label },
      occurrenceKey: uid,
      actorId: req.user?.id ?? null,
      ...(u ? { eventPayload: { recipient: u } } : {}),
    });
  }
}

// Walkthrough performers are MULTI (REPLACE+diff, mirroring the job crew side). The schedule
// (time + SCHEDULED status on the Walkthrough row) is independent of the performer set. The
// customer "scheduled/rescheduled" automation is suppressed when there are 0 performers
// (Decision #9); the walkthrough_customer_email_sent_at flag is stamped only when performers≥1.
//
// Walkthrough-as-entity redesign, PR-B2 (D2/D5): the status guard is DELETED entirely — visit
// events push the lead forward, the lead's status never gates a visit action. The only status
// side effect left is D5's: booking on a NEW lead advances it to CONTACTED; every other status
// is left exactly as it is (never pulled backward). This creates-or-updates a Walkthrough row
// instead of stamping the lead directly; see walkthrough.service.ts's scheduleActiveWalkthrough.
export async function scheduleWalkthrough(req: Request, res: Response) {
  try {
    const id = param(req, 'id');
    const existing = await prisma.lead.findUnique({ where: { id, ...tenantWhere(req) } });
    if (!existing) { res.status(404).json({ error: 'Lead not found' }); return; }
    // #106 P1: SQL-based per-instance scope (nested-safe) — see update().
    if (!(await canAccessRow(req, 'Lead', prisma.lead, id))) { res.status(403).json({ error: 'Insufficient permissions' }); return; }

    const { walkthrough_scheduled_at, performer_ids, walkthrough_duration_minutes, send_email, force } = req.body as {
      walkthrough_scheduled_at: string;
      performer_ids: string[];
      walkthrough_duration_minutes?: number;
      send_email?: boolean;
      force?: boolean;
    };

    // Per-member eligibility: every performer must be an active, assignable in-org user.
    const performers = await validatePerformers(req, performer_ids);
    if (!performers.ok) {
      res.status(performers.status).json({ error: performers.error });
      return;
    }

    const durationMinutes = walkthrough_duration_minutes || 60;
    const scheduledStart = new Date(walkthrough_scheduled_at);
    const scheduledEnd = new Date(scheduledStart.getTime() + durationMinutes * 60_000);

    // The lead's active (REQUESTED/SCHEDULED) visit, if any. Reusing it is a (re)schedule of
    // the SAME visit; when the last visit already finished (COMPLETED/CANCELLED — or there is
    // none at all), this books a fresh, distinct visit (D1 — a lead has many walkthroughs).
    const activeWalkthrough = await findActiveWalkthrough(req, id);
    const wasAlreadyScheduled = activeWalkthrough?.status === 'SCHEDULED';

    // Diff vs the CURRENT performer set (drives conflict scope + diff-emails).
    const currentIds = new Set((activeWalkthrough?.performers ?? []).map((p) => p.user_id));
    const nextIds = new Set(performer_ids);
    const addedIds = performer_ids.filter((uid) => !currentIds.has(uid));
    const keptIds = performer_ids.filter((uid) => currentIds.has(uid));
    const removedIds = [...currentIds].filter((uid) => !nextIds.has(uid));

    // Did the time change? (a kept performer at a brand-new slot can newly collide elsewhere.)
    const timeChanged =
      (activeWalkthrough?.scheduled_at?.getTime() ?? null) !== scheduledStart.getTime();

    // Conflict detection: PER added member; plus KEPT members only when the time also changed.
    if (!force) {
      const conflictUserIds = timeChanged ? [...addedIds, ...keptIds] : addedIds;
      const conflicts = await detectPerformerConflicts(req, {
        leadId: id,
        userIds: conflictUserIds,
        schedStart: scheduledStart,
        schedEnd: scheduledEnd,
      });
      if (conflicts.length > 0) {
        res.status(409).json({ error: 'Schedule conflict detected', conflicts });
        return;
      }
    }

    // Customer "scheduled/rescheduled" automation only when performers≥1. Stamp the flag on the
    // first such send (mirror the job first-schedule/flag pattern). The flag now lives on the
    // Walkthrough row (customer_email_sent_at), not the lead.
    const hasPerformers = performer_ids.length > 0;
    const stampCustomerFlag = hasPerformers && activeWalkthrough?.customer_email_sent_at == null;

    const orgId = req.user!.organization_id;
    const { lead, isReschedule } = await prisma.$transaction(async (tx) => {
      const { walkthrough, isReschedule: reschedule } = await scheduleActiveWalkthrough(tx, {
        leadId: id,
        orgId,
        activeWalkthroughId: activeWalkthrough?.id ?? null,
        wasAlreadyScheduled,
        scheduledAt: scheduledStart,
        durationMinutes,
        stampCustomerEmailSentAt: stampCustomerFlag,
      });
      await replaceWalkthroughPerformers(tx, walkthrough.id, id, orgId, performer_ids);

      // D5: the ONLY status side effect — advance NEW -> CONTACTED. Every other status is
      // left untouched (never pulled backward into a walkthrough-labeled status).
      const statusPatch = existing.status === 'NEW' ? { status: 'CONTACTED' as const } : {};

      const updatedLead = await tx.lead.update({
        where: { id },
        data: statusPatch,
        select: leadDetailSelect,
      });

      await tx.timelineEvent.create({
        data: {
          organization_id: orgId,
          entity_type: 'LEAD', entity_id: id,
          event_type: reschedule ? 'WALKTHROUGH_RESCHEDULED' : 'WALKTHROUGH_SCHEDULED',
          description: reschedule
            ? `Walkthrough rescheduled for ${scheduledStart.toISOString()}`
            : `Walkthrough scheduled for ${scheduledStart.toISOString()}`,
          metadata: { performer_ids, duration: durationMinutes, send_email },
          created_by: req.user!.id,
        },
      });

      return { lead: updatedLead, isReschedule: reschedule };
    });

    // #233 / audit F-012: ability-gated strip before responding (no-op for estimate-readers).
    await stripEstimateMoneyUnlessVisible(req, lead);

    await emit({
      verb: 'lead.walkthrough_scheduled',
      organizationId: orgId,
      actorId: req.user?.id ?? null,
      object: { type: 'LEAD', id, label: existing.lead_number },
      entity: {
        performer_ids,
        commission_owner_id: existing.commission_owner_id ?? null,
      },
      data: { object_label: existing.lead_number },
    });

    // ─── Automation Center — post-commit, fire-and-forget (#271) ─────────────
    // Narrowed to match the (deleted) hard-coded email gates exactly: send_email:false
    // suppresses this WHOLE block, parity with the email gate below (which wrapped both
    // the customer email and the performer diff emails); WALKTHROUGH_SCHEDULED/
    // _RESCHEDULED additionally requires hasPerformers — the state-4 0-performer
    // schedule sent nothing before and must not start sending now.
    if (send_email !== false) {
      if (hasPerformers) {
        dispatchAutomationEvent({
          type: isReschedule ? 'WALKTHROUGH_RESCHEDULED' : 'WALKTHROUGH_SCHEDULED',
          organizationId: orgId,
          entity: { type: 'lead', id, label: existing.lead_number },
          occurrenceKey: scheduledStart.toISOString(),
          actorId: req.user?.id ?? null,
        });
      }
      for (const uid of addedIds) {
        const addedUser = performers.users.find((x) => x.id === uid);
        dispatchAutomationEvent({
          type: 'WALKTHROUGH_PERFORMER_ASSIGNED',
          organizationId: orgId,
          entity: { type: 'lead', id, label: existing.lead_number },
          occurrenceKey: uid,
          actorId: req.user?.id ?? null,
          ...(addedUser ? { eventPayload: { recipient: addedUser } } : {}),
        });
      }
      await dispatchWalkthroughPerformerRemoved(req, removedIds, { id, label: existing.lead_number }, orgId);
    }
    if (isReschedule) {
      void rearmAnchoredWaits('lead', id);
    }

    res.json({ lead: await withTags(req, lead) });
  } catch (err) {
    logger.error('Schedule walkthrough error:', err);
    res.status(500).json({ error: 'Failed to schedule walkthrough' });
  }
}

// ─── Set Walkthrough Performers (performer-only REPLACE) ──
//
// REPLACE the performer set without touching status/time. Diff-emails per added/removed
// performer; NO customer email, NO flag change. Mirrors the job /assignees handler.
//
// Walkthrough-as-entity redesign, PR-B2: today this had NO status guard at all — performers
// could be swapped on a lead in ANY status, including a WON/LOST one whose visit is long over.
// New guard: performers can only be set on the lead's ACTIVE (REQUESTED/SCHEDULED) visit — this
// rejects the terminal (COMPLETED/CANCELLED) case and the "no visit at all" case (nothing to
// attach a crew to), by the same check.
export async function setPerformers(req: Request, res: Response) {
  try {
    const id = param(req, 'id');
    const existing = await prisma.lead.findUnique({ where: { id, ...tenantWhere(req) } });
    if (!existing) { res.status(404).json({ error: 'Lead not found' }); return; }
    // #106 P1: SQL-based per-instance scope (nested-safe) — see update().
    if (!(await canAccessRow(req, 'Lead', prisma.lead, id))) { res.status(403).json({ error: 'Insufficient permissions' }); return; }

    const { performer_ids } = req.body as { performer_ids: string[] };

    const performers = await validatePerformers(req, performer_ids);
    if (!performers.ok) {
      res.status(performers.status).json({ error: performers.error });
      return;
    }

    const activeWalkthrough = await findActiveWalkthrough(req, id);
    if (!activeWalkthrough) {
      res.status(400).json({ error: 'No active walkthrough to set performers on' });
      return;
    }

    const currentIds = new Set(activeWalkthrough.performers.map((p) => p.user_id));
    const nextIds = new Set(performer_ids);
    const addedIds = performer_ids.filter((uid) => !currentIds.has(uid));
    const removedIds = [...currentIds].filter((uid) => !nextIds.has(uid));

    const orgId = req.user!.organization_id;
    const lead = await prisma.$transaction(async (tx) => {
      await replaceWalkthroughPerformers(tx, activeWalkthrough.id, id, orgId, performer_ids);
      // Re-read via the detail select (performer-only mutation; status/schedule untouched).
      return tx.lead.findUnique({ where: { id }, select: leadDetailSelect });
    });

    // The row was loaded above and is only mutated (never deleted) inside the tx.
    // #233 / audit F-012: ability-gated strip before responding (no-op for estimate-readers).
    await stripEstimateMoneyUnlessVisible(req, lead!);
    res.json({ lead: await withTags(req, lead!) });

    // ─── Automation Center — post-commit, fire-and-forget (#271) ─────────────
    for (const uid of addedIds) {
      const addedUser = performers.users.find((x) => x.id === uid);
      dispatchAutomationEvent({
        type: 'WALKTHROUGH_PERFORMER_ASSIGNED',
        organizationId: orgId,
        entity: { type: 'lead', id, label: existing.lead_number },
        occurrenceKey: uid,
        actorId: req.user?.id ?? null,
        ...(addedUser ? { eventPayload: { recipient: addedUser } } : {}),
      });
    }
    await dispatchWalkthroughPerformerRemoved(req, removedIds, { id, label: existing.lead_number }, orgId);
  } catch (err) {
    logger.error('Set walkthrough performers error:', err);
    if (!res.headersSent) {
      res.status(500).json({ error: 'Failed to set walkthrough performers' });
    }
  }
}

// ─── Unschedule Walkthrough ──────────────────────────
//
// Clear the walkthrough TIME → status CONTACTED. KEEPS the performers (crew ⟂ schedule).
// Built FRESH: NO email, NO cancellation stamp (distinct from cancelWalkthrough, which
// records a reason + emails). Mirrors the job /unassign handler.
//
// Walkthrough-as-entity redesign, PR-B2: the guard moves onto the visit's own status (only a
// SCHEDULED visit can be unscheduled); the row returns to REQUESTED, performers retained — this
// already matches current behavior, just repointed onto the new table. Walkthrough update +
// lead update + timeline write now share ONE transaction (previously the timeline write sat
// outside it — a failed insert could leave a committed status change with no audit trail).
export async function unscheduleWalkthrough(req: Request, res: Response) {
  try {
    const id = param(req, 'id');
    const existing = await prisma.lead.findUnique({ where: { id, ...tenantWhere(req) } });
    if (!existing) { res.status(404).json({ error: 'Lead not found' }); return; }
    // #106 P1: SQL-based per-instance scope (nested-safe) — see update().
    if (!(await canAccessRow(req, 'Lead', prisma.lead, id))) { res.status(403).json({ error: 'Insufficient permissions' }); return; }

    const scheduled = await findScheduledWalkthrough(req, id);
    if (!scheduled) {
      res.status(400).json({ error: 'Can only unschedule a scheduled walkthrough' });
      return;
    }

    const orgId = req.user!.organization_id;
    const lead = await prisma.$transaction(async (tx) => {
      await unscheduleWalkthroughRow(tx, scheduled.id);
      const updatedLead = await tx.lead.update({
        where: { id },
        data: { status: 'CONTACTED' },
        select: leadDetailSelect,
      });
      await tx.timelineEvent.create({
        data: {
          organization_id: orgId,
          entity_type: 'LEAD', entity_id: id,
          event_type: 'WALKTHROUGH_UNSCHEDULED',
          description: 'Walkthrough unscheduled',
          created_by: req.user!.id,
        },
      });
      return updatedLead;
    });

    // #233 / audit F-012: ability-gated strip before responding (no-op for estimate-readers).
    await stripEstimateMoneyUnlessVisible(req, lead);

    res.json({ lead: await withTags(req, lead) });
  } catch (err) {
    logger.error('Unschedule walkthrough error:', err);
    res.status(500).json({ error: 'Failed to unschedule walkthrough' });
  }
}

// ─── Complete Walkthrough ────────────────────────────
//
// Walkthrough-as-entity redesign, PR-B2: the guard moves onto the visit's own status (only a
// SCHEDULED visit can be completed).
//
// PERMISSION CHANGE (flagged explicitly per the task): this was the one handler that never
// called canAccessRow — it hand-rolled `manage('all') || is-performer` instead, so a DISPATCHER
// who was not personally a performer on this specific visit got 403'd, unlike every sibling
// handler (schedule/unschedule/cancel), which all resolve through canAccessRow('Lead') and so
// pass DISPATCHER's unconditional `read Lead` grant. Repointed onto canAccessRow('Lead') for
// consistency with those siblings — it resolves through the SAME read-Lead grant condition
// every other handler already uses (OWN_WALKTHROUGH for TECHNICIAN, now enforced against the
// Walkthrough's performers relation via the nested walkthroughs -> performers join in
// defaultGrants.ts; OWN_LEAD for SALES; unconditional for DISPATCHER/ADMIN). Net effect:
// DISPATCHER can now complete any walkthrough in the org (matches its unconditional authority
// everywhere else — job complete/cancel, etc.), and a TECHNICIAN who performed on ANY of this
// lead's visits (not only the one being completed) can complete whichever visit is currently
// SCHEDULED — a narrow widening now that a lead can have multiple visits, functionally
// identical to before under the old one-visit-per-lead model.
export async function completeWalkthrough(req: Request, res: Response) {
  try {
    const id = param(req, 'id');
    const existing = await prisma.lead.findUnique({ where: { id, ...tenantWhere(req) } });
    if (!existing) { res.status(404).json({ error: 'Lead not found' }); return; }

    const scheduled = await findScheduledWalkthrough(req, id);
    if (!scheduled) {
      res.status(400).json({ error: 'Can only complete a scheduled walkthrough' });
      return;
    }

    if (!(await canAccessRow(req, 'Lead', prisma.lead, id))) {
      res.status(403).json({ error: 'Only the assigned performer, Admin, or Dispatcher can complete this walkthrough' });
      return;
    }

    const orgId = req.user!.organization_id;
    const completedAt = new Date();
    const lead = await prisma.$transaction(async (tx) => {
      await completeWalkthroughRow(tx, scheduled.id, completedAt);
      // PR-C2: WALKTHROUGH_COMPLETED left LeadStatus - completing a visit is now purely a fact
      // recorded on the Walkthrough row, not a lead-pipeline transition. The lead's status is
      // left exactly where the earlier schedule call (D5: NEW -> CONTACTED only) put it.
      const updatedLead = await tx.lead.update({
        where: { id },
        data: {},
        select: leadDetailSelect,
      });
      await tx.timelineEvent.create({
        data: {
          organization_id: orgId,
          entity_type: 'LEAD', entity_id: id,
          event_type: 'WALKTHROUGH_COMPLETED',
          description: 'Walkthrough completed',
          created_by: req.user!.id,
        },
      });
      return updatedLead;
    });

    // #233 / audit F-012: ability-gated strip before responding (no-op for estimate-readers).
    await stripEstimateMoneyUnlessVisible(req, lead);

    res.json({ lead: await withTags(req, lead) });

    // ─── Automation Center — post-commit, fire-and-forget (#271) ─────────────
    dispatchAutomationEvent({
      type: 'WALKTHROUGH_COMPLETED',
      organizationId: orgId,
      entity: { type: 'lead', id, label: existing.lead_number },
      actorId: req.user?.id ?? null,
    });
  } catch (err) {
    logger.error('Complete walkthrough error:', err);
    res.status(500).json({ error: 'Failed to complete walkthrough' });
  }
}

// ─── Cancel Walkthrough ──────────────────────────────
//
// Walkthrough-as-entity redesign, PR-B2: the guard moves onto the visit's own status (only a
// SCHEDULED visit can be cancelled). Per D12, a cancelled visit with nothing rebooked leaves a
// FRESH REQUESTED row for the same lead so it reappears in the scheduler bucket — it does not
// just go CANCELLED and stop (cancelWalkthroughRow in walkthrough.service.ts does both writes).
export async function cancelWalkthrough(req: Request, res: Response) {
  try {
    const id = param(req, 'id');
    const existing = await prisma.lead.findUnique({ where: { id, ...tenantWhere(req) } });
    if (!existing) { res.status(404).json({ error: 'Lead not found' }); return; }
    // #106 P1: SQL-based per-instance scope (nested-safe) — see update().
    if (!(await canAccessRow(req, 'Lead', prisma.lead, id))) { res.status(403).json({ error: 'Insufficient permissions' }); return; }

    const scheduled = await findScheduledWalkthrough(req, id);
    if (!scheduled) {
      res.status(400).json({ error: 'Can only cancel a scheduled walkthrough' });
      return;
    }

    const orgId = req.user!.organization_id;
    const cancelledAt = new Date();
    const reason = req.body.cancelled_reason;
    const lead = await prisma.$transaction(async (tx) => {
      await cancelWalkthroughRow(tx, {
        walkthroughId: scheduled.id, leadId: id, orgId,
        cancelledAt, reason, cancelledBy: req.user!.id,
      });
      const updatedLead = await tx.lead.update({
        where: { id },
        data: { status: 'CONTACTED' },
        select: leadDetailSelect,
      });
      await tx.timelineEvent.create({
        data: {
          organization_id: orgId,
          entity_type: 'LEAD', entity_id: id,
          event_type: 'WALKTHROUGH_CANCELLED',
          description: `Walkthrough cancelled: ${reason}`,
          created_by: req.user!.id,
        },
      });
      return updatedLead;
    });

    // #233 / audit F-012: ability-gated strip before responding (no-op for estimate-readers).
    await stripEstimateMoneyUnlessVisible(req, lead);

    res.json({ lead: await withTags(req, lead) });

    // ─── Automation Center — post-commit, fire-and-forget (#271) ─────────────
    dispatchAutomationEvent({
      type: 'WALKTHROUGH_CANCELLED',
      organizationId: orgId,
      entity: { type: 'lead', id, label: existing.lead_number },
      actorId: req.user?.id ?? null,
      eventPayload: { mergeFields: { 'event.reason': reason } },
    });
  } catch (err) {
    logger.error('Cancel walkthrough error:', err);
    res.status(500).json({ error: 'Failed to cancel walkthrough' });
  }
}

// ─── Cancel Lead ─────────────────────────────────────

// Walkthrough-as-entity redesign, PR-B2: auto-cancel now writes the Walkthrough row (via
// autoCancelScheduledWalkthroughOnLeadExit), keyed on the visit's own SCHEDULED status rather
// than lead.status. Deliberately does NOT rebook a fresh REQUESTED row the way a standalone
// cancelWalkthrough does (D12) — the lead itself is now CANCELLED, so it must not reappear in
// the "needs scheduling" bucket.
export async function cancelLead(req: Request, res: Response) {
  try {
    const id = param(req, 'id');
    const existing = await prisma.lead.findUnique({ where: { id, ...tenantWhere(req) } });
    if (!existing) { res.status(404).json({ error: 'Lead not found' }); return; }
    // #106 P1: SQL-based per-instance scope (nested-safe) — see update().
    if (!(await canAccessRow(req, 'Lead', prisma.lead, id))) { res.status(403).json({ error: 'Insufficient permissions' }); return; }

    if (existing.status === 'WON' || existing.status === 'LOST' || existing.status === 'CANCELLED') {
      res.status(400).json({ error: `Cannot cancel a ${existing.status.toLowerCase()} lead` });
      return;
    }

    const orgId = req.user!.organization_id;
    const scheduled = await findScheduledWalkthrough(req, id);
    const cancelledAt = new Date();

    const lead = await prisma.$transaction(async (tx) => {
      await autoCancelScheduledWalkthroughOnLeadExit(tx, scheduled, {
        cancelledAt, reason: 'Lead cancelled', cancelledBy: req.user!.id,
      });

      const updatedLead = await tx.lead.update({
        where: { id },
        data: {
          status: 'CANCELLED',
          cancelled_at: cancelledAt,
          cancelled_reason: req.body.cancelled_reason,
        },
        select: leadDetailSelect,
      });

      await tx.timelineEvent.create({
        data: {
          organization_id: orgId,
          entity_type: 'LEAD', entity_id: id,
          event_type: 'STATUS_CHANGE',
          description: scheduled
            ? 'Lead cancelled — walkthrough auto-cancelled'
            : 'Lead cancelled',
          created_by: req.user!.id,
        },
      });

      return updatedLead;
    });

    // Cancel all active estimates for this lead
    await prisma.estimate.updateMany({
      where: {
        ...tenantWhere(req),
        lead_id: id,
        status: { in: ['DRAFT', 'SENT', 'PENDING'] },
      },
      data: {
        status: ESTIMATE_STATUS.ARCHIVED,
        cancelled_at: new Date(),
        cancelled_reason: 'Lead cancelled',
      },
    });

    // Void any UNPAID kind=DEPOSIT Invoice on the lead's estimates (the SOLE deposit document).
    const leadEstimates = await prisma.estimate.findMany({
      where: { ...tenantWhere(req), lead_id: id },
      select: { id: true },
    });
    await voidUnpaidDepositInvoices(req, leadEstimates.map(e => e.id));

    // #233 / audit F-012: ability-gated strip before responding (no-op for estimate-readers).
    // The deposit-void logic above queries estimates fresh by lead_id (id only) and never
    // reads `lead.estimates`' monetary fields, so this in-place strip is response-bound only.
    await stripEstimateMoneyUnlessVisible(req, lead);

    res.json({ lead: await withTags(req, lead) });
  } catch (err) {
    logger.error('Cancel lead error:', err);
    res.status(500).json({ error: 'Failed to cancel lead' });
  }
}

// ─── Stats ────────────────────────────────────────────

export async function getStats(req: Request, res: Response) {
  try {
    const now = new Date();
    const startOfWeek = new Date(now);
    startOfWeek.setDate(now.getDate() - now.getDay());
    startOfWeek.setHours(0, 0, 0, 0);

    const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);

    const orgWhere = tenantWhere(req);
    // GAP-3: scope the aggregates to the requester the SAME way the list endpoint does
    // (buildLeadListWhere → scopeWhereForReq). ADMIN/DISPATCHER resolve to {} (org-wide);
    // a row-scoped role (SALES → OWN_LEAD) gets the owner condition on EVERY count, so the
    // stats cards never expose org-wide totals/won/lost to an own-lead-scoped user.
    const scopeWhere = await scopeWhereForReq(req, 'Lead');
    const [total, newThisWeek, unassigned, wonThisMonth, lostThisMonth] = await Promise.all([
      prisma.lead.count({ where: { ...orgWhere, ...scopeWhere } }),
      prisma.lead.count({ where: { ...orgWhere, ...scopeWhere, created_at: { gte: startOfWeek } } }),
      prisma.lead.count({ where: { ...orgWhere, ...scopeWhere, status: { in: ['NEW', 'CONTACTED'] }, AND: [{ lead_assignees: { none: {} } }] } }),
      prisma.lead.count({ where: { ...orgWhere, ...scopeWhere, status: 'WON', updated_at: { gte: startOfMonth } } }),
      prisma.lead.count({ where: { ...orgWhere, ...scopeWhere, status: 'LOST', lost_at: { gte: startOfMonth } } }),
    ]);

    res.json({ total, new_this_week: newThisWeek, unassigned, won_this_month: wonThisMonth, lost_this_month: lostThisMonth });
  } catch (err) {
    logger.error('Get lead stats error:', err);
    res.status(500).json({ error: 'Failed to get lead stats' });
  }
}

// ─── Lead Notes ───────────────────────────────────────

export const createLeadNoteSchema = z.object({
  content: z.string().min(1).max(5000),
});

export async function getNotes(req: Request, res: Response) {
  try {
    const id = param(req, 'id');

    const lead = await prisma.lead.findUnique({ where: { id, ...tenantWhere(req) } });
    if (!lead) {
      res.status(404).json({ error: 'Lead not found' });
      return;
    }

    // #106 P1: per-instance scope — mirror getById/update. The route guard (`read Lead`) is
    // CONDITIONAL for SALES (OWN_LEAD) and TECHNICIAN (OWN_WALKTHROUGH); without this an
    // own-scoped role could read notes on a lead it doesn't own (in-tenant cross-user leak).
    if (!(await canAccessRow(req, 'Lead', prisma.lead, id))) {
      res.status(403).json({ error: 'Insufficient permissions' });
      return;
    }

    const notes = await prisma.note.findMany({
      where: { entity_type: 'LEAD', entity_id: id, ...tenantWhere(req) },
      select: {
        id: true,
        content: true,
        created_at: true,
        creator: { select: { id: true, first_name: true, last_name: true } },
      },
      orderBy: { created_at: 'desc' },
    });

    res.json({ notes });
  } catch (err) {
    logger.error('Get lead notes error:', err);
    res.status(500).json({ error: 'Failed to get lead notes' });
  }
}

// #585 — expose the LEAD timeline (status/owner/dispatcher changes) to the activity panel.
export async function getTimeline(req: Request, res: Response) {
  try {
    const id = param(req, 'id');

    const lead = await prisma.lead.findUnique({ where: { id, ...tenantWhere(req) } });
    if (!lead) {
      res.status(404).json({ error: 'Lead not found' });
      return;
    }

    // Per-instance scope — mirror getNotes (own-scoped SALES/TECHNICIAN must not read
    // a lead timeline they don't own).
    if (!(await canAccessRow(req, 'Lead', prisma.lead, id))) {
      res.status(403).json({ error: 'Insufficient permissions' });
      return;
    }

    const events = await prisma.timelineEvent.findMany({
      where: { entity_type: 'LEAD', entity_id: id, ...tenantWhere(req) },
      select: {
        id: true,
        event_type: true,
        description: true,
        metadata: true,
        created_at: true,
        creator: { select: { id: true, first_name: true, last_name: true } },
      },
      orderBy: { created_at: 'desc' },
    });

    res.json({ events });
  } catch (err) {
    logger.error('Get lead timeline error:', err);
    res.status(500).json({ error: 'Failed to get timeline' });
  }
}

export async function addNote(req: Request, res: Response) {
  try {
    const id = param(req, 'id');

    const lead = await prisma.lead.findUnique({ where: { id, ...tenantWhere(req) } });
    if (!lead) {
      res.status(404).json({ error: 'Lead not found' });
      return;
    }

    // #106 P1: per-instance scope — mirror update(). The route guard (`update Lead`) is
    // CONDITIONAL for SALES (OWN_LEAD); without this an own-scoped role could write a note
    // onto a lead it doesn't own (in-tenant cross-user write leak).
    if (!(await canAccessRow(req, 'Lead', prisma.lead, id))) {
      res.status(403).json({ error: 'Insufficient permissions' });
      return;
    }

    const note = await prisma.note.create({
      data: {
        entity_type: 'LEAD',
        entity_id: id,
        content: req.body.content,
        created_by: req.user!.id,
        organization_id: req.user!.organization_id,
      },
      select: {
        id: true,
        content: true,
        created_at: true,
        creator: { select: { id: true, first_name: true, last_name: true } },
      },
    });

    res.status(201).json({ note });
  } catch (err) {
    logger.error('Add lead note error:', err);
    res.status(500).json({ error: 'Failed to add note' });
  }
}

// ─── Mark Lost ────────────────────────────────────────

// Walkthrough-as-entity redesign, PR-B2: same auto-cancel repoint as cancelLead — the trigger is
// the Walkthrough row's own SCHEDULED status, and no fresh REQUESTED row is rebooked (the lead
// is now LOST, so it must not reappear in the "needs scheduling" bucket).
export async function markLost(req: Request, res: Response) {
  try {
    const id = param(req, 'id');
    const existing = await prisma.lead.findUnique({ where: { id, ...tenantWhere(req) } });
    if (!existing) {
      res.status(404).json({ error: 'Lead not found' });
      return;
    }

    // #106 P1: SQL-based per-instance scope (nested-safe) — see update().
    if (!(await canAccessRow(req, 'Lead', prisma.lead, id))) {
      res.status(403).json({ error: 'Insufficient permissions' });
      return;
    }

    if (existing.status === 'LOST' || existing.status === 'WON' || existing.status === 'CANCELLED') {
      res.status(400).json({ error: `Cannot mark a ${existing.status.toLowerCase()} lead as lost` });
      return;
    }

    const orgId = req.user!.organization_id;
    const scheduled = await findScheduledWalkthrough(req, id);
    const cancelledAt = new Date();

    const lead = await prisma.$transaction(async (tx) => {
      await autoCancelScheduledWalkthroughOnLeadExit(tx, scheduled, {
        cancelledAt, reason: 'Lead marked as lost', cancelledBy: req.user!.id,
      });

      const updatedLead = await tx.lead.update({
        where: { id },
        data: {
          status: 'LOST',
          lost_at: new Date(),
          lost_reason: req.body.lost_reason,
        },
        select: leadDetailSelect,
      });

      // Log timeline event
      await tx.timelineEvent.create({
        data: {
          organization_id: orgId,
          entity_type: 'LEAD',
          entity_id: id,
          event_type: 'STATUS_CHANGE',
          description: scheduled
            ? 'Lead marked as lost — walkthrough auto-cancelled'
            : 'Lead marked as lost',
          created_by: req.user!.id,
        },
      });

      return updatedLead;
    });

    // Cancel all active estimates for this lead
    await prisma.estimate.updateMany({
      where: {
        ...tenantWhere(req),
        lead_id: id,
        status: { in: ['DRAFT', 'SENT', 'PENDING'] },
      },
      data: {
        status: ESTIMATE_STATUS.ARCHIVED,
        cancelled_at: new Date(),
        cancelled_reason: 'Lead marked as lost',
      },
    });

    // Void any UNPAID kind=DEPOSIT Invoice on the lead's estimates (the SOLE deposit document).
    const leadEstimates = await prisma.estimate.findMany({
      where: { ...tenantWhere(req), lead_id: id },
      select: { id: true },
    });
    await voidUnpaidDepositInvoices(req, leadEstimates.map(e => e.id));

    // #233 / audit F-012: ability-gated strip before responding (no-op for estimate-readers).
    // The deposit-void logic above queries estimates fresh by lead_id (id only) and never
    // reads `lead.estimates`' monetary fields, so this in-place strip is response-bound only.
    await stripEstimateMoneyUnlessVisible(req, lead);

    res.json({ lead: await withTags(req, lead) });
  } catch (err) {
    logger.error('Mark lost error:', err);
    res.status(500).json({ error: 'Failed to mark lead as lost' });
  }
}
