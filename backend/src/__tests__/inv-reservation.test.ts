import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';
import app from '../app';
import { prisma } from '../lib/prisma';
import { mockAuthAs, authHeader, ALPHA_ORG_ID, LEAD_FIXTURE, CUSTOMER_FIXTURE, ESTIMATE_SENT_FIXTURE, PRICE_BOOK_ITEM_FIXTURE } from './helpers';
import { clearPermissionCache } from '../lib/permissions/permissionCache';

const mockPrisma = prisma as unknown as {
  estimate: { findFirst: ReturnType<typeof vi.fn>; findUnique: ReturnType<typeof vi.fn>; update: ReturnType<typeof vi.fn> };
  estimateReservation: { findFirst: ReturnType<typeof vi.fn>; create: ReturnType<typeof vi.fn> };
  lead: { updateMany: ReturnType<typeof vi.fn> };
  customer: { findFirst: ReturnType<typeof vi.fn> };
  priceBookItem: { findMany: ReturnType<typeof vi.fn> };
  timelineEvent: { create: ReturnType<typeof vi.fn> };
  $transaction: ReturnType<typeof vi.fn>;
};

beforeEach(() => { vi.clearAllMocks(); clearPermissionCache(); });

describe('Estimate approval auto-creates an EstimateReservation (V2/D4)', () => {
  it('creates a reservation linked to the estimate + customer on no-deposit approval', async () => {
    const token = 'tok-123';
    const existing = {
      id: ESTIMATE_SENT_FIXTURE.id, status: 'SENT', estimate_number: 'E00002',
      lead_id: LEAD_FIXTURE.id, organization_id: ALPHA_ORG_ID,
      total_amount: 1062.5, valid_until: null, signature_data: null,
      deposit: null,
      // Spec #1751 D6: approvePublic reads the lead's CURRENT status off this row and hands it to
      // the one status writer as the ledger entry's `from`. It is in the door's select; the
      // fixture predates the column.
      lead: { commission_owner_id: null, status: 'ESTIMATED' },
      send_config: { deposit_required: false, payment_methods: [] },
      organization: { id: ALPHA_ORG_ID, stripe_account_id: null, accepted_payment_methods: [] },
    };
    mockPrisma.estimate.findFirst.mockResolvedValue(existing);
    mockPrisma.estimate.update.mockResolvedValue({ id: existing.id, status: 'WON', estimate_number: 'E00002' });
    mockPrisma.lead.updateMany.mockResolvedValue({ count: 1 });
    mockPrisma.timelineEvent.create.mockResolvedValue({});
    mockPrisma.estimateReservation.findFirst.mockResolvedValue(null); // no existing reservation
    mockPrisma.estimate.findUnique.mockResolvedValue({
      estimate_number: 'E00002', approved_at: new Date(),
      lead: { customer_id: CUSTOMER_FIXTURE.id, customer: { first_name: 'John', last_name: 'Doe', company_name: 'Doe HVAC', email: 'john@doe.com' } },
      line_items: [
        // price_book_item ride-along mirrors the controller's SKU-resolving select —
        // estimate lines carry no SKU column, so the reservation snapshot takes it from
        // the linked catalog item (a blank item_sku makes the reservation→PO line
        // unreceivable; the receive contract is SKU-keyed).
        { description: 'Deadbolt', quantity: 2, unit_price: 40, line_total: 80, price_book_item_id: PRICE_BOOK_ITEM_FIXTURE.id, price_book_item: { sku: 'LOCK-100' } },
      ],
    });
    mockPrisma.estimateReservation.create.mockResolvedValue({ id: 'res00000-0000-0000-0000-000000000001' });
    mockPrisma.$transaction.mockImplementation(async (fn: any) => fn(mockPrisma));

    const res = await request(app)
      .post(`/api/estimates/${existing.id}/approve?token=${token}`)
      .send({ signature_data: 'data:image/png;base64,xxx' });

    expect(res.status).toBe(200);
    expect(mockPrisma.estimateReservation.create).toHaveBeenCalled();
    const data = mockPrisma.estimateReservation.create.mock.calls[0][0].data;
    expect(data.estimate_id).toBe(existing.id);
    expect(data.customer_id).toBe(CUSTOMER_FIXTURE.id);
    expect(data.lines.create[0].item_sku).toBe('LOCK-100');
    // SRVW-90: only MATERIAL lines are snapshotted, which is exactly why an item
    // mis-typed as SERVICE never reaches the reservation -> PO chain.
    expect(mockPrisma.estimate.findUnique.mock.calls[0][0].select.line_items.where).toEqual({
      item_type: 'MATERIAL',
    });
  });
});

describe('POST /api/inventory/estimate-reservations (V2/B2)', () => {
  it('creates a reservation with org-validated FKs', async () => {
    mockAuthAs('admin');
    mockPrisma.estimate.findFirst.mockResolvedValue({ id: ESTIMATE_SENT_FIXTURE.id });
    mockPrisma.customer.findFirst.mockResolvedValue({ id: CUSTOMER_FIXTURE.id });
    mockPrisma.priceBookItem.findMany.mockResolvedValue([{ id: PRICE_BOOK_ITEM_FIXTURE.id, sku: 'LOCK-100' }]);
    mockPrisma.estimateReservation.create.mockResolvedValue({
      id: 'res00000-0000-0000-0000-000000000001', estimate_number: 'E00002',
      customer: 'John Doe', approved_at: new Date(), reserved_total: 80,
      lines_summary: { items: 1, units: 2 }, lines: [], emails: [], organization_id: ALPHA_ORG_ID,
    });
    const res = await request(app).post('/api/inventory/estimate-reservations').set(authHeader('admin')).send({
      estimateId: ESTIMATE_SENT_FIXTURE.id, estimateNumber: 'E00002', customerId: CUSTOMER_FIXTURE.id,
      customer: 'John Doe', approvedAt: new Date().toISOString(), reservedTotal: 80,
      linesSummary: { items: 1, units: 2 },
      lines: [{ itemSku: 'LOCK-100', itemName: 'Deadbolt', qty: 2, uom: 'EA' }],
    });
    expect(res.status).toBe(201);
    expect(mockPrisma.estimateReservation.create.mock.calls[0][0].data.estimate_id).toBe(ESTIMATE_SENT_FIXTURE.id);
  });
  it('rejects an estimateId from another org', async () => {
    mockAuthAs('admin');
    mockPrisma.estimate.findFirst.mockResolvedValue(null);
    const res = await request(app).post('/api/inventory/estimate-reservations').set(authHeader('admin')).send({
      estimateId: '99999999-9999-9999-9999-999999999999', estimateNumber: 'E9', customer: 'X',
      approvedAt: new Date().toISOString(), reservedTotal: 0, linesSummary: { items: 0, units: 0 }, lines: [],
    });
    expect(res.status).toBe(400);
  });
});
