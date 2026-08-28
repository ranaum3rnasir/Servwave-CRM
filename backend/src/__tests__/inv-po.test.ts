import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';
import app from '../app';
import { prisma } from '../lib/prisma';
import { mockAuthAs, authHeader, TEST_USERS, JOB_FIXTURE, CUSTOMER_FIXTURE, PURCHASE_ORDER_FIXTURE, PRICE_BOOK_ITEM_FIXTURE, INVENTORY_LOCATION_FIXTURE } from './helpers';
import { clearPermissionCache } from '../lib/permissions/permissionCache';

const mockPrisma = prisma as unknown as {
  purchaseOrder: { findMany: ReturnType<typeof vi.fn>; findFirst: ReturnType<typeof vi.fn>; create: ReturnType<typeof vi.fn>; update: ReturnType<typeof vi.fn> };
  purchaseOrderLine: { findMany: ReturnType<typeof vi.fn>; update: ReturnType<typeof vi.fn>; deleteMany: ReturnType<typeof vi.fn> };
  jobStageLine: { findMany: ReturnType<typeof vi.fn> };
  job: { findFirst: ReturnType<typeof vi.fn> };
  customer: { findFirst: ReturnType<typeof vi.fn> };
  vendor: { findFirst: ReturnType<typeof vi.fn> };
  priceBookItem: { findMany: ReturnType<typeof vi.fn>; findFirst: ReturnType<typeof vi.fn> };
  inventoryLocation: { findFirst: ReturnType<typeof vi.fn> };
  organization: { findFirst: ReturnType<typeof vi.fn>; findUnique: ReturnType<typeof vi.fn> };
  stockMovement: { create: ReturnType<typeof vi.fn> };
  stockBalance: { upsert: ReturnType<typeof vi.fn> };
  estimateReservation: { create: ReturnType<typeof vi.fn> };
  estimate: { findFirst: ReturnType<typeof vi.fn> };
  invoice: { create: ReturnType<typeof vi.fn> };
  invoiceLineItem: { create: ReturnType<typeof vi.fn> };
  $transaction: ReturnType<typeof vi.fn>;
};

beforeEach(() => {
  vi.clearAllMocks();
  clearPermissionCache();
  // P0 §A: createPurchaseOrder allocates its number inside a transaction.
  mockPrisma.$transaction.mockImplementation(async (fn: any) => fn(mockPrisma));
});

describe('GET /api/inventory/purchase-orders (harness smoke)', () => {
  it('returns 200 with an empty list', async () => {
    mockAuthAs('admin');
    mockPrisma.purchaseOrder.findMany.mockResolvedValue([]);
    const res = await request(app).get('/api/inventory/purchase-orders').set(authHeader('admin'));
    expect(res.status).toBe(200);
    expect(res.body.purchaseOrders).toEqual([]);
  });

  it('PO line mapper emits priceBookItemId', async () => {
    mockAuthAs('admin');
    const po = { ...PURCHASE_ORDER_FIXTURE, lines: [{ ...PURCHASE_ORDER_FIXTURE.lines[0], price_book_item_id: PRICE_BOOK_ITEM_FIXTURE.id }] };
    mockPrisma.purchaseOrder.findFirst.mockResolvedValue(po);
    const res = await request(app).get(`/api/inventory/purchase-orders/${po.id}`).set(authHeader('admin'));
    expect(res.status).toBe(200);
    expect(res.body.purchaseOrder.lines[0].priceBookItemId).toBe(PRICE_BOOK_ITEM_FIXTURE.id);
    // D2: the line id is serialized so the receive contract can key on it.
    expect(res.body.purchaseOrder.lines[0].id).toBe(PURCHASE_ORDER_FIXTURE.lines[0].id);
  });
});

