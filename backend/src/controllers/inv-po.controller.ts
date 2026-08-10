import { Request, Response } from 'express';
import { z } from 'zod';
import { Prisma, PrismaClient } from '@prisma/client';
import { prisma } from '../lib/prisma';
import { logger } from '../lib/logger';
import { tenantWhere } from '../lib/tenant';
import { allocateNumber } from '../lib/numbering';
import { logAudit } from '../lib/audit';
import { canAccessRow } from '../lib/permissions/enforce';
import { applyStockMovement, resolveItemsById } from './inv-stock.controller';
import { emitPoPartial } from '../services/notifications/inventoryEmit';
import { sendPurchaseOrderEmail, dispatchFailureStatus, EmailDispatchResult, PurchaseOrderEmailLine } from '../lib/email';
import { env } from '../config/env';

const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ─── Org-validated FK guard (closes the P1 cross-org injection gap) ──────────
// Before persisting an inbound job_id/customer_id, confirm the referenced row
// belongs to the requesting org. Returns an error message string (→ 400) or null.
async function validateJobAndCustomer(req: Request, jobId?: string | null, customerId?: string | null): Promise<string | null> {
  if (jobId) {
    const job = await prisma.job.findFirst({ where: { id: jobId, ...tenantWhere(req) }, select: { id: true } });
    if (!job) return 'Invalid job_id';
  }
  if (customerId) {
    const customer = await prisma.customer.findFirst({ where: { id: customerId, ...tenantWhere(req) }, select: { id: true } });
    if (!customer) return 'Invalid customer_id';
  }
  return null;
}

// ─── Org-validated vendor FK guard (P2 item 1b) ──────────────────────────────
// Mirrors validateJobAndCustomer: a supplied vendorId must resolve inside the
// requesting org. Returns the vendor row (for display-string resolution) or an
// error message string (→ 400).
async function validateVendor(
  req: Request,
  vendorId?: string | null,
): Promise<{ error: string | null; vendor: { id: string; name: string } | null }> {
  if (!vendorId) return { error: null, vendor: null };
  const vendor = await prisma.vendor.findFirst({
    where: { id: vendorId, ...tenantWhere(req) },
    select: { id: true, name: true },
  });
  if (!vendor) return { error: 'Invalid vendor_id', vendor: null };
  return { error: null, vendor };
}

// Org-validate client-supplied per-line priceBookItemIds (P2: the low-stock create
// flow sends explicit catalog FKs). Cross-org/unknown ids are dropped to null —
// same tolerance as an unmatched SKU (the line is kept, just uncatalogued).
async function resolveExplicitItemIds(req: Request, lines: Array<{ priceBookItemId?: string | null }>): Promise<Set<string>> {
  const ids = [...new Set(lines.map((l) => l.priceBookItemId).filter((v): v is string => !!v))];
  if (ids.length === 0) return new Set();
  const rows = await prisma.priceBookItem.findMany({
    where: { id: { in: ids }, ...tenantWhere(req) },
    select: { id: true },
  });
  return new Set(rows.map((r) => r.id));
}

// ─── SKU → PriceBookItem resolver (V6/D5) ───────────────────────────────────
// Map each inbound line's item_sku to a catalog PriceBookItem id within the
// requesting org. @@unique([organization_id, sku]) guarantees ≤1 match per SKU.
// Lines whose SKU has no catalog match keep price_book_item_id = null.
//
// `db` defaults to the global client for the pre-transaction call sites. A caller already inside
// an interactive transaction MUST pass its `tx` — a global query there checks out a SECOND pooled
// connection while the first is still held, which starves the pool and fails the whole
// transaction with P2024 on a connection-limited deployment (invisible locally, where spare
// connections mask it).
async function resolveSkuMap(
  req: Request,
  skus: string[],
  db: Prisma.TransactionClient | PrismaClient = prisma,
): Promise<Map<string, string>> {
  const unique = [...new Set(skus.filter(Boolean))];
  if (unique.length === 0) return new Map();
  const items = await db.priceBookItem.findMany({
    where: { sku: { in: unique }, ...tenantWhere(req) },
    select: { id: true, sku: true },
  });
  return new Map(items.filter((i) => i.sku).map((i) => [i.sku as string, i.id]));
}

// ─── Receive-location resolver (DEC3) ───────────────────────────────────────
// Resolve the org's configured default inventory location; fall back to the
// first 'warehouse' location only if no default is set (e.g. legacy orgs).
async function resolveReceiveLocationId(req: Request): Promise<string | null> {
  const org = await prisma.organization.findUnique({
    where: { id: req.user!.organization_id },
    select: { default_inventory_location_id: true },
  });
  if (org?.default_inventory_location_id) return org.default_inventory_location_id;
  const fallback = await prisma.inventoryLocation.findFirst({
    where: { ...tenantWhere(req), type: 'warehouse' }, select: { id: true },
  });
  return fallback?.id ?? null;
}

// ─── Mappers (snake_case Prisma row → camelCase frontend contract) ──────────
//
// The frontend is typed against the `_mock/inventory` shapes. Every handler
// returns JSON whose shape EXACTLY matches the corresponding mock type:
//   PurchaseOrder  (purchase-orders.ts)
//   RFQ            (pre-po.ts)
//   EstimateReservation (pre-po.ts)
// Decimal columns are coerced to numbers; ISO timestamps to strings; optional
// columns that are null are dropped to match the optional `?` mock fields.

function mapPOLine(line: any) {
  return {
    id: line.id,
    itemSku: line.item_sku,
    itemName: line.item_name,
    uom: line.uom,
    qtyOrdered: Number(line.qty_ordered),
    qtyReceived: Number(line.qty_received),
    unitCost: line.unit_cost != null ? Number(line.unit_cost) : undefined,
    priceBookItemId: line.price_book_item_id ?? undefined,
  };
}

function mapPurchaseOrder(po: any) {
  const out: any = {
    id: po.id,
    poNumber: po.po_number,
    vendor: po.vendor,
    status: po.status,
    orderedAt: po.ordered_at.toISOString(),
    lines: (po.lines ?? []).map(mapPOLine),
  };
  if (po.job?.job_number) out.jobNumber = po.job.job_number;
  if (po.customer != null) out.customer = po.customer;
  if (po.site != null) out.site = po.site;
  if (po.trade != null) out.trade = po.trade;
  if (po.expected_date != null) out.expectedDate = po.expected_date.toISOString();
  if (po.staged_as_job_stage_id != null) out.stagedAsJobStageId = po.staged_as_job_stage_id;
  if (po.vendor_id != null) out.vendorId = po.vendor_id;
  // P2 item 6: outbound send history — included on the detail read only.
  if (Array.isArray(po.emails)) out.emails = po.emails.map(mapEmail);
  return out;
}

function mapPrePOLine(line: any) {
  return {
    itemSku: line.item_sku,
    itemName: line.item_name,
    qty: Number(line.qty),
    uom: line.uom,
    priceBookItemId: line.price_book_item_id ?? undefined,
  };
}

function mapEmail(email: any) {
  const out: any = {
    id: email.id,
    direction: email.direction,
    kind: email.kind,
    from: email.from,
    to: email.to,
    subject: email.subject,
    body: email.body,
    sentAt: email.sent_at.toISOString(),
  };
  if (email.attachments != null) out.attachments = email.attachments;
  return out;
}

function mapRfqQuote(quote: any) {
  return {
    vendor: quote.vendor,
    total: Number(quote.total),
    leadTimeDays: quote.lead_time_days,
    recommended: quote.recommended,
  };
}

function mapRfq(rfq: any) {
  const out: any = {
    id: rfq.id,
    rfqNumber: rfq.rfq_number,
    requestedAt: rfq.requested_at.toISOString(),
    responsesDueBy: rfq.responses_due_by.toISOString(),
    linesSummary: rfq.lines_summary,
    lines: (rfq.lines ?? []).map(mapPrePOLine),
    quotes: (rfq.quotes ?? []).map(mapRfqQuote),
    status: rfq.status,
    emails: (rfq.emails ?? []).map(mapEmail),
  };
  if (rfq.job_number != null) out.jobNumber = rfq.job_number;
  if (rfq.customer != null) out.customer = rfq.customer;
  if (rfq.site != null) out.site = rfq.site;
  if (rfq.trade != null) out.trade = rfq.trade;
  return out;
}

