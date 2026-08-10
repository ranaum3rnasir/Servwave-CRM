import { Request, Response } from 'express';
import { z } from 'zod';
import { LeadStatus, JobStatus, Prisma } from '@prisma/client';
import { prisma } from '../lib/prisma';
// Creator tracking (audit only) - stamped at every create, never read for authorization here.
import { createdByUser } from '../lib/created-by';
import { logger } from '../lib/logger';
import { parsePagination, buildPaginationMeta, parseSortParams, respondInvalidSort } from '../lib/pagination';
import { CUSTOMER_SORT_FIELDS } from '../lib/sortFields';
import { parseArrayParam } from '../lib/query/parseArrayParam';
import { applyFilters } from '../lib/query/filterEngine';
import { customerFacets } from '../lib/query/registries/customer.filters';
import { tenantWhere } from '../lib/tenant';
import { withRequiredCustomerFields } from '../lib/customer-create';
import { hasPaymentInSubtree, paymentSummaryForSubtree, purgeCustomerSubtree } from '../lib/purge';
import { findDuplicateCustomer } from '../lib/customer-duplicate';
import { phoneSearchClauses, phoneRelationSearchClauses } from '../lib/phone-search';
import { logAudit } from '../lib/audit';
import { optionalCustomerEmail, hasPhoneOrEmail, CONTACT_REQUIRED_MSG } from '../lib/email-schema';
import { requiredCustomerPhone, optionalCustomerPhone } from '../lib/phone-schema';
import { hasNameOrCompany, deriveCustomerKind } from '../lib/customer-kind';
import { ESTIMATE_STATUS } from '../constants/estimateStatus';
import { loadTagsByEntity, loadTagsForEntity } from '../lib/tags';
import { mergeCustomFields, validateCustomFieldValues, CustomFieldValidationError } from '../lib/custom-fields';

// ─── Shared status sets ────────────────────────────────

const OPEN_LEAD_STATUSES: LeadStatus[] = ['NEW', 'CONTACTED', 'ESTIMATED'];
// Open pipeline minus untouched NEW — leads being actively worked (see lead-semantics note).
// Derived from OPEN so active ⊆ open holds by construction; PRODUCT DECISION PENDING —
// if product rules active ≡ open, delete the .filter and alias ACTIVE_LEAD_STATUSES = OPEN_LEAD_STATUSES.
const ACTIVE_LEAD_STATUSES: LeadStatus[] = OPEN_LEAD_STATUSES.filter((s) => s !== 'NEW');
// Spec B1 (Task 5): EN_ROUTE/ON_SITE are genuinely active/reachable now -- previously dropped,
// so a customer whose tech was en route or on site read as having no active job.
const ACTIVE_JOB_STATUSES: JobStatus[] = ['UNASSIGNED', 'SCHEDULED', 'EN_ROUTE', 'ON_SITE', 'IN_PROGRESS'];

// ─── Select Objects ────────────────────────────────────

const customerSelect = {
  id: true,
  customer_number: true,
  first_name: true,
  last_name: true,
  company_name: true,
  email: true,
  phone: true,
  phone_ext: true,
  secondary_phone: true,
  secondary_phone_ext: true,
  ad_source: true,
  allow_billing: true,
  tax_exempt: true,
  payment_type: true,
  // SRVW-114 slice 3 - { "<CustomFieldDefinition-uuid>": <scalar> }. ExtraInfoPanel reads this
  // bag off the detail payload; without it the panel renders every field blank.
  custom_fields: true,
  created_at: true,
  updated_at: true,
  // entity-redesign §2/§10 (additive)
  kind: true,
  segment: true,
  is_parent: true,
  parent_id: true,
  bill_to_customer_id: true,
  billing_address_line1: true,
  billing_address_line2: true,
  billing_city: true,
  billing_state: true,
  billing_zip: true,
  billing_terms: true,
  source: true,
  notes: true,
  is_active: true,
  archived_at: true,
  extra_emails: {
    select: { id: true, email: true, label: true, receives_emails: true },
    orderBy: { created_at: 'asc' as const },
  },
  phones: { select: { id: true, phone: true, label: true, extension: true, is_primary: true }, orderBy: { created_at: 'asc' as const } },
};

const locationSelect = {
  id: true,
  address_line1: true,
  address_line2: true,
  city: true,
  state: true,
  zip: true,
  is_primary: true,
  is_active: true,
  archived_at: true,
  created_at: true,
};

// ─── Zod Schemas ───────────────────────────────────────

const locationSchema = z.object({
  address_line1: z.string().min(1).max(200),
  address_line2: z.string().max(200).optional(),
  city: z.string().min(1).max(100),
  state: z.string().min(2).max(2),
  zip: z.string().min(5).max(10),
  is_primary: z.boolean().optional(),
});

const extraEmailSchema = z.object({
  email: z.string().email(),
  label: z.string().max(50).optional(),
  // Opt this address in to the org's AUTOMATED customer mail (Automation Center).
  // Optional on the wire, but absence means FALSE at the write below, never the
  // column default — see normalizeExtraEmails.
  receives_emails: z.boolean().optional(),
});

type ExtraEmailInput = z.infer<typeof extraEmailSchema>;

/**
 * Both write paths recreate extra_emails from scratch (create, and the PATCH's
 * deleteMany+create), so an omitted `receives_emails` would otherwise fall through to
 * the column default of TRUE and silently opt an address in every time an older client
 * re-saved a customer. Defaulting to false here keeps the opt-in deliberate: the flag
 * is on only because a caller said so. The form always sends it explicitly, with true
 * for freshly added rows.
 */
function normalizeExtraEmails(rows: ExtraEmailInput[]) {
  return rows.map(({ email, label, receives_emails }) => ({
    email,
    label,
    receives_emails: receives_emails ?? false,
  }));
}

// entity-redesign §2 — phones[] ({phone, label?, extension?, is_primary?}). Spec wants
// 1+ phones, but that tightening is DEFERRED to the FE phase + Phase D, so the array
// itself stays .optional() to keep legacy single-phone create working.
const phoneSchema = z.object({
  phone: requiredCustomerPhone,
  label: z.string().max(50).optional().nullable(),
  extension: z.string().max(10).optional().nullable(),
  is_primary: z.boolean().optional(),
});

// Shared additive entity-redesign §2/§10 fields (all optional, backward-compatible).
// NOTE: `kind` intentionally is NOT here — it is derived server-side only
// (unified-client-creation §5.1), never accepted from the client.
const redesignFields = {
  segment: z.enum(['RESIDENTIAL', 'COMMERCIAL']).optional(),
  is_parent: z.boolean().optional(),
  parent_id: z.string().uuid().nullable().optional(),
  bill_to_customer_id: z.string().uuid().nullable().optional(),
  billing_address_line1: z.string().max(200).nullable().optional(),
  billing_address_line2: z.string().max(200).nullable().optional(),
  billing_city: z.string().max(100).nullable().optional(),
  billing_state: z.string().min(2).max(2).nullable().optional(),
  billing_zip: z.string().max(10).nullable().optional(),
  billing_terms: z.string().max(50).nullable().optional(),
  source: z.string().max(100).nullable().optional(),
  notes: z.string().max(5000).nullable().optional(),
  phones: z.array(phoneSchema).optional(),
  // convenience: copy the primary service-location address into billing_* before persist
  billing_same_as_service_location: z.boolean().optional(),
};