describe('POST /api/inventory/purchase-orders/receive — line-id identity (D2)', () => {
  // CAT = catalogued line (price_book_item_id set); FREE_* = from-job free-text lines (blank SKU, no FK).
  const CAT_LINE = { id: 'aaaaaaa5-0000-0000-0000-0000000000c1', item_sku: 'LOCK-100', item_name: 'Deadbolt', uom: 'EA', qty_ordered: 4, qty_received: 0, unit_cost: 20, price_book_item_id: PRICE_BOOK_ITEM_FIXTURE.id, created_at: new Date('2026-02-01') };
  const FREE_A   = { id: 'aaaaaaa5-0000-0000-0000-0000000000f1', item_sku: '', item_name: 'Custom bracket', uom: 'EA', qty_ordered: 3, qty_received: 0, unit_cost: 7, price_book_item_id: null, created_at: new Date('2026-02-01') };
  const FREE_B   = { id: 'aaaaaaa5-0000-0000-0000-0000000000f2', item_sku: '', item_name: 'Custom shim', uom: 'EA', qty_ordered: 2, qty_received: 0, unit_cost: 3, price_book_item_id: null, created_at: new Date('2026-02-01') };

  function mockPo(lines: any[]) {
    const po = { ...PURCHASE_ORDER_FIXTURE, job_id: JOB_FIXTURE.id, staged_as_job_stage_id: null, lines };
    mockPrisma.purchaseOrder.findFirst.mockResolvedValueOnce(po).mockResolvedValueOnce(po);
    mockPrisma.organization.findUnique.mockResolvedValue({ default_inventory_location_id: INVENTORY_LOCATION_FIXTURE.id });
    mockPrisma.purchaseOrderLine.findMany.mockResolvedValue(lines.map((l) => ({ ...l })));
    return po;
  }

  it('receives a blank-SKU free-text line by its id — costed + ledgered, but writes NO StockBalance', async () => {
    mockAuthAs('admin');
    const po = mockPo([FREE_A]);
    const res = await request(app).post('/api/inventory/purchase-orders/receive').set(authHeader('admin'))
      .send({ poId: po.id, lines: [{ lineId: FREE_A.id, qtyReceived: 3 }] });

    expect(res.status).toBe(200);
    expect(mockPrisma.purchaseOrderLine.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: FREE_A.id }, data: { qty_received: 3 } }),
    );
    expect(mockPrisma.stockMovement.create).toHaveBeenCalled();     // ledger row for audit + cost roll-up
    expect(mockPrisma.stockBalance.upsert).not.toHaveBeenCalled();  // no phantom catalog stock
  });

  it('receives two blank-SKU lines independently — no collision onto the first line', async () => {
    mockAuthAs('admin');
    const po = mockPo([FREE_A, FREE_B]);
    const res = await request(app).post('/api/inventory/purchase-orders/receive').set(authHeader('admin'))
      .send({ poId: po.id, lines: [{ lineId: FREE_A.id, qtyReceived: 3 }, { lineId: FREE_B.id, qtyReceived: 2 }] });

    expect(res.status).toBe(200);
    const updatedIds = mockPrisma.purchaseOrderLine.update.mock.calls.map((c) => c[0].where.id);
    expect(new Set(updatedIds)).toEqual(new Set([FREE_A.id, FREE_B.id]));
  });

  it('resolves stock identity from price_book_item_id (not a SKU re-lookup) for a catalogued line', async () => {
    mockAuthAs('admin');
    const po = mockPo([CAT_LINE]);
    const res = await request(app).post('/api/inventory/purchase-orders/receive').set(authHeader('admin'))
      .send({ poId: po.id, lines: [{ lineId: CAT_LINE.id, qtyReceived: 4 }] });

    expect(res.status).toBe(200);
    expect(mockPrisma.stockBalance.upsert.mock.calls[0][0].where.item_id_location_id.item_id).toBe(PRICE_BOOK_ITEM_FIXTURE.id);
  });
});