function mapEstimateReservation(r: any) {
  const out: any = {
    id: r.id,
    estimateNumber: r.estimate_number,
    customer: r.customer,
    approvedAt: r.approved_at.toISOString(),
    reservedTotal: Number(r.reserved_total),
    linesSummary: r.lines_summary,
    lines: (r.lines ?? []).map(mapPrePOLine),
    emails: (r.emails ?? []).map(mapEmail),
    // Lifecycle (P2 §3): 'open' | 'converted' | 'dismissed' — always emitted.
    status: r.status,
  };
  if (r.job_number != null) out.jobNumber = r.job_number;
  if (r.customer_email != null) out.customerEmail = r.customer_email;
  if (r.site != null) out.site = r.site;
  if (r.trade != null) out.trade = r.trade;
  if (r.preferred_vendor != null) out.preferredVendor = r.preferred_vendor;
  if (r.converted_purchase_order_id != null) out.convertedPurchaseOrderId = r.converted_purchase_order_id;
  if (r.converted_purchase_order?.po_number != null) out.convertedPoNumber = r.converted_purchase_order.po_number;
  // A-12 context for the queue row: approved estimates are frozen and there is NO
  // estimate-side auto-dismiss, so open + leadStatus LOST is a legitimate state
  // surfaced for the human call (QA-308).
  if (r.estimate?.status != null) out.estimateStatus = r.estimate.status;
  if (r.estimate?.lead?.status != null) out.leadStatus = r.estimate.lead.status;
  return out;
}

// ─── Zod Schemas ────────────────────────────────────────

const tradeEnum = z.enum(['locksmith', 'door', 'security', 'hvac', 'plumbing', 'multi']);

const poLineSchema = z.object({
  itemSku: z.string().max(100).default(''), // optional label; identity is priceBookItemId (D2)
  itemName: z.string().min(1),
  uom: z.string().min(1),
  qtyOrdered: z.number().min(0),
  qtyReceived: z.number().min(0).optional(),
  unitCost: z.number().min(0).nullable().optional(),
  // P2: an explicit catalog FK (low-stock create flow) wins over SKU re-resolution.
  priceBookItemId: z.string().uuid().nullable().optional(),
});

// po_number is server-assigned via allocateNumber('purchase_order') — never
// client-supplied (P0 §A). Old clients still sending poNumber are stripped by
// Zod's unknown-key removal, so they get no 400.
// P2 item 1b: vendorId is the org-validated FK; the vendor display string may be
// omitted when vendorId is supplied (it is then resolved from the vendor row).
export const createPurchaseOrderSchema = z.object({
  vendor: z.string().min(1, 'Vendor is required').max(200).optional(),
  vendorId: z.string().uuid().nullable().optional(),
  status: z.enum(['draft', 'sent', 'partial', 'received', 'closed']).optional(),
  jobId: z.string().uuid().nullable().optional(),
  customerId: z.string().uuid().nullable().optional(),
  jobNumber: z.string().max(50).nullable().optional(),
  customer: z.string().max(200).nullable().optional(),
  site: z.string().max(500).nullable().optional(),
  trade: tradeEnum.nullable().optional(),
  orderedAt: z.string().datetime().optional(),
  expectedDate: z.string().datetime().nullable().optional(),
  lines: z.array(poLineSchema).min(1, 'At least one line is required'),
}).refine((b) => !!b.vendor || !!b.vendorId, { message: 'Vendor is required', path: ['vendor'] });

export const updatePurchaseOrderSchema = z.object({
  vendor: z.string().min(1).max(200).optional(),
  vendorId: z.string().uuid().nullable().optional(),
  status: z.enum(['draft', 'sent', 'partial', 'received', 'closed']).optional(),
  jobId: z.string().uuid().nullable().optional(),
  customerId: z.string().uuid().nullable().optional(),
  customer: z.string().max(200).nullable().optional(),
  site: z.string().max(500).nullable().optional(),
  trade: tradeEnum.nullable().optional(),
  orderedAt: z.string().datetime().optional(),
  expectedDate: z.string().datetime().nullable().optional(),
  lines: z.array(poLineSchema).min(1).optional(),
});

// P2 item 1c (D16 entry 2): job-anchored PO create — the FE sends only ids; SKU/name/
// uom/cost are SERVER-resolved from job line items and/or catalog rows.
export const createPurchaseOrderFromJobSchema = z.object({
  jobId: z.string().uuid(),
  vendorId: z.string().uuid().nullable().optional(),
  expectedDate: z.string().datetime().nullable().optional(),
  lines: z.array(
    z.object({
      jobLineItemId: z.string().uuid().optional(),
      priceBookItemId: z.string().uuid().optional(),
      qty: z.number().positive(),
    }).refine((l) => !!l.jobLineItemId || !!l.priceBookItemId, 'jobLineItemId or priceBookItemId required')
  ).min(1),
});

// P2 item 3a/3b: reservation lifecycle verbs.
export const convertReservationSchema = z.object({
  vendorId: z.string().uuid().nullable().optional(),
  expectedDate: z.string().datetime().nullable().optional(),
});

export const dismissReservationSchema = z.object({
  reason: z.string().max(500).optional(),
});

const rfqLineSchema = z.object({
  itemSku: z.string().min(1),
  itemName: z.string().min(1),
  qty: z.number().min(0),
  uom: z.string().min(1),
});

const rfqQuoteSchema = z.object({
  vendor: z.string().min(1),
  total: z.number().min(0),
  leadTimeDays: z.number().int().min(0),
  recommended: z.boolean().optional(),
});

export const createRfqSchema = z.object({
  rfqNumber: z.string().min(1, 'RFQ number is required').max(50),
  jobId: z.string().uuid().nullable().optional(),
  customerId: z.string().uuid().nullable().optional(),
  jobNumber: z.string().max(50).nullable().optional(),
  customer: z.string().max(200).nullable().optional(),
  site: z.string().max(500).nullable().optional(),
  trade: tradeEnum.nullable().optional(),
  requestedAt: z.string().datetime().optional(),
  responsesDueBy: z.string().datetime(),
  linesSummary: z.object({ items: z.number().int().min(0), units: z.number().min(0) }),
  status: z.enum(['awaiting_quotes', 'ready_to_compare', 'winner_picked']).optional(),
  lines: z.array(rfqLineSchema).min(1, 'At least one line is required'),
  quotes: z.array(rfqQuoteSchema).optional(),
});

export const updateRfqSchema = z.object({
  rfqNumber: z.string().min(1).max(50).optional(),
  jobId: z.string().uuid().nullable().optional(),
  customerId: z.string().uuid().nullable().optional(),
  jobNumber: z.string().max(50).nullable().optional(),
  customer: z.string().max(200).nullable().optional(),
  site: z.string().max(500).nullable().optional(),
  trade: tradeEnum.nullable().optional(),
  requestedAt: z.string().datetime().optional(),
  responsesDueBy: z.string().datetime().optional(),
  linesSummary: z.object({ items: z.number().int().min(0), units: z.number().min(0) }).optional(),
  status: z.enum(['awaiting_quotes', 'ready_to_compare', 'winner_picked']).optional(),
  lines: z.array(rfqLineSchema).min(1).optional(),
  quotes: z.array(rfqQuoteSchema).optional(),
});

// ─── Purchase Order Handlers ────────────────────────────

