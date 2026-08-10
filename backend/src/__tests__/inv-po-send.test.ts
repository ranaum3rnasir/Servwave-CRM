import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { Mock } from 'vitest';
import request from 'supertest';
import app from '../app';
import { prisma } from '../lib/prisma';
import { sendPurchaseOrderEmail } from '../lib/email';
import { mockAuthAs, authHeader, PURCHASE_ORDER_FIXTURE, ALPHA_ORG_ID } from './helpers';
import { clearPermissionCache } from '../lib/permissions/permissionCache';

// P2 item 6 (§3.8, QA-908): REAL PO send, mirroring the estimate send pattern —
// resolve recipient → AWAIT the dispatch → only commit state (status flip +
// InventoryEmail row + timeline) once the email actually left. The only writer
// of InventoryEmail in the codebase is this path.

const mockPrisma = prisma as unknown as {
  purchaseOrder: { findFirst: ReturnType<typeof vi.fn>; update: ReturnType<typeof vi.fn> };
  inventoryEmail: { create: ReturnType<typeof vi.fn> };
  timelineEvent: { create: ReturnType<typeof vi.fn> };
  organization: { findUnique: ReturnType<typeof vi.fn> };
  $transaction: ReturnType<typeof vi.fn>;
};

const ORG_ROW = {
  id: ALPHA_ORG_ID,
  name: 'Alpha Doors',
  logo_url: null,
  brand_color: '#0C2D3A',
  currency: 'USD',
};

const VENDOR_ID = 'e2000000-0000-0000-0000-000000000001';

// Draft PO with a vendor contact on file (the default recipient source).
const DRAFT_PO = {
  ...PURCHASE_ORDER_FIXTURE,
  status: 'draft',
  vendor_id: VENDOR_ID,
  vendor_rel: { name: 'Acme Supply', contact_email: 'orders@acme.com' },
  job: null,
  job_id: null,
};

const SENT_RESULT = { status: 'sent' as const, subject: 'Purchase Order PO-1001 from Alpha Doors', html: '<html>po</html>' };

beforeEach(() => {
  vi.clearAllMocks();
  clearPermissionCache();
  mockPrisma.$transaction.mockImplementation(async (fn: any) => fn(mockPrisma));
  mockPrisma.organization.findUnique.mockResolvedValue(ORG_ROW);
  mockPrisma.purchaseOrder.findFirst.mockResolvedValue(DRAFT_PO);
  mockPrisma.purchaseOrder.update.mockResolvedValue({ ...DRAFT_PO, status: 'sent' });
  // Re-prime the default: earlier tests override the resolved value and
  // clearAllMocks does NOT restore implementations.
  (sendPurchaseOrderEmail as unknown as Mock).mockResolvedValue(SENT_RESULT);
});