describe('POST /api/inventory/purchase-orders — FK population (V4/P1)', () => {
  // JOB_FIXTURE.id ('j...') is not a hex-valid UUID, which the uuid()-validated
  // jobId field correctly rejects; use a valid UUID for the job in these tests.
  const VALID_JOB_ID = 'a1b2c3d4-0000-0000-0000-000000000001';
  const basePayload = {
    poNumber: 'PO-2001', vendor: 'Acme', status: 'draft',
    lines: [{ itemSku: 'LOCK-100', itemName: 'Deadbolt', uom: 'EA', qtyOrdered: 5 }],
  };

  it('writes job_id + customer_id when both exist in the org', async () => {
    mockAuthAs('admin');
    mockPrisma.job.findFirst.mockResolvedValue({ id: VALID_JOB_ID });
    mockPrisma.customer.findFirst.mockResolvedValue({ id: CUSTOMER_FIXTURE.id });
    mockPrisma.priceBookItem.findMany.mockResolvedValue([]);
    mockPrisma.purchaseOrder.create.mockResolvedValue({ ...PURCHASE_ORDER_FIXTURE, job_id: VALID_JOB_ID, customer_id: CUSTOMER_FIXTURE.id });
    const res = await request(app).post('/api/inventory/purchase-orders').set(authHeader('admin'))
      .send({ ...basePayload, jobId: VALID_JOB_ID, customerId: CUSTOMER_FIXTURE.id });
    expect(res.status).toBe(201);
    const data = mockPrisma.purchaseOrder.create.mock.calls[0][0].data;
    expect(data.job_id).toBe(VALID_JOB_ID);
    expect(data.customer_id).toBe(CUSTOMER_FIXTURE.id);
  });

  it('rejects a job_id from another org (P1 cross-org FK injection)', async () => {
    mockAuthAs('admin');
    mockPrisma.job.findFirst.mockResolvedValue(null); // not in requesting org
    const res = await request(app).post('/api/inventory/purchase-orders').set(authHeader('admin'))
      .send({ ...basePayload, jobId: '99999999-9999-9999-9999-999999999999' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/job/i);
    expect(mockPrisma.purchaseOrder.create).not.toHaveBeenCalled();
  });
});

describe('POST /api/inventory/purchase-orders — SKU→price_book_item_id resolution (V6/D5)', () => {
  it('resolves price_book_item_id from item_sku on PO create', async () => {
    mockAuthAs('admin');
    mockPrisma.priceBookItem.findMany.mockResolvedValue([{ id: PRICE_BOOK_ITEM_FIXTURE.id, sku: 'LOCK-100' }]);
    mockPrisma.purchaseOrder.create.mockResolvedValue(PURCHASE_ORDER_FIXTURE);
    await request(app).post('/api/inventory/purchase-orders').set(authHeader('admin')).send({
      poNumber: 'PO-3001', vendor: 'Acme',
      lines: [{ itemSku: 'LOCK-100', itemName: 'Deadbolt', uom: 'EA', qtyOrdered: 2 }],
    });
    const createdLines = mockPrisma.purchaseOrder.create.mock.calls[0][0].data.lines.create;
    expect(createdLines[0].price_book_item_id).toBe(PRICE_BOOK_ITEM_FIXTURE.id);
  });
});

describe('POST /api/inventory/purchase-orders — unitCost capture (DEC2 cost source)', () => {
  it('persists unit_cost on PO line create (DEC2 cost source)', async () => {
    mockAuthAs('admin');
    mockPrisma.priceBookItem.findMany.mockResolvedValue([]);
    mockPrisma.purchaseOrder.create.mockResolvedValue(PURCHASE_ORDER_FIXTURE);
    await request(app).post('/api/inventory/purchase-orders').set(authHeader('admin')).send({
      poNumber: 'PO-4001', vendor: 'Acme',
      lines: [{ itemSku: 'LOCK-100', itemName: 'Deadbolt', uom: 'EA', qtyOrdered: 2, unitCost: 22.5 }],
    });
    const createdLines = mockPrisma.purchaseOrder.create.mock.calls[0][0].data.lines.create;
    expect(createdLines[0].unit_cost).toBe(22.5);
  });

  it('exposes unitCost on the PO read contract', async () => {
    mockAuthAs('admin');
    const po = { ...PURCHASE_ORDER_FIXTURE, lines: [{ ...PURCHASE_ORDER_FIXTURE.lines[0], unit_cost: 22.5 }] };
    mockPrisma.purchaseOrder.findFirst.mockResolvedValue(po);
    const res = await request(app).get(`/api/inventory/purchase-orders/${po.id}`).set(authHeader('admin'));
    expect(res.body.purchaseOrder.lines[0].unitCost).toBe(22.5);
  });
});

describe('POST/PATCH /api/inventory/purchase-orders — vendor_id FK (P2 item 1b)', () => {
  const VENDOR_ID = 'e2000000-0000-0000-0000-000000000001';
  const basePayload = {
    vendor: 'Acme', status: 'draft',
    lines: [{ itemSku: 'LOCK-100', itemName: 'Deadbolt', uom: 'EA', qtyOrdered: 5 }],
  };

  it('persists vendor_id on create when the vendor exists in the org', async () => {
    mockAuthAs('admin');
    mockPrisma.vendor.findFirst.mockResolvedValue({ id: VENDOR_ID, name: 'Acme Supply' });
    mockPrisma.priceBookItem.findMany.mockResolvedValue([]);
    mockPrisma.purchaseOrder.create.mockResolvedValue(PURCHASE_ORDER_FIXTURE);
    const res = await request(app).post('/api/inventory/purchase-orders').set(authHeader('admin'))
      .send({ ...basePayload, vendorId: VENDOR_ID });
    expect(res.status).toBe(201);
    const data = mockPrisma.purchaseOrder.create.mock.calls[0][0].data;
    expect(data.vendor_id).toBe(VENDOR_ID);
    expect(data.vendor).toBe('Acme'); // both present → both persisted as given
  });

  it('rejects a cross-org vendorId on create (400, no write)', async () => {
    mockAuthAs('admin');
    mockPrisma.vendor.findFirst.mockResolvedValue(null);
    const res = await request(app).post('/api/inventory/purchase-orders').set(authHeader('admin'))
      .send({ ...basePayload, vendorId: VENDOR_ID });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/vendor/i);
    expect(mockPrisma.purchaseOrder.create).not.toHaveBeenCalled();
  });

  it('resolves the vendor display string from the vendor row when only vendorId is sent', async () => {
    mockAuthAs('admin');
    mockPrisma.vendor.findFirst.mockResolvedValue({ id: VENDOR_ID, name: 'Acme Supply' });
    mockPrisma.priceBookItem.findMany.mockResolvedValue([]);
    mockPrisma.purchaseOrder.create.mockResolvedValue(PURCHASE_ORDER_FIXTURE);
    const res = await request(app).post('/api/inventory/purchase-orders').set(authHeader('admin'))
      .send({ vendorId: VENDOR_ID, lines: basePayload.lines });
    expect(res.status).toBe(201);
    const data = mockPrisma.purchaseOrder.create.mock.calls[0][0].data;
    expect(data.vendor).toBe('Acme Supply');
    expect(data.vendor_id).toBe(VENDOR_ID);
  });

  it('maps vendorId on update and refreshes the display string from the vendor row', async () => {
    mockAuthAs('admin');
    mockPrisma.purchaseOrder.findFirst.mockResolvedValue(PURCHASE_ORDER_FIXTURE);
    mockPrisma.vendor.findFirst.mockResolvedValue({ id: VENDOR_ID, name: 'Acme Supply' });
    mockPrisma.purchaseOrder.update.mockResolvedValue(PURCHASE_ORDER_FIXTURE);
    const res = await request(app).patch(`/api/inventory/purchase-orders/${PURCHASE_ORDER_FIXTURE.id}`)
      .set(authHeader('admin')).send({ vendorId: VENDOR_ID });
    expect(res.status).toBe(200);
    const data = mockPrisma.purchaseOrder.update.mock.calls[0][0].data;
    expect(data.vendor_id).toBe(VENDOR_ID);
    expect(data.vendor).toBe('Acme Supply');
  });

  it('emits vendorId on the read contract when the FK is set', async () => {
    mockAuthAs('admin');
    mockPrisma.purchaseOrder.findFirst.mockResolvedValue({ ...PURCHASE_ORDER_FIXTURE, vendor_id: VENDOR_ID });
    const res = await request(app).get(`/api/inventory/purchase-orders/${PURCHASE_ORDER_FIXTURE.id}`).set(authHeader('admin'));
    expect(res.status).toBe(200);
    expect(res.body.purchaseOrder.vendorId).toBe(VENDOR_ID);
  });
});