// Customer must have a first name OR a company name (unified-client-creation §2).
// Last name + email are optional everywhere — see hasNameOrCompany / hasPhoneOrEmail.
export const createCustomerSchema = z
  .object({
    first_name: z.string().max(100).optional().nullable(),
    last_name: z.string().max(100).optional().nullable(),
    company_name: z.string().max(200).optional().nullable(),
    email: optionalCustomerEmail,
    phone: optionalCustomerPhone,
    phone_ext: z.string().max(10).optional().nullable(),
    secondary_phone: optionalCustomerPhone,
    secondary_phone_ext: z.string().max(10).optional().nullable(),
    ad_source: z.string().max(100).optional().nullable(),
    allow_billing: z.boolean().optional(),
    tax_exempt: z.boolean().optional(),
    payment_type: z.string().max(100).optional().nullable(),
    extra_emails: z.array(extraEmailSchema).optional(),
    locations: z.array(locationSchema).optional(),
    ...redesignFields,
  })
  .refine(hasNameOrCompany, {
    message: 'Customer must have either a first name or a company name',
    path: ['first_name'],
  })
  .refine(hasPhoneOrEmail, {
    message: CONTACT_REQUIRED_MSG,
    path: ['phone'],
  });

// PATCH is intentionally permissive about person-or-company — the rule is enforced at create.
// A partial update touching only first_name shouldn't have to also restate last_name/company_name.
export const updateCustomerSchema = z.object({
  first_name: z.string().max(100).optional().nullable(),
  last_name: z.string().max(100).optional().nullable(),
  company_name: z.string().max(200).optional().nullable(),
  email: optionalCustomerEmail,
  phone: optionalCustomerPhone,
  phone_ext: z.string().max(10).optional().nullable(),
  secondary_phone: optionalCustomerPhone,
  secondary_phone_ext: z.string().max(10).optional().nullable(),
  ad_source: z.string().max(100).optional().nullable(),
  allow_billing: z.boolean().optional(),
  tax_exempt: z.boolean().optional(),
  payment_type: z.string().max(100).optional().nullable(),
  extra_emails: z.array(extraEmailSchema).optional(),
  created_at: z.coerce.date().refine((d) => d <= new Date(), 'created_at cannot be in the future').optional(),
  ...redesignFields,
  // SRVW-114 slice 3 - ExtraInfoPanel's save patch, keyed by CustomFieldDefinition uuid, same
  // shape the job and lead PATCHes accept. Values are `unknown` here on purpose: legality
  // depends on the org's own definitions, so validateCustomFieldValues enforces it downstream.
  // An explicit null clears a key (see mergeCustomFields).
  custom_fields: z.record(z.string().uuid(), z.unknown()).optional(),
});

export const createLocationSchema = locationSchema;

export const updateLocationSchema = z.object({
  address_line1: z.string().min(1).max(200).optional(),
  address_line2: z.string().max(200).optional().nullable(),
  city: z.string().min(1).max(100).optional(),
  state: z.string().min(2).max(2).optional(),
  zip: z.string().min(5).max(10).optional(),
  is_primary: z.boolean().optional(),
});

// ─── Helpers ───────────────────────────────────────────

function param(req: Request, name: string): string {
  return req.params[name] as string;
}

interface LocationInput {
  address_line1?: string;
  city?: string;
  state?: string;
  zip?: string;
  is_primary?: boolean;
}

// "Same as service location" convenience — copy the primary (or first) location address
// into billing_* before persist. Mutates the data object in place.
function applyBillingCopy(data: Record<string, unknown>, locations?: LocationInput[]): void {
  if (!data.billing_same_as_service_location || !locations?.length) return;
  const primary = locations.find((l) => l.is_primary) ?? locations[0];
  data.billing_address_line1 = primary.address_line1 ?? null;
  data.billing_city = primary.city ?? null;
  data.billing_state = primary.state ?? null;
  data.billing_zip = primary.zip ?? null;
}

// §2 — phone primary invariant (CUST-06). The API is authoritative regardless of payload:
// if any row flags is_primary, keep only the FIRST such row primary and force the rest false;
// if none is flagged, default the first phone to primary. Returns persist-ready create rows.
function normalizePhones(phones: z.infer<typeof phoneSchema>[]): Array<{
  phone: string;
  label: string | null;
  extension: string | null;
  is_primary: boolean;
}> {
  const primaryIndex = phones.findIndex((p) => p.is_primary === true);
  const winner = primaryIndex >= 0 ? primaryIndex : 0;
  return phones.map((p, i) => ({
    phone: p.phone,
    label: p.label ?? null,
    extension: p.extension ?? null,
    is_primary: i === winner,
  }));
}

class GuardError extends Error {}

// §10 — parent_id must be a top-level billing group (its own parent_id IS NULL), in the
// same tenant, and not self. bill_to target must be self OR the resolved parent. Returns
// nothing; throws GuardError (→ 400) on violation. selfId is undefined on create.
//
// `effectiveParentId` is the parent the bill_to invariant is evaluated against. On create it
// equals data.parent_id. On PATCH the caller passes the EFFECTIVE parent (the edited value if
// parent_id is part of the edit, otherwise the persisted parent_id from the row) so a member
// that PATCHes only { bill_to_customer_id: P } is correctly accepted instead of falsely 400'd.
async function validateParentAndBillTo(
  req: Request,
  data: { parent_id?: string | null; bill_to_customer_id?: string | null; is_parent?: boolean },
  selfId?: string,
  effectiveParentId?: string | null,
  effectiveIsParent?: boolean,
): Promise<void> {
  const parentId = data.parent_id ?? null;

  // Franchise conflict — a customer that sits UNDER a franchise (has an effective parent)
  // cannot itself be a franchise. Evaluated against the effective parent_id + is_parent so
  // it holds on create AND on PATCH (where either value may come from the persisted row).
  const conflictParentId = effectiveParentId !== undefined ? effectiveParentId : parentId;
  const conflictIsParent = effectiveIsParent !== undefined ? effectiveIsParent : data.is_parent === true;
  if (conflictParentId !== null && conflictIsParent === true) {
    throw new GuardError('A customer under a franchise cannot itself be a franchise');
  }

  if (parentId) {
    if (selfId && parentId === selfId) {
      throw new GuardError('A customer cannot be its own parent');
    }
    const parent = await prisma.customer.findFirst({
      where: { id: parentId, ...tenantWhere(req) },
      select: { id: true, parent_id: true, is_parent: true },
    });
    if (!parent) throw new GuardError('Parent customer not found in this organization');
    if (parent.parent_id !== null) {
      throw new GuardError('Parent must be a top-level customer (billing group)');
    }
    if (parent.is_parent !== true) {
      throw new GuardError('Parent must be a franchise (billing group)');
    }
  }

  // bill_to ∈ {self, the effective parent billing group}. effectiveParentId defaults to the
  // edited/created parentId when not supplied (create + the parent-only edit path).
  const billToParent = effectiveParentId !== undefined ? effectiveParentId : parentId;
  if (data.bill_to_customer_id !== undefined && data.bill_to_customer_id !== null) {
    const billTo = data.bill_to_customer_id;
    const isSelf = selfId !== undefined && billTo === selfId;
    const isParent = billToParent !== null && billTo === billToParent;
    if (!isSelf && !isParent) {
      throw new GuardError('bill_to must be the customer itself or its parent billing group');
    }
  }
}

// ─── Handlers ──────────────────────────────────────────

/**
 * Build the `where` clause for the customer list/export, parsing tenant scope and every
 * filter from `req.query`. Extracted from `list()` so the unpaginated `exportAll` applies
 * the IDENTICAL filter set — list and export can never drift.
 */
