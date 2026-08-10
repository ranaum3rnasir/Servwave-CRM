import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';
import app from '../app';
import { prisma } from '../lib/prisma';
import { logAudit } from '../lib/audit';
import { mockAuthAs, authHeader, ALPHA_ORG_ID, CUSTOMER_FIXTURE, ESTIMATE_SENT_FIXTURE, PURCHASE_ORDER_FIXTURE, PRICE_BOOK_ITEM_FIXTURE } from './helpers';
import { clearPermissionCache } from '../lib/permissions/permissionCache';

// D3 hardening / A-12 / QA-601/602: reservation conversion is SERVER-side (status flip +
// converted_purchase_order_id linkage in the same tx as the PO create), dismiss is an
// atomic terminal transition, and the list carries estimate/lead status for the human call.

vi.mock('../lib/audit', () => ({
  logAudit: vi.fn().mockResolvedValue(undefined),
  writeSettingsAudit: vi.fn().mockResolvedValue(undefined),
  getClientIp: vi.fn().mockReturnValue('127.0.0.1'),
}));

const mockPrisma = prisma as unknown as {
  estimateReservation: {
    findMany: ReturnType<typeof vi.fn>; findFirst: ReturnType<typeof vi.fn>;
    update: ReturnType<typeof vi.fn>; updateMany: ReturnType<typeof vi.fn>;
  };
  purchaseOrder: { create: ReturnType<typeof vi.fn> };
  priceBookItem: { findMany: ReturnType<typeof vi.fn> };
  vendor: { findFirst: ReturnType<typeof vi.fn> };
  $transaction: ReturnType<typeof vi.fn>;
};

const RES_ID = 'ee000000-0000-0000-0000-000000000001';
const VENDOR_ID = 'e2000000-0000-0000-0000-000000000001';

const OPEN_RESERVATION = {
  id: RES_ID,
  estimate_id: ESTIMATE_SENT_FIXTURE.id,
  estimate_number: 'E00002',
  job_id: null,
  job_number: null,
  customer_id: CUSTOMER_FIXTURE.id,
  customer: 'John Doe',
  customer_email: null,
  site: '123 Main St',
  trade: 'locksmith',
  approved_at: new Date('2026-03-01'),
  reserved_total: 80,
  lines_summary: { items: 1, units: 2 },
  preferred_vendor: null,
  status: 'open',
  converted_purchase_order_id: null,
  organization_id: ALPHA_ORG_ID,
  lines: [
    { id: 'ee000001-0000-0000-0000-000000000001', item_sku: 'LOCK-100', item_name: 'Deadbolt', qty: 2, uom: 'EA', price_book_item_id: PRICE_BOOK_ITEM_FIXTURE.id, created_at: new Date('2026-03-01') },
  ],
  emails: [],
};

beforeEach(() => {
  vi.clearAllMocks();
  clearPermissionCache();
  mockPrisma.$transaction.mockImplementation(async (fn: any) => fn(mockPrisma));
  mockPrisma.priceBookItem.findMany.mockResolvedValue([
    { id: PRICE_BOOK_ITEM_FIXTURE.id, sku: 'LOCK-100', name: 'Deadbolt Lock', unit_cost: 20 },
  ]);
});