describe('POST /api/inventory/purchase-orders/receive (B2/V5)', () => {
  it('updates qty_received, emits StockMovement, updates StockBalance — and creates NO billing (DEC2)', async () => {
    mockAuthAs('admin');
    const po = { ...PURCHASE_ORDER_FIXTURE, job_id: JOB_FIXTURE.id }; // linked job, but still no billing
    mockPrisma.purchaseOrder.findFirst.mockResolvedValueOnce(po).mockResolvedValueOnce(po); // initial load + re-read
    mockPrisma.priceBookItem.findMany.mockResolvedValue([{ id: PRICE_BOOK_ITEM_FIXTURE.id, sku: 'LOCK-100' }]);
    mockPrisma.organization.findUnique.mockResolvedValue({ default_inventory_location_id: INVENTORY_LOCATION_FIXTURE.id });
    mockPrisma.purchaseOrderLine.findMany.mockResolvedValue(po.lines.map((l) => ({ ...l, qty_received: 5 })));
    mockPrisma.$transaction.mockImplementation(async (fn: any) => fn(mockPrisma));
    const res = await request(app).post('/api/inventory/purchase-orders/receive').set(authHeader('admin'))
      .send({ poId: po.id, lines: [{ lineId: po.lines[0].id, qtyReceived: 5 }] });
    expect(res.status).toBe(200);
    expect(mockPrisma.stockMovement.create).toHaveBeenCalled();
    expect(mockPrisma.purchaseOrderLine.update).toHaveBeenCalled();
    // DEC2: receipt is internal-cost only — no billing (no invoice / invoice line) by receipt.
    expect(mockPrisma.invoice.create).not.toHaveBeenCalled();
    expect(mockPrisma.invoiceLineItem.create).not.toHaveBeenCalled();
  });

  it('uses the org default receive-location, not first-warehouse, when set (DEC3)', async () => {
    mockAuthAs('admin');
    const po = { ...PURCHASE_ORDER_FIXTURE, job_id: null };
    mockPrisma.purchaseOrder.findFirst.mockResolvedValueOnce(po).mockResolvedValueOnce(po);
    mockPrisma.priceBookItem.findMany.mockResolvedValue([{ id: PRICE_BOOK_ITEM_FIXTURE.id, sku: 'LOCK-100' }]);
    mockPrisma.organization.findUnique.mockResolvedValue({ default_inventory_location_id: 'bbbbbbb1-0000-0000-0000-000000000099' });
    mockPrisma.purchaseOrderLine.findMany.mockResolvedValue(po.lines.map((l) => ({ ...l, qty_received: 5 })));
    mockPrisma.$transaction.mockImplementation(async (fn: any) => fn(mockPrisma));
    await request(app).post('/api/inventory/purchase-orders/receive').set(authHeader('admin'))
      .send({ poId: po.id, lines: [{ lineId: po.lines[0].id, qtyReceived: 5 }] });
    // inventoryLocation.findFirst (the first-warehouse fallback) is NOT consulted when a default exists.
    expect(mockPrisma.inventoryLocation.findFirst).not.toHaveBeenCalled();
    expect(mockPrisma.stockMovement.create.mock.calls[0][0].data.to_location_id).toBe('bbbbbbb1-0000-0000-0000-000000000099');
  });

  it('404s when the PO is in another org', async () => {
    mockAuthAs('admin');
    mockPrisma.purchaseOrder.findFirst.mockResolvedValue(null);
    const res = await request(app).post('/api/inventory/purchase-orders/receive').set(authHeader('admin'))
      .send({ poId: '99999999-9999-9999-9999-999999999999', lines: [{ lineId: 'aaaaaaa5-0000-0000-0000-0000000000ff', qtyReceived: 1 }] });
    expect(res.status).toBe(404);
  });

  it('threads job_id + unit_cost + actor_user_id into the receive movement', async () => {
    mockAuthAs('admin');
    const po = { ...PURCHASE_ORDER_FIXTURE, job_id: JOB_FIXTURE.id }; // fixture line unit_cost = 20
    mockPrisma.purchaseOrder.findFirst.mockResolvedValueOnce(po).mockResolvedValueOnce(po);
    mockPrisma.priceBookItem.findMany.mockResolvedValue([{ id: PRICE_BOOK_ITEM_FIXTURE.id, sku: 'LOCK-100' }]);
    mockPrisma.organization.findUnique.mockResolvedValue({ default_inventory_location_id: INVENTORY_LOCATION_FIXTURE.id });
    mockPrisma.purchaseOrderLine.findMany.mockResolvedValue(po.lines.map((l) => ({ ...l, qty_received: 5 })));
    mockPrisma.$transaction.mockImplementation(async (fn: any) => fn(mockPrisma));
    const res = await request(app).post('/api/inventory/purchase-orders/receive').set(authHeader('admin'))
      .send({ poId: po.id, lines: [{ lineId: po.lines[0].id, qtyReceived: 5 }] });
    expect(res.status).toBe(200);
    const data = mockPrisma.stockMovement.create.mock.calls[0][0].data;
    expect(data.job_id).toBe(JOB_FIXTURE.id);
    expect(data.unit_cost).toBe(20);
    expect(data.actor_user_id).toBe(TEST_USERS.admin.id);
  });

  it('a downward correction emits a signed negative adjust that SUBTRACTS from the balance', async () => {
    mockAuthAs('admin');
    // Stored qty_received 5, dialog submits absolute total 3 → delta -2.
    // Catalogued line (FK set) so the signed adjust moves a StockBalance (D2).
    const po = { ...PURCHASE_ORDER_FIXTURE, job_id: null, lines: [{ ...PURCHASE_ORDER_FIXTURE.lines[0], qty_received: 5, price_book_item_id: PRICE_BOOK_ITEM_FIXTURE.id }] };
    mockPrisma.purchaseOrder.findFirst.mockResolvedValueOnce(po).mockResolvedValueOnce(po);
    mockPrisma.priceBookItem.findMany.mockResolvedValue([{ id: PRICE_BOOK_ITEM_FIXTURE.id, sku: 'LOCK-100' }]);
    mockPrisma.organization.findUnique.mockResolvedValue({ default_inventory_location_id: INVENTORY_LOCATION_FIXTURE.id });
    mockPrisma.purchaseOrderLine.findMany.mockResolvedValue(po.lines.map((l) => ({ ...l, qty_received: 3 })));
    mockPrisma.$transaction.mockImplementation(async (fn: any) => fn(mockPrisma));
    const res = await request(app).post('/api/inventory/purchase-orders/receive').set(authHeader('admin'))
      .send({ poId: po.id, lines: [{ lineId: po.lines[0].id, qtyReceived: 3 }] });
    expect(res.status).toBe(200);
    const data = mockPrisma.stockMovement.create.mock.calls[0][0].data;
    expect(data.type).toBe('adjust');
    expect(data.qty).toBe(-2);
    expect(mockPrisma.stockBalance.upsert.mock.calls[0][0].update.on_hand).toEqual({ increment: -2 });
  });
});