export async function buildCustomerListWhere(req: Request): Promise<Record<string, unknown>> {
  const search = (req.query.search as string) || '';
  const cityFilter = (req.query.city as string) || '';
  const stateFilters = parseArrayParam(req.query.state);
  const hasLeads = (req.query.has_leads as string) || '';
  const hasJobs = (req.query.has_jobs as string) || '';
  const isParent = (req.query.is_parent as string) || '';

  const searchWhere = search
    ? {
        OR: [
          { customer_number: { contains: search, mode: 'insensitive' as const } },
          { first_name: { contains: search, mode: 'insensitive' as const } },
          { last_name: { contains: search, mode: 'insensitive' as const } },
          { company_name: { contains: search, mode: 'insensitive' as const } },
          // #350 — phone search is digit-normalized both ways so a digits-only query
          // (`5551234567`) finds a formatted store (`(555) 123-4567`) and vice-versa.
          // #460 — search BOTH the legacy scalar Customer.phone AND the phones[] relation
          // (CustomerPhone), where the current create/edit path now stores numbers.
          ...phoneSearchClauses(search),
          ...phoneRelationSearchClauses(search),
          { email: { contains: search, mode: 'insensitive' as const } },
          { extra_emails: { some: { email: { contains: search, mode: 'insensitive' as const } } } },
        ],
      }
    : {};

  // Build location filter. `state` STAYS hand-rolled (not a customer.filters.ts facet) because
  // it's coupled with `city` — a free-text `{ contains }` filter that isn't a facet at all — in
  // the SAME `service_locations.some` sub-object. Splitting `state` out into a facet would need
  // a merge dance with this non-facet `city` block for no benefit; the frontend still gets the
  // same `?state=CA,TX` wire contract either way (Task 17 facets `state`, backend just doesn't
  // route it through the shared engine).
  const locationWhere: Record<string, unknown> = {};
  if (cityFilter) locationWhere.city = { contains: cityFilter, mode: 'insensitive' };
  if (stateFilters.length > 0) locationWhere.state = stateFilters.length === 1 ? stateFilters[0] : { in: stateFilters };

  // §11 — list defaults to active customers; archived are included only when explicitly
  // requested (include_archived=true) or when searching (so a search can find them).
  const includeArchived = req.query.include_archived === 'true' || !!search;

  const where: Record<string, unknown> = {
    ...tenantWhere(req),
    ...(includeArchived ? {} : { is_active: true }),
    ...searchWhere,
    ...(Object.keys(locationWhere).length > 0 ? { service_locations: { some: locationWhere } } : {}),
    ...(hasLeads === 'true' ? { leads: { some: {} } } : {}),
    ...(hasLeads === 'false' ? { leads: { none: {} } } : {}),
    ...(hasJobs === 'true' ? { jobs: { some: {} } } : {}),
    ...(hasJobs === 'false' ? { jobs: { none: {} } } : {}),
    ...((req.query.open_leads as string) === 'true' ? { leads: { some: { status: { in: OPEN_LEAD_STATUSES } } } } : {}),
    ...((req.query.active_jobs as string) === 'true' ? { jobs: { some: { status: { in: ACTIVE_JOB_STATUSES } } } } : {}),
    // customer-form-redesign — "is_parent" filters to franchises (billing groups), the only
    // customers eligible to be a parent. Used by the customer-form parent picker.
    ...(isParent === 'true' ? { is_parent: true } : {}),
  };

  // Generalized filter engine (Task 16): ad_source, payment_type, tax_exempt (2-option
  // boolean), and the first DOUBLE-countRange case in the app — leads_min/leads_max +
  // jobs_min/jobs_max on the SAME parent model (Customer), each grouping a different child
  // model by its own customer_id FK. See customer.filters.ts for the double-countRange trace.
  // The existence/tri-state toggles above (has_leads/has_jobs/open_leads/active_jobs) touch
  // where.leads/where.jobs, never where.id/where.AND, so they compose cleanly alongside
  // whatever id-filter(s) applyFilters adds.
  await applyFilters(where, req, customerFacets);

  return where;
}

export async function list(req: Request, res: Response) {
  try {
    const { page, limit, skip } = parsePagination(req.query as { page?: string; limit?: string });
    const sort = parseSortParams(req.query as any, CUSTOMER_SORT_FIELDS);
    if (!sort.ok) {
      respondInvalidSort(res, sort);
      return;
    }
    const orderBy = sort.orderBy;
    const search = (req.query.search as string) || '';

    const where = await buildCustomerListWhere(req);

    // Always include primary location for address column; expand when searching
    const locationSelect = search
      ? {
          service_locations: {
            select: { id: true, address_line1: true, address_line2: true, city: true, state: true, zip: true, is_primary: true },
            orderBy: { is_primary: 'desc' as const },
          },
        }
      : {
          service_locations: {
            where: { is_primary: true },
            select: { address_line1: true, city: true, state: true, zip: true },
            take: 1,
          },
        };

    const [customers, total] = await Promise.all([
      prisma.customer.findMany({
        where,
        select: {
          ...customerSelect,
          ...locationSelect,
          _count: { select: { leads: true, jobs: true } },
        },
        orderBy,
        skip,
        take: limit,
      }),
      prisma.customer.count({ where }),
    ]);

    // SRVW-103 - one batched, tenant-scoped tag read for the whole page (never one per row).
    const tagsByCustomer = await loadTagsByEntity(req, 'CUSTOMER', customers.map((c) => c.id));

    res.json({
      customers: customers.map((c) => ({ ...c, tags: tagsByCustomer.get(c.id) ?? [] })),
      pagination: buildPaginationMeta(total, { page, limit, skip }),
    });
  } catch (err) {
    logger.error('List customers error:', err);
    res.status(500).json({ error: 'Failed to list customers' });
  }
}

export async function create(req: Request, res: Response) {
  try {
    const { locations, extra_emails, phones, billing_same_as_service_location, ...rest } = req.body;
    const orgId = req.user!.organization_id;

    // §10 guards — parent must be a top-level billing group; bill_to ∈ {self, parent}.
    // (On create there is no self id yet, so bill_to may only equal the parent.)
    try {
      await validateParentAndBillTo(req, rest);
    } catch (err) {
      if (err instanceof GuardError) {
        res.status(400).json({ error: err.message });
        return;
      }
      throw err;
    }

    // Duplicate-customer guard (Fixes #42) — block a create whose primary email
    // OR phone already exists in this org. `?override=true` bypasses the block
    // but the match is still recorded on the timeline event below.
    const override = req.query.override === 'true';
    const duplicateMatch = await findDuplicateCustomer(prisma, orgId, {
      email: rest.email,
      phone: rest.phone,
    });
    if (duplicateMatch && !override) {
      res.status(409).json({ error: 'duplicate', existing: duplicateMatch });
      return;
    }

    // "same as service location" billing-address copy convenience.
    if (billing_same_as_service_location) {
      applyBillingCopy(Object.assign(rest, { billing_same_as_service_location: true }), locations);
      delete rest.billing_same_as_service_location;
    }

    const locationData = locations?.map((loc: z.infer<typeof locationSchema>, i: number) => ({
      ...loc,
      is_primary: locations.length === 1 ? true : (loc.is_primary ?? (i === 0)),
    }));

    const phoneData = phones && normalizePhones(phones);

    const customer = await prisma.$transaction(async (tx) => {
      return tx.customer.create({
        data: {
          // NOT-NULL safety — customer_number/kind/segment have no DB default.
          // The shared helper guarantees them (and organization_id); is_parent
          // flows via ...rest (defaults to false in the schema when omitted).
          ...(await withRequiredCustomerFields(tx, orgId, rest)),
          ...(locationData && {
            service_locations: { create: locationData },
          }),
          ...(extra_emails?.length && {
            extra_emails: { create: normalizeExtraEmails(extra_emails) },
          }),
          ...(phoneData?.length && {
            phones: { create: phoneData },
          }),
          // Audit: the acting user. LAST in the object on purpose - withRequiredCustomerFields
          // spreads the parsed body (`...rest`), and this has to win over anything arriving that
          // way. Nothing can today (the zod create schema declares no created_by_* key, so
          // validate() strips them), and the ordering keeps that true if the schema ever grows.
          ...createdByUser(req),
        },
        select: {
          ...customerSelect,
          service_locations: { select: locationSelect },
        },
      });
    });

    await prisma.timelineEvent.create({
      data: {
        organization_id: orgId,
        entity_type: 'CUSTOMER',
        entity_id: customer.id,
        event_type: 'CUSTOMER_CREATED',
        // On an override-create, record the bypassed duplicate — the only
        // forward audit trail for #42 (no merge tool yet).
        description: duplicateMatch
          ? `Customer created (duplicate of ${duplicateMatch.customer_number} bypassed)`
          : 'Customer created',
        ...(duplicateMatch && {
          metadata: {
            duplicate_override: true,
            matched_customer_id: duplicateMatch.id,
            matched_customer_number: duplicateMatch.customer_number,
          },
        }),
        created_by: req.user!.id,
      },
    });

    void logAudit({ req, action: 'customer.created', resourceType: 'Customer', resourceId: customer.id });
    res.status(201).json({ customer });
  } catch (err) {
    logger.error('Create customer error:', err);
    res.status(500).json({ error: 'Failed to create customer' });
  }
}