describe('POST /api/inventory/estimate-reservations/:id/convert (QA-601)', () => {
  it('claims the open reservation atomically, creates the PO, and links the FK in the same tx', async () => {
    mockAuthAs('admin');
    mockPrisma.estimateReservation.findFirst
      .mockResolvedValueOnce(OPEN_RESERVATION) // initial load
      .mockResolvedValueOnce({                 // fresh post-tx read
        ...OPEN_RESERVATION, status: 'converted', converted_purchase_order_id: PURCHASE_ORDER_FIXTURE.id,
        converted_purchase_order: { id: PURCHASE_ORDER_FIXTURE.id, po_number: PURCHASE_ORDER_FIXTURE.po_number },
      });
    mockPrisma.estimateReservation.updateMany.mockResolvedValue({ count: 1 });
    mockPrisma.estimateReservation.update.mockResolvedValue({});
    mockPrisma.purchaseOrder.create.mockResolvedValue(PURCHASE_ORDER_FIXTURE);

    const res = await request(app).post(`/api/inventory/estimate-reservations/${RES_ID}/convert`)
      .set(authHeader('admin')).send({});

    expect(res.status).toBe(201);
    expect(res.body.purchaseOrder).toBeDefined();
    expect(res.body.estimateReservation.status).toBe('converted');
    expect(res.body.estimateReservation.convertedPoNumber).toBe(PURCHASE_ORDER_FIXTURE.po_number);

    // Atomic claim: only an 'open' row flips (TOCTOU-safe updateMany).
    const claimArgs = mockPrisma.estimateReservation.updateMany.mock.calls[0][0];
    expect(claimArgs.where).toMatchObject({ id: RES_ID, status: 'open', organization_id: ALPHA_ORG_ID });
    expect(claimArgs.data).toEqual({ status: 'converted' });

    // FK linkage written inside the same $transaction as the PO create.
    expect(mockPrisma.$transaction).toHaveBeenCalledTimes(1);
    const linkArgs = mockPrisma.estimateReservation.update.mock.calls[0][0];
    expect(linkArgs.where).toEqual({ id: RES_ID });
    expect(linkArgs.data).toEqual({ converted_purchase_order_id: PURCHASE_ORDER_FIXTURE.id });

    expect(logAudit).toHaveBeenCalledWith(expect.objectContaining({ action: 'inventory.reservation_converted' }));
    expect(logAudit).toHaveBeenCalledWith(expect.objectContaining({ action: 'inventory.po_created' }));
  });

  it('a vendor-less reservation converts as a vendor-less draft (fixes the FE-convert 400)', async () => {
    mockAuthAs('admin');
    mockPrisma.estimateReservation.findFirst
      .mockResolvedValueOnce({ ...OPEN_RESERVATION, preferred_vendor: null })
      .mockResolvedValueOnce({ ...OPEN_RESERVATION, status: 'converted' });
    mockPrisma.estimateReservation.updateMany.mockResolvedValue({ count: 1 });
    mockPrisma.estimateReservation.update.mockResolvedValue({});
    mockPrisma.purchaseOrder.create.mockResolvedValue(PURCHASE_ORDER_FIXTURE);

    const res = await request(app).post(`/api/inventory/estimate-reservations/${RES_ID}/convert`)
      .set(authHeader('admin')).send({});

    expect(res.status).toBe(201);
    const data = mockPrisma.purchaseOrder.create.mock.calls[0][0].data;
    expect(data.vendor).toBe('');
    expect(data.status).toBe('draft');
  });

  it('carries reservation lines with the catalog unit_cost snapshot + FK', async () => {
    mockAuthAs('admin');
    mockPrisma.estimateReservation.findFirst
      .mockResolvedValueOnce(OPEN_RESERVATION)
      .mockResolvedValueOnce({ ...OPEN_RESERVATION, status: 'converted' });
    mockPrisma.estimateReservation.updateMany.mockResolvedValue({ count: 1 });
    mockPrisma.estimateReservation.update.mockResolvedValue({});
    mockPrisma.purchaseOrder.create.mockResolvedValue(PURCHASE_ORDER_FIXTURE);

    await request(app).post(`/api/inventory/estimate-reservations/${RES_ID}/convert`)
      .set(authHeader('admin')).send({});

    const line = mockPrisma.purchaseOrder.create.mock.calls[0][0].data.lines.create[0];
    expect(line.item_sku).toBe('LOCK-100');
    expect(line.qty_ordered).toBe(2);
    expect(line.qty_received).toBe(0);
    expect(line.unit_cost).toBe(20); // catalog snapshot via price_book_item_id
    expect(line.price_book_item_id).toBe(PRICE_BOOK_ITEM_FIXTURE.id);
  });

  it('backstops a legacy blank-SKU reservation line from the catalog (line stays receivable)', async () => {
    // Pre-fix reservations snapshot item_sku:'' (estimate lines carry no SKU column) —
    // the receive contract is SKU-keyed, so without the catalog backstop the converted
    // PO line is permanently unreceivable. QA-605 staging finding, 2026-07-17.
    mockAuthAs('admin');
    const blankSkuReservation = {
      ...OPEN_RESERVATION,
      lines: [{ ...OPEN_RESERVATION.lines[0], item_sku: '' }],
    };
    mockPrisma.estimateReservation.findFirst
      .mockResolvedValueOnce(blankSkuReservation)
      .mockResolvedValueOnce({ ...blankSkuReservation, status: 'converted' });
    mockPrisma.estimateReservation.updateMany.mockResolvedValue({ count: 1 });
    mockPrisma.estimateReservation.update.mockResolvedValue({});
    mockPrisma.purchaseOrder.create.mockResolvedValue(PURCHASE_ORDER_FIXTURE);

    const res = await request(app).post(`/api/inventory/estimate-reservations/${RES_ID}/convert`)
      .set(authHeader('admin')).send({});

    expect(res.status).toBe(201);
    const line = mockPrisma.purchaseOrder.create.mock.calls[0][0].data.lines.create[0];
    expect(line.item_sku).toBe('LOCK-100'); // resolved from the catalog via price_book_item_id
  });

  it('uses the org-validated vendorId for display + FK', async () => {
    mockAuthAs('admin');
    mockPrisma.vendor.findFirst.mockResolvedValue({ id: VENDOR_ID, name: 'Acme Supply' });
    mockPrisma.estimateReservation.findFirst
      .mockResolvedValueOnce(OPEN_RESERVATION)
      .mockResolvedValueOnce({ ...OPEN_RESERVATION, status: 'converted' });
    mockPrisma.estimateReservation.updateMany.mockResolvedValue({ count: 1 });
    mockPrisma.estimateReservation.update.mockResolvedValue({});
    mockPrisma.purchaseOrder.create.mockResolvedValue(PURCHASE_ORDER_FIXTURE);

    const res = await request(app).post(`/api/inventory/estimate-reservations/${RES_ID}/convert`)
      .set(authHeader('admin')).send({ vendorId: VENDOR_ID });

    expect(res.status).toBe(201);
    const data = mockPrisma.purchaseOrder.create.mock.calls[0][0].data;
    expect(data.vendor).toBe('Acme Supply');
    expect(data.vendor_id).toBe(VENDOR_ID);
  });

  it('409 RESERVATION_NOT_OPEN when the claim loses (already converted/dismissed)', async () => {
    mockAuthAs('admin');
    mockPrisma.estimateReservation.findFirst
      .mockResolvedValueOnce({ ...OPEN_RESERVATION, status: 'open' }) // load raced
      .mockResolvedValueOnce({ status: 'converted' });                // in-tx current-status read
    mockPrisma.estimateReservation.updateMany.mockResolvedValue({ count: 0 });

    const res = await request(app).post(`/api/inventory/estimate-reservations/${RES_ID}/convert`)
      .set(authHeader('admin')).send({});

    expect(res.status).toBe(409);
    expect(res.body.error).toBe('RESERVATION_NOT_OPEN');
    expect(res.body.status).toBe('converted');
    expect(mockPrisma.purchaseOrder.create).not.toHaveBeenCalled();
  });

  it('404 on an unknown/cross-org reservation', async () => {
    mockAuthAs('admin');
    mockPrisma.estimateReservation.findFirst.mockResolvedValue(null);
    const res = await request(app).post(`/api/inventory/estimate-reservations/${RES_ID}/convert`)
      .set(authHeader('admin')).send({});
    expect(res.status).toBe(404);
  });
});