describe('POST /api/inventory/purchase-orders/receive — over-receive guard (P2 4a, QA-606)', () => {
  it('400 OVER_RECEIVE when the absolute total exceeds qty_ordered — zero partial application', async () => {
    mockAuthAs('admin');
    const po = { ...PURCHASE_ORDER_FIXTURE, job_id: null }; // line qty_ordered = 5
    mockPrisma.purchaseOrder.findFirst.mockResolvedValue(po);
    const res = await request(app).post('/api/inventory/purchase-orders/receive').set(authHeader('admin'))
      .send({ poId: po.id, lines: [{ lineId: po.lines[0].id, qtyReceived: 7 }] });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('OVER_RECEIVE');
    expect(res.body.item_sku).toBe('LOCK-100');
    expect(res.body.qty_ordered).toBe(5);
    expect(res.body.qty_received).toBe(7);
    expect(mockPrisma.$transaction).not.toHaveBeenCalled();
    expect(mockPrisma.stockMovement.create).not.toHaveBeenCalled();
    expect(mockPrisma.purchaseOrderLine.update).not.toHaveBeenCalled();
  });

  it('absolute-total semantics: 7 of 5 rejects even after a prior partial receive of 3', async () => {
    mockAuthAs('admin');
    const po = { ...PURCHASE_ORDER_FIXTURE, job_id: null, lines: [{ ...PURCHASE_ORDER_FIXTURE.lines[0], qty_received: 3 }] };
    mockPrisma.purchaseOrder.findFirst.mockResolvedValue(po);
    const res = await request(app).post('/api/inventory/purchase-orders/receive').set(authHeader('admin'))
      .send({ poId: po.id, lines: [{ lineId: po.lines[0].id, qtyReceived: 7 }] });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('OVER_RECEIVE');
  });

  it('receiving exactly qty_ordered stays allowed', async () => {
    mockAuthAs('admin');
    const po = { ...PURCHASE_ORDER_FIXTURE, job_id: null };
    mockPrisma.purchaseOrder.findFirst.mockResolvedValueOnce(po).mockResolvedValueOnce(po);
    mockPrisma.priceBookItem.findMany.mockResolvedValue([]);
    mockPrisma.organization.findUnique.mockResolvedValue({ default_inventory_location_id: INVENTORY_LOCATION_FIXTURE.id });
    mockPrisma.purchaseOrderLine.findMany.mockResolvedValue(po.lines.map((l) => ({ ...l, qty_received: 5 })));
    const res = await request(app).post('/api/inventory/purchase-orders/receive').set(authHeader('admin'))
      .send({ poId: po.id, lines: [{ lineId: po.lines[0].id, qtyReceived: 5 }] });
    expect(res.status).toBe(200);
  });
});