// ─── Shared Financial Helper ──────────────────────────────
// Single source of truth for customer-anchored financial aggregation.
// Both getById and getSummary use this so they can never disagree.
async function loadCustomerFinancials(id: string, orgId: string) {
  const result = await prisma.$queryRaw<Array<{
    lifetime_revenue: string | null;
    total_invoiced: string | null;
    past_due_balance: string | null;
    due_balance: string | null;
    unpaid_invoice_count: string;
    paid_invoice_count: string;
  }>>`
    SELECT
      COALESCE((SELECT SUM(p.amount) FROM payments p
                JOIN invoices i2 ON p.invoice_id = i2.id
                WHERE i2.customer_id = ${id}::uuid AND i2.organization_id = ${orgId}::uuid
                  AND (p.reference_number IS DISTINCT FROM 'DEPOSIT-CREDIT')), 0) AS lifetime_revenue,
      COALESCE((SELECT SUM(i2.total_amount) FROM invoices i2
                WHERE i2.customer_id = ${id}::uuid AND i2.organization_id = ${orgId}::uuid
                  AND i2.kind <> 'DEPOSIT'), 0) AS total_invoiced,
      COALESCE((SELECT SUM(i2.amount_due) FROM invoices i2
                WHERE i2.customer_id = ${id}::uuid AND i2.organization_id = ${orgId}::uuid
                  AND i2.kind <> 'DEPOSIT'
                  AND i2.status IN ('SENT','PARTIAL') AND i2.due_date < NOW()), 0) AS past_due_balance,
      COALESCE((SELECT SUM(i2.amount_due) FROM invoices i2
                WHERE i2.customer_id = ${id}::uuid AND i2.organization_id = ${orgId}::uuid
                  AND i2.kind <> 'DEPOSIT'
                  AND i2.status IN ('SENT','PARTIAL') AND (i2.due_date IS NULL OR i2.due_date >= NOW())), 0) AS due_balance,
      (SELECT COUNT(*) FROM invoices i2 WHERE i2.customer_id = ${id}::uuid AND i2.organization_id = ${orgId}::uuid
                AND i2.kind <> 'DEPOSIT'
                AND i2.status IN ('SENT','PARTIAL')) AS unpaid_invoice_count,
      (SELECT COUNT(*) FROM invoices i2 WHERE i2.customer_id = ${id}::uuid AND i2.organization_id = ${orgId}::uuid
                AND i2.kind <> 'DEPOSIT'
                AND i2.status = 'PAID') AS paid_invoice_count
  `;
  const fin = result?.[0];
  return {
    lifetime_revenue: parseFloat(String(fin?.lifetime_revenue ?? '0')),
    total_invoiced: parseFloat(String(fin?.total_invoiced ?? '0')),
    past_due_balance: parseFloat(String(fin?.past_due_balance ?? '0')),
    due_balance: parseFloat(String(fin?.due_balance ?? '0')),
    paid_invoice_count: parseInt(String(fin?.paid_invoice_count ?? '0'), 10),
    unpaid_invoice_count: parseInt(String(fin?.unpaid_invoice_count ?? '0'), 10),
  };
}