describe('POST /api/inventory/estimate-reservations/:id/dismiss (QA-602)', () => {
  it('dismisses an open reservation atomically and audits actor + reason', async () => {
    mockAuthAs('admin');
    mockPrisma.estimateReservation.findFirst
      .mockResolvedValueOnce(OPEN_RESERVATION)
      .mockResolvedValueOnce({ ...OPEN_RESERVATION, status: 'dismissed' });
    mockPrisma.estimateReservation.updateMany.mockResolvedValue({ count: 1 });

    const res = await request(app).post(`/api/inventory/estimate-reservations/${RES_ID}/dismiss`)
      .set(authHeader('admin')).send({ reason: 'ordered elsewhere' });

    expect(res.status).toBe(200);
    expect(res.body.estimateReservation.status).toBe('dismissed');
    const args = mockPrisma.estimateReservation.updateMany.mock.calls[0][0];
    expect(args.where).toMatchObject({ id: RES_ID, status: 'open', organization_id: ALPHA_ORG_ID });
    expect(args.data).toEqual({ status: 'dismissed' });
    expect(logAudit).toHaveBeenCalledWith(expect.objectContaining({
      action: 'inventory.reservation_dismissed',
      resourceType: 'EstimateReservation',
      resourceId: RES_ID,
      metadata: expect.objectContaining({ reason: 'ordered elsewhere' }),
    }));
  });

  it('409 RESERVATION_NOT_OPEN on an already-terminal reservation (never reopens)', async () => {
    mockAuthAs('admin');
    mockPrisma.estimateReservation.findFirst.mockResolvedValue({ ...OPEN_RESERVATION, status: 'converted' });
    mockPrisma.estimateReservation.updateMany.mockResolvedValue({ count: 0 });

    const res = await request(app).post(`/api/inventory/estimate-reservations/${RES_ID}/dismiss`)
      .set(authHeader('admin')).send({});

    expect(res.status).toBe(409);
    expect(res.body.error).toBe('RESERVATION_NOT_OPEN');
  });

  it('404 on an unknown/cross-org reservation', async () => {
    mockAuthAs('admin');
    mockPrisma.estimateReservation.findFirst.mockResolvedValue(null);
    const res = await request(app).post(`/api/inventory/estimate-reservations/${RES_ID}/dismiss`)
      .set(authHeader('admin')).send({});
    expect(res.status).toBe(404);
  });
});