describe('POST /api/inventory/purchase-orders/receive — destination picker (P2 4b, D14)', () => {
  const DEST = 'bbbbbbb1-0000-0000-0000-000000000077';

  it('honors an org-validated destinationLocationId for every movement in the call', async () => {
    mockAuthAs('admin');
    const po = { ...PURCHASE_ORDER_FIXTURE, job_id: null };
    mockPrisma.purchaseOrder.findFirst.mockResolvedValueOnce(po).mockResolvedValueOnce(po);
    mockPrisma.priceBookItem.findMany.mockResolvedValue([{ id: PRICE_BOOK_ITEM_FIXTURE.id, sku: 'LOCK-100' }]);
    mockPrisma.inventoryLocation.findFirst.mockResolvedValue({ id: DEST });
    mockPrisma.purchaseOrderLine.findMany.mockResolvedValue(po.lines.map((l) => ({ ...l, qty_received: 5 })));
    const res = await request(app).post('/api/inventory/purchase-orders/receive').set(authHeader('admin'))
      .send({ poId: po.id, destinationLocationId: DEST, lines: [{ lineId: po.lines[0].id, qtyReceived: 5 }] });
    expect(res.status).toBe(200);
    expect(mockPrisma.stockMovement.create.mock.calls[0][0].data.to_location_id).toBe(DEST);
    // The DEC3 org-default resolver is NOT consulted when a destination is picked.
    expect(mockPrisma.organization.findUnique).not.toHaveBeenCalled();
  });

  it('404s on a cross-org destinationLocationId', async () => {
    mockAuthAs('admin');
    const po = { ...PURCHASE_ORDER_FIXTURE, job_id: null };
    mockPrisma.purchaseOrder.findFirst.mockResolvedValue(po);
    mockPrisma.inventoryLocation.findFirst.mockResolvedValue(null);
    const res = await request(app).post('/api/inventory/purchase-orders/receive').set(authHeader('admin'))
      .send({ poId: po.id, destinationLocationId: DEST, lines: [{ lineId: po.lines[0].id, qtyReceived: 5 }] });
    expect(res.status).toBe(404);
    expect(mockPrisma.stockMovement.create).not.toHaveBeenCalled();
  });
});