describe('POST /api/inventory/purchase-orders/:id/send (P2 item 6, QA-908)', () => {
  it('sends a draft PO: awaits the email, THEN flips status + writes the InventoryEmail row', async () => {
    mockAuthAs('admin');
    const res = await request(app)
      .post(`/api/inventory/purchase-orders/${DRAFT_PO.id}/send`)
      .set(authHeader('admin'))
      .send({});

    expect(res.status).toBe(200);
    expect(res.body.purchaseOrder).toBeDefined();

    // Recipient defaults to the vendor contact; content built from the PO lines.
    const sendArgs = (sendPurchaseOrderEmail as unknown as Mock).mock.calls[0][0];
    expect(sendArgs.to).toEqual(['orders@acme.com']);
    expect(sendArgs.poNumber).toBe('PO-1001');
    expect(sendArgs.vendorName).toBe('Acme Supply');
    expect(sendArgs.currency).toBe('USD');
    expect(sendArgs.lines[0]).toMatchObject({ sku: 'LOCK-100', qtyOrdered: 5, unitCost: 20 });
    expect(sendArgs.total).toBe(100);

    // Await-then-commit ordering: the dispatch resolves BEFORE any state write.
    const sendOrder = (sendPurchaseOrderEmail as unknown as Mock).mock.invocationCallOrder[0];
    const updateOrder = mockPrisma.purchaseOrder.update.mock.invocationCallOrder[0];
    expect(sendOrder).toBeLessThan(updateOrder);

    // draft → sent
    expect(mockPrisma.purchaseOrder.update.mock.calls[0][0].data.status).toBe('sent');

    // QA-908: the InventoryEmail row carries the PO FK + transmitted content.
    const emailRow = mockPrisma.inventoryEmail.create.mock.calls[0][0].data;
    expect(emailRow.purchase_order_id).toBe(DRAFT_PO.id);
    expect(emailRow.kind).toBe('po');
    expect(emailRow.direction).toBe('out');
    expect(emailRow.to).toEqual(['orders@acme.com']);
    expect(emailRow.subject).toBe(SENT_RESULT.subject);
    expect(emailRow.body).toBe(SENT_RESULT.html);
    expect(emailRow.organization_id).toBe(ALPHA_ORG_ID);
  });

  it('writes a PO_SENT timeline event when the PO is job-linked', async () => {
    mockAuthAs('admin');
    const JOB_ID = 'a1b2c3d4-0000-0000-0000-000000000001';
    mockPrisma.purchaseOrder.findFirst.mockResolvedValue({
      ...DRAFT_PO, job_id: JOB_ID, job: { id: JOB_ID, job_number: 'J00001' },
    });

    const res = await request(app)
      .post(`/api/inventory/purchase-orders/${DRAFT_PO.id}/send`)
      .set(authHeader('admin'))
      .send({});

    expect(res.status).toBe(200);
    const evt = mockPrisma.timelineEvent.create.mock.calls[0][0].data;
    expect(evt.entity_type).toBe('JOB');
    expect(evt.entity_id).toBe(JOB_ID);
    expect(evt.event_type).toBe('PO_SENT');
    expect(evt.metadata).toMatchObject({ purchase_order_id: DRAFT_PO.id });
  });

  it('does NOT write a timeline event for an unlinked PO', async () => {
    mockAuthAs('admin');
    const res = await request(app)
      .post(`/api/inventory/purchase-orders/${DRAFT_PO.id}/send`)
      .set(authHeader('admin'))
      .send({});
    expect(res.status).toBe(200);
    expect(mockPrisma.timelineEvent.create).not.toHaveBeenCalled();
  });

  it('org_disabled skip → 409, PO state untouched, NO InventoryEmail row (QA-908)', async () => {
    mockAuthAs('admin');
    (sendPurchaseOrderEmail as unknown as Mock).mockResolvedValue({ status: 'skipped', reason: 'org_disabled' });

    const res = await request(app)
      .post(`/api/inventory/purchase-orders/${DRAFT_PO.id}/send`)
      .set(authHeader('admin'))
      .send({});

    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/disabled/i);
    expect(mockPrisma.purchaseOrder.update).not.toHaveBeenCalled();
    expect(mockPrisma.inventoryEmail.create).not.toHaveBeenCalled();
  });

  it('provider failure → 502, PO state untouched', async () => {
    mockAuthAs('admin');
    (sendPurchaseOrderEmail as unknown as Mock).mockResolvedValue({ status: 'failed', error: 'boom' });

    const res = await request(app)
      .post(`/api/inventory/purchase-orders/${DRAFT_PO.id}/send`)
      .set(authHeader('admin'))
      .send({});

    expect(res.status).toBe(502);
    expect(mockPrisma.purchaseOrder.update).not.toHaveBeenCalled();
    expect(mockPrisma.inventoryEmail.create).not.toHaveBeenCalled();
  });

  it('422 when no recipient anywhere (no body.to, no vendor contact email)', async () => {
    mockAuthAs('admin');
    mockPrisma.purchaseOrder.findFirst.mockResolvedValue({
      ...DRAFT_PO, vendor_rel: { name: 'Acme Supply', contact_email: null },
    });

    const res = await request(app)
      .post(`/api/inventory/purchase-orders/${DRAFT_PO.id}/send`)
      .set(authHeader('admin'))
      .send({});

    expect(res.status).toBe(422);
    expect(res.body.error).toMatch(/email address/i);
    expect(sendPurchaseOrderEmail).not.toHaveBeenCalled();
  });

  it('body.to (array) overrides vendor contact; cc + subject + message thread through and persist (D1)', async () => {
    mockAuthAs('admin');
    const res = await request(app)
      .post(`/api/inventory/purchase-orders/${DRAFT_PO.id}/send`)
      .set(authHeader('admin'))
      .send({ to: ['override@example.com'], cc: ['cc1@example.com'], subject: 'Custom subject', message: 'Please ship Monday.' });

    expect(res.status).toBe(200);
    const sendArgs = (sendPurchaseOrderEmail as unknown as Mock).mock.calls[0][0];
    expect(sendArgs.to).toEqual(['override@example.com']);
    expect(sendArgs.cc).toEqual(['cc1@example.com']);
    expect(sendArgs.subject).toBe('Custom subject');
    expect(sendArgs.message).toBe('Please ship Monday.');
    const emailRow = mockPrisma.inventoryEmail.create.mock.calls[0][0].data;
    expect(emailRow.to).toEqual(['override@example.com', 'cc1@example.com']);
  });

  it('accepts the real frontend payload: every To recipient reaches the mailer (regression: array-to 400) (D1)', async () => {
    mockAuthAs('admin');
    const res = await request(app)
      .post(`/api/inventory/purchase-orders/${DRAFT_PO.id}/send`)
      .set(authHeader('admin'))
      .send({ to: ['buyer@acme.com', 'ap@acme.com'], subject: 'PO for job', message: 'Notes' });

    expect(res.status).toBe(200);
    const sendArgs = (sendPurchaseOrderEmail as unknown as Mock).mock.calls[0][0];
    expect(sendArgs.to).toEqual(['buyer@acme.com', 'ap@acme.com']);
    const emailRow = mockPrisma.inventoryEmail.create.mock.calls[0][0].data;
    expect(emailRow.to).toEqual(['buyer@acme.com', 'ap@acme.com']);
  });

  it('resend from sent is allowed and never regresses status', async () => {
    mockAuthAs('admin');
    mockPrisma.purchaseOrder.findFirst.mockResolvedValue({ ...DRAFT_PO, status: 'sent' });

    const res = await request(app)
      .post(`/api/inventory/purchase-orders/${DRAFT_PO.id}/send`)
      .set(authHeader('admin'))
      .send({});

    expect(res.status).toBe(200);
    // Status is already 'sent' — no flip, but the email row is still recorded.
    expect(mockPrisma.purchaseOrder.update).not.toHaveBeenCalled();
    expect(mockPrisma.inventoryEmail.create).toHaveBeenCalledTimes(1);
  });

  it('400 for partial/received/closed POs — past the point of transmitting an order', async () => {
    mockAuthAs('admin');
    mockPrisma.purchaseOrder.findFirst.mockResolvedValue({ ...DRAFT_PO, status: 'partial' });

    const res = await request(app)
      .post(`/api/inventory/purchase-orders/${DRAFT_PO.id}/send`)
      .set(authHeader('admin'))
      .send({});

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/draft or sent/i);
    expect(sendPurchaseOrderEmail).not.toHaveBeenCalled();
  });

  it('404 for an unknown/cross-org PO', async () => {
    mockAuthAs('admin');
    mockPrisma.purchaseOrder.findFirst.mockResolvedValue(null);
    const res = await request(app)
      .post(`/api/inventory/purchase-orders/${DRAFT_PO.id}/send`)
      .set(authHeader('admin'))
      .send({});
    expect(res.status).toBe(404);
  });

  it('400 on an invalid recipient (Zod)', async () => {
    mockAuthAs('admin');
    const res = await request(app)
      .post(`/api/inventory/purchase-orders/${DRAFT_PO.id}/send`)
      .set(authHeader('admin'))
      .send({ to: ['not-an-email'] });
    expect(res.status).toBe(400);
    expect(sendPurchaseOrderEmail).not.toHaveBeenCalled();
  });

  it('gate: SALES 403s, DISPATCHER passes (update PurchaseOrder)', async () => {
    mockAuthAs('sales');
    const salesRes = await request(app)
      .post(`/api/inventory/purchase-orders/${DRAFT_PO.id}/send`)
      .set(authHeader('sales'))
      .send({});
    expect(salesRes.status).toBe(403);

    mockAuthAs('dispatcher');
    const dispatcherRes = await request(app)
      .post(`/api/inventory/purchase-orders/${DRAFT_PO.id}/send`)
      .set(authHeader('dispatcher'))
      .send({});
    expect(dispatcherRes.status).toBe(200);
  });
});
