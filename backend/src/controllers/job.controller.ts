import { Request, Response } from 'express';
import { z } from 'zod';
import { Prisma, JobStatus } from '@prisma/client';
import { prisma } from '../lib/prisma';
import { logger } from '../lib/logger';
import { parsePagination, buildPaginationMeta, parseSortParams, respondInvalidSort } from '../lib/pagination';
import { JOB_SORT_FIELDS } from '../lib/sortFields';
import { parseArrayParam } from '../lib/query/parseArrayParam';
import { applyFilters } from '../lib/query/filterEngine';
import { jobFacets } from '../lib/query/registries/job.filters';
import { tenantWhere } from '../lib/tenant';
import { allocateNumber } from '../lib/numbering';
import { computeJobBilling } from '../lib/jobBilling';
import { recomputeInvoiceTotals } from '../lib/invoice-totals';
import { asScopeArray, toScopeForTotals } from '../lib/scopes';
import { findDuplicateCustomer } from '../lib/customer-duplicate';
import { withRequiredCustomerFields } from '../lib/customer-create';
import { optionalCustomerEmail, hasPhoneOrEmail, CONTACT_REQUIRED_MSG } from '../lib/email-schema';
import { optionalCustomerPhone } from '../lib/phone-schema';
import { hasNameOrCompany } from '../lib/customer-kind';
import { accreteContactMethods } from '../lib/customer-accretion';
import { resolveOrAccreteLocation, buildLocationTaxWarning, LocationResolutionError } from '../lib/service-location';
import { loadTagsByEntity, loadTagsForEntity, type TagSummary } from '../lib/tags';
import { mergeCustomFields, validateCustomFieldValues, CustomFieldValidationError } from '../lib/custom-fields';
import { ESTIMATE_STATUS } from '../constants/estimateStatus';
import { signAvatarPaths, resolveAvatarUrl } from '../lib/avatar';
// Creator tracking (audit only) - stamped at every create, never read for authorization here.
import { createdByUser } from '../lib/created-by';
// job-owns-tax-discount (E1) - the job stamps its own tax_rate at create time, the same
// state-lookup estimate.controller.ts uses.
import { resolveTaxRateForState } from '../lib/tax/resolveTaxRate';
// Inventory P1 (§4.2/§4.3) — job cancel/delete auto-return SYNCED lines through the shared
// inv-stock return loop (applyStockMovement stays the only StockBalance write path).
import { returnSyncedLines } from './inv-stock.controller';
// Logistic Orders (spec §14 C1) — job cancel/delete unwind the LOs anchored to the job: resolve
// them pre-tx (pool discipline), then return/cancel them inside the existing transaction.
import { collectAnchoredLoUnwind, applyAnchoredLoUnwind } from '../lib/logisticOrders';
// SERV10X-38 Task 5 — createInvoiceFromJob() reuses these to draw down a paid estimate
// deposit as credit onto a job-owned-items invoice (see invoice.controller.create() ~L610-650).
import {
  DEPOSIT_CREDIT_REFERENCE,
  resolvePaidDepositInvoices,
  computeDepositCredit,
  applyDepositCreditsWithPayments,
  depositEstimateIds,
} from '../lib/deposit-credit';
// SRVW-84 (#1169) - credits-aware cash derivation for the job-financials aggregate below.
import { amountPaidOf, creditsTotalOf } from '../lib/invoice-editable';
import { jobLineToInvoiceLineCreate } from '../lib/invoice-lines-from-job';
import type { Action, Subject } from '../lib/permissions/catalog';
import { isAssignable, isDispatcherEligible } from '../lib/permissions/assignableRoles';
import { canAccessRow, canActOnRow, scopeWhereForReq, canSeePricing } from '../lib/permissions/enforce';
import { validationFailure, zodValidationFailure } from '../middleware/validate';
import { emit } from '../services/notifications/notificationService';
import { dispatchAutomationEvent } from '../services/automations/dispatch';
import { rearmAnchoredWaits } from '../services/automations/enrollment';
import { resolveScheduleJobNotifications } from '../services/notifications/resolveNotifications';
import { addOrFilter } from '../lib/permissions/whereCompose';
import { logAudit } from '../lib/audit';
import { milestoneClears, clearsCompletion } from '../lib/job-milestones';
import { subStatusClears } from '../lib/job-sub-status';
import { walkthroughSnapshotSelect, projectLeadWalkthroughFields } from '../services/walkthrough.service';

// ─── Select Objects ────────────────────────────────────

async function revertPlanVisitOnUncomplete(
  req: Request,
  jobId: string,
  sourcePlanId: string | null | undefined,
) {
  if (!sourcePlanId) return;
  await prisma.planVisit.updateMany({
    where: { job_id: jobId, status: 'COMPLETED', ...tenantWhere(req) },
    data: { status: 'SCHEDULED', completed_at: null },
  });
}

const jobListSelect = {
  id: true,
  job_number: true,
  status: true,
  // Creation confers control (technician-ownership spec, Part C). The LIST needs it for the same
  // reason the detail payload does: the bulk Assign action is offered from here, and `assign Job` is
  // creator-scoped for a technician - without this the page can only ask the subject-level question,
  // which is true for every technician, and would offer a bulk action the API refuses per row.
  created_by_id: true,
  // SRVW-112 - the org-defined label rendered inside the list's existing Status cell.
  sub_status: { select: { id: true, label: true } },
  job_type: true,
  scope_notes: true,
  scheduled_start: true,
  scheduled_end: true,
  created_at: true,
  customer: { select: { id: true, customer_number: true, first_name: true, last_name: true, company_name: true, phone: true } },
  assignees: { select: { user: { select: { id: true, first_name: true, last_name: true } } } },
  service_location: { select: { id: true, address_line1: true, city: true, state: true } },
  estimate: { select: { lead: { select: { commission_owner: { select: { id: true, first_name: true, last_name: true } } } } } },
  // Money-not-status reschedule gate (Spec B1, B-2): the schedule board needs to know whether
  // a job has been invoiced yet, without fetching full invoice detail. One row is enough.
  invoices: {
    where: { sent_at: { not: null } },
    select: { sent_at: true },
    orderBy: { sent_at: 'asc' as const },
    take: 1,
  },
};

const jobDetailSelect = {
  id: true,
  job_number: true,
  status: true,
  // SRVW-112 - `parent` travels too: the detail page only offers sub-statuses of the current
  // parent, and the setter rejects a mismatch.
  sub_status: { select: { id: true, label: true, parent: true } },
  amount_invoiced: true,
  scope_notes: true,
  job_type: true,
  // R3b (2026-07-21) — cost model (D2/D8/D18). Staff-only — stripJobPricingForRequester deletes
  // these three for a requester who can't see pricing (canSeePricing gates read Invoice).
  labor_hours: true,
  overhead_mode: true,
  overhead_value: true,
  estimated_duration: true,
  completion_notes: true,
  scheduled_start: true,
  scheduled_end: true,
  is_all_day: true,
  started_at: true,
  en_route_at: true,
  on_site_at: true,
  completed_at: true,
  cancelled_at: true,
  cancelled_reason: true,
  signature_data: true,
  signature_ip: true,
  signature_at: true,
  created_at: true,
  updated_at: true,
  // Creation confers control (technician-ownership spec, Part C), so this is not audit trivia on the
  // detail payload - it is the fact `canOnJob` needs to decide whether to OFFER the creator-only
  // actions (line items, assign/unassign, delete). Without it the client cannot evaluate a
  // creator-scoped grant and hides every one of them.
  created_by_id: true,
  customer: {
    select: {
      id: true,
      first_name: true,
      last_name: true,
      company_name: true,
      email: true,
      phone: true,
    },
  },
  dispatcher: {
    select: {
      id: true, first_name: true, last_name: true, email: true, phone: true, role: true, avatar_path: true,
      department: { select: { id: true, name: true } },
    },
  },
  // Job crew (M2M). The legacy single-assignee + walkthrough FKs are dropped in
  // TG7 — Job-level walkthrough fields are dead (walkthroughs live on the lead,
  // surfaced via estimate.lead.walkthrough_performers below).
  assignees: {
    select: {
      user: {
        select: {
          id: true, first_name: true, last_name: true, role: true, phone: true, email: true, avatar_path: true,
          department: { select: { id: true, name: true } },
        },
      },
    },
  },
  service_location: {
    select: {
      id: true,
      address_line1: true,
      address_line2: true,
      city: true,
      state: true,
      zip: true,
    },
  },
  estimate: {
    select: {
      id: true,
      estimate_number: true,
      total_amount: true,
      status: true,
      lead_id: true,
      lead: {
        select: {
          id: true,
          lead_number: true,
          status: true,
          // Walkthrough-as-entity redesign, PR-B2: the three walkthrough_* fields below are no
          // longer raw legacy columns - presentJobDetail's projectLeadWalkthroughFields call
          // sources them from this relation instead, resolving D15's "current visit".
          walkthroughs: { select: walkthroughSnapshotSelect },
          walkthrough_performers: { select: { user: { select: { id: true, first_name: true, last_name: true } } } },
          commission_owner: { select: { id: true, first_name: true, last_name: true, email: true, avatar_path: true } },
        },
      },
      line_items: {
        select: {
          id: true,
          sequence: true,
          description: true,
          quantity: true,
          unit_price: true,
          is_taxable: true,
          line_total: true,
          item_type: true,
        },
        orderBy: { sequence: 'asc' as const },
      },
    },
  },
  invoices: {
    select: { id: true, invoice_number: true, status: true, total_amount: true, amount_due: true, created_at: true, sent_at: true, paid_at: true, kind: true },
    orderBy: { created_at: 'asc' as const },
  },
  // SRVW-96 - estimates attached to this job via the R6 EstimateJobLink (Estimate.job_id) that
  // are NOT this job's provenance estimate (`estimate` above). Surfaces both shapes the deposit
  // guard in estimate.controller.ts refuses: the job anchor and a multi-estimate conversion.
  linked_estimates: {
    select: { id: true, estimate_number: true, total_amount: true, status: true },
    orderBy: { created_at: 'asc' as const },
  },
  // Service-plan provenance: when set, this job is a (non-billable) plan visit. Drives the
  // "Plan Visit" badge + link-back on the job page; the plan owns the contract/billing.
  source_plan_id: true,
  source_plan: { select: { id: true, service_plan_number: true, name: true } },
  // SRVW-114 slice 1 - { "<CustomFieldDefinition-uuid>": <scalar> }. ExtraInfoPanel reads this
  // straight off the job detail payload; without it a saved value never reappears after refresh.
  custom_fields: true,
  // Annotated with `satisfies` so excess-property checking fires on this literal: a stale
  // relation key (e.g. a dropped `deposit`) is a tsc error here, not a runtime 500. Without
  // the annotation, passing this const to `select` skips the check and the bug ships silently.
} satisfies Prisma.JobSelect;

// ─── Zod Schemas ───────────────────────────────────────

// Mirrors lead.controller.ts locationSchema (kept local to avoid touching the lead controller).
const locationSchema = z.object({
  address_line1: z.string().min(1).max(200),
  address_line2: z.string().max(200).optional().nullable(),
  city: z.string().min(1).max(100),
  state: z.string().min(2).max(2),
  zip: z.string().min(5).max(10),
});

// Mirrors lead.controller.ts newCustomerSchema.
const newCustomerSchema = z.object({
  first_name: z.string().max(100).optional(),
  // Last name + company are optional; the customer needs a first name OR a company
  // name (unified-client-creation §2), and at least one of phone/email (SERV10X-35).
  last_name: z.string().max(100).optional(),
  company_name: z.string().max(200).optional(),
  email: optionalCustomerEmail,
  phone: optionalCustomerPhone,
  ad_source: z.string().max(100).optional().nullable(),
  location: locationSchema,
}).refine(hasNameOrCompany, {
  message: 'Provide a first name or a company name',
  path: ['first_name'],
}).refine(hasPhoneOrEmail, {
  message: CONTACT_REQUIRED_MSG,
  path: ['phone'],
});

export const createJobSchema = z.object({
  estimate_id: z.string().uuid().optional(),
  // SERV10X-61 Task 9 (MONEY PATH) - convert MULTIPLE WON estimates into one job. When present it
  // supersedes estimate_id; every id must be a WON estimate on the SAME lead + customer, and ALL of
  // them get attached to the new job (Estimate.job_id). A length-1 estimate_ids collapses to the
  // single-estimate provenance path (Job.estimate_id set), byte-identical to passing estimate_id.
  // Capped: the id set drives an IN clause and a createMany of the whole line UNION, both inside
  // one transaction. 50 is far above any real selection (the picker is per-lead/customer).
  estimate_ids: z.array(z.string().uuid()).min(1).max(50, 'Select at most 50 estimates').optional(),
  customer_id: z.string().uuid().optional(),
  new_customer: newCustomerSchema.optional(),
  // Existing-customer accretion (§5.3) — mirrors lead.controller.ts.
  phone: optionalCustomerPhone,
  email: optionalCustomerEmail,
  service_location_id: z.string().uuid().optional(),
  new_location: locationSchema.optional(),
  scope_notes: z.string().max(5000).optional(),
  job_type: z.string().max(100).optional().nullable(),
  ad_source: z.string().max(100).optional().nullable(),
  scheduled_start: z.string().datetime({ offset: true }).optional(),
  scheduled_end: z.string().datetime({ offset: true }).optional(),
  estimated_duration: z.number().int().positive().optional(),
}).superRefine((data, ctx) => {
  // A job is created EITHER from approved estimate(s), OR standalone from a customer + location.
  // The estimate flow is "has estimate_id OR estimate_ids" - the customer/location refine below
  // only applies when NEITHER is present.
  const hasEstimate = Boolean(data.estimate_id) || Boolean(data.estimate_ids?.length);
  if (!hasEstimate) {
    const hasCustomer = Boolean(data.customer_id);
    const hasNewCustomer = Boolean(data.new_customer);
    if (hasCustomer === hasNewCustomer) {
      // neither (need one) OR both (not allowed)
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Provide either customer_id or new_customer (exactly one) when no estimate_id is provided', path: ['customer_id'] });
    }
    // An EXISTING customer needs a location source; a new_customer carries its own primary location.
    if (hasCustomer && !data.service_location_id && !data.new_location) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'service_location_id or new_location is required when no estimate_id is provided', path: ['service_location_id'] });
    }
  }
});

export const updateJobSchema = z.object({
  scope_notes: z.string().max(5000).optional(),
  job_type: z.string().max(100).optional().nullable(),
  // §10 — re-point the job to a different service location: pick an existing one by id,
  // or accrete a new one from an address (resolveOrAccreteLocation). customer_id is LOCKED
  // (re-pointing the customer = cancel + create).
  service_location_id: z.string().uuid().optional(),
  address: z.object({
    address_line1: z.string().min(1),
    address_line2: z.string().optional().nullable(),
    city: z.string().min(1),
    state: z.string().min(1),
    zip: z.string().min(1),
  }).optional(),
  estimated_duration: z.number().int().positive().optional(),
  scheduled_start: z.string().datetime({ offset: true }).optional().nullable(),
  scheduled_end: z.string().datetime({ offset: true }).optional().nullable(),
  // R3b (2026-07-21) — cost model (D2/D8). Nullable overhead_mode/value mirror deposit_type/value
  // (both must be set for an override; null falls back to the org default) — see resolveOverhead.
  labor_hours: z.number().min(0).max(99999).nullable().optional(),
  overhead_mode: z.enum(['PERCENTAGE', 'FIXED']).nullable().optional(),
  overhead_value: z.number().min(0).nullable().optional(),
  // E1/E2 (job-owns-tax-discount) - the job's own editable tax rate + discount (Items tab).
  // discount_amount is NOT accepted here: it is always SERVER-resolved from discount_type/value
  // against the job's current subtotal, never trusted from the client.
  tax_rate: z.number().min(0).max(1).optional(),
  discount_type: z.enum(['PERCENTAGE', 'FIXED_AMOUNT']).nullable().optional(),
  discount_value: z.number().min(0).nullable().optional(),
  // D14 (Spec A) — genuinely editable so the reschedule guard below has something to guard.
  // Previously absent, so validate() (a bare zod .parse()) silently stripped it before the
  // controller ever saw it — the field-level guard would have been unreachable dead code.
  is_all_day: z.boolean().optional(),
  // SRVW-87 - the double-book override, mirroring assignJobSchema's `force` below. Same trap as
  // is_all_day above: without the key here, validate()'s bare .parse() strips it and the override
  // is unreachable dead code. Deliberately NO start/end pairing refine on this schema - the
  // reschedule guard's own test sends a lone scheduled_start and expects 403, not 400.
  force: z.boolean().optional(),
  // SRVW-114 slice 1 - ExtraInfoPanel's save patch, keyed by CustomFieldDefinition uuid. Same
  // trap as is_all_day/force above: without a key here, validate() strips it before the
  // controller ever sees it and the PATCH silently no-ops. Values are `unknown` here - shape is
  // enforced downstream by validateCustomFieldValues, not by this schema, since the allowed
  // shape depends on each definition's own `type`. An explicit `null` value deletes that key
  // (see mergeCustomFields).
  custom_fields: z.record(z.string().uuid(), z.unknown()).optional(),
});

/**
 * The PATCH /api/jobs/:id fields that require `manage_lines Job` (technician-ownership spec, Part
 * C), derived from `updateJobSchema` BY EXCLUSION so the default for a new field is GUARDED.
 *
 * The money fields ride the same PATCH as harmless ones, so the split cannot be made at the route -
 * it needs the field-level check inside `update()`, mirroring the D14 reschedule guard there.
 *
 * Inverted on purpose. The first version of this hand-listed the money fields and missed
 * `labor_hours`/`overhead_mode`/`overhead_value`; with the list inverted, forgetting to classify a
 * new schema key makes the API over-REFUSE (a visible 403 someone reports) instead of silently
 * letting an unauthorised write through. `permissions-job-manage-lines.test.ts` asserts every key of
 * updateJobSchema is classified, so adding one without a decision is a red test either way.
 */
const NOT_MANAGE_LINES_FIELDS = new Set([
  // Plain job fields - the assignee's work surface, gated by `update Job`.
  'scope_notes', 'job_type', 'service_location_id', 'address', 'estimated_duration',
  // Schedule - gated by its own `reschedule Job` check (D14) a few lines below, not by this one.
  'scheduled_start', 'scheduled_end', 'is_all_day', 'force',
  // SRVW-114 slice 1 - Extra Info values are org-admin-defined metadata, not money. Gated by the
  // route's own `update Job` + the per-instance canAccessRow check, same as scope_notes.
  'custom_fields',
]);

export const MANAGE_LINES_FIELDS: readonly string[] = [
  ...Object.keys(updateJobSchema.shape).filter((k) => !NOT_MANAGE_LINES_FIELDS.has(k)),
  // Named by the spec but NOT keys on updateJobSchema, so validate()'s bare .parse() strips them
  // before the guard runs - they cannot reach it today. Listed so that adding either key to the
  // schema cannot silently open a money door; do NOT read this as "they are gated today".
  'discount_name', 'estimate_id',
];

// Crew ⟂ schedule: assignee_ids is the FULL new crew (REPLACE semantics; [] is valid).
// status derives from TIME only — see assign(). The start/end pairing refine is preserved.
export const assignJobSchema = z.object({
  assignee_ids: z.array(z.string().uuid()),
  scheduled_start: z.string().datetime({ offset: true }).optional(),
  scheduled_end: z.string().datetime({ offset: true }).optional(),
  is_all_day: z.boolean().optional(),
  force: z.boolean().optional(),
}).refine(
  (data) => {
    const hasStart = Boolean(data.scheduled_start);
    const hasEnd = Boolean(data.scheduled_end);
    // For all-day jobs, end can be omitted (auto-computed from start)
    if (data.is_all_day && hasStart && !hasEnd) return true;
    return hasStart === hasEnd;
  },
  { message: 'scheduled_start and scheduled_end must both be provided or both omitted', path: ['scheduled_end'] },
);

// Crew-only REPLACE (no schedule/status side effects). See setAssignees().
// notify (#361, optional): the assign popover's channel toggles. in_app:false suppresses the
// added-crew dispatch.job_assigned emit; email:false suppresses the added-crew assignment
// email. Removal notices stay unconditional. Omitted → today's behavior (backward compat).
export const setAssigneesSchema = z.object({
  assignee_ids: z.array(z.string().uuid()),
  notify: z.object({ in_app: z.boolean().optional(), email: z.boolean().optional() }).optional(),
});

// #291 — set or clear the job's dispatcher from the JCC Team card.
export const setDispatcherSchema = z.object({
  dispatcher_id: z.string().uuid().nullable(),
});

// SRVW-112 - set or clear the job's org-defined sub-status. A DEDICATED door rather than a key on
// updateJobSchema: it keeps this out of update() (which SRVW-87 also rewrites) and removes the
// ordering trap of validating a sub-status parent against a status the same PATCH is changing.
export const setSubStatusSchema = z.object({
  sub_status_id: z.string().uuid().nullable(),
});

export const completeJobSchema = z.object({
  completion_notes: z.string().max(5000).optional(),
  // Cap at 500KB for parity with the estimate approve signature (estimate.controller.ts).
  // A real signature PNG is tens of KB; this bounds storage / PDF-render amplification (F-48).
  signature_data: z.string().max(500000).optional(),
  signature_ip: z.string().optional(),
  signature_at: z.string().datetime().optional(),
});

export const cancelJobSchema = z.object({
  cancelled_reason: z.string().min(1, 'Cancellation reason is required').max(2000),
});

export const noteSchema = z.object({
  content: z.string().min(1).max(5000),
});

// SRVW-104 - Jobs list bulk actions. `en_route` is deliberately absent from the enum:
// `default-job-en-route` is a seeded, enabled, customer-recipient automation in every org
// (recipients: ['customer']) and enRoute() dispatches it whenever the job has crew, so a bulk
// en-route would message every selected job's customer "we're on the way" with no technician
// actually driving. SCHEDULED/UNASSIGNED are absent too - those are schedule writes, not status
// changes. The duplicate-ids refine matters because the API (unlike the UI) can be sent one:
// without it a repeated id would run the verb twice, doubling its TimelineEvent/emit/dispatch.
export const bulkStatusJobsSchema = z
  .object({
    ids: z.array(z.string().uuid()).min(1).max(100),
    action: z.enum(['arrive', 'start', 'complete', 'cancel']),
    cancelled_reason: z.string().min(1).max(2000).optional(),
  })
  .refine((d) => new Set(d.ids).size === d.ids.length, { message: 'Duplicate job ids', path: ['ids'] })
  .refine((d) => d.action !== 'cancel' || Boolean(d.cancelled_reason?.trim()), {
    message: 'Cancellation reason is required',
    path: ['cancelled_reason'],
  });

export const bulkAssignJobsSchema = z
  .object({
    ids: z.array(z.string().uuid()).min(1).max(100),
    assignee_ids: z.array(z.string().uuid()),
    notify: z.object({ in_app: z.boolean().optional(), email: z.boolean().optional() }).optional(),
  })
  .refine((d) => new Set(d.ids).size === d.ids.length, { message: 'Duplicate job ids', path: ['ids'] });

// ─── Helpers ───────────────────────────────────────────

function param(req: Request, name: string): string {
  return req.params[name] as string;
}

async function withTags<T extends { id: string }>(req: Request, job: T | null): Promise<(T & { tags: TagSummary[] }) | null> {
  if (!job) return null;
  const tags = await loadTagsForEntity(req, 'JOB', job.id);
  return { ...job, tags };
}

async function withTagsMany<T extends { id: string }>(req: Request, jobs: T[]): Promise<Array<T & { tags: TagSummary[] }>> {
  const grouped = await loadTagsByEntity(req, 'JOB', jobs.map((j) => j.id));
  return jobs.map((j) => ({ ...j, tags: grouped.get(j.id) ?? [] }));
}

/**
 * §5/§10 — surface the remaining un-billed balance against the as-sold estimate total.
 * `remaining_unbilled = estimate.total_amount − amount_invoiced` (a derived read, not a
 * column). Goes negative when change-orders push total billed past the estimate — the
 * intended over-billing signal. Returns the job unchanged when there is no estimate.
 */
function withRemainingUnbilled<
  T extends { amount_invoiced?: unknown; estimate?: { total_amount?: unknown } | null },
>(job: T): T & { remaining_unbilled: number | null } {
  const estimateTotal = job.estimate?.total_amount;
  if (estimateTotal == null) return { ...job, remaining_unbilled: null };
  const billed = Number(job.amount_invoiced ?? 0);
  return { ...job, remaining_unbilled: Math.round((Number(estimateTotal) - billed) * 100) / 100 };
}

// Phase B (§E) — strip the estimate's as-sold dollar figures from a job-detail payload for a
// requester who cannot `read Invoice`. A field technician reaches their OWN job (read Job OWN_JOB)
// and the estimate total + per-line unit_price/line_total leak through the job payload independent
// of invoice read. We keep line DESCRIPTIONS + QUANTITIES (needed to do the work) but remove
// total_amount, unit_price, line_total, and the job's amount_invoiced; the derived
// remaining_unbilled then resolves to null in withRemainingUnbilled (it reads estimate.total_amount).
// QA-B2 leak 2: jobDetailSelect also embeds invoices[] with each invoice's total_amount/amount_due,
// which leaked the same dollar figures a second way; we project those out too (keeping
// invoice_number/status so the tech still knows an invoice exists).
// Mirrors lead.controller's stripEstimateMonetaryFields. ADMIN/DISPATCHER/invoice-readers keep it.
// canSeePricing() itself now lives in ../lib/permissions/enforce.ts (job-lines pricing-leak
// follow-up — job-lines.controller.ts's unit_cost/markup_percent strip needed the same check).