describe('POST /api/inventory/purchase-orders/receive — staged-PO guard (P2 4d, D14/QA-611)', () => {
  const STAGE_ID = 'aaaaaaa6-0000-0000-0000-000000000009';

  it('409 STAGED_PO when receiving a line that is staged (single receive path)', async () => {
    mockAuthAs('admin');
    const po = { ...PURCHASE_ORDER_FIXTURE, job_id: null, staged_as_job_stage_id: STAGE_ID };
    mockPrisma.purchaseOrder.findFirst.mockResolvedValue(po);
    mockPrisma.jobStageLine.findMany.mockResolvedValue([{ item_sku: 'LOCK-100' }]);
    const res = await request(app).post('/api/inventory/purchase-orders/receive').set(authHeader('admin'))
      .send({ poId: po.id, lines: [{ lineId: po.lines[0].id, qtyReceived: 2 }] });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('STAGED_PO');
    expect(res.body.staged_skus).toEqual(['LOCK-100']);
    expect(mockPrisma.stockMovement.create).not.toHaveBeenCalled();
  });

  it('a request touching only unlinked SKUs on a partially-staged PO proceeds', async () => {
    mockAuthAs('admin');
    const wireLine = { id: 'aaaaaaa5-0000-0000-0000-000000000002', item_sku: 'WIRE-12', item_name: 'Wire', uom: 'FT', qty_ordered: 10, qty_received: 0, unit_cost: 1, price_book_item_id: null, created_at: new Date('2026-02-01') };
    const po = { ...PURCHASE_ORDER_FIXTURE, job_id: null, staged_as_job_stage_id: STAGE_ID, lines: [PURCHASE_ORDER_FIXTURE.lines[0], wireLine] };
    mockPrisma.purchaseOrder.findFirst.mockResolvedValueOnce(po).mockResolvedValueOnce(po);
    mockPrisma.jobStageLine.findMany.mockResolvedValue([{ item_sku: 'LOCK-100' }]); // only LOCK-100 staged
    mockPrisma.priceBookItem.findMany.mockResolvedValue([]);
    mockPrisma.organization.findUnique.mockResolvedValue({ default_inventory_location_id: INVENTORY_LOCATION_FIXTURE.id });
    mockPrisma.purchaseOrderLine.findMany.mockResolvedValue(po.lines);
    const res = await request(app).post('/api/inventory/purchase-orders/receive').set(authHeader('admin'))
      .send({ poId: po.id, lines: [{ lineId: wireLine.id, qtyReceived: 4 }] });
    expect(res.status).toBe(200);
    expect(mockPrisma.stockMovement.create).toHaveBeenCalled();
  });
});