export async function getById(req: Request, res: Response) {
  try {
    const id = param(req, 'id');
    const orgId = req.user!.organization_id;

    const [customer, notes, orphanInvoices, financials, estimateResult, depositResult, allInvoices, openLeadsCount, activeLeadsCount, openTasksCount] = await Promise.all([
      prisma.customer.findUnique({
        where: { id, ...tenantWhere(req) },
        select: {
          ...customerSelect,
          service_locations: { select: locationSelect, orderBy: { is_primary: 'desc' } },
          _count: { select: { leads: true, jobs: true } },
          jobs: {
            select: {
              id: true,
              job_number: true,
              status: true,
              scope_notes: true,
              scheduled_start: true,
              completed_at: true,
              created_at: true,
              assignees: { select: { user: { select: { id: true, first_name: true, last_name: true } } } },
              service_location: { select: { address_line1: true, city: true, state: true } },
              estimate: { select: { estimate_number: true, total_amount: true } },
              invoices: {
                select: {
                  id: true,
                  invoice_number: true,
                  status: true,
                  total_amount: true,
                  amount_due: true,
                  due_date: true,
                  created_at: true,
                  payments: {
                    select: {
                      id: true,
                      amount: true,
                      method: true,
                      paid_at: true,
                      notes: true,
                      collector: { select: { id: true, first_name: true, last_name: true } },
                    },
                    orderBy: { paid_at: 'desc' as const },
                  },
                },
                orderBy: { created_at: 'asc' as const },
              },
            },
            orderBy: { created_at: 'desc' },
            take: 20,
          },
        },
      }),
      prisma.note.findMany({
        where: { entity_type: 'CUSTOMER', entity_id: id, ...tenantWhere(req) },
        select: {
          id: true,
          content: true,
          created_at: true,
          creator: { select: { id: true, first_name: true, last_name: true } },
        },
        orderBy: { created_at: 'desc' },
        take: 50,
      }),
      // §6/§8 — reach invoices anchored directly to the customer (orphan + estimate-anchored,
      // not only the job-nested ones above). Job-less invoices have a non-null customer_id.
      prisma.invoice.findMany({
        where: { customer_id: id, job_id: null, organization_id: orgId },
        select: {
          id: true,
          invoice_number: true,
          status: true,
          kind: true,
          total_amount: true,
          amount_due: true,
          due_date: true,
          created_at: true,
          payments: {
            select: {
              id: true,
              amount: true,
              method: true,
              paid_at: true,
              notes: true,
              collector: { select: { id: true, first_name: true, last_name: true } },
            },
            orderBy: { paid_at: 'desc' as const },
          },
        },
        orderBy: { created_at: 'desc' as const },
        take: 20,
      }),
      loadCustomerFinancials(id, orgId),
      prisma.$queryRaw<Array<{
        total: string;
        pending: string;
        approved: string;
        total_value: string | null;
      }>>`
        SELECT
          COUNT(*)::text AS total,
          COUNT(CASE WHEN e.status IN ('DRAFT','SENT') THEN 1 END)::text AS pending,
          COUNT(CASE WHEN e.status = ${ESTIMATE_STATUS.WON}::"EstimateStatus" THEN 1 END)::text AS approved,
          COALESCE(SUM(e.total_amount), 0) AS total_value
        FROM estimates e
        WHERE e.customer_id = ${id}::uuid
          AND e.organization_id = ${orgId}::uuid
      `,
      prisma.$queryRaw<Array<{
        deposits_collected: string | null;
        deposits_pending: string | null;
      }>>`
        SELECT
          COALESCE(SUM(CASE WHEN i.status = 'PAID' THEN i.total_amount ELSE 0 END), 0) AS deposits_collected,
          COALESCE(SUM(CASE WHEN i.status IN ('DRAFT', 'SENT') THEN i.amount_due ELSE 0 END), 0) AS deposits_pending
        FROM invoices i
        JOIN estimates e ON i.estimate_id = e.id
        WHERE i.kind = 'DEPOSIT'
          AND e.customer_id = ${id}::uuid
          AND e.organization_id = ${orgId}::uuid
      `,
      prisma.invoice.findMany({
        where: { customer_id: id, organization_id: orgId, kind: { not: 'DEPOSIT' } },
        select: {
          id: true, invoice_number: true, status: true, kind: true,
          total_amount: true, amount_due: true, due_date: true, created_at: true,
          job: { select: { id: true, job_number: true } },
          payments: {
            select: { id: true, amount: true, method: true, paid_at: true, notes: true,
                      collector: { select: { id: true, first_name: true, last_name: true } } },
            orderBy: { paid_at: 'desc' as const },
          },
        },
        orderBy: { created_at: 'desc' as const },
      }),
      prisma.lead.count({ where: { customer_id: id, ...tenantWhere(req), status: { in: OPEN_LEAD_STATUSES } } }),
      prisma.lead.count({ where: { customer_id: id, ...tenantWhere(req), status: { in: ACTIVE_LEAD_STATUSES } } }),
      prisma.task.count({ where: { linked_entity_type: 'CUSTOMER', linked_entity_id: id, ...tenantWhere(req), status: { not: 'DONE' } } }),
    ]);

    if (!customer) {
      res.status(404).json({ error: 'Customer not found' });
      return;
    }

    // SRVW-103 - after the 404 guard, so no tag query fires for a row the caller cannot read.
    const tags = await loadTagsForEntity(req, 'CUSTOMER', customer.id);

    const est = estimateResult[0];
    const dep = depositResult[0];

    // Flatten the nested `job` relation into scalar `job_number`/`job_id` on each invoice row.
    const mappedInvoices = (allInvoices ?? []).map((inv) => ({
      ...inv,
      job_number: inv.job?.job_number ?? null,
      job_id: inv.job?.id ?? null,
      job: undefined,
    }));

    res.json({
      // `notes` is the scalar free-text column (the edit form binds it); the polymorphic
      // Note rows go under `activity_notes` so the two never collide (was: spreading the
      // array onto `notes`, which made the edit form render/save "[object Object]").
      customer: { ...customer, activity_notes: notes, orphan_invoices: orphanInvoices, invoices: mappedInvoices, tags },
      summary: {
        financials,
        estimates: {
          total: parseInt(String(est?.total ?? '0'), 10),
          pending: parseInt(String(est?.pending ?? '0'), 10),
          approved: parseInt(String(est?.approved ?? '0'), 10),
          total_value: parseFloat(String(est?.total_value ?? '0')),
        },
        deposits: {
          collected: parseFloat(String(dep?.deposits_collected ?? '0')),
          pending: parseFloat(String(dep?.deposits_pending ?? '0')),
        },
        leads: { open: openLeadsCount ?? 0, active: activeLeadsCount ?? 0 },
        tasks: { open: openTasksCount ?? 0 },
      },
    });
  } catch (err) {
    logger.error('Get customer error:', err);
    res.status(500).json({ error: 'Failed to get customer' });
  }
}

export async function update(req: Request, res: Response) {
  try {
    const existing = await prisma.customer.findUnique({ where: { id: param(req, 'id'), ...tenantWhere(req) } });
    if (!existing) {
      res.status(404).json({ error: 'Customer not found' });
      return;
    }

    // SRVW-114 slice 3 - custom_fields is pulled out of the generic spread on purpose. `rest`
    // flows straight into prisma.customer.update, so leaving it in would write an arbitrary
    // caller-supplied bag over the stored one: no validation, and every untouched key lost.
    const { extra_emails, phones, billing_same_as_service_location, created_at, custom_fields, ...rest } = req.body;
    const selfId = param(req, 'id');

    let nextCustomFields: Record<string, unknown> | undefined;
    if (custom_fields !== undefined) {
      try {
        await validateCustomFieldValues(req.user!.organization_id, 'CUSTOMER', custom_fields);
      } catch (err) {
        if (err instanceof CustomFieldValidationError) {
          res.status(400).json({ error: err.message });
          return;
        }
        throw err;
      }
      nextCustomFields = mergeCustomFields(existing.custom_fields as Record<string, unknown> | null, custom_fields);
    }

    // §10 — clearing parent_id (member removal / promote-to-standalone) resets bill_to to self (null).
    if ('parent_id' in rest && (rest.parent_id === null || rest.parent_id === undefined)) {
      rest.bill_to_customer_id = null;
    }

    // The effective parent is the EDITED value when parent_id is part of this PATCH, otherwise
    // the persisted parent_id. The bill_to ∈ {self, parent} invariant is evaluated against it,
    // so a member that PATCHes only { bill_to_customer_id: P } is accepted (defect 1).
    const effectiveParentId =
      'parent_id' in rest ? (rest.parent_id ?? null) : ((existing.parent_id as string | null) ?? null);

    // Franchise flag follows the same effective-value pattern: the edited value when is_parent
    // is part of this PATCH, otherwise the persisted flag. Used for the franchise-conflict rule.
    const effectiveIsParent =
      'is_parent' in rest ? rest.is_parent === true : (existing.is_parent as boolean | undefined) === true;

    // §10 — re-parenting to a DIFFERENT non-null parent without restating bill_to: a stale
    // persisted bill_to that no longer satisfies {self, new parent} would otherwise survive
    // and silently break the invariant (defect 2). Re-validate the persisted bill_to against
    // the new parent and reset it to self (null = bills self) when it no longer qualifies.
    if ('parent_id' in rest && rest.parent_id && !('bill_to_customer_id' in rest)) {
      const persistedBillTo = (existing.bill_to_customer_id as string | null) ?? null;
      if (persistedBillTo !== null && persistedBillTo !== selfId && persistedBillTo !== rest.parent_id) {
        rest.bill_to_customer_id = null;
      }
    }

    // §10 guards — run when parent/bill_to OR the franchise flag are part of this edit. The
    // franchise-conflict rule needs to fire even when only is_parent is toggled on a member.
    if ('parent_id' in rest || 'bill_to_customer_id' in rest || 'is_parent' in rest) {
      try {
        await validateParentAndBillTo(req, rest, selfId, effectiveParentId, effectiveIsParent);
      } catch (err) {
        if (err instanceof GuardError) {
          res.status(400).json({ error: err.message });
          return;
        }
        throw err;
      }
    }

    // SERV10X-35 — a customer must keep at least one contact method after this edit.
    if ('phone' in rest || 'email' in rest) {
      const effPhone = 'phone' in rest ? rest.phone : (existing.phone as string | null);
      const effEmail = 'email' in rest ? rest.email : (existing.email as string | null);
      if (!hasPhoneOrEmail({ phone: effPhone, email: effEmail })) {
        res.status(400).json({ error: CONTACT_REQUIRED_MSG });
        return;
      }
    }

    // billing-copy convenience needs the customer's locations.
    if (billing_same_as_service_location) {
      const locs = await prisma.serviceLocation.findMany({
        where: { customer_id: selfId },
        select: { address_line1: true, city: true, state: true, zip: true, is_primary: true },
      });
      applyBillingCopy(Object.assign(rest, { billing_same_as_service_location: true }), locs);
      delete rest.billing_same_as_service_location;
    }

    const isAdmin = req.user?.role === 'ADMIN';
    const createdAtChanged =
      isAdmin && created_at !== undefined &&
      (!existing.created_at ||
       (created_at as Date).toISOString().slice(0, 10) !== (existing.created_at as Date).toISOString().slice(0, 10));
    // §5.1 — kind is derived, never client-supplied. Re-derive it whenever this PATCH
    // touches the customer's identity (name/company), using the EFFECTIVE
    // (edited-if-present, else persisted) values. Untouched PATCHes never write kind.
    const kindUpdate = ('first_name' in rest || 'company_name' in rest)
      ? {
          kind: deriveCustomerKind({
            first_name: 'first_name' in rest ? (rest.first_name as string | null | undefined) : existing.first_name,
            company_name: 'company_name' in rest ? (rest.company_name as string | null | undefined) : existing.company_name,
          }),
        }
      : {};

    const customer = await prisma.customer.update({
      where: { id: param(req, 'id') },
      data: {
        ...rest,
        ...kindUpdate,
        ...(nextCustomFields !== undefined && { custom_fields: nextCustomFields as Prisma.InputJsonValue }),
        ...(createdAtChanged && { created_at }),
        ...(extra_emails !== undefined && {
          extra_emails: {
            deleteMany: {},
            create: normalizeExtraEmails(extra_emails),
          },
        }),
        ...(phones !== undefined && {
          phones: {
            deleteMany: {},
            create: normalizePhones(phones),
          },
        }),
      },
      select: customerSelect,
    });

    const auditFields = [
      ...Object.keys(rest),
      ...(createdAtChanged ? ['created_at'] : []),
      // Destructured out of `rest` above, so it has to be re-declared here or the edit would
      // vanish from the audit trail. Only the field NAME is recorded - the values themselves
      // are org-defined and can hold anything, so they never enter timeline metadata.
      ...(nextCustomFields !== undefined ? ['custom_fields'] : []),
    ];

    await prisma.timelineEvent.create({
      data: {
        organization_id: req.user!.organization_id,
        entity_type: 'CUSTOMER',
        entity_id: param(req, 'id'),
        event_type: 'CUSTOMER_UPDATED',
        description: 'Customer details updated',
        metadata: { fields: auditFields },
        created_by: req.user!.id,
      },
    });

    void logAudit({
      req,
      action: 'customer.updated',
      resourceType: 'Customer',
      resourceId: param(req, 'id'),
      metadata: { fields: auditFields },
    });
    res.json({ customer });
  } catch (err) {
    logger.error('Update customer error:', err);
    res.status(500).json({ error: 'Failed to update customer' });
  }
}