// GAP-5 — money keys that cancel() writes into a JOB timeline event's metadata. getTimeline returns
// metadata raw, so for a requester who cannot see pricing these are redacted (the row/event stays,
// only the monetary fields are removed). Mirrors the job-detail pricing strip.
const TIMELINE_MONEY_METADATA_KEYS = ['collected_total', 'refund_suggested'] as const;

function redactTimelineMoneyForRequester<
  T extends { metadata?: unknown },
>(events: T[], req: Request): T[] {
  if (canSeePricing(req)) return events;
  return events.map((ev) => {
    const meta = ev.metadata;
    if (!meta || typeof meta !== 'object' || Array.isArray(meta)) return ev;
    const metaObj = meta as Record<string, unknown>;
    if (!TIMELINE_MONEY_METADATA_KEYS.some((k) => k in metaObj)) return ev;
    const cleaned: Record<string, unknown> = { ...metaObj };
    for (const k of TIMELINE_MONEY_METADATA_KEYS) delete cleaned[k];
    return { ...ev, metadata: cleaned };
  });
}

function stripJobPricingForRequester<T extends Record<string, unknown>>(job: T, req: Request): T {
  if (canSeePricing(req)) return job;
  // Clone the branches we redact (rather than mutating in place) so the strip never leaks into a
  // shared object reference. Returns a new job with the monetary fields omitted.
  const out: Record<string, unknown> = { ...job };
  delete out.amount_invoiced;
  // R3b (2026-07-21) — cost model (D2/D8/D18). Same staff-only fields as Estimate's.
  delete out.labor_hours;
  delete out.overhead_mode;
  delete out.overhead_value;
  const estimate = job.estimate as { total_amount?: unknown; line_items?: Array<Record<string, unknown>> } | null | undefined;
  if (estimate) {
    const { total_amount: _omitTotal, line_items, ...estRest } = estimate;
    out.estimate = {
      ...estRest,
      line_items: (line_items ?? []).map(({ unit_price: _u, line_total: _l, ...liRest }) => liRest),
    };
  }
  const invoices = job.invoices as Array<Record<string, unknown>> | null | undefined;
  if (Array.isArray(invoices)) {
    out.invoices = invoices.map(({ total_amount: _t, amount_due: _d, ...invRest }) => invRest);
  }
  // SRVW-96 - same strip on the job's attached (linked) estimates. Array.isArray, not a bare map,
  // because many existing tests mock a jobDetailSelect-shaped job without the new key.
  const linked = job.linked_estimates as Array<Record<string, unknown>> | null | undefined;
  if (Array.isArray(linked)) {
    out.linked_estimates = linked.map(({ total_amount: _t, ...rest }) => rest);
  }
  return out as T;
}

/**
 * Phase B (§E) — the canonical "present a jobDetailSelect job to the requester" pipeline, mirroring
 * getById exactly: attach tags → ability-gated pricing strip → derive remaining_unbilled (which
 * resolves to null once total_amount is stripped). Every handler that responds with a
 * jobDetailSelect-shaped job (the action handlers — update/assign/setAssignees/unassign/enRoute/
 * arrive/start/complete/cancel/reopen — and create) routes through this so a requester who cannot
 * `read Invoice` never gets estimate/invoice pricing echoed back in an action response. Phase B now
 * lets an admin grant a technician an advance verb (or update/create Job) per-user WITHOUT read
 * Invoice, which is exactly that leak. A no-op for invoice readers (the strip early-returns).
 */
// Walkthrough-as-entity redesign, PR-B2: jobDetailSelect's nested `estimate.lead.walkthroughs`
// relation (see the select above) needs projecting onto the legacy walkthrough_* field NAMES the
// job detail page already reads off `job.estimate.lead`. A no-op for a standalone (lead-less)
// job, whose `estimate`/`estimate.lead` is null.
function projectJobEstimateLeadWalkthrough<T extends { estimate?: { lead?: unknown } | null }>(job: T): T {
  const lead = job.estimate?.lead;
  if (!lead) return job;
  return { ...job, estimate: { ...job.estimate, lead: projectLeadWalkthroughFields(lead as never, { full: true }) } } as T;
}

type PersonWithAvatarPath = { avatar_path?: string | null } & Record<string, unknown>;

/** Swap `avatar_path` for a response-safe signed `avatar_url` on the three person shapes
 *  jobDetailSelect embeds: the dispatcher, each crew assignee's user, and the estimate's lead
 *  commission_owner. One batched signAvatarPaths call for all three, same as
 *  user.controller.ts's withAvatarUrls but shaped for this nesting instead of a flat row list. */
async function withPersonAvatars<T extends Record<string, unknown>>(job: T): Promise<T> {
  const dispatcher = job.dispatcher as PersonWithAvatarPath | null | undefined;
  const assignees = job.assignees as Array<{ user: PersonWithAvatarPath }> | null | undefined;
  const estimate = job.estimate as { lead?: { commission_owner?: PersonWithAvatarPath | null } | null } | null | undefined;
  const commissionOwner = estimate?.lead?.commission_owner;

  const signed = await signAvatarPaths([
    dispatcher?.avatar_path,
    ...(assignees ?? []).map((a) => a.user?.avatar_path),
    commissionOwner?.avatar_path,
  ]);

  const swap = (person: PersonWithAvatarPath | null | undefined) => {
    if (!person) return person;
    const { avatar_path, ...rest } = person;
    return { ...rest, avatar_url: resolveAvatarUrl(avatar_path, signed) };
  };

  return {
    ...job,
    dispatcher: swap(dispatcher),
    assignees: assignees ? assignees.map((a) => ({ ...a, user: swap(a.user) })) : assignees,
    estimate: estimate
      ? { ...estimate, lead: estimate.lead ? { ...estimate.lead, commission_owner: swap(commissionOwner) } : estimate.lead }
      : estimate,
  };
}

async function presentJobDetail<
  T extends { id: string; amount_invoiced?: unknown; estimate?: { total_amount?: unknown; lead?: unknown } | null },
>(req: Request, job: T | null) {
  const tagged = await withTags(req, job);
  if (!tagged) return null;
  const withAvatars = await withPersonAvatars(tagged);
  return withRemainingUnbilled(stripJobPricingForRequester(projectJobEstimateLeadWalkthrough(withAvatars), req));
}


// GAP-1 — the role-literal `canAccessJob` (ADMIN||DISPATCHER → true, ignoring the CASL
// ability/override engine) was REMOVED. getById/getNotes/addNote/getTimeline now use the
// canonical grant/override-aware canAccessRow, the same per-instance gate as update/remove.

// ─── Crew assignment helpers (scheduler redesign) ──────

type CrewMember = { id: string; email: string | null; first_name: string; last_name: string };

/**
 * REPLACE semantics: the array IS the new crew. Diffs against the current crew inside the
 * transaction and applies the delta. Returns {added, removed} (user-id arrays) for diff-emails.
 */
async function replaceJobCrew(
  tx: Prisma.TransactionClient,
  jobId: string,
  orgId: string,
  userIds: string[],
): Promise<{ added: string[]; removed: string[] }> {
  const current = await tx.jobAssignee.findMany({ where: { job_id: jobId }, select: { user_id: true } });
  const currentIds = new Set(current.map((c) => c.user_id));
  const next = new Set(userIds);
  const added = [...next].filter((id) => !currentIds.has(id));
  const removed = [...currentIds].filter((id) => !next.has(id));
  if (removed.length) await tx.jobAssignee.deleteMany({ where: { job_id: jobId, user_id: { in: removed } } });
  if (added.length) await tx.jobAssignee.createMany({ data: added.map((user_id) => ({ job_id: jobId, user_id, organization_id: orgId })) });
  return { added, removed };
}

/**
 * Per-member eligibility: every assignee_id must resolve to an ACTIVE in-org user whose role
 * `isAssignable`. Returns the resolved crew on success, or a {status, error} to send on failure.
 */
async function validateCrew(
  req: Request,
  assigneeIds: string[],
): Promise<{ ok: true; users: CrewMember[] } | { ok: false; status: number; error: string }> {
  const users: CrewMember[] = [];
  for (const userId of assigneeIds) {
    const tech = await prisma.user.findUnique({
      where: { id: userId, ...tenantWhere(req) },
      select: { id: true, role: true, is_active: true, email: true, first_name: true, last_name: true },
    });
    if (!tech) return { ok: false, status: 404, error: 'User not found' };
    if (!isAssignable(tech.role)) return { ok: false, status: 400, error: 'This user is not eligible to be assigned as job crew' };
    if (!tech.is_active) return { ok: false, status: 400, error: 'Cannot assign job to an inactive technician' };
    users.push({ id: tech.id, email: tech.email, first_name: tech.first_name, last_name: tech.last_name });
  }
  return { ok: true, users };
}

type ScheduleConflict =
  | { type: 'job'; id: string; number: string; start: Date | null; end: Date | null }
  | { type: 'walkthrough'; id: string; number: string; start: Date | null; end: Date };

/**
 * Per-member conflict detection. For each candidate user, finds overlapping SCHEDULED/IN_PROGRESS
 * jobs (crew M2M) and scheduled walkthroughs (walkthrough-performer M2M) in the same time window.
 * Returns the conflicts in the EXACT existing 409 entry shape (type/id/number/start/end) — the FE
 * retry path + the jobs.test.ts conflict assertion read this shape, so it is kept byte-stable.
 */
async function detectCrewConflicts(
  req: Request,
  opts: { jobId: string; userIds: string[]; schedStart: Date; schedEnd: Date },
): Promise<ScheduleConflict[]> {
  if (opts.userIds.length === 0) return [];
  const { schedStart, schedEnd } = opts;

  const [jobConflicts, walkthroughConflicts] = await Promise.all([
    prisma.job.findMany({
      where: {
        ...tenantWhere(req),
        id: { not: opts.jobId },
        assignees: { some: { user_id: { in: opts.userIds } } },
        // Spec B1 (Task 5): a technician physically on site (or en route) still occupies the
        // slot -- this previously only checked SCHEDULED/IN_PROGRESS, so a double-booking check
        // missed a crew member who had already advanced past SCHEDULED for the conflicting job.
        status: { in: ['SCHEDULED', 'EN_ROUTE', 'ON_SITE', 'IN_PROGRESS'] },
        scheduled_start: { lt: schedEnd },
        scheduled_end: { gt: schedStart },
      },
      select: { id: true, job_number: true, scheduled_start: true, scheduled_end: true },
    }),
    // Walkthrough-as-entity redesign, PR-B2: repointed from Lead.status/walkthrough_scheduled_at
    // onto the Walkthrough row's own status/scheduled_at.
    prisma.walkthrough.findMany({
      where: {
        ...tenantWhere(req),
        performers: { some: { user_id: { in: opts.userIds } } },
        status: 'SCHEDULED',
        scheduled_at: { not: null },
      },
      select: { id: true, scheduled_at: true, duration_minutes: true, lead: { select: { id: true, lead_number: true } } },
    }),
  ]);

  // Filter walkthrough conflicts by time overlap (same window math as the legacy single-tech path)
  const wtConflicts = walkthroughConflicts.filter((wt) => {
    if (!wt.scheduled_at) return false;
    const wtStart = new Date(wt.scheduled_at);
    const wtEnd = new Date(wtStart.getTime() + (wt.duration_minutes || 60) * 60_000);
    return wtStart < schedEnd && wtEnd > schedStart;
  });

  return [
    ...jobConflicts.map((j) => ({ type: 'job' as const, id: j.id, number: j.job_number, start: j.scheduled_start, end: j.scheduled_end })),
    // `id`/`number` are the LEAD's (not the Walkthrough row's) — the FE retry path and the
    // /leads/{id} link expect the lead, same as before this redesign.
    ...wtConflicts.map((w) => ({
      type: 'walkthrough' as const, id: w.lead.id, number: w.lead.lead_number,
      start: w.scheduled_at,
      end: new Date(new Date(w.scheduled_at!).getTime() + (w.duration_minutes || 60) * 60_000),
    })),
  ];
}

// ─── Handlers ──────────────────────────────────────────

/**
 * Build the `where` clause (and the underlying grant-driven `rowScope`) for the job
 * list/export. Extracted from `list()` so the unpaginated `exportAll` applies the IDENTICAL
 * tenant scope + CASL row-scope + filters. Returns `rowScope` too because `list()` reuses it
 * to build the separate stats `scopeWhere`.
 */
export async function buildJobListWhere(req: Request): Promise<{ where: Record<string, unknown>; rowScope: Record<string, unknown> }> {
  const search = (req.query.search as string) || '';

  // #106 — grant-driven row scope (replaces the hand-rolled SALES/TECHNICIAN if-block,
  // which hardcoded two roles + the literal owner field and let every OTHER non-ADMIN role
  // see the whole org). scopeWhereForReq returns {} for ADMIN/unconditional-read, the
  // owner/team/location condition for a conditional read grant, or MATCH_NOTHING
  // (fail-closed) when there is no read grant. Spread as the OUTERMOST base of every
  // where/count/aggregate so a MATCH_NOTHING `id` key can't be overwritten by a filter.
  const rowScope = await scopeWhereForReq(req, 'Job');
  const where: Record<string, unknown> = { ...tenantWhere(req), ...rowScope };

  // Service-plan visit-jobs are managed inside the Service Plans module, so the office Jobs
  // list (and its KPI tiles) exclude them when asked. The calendar and tech app call the same
  // endpoint WITHOUT this flag, so they still see visit-jobs — they must, to execute them.
  if (req.query.exclude_plan_visits === 'true') {
    where.source_plan_id = null;
  }

  // Generalized filter engine (Task 10): status (enum-validated), customer_id,
  // scheduled_after/before (-> scheduled_start), created_after/before (-> created_at). See
  // job.filters.ts's file-level comment for why the crew filters (assigned_to/department_id)
  // are NOT part of this registry.
  await applyFilters(where, req, jobFacets);

  // Crew (M2M) filters: assignee user and/or assignee department. SECURITY: kept hand-rolled
  // here rather than as generic engine facets — see job.filters.ts's file-level comment.
  // `scopeWhereForReq` may have already set `where.assignees` for a row-scoped role (e.g. a
  // TECHNICIAN's OWN_JOB grant narrows to `assignees.some.user_id: <self>`). If these params
  // merged into that SAME `.some` clause (what the generic `relationSome` helper does), an
  // attacker-supplied `assigned_to`/`department_id` would OVERWRITE `user_id: <self>` —
  // widening a row-scoped user's visibility to another user's jobs (RBAC bypass). Composed
  // under AND instead, so a pre-existing role-scoped `where.assignees` clause is preserved
  // byte-for-byte and this becomes a SEPARATE, additive constraint. When there is no
  // pre-existing role-scoped `where.assignees` (e.g. ADMIN/DISPATCHER), both params merge
  // into ONE `where.assignees.some`, exactly as the pre-Task-10 code did.
  const assignedTo = parseArrayParam(req.query.assigned_to);
  const departmentId = parseArrayParam(req.query.department_id);
  if (assignedTo.length || departmentId.length) {
    const assigneeSome: Record<string, unknown> = {};
    if (assignedTo.length) assigneeSome.user_id = assignedTo.length === 1 ? assignedTo[0] : { in: assignedTo };
    if (departmentId.length) assigneeSome.user = { department_id: departmentId.length === 1 ? departmentId[0] : { in: departmentId } };
    // `rowScope`, not `where.assignees`: a row-scoped role's fragment is not always a bare
    // `assignees` key. Since the technician-ownership spec widened `read Job` to assigned-OR-created
    // it arrives as `{ OR: [...] }`, and keying off `where.assignees` alone would take the else
    // branch. That still ANDs at the top level rather than leaking, but only by luck - the explicit
    // AND is what the security property is meant to rest on, so ask the question that matters: does
    // this requester have ANY row scope at all.
    if (where.assignees || Object.keys(rowScope).length > 0) {
      (where.AND ??= [] as unknown[]);
      (where.AND as unknown[]).push({ assignees: { some: assigneeSome } });
    } else {
      where.assignees = { some: assigneeSome };
    }
  }

  const needsInvoice = req.query.needs_invoice as string | undefined;
  if (needsInvoice === 'true') {
    where.status = 'COMPLETED';
    where.NOT = { invoices: { some: { status: { not: 'VOIDED' } } } };
  }

  if (search) {
    // Clobber-safe: for a MULTI-READ user the spread-in `rowScope` is itself `{ OR: [...] }`
    // (e.g. SALES role read OWN_JOB_VIA_ESTIMATE + a `create/update Job` override implying OWN_JOB
    // → two distinct conditions → scope OR). A bare `where.OR = [...search...]` would silently drop
    // that scope OR = a row-scope LEAK. addOrFilter demotes a pre-existing scope OR under AND
    // alongside the search OR (`AND: [{OR: scope}, {OR: search}]`) so neither is lost; with no scope
    // OR it's the unchanged cheap `where.OR =` path. Mirrors the lead/invoice/estimate list fix.
    addOrFilter(where, [
      { job_number: { contains: search, mode: 'insensitive' } },
      { customer: { first_name: { contains: search, mode: 'insensitive' } } },
      { customer: { last_name: { contains: search, mode: 'insensitive' } } },
      { customer: { company_name: { contains: search, mode: 'insensitive' } } },
    ]);
  }

  return { where, rowScope };
}

export async function list(req: Request, res: Response) {
  try {
    const { page, limit, skip } = parsePagination(req.query as { page?: string; limit?: string });
    const sort = parseSortParams(req.query as any, JOB_SORT_FIELDS);
    if (!sort.ok) {
      respondInvalidSort(res, sort);
      return;
    }
    const orderBy = sort.orderBy;

    const { where, rowScope } = await buildJobListWhere(req);
    const scopeWhere: Record<string, unknown> = { ...tenantWhere(req), ...rowScope };
    // exclude_plan_visits also scopes the stats tiles (mirrors the list `where`).
    if (req.query.exclude_plan_visits === 'true') {
      scopeWhere.source_plan_id = null;
    }

    // Monthly window for completed/cancelled status tiles (scheduled_start ∈ current month)
    const now = new Date();
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
    const monthEnd = new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59, 999);
    const needInvoiceWhere: Prisma.JobWhereInput = {
      ...scopeWhere,
      status: 'COMPLETED',
      NOT: { invoices: { some: { status: { not: 'VOIDED' } } } },
    };

    const [
      jobs, total,
      statusGroups,
      completedThisMonth, cancelledThisMonth, needInvoicesCount,
    ] = await Promise.all([
      prisma.job.findMany({
        where,
        select: jobListSelect,
        orderBy,
        skip,
        take: limit,
      }),
      prisma.job.count({ where }),
      prisma.job.groupBy({
        by: ['status'],
        where: scopeWhere,
        _count: true,
      }),
      prisma.job.count({ where: { ...scopeWhere, status: 'COMPLETED', scheduled_start: { gte: monthStart, lte: monthEnd } } }),
      prisma.job.count({ where: { ...scopeWhere, status: 'CANCELLED', scheduled_start: { gte: monthStart, lte: monthEnd } } }),
      prisma.job.count({ where: needInvoiceWhere }),
    ]);

    const byStatus = Object.fromEntries(statusGroups.map((g) => [g.status, g._count]));

    res.json({
      jobs: await withTagsMany(req, jobs),
      pagination: buildPaginationMeta(total, { page, limit, skip }),
      stats: {
        unassigned:    byStatus['UNASSIGNED']  ?? 0,
        scheduled:     byStatus['SCHEDULED']   ?? 0,
        // Spec B1 (Task 5): EN_ROUTE and ON_SITE are "in progress" to a dispatcher reading a
        // tile. Folding them in keeps the tiles summing to the total; listing them separately
        // would need a 7th tile.
        in_progress:   (byStatus['IN_PROGRESS'] ?? 0) + (byStatus['EN_ROUTE'] ?? 0) + (byStatus['ON_SITE'] ?? 0),
        completed:     completedThisMonth,
        cancelled:     cancelledThisMonth,
        need_invoices: needInvoicesCount,
      },
    });
  } catch (err) {
    logger.error('List jobs error:', err);
    res.status(500).json({ error: 'Failed to list jobs' });
  }
}

const EXPORT_ROW_CAP = 50_000;

/**
 * Export every job matching the active filters (unpaginated, capped). Reuses the list's
 * `where` (tenant + CASL row-scope + filters), `select`, and default `orderBy` so the CSV
 * the frontend builds is column-identical to the list and row-level security holds.
 */
export async function exportAll(req: Request, res: Response) {
  try {
    const { where } = await buildJobListWhere(req);
    const jobs = await prisma.job.findMany({
      where,
      select: jobListSelect,
      orderBy: { created_at: 'desc' },
      take: EXPORT_ROW_CAP,
    });
    if (jobs.length === EXPORT_ROW_CAP) {
      logger.warn(`Job export hit row cap (${EXPORT_ROW_CAP}) for org ${req.user?.organization_id}`);
    }
    void logAudit({ req, action: 'job.exported', resourceType: 'Job', resourceId: null, metadata: { count: jobs.length } });
    res.json({ jobs });
  } catch (err) {
    logger.error('Export jobs error:', err);
    res.status(500).json({ error: 'Failed to export jobs' });
  }
}

/**
 * SERV10X-61 - thrown inside the multi-estimate transaction when the conditional attach matched
 * fewer estimates than were requested, i.e. a concurrent create attached one of them first.
 * Rolls the transaction back and surfaces as a 409 (see create()'s catch), not a 500.
 */
class EstimateAttachRaceError extends Error {}