describe('GET /api/inventory/estimate-reservations — enriched list (A-12, QA-308)', () => {
  it('emits status, estimate/lead status, and converted-PO refs from the enriched include', async () => {
    mockAuthAs('admin');
    mockPrisma.estimateReservation.findMany.mockResolvedValue([{
      ...OPEN_RESERVATION,
      status: 'open',
      estimate: { status: 'WON', lead: { status: 'LOST' } },
      converted_purchase_order: null,
    }, {
      ...OPEN_RESERVATION,
      id: 'ee000000-0000-0000-0000-000000000002',
      status: 'converted',
      converted_purchase_order_id: PURCHASE_ORDER_FIXTURE.id,
      estimate: { status: 'WON', lead: { status: 'WON' } },
      converted_purchase_order: { id: PURCHASE_ORDER_FIXTURE.id, po_number: 'PO-1001' },
    }]);

    const res = await request(app).get('/api/inventory/estimate-reservations').set(authHeader('admin'));

    expect(res.status).toBe(200);
    const [open, converted] = res.body.estimateReservations;
    // open + lead LOST is a legitimate displayable state (no estimate-side auto-dismiss).
    expect(open.status).toBe('open');
    expect(open.estimateStatus).toBe('WON');
    expect(open.leadStatus).toBe('LOST');
    expect(open.convertedPurchaseOrderId).toBeUndefined();
    expect(converted.status).toBe('converted');
    expect(converted.convertedPurchaseOrderId).toBe(PURCHASE_ORDER_FIXTURE.id);
    expect(converted.convertedPoNumber).toBe('PO-1001');

    // Include must carry the estimate→lead + converted-PO joins.
    const include = mockPrisma.estimateReservation.findMany.mock.calls[0][0].include;
    expect(include.estimate).toBeDefined();
    expect(include.converted_purchase_order).toBeDefined();
  });

  it('supports a Zod-validated ?status= filter (open-only queue tab)', async () => {
    mockAuthAs('admin');
    mockPrisma.estimateReservation.findMany.mockResolvedValue([]);

    const res = await request(app).get('/api/inventory/estimate-reservations?status=open').set(authHeader('admin'));

    expect(res.status).toBe(200);
    const where = mockPrisma.estimateReservation.findMany.mock.calls[0][0].where;
    expect(where.status).toBe('open');
  });

  it('400s on an invalid ?status= value', async () => {
    mockAuthAs('admin');
    const res = await request(app).get('/api/inventory/estimate-reservations?status=bogus').set(authHeader('admin'));
    expect(res.status).toBe(400);
  });
});