export async function remove(req: Request, res: Response) {
  try {
    const id = param(req, 'id');
    const orgId = req.user!.organization_id;
    const existing = await prisma.customer.findUnique({ where: { id, ...tenantWhere(req) } });
    if (!existing) {
      res.status(404).json({ error: 'Customer not found' });
      return;
    }

    // §10 — a parent billing group with members can never be casually deleted (members are
    // independent customers; detach them first). Archive instead, or force-purge.
    const memberCount = await prisma.customer.count({ where: { parent_id: id, ...tenantWhere(req) } });
    if (memberCount > 0) {
      res.status(400).json({ error: 'Cannot delete a billing group with members — detach members first' });
      return;
    }

    const [leadCount, jobCount] = await Promise.all([
      prisma.lead.count({ where: { customer_id: id, ...tenantWhere(req) } }),
      prisma.job.count({ where: { customer_id: id, ...tenantWhere(req) } }),
    ]);

    if (leadCount > 0 || jobCount > 0) {
      res.status(400).json({ error: 'Cannot delete customer with existing leads or jobs' });
      return;
    }

    // §10 money-gate — casual delete is allowed ONLY when there is zero financial history.
    // Even with no leads/jobs an orphan invoice + payment could still exist in the subtree.
    if (await hasPaymentInSubtree(id, orgId)) {
      res.status(400).json({
        error: 'Cannot delete a customer with recorded payments — archive the customer or force-purge instead',
      });
      return;
    }

    await prisma.customer.delete({ where: { id } });
    void logAudit({ req, action: 'customer.deleted', resourceType: 'Customer', resourceId: id });
    res.json({ message: 'Customer deleted' });
  } catch (err) {
    logger.error('Delete customer error:', err);
    res.status(500).json({ error: 'Failed to delete customer' });
  }
}

// ─── Customer lifecycle (entity-redesign §10) ───────────

export async function archiveCustomer(req: Request, res: Response) {
  try {
    const id = param(req, 'id');
    const existing = await prisma.customer.findUnique({ where: { id, ...tenantWhere(req) } });
    if (!existing) {
      res.status(404).json({ error: 'Customer not found' });
      return;
    }

    const customer = await prisma.customer.update({
      where: { id },
      data: { is_active: false, archived_at: new Date() },
      select: customerSelect,
    });

    await prisma.timelineEvent.create({
      data: {
        organization_id: req.user!.organization_id,
        entity_type: 'CUSTOMER',
        entity_id: id,
        event_type: 'CUSTOMER_ARCHIVED',
        description: 'Customer archived',
        created_by: req.user!.id,
      },
    });

    void logAudit({ req, action: 'customer.archived', resourceType: 'Customer', resourceId: id });
    res.json({ customer });
  } catch (err) {
    logger.error('Archive customer error:', err);
    res.status(500).json({ error: 'Failed to archive customer' });
  }
}

export async function unarchiveCustomer(req: Request, res: Response) {
  try {
    const id = param(req, 'id');
    const existing = await prisma.customer.findUnique({ where: { id, ...tenantWhere(req) } });
    if (!existing) {
      res.status(404).json({ error: 'Customer not found' });
      return;
    }

    const customer = await prisma.customer.update({
      where: { id },
      data: { is_active: true, archived_at: null },
      select: customerSelect,
    });

    await prisma.timelineEvent.create({
      data: {
        organization_id: req.user!.organization_id,
        entity_type: 'CUSTOMER',
        entity_id: id,
        event_type: 'CUSTOMER_UNARCHIVED',
        description: 'Customer unarchived',
        created_by: req.user!.id,
      },
    });

    res.json({ customer });
  } catch (err) {
    logger.error('Unarchive customer error:', err);
    res.status(500).json({ error: 'Failed to unarchive customer' });
  }
}

export const purgeCustomerSchema = z.object({
  confirm: z.string().min(1),
});

