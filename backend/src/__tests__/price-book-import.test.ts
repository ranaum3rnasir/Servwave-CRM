import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';
import app from '../app';
import { prisma } from '../lib/prisma';
import { mockAuthAs, authHeader, ALPHA_ORG_ID, PRICE_BOOK_ITEM_FIXTURE } from './helpers';
import { clearPermissionCache } from '../lib/permissions/permissionCache';

// P0 §D3 (QA-107 / A-16): CSV import is per-row upsert-by-(org, sku) with
// per-row error isolation — one bad row never aborts the batch, and a dup-SKU
// row becomes an update. Response: 200 {created, updated, errors:[{index,message}]}.

const mockPrisma = prisma as unknown as {
  priceBookItem: {
    findFirst: ReturnType<typeof vi.fn>;
    create: ReturnType<typeof vi.fn>;
    update: ReturnType<typeof vi.fn>;
  };
  $transaction: ReturnType<typeof vi.fn>;
};

beforeEach(() => { vi.clearAllMocks(); clearPermissionCache(); });

describe('POST /api/price-book/items/import', () => {
  it('mixed batch: new row created, dup-SKU row updated, malformed row errored — nothing aborts', async () => {
    mockAuthAs('admin');
    // Row 0 (new SKU): no existing match → create.
    // Row 1 (existing SKU): match → update.
    // Row 2 (malformed: no name) → per-row validation error.
    mockPrisma.priceBookItem.findFirst
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ id: PRICE_BOOK_ITEM_FIXTURE.id, sku: 'LOCK-100', organization_id: ALPHA_ORG_ID });
    mockPrisma.priceBookItem.create.mockResolvedValue(PRICE_BOOK_ITEM_FIXTURE);
    mockPrisma.priceBookItem.update.mockResolvedValue(PRICE_BOOK_ITEM_FIXTURE);

    const res = await request(app).post('/api/price-book/items/import').set(authHeader('admin'))
      .send({
        items: [
          { name: 'Hinge', sku: 'HINGE-200', sellPrice: 12.5, unitCost: 6, uom: 'EA' },
          { name: 'Deadbolt Lock', sku: 'LOCK-100', sellPrice: 45, unitCost: 22 },
          { sku: 'BROKEN-1', sellPrice: 10 }, // no name → row error
        ],
      });

    expect(res.status).toBe(200);
    expect(res.body.created).toBe(1);
    expect(res.body.updated).toBe(1);
    expect(res.body.errors).toHaveLength(1);
    expect(res.body.errors[0].index).toBe(2);
    expect(mockPrisma.priceBookItem.create).toHaveBeenCalledTimes(1);
    expect(mockPrisma.priceBookItem.update).toHaveBeenCalledTimes(1);
  });

  it('mirrors sellPrice into unit_price AND sell_price on create', async () => {
    mockAuthAs('admin');
    mockPrisma.priceBookItem.findFirst.mockResolvedValue(null);
    mockPrisma.priceBookItem.create.mockResolvedValue(PRICE_BOOK_ITEM_FIXTURE);

    const res = await request(app).post('/api/price-book/items/import').set(authHeader('admin'))
      .send({ items: [{ name: 'Hinge', sku: 'HINGE-200', sellPrice: 12.5 }] });

    expect(res.status).toBe(200);
    const data = mockPrisma.priceBookItem.create.mock.calls[0][0].data;
    expect(data.unit_price).toBe(12.5);
    expect(data.sell_price).toBe(12.5);
    expect(data.organization_id).toBe(ALPHA_ORG_ID);
  });

  it('a DB error on one row is captured per-row and the loop continues', async () => {
    mockAuthAs('admin');
    mockPrisma.priceBookItem.findFirst.mockResolvedValue(null);
    mockPrisma.priceBookItem.create
      .mockRejectedValueOnce(Object.assign(new Error('duplicate'), { code: 'P2002' }))
      .mockResolvedValueOnce(PRICE_BOOK_ITEM_FIXTURE);

    const res = await request(app).post('/api/price-book/items/import').set(authHeader('admin'))
      .send({
        items: [
          { name: 'Race Dup', sku: 'DUP-1', sellPrice: 5 },
          { name: 'Fine Row', sku: 'OK-1', sellPrice: 7 },
        ],
      });

    expect(res.status).toBe(200);
    expect(res.body.created).toBe(1);
    expect(res.body.errors).toHaveLength(1);
    expect(res.body.errors[0].index).toBe(0);
  });

  it('runs without a wrapping transaction (rows are independent)', async () => {
    mockAuthAs('admin');
    mockPrisma.priceBookItem.findFirst.mockResolvedValue(null);
    mockPrisma.priceBookItem.create.mockResolvedValue(PRICE_BOOK_ITEM_FIXTURE);

    await request(app).post('/api/price-book/items/import').set(authHeader('admin'))
      .send({ items: [{ name: 'Hinge', sellPrice: 12.5 }] });

    expect(mockPrisma.$transaction).not.toHaveBeenCalled();
  });

  it('rejects an empty batch at the envelope (400)', async () => {
    mockAuthAs('admin');
    const res = await request(app).post('/api/price-book/items/import').set(authHeader('admin'))
      .send({ items: [] });
    expect(res.status).toBe(400);
  });

  // SRVW-90 - the CSV door derives `type` from `kind` exactly as the UI door does.
  it('a kind=material row is created as MATERIAL', async () => {
    mockAuthAs('admin');
    mockPrisma.priceBookItem.findFirst.mockResolvedValue(null);
    mockPrisma.priceBookItem.create.mockResolvedValue(PRICE_BOOK_ITEM_FIXTURE);

    const res = await request(app).post('/api/price-book/items/import').set(authHeader('admin'))
      .send({ items: [{ name: 'Deadbolt', sku: 'LOCK-900', sellPrice: 45, kind: 'material' }] });

    expect(res.status).toBe(200);
    expect(mockPrisma.priceBookItem.create.mock.calls[0][0].data.type).toBe('MATERIAL');
  });

  it('a kind=labor row and a kind-less row are created as SERVICE', async () => {
    mockAuthAs('admin');
    mockPrisma.priceBookItem.findFirst.mockResolvedValue(null);
    mockPrisma.priceBookItem.create.mockResolvedValue(PRICE_BOOK_ITEM_FIXTURE);

    const res = await request(app).post('/api/price-book/items/import').set(authHeader('admin'))
      .send({
        items: [
          { name: 'Install hour', sku: 'LAB-1', sellPrice: 95, kind: 'labor' },
          { name: 'Mystery row', sku: 'MYS-1', sellPrice: 10 },
        ],
      });

    expect(res.status).toBe(200);
    expect(mockPrisma.priceBookItem.create.mock.calls[0][0].data.type).toBe('SERVICE');
    expect(mockPrisma.priceBookItem.create.mock.calls[1][0].data.type).toBe('SERVICE');
  });

  it('a dup-SKU row with kind=material repoints the existing item type', async () => {
    mockAuthAs('admin');
    mockPrisma.priceBookItem.findFirst.mockResolvedValue({ id: PRICE_BOOK_ITEM_FIXTURE.id });
    mockPrisma.priceBookItem.update.mockResolvedValue(PRICE_BOOK_ITEM_FIXTURE);

    const res = await request(app).post('/api/price-book/items/import').set(authHeader('admin'))
      .send({ items: [{ name: 'Deadbolt', sku: 'LOCK-100', sellPrice: 45, kind: 'material' }] });

    expect(res.status).toBe(200);
    expect(mockPrisma.priceBookItem.update.mock.calls[0][0].data.type).toBe('MATERIAL');
  });

  it('a dup-SKU row with no kind leaves type alone', async () => {
    mockAuthAs('admin');
    mockPrisma.priceBookItem.findFirst.mockResolvedValue({ id: PRICE_BOOK_ITEM_FIXTURE.id });
    mockPrisma.priceBookItem.update.mockResolvedValue(PRICE_BOOK_ITEM_FIXTURE);

    const res = await request(app).post('/api/price-book/items/import').set(authHeader('admin'))
      .send({ items: [{ name: 'Deadbolt', sku: 'LOCK-100', sellPrice: 45 }] });

    expect(res.status).toBe(200);
    expect(mockPrisma.priceBookItem.update.mock.calls[0][0].data).not.toHaveProperty('type');
  });
});