export async function create(req: Request, res: Response) {
  try {
    const {
      estimate_id: singleEstimateId, estimate_ids, customer_id, service_location_id, new_location,
      scope_notes, job_type, ad_source,
      scheduled_start, scheduled_end, estimated_duration,
      phone, email,
    } = req.body;

    // SERV10X-61 Task 9 - normalize the single/multi estimate inputs into ONE array. estimate_ids
    // (multi) wins when present; else a lone estimate_id becomes a length-1 array; else [] (the
    // standalone/customer flow). Length 0 → standalone branch; length 1 → the UNCHANGED single-
    // estimate branch (byte-identical provenance + idempotency); length > 1 → the new multi branch.
    const estimateIds: string[] = estimate_ids ?? (singleEstimateId ? [singleEstimateId] : []);

    // #375: once the job is committed, post-commit presentation (which loads tags) must
    // never turn success into a 500 "Failed to create job". Present defensively — on a
    // post-commit failure, log it and return a minimal payload (the FE navigates on id and
    // the detail page refetches).
    const safePresentJob = async <T extends { id: string; job_number: string }>(j: T) => {
      try {
        return await presentJobDetail(req, j);
      } catch (e) {
        logger.error('Post-commit job presentation failed (job WAS created; returning minimal payload):', e);
        return { id: j.id, job_number: j.job_number };
      }
    };

    // Phase B — row-scoped creators (a per-user OWN-scoped `create Job` grantee, e.g. a technician)
    // must end up OWNING the job they create, else they can't read it afterwards (#232). Detect via
    // the Job read-scope: a row-scoped grantee's paired `read Job` is conditioned (OWN_JOB) so the
    // fragment is non-empty; an unconditional creator (dispatcher/admin) yields {} and is NOT
    // auto-assigned. The route guard `canDo('create','Job')` already gated entry.
    const jobScope = await scopeWhereForReq(req, 'Job');
    const isRowScopedCreator = Object.keys(jobScope).length > 0;
    const orgId = req.user!.organization_id;
    const selfAssigneeRow = { user_id: req.user!.id, organization_id: orgId };

    if (estimateIds.length === 0) {
      // Fields written onto every standalone job (the estimate branch builds its own).
      const jobExtra = {
        scope_notes: scope_notes || null,
        job_type: job_type || null,
        scheduled_start: scheduled_start ? new Date(scheduled_start) : null,
        scheduled_end: scheduled_end ? new Date(scheduled_end) : null,
        estimated_duration: estimated_duration || null,
        ...(scheduled_start ? { status: 'SCHEDULED' as const } : {}),
        // Audit: both standalone branches (new customer / existing customer) spread this.
        ...createdByUser(req),
      };

      // ── Inline new customer (mirrors POST /api/leads new_customer path) ──
      const { new_customer } = req.body;
      if (new_customer) {
        const override = req.query.override === 'true';
        const duplicateMatch = await findDuplicateCustomer(prisma, orgId, {
          email: new_customer.email,
          phone: new_customer.phone,
        });
        if (duplicateMatch && !override) {
          res.status(409).json({ error: 'duplicate', existing: duplicateMatch });
          return;
        }

        const job = await prisma.$transaction(async (tx) => {
          const { location, email, ad_source: newCustomerSource, ...customerData } = new_customer;
          const newCust = await tx.customer.create({
            data: {
              ...(await withRequiredCustomerFields(tx, orgId, {
                ...customerData,
                // Email is optional — omitted/blank persists as NULL.
                email: email?.trim() || null,
                ad_source: newCustomerSource || ad_source || null,
              })),
              service_locations: { create: { ...location, is_primary: true } },
              // Audit: the user creating the job also authored the customer this path mints. LAST
              // so it wins over the body-derived spread above.
              ...createdByUser(req),
            },
            select: { id: true, service_locations: { where: { is_primary: true }, take: 1, select: { id: true } } },
          });

          // Forward audit of a knowingly-duplicate create (no merge tool yet) — mirrors POST /api/leads.
          if (override && duplicateMatch) {
            await tx.timelineEvent.create({
              data: {
                organization_id: orgId,
                entity_type: 'CUSTOMER',
                entity_id: newCust.id,
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

          const primaryLocationId = newCust.service_locations[0]?.id ?? null;
          const jobNumber = await allocateNumber(tx, 'job', orgId);
          // E1 (job-owns-tax-discount) - a standalone job has no estimate to inherit from, so it
          // stamps tax_rate from its own service location, same lookup estimate.controller.ts
          // uses. Must run on `tx`: a read on the outer `prisma` client here would ask the pooler
          // for a 2nd connection while this transaction is still open.
          const taxRate = await resolveTaxRateForState(tx, orgId, location?.state ?? null);
          const j = await tx.job.create({
            data: {
              job_number: jobNumber,
              organization_id: orgId,
              customer_id: newCust.id,
              service_location_id: primaryLocationId,
              tax_rate: taxRate,
              ...jobExtra,
            },
            select: jobDetailSelect,
          });

          // Phase B (#232) — a row-scoped creator owns the standalone (urgent) job they make, so
          // they can read/invoice it. Unconditional creators (dispatcher/admin) are not auto-assigned.
          if (isRowScopedCreator) {
            await tx.jobAssignee.createMany({ data: [{ job_id: j.id, ...selfAssigneeRow }] });
          }

          await tx.timelineEvent.create({
            data: {
              organization_id: orgId,
              entity_type: 'JOB',
              entity_id: j.id,
              event_type: 'CREATED',
              description: `Job ${j.job_number} created`,
              created_by: req.user!.id,
            },
          });

          return j;
        });

        void logAudit({ req, action: 'job.created', resourceType: 'Job', resourceId: job.id, metadata: { job_number: job.job_number } });
        res.status(201).json({ job: await safePresentJob(job) });
        return;
      }

      // Existing customer — verify it exists in the requesting org.
      const customer = await prisma.customer.findUnique({ where: { id: customer_id, ...tenantWhere(req) }, select: { id: true } });
      if (!customer) {
        res.status(404).json({ error: 'Customer not found' });
        return;
      }

      // Cross-customer accretion guard (#800 follow-up) — mirrors the new_customer path and
      // POST /api/leads. A typed phone/email belonging to a DIFFERENT customer must not
      // silently accrete onto the linked one. `?override=true` bypasses (Create anyway); the
      // linked customer is EXCLUDED so its own prefilled contact never trips this (that
      // same-customer case is deduped inside accreteContactMethods).
      if (phone || email) {
        const override = req.query.override === 'true';
        const crossMatch = await findDuplicateCustomer(prisma, orgId, { phone, email }, customer_id);
        if (crossMatch && !override) {
          res.status(409).json({ error: 'duplicate', existing: crossMatch });
          return;
        }
      }

      // Validate an explicitly-picked location up front (preserves the BUG #20 query
      // shape + 404). A new_location is accreted inside the transaction instead.
      let resolvedLocationId: string | null = null;
      let resolvedLocationState: string | null = null;
      if (service_location_id) {
        const location = await prisma.serviceLocation.findFirst({
          where: { id: service_location_id, customer_id, is_active: { not: false } },
          select: { id: true, state: true },
        });
        if (!location) {
          res.status(404).json({ error: 'Service location not found or does not belong to customer' });
          return;
        }
        resolvedLocationId = location.id;
        resolvedLocationState = location.state;
      }

      let job;
      try {
        job = await prisma.$transaction(async (tx) => {
          // Source lives on the customer — update it when supplied.
          if (ad_source !== undefined) {
            await tx.customer.update({ where: { id: customer_id }, data: { ad_source: ad_source || null } });
          }

          // Workiz-style accretion (spec §3/§5.3): a typed phone/email adds a new
          // secondary contact method on the customer; the primary is never touched.
          await accreteContactMethods(tx, customer_id, { phone, email });

          // No id picked → accrete the new_location onto the customer.
          if (!resolvedLocationId) {
            const resolved = await resolveOrAccreteLocation(tx, {
              customerId: customer_id,
              orgId,
              service_location_id: null,
              address: new_location ?? null,
            });
            resolvedLocationId = resolved.id;
            resolvedLocationState = resolved.state;
          }

          // E1 (job-owns-tax-discount) - see the new_customer branch above for why this must run
          // on `tx`.
          const taxRate = await resolveTaxRateForState(tx, orgId, resolvedLocationState);

          const jobNumber = await allocateNumber(tx, 'job', orgId);
          const j = await tx.job.create({
            data: {
              job_number: jobNumber,
              organization_id: orgId,
              customer_id,
              service_location_id: resolvedLocationId,
              tax_rate: taxRate,
              ...jobExtra,
            },
            select: jobDetailSelect,
          });

          // Phase B (#232) — a row-scoped creator owns the standalone (urgent) job they make, so
          // they can read/invoice it. Unconditional creators (dispatcher/admin) are not auto-assigned.
          if (isRowScopedCreator) {
            await tx.jobAssignee.createMany({ data: [{ job_id: j.id, ...selfAssigneeRow }] });
          }

          await tx.timelineEvent.create({
            data: {
              organization_id: orgId,
              entity_type: 'JOB',
              entity_id: j.id,
              event_type: 'CREATED',
              description: `Job ${j.job_number} created`,
              created_by: req.user!.id,
            },
          });

          return j;
        });
      } catch (e) {
        if (e instanceof LocationResolutionError) {
          res.status(400).json({ error: (e as Error).message });
          return;
        }
        throw e;
      }

      // ─── In-app notification hook ───────────────────────────────────────────
      // Job created directly (no estimate): notify dispatchers.
      await emit({
        verb: 'dispatch.job_created',
        organizationId: req.user!.organization_id,
        actorId: req.user?.id ?? null,
        object: { type: 'JOB', id: job.id, label: job.job_number },
        entity: { assignee_ids: [] },
        data: { object_label: job.job_number },
      });

      // Phase B (§E) — a row-scoped creator (e.g. a technician creating an urgent standalone job,
      // #232) who lacks read Invoice shouldn't get pricing echoed back; no-op for invoice readers.
      void logAudit({ req, action: 'job.created', resourceType: 'Job', resourceId: job.id, metadata: { job_number: job.job_number } });
      res.status(201).json({ job: await safePresentJob(job) });
    } else if (estimateIds.length === 1) {
      // SERV10X-61 Task 9 - LENGTH 1: the UNCHANGED single-estimate branch (byte-identical
      // provenance, idempotent find-or-create, cost-basis copy, P2002 race fallback). `estimate_id`
      // is the one selected id, whether the request used `estimate_id:X` or `estimate_ids:[X]`.
      const estimate_id = estimateIds[0];
      // Standard flow: validate estimate exists in requesting org. The route guard
      // `canDo('create','Job')` already gated entry; ownership is narrowed below (Phase B —
      // replaces the old blanket `role === 'TECHNICIAN'` 403, which a per-user grant couldn't
      // override). lead_assignees is loaded so a row-scoped creator can be checked against the
      // parent lead's ownership.
      const estimate = await prisma.estimate.findUnique({
        where: { id: estimate_id, ...tenantWhere(req) },
        select: {
          id: true,
          status: true,
          estimate_number: true,
          lead_id: true,
          // SERV10X-61 - the estimate's OWN denormalized anchors, read as the fallback for a
          // lead-less (customer-anchored) estimate. Same resolution the multi branch does.
          customer_id: true,
          service_location_id: true,
          // job_id = attachment (EstimateJobLink); job = provenance reverse (JobPrimaryEstimate).
          // Both are read so a JOB-anchored estimate (job_id set, nothing pointing back) can be
          // told apart from a plain re-conversion of an estimate that owns its own job.
          job_id: true,
          job: { select: { id: true } },
          job_type: true,
          // R3b (2026-07-21) — cost model (D2/D8/D18): copied onto the new Job below so its cost
          // basis starts where the estimate left off, not the org default (that fallback is only
          // for a Job created from scratch, e.g. an urgent job with no estimate_id).
          labor_hours: true,
          overhead_mode: true,
          overhead_value: true,
          // E1/E2 (job-owns-tax-discount) - copied onto the new Job below, same "no information
          // loss on conversion" precedent as the cost basis above: the job inherits the numbers
          // the estimate was actually agreed at, then owns them independently from that point on.
          tax_rate: true,
          discount_type: true,
          discount_value: true,
          discount_amount: true,
          lead: {
            select: {
              customer_id: true,
              service_location_id: true,
              service_address_line1: true,
              job_type: true,
              customer: { select: { id: true } },
              lead_assignees: { select: { user_id: true } },
            },
          },
          // SERV10X-38 Task 6b — loaded so the estimate's line items can be copied onto the
          // new job's own JobLineItem rows at conversion (no information loss, Ran's lead→job
          // principle). job_line_items was a new table (Task 3); nothing populated it before.
          line_items: {
            select: {
              sequence: true,
              description: true,
              quantity: true,
              unit_price: true,
              unit_cost: true,
              is_taxable: true,
              line_total: true,
              discount_type: true,
              discount_value: true,
              discount_amount: true,
              item_type: true,
              price_book_item_id: true,
            },
            orderBy: { sequence: 'asc' },
          },
        },
      });

      if (!estimate) {
        res.status(404).json({ error: 'Estimate not found' });
        return;
      }

      // Phase B — a row-scoped creator may only create a job from an estimate on a lead they OWN
      // (parent-ownership; the SALES create-estimate precedent). Unconditional creators skip this.
      if (isRowScopedCreator && !(estimate.lead?.lead_assignees?.some((a) => a.user_id === req.user!.id) ?? false)) {
        res.status(403).json({ error: 'Insufficient permissions' });
        return;
      }

      if (estimate.status !== ESTIMATE_STATUS.WON) {
        res.status(400).json({ error: 'Estimate must be WON to create a job' });
        return;
      }

      // SERV10X-61 - already ATTACHED to a job that is not its own (mirrors the multi branch's
      // check). Since Task 3, Estimate.job_id is settable at create time, so it is no longer a
      // pure mirror of Job.estimate_id: a JOB-anchored estimate carries job_id with NO Job
      // pointing back, which the idempotency probe below cannot see. Converting it anyway
      // re-pointed the estimate off its anchor job - the anchor job silently lost that
      // estimate's paid deposit credit and its line items got billed a second time. A plain
      // re-conversion (job_id === the provenance job's id) is NOT rejected: it falls through to
      // the idempotent find-or-create, which returns the existing job.
      if (estimate.job_id != null && estimate.job_id !== estimate.job?.id) {
        res.status(400).json({ error: `Estimate ${estimate.estimate_number} is already attached to a job` });
        return;
      }

      // Deposit gate (§5/§6) — keyed to the kind=DEPOSIT Invoice (the SOLE deposit document).
      // Block creation while a configured deposit invoice is still pre-payment (DRAFT/SENT/PARTIAL).
      // PAID or VOIDED(waived) — and post-payment REFUNDED states — pass. No deposit invoice ⇒ no gate.
      const DEPOSIT_OK = ['PAID', 'VOIDED', 'PARTIALLY_REFUNDED', 'REFUNDED'];
      const depInv = await prisma.invoice.findFirst({
        where: { estimate_id, kind: 'DEPOSIT', ...tenantWhere(req) },
        select: { id: true, status: true },
      });
      if (depInv && !DEPOSIT_OK.includes(depInv.status)) {
        res.status(400).json({ error: 'Deposit must be paid or waived before creating a job. Mark the deposit as received or waive it first.' });
        return;
      }

      // Resolve the customer anchor-aware (SERV10X-61 Task 7, same as the multi branch): the
      // lead's customer when the estimate hangs off a lead, else the estimate's own customer_id
      // (NOT NULL in schema.prisma) for a lead-less, customer-anchored estimate.
      const customerId = estimate.lead?.customer_id ?? estimate.customer_id;
      if (!customerId) {
        res.status(400).json({ error: 'Estimate has no associated customer' });
        return;
      }

      // #180 fix: when the body supplies an explicit service_location_id, it wins the
      // precedence below and is written verbatim — so validate ownership/existence the SAME
      // way the standalone branch does (job.controller.ts:507-514), BEFORE the transaction.
      // ServiceLocation has no organization_id column; `customer: tenantWhere(req)` is the org
      // guard. The lead-anchor + primary fallbacks below are already customer+org scoped.
      if (service_location_id) {
        const ownedLocation = await prisma.serviceLocation.findFirst({
          where: { id: service_location_id, customer_id: customerId, customer: tenantWhere(req) },
          select: { id: true },
        });
        if (!ownedLocation) {
          res.status(404).json({ error: 'Service location not found or does not belong to customer' });
          return;
        }
      }

      // Resolve the as-executed service location (§4a/§4c): an explicit body override wins,
      // then the lead's anchored service_location_id (Phase 4a), then - for a lead-less estimate
      // - the estimate's OWN denormalized anchor, then the customer's primary location as a
      // fallback for legacy leads lacking an anchored location.
      const primaryLocation = await prisma.serviceLocation.findFirst({
        where: { customer_id: customerId, is_primary: true, customer: tenantWhere(req) },
        select: { id: true },
      });

      const locationId = service_location_id
        || estimate.lead?.service_location_id
        || estimate.service_location_id
        || primaryLocation?.id;
      if (!locationId) {
        res.status(400).json({ error: 'No service location found for customer' });
        return;
      }

      // Idempotent find-or-create (Bug #23): estimate_id is @unique, so an estimate has at most
      // one job. If it already exists, return it (200) instead of failing — the prior behavior
      // 409'd with no job, so the UI saw "a job already exists" but couldn't navigate to it.
      const existingJob = await prisma.job.findFirst({
        where: { estimate_id, ...tenantWhere(req) },
        select: jobDetailSelect,
      });
      if (existingJob) {
        res.status(200).json({ job: await safePresentJob(existingJob) });
        return;
      }

      try {
        const job = await prisma.$transaction(async (tx) => {
          const jobNumber = await allocateNumber(tx, 'job', req.user!.organization_id);

          const j = await tx.job.create({
            data: {
              job_number: jobNumber,
              organization_id: req.user!.organization_id,
              estimate_id,
              customer_id: customerId,
              service_location_id: locationId,
              scope_notes: scope_notes || null,
              scheduled_start: scheduled_start ? new Date(scheduled_start) : null,
              scheduled_end: scheduled_end ? new Date(scheduled_end) : null,
              estimated_duration: estimated_duration || null,
              job_type: estimate.job_type ?? estimate.lead?.job_type ?? null,
              // E1/E2 (job-owns-tax-discount) - inherit the estimate's tax rate and discount
              // one time, at conversion; see the select comment above.
              tax_rate: estimate.tax_rate,
              discount_type: estimate.discount_type,
              discount_value: estimate.discount_value,
              discount_amount: estimate.discount_amount,
              // SRVW-87 - mirrors the standalone branch's jobExtra: a conversion that lands the
              // job straight on the calendar must not create it as UNASSIGNED.
              ...(scheduled_start ? { status: 'SCHEDULED' as const } : {}),
              // R3b (2026-07-21) — copy the estimate's cost basis onto the new job (D18); a job
              // created from scratch (no estimate_id, see the standalone branch above) leaves
              // these null, falling back to the org default via resolveOverhead.
              labor_hours: estimate.labor_hours,
              overhead_mode: estimate.overhead_mode,
              overhead_value: estimate.overhead_value,
              // Audit: the user performing the conversion, never the estimate's own author.
              ...createdByUser(req),
            },
            select: jobDetailSelect,
          });

          // R6 (2026-07-22) — M4: keep Estimate.job_id (the new reverse-lookup mirror) in sync
          // with Job.estimate_id (the pre-existing provenance FK) at the one site that sets the
          // latter, so the denormalized column never starts drifting the moment it ships. This
          // is the only write path for Job.estimate_id today — the standalone branch above never
          // sets it, and this whole block only runs on a BRAND NEW job (the idempotent
          // find-or-create above already returned early otherwise).
          await tx.estimate.update({ where: { id: estimate_id, ...tenantWhere(req) }, data: { job_id: j.id } });

          // SERV10X-38 Task 6b — copy the estimate's line items onto the job's OWN JobLineItem
          // rows so an estimate-backed job's Items tab isn't empty (no information loss). Safe
          // to run unconditionally here: this transaction only runs when `j` is a BRAND NEW job
          // (the idempotent find-or-create above already returned early for an existing job), so
          // there is no existing-lines case to guard against / no risk of duplicating rows.
          const estimateLineItems = estimate.line_items ?? [];
          if (estimateLineItems.length > 0) {
            // LO-4: estimate→job lines are stamped NOT_TRACKED unconditionally. Logistic Orders
            // now own all stock deduction, so the legacy tracked→UNSYNCED stamp (which fed the
            // retired "Sync with inventory" flow) is gone — no catalog lookup here anymore.
            await tx.jobLineItem.createMany({
              data: estimateLineItems.map((li) => ({
                job_id: j.id,
                organization_id: req.user!.organization_id,
                sequence: li.sequence,
                description: li.description,
                quantity: li.quantity,
                unit_price: li.unit_price,
                unit_cost: li.unit_cost,
                markup_percent: null,
                is_taxable: li.is_taxable,
                line_total: li.line_total,
                discount_type: li.discount_type,
                discount_value: li.discount_value,
                discount_amount: li.discount_amount,
                item_type: li.item_type,
                price_book_item_id: li.price_book_item_id,
                stock_status: 'NOT_TRACKED' as const,
                // stock_location_id stays null (DB default).
              })),
            });
          }

          // Phase B (#232) — a row-scoped creator owns the job they create from their own lead's
          // estimate, so they can read/invoice it. Unconditional creators are not auto-assigned.
          if (isRowScopedCreator) {
            await tx.jobAssignee.createMany({ data: [{ job_id: j.id, ...selfAssigneeRow }] });
          }

          await tx.timelineEvent.create({
            data: {
              organization_id: req.user!.organization_id,
              entity_type: 'JOB',
              entity_id: j.id,
              event_type: 'CREATED',
              description: `Job ${j.job_number} created from estimate ${estimate.estimate_number}`,
              created_by: req.user!.id,
            },
          });

          return j;
        });

        // Communication ↔ Jobs (story 5) — estimate-time transactional emails predate their
        // job (attach-by-origin persists them with customer/lead only, since no job exists
        // yet), so attribution completes here, the moment the job materializes. Scoped tight:
        // system-account rows only (transactional), job_id NULL only (never re-attribute),
        // and only this estimate's lead. Fire-and-forget: a backfill failure must never fail
        // job creation (same contract as the email sends around it).
        if (estimate.lead_id) {
          try {
            await prisma.email.updateMany({
              where: {
                ...tenantWhere(req),
                account: 'system',
                job_id: null,
                lead_id: estimate.lead_id,
              },
              data: { job_id: job.id, job_label: job.job_number },
            });
          } catch (backfillErr) {
            logger.error('Estimate-email job backfill error:', backfillErr);
          }
        }

        // Clear the Dispatcher's pinned "Schedule job" notification now that the job exists.
        // Best-effort, post-commit — never blocks the response. The idempotent early-return
        // branches intentionally skip this (the first conversion already resolved it; a
        // swallowed first-resolve failure is an accepted low-probability stale-pin).
        if (estimate_id) {
          try {
            await resolveScheduleJobNotifications(estimate_id, req.user!.organization_id);
          } catch (notifyErr) {
            // #375: truly best-effort — a post-commit notification failure must not 500 a created job.
            logger.error('Post-commit schedule-notification resolve failed (job WAS created):', notifyErr);
          }
        }

        // Phase B (§E) — a row-scoped creator who lacks read Invoice shouldn't see estimate/invoice
        // pricing on the job they just made; no-op for invoice-capable creators.
        void logAudit({ req, action: 'job.created', resourceType: 'Job', resourceId: job.id, metadata: { job_number: job.job_number } });
        res.status(201).json({ job: await safePresentJob(job) });
      } catch (err: unknown) {
        if ((err as { code?: string }).code === 'P2002') {
          // Race fallback (Bug #23): a concurrent create won the @unique estimate_id. Re-query
          // and return the now-existing job (200) rather than a dead-end 409.
          const racedJob = await prisma.job.findFirst({
            where: { estimate_id, ...tenantWhere(req) },
            select: jobDetailSelect,
          });
          if (racedJob) {
            res.status(200).json({ job: await safePresentJob(racedJob) });
            return;
          }
        }
        throw err;
      }
    } else {
      // ── SERV10X-61 Task 9 (MONEY PATH) - LENGTH > 1: multiple WON estimates → ONE job ─────────
      // ALL selected estimates are ATTACHED to the new job (Estimate.job_id - the R6 EstimateJobLink
      // 1:N relation) and their line items feed the job's item list. Job.estimate_id (the 1:1
      // JobPrimaryEstimate provenance FK) is left NULL for multi - it is set ONLY when exactly one
      // estimate is selected (the single-estimate branch above). This branch only runs at length > 1.
      const estimates = await prisma.estimate.findMany({
        where: { id: { in: estimateIds }, ...tenantWhere(req) },
        select: {
          id: true,
          status: true,
          estimate_number: true,
          lead_id: true,
          // Anchor-aware customer/location resolution (Task 7): the lead's anchors when the
          // estimate hangs off a lead, else the estimate's own denormalized columns.
          customer_id: true,
          service_location_id: true,
          // Task 10b / E1 (job-owns-tax-discount): every estimate on one job must share ONE tax
          // rate - the new job stamps ITS OWN tax_rate from this set (validated below), so an
          // ambiguous set would silently pick one estimate's rate over another's.
          tax_rate: true,
          // job_id = attachment (EstimateJobLink); job = provenance reverse (JobPrimaryEstimate).
          // Both are read so an already-attached OR already-converted estimate is rejected (no
          // idempotent find-or-create for multi, unlike the single branch).
          job_id: true,
          job: { select: { id: true } },
          job_type: true,
          labor_hours: true,
          overhead_mode: true,
          overhead_value: true,
          // Union ordering: estimate created_at asc, then line sequence asc.
          created_at: true,
          lead: {
            select: {
              customer_id: true,
              service_location_id: true,
              service_address_line1: true,
              job_type: true,
              customer: { select: { id: true } },
              lead_assignees: { select: { user_id: true } },
            },
          },
          line_items: {
            select: {
              sequence: true,
              description: true,
              quantity: true,
              unit_price: true,
              unit_cost: true,
              is_taxable: true,
              line_total: true,
              discount_type: true,
              discount_value: true,
              discount_amount: true,
              item_type: true,
              price_book_item_id: true,
            },
            orderBy: { sequence: 'asc' },
          },
        },
        orderBy: { created_at: 'asc' },
      });

      // 1. All found - a missing/cross-org id shortens the list.
      if (estimates.length !== estimateIds.length) {
        res.status(404).json({ error: 'One or more estimates not found' });
        return;
      }

      // 2. Row-scope (Phase B) - a row-scoped creator may only convert estimates on leads they OWN,
      //    and here that must hold for EVERY selected estimate (generalizes the single branch's gate).
      if (isRowScopedCreator && !estimates.every((e) => e.lead?.lead_assignees?.some((a) => a.user_id === req.user!.id) ?? false)) {
        res.status(403).json({ error: 'Insufficient permissions' });
        return;
      }

      // 3. All WON.
      if (!estimates.every((e) => e.status === ESTIMATE_STATUS.WON)) {
        res.status(400).json({ error: 'All estimates must be WON to create a job' });
        return;
      }

      // 4. Same lead (from-lead flow) - every selected estimate must share ONE lead_id. A null
      //    lead_id is a valid Set member (no crash); a genuinely lead-less estimate is a length-1
      //    concern handled by the single branch above.
      if (new Set(estimates.map((e) => e.lead_id)).size > 1) {
        res.status(400).json({ error: 'All estimates must belong to the same lead' });
        return;
      }

      // 5. Unattached + unconverted - reject if ANY estimate is already attached (job_id) or already
      //    converted (job). No idempotent return for multi.
      const alreadyLinked = estimates.find((e) => e.job_id != null || e.job != null);
      if (alreadyLinked) {
        res.status(400).json({ error: `Estimate ${alreadyLinked.estimate_number} is already attached to a job` });
        return;
      }

      // 6. Deposit gate (per estimate) - block while ANY configured kind=DEPOSIT invoice is still
      //    pre-payment. PAID/VOIDED(waived) + refunded states pass; an estimate with no deposit
      //    invoice passes. Same block message as the single branch.
      const DEPOSIT_OK = ['PAID', 'VOIDED', 'PARTIALLY_REFUNDED', 'REFUNDED'];
      const depositInvoices = await prisma.invoice.findMany({
        where: { estimate_id: { in: estimateIds }, kind: 'DEPOSIT', ...tenantWhere(req) },
        select: { estimate_id: true, status: true },
      });
      if (depositInvoices.some((inv) => !DEPOSIT_OK.includes(inv.status))) {
        res.status(400).json({ error: 'Deposit must be paid or waived before creating a job. Mark the deposit as received or waive it first.' });
        return;
      }

      // ── Customer (anchor-aware) - all selected estimates must resolve the SAME customer. ──
      const customerId = estimates[0].lead?.customer_id ?? estimates[0].customer_id;
      if (!customerId) {
        res.status(400).json({ error: 'Estimate has no associated customer' });
        return;
      }
      if (!estimates.every((e) => (e.lead?.customer_id ?? e.customer_id) === customerId)) {
        res.status(400).json({ error: 'All estimates must belong to the same customer' });
        return;
      }

      // ── Same tax rate. Task 10b's createInvoiceFromJob picks ONE of the job's estimates as the
      //    invoice's tax source, which is only sound if they all agree - this is the only site
      //    that can put several estimates on one job, so enforce it here. tax_rate is a Prisma
      //    Decimal (object identity, never ===), so compare by numeric value. ──
      const taxRate = Number(estimates[0].tax_rate);
      if (!estimates.every((e) => Number(e.tax_rate) === taxRate)) {
        res.status(400).json({ error: 'All estimates must have the same tax rate' });
        return;
      }

      // ── Location precedence: body override (validate ownership, same shape as the single branch) →
      //    lead anchor → customer primary. ──
      if (service_location_id) {
        const ownedLocation = await prisma.serviceLocation.findFirst({
          where: { id: service_location_id, customer_id: customerId, customer: tenantWhere(req) },
          select: { id: true },
        });
        if (!ownedLocation) {
          res.status(404).json({ error: 'Service location not found or does not belong to customer' });
          return;
        }
      }
      const primaryLocation = await prisma.serviceLocation.findFirst({
        where: { customer_id: customerId, is_primary: true, customer: tenantWhere(req) },
        select: { id: true },
      });
      const locationId = service_location_id
        || estimates[0].lead?.service_location_id
        || estimates[0].service_location_id
        || primaryLocation?.id;
      if (!locationId) {
        res.status(400).json({ error: 'No service location found for customer' });
        return;
      }

      const job = await prisma.$transaction(async (tx) => {
        const jobNumber = await allocateNumber(tx, 'job', req.user!.organization_id);

        const j = await tx.job.create({
          data: {
            job_number: jobNumber,
            organization_id: req.user!.organization_id,
            // Provenance (1:1) is set ONLY for a single-estimate conversion; NULL for multi.
            estimate_id: estimateIds.length === 1 ? estimateIds[0] : null,
            customer_id: customerId,
            service_location_id: locationId,
            scope_notes: scope_notes || null,
            scheduled_start: scheduled_start ? new Date(scheduled_start) : null,
            scheduled_end: scheduled_end ? new Date(scheduled_end) : null,
            estimated_duration: estimated_duration || null,
            job_type: estimates[0].job_type ?? estimates[0].lead?.job_type ?? null,
            // SRVW-87 - mirrors the standalone branch's jobExtra: a conversion that lands the
            // job straight on the calendar must not create it as UNASSIGNED.
            ...(scheduled_start ? { status: 'SCHEDULED' as const } : {}),
            // Cost basis (D18) - a multi-estimate job has no single labor/overhead source of truth
            // (estimates may disagree), so leave all three NULL: resolveOverhead falls back to the
            // org default. Only a single-estimate conversion copies the estimate's basis (above).
            labor_hours: null,
            overhead_mode: null,
            overhead_value: null,
            // E1 (job-owns-tax-discount) - the set's single shared rate, already validated above.
            tax_rate: taxRate,
            // E2 - no single-discount invariant is enforced across the set (unlike tax_rate), so
            // this mirrors the cost-basis NULL treatment just above rather than guessing which
            // estimate's discount wins.
            discount_type: null,
            discount_value: null,
            discount_amount: 0,
            // Audit: the user performing the conversion, never any estimate's own author.
            ...createdByUser(req),
          },
          select: jobDetailSelect,
        });

        // Attach ALL selected estimates to the new job (Estimate.job_id / EstimateJobLink 1:N) -
        // generalizes the single branch's `estimate.update` to the whole set. The write is
        // CONDITIONAL on job_id still being null: the pre-flight "unattached" check above is
        // check-then-act and Estimate.job_id is deliberately not @unique (schema.prisma), so two
        // concurrent POSTs can both pass it and each end up with a job carrying the full union of
        // line items - one of them orphaned, drawing zero deposit credit. A short count means we
        // lost that race; throwing here rolls the whole job back.
        const attached = await tx.estimate.updateMany({
          where: { id: { in: estimateIds }, ...tenantWhere(req), job_id: null },
          data: { job_id: j.id },
        });
        if (attached.count !== estimateIds.length) {
          throw new EstimateAttachRaceError();
        }

        // Line union - estimates already come back ordered by created_at asc, each with its lines
        // ordered by sequence asc, so flatMap preserves (estimate, line) order. Re-sequence 1..N
        // CONTINUOUSLY across the whole union; per-line field mapping is identical to the single
        // branch (incl. stock_status NOT_TRACKED).
        const unionLines = estimates.flatMap((e) => e.line_items ?? []);
        if (unionLines.length > 0) {
          await tx.jobLineItem.createMany({
            data: unionLines.map((li, idx) => ({
              job_id: j.id,
              organization_id: req.user!.organization_id,
              sequence: idx + 1,
              description: li.description,
              quantity: li.quantity,
              unit_price: li.unit_price,
              unit_cost: li.unit_cost,
              markup_percent: null,
              is_taxable: li.is_taxable,
              line_total: li.line_total,
              discount_type: li.discount_type,
              discount_value: li.discount_value,
              discount_amount: li.discount_amount,
              item_type: li.item_type,
              price_book_item_id: li.price_book_item_id,
              stock_status: 'NOT_TRACKED' as const,
            })),
          });
        }

        // Phase B (#232) - a row-scoped creator owns the job they create so they can read/invoice it.
        if (isRowScopedCreator) {
          await tx.jobAssignee.createMany({ data: [{ job_id: j.id, ...selfAssigneeRow }] });
        }

        await tx.timelineEvent.create({
          data: {
            organization_id: req.user!.organization_id,
            entity_type: 'JOB',
            entity_id: j.id,
            event_type: 'CREATED',
            description: `Job ${j.job_number} created from estimate(s) ${estimates.map((e) => e.estimate_number).join(', ')}`,
            created_by: req.user!.id,
          },
        });

        return j;
      });

      // Post-commit (best-effort, never fails a committed job) - estimate-email backfill keys on the
      // shared lead; schedule-notification resolve loops per selected estimate. Same fire-and-forget
      // contract as the single branch.
      const backfillLeadId = estimates[0].lead_id;
      if (backfillLeadId) {
        try {
          await prisma.email.updateMany({
            where: { ...tenantWhere(req), account: 'system', job_id: null, lead_id: backfillLeadId },
            data: { job_id: job.id, job_label: job.job_number },
          });
        } catch (backfillErr) {
          logger.error('Estimate-email job backfill error:', backfillErr);
        }
      }
      for (const eid of estimateIds) {
        try {
          await resolveScheduleJobNotifications(eid, req.user!.organization_id);
        } catch (notifyErr) {
          logger.error('Post-commit schedule-notification resolve failed (job WAS created):', notifyErr);
        }
      }

      void logAudit({ req, action: 'job.created', resourceType: 'Job', resourceId: job.id, metadata: { job_number: job.job_number } });
      res.status(201).json({ job: await safePresentJob(job) });
    }
  } catch (err) {
    if (err instanceof EstimateAttachRaceError) {
      // Lost the attach race - nothing was committed. A conflict the caller can retry after a
      // refresh, not a server fault.
      res.status(409).json({ error: 'One or more estimates were attached to another job while this job was being created. Refresh and try again.' });
      return;
    }
    logger.error('Create job error:', err);
    res.status(500).json({ error: 'Failed to create job' });
  }
}

export async function getById(req: Request, res: Response) {
  try {
    const id = param(req, 'id');

    // Existence (+ tenant) probe → 404 a missing/cross-org id.
    const accessCheck = await prisma.job.findUnique({
      where: { id, ...tenantWhere(req) },
      select: { id: true },
    });

    if (!accessCheck) {
      res.status(404).json({ error: 'Job not found' });
      return;
    }

    // GAP-1 — per-instance gate via the grant/override-aware canAccessRow (one scoped findFirst),
    // NOT the role-literal canAccessJob which hardcoded ADMIN||DISPATCHER → true and ignored a
    // narrowed read-Job grant or a per-user DENY. Mirrors update/remove. ADMIN/unconditional-read
    // → no query (visible); a conditional read grant → the row must match the owner condition.
    if (!(await canAccessRow(req, 'Job', prisma.job, id))) {
      res.status(403).json({ error: 'Insufficient permissions' });
      return;
    }

    const job = await prisma.job.findUnique({ where: { id }, select: jobDetailSelect });

    // Phase B (§E) — strip estimate pricing for non-invoice readers BEFORE deriving remaining_unbilled
    // (so the derived figure also resolves to null once total_amount is gone). Same pipeline reused
    // by every action handler below via presentJobDetail.
    res.json({ job: await presentJobDetail(req, job) });
  } catch (err) {
    logger.error('Get job error:', err);
    res.status(500).json({ error: 'Failed to get job' });
  }
}

/**
 * D13 (Spec A) — pricing strip for GET /api/jobs/:id/financials.
 *
 * The route is gated `read Job` only, and JobDetailPage fetches it on mount, so admitting a
 * technician to the main app without this hands them the job's full money picture. Strips the
 * KEYS rather than nulling them, matching stripJobPricingForRequester's convention.
 *
 * DELIBERATELY NOT a 403: the lifecycle bar reads final_invoice.sent_at / paid_at from this
 * payload (Spec B2's Invoice Sent and Payment Received nodes), so a price-blind requester must
 * still get a well-formed answer — one without money in it. Line description and quantity also
 * survive: a technician needs to know WHAT is on the job, just not what it costs.
 *
 * Exported for unit test only.
 */
export function stripFinancialsForRequester<T extends Record<string, unknown>>(payload: T, req: Request): T {
  if (canSeePricing(req)) return payload;

  const finalInvoice = payload.final_invoice as Record<string, unknown> | null | undefined;
  const invoices = payload.invoices as Array<Record<string, unknown>> | undefined;

  return {
    ...payload,
    final_invoice: finalInvoice
      ? (({ total_amount: _t, amount_due: _d, ...rest }) => rest)(finalInvoice)
      : finalInvoice,
    invoices: (invoices ?? []).map(
      ({
        total_amount: _t, amount_due: _d, tip: _tip, tax_rate: _tr, tax_amount: _ta,
        discount_amount: _da, subtotal: _s, line_items, ...invRest
      }) => ({
        ...invRest,
        line_items: ((line_items as Array<Record<string, unknown>>) ?? []).map(
          ({
            unit_price: _u, line_total: _l, discount_type: _dt,
            discount_value: _dv, discount_amount: _lda, ...liRest
          }) => liRest,
        ),
      }),
    ),
    // Every field on a payment is about money. Return an empty array rather than omitting the
    // key so existing consumers keep mapping over an array.
    payments: [],
    // Money. `first_sent_at` is a date, not an amount, and the lifecycle bar needs it — it stays.
    total_invoiced: undefined,
    total_paid: undefined,
  } as unknown as T;
}

export async function getFinancials(req: Request, res: Response) {
  try {
    const id = param(req, 'id');

    // Only estimate_id is read below; ownership is gated by canAccessRow (its own scoped query),
    // so the assignee / lead-assignee relations the old canAccessJob needed are no longer fetched.
    const job = await prisma.job.findUnique({
      where: { id, ...tenantWhere(req) },
      // SRVW-96 - linked_estimates (the R6 EstimateJobLink back-relation) is the set
      // createInvoiceFromJob is already capable of drawing a deposit credit from
      // (job.controller.ts depositEstimateIds); surface those DEPOSIT invoices here too so the
      // credit is visible on the job before it is spent.
      select: { estimate_id: true, linked_estimates: { select: { id: true } } },
    });
    if (!job) { res.status(404).json({ error: 'Job not found' }); return; }
    // GAP-1 — per-instance gate via the grant/override-aware canAccessRow (replaces the old
    // role-literal canAccessJob, which hardcoded ADMIN||DISPATCHER → true and ignored grants).
    if (!(await canAccessRow(req, 'Job', prisma.job, id))) { res.status(403).json({ error: 'Insufficient permissions' }); return; }

    const orClauses: Prisma.InvoiceWhereInput[] = [{ job_id: id }];
    if (job.estimate_id) orClauses.push({ estimate_id: job.estimate_id });
    // `?? []` defends a shape mismatch (a stale mock, a future select drift) into today's
    // behaviour instead of a 500 on every GET /api/jobs/:id/financials - it does not mask a
    // forgotten select, which the dedicated select assertion above catches directly.
    //
    // NOT scoped to kind DEPOSIT. SRVW-96 added this clause DEPOSIT-only, which left the two link
    // directions asymmetric: the legacy provenance pointer (`{ estimate_id: job.estimate_id }`
    // above) admits every kind, while the R6 EstimateJobLink admitted only deposits. A job linked
    // ONLY via Estimate.job_id - which is exactly what the estimate-anchored conversion writes,
    // leaving jobs.estimate_id null - therefore could never resolve a `final_invoice` (derived
    // from kind STANDARD below), so its Invoice card rendered "No invoice yet" and its Balance
    // card stayed empty even with a paid deposit visible in the same tab. Widening it does move
    // total_invoiced/total_paid/first_sent_at once such a job is invoiced; that is the point, and
    // it is the same figure the provenance path has always reported for the identical shape.
    // Double-counting a drawn-down deposit stays guarded by total_paid's back-derivation from
    // total_amount - amount_due rather than from summing Payment rows.
    const linkedEstimateIds = (job.linked_estimates ?? []).map((e) => e.id).filter((eid) => eid !== job.estimate_id);
    if (linkedEstimateIds.length) orClauses.push({ estimate_id: { in: linkedEstimateIds } });

    const invoices = await prisma.invoice.findMany({
      where: { ...tenantWhere(req), OR: orClauses },
      select: {
        id: true, invoice_number: true, kind: true, status: true,
        total_amount: true, amount_due: true, sent_at: true, paid_at: true, voided_at: true,
        tip: true, tax_rate: true, tax_amount: true, discount_amount: true, subtotal: true,
        line_items: {
          select: {
            id: true, sequence: true, description: true, quantity: true,
            unit_price: true, is_taxable: true, line_total: true,
            discount_type: true, discount_value: true, discount_amount: true,
            item_type: true, price_book_item_id: true,
            // Photo for the Items-tab editor — from the linked catalog item (null for custom lines).
            price_book_item: { select: { image_url: true, photo_url: true } },
          },
          orderBy: { sequence: 'asc' as const },
        },
        payments: {
          where: { voided_at: null },
          select: {
            id: true, amount: true, method: true, paid_at: true, voided_at: true, reference_number: true,
            // Task 3.4 (spec §7.3) — per-payment fee breakdown for the job PaymentsTab; null
            // until Stripe reconciliation lands (Task 3.3) or for non-CARD payments.
            stripe_fee_amount: true, platform_fee_amount: true, net_amount: true,
            // net_amount is measured against face + service fee + tip (reconcile-stripe-fees.ts
            // reads Stripe's charge.amount) while `amount` is face only, so the breakdown needs
            // both additive terms or it renders a Net larger than its own Gross.
            service_fee_amount: true, tip_amount: true,
          },
          orderBy: { paid_at: 'asc' as const },
        },
        // SRVW-84 - total_paid below back-derives cash from total_amount - amount_due, so it needs
        // the credit notes to net out. Rides this query's existing tenantWhere(req) scope.
        credits: { select: { amount: true } },
      },
      orderBy: { created_at: 'asc' as const },
    });

    const finalInvoice = [...invoices]
      .filter((i) => i.kind === 'STANDARD' && !i.voided_at)
      .sort((a, b) => (a.invoice_number < b.invoice_number ? 1 : -1))[0] ?? null;

    // Multi-draw aggregates (Spec B2). The bar summarises the JOB, not the latest invoice.
    // `final_invoice` stays in the payload — PaymentsTab and the invoice links use it.
    //
    // `invoices` (via `orClauses` above) can include BOTH the job's STANDARD draws AND, when the
    // job came from an estimate, that estimate's kind=DEPOSIT invoice. A paid deposit's credit is
    // applied to a STANDARD invoice as a SEPARATE, real Payment row (tagged DEPOSIT-CREDIT) while
    // the deposit invoice keeps its own original Payment — the same money is then backed by two
    // live Payment rows. Summing raw `payments` across the whole set (deposit + STANDARD) would
    // double-count it, so `first_sent_at`/`total_paid` are scoped to STANDARD invoices only
    // (matching `total_invoiced`'s existing scope), and `total_paid` is derived from each
    // STANDARD invoice's own `total_amount - amount_due` (which already nets out cash payments
    // AND deposit credit, exactly once) rather than from summing Payment rows across the set.
    //
    // SRVW-84 - a credit note lowers `amount_due` without any cash being collected, so it is
    // subtracted here too; otherwise a write-off reports as money received. The per-invoice
    // Math.max is a SECOND, distinct correction: this line carried no clamp at all, so an invoice
    // with amount_due > total_amount contributed a negative figure that offset a sibling invoice's
    // real cash (0 such rows on staging today, so it is inert).
    const live = invoices.filter((i) => !i.voided_at);
    const standardLive = live.filter((i) => i.kind === 'STANDARD');
    const sentDates = standardLive.map((i) => i.sent_at).filter((d): d is Date => d != null);
    const firstSentAt = sentDates.length ? sentDates.reduce((a, b) => (a < b ? a : b)) : null;
    const totalInvoiced = Math.round(
      standardLive.reduce((s, i) => s + Number(i.total_amount), 0) * 100,
    ) / 100;
    const totalPaid = Math.round(
      standardLive.reduce(
        (s, i) => s + amountPaidOf(Number(i.total_amount), 0, Number(i.amount_due), creditsTotalOf(i.credits)),
        0,
      ) * 100,
    ) / 100;

    const payments = invoices.flatMap((inv) =>
      inv.payments.map((p) => ({
        id: p.id, invoice_id: inv.id, invoice_number: inv.invoice_number, invoice_kind: inv.kind,
        amount: p.amount, method: p.method, paid_at: p.paid_at, voided_at: p.voided_at, reference_number: p.reference_number,
        // Task 3.4 — carry the reconciled fee breakdown through (null for cash/check/legacy or
        // not-yet-reconciled CARD payments; PaymentsTab renders nothing in that case).
        stripe_fee_amount: p.stripe_fee_amount, platform_fee_amount: p.platform_fee_amount, net_amount: p.net_amount,
        service_fee_amount: p.service_fee_amount, tip_amount: p.tip_amount,
      })),
    );

    res.json(stripFinancialsForRequester({
      final_invoice: finalInvoice && {
        id: finalInvoice.id, invoice_number: finalInvoice.invoice_number, status: finalInvoice.status,
        total_amount: finalInvoice.total_amount, amount_due: finalInvoice.amount_due,
        sent_at: finalInvoice.sent_at, paid_at: finalInvoice.paid_at,
      },
      // `credits` is dropped alongside payments/voided_at: it is an input to total_paid above,
      // not a payload field. stripFinancialsForRequester removes money from invoices[] by NAME,
      // so leaving it in would leak credit amounts to a price-blind requester (SRVW-84).
      invoices: invoices.map(({ payments, voided_at, credits, ...rest }) => rest),
      payments,
      first_sent_at: firstSentAt,
      total_invoiced: totalInvoiced,
      total_paid: totalPaid,
    }, req));
  } catch (err) {
    logger.error('Get job financials error:', err);
    res.status(500).json({ error: 'Failed to get job financials' });
  }
}

/**
 * D14 (Spec A) — does this PATCH body actually move the job on the calendar?
 *
 * `update Job` became a TECHNICIAN role default in D3, and updateJobSchema accepts the schedule
 * fields, so without this the OFF-by-default `reschedule` toggle could never bite. Compares
 * VALUES rather than key presence: a client that round-trips the whole job object sends
 * scheduled_start unchanged, and that is not a reschedule.
 *
 * Exported for unit test only.
 */
export function changesSchedule(
  body: Record<string, unknown>,
  existing: { scheduled_start: Date | null; scheduled_end: Date | null; is_all_day: boolean },
): boolean {
  const sameInstant = (a: unknown, b: Date | null) => {
    if (a === undefined) return true;              // absent → not a change
    if (a === null || b === null) return a === null && b === null;
    return new Date(a as string).getTime() === b.getTime();
  };
  if (!sameInstant(body.scheduled_start, existing.scheduled_start)) return true;
  if (!sameInstant(body.scheduled_end, existing.scheduled_end)) return true;
  if (body.is_all_day !== undefined && body.is_all_day !== existing.is_all_day) return true;
  return false;
}

/**
 * SRVW-87 - the status a PATCH-reschedule writes, or `undefined` for "leave the status alone"
 * (Prisma treats an undefined data key as a no-op, so a non-schedule PATCH writes no status).
 *
 * This deliberately does NOT reuse assign()'s `status: scheduled_start ? 'SCHEDULED' :
 * existing.status`. That derivation is paired there with `milestoneClears('scheduled')` and a
 * post-commit `revertPlanVisitOnUncomplete`, so copying it here would mean that correcting a typo
 * in a COMPLETED job's date silently demotes the job, nulls completed_at/on_site_at/started_at,
 * and flips the linked PlanVisit back to SCHEDULED. COMPLETED feeds the dashboard's
 * completed-this-month KPI, so that is a reporting corruption, not a cosmetic one.
 *
 * PATCH is the EDIT door, not the scheduler: it moves a job only between the two states that are
 * defined purely by whether a time exists, and never touches EN_ROUTE / ON_SITE / IN_PROGRESS /
 * COMPLETED / CANCELLED. A caller who genuinely wants the milestone rewind uses POST /:id/assign.
 *
 * The demote branch fires regardless of crew, mirroring unassign(), which drops to UNASSIGNED and
 * KEEPS the crew: the codebase's stated invariant is that status derives from TIME, not crew, and
 * leaving a timeless job SCHEDULED would reproduce the badge-vs-lifecycle-bar disagreement in the
 * opposite direction.
 *
 * Exported for unit test only.
 */
export function deriveStatusOnReschedule(
  current: JobStatus,
  startTouched: boolean,
  nextStart: Date | null,
): JobStatus | undefined {
  if (!startTouched) return undefined;
  if (nextStart && current === 'UNASSIGNED') return 'SCHEDULED';
  if (!nextStart && current === 'SCHEDULED') return 'UNASSIGNED';
  return undefined;
}

export async function update(req: Request, res: Response) {
  try {
    const existing = await prisma.job.findUnique({
      where: { id: param(req, 'id'), ...tenantWhere(req) },
      select: {
        id: true, status: true, customer_id: true, source_plan_id: true,
        service_location: { select: { state: true } },
        // #106 ownership relations the role's grant condition references (OWN_JOB /
        // OWN_JOB_VIA_ESTIMATE) — required for the per-instance can() to bind.
        assignees: { select: { user_id: true } },
        estimate: { select: { lead: { select: { lead_assignees: { select: { user_id: true } } } } } },
        // D14 — changesSchedule needs the CURRENT schedule to compare the PATCH body against.
        scheduled_start: true, scheduled_end: true, is_all_day: true,
        // E1/E2 (job-owns-tax-discount) - customer.tax_exempt clamps an incoming tax_rate;
        // job_line_items/scopes give the CURRENT subtotal a discount edit resolves against;
        // discount_type is read as the pre-edit fallback when only discount_value is sent.
        customer: { select: { tax_exempt: true } },
        job_line_items: { select: { quantity: true, unit_price: true, is_taxable: true } },
        scopes: true,
        discount_type: true,
        discount_value: true,
        // SRVW-114 slice 1 - the pre-edit bag a custom_fields patch merges onto.
        custom_fields: true,
      },
    });

    if (!existing) {
      res.status(404).json({ error: 'Job not found' });
      return;
    }

    // #106 — base update must do a PER-INSTANCE owner check, not rely on the subject-level
    // route guard (a conditional `update Job` grant passes the guard for ANY job). 403 a job
    // the requester does not own under their grant condition. Uses the SQL-based canAccessRow
    // (one scoped findFirst) rather than the in-memory CASL matcher: a NESTED Team/Location
    // grant (assignees.some.user.department_id) makes `can()` THROW → 500; the where-fragment
    // compiles to SQL and is nested-safe.
    if (!(await canAccessRow(req, 'Job', prisma.job, existing.id))) {
      res.status(403).json({ error: 'Insufficient permissions' });
      return;
    }

    // D14 — rescheduling is a distinct capability from editing a job. A technician holds
    // `update Job` by role default (D3) but `reschedule Job` only if an admin granted the
    // per-user toggle. ADMIN/DISPATCHER pass on their unconditional grant.
    if (
      changesSchedule(req.body as Record<string, unknown>, existing) &&
      !req.ability?.can('reschedule', 'Job')
    ) {
      res.status(403).json({ error: 'You do not have permission to reschedule this job' });
      return;
    }

    // Technician-ownership spec, Part C - the job's money fields ride the SAME PATCH as harmless
    // ones like scope_notes, so `manage_lines Job` cannot be enforced at the route the way it is
    // for the line-item and scope routes. Field-level check here, same shape as D14 above.
    //
    // Deliberately PRESENCE-based, not value-based like changesSchedule: a caller sending a
    // discount at all is asserting authority over the money, and a "same value" carve-out would
    // let a round-tripping client re-assert a discount it may not set. Cheap, and the failure
    // direction is refusal rather than a silent write.
    //
    // PER-INSTANCE, not `req.ability.can('manage_lines','Job')`. A bare ability check is
    // subject-level: it answers "could you ever", which is TRUE for every technician now that the
    // role holds a creator-conditioned `manage_lines Job`. canActOnRow asks the row.
    //
    // The list is DERIVED from updateJobSchema by exclusion (see MANAGE_LINES_FIELDS above) rather
    // than hand-written. A hand-written list is what failed review: `labor_hours`, `overhead_mode`
    // and `overhead_value` - the job COST MODEL, the margin side of the very surface the spec says
    // follows creation - were omitted, and their only other guard was canSeePricing, which had been
    // fail-closed for technicians purely because the role held no `read Pricing`. This PR grants it,
    // so an assigned non-creator could have set the job's labour and overhead.
    const body = req.body as Record<string, unknown>;
    if (
      MANAGE_LINES_FIELDS.some((field) => body[field] !== undefined) &&
      !(await canActOnRow(req, 'Job', prisma.job, existing.id, 'manage_lines'))
    ) {
      res.status(403).json({ error: 'You do not have permission to edit this job\'s pricing' });
      return;
    }

    // customer_id is intentionally NOT in updateJobSchema — re-pointing the customer is a
    // cancel + create, not an edit. address/service_location_id drive the §10 location re-point.
    const { scope_notes, job_type, service_location_id, address, estimated_duration, scheduled_start, scheduled_end, labor_hours, overhead_mode, overhead_value, tax_rate, discount_type, discount_value, force, custom_fields } = req.body;

    // SRVW-114 slice 1 - validate BEFORE merging/writing anything: an unknown/cross-org/archived
    // definition id or a value that doesn't match its definition's type 400s here rather than
    // landing in the job's custom_fields bag.
    let nextCustomFields: Record<string, unknown> | undefined;
    if (custom_fields !== undefined) {
      try {
        await validateCustomFieldValues(req.user!.organization_id, 'JOB', custom_fields);
      } catch (err) {
        if (err instanceof CustomFieldValidationError) {
          res.status(400).json({ error: err.message });
          return;
        }
        throw err;
      }
      nextCustomFields = mergeCustomFields(existing.custom_fields as Record<string, unknown> | null, custom_fields);
    }

    // Spec B1 (free status transitions) — no status-ordering gate here. A job in any status
    // stays editable; the reschedule guard above and the cost-field guard below are the real
    // (ability-based) authorization checks, not the job's current status.

    // R3b (2026-07-21) — labor_hours/overhead_mode/overhead_value are staff-only cost-model
    // inputs (D2/D8). A requester who can't see pricing (canSeePricing gates read Invoice) must
    // not be able to blindly set them either — mirrors the read-side strip in
    // stripJobPricingForRequester and Estimate's identical guard in estimate.controller.ts.
    // E1/E2 (job-owns-tax-discount) - tax_rate/discount_* are money edits too, same gate.
    if (
      (labor_hours !== undefined || overhead_mode !== undefined || overhead_value !== undefined
        || tax_rate !== undefined || discount_type !== undefined || discount_value !== undefined)
      && !canSeePricing(req)
    ) {
      res.status(403).json({ error: 'Insufficient permissions to edit cost fields' });
      return;
    }

    // E1 (job-owns-tax-discount) - SRVW-82's exemption clamp, mirroring estimate.controller.ts:
    // a tax-exempt customer owes no sales tax, so the exemption is applied to the RATE, not just
    // the computed amount.
    const requestedTaxRate = tax_rate !== undefined
      ? (existing.customer?.tax_exempt ? 0 : tax_rate)
      : undefined;

    // E2 - discount_amount is ALWAYS server-resolved, never trusted from the client (the schema
    // doesn't even accept it). Resolved as a RATE against the job's CURRENT subtotal at the
    // moment of this edit, then frozen (billingFor reads it back as-is) - the whole point being
    // that it must not silently drift as the item set changes AFTER this PATCH (see the
    // migration's rationale). Only recomputed when the discount is actually touched.
    let discountUpdate: { discount_type: 'PERCENTAGE' | 'FIXED_AMOUNT' | null; discount_value: number | null; discount_amount: number } | undefined;
    if (discount_type !== undefined || discount_value !== undefined) {
      const effectiveDiscountType = discount_type !== undefined ? discount_type : existing.discount_type;
      const effectiveDiscountValue = discount_value !== undefined
        ? discount_value
        : (existing.discount_value != null ? Number(existing.discount_value) : null);
      const totals = recomputeInvoiceTotals({
        lines: (existing.job_line_items ?? []).map((l) => ({
          quantity: Number(l.quantity), unit_price: Number(l.unit_price), is_taxable: l.is_taxable,
        })),
        scopes: toScopeForTotals(asScopeArray(existing.scopes)),
        taxRate: 0,
        taxExempt: false,
        discountType: effectiveDiscountType,
        discountValue: effectiveDiscountValue,
      });
      discountUpdate = {
        discount_type: effectiveDiscountType ?? null,
        discount_value: effectiveDiscountValue,
        discount_amount: totals.discount_amount,
      };
    }

    // SRVW-87 - resolve the window this PATCH LANDS ON (body value where the key is present,
    // current row value where it is absent), then run the same crew-conflict detection assign()
    // runs. Before this, a PATCH-reschedule was the one door that could silently double-book a
    // crew. Three deliberate details, so none of them gets "fixed" later by mistake:
    //  (i)   the gate is `timeMoved` - the resolved window actually moving - NOT changesSchedule.
    //        changesSchedule is also true for an is_all_day-only body, and that must not newly
    //        409 a job that already overlapped something at a window nobody is changing.
    //  (ii)  `existing.assignees ?? []` is defensive on purpose: the select above always asks for
    //        assignees, but several test fixtures build the row without the key, and today only
    //        the timeMoved gate keeps that undefined from being dereferenced.
    //  (iii) a start with a null end skips detection. That is reachable, because updateJobSchema
    //        deliberately has no start/end pairing refine (see the schema comment).
    const startTouched = scheduled_start !== undefined;
    const nextStart = startTouched ? (scheduled_start ? new Date(scheduled_start) : null) : existing.scheduled_start;
    const nextEnd = scheduled_end !== undefined ? (scheduled_end ? new Date(scheduled_end) : null) : existing.scheduled_end;
    const timeMoved =
      (nextStart?.getTime() ?? null) !== (existing.scheduled_start?.getTime() ?? null)
      || (nextEnd?.getTime() ?? null) !== (existing.scheduled_end?.getTime() ?? null);
    // SRVW-112 - hoisted out of the data object below so the status write and the sub-status
    // clear read ONE value. Still `undefined` on a non-schedule PATCH, which Prisma no-ops.
    const derivedStatus = deriveStatusOnReschedule(existing.status, startTouched, nextStart);

    if (timeMoved && !force && nextStart && nextEnd) {
      const conflicts = await detectCrewConflicts(req, {
        jobId: existing.id,
        userIds: (existing.assignees ?? []).map((a) => a.user_id),
        schedStart: nextStart,
        schedEnd: nextEnd,
      });
      if (conflicts.length > 0) {
        // Byte-stable with assign()'s 409 - the FE retry path reads this exact shape.
        res.status(409).json({ error: 'Schedule conflict detected', conflicts });
        return;
      }
    }

    const wantsLocationChange = Boolean(service_location_id) || Boolean(address);
    let taxWarning: ReturnType<typeof buildLocationTaxWarning> = null;

    try {
      const job = await prisma.$transaction(async (tx) => {
        let resolvedLocationId: string | undefined = undefined;

        if (wantsLocationChange) {
          // Pick-existing or accrete the location on THIS job's customer (forward-only —
          // the lead is never touched; lead = as-sold, job = as-executed).
          const resolved = await resolveOrAccreteLocation(tx, {
            customerId: existing.customer_id,
            orgId: req.user!.organization_id,
            service_location_id: service_location_id ?? null,
            address: address ?? null,
          });
          resolvedLocationId = resolved.id;
          taxWarning = buildLocationTaxWarning(existing.service_location?.state ?? null, resolved.state);
        }

        const j = await tx.job.update({
          where: { id: existing.id },
          data: {
            scope_notes: scope_notes !== undefined ? scope_notes : undefined,
            job_type: job_type !== undefined ? job_type : undefined,
            service_location_id: resolvedLocationId,
            estimated_duration: estimated_duration !== undefined ? estimated_duration : undefined,
            // SRVW-87 - UNASSIGNED <-> SCHEDULED only, and NO milestoneClears / no
            // revertPlanVisitOnUncomplete: see deriveStatusOnReschedule for why PATCH must not
            // adopt assign()'s pairing.
            status: derivedStatus,
            // SRVW-112 - reuses SRVW-87's own derived status rather than recomputing it. undefined
            // means "leave the status alone", which is also exactly when a set sub-status stays
            // valid, so the ?? existing.status collapses that case to {}.
            ...subStatusClears(existing.status, derivedStatus ?? existing.status),
            scheduled_start: startTouched ? nextStart : undefined,
            scheduled_end: scheduled_end !== undefined ? nextEnd : undefined,
            labor_hours: labor_hours !== undefined ? (labor_hours ?? null) : undefined,
            overhead_mode: overhead_mode !== undefined ? (overhead_mode || null) : undefined,
            overhead_value: overhead_value !== undefined ? (overhead_value ?? null) : undefined,
            tax_rate: requestedTaxRate,
            ...(discountUpdate ?? {}),
            // SRVW-114 slice 1 - already the FULL merged bag (existing + patch), not the raw
            // patch: a bare overwrite here would drop every field the patch didn't mention.
            custom_fields: nextCustomFields !== undefined ? (nextCustomFields as Prisma.InputJsonValue) : undefined,
          },
          select: jobDetailSelect,
        });

        if (resolvedLocationId) {
          await tx.timelineEvent.create({
            data: {
              organization_id: req.user!.organization_id,
              entity_type: 'JOB',
              entity_id: existing.id,
              event_type: 'JOB_LOCATION_CHANGED',
              description: `Service location updated for job ${j.job_number}`,
              metadata: {
                to_location_id: resolvedLocationId,
                old_state: existing.service_location?.state ?? null,
                new_state: taxWarning?.new_state ?? null,
              },
              created_by: req.user!.id,
            },
          });
        }

        // Keep the linked service-plan visit's date in sync when a visit-job is rescheduled —
        // the plan's next-due / scheduler bucket read PlanVisit, so a Job-only date change would
        // leave them stale. Gated on source_plan_id, so it's a no-op for normal jobs.
        if (existing.source_plan_id && scheduled_start) {
          await tx.planVisit.updateMany({
            where: { job_id: existing.id, ...tenantWhere(req) },
            data: { scheduled_date: new Date(scheduled_start) },
          });
        }

        return j;
      });

      // Phase B (§E) — strip pricing for a non-invoice-reader (e.g. a tech granted `update Job`
      // per-user without read Invoice); no-op for invoice readers.
      const presented = await presentJobDetail(req, job);
      void logAudit({ req, action: 'job.updated', resourceType: 'Job', resourceId: existing.id, metadata: { fields: Object.keys(req.body) } });
      res.json({ job: presented, ...(taxWarning ? { tax_warning: taxWarning } : {}) });
    } catch (err) {
      if (err instanceof LocationResolutionError) {
        res.status(400).json({ error: err.message });
        return;
      }
      throw err;
    }
  } catch (err) {
    logger.error('Update job error:', err);
    res.status(500).json({ error: 'Failed to update job' });
  }
}

export async function remove(req: Request, res: Response) {
  try {
    const existing = await prisma.job.findUnique({
      where: { id: param(req, 'id'), ...tenantWhere(req) },
      select: {
        id: true, status: true, job_number: true, invoices: { select: { id: true, status: true } },
        // #106 ownership relations (OWN_JOB / OWN_JOB_VIA_ESTIMATE) for the per-instance check.
        assignees: { select: { user_id: true } },
        estimate: { select: { lead: { select: { lead_assignees: { select: { user_id: true } } } } } },
      },
    });

    if (!existing) {
      res.status(404).json({ error: 'Job not found' });
      return;
    }

    // #106 — base delete must do a PER-INSTANCE owner check (the subject-level route guard
    // passes for ANY job under a conditional `delete Job` grant). 403 a job the requester
    // does not own under their grant condition. SQL-based (one scoped findFirst) rather than the
    // in-memory CASL matcher: a NESTED Team/Location grant (assignees.some.user.department_id)
    // makes `can()` THROW → 500; the where-fragment is nested-safe.
    //
    // canActOnRow, NOT canAccessRow: `delete Job` is creator-scoped for a technician while
    // `read Job` is assigned-OR-created, so the read fragment alone would let every assignee
    // delete the job (technician-ownership spec, Part C).
    if (!(await canActOnRow(req, 'Job', prisma.job, existing.id, 'delete'))) {
      res.status(403).json({ error: 'Insufficient permissions' });
      return;
    }

    // B-12 (Spec B1): `Invoice.job_id` is `onDelete: Restrict` regardless of the invoice's
    // status, so a job whose only invoice is VOIDED still throws a Prisma P2003 → generic 500
    // if this only checked for a non-voided invoice. Block on ANY invoice existing at all.
    if (existing.invoices.length > 0) {
      res.status(400).json({ error: 'Cannot delete a job that has an invoice' });
      return;
    }

    // Inventory P1 (§4.3 / QA-416): auto-return SYNCED lines BEFORE the job row (and its
    // cascading JobLineItem rows, onDelete: Cascade) die. Movement inserts must precede the
    // delete — the line FKs must exist at insert; SetNull then keeps the ledger rows with the
    // reference string. No UNSYNCED stamping — the rows die with the job.
    const actor = `${req.user!.first_name ?? ''} ${req.user!.last_name ?? ''}`.trim() || 'Unknown';
    // Logistic Orders (spec §14 C1): resolve the job's LOs PRE-TX (pool discipline). The job's
    // invoices are all VOIDED by the delete guard, so their invoice-anchored LOs were already
    // unwound by the void verb (the CAS no-ops them here) — the job anchor is all this needs.
    const loUnwind = await collectAnchoredLoUnwind(prisma, {
      orgId: req.user!.organization_id,
      where: { job_id: existing.id },
      actor,
      actorUserId: req.user!.id,
    });
    await prisma.$transaction(async (tx) => {
      const syncedLines = await tx.jobLineItem.findMany({
        where: { job_id: existing.id, stock_status: 'SYNCED' },
        select: { id: true, quantity: true, price_book_item_id: true, stock_location_id: true },
      });
      await returnSyncedLines(tx, syncedLines, {
        orgId: req.user!.organization_id,
        reference: `${existing.job_number} deleted`,
        actor,
        actorUserId: req.user!.id,
        jobId: existing.id,
        lineRef: 'job',
      });
      // Return PROCESSED LOs and cancel open ones BEFORE the job row dies — the return movement's
      // logistic_order_line_id FK must exist at insert. The LO row itself SURVIVES the delete
      // unanchored (job_id SetNull) as a historical document (E10).
      await applyAnchoredLoUnwind(tx, loUnwind, { cancelOpen: true });
      await tx.job.delete({ where: { id: existing.id } });
    });

    void logAudit({ req, action: 'job.deleted', resourceType: 'Job', resourceId: existing.id });
    res.json({ message: 'Job deleted' });
  } catch (err) {
    logger.error('Delete job error:', err);
    res.status(500).json({ error: 'Failed to delete job' });
  }
}

// ─── Status Actions ─────────────────────────────────────

/**
 * Dispatch TECH_UNASSIGNED for each removed crew member, carrying their
 * identity as eventPayload.recipient — by the time an automation fires
 * they're already off the crew, so nothing downstream can re-derive who they
 * were from the job row. Never throws: a lookup failure must not turn an
 * otherwise-successful crew change into a 500; the event still dispatches,
 * just without a captured recipient (falls back to "no one to notify" at the
 * removed_user audience, same as any other unresolvable audience).
 */
async function dispatchTechUnassigned(
  req: Request,
  removedIds: string[],
  job: { id: string; label: string },
): Promise<void> {
  if (removedIds.length === 0) return;
  let removedUsers: { id: string; email: string | null; first_name: string; last_name: string }[] = [];
  try {
    removedUsers = (await prisma.user.findMany({
      where: { id: { in: removedIds }, ...tenantWhere(req) },
      select: { id: true, email: true, first_name: true, last_name: true },
    })) ?? [];
  } catch (err) {
    logger.warn('Failed to resolve removed technicians for TECH_UNASSIGNED — dispatching without a recipient', err);
  }
  for (const uid of removedIds) {
    const u = removedUsers.find((x) => x.id === uid);
    dispatchAutomationEvent({
      type: 'TECH_UNASSIGNED',
      organizationId: req.user!.organization_id,
      entity: { type: 'job', id: job.id, label: job.label },
      occurrenceKey: uid,
      actorId: req.user?.id ?? null,
      ...(u ? { eventPayload: { recipient: u } } : {}),
    });
  }
}

export async function assign(req: Request, res: Response) {
  try {
    const id = param(req, 'id');
    // assignee_ids is the FULL new crew (REPLACE semantics; [] is a valid state-4 schedule).
    const { assignee_ids, scheduled_start, scheduled_end, is_all_day, force } = req.body as {
      assignee_ids: string[];
      scheduled_start?: string;
      scheduled_end?: string;
      is_all_day?: boolean;
      force?: boolean;
    };

    let computedEnd = scheduled_end ? new Date(scheduled_end) : null;
    if (is_all_day && scheduled_start && !scheduled_end) {
      const start = new Date(scheduled_start);
      computedEnd = new Date(start.getTime() + 24 * 60 * 60 * 1000);
    }

    const existing = await prisma.job.findUnique({
      where: { id, ...tenantWhere(req) },
      select: {
        id: true, status: true, job_number: true, source_plan_id: true,
        scheduled_start: true,
        customer_scheduled_email_sent_at: true,
        customer: { select: { id: true, first_name: true, last_name: true, company_name: true, email: true } },
        service_location: { select: { address_line1: true, city: true, state: true } },
        scope_notes: true,
        assignees: { select: { user_id: true } },
      },
    });

    if (!existing) {
      res.status(404).json({ error: 'Job not found' });
      return;
    }

    // Per-instance crew-authority check (technician-ownership spec, Part C). The route guard
    // `canDo('assign','Job')` is SUBJECT-level, and until this PR only DISPATCHER/ADMIN held the
    // action - both unconditionally - so no handler here ever needed a row check. A technician now
    // holds it conditioned on `created_by_id`, so without this every technician could re-crew every
    // job in the org. canActOnRow intersects that verb scope with the read scope.
    if (!(await canActOnRow(req, 'Job', prisma.job, existing.id, 'assign'))) {
      res.status(403).json({ error: 'Insufficient permissions' });
      return;
    }

    // Eligibility: every crew member must be an active, assignable in-org user.
    const crew = await validateCrew(req, assignee_ids);
    if (!crew.ok) {
      res.status(crew.status).json({ error: crew.error });
      return;
    }

    // Crew diff vs the CURRENT crew (drives conflict scope + diff-emails).
    const currentIds = new Set(existing.assignees.map((a) => a.user_id));
    const nextIds = new Set(assignee_ids);
    const addedIds = assignee_ids.filter((uid) => !currentIds.has(uid));
    const keptIds = assignee_ids.filter((uid) => currentIds.has(uid));
    const removedIds = [...currentIds].filter((uid) => !nextIds.has(uid));

    // Did the schedule time change? (a state-4→state-2 add, or a true reschedule)
    const newStart = scheduled_start ? new Date(scheduled_start) : null;
    const timeChanged =
      (existing.scheduled_start?.getTime() ?? null) !== (newStart?.getTime() ?? null);

    // Conflict detection: PER added member; plus KEPT members only when the time also changed
    // (a kept member at a brand-new slot can newly collide elsewhere).
    if (!force && scheduled_start && computedEnd) {
      const conflictUserIds = timeChanged ? [...addedIds, ...keptIds] : addedIds;
      const conflicts = await detectCrewConflicts(req, {
        jobId: id,
        userIds: conflictUserIds,
        schedStart: new Date(scheduled_start),
        schedEnd: computedEnd,
      });
      if (conflicts.length > 0) {
        res.status(409).json({ error: 'Schedule conflict detected', conflicts });
        return;
      }
    }

    // status derives from TIME, not crew: SCHEDULED iff a time is present, else keep current.
    // SRVW-112 - hoisted to ONE const so the status write and subStatusClears below cannot drift
    // apart: a crew-only assign (no scheduled_start) keeps existing.status and must therefore
    // leave a still-valid sub-status alone.
    const nextStatus: JobStatus = scheduled_start ? 'SCHEDULED' : existing.status;
    // First-schedule with crew≥1 → send the customer "scheduled" email + stamp the flag now.
    const isFirstScheduleWithCrew = existing.status === 'UNASSIGNED' && assignee_ids.length > 0 && Boolean(scheduled_start);
    const stampScheduledFlag = isFirstScheduleWithCrew && existing.customer_scheduled_email_sent_at == null;

    const job = await prisma.$transaction(async (tx) => {
      await replaceJobCrew(tx, id, req.user!.organization_id, assignee_ids);

      const updated = await tx.job.update({
        where: { id },
        data: {
          status: nextStatus,
          ...subStatusClears(existing.status, nextStatus),
          scheduled_start: scheduled_start ? new Date(scheduled_start) : undefined,
          scheduled_end: computedEnd ?? undefined,
          is_all_day: is_all_day ?? false,
          ...(stampScheduledFlag ? { customer_scheduled_email_sent_at: new Date() } : {}),
          // Only a real reschedule rewinds the milestones (Spec B1, Step 6b). A crew-only
          // assign (no scheduled_start in the body) must not null completed_at while leaving
          // status COMPLETED -- that row would report as not-completed and, because canComplete
          // excludes COMPLETED, could not be re-completed from the UI.
          ...(scheduled_start ? milestoneClears('scheduled') : {}),
        },
        select: jobDetailSelect,
      });

      // Reschedule sync: a calendar drag re-dates the Job here, so mirror the new date onto the
      // linked service-plan visit (the plan's next-due / bucket read PlanVisit). No-op for normal jobs.
      if (existing.source_plan_id && scheduled_start) {
        await tx.planVisit.updateMany({
          where: { job_id: id, ...tenantWhere(req) },
          data: { scheduled_date: new Date(scheduled_start) },
        });
      }

      // Diff TimelineEvents: one per crew change (replaces the single ASSIGNED event).
      for (const uid of addedIds) {
        const u = crew.users.find((x) => x.id === uid);
        await tx.timelineEvent.create({
          data: {
            organization_id: req.user!.organization_id,
            entity_type: 'JOB',
            entity_id: id,
            event_type: 'CREW_MEMBER_ADDED',
            description: `${u ? `${u.first_name} ${u.last_name}` : 'A crew member'} added to job ${existing.job_number}`,
            created_by: req.user!.id,
          },
        });
      }
      for (const uid of removedIds) {
        await tx.timelineEvent.create({
          data: {
            organization_id: req.user!.organization_id,
            entity_type: 'JOB',
            entity_id: id,
            event_type: 'CREW_MEMBER_REMOVED',
            description: `A crew member removed from job ${existing.job_number}`,
            created_by: req.user!.id,
          },
        });
      }

      if (newStart && timeChanged) {
        await tx.timelineEvent.create({
          data: {
            organization_id: req.user!.organization_id,
            entity_type: 'JOB',
            entity_id: id,
            event_type: existing.scheduled_start ? 'RESCHEDULED' : 'SCHEDULED',
            description: existing.scheduled_start
              ? `Job ${existing.job_number} rescheduled`
              : `Job ${existing.job_number} scheduled`,
            metadata: { from: existing.scheduled_start?.toISOString() ?? null, to: newStart.toISOString() },
            created_by: req.user!.id,
          },
        });
      }

      return updated;
    });

    if (scheduled_start && clearsCompletion('scheduled')) {
      await revertPlanVisitOnUncomplete(req, id, existing.source_plan_id);
    }

    // ─── In-app notification hooks — POST-COMMIT (must NOT run inside the txn; #271) ──
    // Best-effort: emit() never throws.
    if (addedIds.length > 0) {
      await emit({
        verb: 'dispatch.job_assigned',
        organizationId: req.user!.organization_id,
        actorId: req.user?.id ?? null,
        object: { type: 'JOB', id, label: existing.job_number },
        entity: { assignee_ids: addedIds },
        data: {
          object_label: existing.job_number,
          scheduled_start: (newStart ?? existing.scheduled_start)?.toISOString() ?? null,
        },
      });
    }
    if (removedIds.length > 0) {
      await emit({
        verb: 'dispatch.job_unassigned',
        organizationId: req.user!.organization_id,
        actorId: req.user?.id ?? null,
        object: { type: 'JOB', id, label: existing.job_number },
        entity: { assignee_ids: removedIds },
        data: {
          object_label: existing.job_number,
          scheduled_start: (newStart ?? existing.scheduled_start)?.toISOString() ?? null,
        },
      });
    }
    if (timeChanged && addedIds.length === 0) {
      // Reschedule with no crew change: notify all kept/current assignees.
      await emit({
        verb: 'dispatch.job_rescheduled',
        organizationId: req.user!.organization_id,
        actorId: req.user?.id ?? null,
        object: { type: 'JOB', id, label: existing.job_number },
        entity: { assignee_ids: keptIds },
        data: {
          object_label: existing.job_number,
          scheduled_start: (newStart ?? existing.scheduled_start)?.toISOString() ?? null,
        },
      });
    }

    // ─── Automation Center events — post-commit, fire-and-forget (#271) ──────
    for (const uid of addedIds) {
      const addedUser = crew.users.find((x) => x.id === uid);
      dispatchAutomationEvent({
        type: 'TECH_ASSIGNED',
        organizationId: req.user!.organization_id,
        entity: { type: 'job', id, label: existing.job_number },
        occurrenceKey: uid,
        actorId: req.user?.id ?? null,
        ...(addedUser ? { eventPayload: { recipient: addedUser } } : {}),
      });
    }
    await dispatchTechUnassigned(req, removedIds, { id, label: existing.job_number });
    // Narrowed to match the customer-facing email gates exactly (stampScheduledFlag /
    // the reschedule flag check below) — parity with the hard-coded senders these
    // dispatches replace. Do not simplify back to `newStart && timeChanged` alone,
    // nor to bare isFirstScheduleWithCrew; either would dispatch (and, once a default
    // automation is enabled, actually send) in states the hard-coded email never did
    // (see phase 3 cutover plan). stampScheduledFlag = isFirstScheduleWithCrew AND the
    // send-guard flag still unset, so a job that was backward-cleared and re-assigned
    // does not announce "scheduled" to the customer a second time.
    if (stampScheduledFlag) {
      dispatchAutomationEvent({
        type: 'JOB_SCHEDULED',
        organizationId: req.user!.organization_id,
        entity: { type: 'job', id, label: existing.job_number },
        actorId: req.user?.id ?? null,
      });
    }
    if (
      existing.status === 'SCHEDULED' &&
      assignee_ids.length > 0 &&
      existing.customer_scheduled_email_sent_at != null &&
      newStart &&
      timeChanged
    ) {
      dispatchAutomationEvent({
        type: 'JOB_RESCHEDULED',
        organizationId: req.user!.organization_id,
        entity: { type: 'job', id, label: existing.job_number },
        occurrenceKey: newStart.toISOString(),
        actorId: req.user?.id ?? null,
      });
    }
    if (newStart && timeChanged && existing.scheduled_start) {
      void rearmAnchoredWaits('job', id);
    }

    res.json({ job: await presentJobDetail(req, job) });
  } catch (err) {
    logger.error('Assign job error:', err);
    res.status(500).json({ error: 'Failed to assign job' });
  }
}

// Crew-only REPLACE (Step 5.6): never reads/writes status or scheduling fields. Per-member
// eligibility + diff TimelineEvents + diff-emails (assignment per added, unassigned per removed).
// No customer email, no flag change.
export async function setAssignees(req: Request, res: Response) {
  try {
    const id = param(req, 'id');
    const { assignee_ids, notify } = req.body as {
      assignee_ids: string[];
      notify?: { in_app?: boolean; email?: boolean };
    };

    const existing = await prisma.job.findUnique({
      where: { id, ...tenantWhere(req) },
      select: {
        id: true, status: true, job_number: true,
        customer: { select: { first_name: true, last_name: true, company_name: true } },
        service_location: { select: { address_line1: true, city: true, state: true } },
        scope_notes: true,
        scheduled_start: true,
        assignees: { select: { user_id: true } },
      },
    });

    if (!existing) {
      res.status(404).json({ error: 'Job not found' });
      return;
    }

    // Per-instance crew-authority check (technician-ownership spec, Part C). The route guard
    // `canDo('assign','Job')` is SUBJECT-level, and until this PR only DISPATCHER/ADMIN held the
    // action - both unconditionally - so no handler here ever needed a row check. A technician now
    // holds it conditioned on `created_by_id`, so without this every technician could re-crew every
    // job in the org. canActOnRow intersects that verb scope with the read scope.
    if (!(await canActOnRow(req, 'Job', prisma.job, existing.id, 'assign'))) {
      res.status(403).json({ error: 'Insufficient permissions' });
      return;
    }

    const crew = await validateCrew(req, assignee_ids);
    if (!crew.ok) {
      res.status(crew.status).json({ error: crew.error });
      return;
    }

    const currentIds = new Set(existing.assignees.map((a) => a.user_id));
    const nextIds = new Set(assignee_ids);
    const addedIds = assignee_ids.filter((uid) => !currentIds.has(uid));
    const removedIds = [...currentIds].filter((uid) => !nextIds.has(uid));

    const job = await prisma.$transaction(async (tx) => {
      await replaceJobCrew(tx, id, req.user!.organization_id, assignee_ids);

      for (const uid of addedIds) {
        const u = crew.users.find((x) => x.id === uid);
        await tx.timelineEvent.create({
          data: {
            organization_id: req.user!.organization_id,
            entity_type: 'JOB',
            entity_id: id,
            event_type: 'CREW_MEMBER_ADDED',
            description: `${u ? `${u.first_name} ${u.last_name}` : 'A crew member'} added to job ${existing.job_number}`,
            created_by: req.user!.id,
          },
        });
      }
      for (const _uid of removedIds) {
        await tx.timelineEvent.create({
          data: {
            organization_id: req.user!.organization_id,
            entity_type: 'JOB',
            entity_id: id,
            event_type: 'CREW_MEMBER_REMOVED',
            description: `A crew member removed from job ${existing.job_number}`,
            created_by: req.user!.id,
          },
        });
      }

      // Re-read via the detail select (crew-only mutation; status/schedule untouched).
      return tx.job.findUnique({ where: { id }, select: jobDetailSelect });
    });

    // ─── In-app notification hooks — POST-COMMIT (must NOT run inside the txn; #271) ──
    // #361: notify.in_app:false suppresses ONLY the added-crew emit; removal stays unconditional.
    if (addedIds.length > 0 && notify?.in_app !== false) {
      await emit({
        verb: 'dispatch.job_assigned',
        organizationId: req.user!.organization_id,
        actorId: req.user?.id ?? null,
        object: { type: 'JOB', id, label: existing.job_number },
        entity: { assignee_ids: addedIds },
        data: {
          object_label: existing.job_number,
          scheduled_start: existing.scheduled_start?.toISOString() ?? null,
        },
      });
    }
    if (removedIds.length > 0) {
      await emit({
        verb: 'dispatch.job_unassigned',
        organizationId: req.user!.organization_id,
        actorId: req.user?.id ?? null,
        object: { type: 'JOB', id, label: existing.job_number },
        entity: { assignee_ids: removedIds },
        data: {
          object_label: existing.job_number,
          scheduled_start: existing.scheduled_start?.toISOString() ?? null,
        },
      });
    }

    // ─── Automation Center events — post-commit, fire-and-forget (#271) ──────
    // #361: notify.email:false suppresses ONLY the added-crew TECH_ASSIGNED dispatch —
    // parity with the (now-deleted) sendJobAssignmentEmail gate at the bottom of this
    // function. Removal (TECH_UNASSIGNED) stays unconditional, same as today.
    if (notify?.email !== false) {
      for (const uid of addedIds) {
        const addedUser = crew.users.find((x) => x.id === uid);
        dispatchAutomationEvent({
          type: 'TECH_ASSIGNED',
          organizationId: req.user!.organization_id,
          entity: { type: 'job', id, label: existing.job_number },
          occurrenceKey: uid,
          actorId: req.user?.id ?? null,
          ...(addedUser ? { eventPayload: { recipient: addedUser } } : {}),
        });
      }
    }
    await dispatchTechUnassigned(req, removedIds, { id, label: existing.job_number });

    res.json({ job: await presentJobDetail(req, job) });
  } catch (err) {
    logger.error('Set assignees error:', err);
    res.status(500).json({ error: 'Failed to set job assignees' });
  }
}

// #291 — set or clear Job.dispatcher_id (JCC Team card). Only ADMIN/DISPATCHER-role,
// active, same-org users are eligible. Never touches status/schedule/crew.
export async function setDispatcher(req: Request, res: Response) {
  try {
    const id = param(req, 'id');
    const { dispatcher_id } = req.body as { dispatcher_id: string | null };

    const existing = await prisma.job.findUnique({
      where: { id, ...tenantWhere(req) },
      select: { id: true, job_number: true, dispatcher_id: true, estimate: { select: { lead_id: true } } },
    });

    if (!existing) {
      res.status(404).json({ error: 'Job not found' });
      return;
    }

    // Per-instance crew-authority check (technician-ownership spec, Part C). The route guard
    // `canDo('assign','Job')` is SUBJECT-level, and until this PR only DISPATCHER/ADMIN held the
    // action - both unconditionally - so no handler here ever needed a row check. A technician now
    // holds it conditioned on `created_by_id`, so without this every technician could re-crew every
    // job in the org. canActOnRow intersects that verb scope with the read scope.
    if (!(await canActOnRow(req, 'Job', prisma.job, existing.id, 'assign'))) {
      res.status(403).json({ error: 'Insufficient permissions' });
      return;
    }

    let targetName: string | null = null;
    if (dispatcher_id !== null) {
      const target = await prisma.user.findUnique({
        where: { id: dispatcher_id, ...tenantWhere(req) },
        select: { id: true, role: true, is_active: true, first_name: true, last_name: true },
      });
      if (!target) {
        res.status(404).json({ error: 'User not found' });
        return;
      }
      if (!isDispatcherEligible(target.role)) {
        res.status(400).json({ error: 'This user is not eligible to be assigned as dispatcher' });
        return;
      }
      if (!target.is_active) {
        res.status(400).json({ error: 'Cannot assign an inactive user as dispatcher' });
        return;
      }
      targetName = `${target.first_name} ${target.last_name}`;
    }

    const changed = existing.dispatcher_id !== dispatcher_id;

    const job = await prisma.$transaction(async (tx) => {
      await tx.job.update({ where: { id }, data: { dispatcher_id } });

      if (changed) {
        await tx.timelineEvent.create({
          data: {
            organization_id: req.user!.organization_id,
            entity_type: 'JOB',
            entity_id: id,
            event_type: 'DISPATCHER_CHANGED',
            description: dispatcher_id
              ? `${targetName} set as dispatcher on job ${existing.job_number}`
              : `Dispatcher cleared on job ${existing.job_number}`,
            created_by: req.user!.id,
          },
        });

        // #585 — mirror the change onto the originating lead's timeline (traceability).
        if (existing.estimate?.lead_id) {
          await tx.timelineEvent.create({
            data: {
              organization_id: req.user!.organization_id,
              entity_type: 'LEAD',
              entity_id: existing.estimate.lead_id,
              event_type: 'DISPATCHER_CHANGED',
              description: dispatcher_id
                ? `${targetName} set as dispatcher on job ${existing.job_number}`
                : `Dispatcher cleared on job ${existing.job_number}`,
              created_by: req.user!.id,
            },
          });
        }
      }

      // Re-read via the detail select (dispatcher-only mutation; status/schedule untouched).
      return tx.job.findUnique({ where: { id }, select: jobDetailSelect });
    });

    void logAudit({
      req,
      action: 'job.dispatcher_set',
      resourceType: 'Job',
      resourceId: id,
      metadata: { dispatcher_id },
    });

    res.json({ job: await presentJobDetail(req, job) });
  } catch (err) {
    logger.error('Set job dispatcher error:', err);
    res.status(500).json({ error: 'Failed to set job dispatcher' });
  }
}

/**
 * SRVW-112 - POST /api/jobs/:id/sub-status. The ONLY writer of a non-null Job.sub_status_id.
 * (The eight status verbs also write the column, but only ever to null - see subStatusClears.)
 *
 * Two guards, in this order:
 *  1. TENANCY. The incoming id is resolved through a tenant-scoped findFirst BEFORE it is written
 *     as an FK, so a guessed uuid can never attach another org's label to a job and have it
 *     rendered on the detail page and the list. A miss answers 404, not 403, so the endpoint is
 *     not an existence oracle for other tenants' rows.
 *  2. PARENT MATCH. A sub-status whose parent differs from the job's CURRENT status is a 400.
 *     Picking a sub-status deliberately does not move the parent (unlike Workiz) - the user moves
 *     the job first, then labels it. That is what lets every status handler clear the label on a
 *     status change without ever reading sub_status.parent.
 */
export async function setSubStatus(req: Request, res: Response) {
  try {
    const id = param(req, 'id');
    const { sub_status_id } = req.body as z.infer<typeof setSubStatusSchema>;

    const existing = await prisma.job.findUnique({
      where: { id, ...tenantWhere(req) },
      select: { id: true, status: true, job_number: true, sub_status_id: true },
    });

    if (!existing) {
      res.status(404).json({ error: 'Job not found' });
      return;
    }

    // Same per-instance owner gate update() uses (#106b) - a technician with `update Job` may
    // label their OWN job, not any job in the org.
    if (!(await canAccessRow(req, 'Job', prisma.job, existing.id))) {
      res.status(403).json({ error: 'Insufficient permissions' });
      return;
    }

    let sub: { id: string; label: string; parent: JobStatus } | null = null;
    if (sub_status_id !== null) {
      sub = await prisma.jobSubStatus.findFirst({
        where: { id: sub_status_id, ...tenantWhere(req) },
        select: { id: true, label: true, parent: true },
      });
      if (!sub) {
        res.status(404).json({ error: 'Sub-status not found' });
        return;
      }
      if (sub.parent !== existing.status) {
        res.status(400).json({ error: 'That sub-status belongs to a different job status' });
        return;
      }
    }

    const job = await prisma.job.update({
      where: { id, ...tenantWhere(req) },
      data: { sub_status_id: sub?.id ?? null },
      select: jobDetailSelect,
    });

    await prisma.timelineEvent.create({
      data: {
        organization_id: req.user!.organization_id,
        entity_type: 'JOB',
        entity_id: id,
        // event_type is a plain String column - no enum migration needed for a new kind.
        event_type: 'JOB_SUB_STATUS_CHANGED',
        description: sub
          ? `Sub-status set to "${sub.label}" on job ${existing.job_number}`
          : `Sub-status cleared on job ${existing.job_number}`,
        metadata: { from: existing.sub_status_id, to: sub?.id ?? null },
        created_by: req.user!.id,
      },
    });

    // ─── Automation Center event — post-commit, fire-and-forget (#271) ────────
    // "Entered" must mean a deliberate label, never the implicit clear
    // subStatusClears performs during a status change - only the SET path
    // (sub !== null) fires this, never the clear path above.
    if (sub) {
      dispatchAutomationEvent({
        type: 'JOB_SUB_STATUS_ENTERED',
        organizationId: req.user!.organization_id,
        entity: { type: 'job', id, label: existing.job_number },
        occurrenceKey: sub.id,
        actorId: req.user?.id ?? null,
      });
    }

    res.json({ job: await presentJobDetail(req, job) });
  } catch (err) {
    logger.error('Set job sub-status error:', err);
    res.status(500).json({ error: 'Failed to set job sub-status' });
  }
}

export async function unassign(req: Request, res: Response) {
  try {
    const id = param(req, 'id');

    const existing = await prisma.job.findUnique({
      where: { id, ...tenantWhere(req) },
      select: { id: true, status: true, job_number: true, source_plan_id: true },
    });

    if (!existing) {
      res.status(404).json({ error: 'Job not found' });
      return;
    }

    // Per-instance crew-authority check (technician-ownership spec, Part C). The route guard
    // `canDo('unassign','Job')` is SUBJECT-level, and until this PR only DISPATCHER/ADMIN held the
    // action - both unconditionally - so no handler here ever needed a row check. A technician now
    // holds it conditioned on `created_by_id`, so without this every technician could re-crew every
    // job in the org. canActOnRow intersects that verb scope with the read scope.
    if (!(await canActOnRow(req, 'Job', prisma.job, existing.id, 'unassign'))) {
      res.status(403).json({ error: 'Insufficient permissions' });
      return;
    }

    // UNSCHEDULE (crew ⟂ schedule): clear the TIME only and drop to UNASSIGNED. The crew is KEPT
    // (state 3: crewed-unscheduled). No customer email.
    const job = await prisma.job.update({
      where: { id, ...tenantWhere(req) },
      data: {
        status: 'UNASSIGNED',
        ...subStatusClears(existing.status, 'UNASSIGNED'),
        scheduled_start: null,
        scheduled_end: null,
      },
      select: jobDetailSelect,
    });

    await prisma.timelineEvent.create({
      data: {
        organization_id: req.user!.organization_id,
        entity_type: 'JOB',
        entity_id: id,
        event_type: 'UNASSIGNED',
        description: `Job ${existing.job_number} moved to Unassigned (crew kept)`,
        created_by: req.user!.id,
      },
    });

    // Service-plan visit hook: unscheduling the visit-job frees its PlanVisit slot back to the
    // plan (CANCELLED visits are excluded from the term-scoped remaining count), so the plan
    // reappears in the scheduler bucket. Mirrors complete()'s PlanVisit hook — plain prisma (no surrounding transaction).
    //
    // B-3 (Spec B1): gated on the job NOT being COMPLETED. Free status transitions make
    // `unassign` reachable from COMPLETED — without this gate, unassigning a finished visit-job
    // as housekeeping would free its slot back to the plan (derive.ts's ACTIONED excludes
    // CANCELLED from the consumed count), handing the customer an extra visit on a fixed-visit
    // contract. The crew/schedule are still cleared either way; only the plan-visit cascade
    // is skipped for a completed visit.
    if (existing.source_plan_id && existing.status !== 'COMPLETED') {
      await prisma.planVisit.updateMany({
        where: { job_id: id, ...tenantWhere(req) },
        data: { status: 'CANCELLED' },
      });
    }

    res.json({ job: await presentJobDetail(req, job) });
  } catch (err) {
    logger.error('Unassign job error:', err);
    res.status(500).json({ error: 'Failed to unassign job' });
  }
}

export async function start(req: Request, res: Response) {
  try {
    const id = param(req, 'id');

    const existing = await prisma.job.findUnique({
      where: { id, ...tenantWhere(req) },
      select: { id: true, status: true, assignees: { select: { user_id: true } }, job_number: true, source_plan_id: true },
    });

    if (!existing) {
      res.status(404).json({ error: 'Job not found' });
      return;
    }

    // Admins/dispatchers may start any job in their org; a technician may only start a job
    // they are assigned to (the route guard already verified the `start Job` capability).
    const isOrgManager = req.ability!.can('manage', 'all' as Subject) || req.user!.role === 'DISPATCHER';
    if (!isOrgManager && !existing.assignees.some((a) => a.user_id === req.user!.id)) {
      res.status(403).json({ error: 'Insufficient permissions' });
      return;
    }

    // B-9 (Spec B1): timeline event written BEFORE the update -- see arrive() for why.
    const clears = milestoneClears('started');
    await prisma.timelineEvent.create({
      data: {
        organization_id: req.user!.organization_id,
        entity_type: 'JOB',
        entity_id: id,
        event_type: 'STARTED',
        description: `Job ${existing.job_number} started`,
        metadata: Object.keys(clears).length ? { cleared: Object.keys(clears) } : undefined,
        created_by: req.user!.id,
      },
    });

    const job = await prisma.job.update({
      where: { id, ...tenantWhere(req) },
      data: {
        status: 'IN_PROGRESS',
        ...subStatusClears(existing.status, 'IN_PROGRESS'),
        started_at: new Date(),
        ...clears,
      },
      select: jobDetailSelect,
    });

    if (clearsCompletion('started')) {
      await revertPlanVisitOnUncomplete(req, id, existing.source_plan_id);
    }

    // ─── In-app notification hook ───────────────────────────────────────────
    await emit({
      verb: 'job.started',
      organizationId: req.user!.organization_id,
      actorId: req.user?.id ?? null,
      object: { type: 'JOB', id, label: existing.job_number },
      entity: {
        assignee_ids: existing.assignees.map((a) => a.user_id),
        sold_by_id: (job as any).estimate?.lead?.commission_owner?.id as string | undefined,
      },
      data: { object_label: existing.job_number },
    });

    res.json({ job: await presentJobDetail(req, job) });
  } catch (err) {
    logger.error('Start job error:', err);
    res.status(500).json({ error: 'Failed to start job' });
  }
}

export async function complete(req: Request, res: Response) {
  try {
    const id = param(req, 'id');
    const { completion_notes, signature_data, signature_ip, signature_at } = req.body;

    const existing = await prisma.job.findUnique({
      where: { id, ...tenantWhere(req) },
      select: {
        id: true,
        status: true,
        started_at: true,
        assignees: { select: { user_id: true } },
        job_number: true,
        source_plan_id: true,
      },
    });

    if (!existing) {
      res.status(404).json({ error: 'Job not found' });
      return;
    }

    // Admins/dispatchers may complete any job in their org; a technician may only complete a
    // job they are assigned to (the route guard already verified the `complete Job` capability).
    const isAssignedToJob = existing.assignees.some((a) => a.user_id === req.user!.id);
    const isOrgManager = req.ability!.can('manage', 'all' as Subject) || req.user!.role === 'DISPATCHER';
    if (!isOrgManager && !isAssignedToJob) {
      res.status(403).json({ error: 'Insufficient permissions' });
      return;
    }

    // B-9 (Spec B1): timeline event written BEFORE the update -- see arrive() for why. complete()
    // moves FORWARD -- milestoneClears('completed') only un-cancels, nothing to report as cleared.
    await prisma.timelineEvent.create({
      data: {
        organization_id: req.user!.organization_id,
        entity_type: 'JOB',
        entity_id: id,
        event_type: 'COMPLETED',
        description: `Job ${existing.job_number} completed`,
        created_by: req.user!.id,
      },
    });

    const job = await prisma.job.update({
      where: { id, ...tenantWhere(req) },
      data: {
        status: 'COMPLETED',
        ...subStatusClears(existing.status, 'COMPLETED'),
        completed_at: new Date(),
        // A job closed out directly from a pre-IN_PROGRESS status was never `start()`ed, so
        // started_at would otherwise stay null forever — backfill it to the completion time
        // (zero duration) so duration reporting never has to handle a null start.
        started_at: existing.started_at ?? new Date(),
        // Preserve-on-omission. These are WORK PRODUCT: a signature captured on the first
        // completion is still valid on a re-completion, and the client sends no body at all
        // (JobDetailPage.tsx posts /complete with an empty body). Null-on-omission was safe
        // only while re-completing was impossible (isJobCompletable excluded COMPLETED); Spec
        // B1 removed that guard, making an empty-body re-completion a one-click way to erase a
        // signed record if this stayed null-on-omission.
        completion_notes: completion_notes !== undefined ? (completion_notes || null) : undefined,
        signature_data: signature_data !== undefined ? (signature_data || null) : undefined,
        signature_ip: signature_ip !== undefined ? (signature_ip || null) : undefined,
        signature_at: signature_at !== undefined ? (signature_at ? new Date(signature_at) : null) : undefined,
        ...milestoneClears('completed'),
      },
      select: jobDetailSelect,
    });

    // Service-plan visit hook: completing the visit-job moves its PlanVisit into History.
    // Status-only and payment-irrelevant (the plan was paid upfront).
    if (existing.source_plan_id) {
      await prisma.planVisit.updateMany({
        where: { job_id: id, ...tenantWhere(req) },
        data: { status: 'COMPLETED', completed_at: new Date() },
      });
    }

    // ─── In-app notification hook ───────────────────────────────────────────
    await emit({
      verb: 'job.completed',
      organizationId: req.user!.organization_id,
      actorId: req.user?.id ?? null,
      object: { type: 'JOB', id, label: existing.job_number },
      entity: {
        assignee_ids: existing.assignees.map((a) => a.user_id),
        sold_by_id: (job as any).estimate?.lead?.commission_owner?.id as string | undefined,
      },
      data: { object_label: existing.job_number },
    });

    // ─── Automation Center event — post-commit, fire-and-forget (#271) ───────
    dispatchAutomationEvent({
      type: 'JOB_COMPLETED',
      organizationId: req.user!.organization_id,
      entity: { type: 'job', id, label: existing.job_number },
      actorId: req.user?.id ?? null,
    });

    res.json({ job: await presentJobDetail(req, job) });
  } catch (err) {
    logger.error('Complete job error:', err);
    res.status(500).json({ error: 'Failed to complete job' });
  }
}

export async function cancel(req: Request, res: Response) {
  try {
    const id = param(req, 'id');
    const { cancelled_reason } = req.body;

    const existing = await prisma.job.findUnique({
      where: { id, ...tenantWhere(req) },
      select: {
        id: true,
        status: true,
        job_number: true,
        source_plan_id: true,
        // §8 cascade inputs: the job's open invoices to void + collected money to surface.
        invoices: {
          select: {
            id: true,
            status: true,
            kind: true,
            amount_due: true,
            total_amount: true,
            payments: { where: { voided_at: null }, select: { amount: true, reference_number: true } },
            refunds: { select: { amount: true } },
          },
        },
      },
    });

    if (!existing) {
      res.status(404).json({ error: 'Job not found' });
      return;
    }

    // Spec B1: cancellation is not terminal and every status is reachable from every state, so
    // a COMPLETED job may now be cancelled (and a CANCELLED job re-cancelled). This still
    // unconditionally voids every open invoice below with no confirmation of amounts/counts —
    // that is a KNOWN, PRE-EXISTING defect, tracked separately as #891, deliberately NOT fixed
    // in this PR. This PR only widens who can reach the existing cascade; it does not touch it.
    const invoices = existing.invoices ?? [];
    // OPEN/billable, non-terminal invoices get voided to $0 (DRAFT is delete-able, not voidable;
    // PAID/VOIDED/REFUNDED are terminal and intentionally left for the admin's §8 refund).
    const openToVoid = invoices.filter((inv) => inv.status === 'SENT' || inv.status === 'PARTIAL');
    // Collected money across ALL the job's invoices = Σ REAL non-voided payments − Σ refunds.
    // Synthetic DEPOSIT-CREDIT rows (the non-cash credit transfer invoice.create writes onto a
    // STANDARD invoice when a deposit is drawn down) are NOT new money — mirror refundInvoice's
    // NON_CREDIT_PAYMENT_FILTER and drop them, else collected_total / refund_suggested inflate by
    // the applied deposit amount. Surfaced for the admin's separate §8 refund action (default
    // refund-all) — NEVER auto-refunded here.
    const collectedTotal = Math.round(
      invoices.reduce((sum, inv) => {
        const paid = (inv.payments ?? [])
          .filter((p) => p.reference_number !== DEPOSIT_CREDIT_REFERENCE)
          .reduce((s, p) => s + Number(p.amount), 0);
        const refunded = (inv.refunds ?? []).reduce((s, r) => s + Number(r.amount), 0);
        return sum + paid - refunded;
      }, 0) * 100,
    ) / 100;
    const voidedInvoiceIds = openToVoid.map((inv) => inv.id);
    const actor = `${req.user!.first_name ?? ''} ${req.user!.last_name ?? ''}`.trim() || 'Unknown';

    // Logistic Orders (spec §14 C1/H1): resolve — PRE-TX, on the global client (pool discipline) —
    // every LO anchored to this job OR to one of the cascade-voided invoices. A DRAFT invoice is
    // NOT in openToVoid, so its LO is intentionally excluded here and unwound later by the invoice's
    // own verb (E11). A multi-anchor (job + voided-invoice) LO is surfaced by both clauses and
    // de-duplicated by returnProcessedLo's compare-and-set, never a special case (E7/E8).
    const loUnwind = await collectAnchoredLoUnwind(prisma, {
      orgId: req.user!.organization_id,
      where: voidedInvoiceIds.length
        ? [{ job_id: id }, { invoice_id: { in: voidedInvoiceIds } }]
        : { job_id: id },
      actor,
      actorUserId: req.user!.id,
    });

    const job = await prisma.$transaction(async (tx) => {
      for (const inv of openToVoid) {
        await tx.invoice.update({
          where: { id: inv.id },
          data: {
            status: 'VOIDED',
            voided_at: new Date(),
            voided_reason: 'Job cancelled',
            amount_due: 0,
          },
        });
        // Inventory P1 (§4.2): a cascade-voided invoice returns its invoice-BORN synced lines
        // in this same tx — otherwise cancelling a job with an ad-hoc-deducted invoice line
        // strands that deduction (D2). Job-copied lines on these invoices are NOT_TRACKED by
        // §5.2 construction and stay silent; the SYNCED filter IS the scope rule.
        const invSyncedLines = await tx.invoiceLineItem.findMany({
          where: { invoice_id: inv.id, stock_status: 'SYNCED' },
          select: { id: true, quantity: true, price_book_item_id: true, stock_location_id: true },
        });
        if (invSyncedLines.length > 0) {
          await returnSyncedLines(tx, invSyncedLines, {
            orgId: req.user!.organization_id,
            reference: `${existing.job_number} cancelled — invoice voided`,
            actor,
            actorUserId: req.user!.id,
            jobId: id,
            lineRef: 'invoice',
          });
          await tx.invoiceLineItem.updateMany({
            where: { invoice_id: inv.id, stock_status: 'SYNCED' },
            data: { stock_status: 'UNSYNCED' },
          });
        }
        await tx.timelineEvent.create({
          data: {
            organization_id: req.user!.organization_id,
            entity_type: 'INVOICE',
            entity_id: inv.id,
            event_type: 'INVOICE_VOIDED',
            description: `Invoice voided: job ${existing.job_number} cancelled`,
            created_by: req.user!.id,
          },
        });
        // Mirror the amount_invoiced decrement for each STANDARD invoice voided (cached billing
        // tracker — only a STANDARD bill counts as billed).
        if (inv.kind === 'STANDARD') {
          await tx.job.update({
            where: { id },
            data: { amount_invoiced: { decrement: Number(inv.total_amount) } },
          });
        }
      }

      // Inventory P1 (D2 / QA-413): auto-return every SYNCED job line inside the same tx.
      // Lines stay rows; stock_status→UNSYNCED after the return so ledger + UI agree. Cancel
      // is terminal (no un-cancel verb) — sync/deduct on CANCELLED jobs is refused, so
      // UNSYNCED here can never silently re-deduct.
      const syncedLines = await tx.jobLineItem.findMany({
        where: { job_id: id, stock_status: 'SYNCED' },
        select: { id: true, quantity: true, price_book_item_id: true, stock_location_id: true },
      });
      if (syncedLines.length > 0) {
        await returnSyncedLines(tx, syncedLines, {
          orgId: req.user!.organization_id,
          reference: `${existing.job_number} cancelled`,
          actor,
          actorUserId: req.user!.id,
          jobId: id,
          lineRef: 'job',
        });
        await tx.jobLineItem.updateMany({
          where: { job_id: id, stock_status: 'SYNCED' },
          data: { stock_status: 'UNSYNCED' },
        });
      }

      // Logistic Orders (spec §14 C1/H1): PROCESSED LOs auto-return their stock and flip to
      // RETURNED; open LOs (DRAFT/PENDING_APPROVAL/APPROVED) flip to CANCELLED. returnProcessedLo
      // is the ONLY unwind path, and its CAS is what makes a multi-anchor LO return exactly once.
      await applyAnchoredLoUnwind(tx, loUnwind, { cancelOpen: true });

      const updated = await tx.job.update({
        where: { id, ...tenantWhere(req) },
        data: {
          status: 'CANCELLED',
          ...subStatusClears(existing.status, 'CANCELLED'),
          cancelled_at: new Date(),
          cancelled_reason,
        },
        select: jobDetailSelect,
      });

      await tx.timelineEvent.create({
        data: {
          organization_id: req.user!.organization_id,
          entity_type: 'JOB',
          entity_id: id,
          event_type: 'CANCELLED',
          description: `Job ${existing.job_number} cancelled`,
          metadata: { reason: cancelled_reason, collected_total: collectedTotal, voided_invoice_ids: voidedInvoiceIds },
          created_by: req.user!.id,
        },
      });

      // Service-plan visit hook: cancelling the visit-job frees its PlanVisit slot back to the
      // plan (CANCELLED visits are excluded from the term-scoped remaining count).
      if (existing.source_plan_id) {
        await tx.planVisit.updateMany({
          where: { job_id: id, ...tenantWhere(req) },
          data: { status: 'CANCELLED' },
        });
      }

      return updated;
    });

    // ─── In-app notification hook ───────────────────────────────────────────
    await emit({
      verb: 'job.cancelled',
      organizationId: req.user!.organization_id,
      actorId: req.user?.id ?? null,
      object: { type: 'JOB', id, label: existing.job_number },
      entity: {
        assignee_ids: ((job as any)?.assignees ?? []).map((a: { user: { id: string } }) => a.user.id),
        sold_by_id: (job as any)?.estimate?.lead?.commission_owner?.id as string | undefined,
      },
      data: { object_label: existing.job_number, cancelled_reason },
    });

    // ─── Automation Center event — post-commit, fire-and-forget (#271) ───────
    dispatchAutomationEvent({
      type: 'JOB_CANCELLED',
      organizationId: req.user!.organization_id,
      entity: { type: 'job', id, label: existing.job_number },
      actorId: req.user?.id ?? null,
      eventPayload: { mergeFields: { 'event.reason': cancelled_reason } },
    });

    // GAP-5 — collected_total/refund_suggested are money figures and live OUTSIDE the
    // presentJobDetail pricing strip; gate them behind the same read-Invoice check so a
    // pricing-restricted role (a tech granted cancel, or a DISPATCHER narrowed off Invoice) does
    // not receive them. voided_invoice_ids (operational, non-money) is always returned.
    res.json({
      job: await presentJobDetail(req, job),
      ...(canSeePricing(req) ? { collected_total: collectedTotal, refund_suggested: collectedTotal > 0 } : {}),
      voided_invoice_ids: voidedInvoiceIds,
    });
  } catch (err) {
    logger.error('Cancel job error:', err);
    res.status(500).json({ error: 'Failed to cancel job' });
  }
}

export async function reopen(req: Request, res: Response) {
  try {
    const id = param(req, 'id');

    const existing = await prisma.job.findUnique({
      where: { id, ...tenantWhere(req) },
      select: { id: true, status: true, job_number: true, invoices: { select: { status: true } } },
    });

    if (!existing) {
      res.status(404).json({ error: 'Job not found' });
      return;
    }

    // Spec B1: job state and invoice state are independent under the backward-clearing rule —
    // a sent invoice stays sent when the job reopens (invoice/payment state is never touched by
    // a job-status click; it only reverses through void/refund). Every status is reachable from
    // every other, so reopen no longer requires COMPLETED nor an absent issued invoice.
    const job = await prisma.job.update({
      where: { id, ...tenantWhere(req) },
      data: {
        status: 'IN_PROGRESS',
        ...subStatusClears(existing.status, 'IN_PROGRESS'),
        completed_at: null,
      },
      select: jobDetailSelect,
    });

    await prisma.timelineEvent.create({
      data: {
        organization_id: req.user!.organization_id,
        entity_type: 'JOB',
        entity_id: id,
        event_type: 'JOB_REOPENED',
        description: `Job ${existing.job_number} reopened`,
        created_by: req.user!.id,
      },
    });

    // ─── In-app notification hook ───────────────────────────────────────────
    await emit({
      verb: 'job.reopened',
      organizationId: req.user!.organization_id,
      actorId: req.user?.id ?? null,
      object: { type: 'JOB', id, label: existing.job_number },
      entity: {
        assignee_ids: ((job as any)?.assignees ?? []).map((a: { user: { id: string } }) => a.user.id),
      },
      data: { object_label: existing.job_number },
    });

    res.json({ job: await presentJobDetail(req, job) });
  } catch (err) {
    logger.error('Reopen job error:', err);
    res.status(500).json({ error: 'Failed to reopen job' });
  }
}

// ─── SRVW-87: one set-status door ──────────────────────

/**
 * Outer contract for POST /:id/status. Deliberately a SUPERSET of the verb schemas it feeds, and
 * deliberately NOT a superset of completeJobSchema: signature_data / signature_ip / signature_at
 * are omitted, so validate()'s bare .parse() strips them before setStatus ever runs and a
 * COMPLETED driven through this door can never carry a signature. If a technician sign-off ever
 * needs to travel this way, add the fields here on purpose - do not assume they pass through.
 */
export const setStatusSchema = z.object({
  status: z.nativeEnum(JobStatus),
  assignee_ids: z.array(z.string().uuid()).optional(),
  scheduled_start: z.string().datetime({ offset: true }).optional(),
  scheduled_end: z.string().datetime({ offset: true }).optional(),
  is_all_day: z.boolean().optional(),
  force: z.boolean().optional(),
  completion_notes: z.string().max(5000).optional(),
  cancelled_reason: z.string().max(2000).optional(),
});

type StatusVerb = {
  action: Action;
  handler: (req: Request, res: Response) => Promise<void>;
  // Optional because unassign/en-route/arrive/start carry no validate() on their routes and have
  // no schema to name (job.routes.ts) - a required field would not compile.
  schema?: z.ZodTypeAny;
};

/**
 * Target status -> the verb that owns it. `reopen` is deliberately unmapped: IN_PROGRESS routes
 * into start(), which already nulls completed_at via milestoneClears('started') AND reverts the
 * linked PlanVisit, which reopen() does not - strictly the more correct of the two doors. A
 * caller who needs reopen()'s exact semantics keeps using POST /:id/reopen.
 */
const STATUS_VERBS: Record<JobStatus, StatusVerb> = {
  SCHEDULED: { action: 'assign', handler: assign, schema: assignJobSchema },
  UNASSIGNED: { action: 'unassign', handler: unassign },
  EN_ROUTE: { action: 'en_route', handler: enRoute },
  ON_SITE: { action: 'arrive', handler: arrive },
  IN_PROGRESS: { action: 'start', handler: start },
  COMPLETED: { action: 'complete', handler: complete, schema: completeJobSchema },
  CANCELLED: { action: 'cancel', handler: cancel, schema: cancelJobSchema },
};

/**
 * POST /api/jobs/:id/status - set a job's status through ONE endpoint instead of eight verb
 * routes. It is a pure DISPATCHER: it contains no job.update of its own, so every milestone
 * stamp, timeline event, notification emit and automation dispatch fires exactly as it does
 * through the verb route, including start()'s own per-instance crew check.
 *
 * Authorization is per verb, not per endpoint. The route's outer gate is the coarse `read Job`
 * (every role default and per-user capability that grants a Job verb also implies read, so a
 * stricter outer gate would falsely 403 a holder of a verb without `update Job`); the REAL check
 * is the can(spec.action, 'Job') below, reproducing canGuard exactly. This endpoint can therefore
 * never be a permission-escalation shortcut around the verb routes.
 *
 * Two target statuses have consequences worth stating before anyone uses them:
 *
 *  - SCHEDULED routes into assign(), and the window is NEVER inherited from the job row. A body
 *    with no `scheduled_start` 400s. That is required for SAFETY - inheriting the job's own
 *    window would hand assign() a truthy scheduled_start, firing milestoneClears('scheduled')
 *    (nulling en_route_at/on_site_at/started_at/completed_at/cancelled_at/cancelled_reason) plus
 *    revertPlanVisitOnUncomplete, so `{"status":"SCHEDULED"}` - a body that reads like a label
 *    change - would silently un-complete a finished, paid job. It is also required for HONESTY:
 *    without a scheduled_start, assign() keeps `existing.status`, so a 200 would be a lie.
 *    WITH an explicit window, SCHEDULED is byte-identical to POST /:id/assign with the same body,
 *    milestone rewind included - Spec B1's documented backward-move policy, not new capability
 *    (both doors gate on `assign Job`), and deliberately NOT the PATCH semantics of
 *    deriveStatusOnReschedule. `assignee_ids` defaults to the job's CURRENT crew, because
 *    assignJobSchema requires the array and it is REPLACE semantics - omitting it must not empty
 *    the crew.
 *
 *  - UNASSIGNED routes into unassign(), which nulls scheduled_start/scheduled_end. Callers get
 *    UNSCHEDULE semantics (crew kept), not a bare relabel.
 */
export async function setStatus(req: Request, res: Response) {
  try {
    const {
      status, assignee_ids, scheduled_start, scheduled_end, is_all_day, force,
      completion_notes, cancelled_reason,
    } = req.body as z.infer<typeof setStatusSchema>;

    const spec = STATUS_VERBS[status];

    // The real authorization: the target VERB's own action, not this endpoint's.
    if (!req.ability?.can(spec.action, 'Job')) {
      res.status(403).json({ error: 'Insufficient permissions' });
      return;
    }

    let verbBody: Record<string, unknown> = {};

    if (status === 'SCHEDULED') {
      if (!scheduled_start) {
        res.status(400).json(validationFailure([{
          field: 'scheduled_start',
          message: 'scheduled_start is required to set a job SCHEDULED (the job current window is never reused)',
        }]));
        return;
      }

      let crew = assignee_ids;
      if (crew === undefined) {
        const existing = await prisma.job.findUnique({
          where: { id: param(req, 'id'), ...tenantWhere(req) },
          select: { id: true, assignees: { select: { user_id: true } } },
        });
        if (!existing) {
          res.status(404).json({ error: 'Job not found' });
          return;
        }
        crew = existing.assignees.map((a) => a.user_id);
      }

      verbBody = {
        assignee_ids: crew,
        scheduled_start,
        ...(scheduled_end !== undefined ? { scheduled_end } : {}),
        ...(is_all_day !== undefined ? { is_all_day } : {}),
        ...(force !== undefined ? { force } : {}),
      };
    } else if (status === 'COMPLETED') {
      verbBody = completion_notes !== undefined ? { completion_notes } : {};
    } else if (status === 'CANCELLED') {
      // Left undefined when omitted so cancelJobSchema produces its own "reason is required" 400.
      verbBody = { cancelled_reason };
    }

    if (spec.schema) {
      const parsed = spec.schema.safeParse(verbBody);
      if (!parsed.success) {
        res.status(400).json(zodValidationFailure(parsed.error));
        return;
      }
      verbBody = parsed.data as Record<string, unknown>;
    }

    req.body = verbBody;
    await spec.handler(req, res);
  } catch (err) {
    logger.error('Set job status error:', err);
    res.status(500).json({ error: 'Failed to set job status' });
  }
}

// ─── Technician Mobile Status Actions ─────────────────

export async function enRoute(req: Request, res: Response) {
  try {
    const id = param(req, 'id');

    const existing = await prisma.job.findUnique({
      where: { id, ...tenantWhere(req) },
      select: {
        id: true,
        status: true,
        // Crew (M2M): user_id for the access check + first member's name for the email.
        assignees: { select: { user_id: true, user: { select: { first_name: true } } } },
        job_number: true,
        scheduled_start: true,
        customer: { select: { id: true, email: true, first_name: true, company_name: true } },
        service_location: { select: { address_line1: true, city: true, state: true } },
      },
    });

    if (!existing) {
      res.status(404).json({ error: 'Job not found' });
      return;
    }

    // Admins/dispatchers may advance any job in their org; a technician may only advance a job
    // they are assigned to (the route guard already verified the `en_route Job` capability).
    const isOrgManager = req.ability!.can('manage', 'all' as Subject) || req.user!.role === 'DISPATCHER';
    if (!isOrgManager && !existing.assignees.some((a) => a.user_id === req.user!.id)) {
      res.status(403).json({ error: 'Insufficient permissions' });
      return;
    }

    const enRouteAt = new Date();
    const job = await prisma.job.update({
      where: { id, ...tenantWhere(req) },
      data: {
        status: 'EN_ROUTE',
        ...subStatusClears(existing.status, 'EN_ROUTE'),
        en_route_at: enRouteAt,
      },
      select: jobDetailSelect,
    });

    await prisma.timelineEvent.create({
      data: {
        organization_id: req.user!.organization_id,
        entity_type: 'JOB',
        entity_id: id,
        event_type: 'STATUS_CHANGED',
        description: `Technician is en route for job ${existing.job_number}`,
        created_by: req.user!.id,
      },
    });

    // ─── Automation Center — post-commit, fire-and-forget (#271) ─────────────
    // Crew-gated to match the hard-coded sender this replaced, which required a
    // named technician to send at all. The default automation tells the customer
    // who is on the way, so dispatching with an empty crew would email them a
    // notification naming nobody.
    if (existing.assignees.length > 0) {
      dispatchAutomationEvent({
        type: 'JOB_EN_ROUTE',
        organizationId: req.user!.organization_id,
        entity: { type: 'job', id, label: existing.job_number },
        occurrenceKey: enRouteAt.toISOString(),
        actorId: req.user?.id ?? null,
      });
    }

    res.json({ job: await presentJobDetail(req, job) });
  } catch (err) {
    logger.error('En-route job error:', err);
    res.status(500).json({ error: 'Failed to mark job en route' });
  }
}

export async function arrive(req: Request, res: Response) {
  try {
    const id = param(req, 'id');

    const existing = await prisma.job.findUnique({
      where: { id, ...tenantWhere(req) },
      select: { id: true, status: true, assignees: { select: { user_id: true } }, job_number: true, source_plan_id: true },
    });

    if (!existing) {
      res.status(404).json({ error: 'Job not found' });
      return;
    }

    // Admins/dispatchers may advance any job in their org; a technician may only advance a job
    // they are assigned to (the route guard already verified the `arrive Job` capability).
    const isOrgManager = req.ability!.can('manage', 'all' as Subject) || req.user!.role === 'DISPATCHER';
    if (!isOrgManager && !existing.assignees.some((a) => a.user_id === req.user!.id)) {
      res.status(403).json({ error: 'Insufficient permissions' });
      return;
    }

    // B-9 (Spec B1): the timeline event is written BEFORE the update, not after -- so a crash
    // between the two never leaves a status change with no audit trail. Its metadata records
    // what a backward move actually cleared (the spec's own ask), empty for a forward move.
    const clears = milestoneClears('on_site');
    await prisma.timelineEvent.create({
      data: {
        organization_id: req.user!.organization_id,
        entity_type: 'JOB',
        entity_id: id,
        event_type: 'STATUS_CHANGED',
        description: `Technician arrived on site for job ${existing.job_number}`,
        metadata: Object.keys(clears).length ? { cleared: Object.keys(clears) } : undefined,
        created_by: req.user!.id,
      },
    });

    const job = await prisma.job.update({
      where: { id, ...tenantWhere(req) },
      data: {
        status: 'ON_SITE',
        ...subStatusClears(existing.status, 'ON_SITE'),
        on_site_at: new Date(),
        ...clears,
      },
      select: jobDetailSelect,
    });

    if (clearsCompletion('on_site')) {
      await revertPlanVisitOnUncomplete(req, id, existing.source_plan_id);
    }

    res.json({ job: await presentJobDetail(req, job) });
  } catch (err) {
    logger.error('Arrive job error:', err);
    res.status(500).json({ error: 'Failed to mark job on-site' });
  }
}

// ─── Bulk actions (SRVW-104) ────────────────────────────
//
// Both endpoints are a sequential per-id loop invoking the EXISTING single-job verb handlers
// in-process (never Promise.all - cancel() opens a $transaction and resolves its Logistic Order
// unwind pre-transaction on the global client, for pool discipline). TimelineEvent,
// milestoneClears, revertPlanVisitOnUncomplete, PlanVisit cascades, emit() and
// dispatchAutomationEvent are reproduced BY CONSTRUCTION - zero lines inside those handlers
// change. No prisma.job.updateMany anywhere in this file.

/**
 * Run `handler` once per id, in-process, reusing its entire guard sequence, business rules and
 * side effects. Each id gets its own canAccessRow('Job') check FIRST (tighter than some of the
 * single-job doors - cancel() and setAssignees() have no per-instance check at all - deliberate
 * hardening, not a bug) and its own try/catch (isolation contract from estimate.controller.ts's
 * bulkRemove: one id's failure never aborts the rest of the batch).
 */
async function runJobVerbBatch(
  req: Request,
  ids: string[],
  body: Record<string, unknown>,
  handler: (req: Request, res: Response) => Promise<void>,
  fallbackError: string,
): Promise<{ updated: { id: string; payload: any }[]; failed: { id: string; error: string }[] }> {
  const updated: { id: string; payload: any }[] = [];
  const failed: { id: string; error: string }[] = [];

  for (const id of ids) {
    try {
      if (!(await canAccessRow(req, 'Job', prisma.job, id))) {
        failed.push({ id, error: 'Insufficient permissions' });
        continue;
      }

      const subReq = Object.assign(Object.create(req) as Request, {
        params: { ...req.params, id },
        body,
      });
      // `code` MUST initialise to 200 - every success path in the six handlers calls
      // `res.json()` with NO preceding `res.status()`, so an uninitialised code would
      // classify every success as a failure.
      let code = 200;
      let payload: any;
      const subRes = {
        status(c: number) { code = c; return this; },
        json(b: any) { payload = b; return this; },
      } as unknown as Response;

      await handler(subReq, subRes);

      if (code >= 200 && code < 300) {
        updated.push({ id, payload });
      } else {
        failed.push({ id, error: payload?.error ?? fallbackError });
      }
    } catch (err) {
      logger.error(`Bulk job action error for ${id}:`, err);
      failed.push({ id, error: fallbackError });
    }
  }

  return { updated, failed };
}

const BULK_STATUS_VERBS: Record<string, { action: Action; handler: (req: Request, res: Response) => Promise<void> }> = {
  // IN_PROGRESS maps to start(), not reopen(): milestoneClears('started') nulls completed_at and
  // start() then calls revertPlanVisitOnUncomplete, which reopen() does not (job-milestones.ts).
  arrive: { action: 'arrive', handler: arrive },
  start: { action: 'start', handler: start },
  complete: { action: 'complete', handler: complete },
  cancel: { action: 'cancel', handler: cancel },
};

export async function bulkStatus(req: Request, res: Response) {
  try {
    const { ids, action, cancelled_reason } = req.body as z.infer<typeof bulkStatusJobsSchema>;
    const verb = BULK_STATUS_VERBS[action];

    // The authoritative verb gate lives HERE, not on the route: the route is gated `read Job`
    // (coarse, needed because the ability varies per request body), and canGuard.ts's canDo is a
    // bare `req.ability!.can(action, subject)` - this is byte-equivalent to a route gate on the
    // verb's own action.
    if (!req.ability!.can(verb.action, 'Job' as Subject)) {
      res.status(403).json({ error: 'Insufficient permissions' });
      return;
    }

    const body = action === 'cancel' ? { cancelled_reason } : {};
    const { updated, failed } = await runJobVerbBatch(req, ids, body, verb.handler, `Failed to ${action} job`);

    const responseBody: Record<string, unknown> = {
      updated: updated.map((u) => u.id),
      failed,
    };

    // Reviewer objection 3 fix: cancel() already returns voided_invoice_ids unconditionally and
    // collected_total/refund_suggested behind canSeePricing(req) - the shim already holds that
    // payload, so aggregate it across the batch rather than discarding it on success. The money
    // gate is preserved because every call in the batch shares one `req`.
    if (action === 'cancel') {
      responseBody.voided_invoice_ids = updated.flatMap((u) => u.payload?.voided_invoice_ids ?? []);
      if (canSeePricing(req)) {
        responseBody.collected_total = updated.reduce((sum, u) => sum + Number(u.payload?.collected_total ?? 0), 0);
      }
    }

    res.json(responseBody);
  } catch (err) {
    logger.error('Bulk job status error:', err);
    res.status(500).json({ error: 'Failed to update job status' });
  }
}

export async function bulkAssign(req: Request, res: Response) {
  try {
    const { ids, assignee_ids, notify } = req.body as z.infer<typeof bulkAssignJobsSchema>;
    const { updated, failed } = await runJobVerbBatch(
      req,
      ids,
      { assignee_ids, notify },
      setAssignees,
      'Failed to assign job',
    );
    res.json({ updated: updated.map((u) => u.id), failed });
  } catch (err) {
    logger.error('Bulk job assign error:', err);
    res.status(500).json({ error: 'Failed to assign jobs' });
  }
}

// ─── Notes ─────────────────────────────────────────────

export async function getNotes(req: Request, res: Response) {
  try {
    const id = param(req, 'id');

    const job = await prisma.job.findUnique({
      where: { id, ...tenantWhere(req) },
      select: { id: true },
    });

    if (!job) {
      res.status(404).json({ error: 'Job not found' });
      return;
    }

    // GAP-1 — grant/override-aware per-instance gate (see getById).
    if (!(await canAccessRow(req, 'Job', prisma.job, id))) {
      res.status(403).json({ error: 'Insufficient permissions' });
      return;
    }

    const notes = await prisma.note.findMany({
      where: { entity_type: 'JOB', entity_id: id, ...tenantWhere(req) },
      select: {
        id: true,
        content: true,
        created_at: true,
        creator: { select: { id: true, first_name: true, last_name: true } },
      },
      orderBy: { created_at: 'desc' },
    });

    const includeWalkthrough = req.query.include_walkthrough === 'true';

    if (!includeWalkthrough) {
      res.json({ notes });
      return;
    }

    // Tag existing job notes with source
    const jobNotes = notes.map((n) => ({ ...n, source: 'JOB' as const }));

    // Resolve lead_id through the job's estimate
    const jobRow = await prisma.job.findFirst({
      where: { id, ...tenantWhere(req) },
      select: { estimate: { select: { lead_id: true } } },
    });
    const leadId = jobRow?.estimate?.lead_id ?? null;

    if (!leadId) {
      res.json({ notes: jobNotes });
      return;
    }

    const wtNotes = await prisma.note.findMany({
      where: { entity_type: 'LEAD', entity_id: leadId, ...tenantWhere(req) },
      select: {
        id: true,
        content: true,
        created_at: true,
        creator: { select: { id: true, first_name: true, last_name: true } },
      },
      orderBy: { created_at: 'desc' },
    });

    res.json({ notes: [...jobNotes, ...wtNotes.map((n) => ({ ...n, source: 'WALKTHROUGH' as const }))] });
  } catch (err) {
    logger.error('Get job notes error:', err);
    res.status(500).json({ error: 'Failed to get notes' });
  }
}

export async function addNote(req: Request, res: Response) {
  try {
    const id = param(req, 'id');

    const job = await prisma.job.findUnique({
      where: { id, ...tenantWhere(req) },
      select: { id: true },
    });

    if (!job) {
      res.status(404).json({ error: 'Job not found' });
      return;
    }

    // GAP-1 — grant/override-aware per-instance gate (see getById). NOTE: the route guard for
    // addNote is canDo('update','Job'); the per-instance scope is still derived from the read-Job
    // grant (canAccessRow), matching how update()/the lifecycle verbs bind ownership.
    if (!(await canAccessRow(req, 'Job', prisma.job, id))) {
      res.status(403).json({ error: 'Insufficient permissions' });
      return;
    }

    const note = await prisma.note.create({
      data: {
        entity_type: 'JOB',
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
    logger.error('Add job note error:', err);
    res.status(500).json({ error: 'Failed to add note' });
  }
}

// ─── Timeline ──────────────────────────────────────────

export async function getTimeline(req: Request, res: Response) {
  try {
    const id = param(req, 'id');

    const job = await prisma.job.findUnique({
      where: { id, ...tenantWhere(req) },
      select: { id: true },
    });

    if (!job) {
      res.status(404).json({ error: 'Job not found' });
      return;
    }

    // GAP-1 — grant/override-aware per-instance gate (see getById).
    if (!(await canAccessRow(req, 'Job', prisma.job, id))) {
      res.status(403).json({ error: 'Insufficient permissions' });
      return;
    }

    // Spec B2 N6 — the job's story includes what happened to its invoices. Sending an invoice and
    // recording a payment both write entity_type 'INVOICE' (invoice.controller.ts:666, :1534),
    // so a JOB-only filter left every money event invisible on the job. Widening the read beats
    // writing duplicate JOB-entity events, which would double-count on the invoice's timeline.
    //
    // Gated on canSeePricing: these descriptions embed dollar figures — "Payment of $900.00
    // received via CASH" — and redactTimelineMoneyForRequester only strips METADATA keys, never
    // prose. For a price-blind requester the events are not fetched at all (Spec A D13).
    const invoiceIds = canSeePricing(req)
      ? (await prisma.invoice.findMany({
          where: { job_id: id, ...tenantWhere(req) },
          select: { id: true },
        })).map((i) => i.id)
      : [];

    const events = await prisma.timelineEvent.findMany({
      where: {
        ...tenantWhere(req),
        OR: [
          { entity_type: 'JOB', entity_id: id },
          ...(invoiceIds.length ? [{ entity_type: 'INVOICE', entity_id: { in: invoiceIds } }] : []),
        ],
      },
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

    // GAP-5 — strip monetary metadata (e.g. cancel()'s collected_total) for a non-pricing reader.
    res.json({ events: redactTimelineMoneyForRequester(events, req) });
  } catch (err) {
    logger.error('Get job timeline error:', err);
    res.status(500).json({ error: 'Failed to get timeline' });
  }
}

// ─── Stats ─────────────────────────────────────────────

export async function getStats(req: Request, res: Response) {
  try {
    // GAP-3 — the status counts must be scoped to the requester the SAME way the job LIST is, or a
    // row-scoped role (TECHNICIAN/SALES) reads ORG-WIDE counts here while the list shows only its
    // own. scopeWhereForReq returns {} for ADMIN/unconditional-read (counts stay org-wide), the
    // owner/team/location condition for a conditional read grant, or MATCH_NOTHING (fail-closed).
    const rowScope = await scopeWhereForReq(req, 'Job');
    const orgWhere = { ...tenantWhere(req), ...rowScope };
    const [unassignedCount, scheduledCount, inProgressCount, enRouteCount, onSiteCount, completedCount, cancelledCount] = await Promise.all([
      prisma.job.count({ where: { ...orgWhere, status: 'UNASSIGNED' } }),
      prisma.job.count({ where: { ...orgWhere, status: 'SCHEDULED' } }),
      prisma.job.count({ where: { ...orgWhere, status: 'IN_PROGRESS' } }),
      prisma.job.count({ where: { ...orgWhere, status: 'EN_ROUTE' } }),
      prisma.job.count({ where: { ...orgWhere, status: 'ON_SITE' } }),
      prisma.job.count({ where: { ...orgWhere, status: 'COMPLETED' } }),
      prisma.job.count({ where: { ...orgWhere, status: 'CANCELLED' } }),
    ]);

    res.json({
      unassigned: unassignedCount,
      scheduled: scheduledCount,
      // Spec B1 (Task 5): fold EN_ROUTE/ON_SITE into in_progress, same as list()'s stats block.
      in_progress: inProgressCount + enRouteCount + onSiteCount,
      completed: completedCount,
      cancelled: cancelledCount,
    });
  } catch (err) {
    logger.error('Get job stats error:', err);
    res.status(500).json({ error: 'Failed to get job stats' });
  }
}

// Job-level walkthrough REMOVED (scheduler redesign §5.8): it was the sole writer of
// the legacy job walkthrough FK (dropped in TG7). No replacement — walkthroughs live on the lead.

// ─── Duplicate ─────────────────────────────────────────

export async function duplicate(req: Request, res: Response) {
  try {
    const id = param(req, 'id');
    const source = await prisma.job.findFirst({
      where: { id, ...tenantWhere(req) },
      select: {
        id: true,
        job_number: true,
        customer_id: true,
        service_location_id: true,
        scope_notes: true,
        job_type: true,
        estimated_duration: true,
        // job-owns-tax-discount (E1) - the duplicate is a fresh standalone job (see "NOT copied"
        // below), so its tax_rate is looked up fresh too, not copied from the source.
        service_location: { select: { state: true } },
        // ownership relations are no longer fetched here — canAccessRow gates access via its own
        // scoped query, and the duplicate explicitly does NOT copy assignees (see below).
      },
    });
    if (!source) { res.status(404).json({ error: 'Job not found' }); return; }
    // GAP-1 — per-instance gate via the grant/override-aware canAccessRow (replaces the old
    // role-literal canAccessJob, which hardcoded ADMIN||DISPATCHER → true and ignored grants).
    if (!(await canAccessRow(req, 'Job', prisma.job, id))) { res.status(403).json({ error: 'Insufficient permissions' }); return; }

    const job = await prisma.$transaction(async (tx) => {
      const jobNumber = await allocateNumber(tx, 'job', req.user!.organization_id);
      const taxRate = await resolveTaxRateForState(tx, req.user!.organization_id, source.service_location?.state ?? null);
      const j = await tx.job.create({
        data: {
          job_number: jobNumber,
          organization_id: req.user!.organization_id,
          customer_id: source.customer_id,
          service_location_id: source.service_location_id,
          scope_notes: source.scope_notes,
          job_type: source.job_type,
          estimated_duration: source.estimated_duration,
          status: 'UNASSIGNED',
          tax_rate: taxRate,
          // NOT copied: estimate_id (standalone), discount, schedule, assignees, invoices.
          // Audit: whoever pressed Duplicate owns the new row's provenance, not the source's creator.
          ...createdByUser(req),
        },
        select: jobDetailSelect,
      });
      await tx.timelineEvent.create({
        data: {
          organization_id: req.user!.organization_id,
          entity_type: 'JOB',
          entity_id: j.id,
          event_type: 'CREATED',
          description: `Job ${jobNumber} created (duplicated from ${source.job_number})`,
          created_by: req.user!.id,
        },
      });
      return j;
    });
    res.status(201).json({ job: await withTags(req, job) });
  } catch (err) {
    logger.error('Duplicate job error:', err);
    res.status(500).json({ error: 'Failed to duplicate job' });
  }
}

// ════════════════════════════════════════════════════════════════════════════
// POST /api/jobs/:id/invoices — SERV10X-38 Task 5: explicit "Create Invoice" from a
// job's owned items (JobLineItem). Bills the job's line-item total either as a flat
// DRAW (amount/percent → one summary line) or ITEMIZED (lineIds → copies job lines onto
// the new invoice's InvoiceLineItem rows with a job_line_item_id back-pointer). Multiple
// invoices per job are allowed and over-billing is allowed too: Spec B1 (afdc77e0d) deleted
// BOTH the "one active invoice" guard and the over-bill guard on purpose, because this door
// bills PART of a job and is repeatable by design. The only dedupe here is SRVW-85's
// already-billed-line 409 on the ITEMIZED path (a draw line carries no job_line_item_id, so
// draws can never trip it). The whole-job door, POST /api/invoices { job_id }, keeps its own
// one-active 409 precisely because it bills everything in one document. A PAID estimate deposit
// is drawn down as credit through lib/deposit-credit, shared with that door; the single-credit
// guard is INHERENT (remainingDepositCredit only ever returns unapplied credit).
// Gate: canDo('create','Invoice') at the route + per-instance canAccessRow(Job) here.
// ════════════════════════════════════════════════════════════════════════════
export const createInvoiceFromJobSchema = z.object({
  amount: z.number().positive().optional(),
  percent: z.number().positive().max(100).optional(),
  lineIds: z.array(z.string().uuid()).nonempty().optional(),
  description: z.string().max(5000).optional(),
}).refine(
  (b) => [b.amount, b.percent, b.lineIds].filter((v) => v !== undefined).length === 1,
  { message: 'Provide exactly one of amount, percent, or lineIds' },
);

// Parent-job select: billing inputs (job_line_items/scopes/invoices, for computeJobBilling's
// over-bill guard) + the estimate id (to look up a PAID deposit invoice to draw down).
const jobInvoiceGuardSelect = {
  id: true,
  job_number: true,
  status: true,
  source_plan_id: true,
  customer: { select: { id: true, tax_exempt: true } },
  job_line_items: {
    select: {
      id: true,
      description: true,
      quantity: true,
      unit_price: true,
      is_taxable: true,
      line_total: true,
      item_type: true,
      price_book_item_id: true,
      // SRVW-85: the invoice cost basis. Both doors copy these onto the InvoiceLineItem so the
      // same work billed either way carries the same cost/margin.
      unit_cost: true,
      markup_percent: true,
    },
    // Without an orderBy Postgres returns physical row order, so the `sequence: idx + 1`
    // renumbering below would differ between two identical requests - the same class of bug the
    // linked_estimates orderBy already fixes.
    orderBy: { sequence: 'asc' },
  },
  // Flat-priced, non-line-item scope-of-work blocks (scopes.ts) — folded into the over-bill
  // guard below so a job with priced scope-of-work can't be drawn down past its true total.
  scopes: true,
  invoices: { select: { total_amount: true, voided_at: true } },
  // E1/E2 (job-owns-tax-discount) - the from-job invoice inherits tax/discount straight off the
  // JOB now, not through an attached estimate. discount_type/discount_value (not the frozen
  // discount_amount) because this door can bill an ITEMIZED SUBSET of the job's items - the
  // discount is resolved as a RATE against THAT subtotal, same as tax_rate. See the derivation
  // below.
  tax_rate: true,
  discount_type: true,
  discount_value: true,
  // SERV10X-61 Task 10: a job can have MULTIPLE attached estimates (EstimateJobLink), each with
  // its own PAID deposit, IN ADDITION TO its 1:1 provenance estimate (JobPrimaryEstimate above).
  // Both feed the deposit draw-down; loaded here so the union is resolved from a single query.
  // Tax/discount role retired (E5) - id only.
  estimate: { select: { id: true } },
  linked_estimates: { select: { id: true } },
} as const;

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

export async function createInvoiceFromJob(req: Request, res: Response) {
  try {
    const id = param(req, 'id');
    const body = req.body as z.infer<typeof createInvoiceFromJobSchema>;

    const job = await prisma.job.findUnique({
      where: { id, ...tenantWhere(req) },
      select: jobInvoiceGuardSelect,
    });
    if (!job) { res.status(404).json({ error: 'Job not found' }); return; }
    // Spec B1: cancellation is not terminal, so a cancelled job that gets revived — or one
    // cancelled after work was genuinely done — still bills. Every job status can be invoiced.
    if (job.source_plan_id) {
      res.status(400).json({ error: 'This job is a service plan visit and cannot be invoiced — the plan was already paid upfront.' });
      return;
    }
    // Per-instance owner check (grant-driven SQL scope) — the route's canDo is subject-level only.
    if (!(await canAccessRow(req, 'Job', prisma.job, job.id))) {
      res.status(403).json({ error: 'Insufficient permissions' });
      return;
    }

    // {total, invoiced, remaining} against the job's line-item total (untaxed — tax is a
    // per-invoice add-on that doesn't shrink how much of the underlying work is left to bill).
    const billing = computeJobBilling({
      lines: job.job_line_items.map((l) => ({
        quantity: Number(l.quantity),
        unit_price: Number(l.unit_price),
        is_taxable: l.is_taxable,
      })),
      scopes: toScopeForTotals(asScopeArray(job.scopes)),
      // Task 10b + D2: stays PRE-TAX and PRE-DISCOUNT on purpose. This drives the over-bill basis
      // + the percent-draw basis; tax and discount are both added once to the invoice totals
      // below (step 3), itemized-only. Applying either here too would double-count it against the
      // now-taxed/discounted invoice - the percent draw is a percent of the pre-tax, pre-discount
      // job total, then tax/discount are layered on top only for an itemized bill.
      taxRate: 0,
      taxExempt: job.customer?.tax_exempt ?? false,
      discountType: null,
      discountValue: null,
      invoices: job.invoices.map((i) => ({ total_amount: Number(i.total_amount), voided_at: i.voided_at })),
    });

    // Flat draw (amount/percent of the job total) OR itemized (lineIds → copy those job
    // lines onto the invoice with a job_line_item_id back-pointer). The schema's refine
    // already guarantees exactly one of the three is present.
    const drawAmount = body.amount != null
      ? body.amount
      : body.percent != null
        ? round2(billing.total * (body.percent / 100))
        : null;

    const pickedLines = body.lineIds
      ? job.job_line_items.filter((l) => body.lineIds!.includes(l.id))
      : [];
    if (body.lineIds && pickedLines.length !== body.lineIds.length) {
      res.status(400).json({ error: 'One or more lineIds do not belong to this job' });
      return;
    }

    // SRVW-85 - ALREADY-BILLED LINE GUARD, itemized path only. Both doors now bill the same
    // JobLineItem rows, so without this the same line could sit on two live invoices at once.
    // Deliberately NOT the one-active-invoice guard Spec B1 removed: it keys on job_line_item_id,
    // which a flat/percent DRAW line never carries, so progress draws are untouched and
    // over-billing stays legal. VOIDED invoices are excluded, so void-and-reissue still works.
    // InvoiceLineItem has NO organization_id column, so the tenancy anchor is the nested `invoice`
    // relation - that is where the org lives.
    // Disclosed, not fixed: this read is pre-transaction, so two concurrent itemized requests for
    // the same lineIds can both pass. That matches the shape of this door's other pre-tx checks
    // and respects Spec B1's deliberate removal of the in-tx TOCTOU re-check.
    if (body.lineIds) {
      const alreadyBilled = await prisma.invoiceLineItem.findMany({
        where: {
          job_line_item_id: { in: body.lineIds },
          invoice: { job_id: job.id, status: { not: 'VOIDED' }, ...tenantWhere(req) },
        },
        select: { job_line_item_id: true, invoice: { select: { invoice_number: true } } },
      });
      if (alreadyBilled.length > 0) {
        const numbers = [...new Set(alreadyBilled.map((l) => l.invoice.invoice_number))].join(', ');
        res.status(409).json({
          error: `One or more of these lines are already billed on invoice ${numbers}. Void that invoice or pick different lines.`,
        });
        return;
      }
    }

    const itemizedTotal = round2(pickedLines.reduce((sum, l) => sum + Number(l.line_total), 0));
    const proposedTotal = drawAmount != null ? drawAmount : itemizedTotal;

    // Over-billing is deliberately NOT blocked (Spec B1). A job's billable-line total is an
    // estimate of the work, not a ceiling on what may be invoiced: work grows on site, change
    // orders happen verbally, and an invoice raised outside the system has no arithmetic
    // relationship to the job's lines at all. `billing.remaining` is still returned and is shown
    // in the UI as a default and a reference — it just never blocks a submit.

    const invoice = await prisma.$transaction(async (tx) => {
      const invoiceNumber = await allocateNumber(tx, 'invoice', req.user!.organization_id);

      let lineData: Prisma.InvoiceLineItemCreateWithoutInvoiceInput[];
      if (drawAmount != null) {
        const drawTotal: number = drawAmount;
        lineData = [{
          sequence: 1,
          description: body.description || 'Progress payment',
          quantity: 1,
          unit_price: drawTotal,
          is_taxable: false,
          line_total: drawTotal,
        }];
      } else {
        // SRVW-85: shared with invoice.controller.create()'s itemized path, so the two doors write
        // identical InvoiceLineItem rows for the same JobLineItem.
        lineData = pickedLines.map(jobLineToInvoiceLineCreate);
      }

      // E1 (job-owns-tax-discount): the from-job invoice inherits the JOB's own tax rate -
      // still editable on the invoice afterward. Applies to both the draw and itemized paths:
      // a tax RATE is subset-agnostic, so the same rate is correct whether this bills the whole
      // job or a lineIds subset of it.
      const taxRate = Number(job.tax_rate);

      // E2: the discount carries the SAME way as tax, itemized-only. A flat/percent DRAW is a
      // user-specified amount, orthogonal to the underlying items' pricing - it must not be
      // discounted a second time on top of whatever the user already typed. Resolved as a RATE
      // (discount_type/discount_value) against THIS itemized subtotal, not the job's frozen
      // discount_amount - this door can bill a SUBSET of the job's items, and the frozen
      // whole-job amount could exceed a small subset's subtotal.
      const discountType = drawAmount == null ? job.discount_type : null;
      const discountValue = drawAmount == null && job.discount_value != null
        ? Number(job.discount_value)
        : null;

      // Taxed + discounted totals via the shared calculator (mirrors invoice.controller.create()).
      // Itemized picked lines keep their copied is_taxable, so they carry the estimate's tax per
      // line; the flat/percent DRAW line is is_taxable:false, so a flat progress draw shows the
      // rate but taxes $0 (intended, editable). subtotal (pre-tax, pre-discount) == the old
      // untaxed/undiscounted total.
      const totals = recomputeInvoiceTotals({
        // lineData always sets is_taxable (false for the DRAW line, the copied flag for itemized);
        // `?? false` only narrows the Prisma create-input's optional type - never hit at runtime.
        lines: lineData.map((l) => ({ quantity: Number(l.quantity), unit_price: Number(l.unit_price), is_taxable: l.is_taxable ?? false })),
        taxRate,
        taxExempt: job.customer?.tax_exempt ?? false,
        discountType,
        discountValue,
      });
      const subtotal = totals.subtotal;
      const discountAmount = totals.discount_amount;
      const taxAmount = totals.tax_amount;
      const invoiceTotal = totals.total_amount; // subtotal - discount + tax (tax-inclusive) - what the customer owes

      // Deposit draw-down - SERV10X-61 Task 10: a job's deposit credit is now sourced from ALL
      // its attached estimates (linked_estimates / EstimateJobLink) UNION its 1:1 provenance
      // estimate (job.estimate / JobPrimaryEstimate), deduped by estimate id. A legacy/single-
      // estimate job has the same estimate in both (or only provenance set) → dedupes to one →
      // this stays BYTE-IDENTICAL to the pre-Task-10 single-deposit path. Resolve the PAID
      // deposit invoices ONCE, in a deterministic (created_at) order so the drawdown is stable.
      // SRVW-85: the union + resolution + both drawdown passes now live in lib/deposit-credit so
      // this door and the whole-job door share ONE clamp and cannot drift apart again.
      // Behaviour-identical - the helpers were lifted from the code that used to sit here.
      const paidDeposits = await resolvePaidDepositInvoices(tx, depositEstimateIds(job), req.user!.organization_id);

      // PASS 1 (read-only) - the invoice's deposit_credit, under a DECREASING `room` that starts
      // at the TAX-INCLUSIVE `invoiceTotal` (Task 10b) so two deposits cannot over-credit it.
      const depositCredit = await computeDepositCredit(tx, paidDeposits, invoiceTotal);
      const amountDue = round2(invoiceTotal - depositCredit);

      const created = await tx.invoice.create({
        data: {
          invoice_number: invoiceNumber,
          organization_id: req.user!.organization_id,
          job_id: job.id,
          customer_id: job.customer!.id,
          kind: 'STANDARD',
          status: 'DRAFT',
          subtotal,
          discount_amount: discountAmount,
          tax_rate: taxRate,
          tax_amount: taxAmount,
          deposit_credit: depositCredit,
          total_amount: invoiceTotal,
          amount_due: amountDue,
          // R3b (2026-07-21) — deliberately NOT copying the job's labor_hours/overhead here: this
          // is a partial/progress DRAW invoice (possibly one of several against the same job), and
          // copying the job's whole-job cost basis onto every draw would overstate cost on each
          // one. Left null — falls back to the org default, same as any other from-scratch
          // document — rather than misrepresenting a partial bill as carrying the full job cost.
          line_items: { create: lineData },
          // Audit: the user raising this draw invoice off the job, never the job's own creator.
          ...createdByUser(req),
        },
      });

      // PASS 2 (post-create) - ONE DepositCreditApplication ledger row + ONE post-tax
      // DEPOSIT-CREDIT Payment per deposit that draws > 0, under the same decreasing-room clamp
      // Pass 1 used, so the invoice's deposit_credit and Σ(ledger rows) stay consistent.
      await applyDepositCreditsWithPayments(tx, paidDeposits, created.id, invoiceTotal, req.user!.organization_id);

      // Task 10b: track the TAX-INCLUSIVE total, mirroring invoice.controller (increments by
      // total_amount, void/delete decrement by total_amount) so the cached billed total nets out.
      await tx.job.update({ where: { id: job.id }, data: { amount_invoiced: { increment: invoiceTotal } } });

      // Spec B2 — the lifecycle bar creates invoices, so the job's story must record it. Mirrors
      // invoice.controller.create()'s INVOICE_CREATED write (:666-675). entity_type is INVOICE
      // (not JOB) so it lands on the invoice's own timeline too; Task 3 is what makes it
      // reachable from the job.
      await tx.timelineEvent.create({
        data: {
          organization_id: req.user!.organization_id,
          entity_type: 'INVOICE',
          entity_id: created.id,
          event_type: 'INVOICE_CREATED',
          description: `Invoice ${created.invoice_number} created from job ${job.job_number}`,
          created_by: req.user?.id,
        },
      });

      return created;
    });

    // Audit the Invoice that was actually created, not the parent Job — consistent with
    // invoice.controller.ts's create() (resourceType: 'Invoice', resourceId: invoice.id).
    void logAudit({
      req, action: 'job.invoice_created', resourceType: 'Invoice', resourceId: invoice.id,
      metadata: { job_id: job.id },
    });
    res.status(201).json({ invoice });
  } catch (err) {
    logger.error('Error creating invoice from job:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
}