export async function purgeCustomer(req: Request, res: Response) {
  try {
    const id = param(req, 'id');
    const orgId = req.user!.organization_id;
    const existing = await prisma.customer.findUnique({ where: { id, ...tenantWhere(req) } });
    if (!existing) {
      res.status(404).json({ error: 'Customer not found' });
      return;
    }

    // Type-to-confirm — body.confirm must equal the customer_number.
    if (req.body?.confirm !== existing.customer_number) {
      res.status(400).json({ error: `Confirmation does not match (expected ${existing.customer_number})` });
      return;
    }

    // Members are independent customers — never cascade-delete them. Block purge while
    // any member still points here (chosen minimal-coherent interpretation of §10).
    const memberCount = await prisma.customer.count({ where: { parent_id: id, ...tenantWhere(req) } });
    if (memberCount > 0) {
      res.status(400).json({ error: 'Cannot purge a billing group with members — detach members first' });
      return;
    }

    // Money-gate audit — ADMIN may purge regardless, but we surface a destructive warning.
    const money = await paymentSummaryForSubtree(id, orgId);

    await prisma.$transaction(async (tx) => {
      await purgeCustomerSubtree(tx, id, orgId);
    });

    // Emit the audit AFTER the subtree wipe (the wipe deletes the customer's own timeline rows).
    await prisma.timelineEvent.create({
      data: {
        organization_id: orgId,
        entity_type: 'CUSTOMER',
        entity_id: id,
        event_type: 'CUSTOMER_PURGED',
        description: `Customer ${existing.customer_number} force-purged`,
        metadata: {
          customer_number: existing.customer_number,
          payment_total: money.paymentTotal,
          has_stripe_charge: money.hasStripeCharge,
        },
        created_by: req.user!.id,
      },
    });

    const response: Record<string, unknown> = { message: 'Customer purged', purged: true };
    if (money.hasPayment) {
      response.warning = `$${money.paymentTotal.toFixed(2)} recorded — destroys financial records`;
      response.payment_total = money.paymentTotal;
      response.has_stripe_charge = money.hasStripeCharge;
      if (money.hasStripeCharge) {
        response.stripe_warning = 'One or more payments have a Stripe charge — purging does not refund the customer';
      }
    }
    res.json(response);
  } catch (err) {
    logger.error('Purge customer error:', err);
    res.status(500).json({ error: 'Failed to purge customer' });
  }
}

// §13 — anonymize is DESIGNED-NOW / BUILT-LATER. The route is gated admin-only and returns
// a documented 501 so the design contract is discoverable and the gate is testable.
export async function anonymizeCustomer(req: Request, res: Response) {
  try {
    const id = param(req, 'id');
    const existing = await prisma.customer.findUnique({ where: { id, ...tenantWhere(req) } });
    if (!existing) {
      res.status(404).json({ error: 'Customer not found' });
      return;
    }
    res.status(501).json({
      error: 'Not Implemented',
      deferred: true,
      design:
        'PII→tombstone (Redacted Customer #N), keep financial skeleton incl. scrubbing frozen ' +
        'invoice/estimate name+address snapshots; retention law beats erasure (GDPR 17(3)(b)/(e), ' +
        'CCPA exempt). Build deferred per §13.',
    });
  } catch (err) {
    logger.error('Anonymize customer error:', err);
    res.status(500).json({ error: 'Failed to anonymize customer' });
  }
}

// ─── Stats & Export ─────────────────────────────────────

export async function getStats(req: Request, res: Response) {
  try {
    const now = new Date();
    const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
    const orgWhere = tenantWhere(req);

    const [total, newThisMonth, activeLeads, activeJobs] = await Promise.all([
      prisma.customer.count({ where: { ...orgWhere } }),
      prisma.customer.count({ where: { ...orgWhere, created_at: { gte: startOfMonth } } }),
      prisma.customer.count({ where: { ...orgWhere, leads: { some: { status: { in: OPEN_LEAD_STATUSES } } } } }),
      prisma.customer.count({ where: { ...orgWhere, jobs: { some: { status: { in: ACTIVE_JOB_STATUSES } } } } }),
    ]);

    res.json({ total, newThisMonth, activeLeads, activeJobs });
  } catch (err) {
    logger.error('Get customer stats error:', err);
    res.status(500).json({ error: 'Failed to get customer stats' });
  }
}

const EXPORT_ROW_CAP = 50_000;

export async function exportAll(req: Request, res: Response) {
  try {
    const where = await buildCustomerListWhere(req);
    const customers = await prisma.customer.findMany({
      where,
      select: {
        ...customerSelect,
        service_locations: {
          where: { is_primary: true },
          select: { address_line1: true, city: true, state: true, zip: true },
          take: 1,
        },
        _count: { select: { leads: true, jobs: true } },
      },
      orderBy: { created_at: 'desc' },
      take: EXPORT_ROW_CAP,
    });
    if (customers.length === EXPORT_ROW_CAP) {
      logger.warn(`Customer export hit row cap (${EXPORT_ROW_CAP}) for org ${req.user?.organization_id}`);
    }

    void logAudit({
      req,
      action: 'customer.exported',
      resourceType: 'Customer',
      resourceId: null,
      metadata: { count: customers.length },
    });
    res.json({ customers });
  } catch (err) {
    logger.error('Export customers error:', err);
    res.status(500).json({ error: 'Failed to export customers' });
  }
}

export async function addLocation(req: Request, res: Response) {
  try {
    const customer = await prisma.customer.findUnique({ where: { id: param(req, 'id'), ...tenantWhere(req) } });
    if (!customer) {
      res.status(404).json({ error: 'Customer not found' });
      return;
    }

    if (req.body.is_primary) {
      await prisma.serviceLocation.updateMany({
        where: { customer_id: param(req, 'id') },
        data: { is_primary: false },
      });
    }

    const location = await prisma.serviceLocation.create({
      data: { ...req.body, customer_id: param(req, 'id') },
      select: locationSelect,
    });

    await prisma.timelineEvent.create({
      data: {
        organization_id: req.user!.organization_id,
        entity_type: 'CUSTOMER',
        entity_id: param(req, 'id'),
        event_type: 'LOCATION_ADDED',
        description: `Service location added: ${location.address_line1}, ${location.city}`,
        metadata: { location_id: location.id },
        created_by: req.user!.id,
      },
    });

    res.status(201).json({ location });
  } catch (err) {
    logger.error('Add location error:', err);
    res.status(500).json({ error: 'Failed to add location' });
  }
}

export async function updateLocation(req: Request, res: Response) {
  try {
    const customer = await prisma.customer.findUnique({ where: { id: param(req, 'id'), ...tenantWhere(req) } });
    if (!customer) {
      res.status(404).json({ error: 'Customer not found' });
      return;
    }
    const location = await prisma.serviceLocation.findFirst({
      where: { id: param(req, 'locId'), customer_id: param(req, 'id') },
    });
    if (!location) {
      res.status(404).json({ error: 'Location not found' });
      return;
    }

    if (req.body.is_primary) {
      await prisma.serviceLocation.updateMany({
        where: { customer_id: param(req, 'id'), NOT: { id: param(req, 'locId') } },
        data: { is_primary: false },
      });
    }

    const updated = await prisma.serviceLocation.update({
      where: { id: param(req, 'locId') },
      data: req.body,
      select: locationSelect,
    });

    await prisma.timelineEvent.create({
      data: {
        organization_id: req.user!.organization_id,
        entity_type: 'CUSTOMER',
        entity_id: param(req, 'id'),
        event_type: 'LOCATION_UPDATED',
        description: `Service location updated: ${updated.address_line1}, ${updated.city}`,
        metadata: { location_id: updated.id },
        created_by: req.user!.id,
      },
    });

    res.json({ location: updated });
  } catch (err) {
    logger.error('Update location error:', err);
    res.status(500).json({ error: 'Failed to update location' });
  }
}