describe('GET /api/inventory/jobs/:jobId/material-cost (V1/DEC2)', () => {
  it('sums qty_received × unit_cost across the job PO + stage lines', async () => {
    mockAuthAs('admin');
    mockPrisma.job.findFirst.mockResolvedValue({ id: JOB_FIXTURE.id });
    // 5 received × $20 unit_cost (PO) + 3 received × $20 unit_cost (stage) = $160
    mockPrisma.purchaseOrderLine.findMany.mockResolvedValue([
      { qty_received: 5, unit_cost: 20, price_book_item: null },
    ]);
    mockPrisma.jobStageLine.findMany.mockResolvedValue([
      { qty_received: 3, unit_cost: 20, price_book_item: null },
    ]);
    const res = await request(app).get(`/api/inventory/jobs/${JOB_FIXTURE.id}/material-cost`).set(authHeader('admin'));
    expect(res.status).toBe(200);
    expect(res.body.materialCost).toBe(160);
    expect(res.body.lineCount).toBe(2);
  });

  it('falls back to PriceBookItem.unit_cost when the line has no unit_cost', async () => {
    mockAuthAs('admin');
    mockPrisma.job.findFirst.mockResolvedValue({ id: JOB_FIXTURE.id });
    // line unit_cost null → fall back to catalog unit_cost 20; 4 × 20 = 80
    mockPrisma.purchaseOrderLine.findMany.mockResolvedValue([
      { qty_received: 4, unit_cost: null, price_book_item: { unit_cost: 20 } },
    ]);
    mockPrisma.jobStageLine.findMany.mockResolvedValue([]);
    const res = await request(app).get(`/api/inventory/jobs/${JOB_FIXTURE.id}/material-cost`).set(authHeader('admin'));
    expect(res.body.materialCost).toBe(80);
  });

  it('404s when the job is in another org', async () => {
    mockAuthAs('admin');
    mockPrisma.job.findFirst.mockResolvedValue(null);
    const res = await request(app).get('/api/inventory/jobs/99999999-9999-9999-9999-999999999999/material-cost').set(authHeader('admin'));
    expect(res.status).toBe(404);
  });

  // ─── P2 item 5 (§3.6): staged-PO dedup — PO side wins per line ─────────────
  it('excludes PO-linked stage lines from the stage query (counted once via the PO side)', async () => {
    mockAuthAs('admin');
    mockPrisma.job.findFirst.mockResolvedValue({ id: JOB_FIXTURE.id });
    // The PO line is the authoritative row; the linked stage mirror is excluded by
    // the where filter, so the DB never returns it. 5 × $20 = $100 exactly once.
    mockPrisma.purchaseOrderLine.findMany.mockResolvedValue([
      { qty_received: 5, unit_cost: 20, price_book_item: null },
    ]);
    mockPrisma.jobStageLine.findMany.mockResolvedValue([]);
    const res = await request(app).get(`/api/inventory/jobs/${JOB_FIXTURE.id}/material-cost`).set(authHeader('admin'));
    expect(res.status).toBe(200);
    expect(res.body.materialCost).toBe(100);
    expect(res.body.lineCount).toBe(1);
    // The one-token fix: stage lines only count when they have NO PO linkage.
    const stageWhere = mockPrisma.jobStageLine.findMany.mock.calls[0][0].where;
    expect(stageWhere.purchase_order_id).toBeNull();
  });

  it('manual (unlinked) stage lines still count; unstaged PO lines of a partially-staged PO count', async () => {
    mockAuthAs('admin');
    mockPrisma.job.findFirst.mockResolvedValue({ id: JOB_FIXTURE.id });
    // 5×$20 (PO, staged or not) + 3×$10 (manual stage line) = $130.
    mockPrisma.purchaseOrderLine.findMany.mockResolvedValue([
      { qty_received: 5, unit_cost: 20, price_book_item: null },
    ]);
    mockPrisma.jobStageLine.findMany.mockResolvedValue([
      { qty_received: 3, unit_cost: 10, price_book_item: null },
    ]);
    const res = await request(app).get(`/api/inventory/jobs/${JOB_FIXTURE.id}/material-cost`).set(authHeader('admin'));
    expect(res.body.materialCost).toBe(130);
    expect(res.body.lineCount).toBe(2);
  });
});