export async function listPurchaseOrders(req: Request, res: Response) {
  try {
    const orders = await prisma.purchaseOrder.findMany({
      where: tenantWhere(req),
      orderBy: { ordered_at: 'desc' },
      include: {
        lines: { orderBy: { created_at: 'asc' } },
        job: { select: { job_number: true } },
        customer_rel: { select: { id: true, first_name: true, last_name: true, company_name: true } },
      },
    });

    res.json({ purchaseOrders: orders.map(mapPurchaseOrder) });
  } catch (err) {
    logger.error('Failed to list purchase orders:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
}

export async function getPurchaseOrder(req: Request, res: Response) {
  try {
    const order = await prisma.purchaseOrder.findFirst({
      where: { id: req.params.id as string, ...tenantWhere(req) },
      include: {
        lines: { orderBy: { created_at: 'asc' } },
        job: { select: { job_number: true } },
        customer_rel: { select: { id: true, first_name: true, last_name: true, company_name: true } },
        // P2 item 6: send history on the detail read only (not the list).
        emails: { orderBy: { sent_at: 'asc' } },
      },
    });

    if (!order) {
      res.status(404).json({ error: 'Purchase order not found' });
      return;
    }

    res.json({ purchaseOrder: mapPurchaseOrder(order) });
  } catch (err) {
    logger.error('Failed to get purchase order:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
}

// ─── PO Activity (D7) — real timeline, replaces the synthesized ActivityTabStub.
// Two truthful sources, merged and sorted chronologically:
//   • AuditLog       — lifecycle verbs (created / updated / received) + actor.
//   • InventoryEmail — every real vendor send, with subject + recipient list.
// `inventory.po_sent` audit rows are intentionally dropped: the InventoryEmail
// row is the authoritative, transactionally-durable record of the same send (and
// carries the subject + full recipients), so surfacing both would double-list it.
interface POActivityEvent {
  id: string;
  at: string; // ISO 8601 — sorts lexically, so string compare == chronological
  kind: 'created' | 'updated' | 'received' | 'email_sent' | 'event';
  summary: string;
  actor: string | null;
  detail?: string;
}

function mapAuditToActivity(row: {
  id: string;
  action: string;
  actor_email: string | null;
  metadata: Prisma.JsonValue;
  created_at: Date;
}): POActivityEvent | null {
  const meta = (row.metadata ?? {}) as Record<string, unknown>;
  const base = { id: row.id, at: row.created_at.toISOString(), actor: row.actor_email };
  switch (row.action) {
    case 'inventory.po_created':
      return {
        ...base, kind: 'created', summary: 'Purchase order created',
        detail: typeof meta.vendor === 'string' && meta.vendor ? `Vendor: ${meta.vendor}` : undefined,
      };
    case 'inventory.po_updated': {
      const fields = Array.isArray(meta.fields) ? (meta.fields as unknown[]).filter((f) => typeof f === 'string').join(', ') : '';
      return {
        ...base, kind: 'updated', summary: 'Purchase order updated',
        detail: fields ? `Changed: ${fields}` : undefined,
      };
    }
    case 'inventory.po_received': {
      const n = typeof meta.lines_received === 'number' ? meta.lines_received : null;
      const status = typeof meta.status === 'string' ? meta.status : null;
      return {
        ...base, kind: 'received',
        summary: n != null ? `Received ${n} line${n === 1 ? '' : 's'}` : 'Items received',
        detail: status ? `Status: ${status}` : undefined,
      };
    }
    case 'inventory.po_sent':
      return null; // represented by the InventoryEmail row instead (no double-listing)
    default:
      return { ...base, kind: 'event', summary: row.action };
  }
}

export async function getPurchaseOrderActivity(req: Request, res: Response) {
  try {
    const orgId = req.user!.organization_id;
    const poId = req.params.id as string;

    // Prove the PO is in-org before reading its trail; a miss returns the same
    // 404 the malformed-id guard (requireUuidParam) does.
    const po = await prisma.purchaseOrder.findFirst({
      where: { id: poId, ...tenantWhere(req) }, select: { id: true },
    });
    if (!po) { res.status(404).json({ error: 'Purchase order not found' }); return; }

    // AuditLog is keyed on `org_id` (not the `organization_id` tenantWhere spreads),
    // so scope it explicitly — poId is already proven in-org above.
    const [audits, emails] = await Promise.all([
      prisma.auditLog.findMany({
        where: { org_id: orgId, resource_type: 'PurchaseOrder', resource_id: poId },
        orderBy: { created_at: 'asc' },
      }),
      prisma.inventoryEmail.findMany({
        where: { purchase_order_id: poId, organization_id: orgId },
        orderBy: { sent_at: 'asc' },
      }),
    ]);

    const fromAudit = audits
      .map(mapAuditToActivity)
      .filter((e): e is POActivityEvent => e !== null);

    const fromEmail: POActivityEvent[] = emails.map((e) => {
      const recipients = Array.isArray(e.to)
        ? (e.to as unknown[]).filter((x): x is string => typeof x === 'string')
        : [];
      return {
        id: e.id,
        at: e.sent_at.toISOString(),
        kind: 'email_sent',
        summary: recipients.length > 0 ? `Emailed to ${recipients.join(', ')}` : 'Emailed to vendor',
        actor: null,
        detail: e.subject || undefined,
      };
    });

    const activity = [...fromAudit, ...fromEmail].sort((a, b) => a.at.localeCompare(b.at));
    res.json({ activity });
  } catch (err) {
    logger.error('Failed to load purchase order activity:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
}

// ─── PO persist core (P2 item 1a) ────────────────────────────────────────────
// One write path for every PO entry point (manual create, from-job, reservation
// convert). Callers are responsible for org-validating every FK they pass in.
// When txArg is provided the create joins the caller's transaction (reservation
// convert links status flip + PO create + FK write atomically); otherwise the
// core opens its own.

interface PersistPoLine {
  itemSku: string;
  itemName: string;
  uom: string;
  qtyOrdered: number;
  qtyReceived?: number;
  unitCost?: number | null;
  priceBookItemId?: string | null; // explicit FK wins over SKU re-resolution
}

interface PersistPoInput {
  vendor: string;               // display snapshot ('' allowed at the core level — Zod guards the manual create)
  vendorId?: string | null;     // FK, already org-validated by the caller
  status?: string;              // default 'draft'
  jobId?: string | null;
  customerId?: string | null;
  customer?: string | null;
  site?: string | null;
  trade?: string | null;
  orderedAt?: string;
  expectedDate?: string | null;
  source: 'manual' | 'job' | 'reservation';
  lines: PersistPoLine[];
}

const PO_INCLUDE = {
  lines: { orderBy: { created_at: 'asc' as const } },
  job: { select: { job_number: true } },
  customer_rel: { select: { id: true, first_name: true, last_name: true, company_name: true } },
};

async function persistPurchaseOrder(req: Request, input: PersistPoInput, txArg?: Prisma.TransactionClient) {
  const orgId = req.user!.organization_id;
  // Pass txArg through: when a caller (convertEstimateReservation) hands us its transaction, this
  // resolver must run on THAT connection, not reach for a second one out of the pool.
  const skuMap = await resolveSkuMap(req, input.lines.map((l) => l.itemSku), txArg ?? prisma);

  // Allocate the PO number inside the create transaction: the org-row lock
  // taken by allocateNumber serializes concurrent creates, and a failed
  // create rolls the counter increment back with it (P0 §A).
  const createIn = async (tx: Prisma.TransactionClient) => {
    const poNumber = await allocateNumber(tx, 'purchase_order', orgId);
    return tx.purchaseOrder.create({
      data: {
        po_number: poNumber,
        vendor: input.vendor,
        vendor_id: input.vendorId ?? null,
        status: input.status ?? 'draft',
        // jobNumber is a display value sourced from the related Job on read;
        // the PO links by job_id (UUID FK), not a job_number column.
        job_id: input.jobId ?? null,
        customer_id: input.customerId ?? null,
        customer: input.customer ?? null,
        site: input.site ?? null,
        trade: input.trade ?? null,
        ordered_at: input.orderedAt ? new Date(input.orderedAt) : new Date(),
        expected_date: input.expectedDate ? new Date(input.expectedDate) : null,
        organization_id: orgId,
        lines: {
          create: input.lines.map((line) => ({
            item_sku: line.itemSku,
            item_name: line.itemName,
            uom: line.uom,
            qty_ordered: line.qtyOrdered,
            qty_received: line.qtyReceived ?? 0,
            unit_cost: line.unitCost ?? null,
            price_book_item_id: line.priceBookItemId ?? skuMap.get(line.itemSku) ?? null,
            organization_id: orgId,
          })),
        },
      },
      include: PO_INCLUDE,
    });
  };

  const order = txArg ? await createIn(txArg) : await prisma.$transaction(createIn);

  void logAudit({
    req,
    action: 'inventory.po_created',
    resourceType: 'PurchaseOrder',
    resourceId: order.id,
    metadata: {
      po_number: order.po_number, vendor: order.vendor, job_id: order.job_id,
      line_count: input.lines.length, vendor_id: input.vendorId ?? null, source: input.source,
    },
  });

  return order;
}

export async function createPurchaseOrder(req: Request, res: Response) {
  try {
    const body = req.body;

    const fkError = await validateJobAndCustomer(req, body.jobId, body.customerId);
    if (fkError) { res.status(400).json({ error: fkError }); return; }

    const { error: vendorError, vendor: vendorRow } = await validateVendor(req, body.vendorId);
    if (vendorError) { res.status(400).json({ error: vendorError }); return; }

    // Client-supplied per-line catalog FKs must resolve in-org; misses fall back to SKU resolution.
    const validItemIds = await resolveExplicitItemIds(req, body.lines ?? []);

    const order = await persistPurchaseOrder(req, {
      // When both are present, both persist as given (the string stays the display
      // snapshot — same precedent as customer/customer_rel).
      vendor: body.vendor ?? vendorRow?.name ?? '',
      vendorId: body.vendorId ?? null,
      status: body.status,
      jobId: body.jobId,
      customerId: body.customerId,
      customer: body.customer,
      site: body.site,
      trade: body.trade,
      orderedAt: body.orderedAt,
      expectedDate: body.expectedDate,
      source: 'manual',
      lines: (body.lines ?? []).map((line: any) => ({
        itemSku: line.itemSku,
        itemName: line.itemName,
        uom: line.uom,
        qtyOrdered: line.qtyOrdered,
        qtyReceived: line.qtyReceived,
        unitCost: line.unitCost,
        priceBookItemId: line.priceBookItemId && validItemIds.has(line.priceBookItemId) ? line.priceBookItemId : null,
      })),
    });

    res.status(201).json({ purchaseOrder: mapPurchaseOrder(order) });
  } catch (err) {
    logger.error('Failed to create purchase order:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
}

// ─── Create PO from a job (P2 item 1c, D16 entry 2) ──────────────────────────
export async function createPurchaseOrderFromJob(req: Request, res: Response) {
  try {
    const body = req.body as z.infer<typeof createPurchaseOrderFromJobSchema>;

    const job = await prisma.job.findFirst({
      where: { id: body.jobId, ...tenantWhere(req) },
      select: {
        id: true, job_number: true, status: true,
        customer: { select: { id: true, first_name: true, last_name: true, company_name: true } },
        service_location: { select: { address_line1: true, city: true, state: true } },
      },
    });
    if (!job) { res.status(400).json({ error: 'Invalid job_id' }); return; }
    // Per-instance scope (QA-804 per-user-grant path makes this non-vacuous).
    if (!(await canAccessRow(req, 'Job', prisma.job, body.jobId))) {
      res.status(403).json({ error: 'Insufficient permissions' });
      return;
    }
    // Cancel is terminal — ordering materials for a cancelled job is always a mistake.
    if (job.status === 'CANCELLED') {
      res.status(409).json({ error: 'JOB_CANCELLED', message: 'Cannot order materials for a cancelled job' });
      return;
    }

    const { error: vendorError, vendor: vendorRow } = await validateVendor(req, body.vendorId);
    if (vendorError) { res.status(400).json({ error: vendorError }); return; }

    // Resolve requested job lines in one org-scoped query; any miss → 400.
    const jobLineIds = body.lines.map((l) => l.jobLineItemId).filter((v): v is string => !!v);
    const jobLines = jobLineIds.length > 0
      ? await prisma.jobLineItem.findMany({ where: { id: { in: jobLineIds }, job_id: job.id, ...tenantWhere(req) } })
      : [];
    const jobLineMap = new Map(jobLines.map((l: any) => [l.id, l]));
    if (jobLineIds.some((id) => !jobLineMap.has(id))) {
      res.status(400).json({ error: 'Invalid job_line_item_id' });
      return;
    }

    const resolveCatalogItem = (id: string, requireActive: boolean) =>
      prisma.priceBookItem.findFirst({
        where: { id, ...tenantWhere(req), ...(requireActive ? { is_active: true } : {}) },
        select: { id: true, sku: true, name: true, uom: true, unit_cost: true },
      });

    const lines: PersistPoLine[] = [];
    for (const reqLine of body.lines) {
      if (reqLine.jobLineItemId) {
        const jl: any = jobLineMap.get(reqLine.jobLineItemId)!;
        const catalog = jl.price_book_item_id ? await resolveCatalogItem(jl.price_book_item_id, false) : null;
        if (catalog) {
          lines.push({
            itemSku: catalog.sku ?? '', itemName: catalog.name, uom: catalog.uom ?? 'EA',
            qtyOrdered: reqLine.qty, qtyReceived: 0,
            unitCost: catalog.unit_cost != null ? Number(catalog.unit_cost) : null,
            priceBookItemId: catalog.id,
          });
        } else {
          // Free-text line — no catalog identity (the item_sku:'' convention is
          // established by autoCreateReservation).
          lines.push({
            itemSku: '', itemName: jl.description, uom: 'EA',
            qtyOrdered: reqLine.qty, qtyReceived: 0,
            unitCost: jl.unit_cost != null ? Number(jl.unit_cost) : null,
            priceBookItemId: null,
          });
        }
      } else {
        // Catalog-direct mode ("order more of X") — must be an active in-org item.
        const catalog = await resolveCatalogItem(reqLine.priceBookItemId!, true);
        if (!catalog) { res.status(400).json({ error: 'Invalid price_book_item_id' }); return; }
        lines.push({
          itemSku: catalog.sku ?? '', itemName: catalog.name, uom: catalog.uom ?? 'EA',
          qtyOrdered: reqLine.qty, qtyReceived: 0,
          unitCost: catalog.unit_cost != null ? Number(catalog.unit_cost) : null,
          priceBookItemId: catalog.id,
        });
      }
    }

    const cust = job.customer;
    const customerName = [cust?.first_name, cust?.last_name].filter(Boolean).join(' ') || cust?.company_name || 'Customer';
    const site = [job.service_location?.address_line1, job.service_location?.city, job.service_location?.state]
      .filter(Boolean).join(', ');

    const order = await persistPurchaseOrder(req, {
      vendor: vendorRow?.name ?? '', // drafts may pick a vendor later
      vendorId: body.vendorId ?? null,
      status: 'draft',
      jobId: job.id,
      customerId: cust?.id ?? null,
      customer: customerName,
      site: site || null,
      expectedDate: body.expectedDate ?? null,
      source: 'job',
      lines,
    });

    res.status(201).json({ purchaseOrder: mapPurchaseOrder(order) });
  } catch (err) {
    logger.error('Failed to create purchase order from job:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
}

// ─── Low-stock PO proposals (P2 item 2, D16 entry 3, QA-612) ─────────────────
// PROPOSE, don't create: a read-only computation the FE edits before submitting
// one plain POST /purchase-orders per vendor group. No writes → no audit row.
export async function listLowStockProposals(req: Request, res: Response) {
  try {
    const { locationId } = req.query;
    if (locationId !== undefined && (typeof locationId !== 'string' || !uuidRegex.test(locationId))) {
      res.status(400).json({ error: 'locationId must be a valid UUID' });
      return;
    }
    if (locationId) {
      const loc = await prisma.inventoryLocation.findFirst({
        where: { id: locationId as string, ...tenantWhere(req) }, select: { id: true },
      });
      if (!loc) { res.status(404).json({ error: 'Stock location not found' }); return; }
    }

    const balances = await prisma.stockBalance.findMany({
      where: {
        ...tenantWhere(req),
        min: { not: null },
        ...(locationId ? { location_id: locationId as string } : {}),
        // D8 + QA-105: never propose ordering inactive/untracked SKUs.
        item: { track_inventory: true, is_active: true },
      },
      include: {
        item: { select: { id: true, sku: true, name: true, uom: true, unit_cost: true, vendor_id: true, vendor: { select: { id: true, name: true, contact_email: true } } } },
        location: { select: { id: true, name: true } },
      },
    });

    // Prisma cannot compare two columns — filter on_hand < min in JS (per-org
    // balance row counts are small). min is per-(item,location).
    const low = balances.filter((b: any) => b.min != null && Number(b.on_hand) < b.min);

    // Group by the item's vendor; the vendorId:null group is returned for a manual
    // vendor pick — proposals are NEVER auto-created into POs.
    // Non-goals (v1 is min-gap only): no dedup against open POs already covering
    // the shortfall; no max-based order-up-to logic.
    const groups = new Map<string | null, any>();
    for (const b of low as any[]) {
      const key: string | null = b.item?.vendor_id ?? null;
      if (!groups.has(key)) {
        groups.set(key, {
          vendorId: key,
          vendorName: b.item?.vendor?.name ?? null,
          vendorEmail: b.item?.vendor?.contact_email ?? null,
          lines: [],
        });
      }
      groups.get(key).lines.push({
        itemId: b.item.id,
        itemSku: b.item.sku ?? '',
        itemName: b.item.name,
        uom: b.item.uom ?? 'EA',
        locationId: b.location?.id ?? b.location_id,
        locationName: b.location?.name ?? '',
        onHand: Number(b.on_hand),
        min: b.min,
        suggestedQty: Math.ceil(b.min - Number(b.on_hand)),
        unitCost: b.item.unit_cost != null ? Number(b.item.unit_cost) : null,
      });
    }

    res.json({ proposals: [...groups.values()] });
  } catch (err) {
    logger.error('Failed to compute low-stock proposals:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
}

export async function updatePurchaseOrder(req: Request, res: Response) {
  try {
    const orgId = req.user!.organization_id;
    const existing = await prisma.purchaseOrder.findFirst({
      where: { id: req.params.id as string, ...tenantWhere(req) },
    });
    if (!existing) {
      res.status(404).json({ error: 'Purchase order not found' });
      return;
    }

    const body = req.body;

    const fkError = await validateJobAndCustomer(req, body.jobId, body.customerId);
    if (fkError) { res.status(400).json({ error: fkError }); return; }

    const { error: vendorError, vendor: vendorRow } = await validateVendor(req, body.vendorId);
    if (vendorError) { res.status(400).json({ error: vendorError }); return; }

    // po_number is immutable and server-owned (P0 §A) — deliberately no mapping.
    const data: any = {};
    if (body.vendor !== undefined) data.vendor = body.vendor;
    if (body.vendorId !== undefined) {
      data.vendor_id = body.vendorId ?? null;
      // A non-null vendorId without an explicit display string refreshes it from the row.
      if (body.vendorId && body.vendor === undefined && vendorRow) data.vendor = vendorRow.name;
    }
    if (body.status !== undefined) data.status = body.status;
    if (body.jobId !== undefined) data.job_id = body.jobId ?? null;
    if (body.customerId !== undefined) data.customer_id = body.customerId ?? null;
    if (body.customer !== undefined) data.customer = body.customer;
    if (body.site !== undefined) data.site = body.site;
    if (body.trade !== undefined) data.trade = body.trade;
    if (body.orderedAt !== undefined) data.ordered_at = new Date(body.orderedAt);
    if (body.expectedDate !== undefined) data.expected_date = body.expectedDate ? new Date(body.expectedDate) : null;

    // Lines are replace-all when provided (mirrors the dialog's full-form submit).
    if (body.lines !== undefined) {
      await prisma.purchaseOrderLine.deleteMany({
        where: { purchase_order_id: existing.id, ...tenantWhere(req) },
      });
      const skuMap = await resolveSkuMap(req, body.lines.map((l: any) => l.itemSku));
      const validItemIds = await resolveExplicitItemIds(req, body.lines);
      data.lines = {
        create: body.lines.map((line: any) => ({
          item_sku: line.itemSku,
          item_name: line.itemName,
          uom: line.uom,
          qty_ordered: line.qtyOrdered,
          qty_received: line.qtyReceived ?? 0,
          unit_cost: line.unitCost ?? null,
          price_book_item_id: (line.priceBookItemId && validItemIds.has(line.priceBookItemId) ? line.priceBookItemId : null)
            ?? skuMap.get(line.itemSku) ?? null,
          organization_id: orgId,
        })),
      };
    }

    const order = await prisma.purchaseOrder.update({
      where: { id: existing.id },
      data,
      include: {
        lines: { orderBy: { created_at: 'asc' } },
        job: { select: { job_number: true } },
        customer_rel: { select: { id: true, first_name: true, last_name: true, company_name: true } },
      },
    });

    // F3: surface a received PO on the linked job's central timeline.
    if (existing.job_id && body.status === 'received') {
      await prisma.timelineEvent.create({
        data: {
          organization_id: orgId,
          entity_type: 'JOB', entity_id: existing.job_id,
          event_type: 'PO_RECEIVED',
          description: `Purchase order received: ${order.po_number}`,
          metadata: { purchase_order_id: existing.id },
          created_by: req.user!.id,
        },
      });
    }

    void logAudit({
      req,
      action: 'inventory.po_updated',
      resourceType: 'PurchaseOrder',
      resourceId: existing.id,
      metadata: { fields: Object.keys(req.body), ...(body.status ? { status: body.status } : {}) },
    });

    res.json({ purchaseOrder: mapPurchaseOrder(order) });
  } catch (err) {
    logger.error('Failed to update purchase order:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
}

// ─── PO Receipt (B2/V5) — stock side-effects ONLY (DEC2: no billing) ────────

export const receivePurchaseOrderSchema = z.object({
  poId: z.string().uuid(),
  // D14: optional receive-destination picker; absent → the DEC3 org default.
  destinationLocationId: z.string().uuid().optional(),
  // Identify by the PO line's own id — SKU is a non-unique, sometimes-blank label (D2).
  lines: z.array(z.object({
    lineId: z.string().uuid(),
    qtyReceived: z.number().min(0),
  })).min(1),
});

// PO status from line fill — shared by the PO receive path AND the staging
// write-through (P2 4e) so the status math cannot drift.
export async function recomputePoStatus(tx: Prisma.TransactionClient, poId: string, currentStatus: string): Promise<string> {
  const lines = await tx.purchaseOrderLine.findMany({ where: { purchase_order_id: poId } });
  const allReceived = lines.every((l) => Number(l.qty_received) >= Number(l.qty_ordered));
  const anyReceived = lines.some((l) => Number(l.qty_received) > 0);
  const status = allReceived ? 'received' : anyReceived ? 'partial' : currentStatus;
  await tx.purchaseOrder.update({ where: { id: poId }, data: { status } });
  return status;
}

export async function receivePurchaseOrder(req: Request, res: Response) {
  try {
    const orgId = req.user!.organization_id;
    const body = req.body as z.infer<typeof receivePurchaseOrderSchema>;

    const po = await prisma.purchaseOrder.findFirst({
      where: { id: body.poId, ...tenantWhere(req) },
      include: { lines: true },
    });
    if (!po) { res.status(404).json({ error: 'Purchase order not found' }); return; }

    // 4a (QA-606): per-line over-receive guard — validate ALL lines before any
    // write, so a 400 leaves zero partial application. qtyReceived is an absolute
    // total (dialog semantics): the invariant is 0 ≤ qtyReceived ≤ qty_ordered.
    // Downward corrections remain signed adjust movements below — never bypassed.
    for (const recv of body.lines) {
      const poLine = po.lines.find((l) => l.id === recv.lineId);
      if (!poLine) continue; // unchanged tolerance: unknown line ids are skipped
      if (recv.qtyReceived > Number(poLine.qty_ordered)) {
        res.status(400).json({
          error: 'OVER_RECEIVE',
          item_sku: poLine.item_sku,
          qty_ordered: Number(poLine.qty_ordered),
          qty_received: recv.qtyReceived,
        });
        return;
      }
    }

    // 4d (D14/§3.6/QA-611): single-receive-path — lines staged to a JobStage must
    // be received via the Staging view (which write-throughs to the PO line).
    // Per-line so a backfilled/legacy partially-staged PO can still receive its
    // unstaged lines here.
    if (po.staged_as_job_stage_id) {
      const stagedSkus = new Set((await prisma.jobStageLine.findMany({
        where: { purchase_order_id: po.id, ...tenantWhere(req) },
        select: { item_sku: true },
      })).map((l) => l.item_sku).filter((s) => s !== ''));
      // Derive each received line's SKU from the matched PO line; the blank sentinel
      // never matches (a free-text line cannot be SKU-staged).
      const offending = body.lines
        .map((recv) => po.lines.find((l) => l.id === recv.lineId))
        .filter((l): l is NonNullable<typeof l> => !!l && l.item_sku !== '' && stagedSkus.has(l.item_sku))
        .map((l) => l.item_sku);
      if (offending.length > 0) {
        res.status(409).json({ error: 'STAGED_PO', message: 'Receive staged lines via the Staging view', staged_skus: offending });
        return;
      }
    }

    const actor = `${req.user!.first_name ?? ''} ${req.user!.last_name ?? ''}`.trim() || 'Unknown';

    // 4b (D14): explicit org-validated destination for every movement in this
    // call; absent → the DEC3 org default (a default, not a rule).
    let destinationId: string | null;
    if (body.destinationLocationId) {
      const loc = await prisma.inventoryLocation.findFirst({
        where: { id: body.destinationLocationId, ...tenantWhere(req) }, select: { id: true },
      });
      if (!loc) { res.status(404).json({ error: 'Stock location not found' }); return; }
      destinationId = loc.id;
    } else {
      destinationId = await resolveReceiveLocationId(req);
    }

    const updated = await prisma.$transaction(async (tx) => {
      for (const recv of body.lines) {
        const poLine = po.lines.find((l) => l.id === recv.lineId);
        if (!poLine) continue;
        // The dialog submits absolute totals; compute the delta against the stored qty_received.
        const prevReceived = Number(poLine.qty_received);
        const delta = recv.qtyReceived - prevReceived;
        await tx.purchaseOrderLine.update({
          where: { id: poLine.id },
          data: { qty_received: recv.qtyReceived },
        });
        if (delta !== 0) {
          await applyStockMovement(tx, {
            orgId, type: delta > 0 ? 'receive' : 'adjust',
            itemSku: poLine.item_sku, itemName: poLine.item_name,
            // Signed: a downward correction (delta < 0) must SUBTRACT from the balance;
            // the ledger records adjust rows with negative qty (seed convention).
            // Identity is the stored FK — free-text (null) → ledger only, no balance (D2).
            qty: delta, itemId: poLine.price_book_item_id ?? null,
            jobId: po.job_id ?? null,
            unitCost: poLine.unit_cost != null ? Number(poLine.unit_cost) : null,
            actorUserId: req.user!.id,
            toLocationId: destinationId,
            reference: po.po_number, actor,
          });
        }
        // DEC2: NO billing. Material cost is the read-side roll-up (Task 6) — never a JobCharge.
      }
      await recomputePoStatus(tx, po.id, po.status);

      return tx.purchaseOrder.findFirst({
        where: { id: po.id },
        include: { lines: { orderBy: { created_at: 'asc' } }, job: { select: { job_number: true } } },
      });
    });

    // inventory.po_partial — fire only when status resolves to 'partial'; fire-and-forget.
    if ((updated as any)?.status === 'partial') {
      emitPoPartial(orgId, req.user!.id, po.id, po.po_number);
    }

    void logAudit({
      req,
      action: 'inventory.po_received',
      resourceType: 'PurchaseOrder',
      resourceId: po.id,
      metadata: { po_number: po.po_number, status: (updated as any)?.status, lines_received: body.lines.length },
    });

    res.json({ purchaseOrder: mapPurchaseOrder(updated) });
  } catch (err) {
    logger.error('Failed to receive purchase order:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
}

// ─── Real PO send (P2 item 6, §3.8, QA-908) ──────────────────────────────────
// Mirrors the ESTIMATE send pattern: resolve recipient → AWAIT the dispatch →
// only commit state once the email actually left → map failures 409/502.
// (NOT the invoice send's fire-and-forget shape — QA-908 requires the status to
// flip only when the email delivers.)

export const sendPurchaseOrderSchema = z.object({
  // Frontend contract (POEmailDialog): multiple To recipients + editable subject/message.
  to: z.array(z.string().email()).min(1).optional(),   // omitted → default to the vendor contact email
  cc: z.array(z.string().email()).max(5).optional(),
  subject: z.string().max(200).optional(),
  message: z.string().max(2000).optional(),
});

// PO wording of the estimate controller's mapEmailFailure: org_disabled is a
// deliberate admin kill-switch (409), everything else is upstream/infra (502).
// In every case the PO is LEFT unchanged.
function mapPoEmailFailure(
  result: Exclude<EmailDispatchResult, { status: 'sent' }>,
): { code: number; message: string } {
  // Code from the shared classifier so this and the stage-pickup sender cannot
  // disagree about whether an org-disabled skip is a 409 or a 502; wording local.
  const code = dispatchFailureStatus(result);
  if (result.status === 'skipped' && result.reason === 'org_disabled') {
    return { code, message: 'Email sending is disabled for your organization. The purchase order was not sent.' };
  }
  if (result.status === 'skipped') { // no_api_key
    return { code, message: 'Email is not configured, so the purchase order was not sent.' };
  }
  return { code, message: 'The purchase order could not be emailed to the vendor, so it was not sent. Please try again.' };
}

export async function sendPurchaseOrder(req: Request, res: Response) {
  try {
    const id = req.params.id as string;
    const orgId = req.user!.organization_id;
    const body = req.body as z.infer<typeof sendPurchaseOrderSchema>;

    const po = await prisma.purchaseOrder.findFirst({
      where: { id, ...tenantWhere(req) },
      include: {
        lines: { orderBy: { created_at: 'asc' } },
        vendor_rel: { select: { name: true, contact_email: true } },
        job: { select: { id: true, job_number: true } },
      },
    });
    if (!po) { res.status(404).json({ error: 'Purchase order not found' }); return; }

    // partial/received/closed are past the point of transmitting an order.
    if (!['draft', 'sent'].includes(po.status)) {
      res.status(400).json({ error: 'Only draft or sent purchase orders can be sent' });
      return;
    }

    const recipients: string[] = (body.to && body.to.length > 0)
      ? body.to
      : (po.vendor_rel?.contact_email ? [po.vendor_rel.contact_email] : []);
    if (recipients.length === 0) {
      res.status(422).json({ error: 'No email address on file for this vendor. Add a vendor contact email or provide one.' });
      return;
    }

    const org = await prisma.organization.findUnique({ where: { id: orgId } });
    if (!org) {
      res.status(500).json({ error: 'Organization not configured.' });
      return;
    }

    const emailLines: PurchaseOrderEmailLine[] = po.lines.map((l: any) => ({
      sku: l.item_sku,
      name: l.item_name,
      uom: l.uom,
      qtyOrdered: Number(l.qty_ordered),
      unitCost: l.unit_cost != null ? Number(l.unit_cost) : null,
    }));
    const costed = emailLines.filter((l) => l.unitCost != null);
    const total = costed.length > 0
      ? Math.round(costed.reduce((sum, l) => sum + l.qtyOrdered * (l.unitCost as number), 0) * 100) / 100
      : null;

    // ── AWAIT the dispatch: no state is committed unless the email went out. ──
    const emailResult = await sendPurchaseOrderEmail({
      organizationId: orgId,
      org: { id: org.id, name: org.name, logo_url: org.logo_url, brand_color: org.brand_color },
      to: recipients,
      cc: body.cc,
      subject: body.subject,
      message: body.message,
      poNumber: po.po_number,
      vendorName: po.vendor_rel?.name || po.vendor || 'Vendor',
      lines: emailLines,
      total,
      currency: org.currency,
      jobNumber: po.job?.job_number ?? null,
      // Evidence the vendor was actually sent the order. The InventoryEmail row
      // written below is inventory's own ledger; this is the Communication
      // history, and it is what a vendor's message list reads.
      record: {
        organizationId: orgId,
        vendorId: po.vendor_id,
        jobId: po.job_id,
        jobLabel: po.job?.job_number ?? null,
      },
    });

    if (emailResult.status !== 'sent') {
      const { code, message } = mapPoEmailFailure(emailResult);
      res.status(code).json({ error: message });
      return;
    }

    // ── COMMIT: status flip (first send only) + InventoryEmail + timeline. ──
    await prisma.$transaction(async (tx) => {
      if (po.status === 'draft') {
        // Resend keeps 'sent'; partial+ is excluded by the status guard above.
        await tx.purchaseOrder.update({ where: { id: po.id }, data: { status: 'sent' } });
      }
      await tx.inventoryEmail.create({
        data: {
          purchase_order_id: po.id,
          direction: 'out',
          kind: 'po',
          // The address the mail ACTUALLY left from, taken off the dispatch
          // result. This recorded env.EMAIL_FROM - the root domain reserved for
          // auth-critical mail that bypasses dispatchEmail entirely - while the
          // PO itself went out from EMAIL_FROM_BUSINESS. Same drift as the Email
          // mirror had, on inventory's own ledger, breaking the same contract:
          // the persisted record must be precisely what went out.
          from: emailResult.fromAddress,
          to: [...recipients, ...(body.cc ?? [])],
          subject: emailResult.subject,
          body: emailResult.html,
          sent_at: new Date(),
          organization_id: orgId,
        },
      });
      // F3: surface the send on the linked job's central timeline.
      if (po.job_id) {
        await tx.timelineEvent.create({
          data: {
            organization_id: orgId,
            entity_type: 'JOB', entity_id: po.job_id,
            event_type: 'PO_SENT',
            description: `Purchase order sent: ${po.po_number}`,
            metadata: { purchase_order_id: po.id },
            created_by: req.user!.id,
          },
        });
      }
    });

    void logAudit({
      req,
      action: 'inventory.po_sent',
      resourceType: 'PurchaseOrder',
      resourceId: po.id,
      metadata: { po_number: po.po_number, to: recipients.join(', '), cc_count: body.cc?.length ?? 0 },
    });

    const fresh = await prisma.purchaseOrder.findFirst({
      where: { id: po.id, ...tenantWhere(req) },
      include: {
        lines: { orderBy: { created_at: 'asc' } },
        job: { select: { job_number: true } },
        customer_rel: { select: { id: true, first_name: true, last_name: true, company_name: true } },
        emails: { orderBy: { sent_at: 'asc' } },
      },
    });

    res.json({ purchaseOrder: mapPurchaseOrder(fresh) });
  } catch (err) {
    logger.error('Failed to send purchase order:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
}

// ─── RFQ Handlers ───────────────────────────────────────

export async function listRfqs(req: Request, res: Response) {
  try {
    const rfqs = await prisma.rfq.findMany({
      where: tenantWhere(req),
      orderBy: { requested_at: 'desc' },
      include: {
        lines: { orderBy: { created_at: 'asc' } },
        quotes: { orderBy: { created_at: 'asc' } },
        emails: { orderBy: { sent_at: 'asc' } },
        customer_rel: { select: { id: true, first_name: true, last_name: true, company_name: true } },
      },
    });

    res.json({ rfqs: rfqs.map(mapRfq) });
  } catch (err) {
    logger.error('Failed to list RFQs:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
}

export async function getRfq(req: Request, res: Response) {
  try {
    const rfq = await prisma.rfq.findFirst({
      where: { id: req.params.id as string, ...tenantWhere(req) },
      include: {
        lines: { orderBy: { created_at: 'asc' } },
        quotes: { orderBy: { created_at: 'asc' } },
        emails: { orderBy: { sent_at: 'asc' } },
        customer_rel: { select: { id: true, first_name: true, last_name: true, company_name: true } },
      },
    });

    if (!rfq) {
      res.status(404).json({ error: 'RFQ not found' });
      return;
    }

    res.json({ rfq: mapRfq(rfq) });
  } catch (err) {
    logger.error('Failed to get RFQ:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
}

export async function createRfq(req: Request, res: Response) {
  try {
    const orgId = req.user!.organization_id;
    const body = req.body;

    const fkError = await validateJobAndCustomer(req, body.jobId, body.customerId);
    if (fkError) { res.status(400).json({ error: fkError }); return; }

    const skuMap = await resolveSkuMap(req, (body.lines ?? []).map((l: any) => l.itemSku));

    const rfq = await prisma.rfq.create({
      data: {
        rfq_number: body.rfqNumber,
        job_id: body.jobId ?? null,
        customer_id: body.customerId ?? null,
        job_number: body.jobNumber ?? null,
        customer: body.customer ?? null,
        site: body.site ?? null,
        trade: body.trade ?? null,
        requested_at: body.requestedAt ? new Date(body.requestedAt) : new Date(),
        responses_due_by: new Date(body.responsesDueBy),
        lines_summary: body.linesSummary,
        status: body.status ?? 'awaiting_quotes',
        organization_id: orgId,
        lines: {
          create: (body.lines ?? []).map((line: any) => ({
            item_sku: line.itemSku,
            item_name: line.itemName,
            qty: line.qty,
            uom: line.uom,
            price_book_item_id: skuMap.get(line.itemSku) ?? null,
            organization_id: orgId,
          })),
        },
        quotes: {
          create: (body.quotes ?? []).map((quote: any) => ({
            vendor: quote.vendor,
            total: quote.total,
            lead_time_days: quote.leadTimeDays,
            recommended: quote.recommended ?? false,
            organization_id: orgId,
          })),
        },
      },
      include: {
        lines: { orderBy: { created_at: 'asc' } },
        quotes: { orderBy: { created_at: 'asc' } },
        emails: { orderBy: { sent_at: 'asc' } },
        customer_rel: { select: { id: true, first_name: true, last_name: true, company_name: true } },
      },
    });

    res.status(201).json({ rfq: mapRfq(rfq) });
  } catch (err) {
    logger.error('Failed to create RFQ:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
}

export async function updateRfq(req: Request, res: Response) {
  try {
    const orgId = req.user!.organization_id;
    const existing = await prisma.rfq.findFirst({
      where: { id: req.params.id as string, ...tenantWhere(req) },
    });
    if (!existing) {
      res.status(404).json({ error: 'RFQ not found' });
      return;
    }

    const body = req.body;

    const fkError = await validateJobAndCustomer(req, body.jobId, body.customerId);
    if (fkError) { res.status(400).json({ error: fkError }); return; }

    const data: any = {};
    if (body.rfqNumber !== undefined) data.rfq_number = body.rfqNumber;
    if (body.jobId !== undefined) data.job_id = body.jobId ?? null;
    if (body.customerId !== undefined) data.customer_id = body.customerId ?? null;
    if (body.jobNumber !== undefined) data.job_number = body.jobNumber;
    if (body.customer !== undefined) data.customer = body.customer;
    if (body.site !== undefined) data.site = body.site;
    if (body.trade !== undefined) data.trade = body.trade;
    if (body.requestedAt !== undefined) data.requested_at = new Date(body.requestedAt);
    if (body.responsesDueBy !== undefined) data.responses_due_by = new Date(body.responsesDueBy);
    if (body.linesSummary !== undefined) data.lines_summary = body.linesSummary;
    if (body.status !== undefined) data.status = body.status;

    if (body.lines !== undefined) {
      await prisma.rfqLine.deleteMany({ where: { rfq_id: existing.id, ...tenantWhere(req) } });
      const skuMap = await resolveSkuMap(req, body.lines.map((l: any) => l.itemSku));
      data.lines = {
        create: body.lines.map((line: any) => ({
          item_sku: line.itemSku,
          item_name: line.itemName,
          qty: line.qty,
          uom: line.uom,
          price_book_item_id: skuMap.get(line.itemSku) ?? null,
          organization_id: orgId,
        })),
      };
    }

    if (body.quotes !== undefined) {
      await prisma.rfqQuote.deleteMany({ where: { rfq_id: existing.id, ...tenantWhere(req) } });
      data.quotes = {
        create: body.quotes.map((quote: any) => ({
          vendor: quote.vendor,
          total: quote.total,
          lead_time_days: quote.leadTimeDays,
          recommended: quote.recommended ?? false,
          organization_id: orgId,
        })),
      };
    }

    const rfq = await prisma.rfq.update({
      where: { id: existing.id },
      data,
      include: {
        lines: { orderBy: { created_at: 'asc' } },
        quotes: { orderBy: { created_at: 'asc' } },
        emails: { orderBy: { sent_at: 'asc' } },
        customer_rel: { select: { id: true, first_name: true, last_name: true, company_name: true } },
      },
    });

    res.json({ rfq: mapRfq(rfq) });
  } catch (err) {
    logger.error('Failed to update RFQ:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
}

// ─── Estimate Reservation Handlers ──────────────────────

// A-12 list enrichment: the queue row shows estimate/lead status for the human
// call plus the converted-PO back-reference. Shared by list/get/convert/dismiss.
const RESERVATION_INCLUDE = {
  lines: { orderBy: { created_at: 'asc' as const } },
  emails: { orderBy: { sent_at: 'asc' as const } },
  estimate: { select: { status: true, lead: { select: { status: true } } } },
  converted_purchase_order: { select: { id: true, po_number: true } },
};

const RESERVATION_STATUSES = ['open', 'converted', 'dismissed'] as const;

export async function listEstimateReservations(req: Request, res: Response) {
  try {
    const { status } = req.query;
    if (status !== undefined && (typeof status !== 'string' || !RESERVATION_STATUSES.includes(status as any))) {
      res.status(400).json({ error: 'status must be one of open|converted|dismissed' });
      return;
    }

    const reservations = await prisma.estimateReservation.findMany({
      where: { ...tenantWhere(req), ...(status ? { status: status as string } : {}) },
      orderBy: { approved_at: 'desc' },
      include: RESERVATION_INCLUDE,
    });

    res.json({ estimateReservations: reservations.map(mapEstimateReservation) });
  } catch (err) {
    logger.error('Failed to list estimate reservations:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
}

export async function getEstimateReservation(req: Request, res: Response) {
  try {
    const reservation = await prisma.estimateReservation.findFirst({
      where: { id: req.params.id as string, ...tenantWhere(req) },
      include: RESERVATION_INCLUDE,
    });

    if (!reservation) {
      res.status(404).json({ error: 'Estimate reservation not found' });
      return;
    }

    res.json({ estimateReservation: mapEstimateReservation(reservation) });
  } catch (err) {
    logger.error('Failed to get estimate reservation:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
}

// ─── Reservation lifecycle verbs (P2 item 3, D3 hardening) ───────────────────

class ReservationNotOpenError extends Error {
  constructor(public reservationStatus: string) {
    super('RESERVATION_NOT_OPEN');
  }
}

// POST /estimate-reservations/:id/convert — server-side conversion: the status
// flip, PO create, and converted_purchase_order_id linkage commit in ONE tx
// (fixes the FE-only convert that lost the linkage, and its vendor-less 400).
export async function convertEstimateReservation(req: Request, res: Response) {
  try {
    const id = req.params.id as string;
    const orgId = req.user!.organization_id;
    const body = req.body as z.infer<typeof convertReservationSchema>;

    const reservation = await prisma.estimateReservation.findFirst({
      where: { id, ...tenantWhere(req) },
      include: { lines: { orderBy: { created_at: 'asc' } } },
    });
    if (!reservation) { res.status(404).json({ error: 'Estimate reservation not found' }); return; }

    const { error: vendorError, vendor: vendorRow } = await validateVendor(req, body.vendorId);
    if (vendorError) { res.status(400).json({ error: vendorError }); return; }

    const order = await prisma.$transaction(async (tx) => {
      // Atomic claim (decideStockApproval TOCTOU pattern): only an 'open' row
      // converts; converted/dismissed rows never reopen.
      const claimed = await tx.estimateReservation.updateMany({
        where: { id, status: 'open', ...tenantWhere(req) },
        data: { status: 'converted' },
      });
      if (claimed.count === 0) {
        const current = await tx.estimateReservation.findFirst({
          where: { id, ...tenantWhere(req) }, select: { status: true },
        });
        throw new ReservationNotOpenError(current?.status ?? reservation.status);
      }

      // Catalog unit_cost snapshot for lines whose FK resolves.
      const itemMap = await resolveItemsById(
        tx, orgId,
        reservation.lines.map((l: any) => l.price_book_item_id).filter((v: any): v is string => !!v),
      );

      const po = await persistPurchaseOrder(req, {
        // The server convert accepts a vendor-less draft (preferredVendor ?? '').
        vendor: vendorRow?.name ?? reservation.preferred_vendor ?? '',
        vendorId: body.vendorId ?? null,
        status: 'draft',
        jobId: reservation.job_id,
        customerId: reservation.customer_id,
        customer: reservation.customer,
        site: reservation.site,
        trade: reservation.trade,
        expectedDate: body.expectedDate ?? null,
        source: 'reservation',
        lines: reservation.lines.map((l: any) => ({
          // Legacy reservations snapshot a blank item_sku (estimate lines carry no SKU
          // column; fixed at reservation creation) — backstop from the catalog here so
          // converted POs stay receivable (the receive contract is SKU-keyed).
          itemSku: l.item_sku || (l.price_book_item_id ? (itemMap.get(l.price_book_item_id)?.sku ?? '') : ''),
          itemName: l.item_name,
          uom: l.uom,
          qtyOrdered: Number(l.qty),
          qtyReceived: 0,
          unitCost: l.price_book_item_id ? (itemMap.get(l.price_book_item_id)?.unitCost ?? null) : null,
          priceBookItemId: l.price_book_item_id ?? null,
        })),
      }, tx);

      await tx.estimateReservation.update({
        where: { id },
        data: { converted_purchase_order_id: po.id },
      });

      return po;
    });

    void logAudit({
      req,
      action: 'inventory.reservation_converted',
      resourceType: 'EstimateReservation',
      resourceId: id,
      metadata: { purchase_order_id: order.id, po_number: order.po_number },
    });

    const fresh = await prisma.estimateReservation.findFirst({
      where: { id, ...tenantWhere(req) },
      include: RESERVATION_INCLUDE,
    });

    res.status(201).json({
      purchaseOrder: mapPurchaseOrder(order),
      estimateReservation: fresh ? mapEstimateReservation(fresh) : null,
    });
  } catch (err) {
    if (err instanceof ReservationNotOpenError) {
      res.status(409).json({ error: 'RESERVATION_NOT_OPEN', status: err.reservationStatus });
      return;
    }
    logger.error('Failed to convert estimate reservation:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
}

// POST /estimate-reservations/:id/dismiss — manual terminal transition (QA-602).
// Actor + timestamp live in the AuditLog row + updated_at (no new columns).
export async function dismissEstimateReservation(req: Request, res: Response) {
  try {
    const id = req.params.id as string;
    const body = req.body as z.infer<typeof dismissReservationSchema>;

    const reservation = await prisma.estimateReservation.findFirst({
      where: { id, ...tenantWhere(req) }, select: { id: true, status: true },
    });
    if (!reservation) { res.status(404).json({ error: 'Estimate reservation not found' }); return; }

    const dismissed = await prisma.estimateReservation.updateMany({
      where: { id, status: 'open', ...tenantWhere(req) },
      data: { status: 'dismissed' },
    });
    if (dismissed.count === 0) {
      res.status(409).json({ error: 'RESERVATION_NOT_OPEN', status: reservation.status });
      return;
    }

    void logAudit({
      req,
      action: 'inventory.reservation_dismissed',
      resourceType: 'EstimateReservation',
      resourceId: id,
      metadata: { reason: body.reason ?? null },
    });

    const fresh = await prisma.estimateReservation.findFirst({
      where: { id, ...tenantWhere(req) },
      include: RESERVATION_INCLUDE,
    });

    res.json({ estimateReservation: fresh ? mapEstimateReservation(fresh) : null });
  } catch (err) {
    logger.error('Failed to dismiss estimate reservation:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
}

// ─── Manual EstimateReservation create (V2/B2) ──────────────────────────────
// Estimate approval auto-creates a reservation (Task 8); this is the explicit
// manual create for the Pre-PO tab. Org-validates estimate_id (when supplied)
// plus the shared job_id/customer_id guard, then resolves each line's SKU to a
// catalog PriceBookItem (V6/D5). All NOT-NULL columns are required by Zod.
export const createReservationSchema = z.object({
  estimateId: z.string().uuid().nullable().optional(),
  estimateNumber: z.string().min(1).max(50),
  jobId: z.string().uuid().nullable().optional(),
  customerId: z.string().uuid().nullable().optional(),
  customer: z.string().min(1).max(200),
  customerEmail: z.string().email().nullable().optional(),
  site: z.string().max(500).nullable().optional(),
  trade: tradeEnum.nullable().optional(),
  approvedAt: z.string().datetime(),
  reservedTotal: z.number().min(0),
  linesSummary: z.object({ items: z.number().int().min(0), units: z.number().min(0) }),
  preferredVendor: z.string().max(200).nullable().optional(),
  lines: z.array(rfqLineSchema).min(0),
});

export async function createEstimateReservation(req: Request, res: Response) {
  try {
    const orgId = req.user!.organization_id;
    const body = req.body as z.infer<typeof createReservationSchema>;
    if (body.estimateId) {
      const est = await prisma.estimate.findFirst({ where: { id: body.estimateId, ...tenantWhere(req) }, select: { id: true } });
      if (!est) { res.status(400).json({ error: 'Invalid estimate_id' }); return; }
    }
    const fkError = await validateJobAndCustomer(req, body.jobId, body.customerId);
    if (fkError) { res.status(400).json({ error: fkError }); return; }

    const skuMap = await resolveSkuMap(req, body.lines.map((l) => l.itemSku));
    const reservation = await prisma.estimateReservation.create({
      data: {
        estimate_id: body.estimateId ?? null,
        estimate_number: body.estimateNumber,
        job_id: body.jobId ?? null,
        customer_id: body.customerId ?? null,
        customer: body.customer,
        customer_email: body.customerEmail ?? null,
        site: body.site ?? null,
        trade: body.trade ?? null,
        approved_at: new Date(body.approvedAt),
        reserved_total: body.reservedTotal,
        lines_summary: body.linesSummary,
        preferred_vendor: body.preferredVendor ?? null,
        organization_id: orgId,
        lines: {
          create: body.lines.map((l) => ({
            item_sku: l.itemSku, item_name: l.itemName, qty: l.qty, uom: l.uom,
            price_book_item_id: skuMap.get(l.itemSku) ?? null, organization_id: orgId,
          })),
        },
      },
      include: { lines: { orderBy: { created_at: 'asc' } }, emails: { orderBy: { sent_at: 'asc' } } },
    });

    void logAudit({
      req,
      action: 'inventory.reservation_created',
      resourceType: 'EstimateReservation',
      resourceId: reservation.id,
      metadata: { estimate_number: body.estimateNumber, line_count: body.lines.length },
    });

    res.status(201).json({ estimateReservation: mapEstimateReservation(reservation) });
  } catch (err) {
    logger.error('Failed to create estimate reservation:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
}

// ─── Job material-cost roll-up (V1 re-scoped, DEC2) — read-side, ZERO billing ─
// material_cost = Σ over the job's PO lines + stage lines of
//   qty_received × (line.unit_cost ?? PriceBookItem.unit_cost via the D5 FK).
// StockMovement carries no cost/job_id and JobCharge is billing-only, so neither
// is the source: the roll-up walks the PO/JobStage→Job FK (Task 2). It NEVER
// touches the Invoice — customer billing stays explicit (line items / JobCharge).
export async function getJobMaterialCost(req: Request, res: Response) {
  try {
    const jobId = req.params.jobId as string;
    // Org-scope: the job must belong to the requesting org.
    const job = await prisma.job.findFirst({ where: { id: jobId, ...tenantWhere(req) }, select: { id: true } });
    if (!job) { res.status(404).json({ error: 'Job not found' }); return; }

    // PO lines linked to this job (via PurchaseOrder.job_id), and JobStage lines linked
    // via JobStage.job_id. Pull the line cost + catalog fallback cost in one query each.
    //
    // P2 dedup (§3.6, per line, PO side wins): a stage line WITH purchase_order_id is
    // the same physical order as its PO line (the 4e write-through keeps the PO line's
    // qty_received authoritative) — excluding it here counts each order exactly once.
    // Manual stage lines (purchase_order_id IS NULL) exist nowhere else and keep
    // counting; PO lines always count, which also covers partially-staged POs.
    // Legacy stage lines the backfill couldn't link (no po_number match) can still
    // double-count only if both sides were historically received; the staged-PO 409
    // guard prevents new occurrences — no further heuristic.
    const [poLines, stageLines] = await Promise.all([
      prisma.purchaseOrderLine.findMany({
        where: { purchase_order: { job_id: jobId, ...tenantWhere(req) } },
        select: { qty_received: true, unit_cost: true, price_book_item: { select: { unit_cost: true } } },
      }),
      prisma.jobStageLine.findMany({
        where: { job_stage: { job_id: jobId, ...tenantWhere(req) }, purchase_order_id: null },
        select: { qty_received: true, unit_cost: true, price_book_item: { select: { unit_cost: true } } },
      }),
    ]);

    const costOf = (line: any): number => {
      const unit = line.unit_cost != null ? Number(line.unit_cost)
        : (line.price_book_item?.unit_cost != null ? Number(line.price_book_item.unit_cost) : 0);
      return Number(line.qty_received) * unit;
    };
    const allLines = [...poLines, ...stageLines];
    const materialCost = Math.round(allLines.reduce((sum, l) => sum + costOf(l), 0) * 100) / 100;

    res.json({ jobId, materialCost, lineCount: allLines.length });
  } catch (err) {
    logger.error('Failed to compute job material cost:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
}