// §10 — the "1+ active locations, exactly one primary" invariant. Guards removing or
// archiving a location: blocks the last active, and the primary unless another is promoted.
// Throws GuardError (→ 400). Promotes `promoteId` first when supplied.
async function enforceLocationInvariant(
  customerId: string,
  location: { id: string; is_primary: boolean },
  promoteId: string | undefined,
): Promise<void> {
  const activeCount = await prisma.serviceLocation.count({
    where: { customer_id: customerId, is_active: true },
  });
  if (activeCount <= 1) {
    throw new GuardError('Cannot remove the last active location');
  }
  if (location.is_primary) {
    if (!promoteId) {
      throw new GuardError('Cannot remove the primary location without promoting another');
    }
    // Promote the supplied location to primary, demote everyone else.
    await prisma.serviceLocation.updateMany({
      where: { customer_id: customerId, NOT: { id: promoteId } },
      data: { is_primary: false },
    });
    await prisma.serviceLocation.update({ where: { id: promoteId }, data: { is_primary: true } });
  }
}

export async function removeLocation(req: Request, res: Response) {
  try {
    const customerId = param(req, 'id');
    const locId = param(req, 'locId');
    const customer = await prisma.customer.findUnique({ where: { id: customerId, ...tenantWhere(req) } });
    if (!customer) {
      res.status(404).json({ error: 'Customer not found' });
      return;
    }
    const location = await prisma.serviceLocation.findFirst({
      where: { id: locId, customer_id: customerId },
    });
    if (!location) {
      res.status(404).json({ error: 'Location not found' });
      return;
    }

    // last-active / primary invariant (promotes if promote_location_id supplied).
    try {
      await enforceLocationInvariant(customerId, location, req.body?.promote_location_id);
    } catch (err) {
      if (err instanceof GuardError) {
        res.status(400).json({ error: err.message });
        return;
      }
      throw err;
    }

    // §10 — hard-delete only if NEVER referenced by a lead OR a job; else archive.
    const [jobCount, leadCount] = await Promise.all([
      prisma.job.count({ where: { service_location_id: locId, ...tenantWhere(req) } }),
      prisma.lead.count({ where: { service_location_id: locId, ...tenantWhere(req) } }),
    ]);

    if (jobCount > 0 || leadCount > 0) {
      await prisma.serviceLocation.update({
        where: { id: locId },
        data: { is_active: false, archived_at: new Date() },
      });
      await prisma.timelineEvent.create({
        data: {
          organization_id: req.user!.organization_id,
          entity_type: 'CUSTOMER',
          entity_id: customerId,
          event_type: 'LOCATION_ARCHIVED',
          description: 'Service location archived (referenced by leads or jobs)',
          metadata: { location_id: locId },
          created_by: req.user!.id,
        },
      });
      res.json({ message: 'Location archived (referenced by leads or jobs)', archived: true });
      return;
    }

    await prisma.serviceLocation.delete({ where: { id: locId } });
    res.json({ message: 'Location deleted' });
  } catch (err) {
    logger.error('Delete location error:', err);
    res.status(500).json({ error: 'Failed to delete location' });
  }
}

export async function archiveLocation(req: Request, res: Response) {
  try {
    const customerId = param(req, 'id');
    const locId = param(req, 'locId');
    const customer = await prisma.customer.findUnique({ where: { id: customerId, ...tenantWhere(req) } });
    if (!customer) {
      res.status(404).json({ error: 'Customer not found' });
      return;
    }
    const location = await prisma.serviceLocation.findFirst({
      where: { id: locId, customer_id: customerId },
    });
    if (!location) {
      res.status(404).json({ error: 'Location not found' });
      return;
    }

    try {
      await enforceLocationInvariant(customerId, location, req.body?.promote_location_id);
    } catch (err) {
      if (err instanceof GuardError) {
        res.status(400).json({ error: err.message });
        return;
      }
      throw err;
    }

    const updated = await prisma.serviceLocation.update({
      where: { id: locId },
      data: { is_active: false, archived_at: new Date() },
      select: locationSelect,
    });

    await prisma.timelineEvent.create({
      data: {
        organization_id: req.user!.organization_id,
        entity_type: 'CUSTOMER',
        entity_id: customerId,
        event_type: 'LOCATION_ARCHIVED',
        description: `Service location archived: ${updated.address_line1}, ${updated.city}`,
        metadata: { location_id: locId },
        created_by: req.user!.id,
      },
    });

    res.json({ location: updated });
  } catch (err) {
    logger.error('Archive location error:', err);
    res.status(500).json({ error: 'Failed to archive location' });
  }
}

// ─── Customer Summary (Financial Aggregation) ──────────

export async function getSummary(req: Request, res: Response) {
  try {
    const id = param(req, 'id');
    const orgId = req.user!.organization_id;

    const customer = await prisma.customer.findUnique({ where: { id, ...tenantWhere(req) } });
    if (!customer) {
      res.status(404).json({ error: 'Customer not found' });
      return;
    }

    // Run all 3 aggregation queries in parallel
    const [financials, estimateResult, depositResult] = await Promise.all([
      loadCustomerFinancials(id, orgId),
      prisma.$queryRaw<Array<{
        total: string;
        pending: string;
        approved: string;
        total_value: string | null;
      }>>`
        SELECT
          COUNT(*)::text AS total,
          COUNT(CASE WHEN e.status IN ('DRAFT','SENT') THEN 1 END)::text AS pending,
          COUNT(CASE WHEN e.status = ${ESTIMATE_STATUS.WON}::"EstimateStatus" THEN 1 END)::text AS approved,
          COALESCE(SUM(e.total_amount), 0) AS total_value
        FROM estimates e
        WHERE e.customer_id = ${id}::uuid
          AND e.organization_id = ${orgId}::uuid
      `,
      prisma.$queryRaw<Array<{
        deposits_collected: string | null;
        deposits_pending: string | null;
      }>>`
        SELECT
          COALESCE(SUM(CASE WHEN i.status = 'PAID' THEN i.total_amount ELSE 0 END), 0) AS deposits_collected,
          COALESCE(SUM(CASE WHEN i.status IN ('DRAFT', 'SENT') THEN i.amount_due ELSE 0 END), 0) AS deposits_pending
        FROM invoices i
        JOIN estimates e ON i.estimate_id = e.id
        WHERE i.kind = 'DEPOSIT'
          AND e.customer_id = ${id}::uuid
          AND e.organization_id = ${orgId}::uuid
      `,
    ]);

    const est = estimateResult[0];
    const dep = depositResult[0];

    res.json({
      financials,
      estimates: {
        total: parseInt(String(est?.total ?? '0'), 10),
        pending: parseInt(String(est?.pending ?? '0'), 10),
        approved: parseInt(String(est?.approved ?? '0'), 10),
        total_value: parseFloat(String(est?.total_value ?? '0')),
      },
      deposits: {
        collected: parseFloat(String(dep?.deposits_collected ?? '0')),
        pending: parseFloat(String(dep?.deposits_pending ?? '0')),
      },
    });
  } catch (err) {
    logger.error('Get customer summary error:', err);
    res.status(500).json({ error: 'Failed to get customer summary' });
  }
}

// ─── Customer Notes ─────────────────────────────────────

export const createNoteSchema = z.object({
  content: z.string().min(1).max(5000),
});

export async function addNote(req: Request, res: Response) {
  try {
    const id = param(req, 'id');

    const customer = await prisma.customer.findUnique({ where: { id, ...tenantWhere(req) } });
    if (!customer) {
      res.status(404).json({ error: 'Customer not found' });
      return;
    }

    const note = await prisma.note.create({
      data: {
        entity_type: 'CUSTOMER',
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
    logger.error('Add customer note error:', err);
    res.status(500).json({ error: 'Failed to add note' });
  }
}
