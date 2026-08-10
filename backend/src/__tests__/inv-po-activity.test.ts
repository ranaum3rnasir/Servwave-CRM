import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';
import app from '../app';
import { prisma } from '../lib/prisma';
import { mockAuthAs, authHeader } from './helpers';
import { clearPermissionCache } from '../lib/permissions/permissionCache';

// D7 — GET /api/inventory/purchase-orders/:id/activity returns a REAL timeline
// (replacing the fully-synthesized ActivityTabStub). It merges two truthful
// sources: AuditLog lifecycle verbs (created/updated/received + actor) and
// InventoryEmail sends (subject + recipients). The `inventory.po_sent` audit row
// is dropped in favour of the InventoryEmail row so a send is not double-listed.
const mockPrisma = prisma as unknown as {
  purchaseOrder: { findFirst: ReturnType<typeof vi.fn> };
  auditLog: { findMany: ReturnType<typeof vi.fn> };
  inventoryEmail: { findMany: ReturnType<typeof vi.fn> };
};

const PO_ID = 'aaaaaaa5-0000-4000-8000-000000000001';

beforeEach(() => {
  vi.clearAllMocks();
  clearPermissionCache();
});

describe('GET /api/inventory/purchase-orders/:id/activity (D7)', () => {
  it('merges audit lifecycle + email sends, drops the duplicate po_sent, sorts chronologically', async () => {
    mockAuthAs('admin');
    mockPrisma.purchaseOrder.findFirst.mockResolvedValue({ id: PO_ID });
    mockPrisma.auditLog.findMany.mockResolvedValue([
      { id: 'aud-created', action: 'inventory.po_created', actor_email: 'buyer@acme.test', metadata: { po_number: 'PO-1', vendor: 'ADI' }, created_at: new Date('2026-02-01T10:00:00Z') },
      // Same send as the InventoryEmail row below — must NOT appear twice.
      { id: 'aud-sent', action: 'inventory.po_sent', actor_email: 'buyer@acme.test', metadata: { po_number: 'PO-1', to: 'sales@adi.test' }, created_at: new Date('2026-02-02T10:00:00Z') },
      { id: 'aud-received', action: 'inventory.po_received', actor_email: 'counter@acme.test', metadata: { po_number: 'PO-1', status: 'partial', lines_received: 2 }, created_at: new Date('2026-02-04T10:00:00Z') },
    ]);
    mockPrisma.inventoryEmail.findMany.mockResolvedValue([
      { id: 'em-1', to: ['sales@adi.test', 'ap@adi.test'], subject: 'PO-1 — ADI', sent_at: new Date('2026-02-02T10:00:05Z') },
    ]);

    const res = await request(app).get(`/api/inventory/purchase-orders/${PO_ID}/activity`).set(authHeader('admin'));

    expect(res.status).toBe(200);
    const activity = res.body.activity as { id: string; at: string; kind: string; summary: string; actor: string | null; detail?: string }[];

    // Chronological (created → email → received); po_sent audit dropped entirely.
    expect(activity.map((e) => e.kind)).toEqual(['created', 'email_sent', 'received']);
    expect(activity.every((e) => e.summary !== 'inventory.po_sent')).toBe(true);

    const created = activity[0];
    expect(created).toMatchObject({ kind: 'created', summary: 'Purchase order created', actor: 'buyer@acme.test', detail: 'Vendor: ADI' });

    const email = activity[1];
    expect(email.kind).toBe('email_sent');
    expect(email.summary).toContain('sales@adi.test');
    expect(email.summary).toContain('ap@adi.test');
    expect(email.detail).toBe('PO-1 — ADI');
    expect(email.actor).toBeNull();

    const received = activity[2];
    expect(received).toMatchObject({ kind: 'received', summary: 'Received 2 lines', actor: 'counter@acme.test', detail: 'Status: partial' });
  });

  it('404s when the PO is not in the org, without reading the audit trail', async () => {
    mockAuthAs('admin');
    mockPrisma.purchaseOrder.findFirst.mockResolvedValue(null);

    const res = await request(app).get(`/api/inventory/purchase-orders/${PO_ID}/activity`).set(authHeader('admin'));

    expect(res.status).toBe(404);
    expect(mockPrisma.auditLog.findMany).not.toHaveBeenCalled();
  });

  it('404s on a malformed id via the param guard, before any Prisma read', async () => {
    mockAuthAs('admin');

    const res = await request(app).get('/api/inventory/purchase-orders/not-a-uuid/activity').set(authHeader('admin'));

    expect(res.status).toBe(404);
    expect(mockPrisma.purchaseOrder.findFirst).not.toHaveBeenCalled();
    expect(mockPrisma.auditLog.findMany).not.toHaveBeenCalled();
  });
});
