import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';
import app from '../app';
import { prisma } from '../lib/prisma';
import {
  mockAuthAs, authHeader,
  CUSTOMER_FIXTURE, ESTIMATE_FIXTURE, INVOICE_FIXTURE, TAG_FIXTURE, JOB_FIXTURE, LEAD_FIXTURE,
} from './helpers';
import { clearPermissionCache } from '../lib/permissions/permissionCache';
import { clearUserOverrideCache } from '../lib/permissions/userOverrideCache';
import { DEFAULT_GRANTS } from '../lib/permissions/defaultGrants';

const mockPrisma = prisma as unknown as {
  customer: { findFirst: ReturnType<typeof vi.fn> };
  estimate: { findFirst: ReturnType<typeof vi.fn> };
  invoice: { findFirst: ReturnType<typeof vi.fn> };
  job: { findFirst: ReturnType<typeof vi.fn> };
  lead: { findFirst: ReturnType<typeof vi.fn> };
  tag: { findFirst: ReturnType<typeof vi.fn>; findUnique: ReturnType<typeof vi.fn>; create: ReturnType<typeof vi.fn> };
  tagAssignment: { findUnique: ReturnType<typeof vi.fn>; create: ReturnType<typeof vi.fn>; delete: ReturnType<typeof vi.fn> };
  rolePermission: { findMany: ReturnType<typeof vi.fn> };
};

beforeEach(() => {
  vi.clearAllMocks();
  clearPermissionCache();
  clearUserOverrideCache();
  mockPrisma.tag.findFirst.mockResolvedValue({ id: TAG_FIXTURE.id, name: 'Urgent', color: '#EF4444' });
  mockPrisma.tag.findUnique.mockResolvedValue({ id: TAG_FIXTURE.id, name: 'Urgent', color: '#EF4444' });
  mockPrisma.tagAssignment.findUnique.mockResolvedValue(null);
  mockPrisma.tagAssignment.create.mockResolvedValue({ tag_id: TAG_FIXTURE.id });
  mockPrisma.tagAssignment.delete.mockResolvedValue({});
});

describe('POST /api/customers/:id/tags', () => {
  it('attaches an existing tag to a customer by tag_id (201)', async () => {
    mockAuthAs('admin');
    mockPrisma.customer.findFirst.mockResolvedValue({ id: CUSTOMER_FIXTURE.id });

    const res = await request(app)
      .post(`/api/customers/${CUSTOMER_FIXTURE.id}/tags`)
      .set(authHeader('admin'))
      .send({ tag_id: TAG_FIXTURE.id });

    expect(res.status).toBe(201);
    expect(res.body.tag.name).toBe('Urgent');
    const args = mockPrisma.tagAssignment.create.mock.calls[0][0];
    expect(args.data.entity_type).toBe('CUSTOMER');
    expect(args.data.entity_id).toBe(CUSTOMER_FIXTURE.id);
  });

  it('returns 404 when the customer does not exist', async () => {
    mockAuthAs('admin');
    mockPrisma.customer.findFirst.mockResolvedValue(null);

    const res = await request(app)
      .post(`/api/customers/${CUSTOMER_FIXTURE.id}/tags`)
      .set(authHeader('admin'))
      .send({ tag_id: TAG_FIXTURE.id });

    expect(res.status).toBe(404);
  });

  // SRVW-105 step 12 - the entity-existence check must run BEFORE the tag resolve/find-or-create,
  // exactly as it does today (tag.controller.ts entityExistsInOrg runs first). A two-way split that
  // resolved the tag first would CREATE a Tag row before 404ing on a nonexistent customer - a new
  // write on a 404 path. tag.test.ts's existing 404 case above asserts only the status code and
  // would stay green if that reorder happened; this locks the order through the refactor.
  it('404s on an unknown customer WITHOUT creating a tag', async () => {
    mockAuthAs('admin');
    mockPrisma.customer.findFirst.mockResolvedValue(null);

    const res = await request(app)
      .post(`/api/customers/${CUSTOMER_FIXTURE.id}/tags`)
      .set(authHeader('admin'))
      .send({ name: 'New' });

    expect(res.status).toBe(404);
    expect(mockPrisma.tag.create).not.toHaveBeenCalled();
    expect(mockPrisma.tag.findUnique).not.toHaveBeenCalled();
  });
});

describe('POST /api/estimates/:id/tags', () => {
  it('attaches a tag to an estimate (201)', async () => {
    mockAuthAs('admin');
    mockPrisma.estimate.findFirst.mockResolvedValue({ id: ESTIMATE_FIXTURE.id });

    const res = await request(app)
      .post(`/api/estimates/${ESTIMATE_FIXTURE.id}/tags`)
      .set(authHeader('admin'))
      .send({ tag_id: TAG_FIXTURE.id });

    expect(res.status).toBe(201);
    const args = mockPrisma.tagAssignment.create.mock.calls[0][0];
    expect(args.data.entity_type).toBe('ESTIMATE');
  });
});

describe('POST /api/invoices/:id/tags', () => {
  it('attaches a tag to an invoice (201)', async () => {
    mockAuthAs('admin');
    mockPrisma.invoice.findFirst.mockResolvedValue({ id: INVOICE_FIXTURE.id });

    const res = await request(app)
      .post(`/api/invoices/${INVOICE_FIXTURE.id}/tags`)
      .set(authHeader('admin'))
      .send({ tag_id: TAG_FIXTURE.id });

    expect(res.status).toBe(201);
    const args = mockPrisma.tagAssignment.create.mock.calls[0][0];
    expect(args.data.entity_type).toBe('INVOICE');
  });
});

// ─── Row-scope gate (tag row-scope fix, 2026-08-05) ─────────────────────────
// canDo('update', subject) is SUBJECT-level (no row loaded), so it cannot evaluate a row
// condition like OWN_JOB - it passes for every row once the role holds the bare grant.
// entityExistsInOrg only checks org tenancy. Net effect before this fix: a technician who can
// `update Job` (an unconditional role default) could tag ANY job in the org, not just one it's
// assigned to or created - despite read/delete/assign/manage_lines on the same subject all being
// properly row-scoped. These tests pin the fix: a per-instance canAccessRow gate, keyed off the
// subject's READ scope (mirrors job.controller.ts's own update/delete pattern), applied after the
// existing existence check and before the tag mutation. CUSTOMER is excluded - it has no
// ScopeResource / row-scoping concept anywhere in the codebase to be inconsistent with.

describe('POST /api/jobs/:id/tags - row-scope gate', () => {
  it('403s a TECHNICIAN neither assigned to nor the creator of the job', async () => {
    mockAuthAs('technician');
    // entityExistsInOrg's tenant-only probe finds the row; canAccessRow's SCOPED probe (its
    // `where` carries the OWN_OR_CREATED_JOB `OR`) finds nothing - the technician has no claim.
    mockPrisma.job.findFirst.mockImplementation((args: { where: Record<string, unknown> }) =>
      Promise.resolve(args.where.OR ? null : { id: JOB_FIXTURE.id }));

    const res = await request(app)
      .post(`/api/jobs/${JOB_FIXTURE.id}/tags`)
      .set(authHeader('technician'))
      .send({ tag_id: TAG_FIXTURE.id });

    expect(res.status).toBe(403);
    expect(mockPrisma.tagAssignment.create).not.toHaveBeenCalled();
  });

  it('allows a TECHNICIAN whose scope matches the job (201)', async () => {
    mockAuthAs('technician');
    mockPrisma.job.findFirst.mockResolvedValue({ id: JOB_FIXTURE.id });

    const res = await request(app)
      .post(`/api/jobs/${JOB_FIXTURE.id}/tags`)
      .set(authHeader('technician'))
      .send({ tag_id: TAG_FIXTURE.id });

    expect(res.status).toBe(201);
  });
});

describe('DELETE /api/jobs/:id/tags/:tagId - row-scope gate', () => {
  it('403s a TECHNICIAN neither assigned to nor the creator of the job', async () => {
    mockAuthAs('technician');
    mockPrisma.job.findFirst.mockImplementation((args: { where: Record<string, unknown> }) =>
      Promise.resolve(args.where.OR ? null : { id: JOB_FIXTURE.id }));
    mockPrisma.tagAssignment.findUnique.mockResolvedValue({ tag_id: TAG_FIXTURE.id });

    const res = await request(app)
      .delete(`/api/jobs/${JOB_FIXTURE.id}/tags/${TAG_FIXTURE.id}`)
      .set(authHeader('technician'));

    expect(res.status).toBe(403);
    expect(mockPrisma.tagAssignment.delete).not.toHaveBeenCalled();
  });
});

describe('POST /api/leads/:id/tags - row-scope gate', () => {
  it('403s a SALES rep not assigned to the lead', async () => {
    mockAuthAs('sales');
    // OWN_LEAD's scoped probe carries `lead_assignees`; the tenant-only existence probe doesn't.
    mockPrisma.lead.findFirst.mockImplementation((args: { where: Record<string, unknown> }) =>
      Promise.resolve(args.where.lead_assignees ? null : { id: LEAD_FIXTURE.id }));

    const res = await request(app)
      .post(`/api/leads/${LEAD_FIXTURE.id}/tags`)
      .set(authHeader('sales'))
      .send({ tag_id: TAG_FIXTURE.id });

    expect(res.status).toBe(403);
    expect(mockPrisma.tagAssignment.create).not.toHaveBeenCalled();
  });

  it('allows a SALES rep assigned to the lead (201)', async () => {
    mockAuthAs('sales');
    mockPrisma.lead.findFirst.mockResolvedValue({ id: LEAD_FIXTURE.id });

    const res = await request(app)
      .post(`/api/leads/${LEAD_FIXTURE.id}/tags`)
      .set(authHeader('sales'))
      .send({ tag_id: TAG_FIXTURE.id });

    expect(res.status).toBe(201);
  });
});

describe('DELETE /api/leads/:id/tags/:tagId - row-scope gate', () => {
  it('403s a SALES rep not assigned to the lead', async () => {
    mockAuthAs('sales');
    mockPrisma.lead.findFirst.mockImplementation((args: { where: Record<string, unknown> }) =>
      Promise.resolve(args.where.lead_assignees ? null : { id: LEAD_FIXTURE.id }));
    mockPrisma.tagAssignment.findUnique.mockResolvedValue({ tag_id: TAG_FIXTURE.id });

    const res = await request(app)
      .delete(`/api/leads/${LEAD_FIXTURE.id}/tags/${TAG_FIXTURE.id}`)
      .set(authHeader('sales'));

    expect(res.status).toBe(403);
    expect(mockPrisma.tagAssignment.delete).not.toHaveBeenCalled();
  });
});

describe('POST /api/estimates/:id/tags - row-scope gate', () => {
  it('403s a SALES rep who cannot READ this estimate, even though update Estimate is unconditional', async () => {
    mockAuthAs('sales');
    // SALES's `update Estimate` grant is unconditional (defaultGrants.ts) - the OLD subject-level
    // canDo guard alone would let this through. Its `read Estimate` grant
    // (OWN_ESTIMATE_VIA_LEAD_OR_CREATOR) is conditional, and canAccessRow keys off READ, not
    // update - matching how estimate.controller.ts's own mutation handlers already gate via
    // canAccessEstimate despite the same unconditional route-level grant.
    mockPrisma.estimate.findFirst.mockImplementation((args: { where: Record<string, unknown> }) =>
      Promise.resolve(args.where.OR ? null : { id: ESTIMATE_FIXTURE.id }));

    const res = await request(app)
      .post(`/api/estimates/${ESTIMATE_FIXTURE.id}/tags`)
      .set(authHeader('sales'))
      .send({ tag_id: TAG_FIXTURE.id });

    expect(res.status).toBe(403);
    expect(mockPrisma.tagAssignment.create).not.toHaveBeenCalled();
  });
});

describe('DELETE /api/estimates/:id/tags/:tagId - row-scope gate', () => {
  it('403s a SALES rep who cannot READ this estimate', async () => {
    mockAuthAs('sales');
    mockPrisma.estimate.findFirst.mockImplementation((args: { where: Record<string, unknown> }) =>
      Promise.resolve(args.where.OR ? null : { id: ESTIMATE_FIXTURE.id }));
    mockPrisma.tagAssignment.findUnique.mockResolvedValue({ tag_id: TAG_FIXTURE.id });

    const res = await request(app)
      .delete(`/api/estimates/${ESTIMATE_FIXTURE.id}/tags/${TAG_FIXTURE.id}`)
      .set(authHeader('sales'));

    expect(res.status).toBe(403);
    expect(mockPrisma.tagAssignment.delete).not.toHaveBeenCalled();
  });
});

describe('POST /api/invoices/:id/tags - row-scope gate', () => {
  // No DEFAULT role today holds BOTH a conditional `read Invoice` and `update Invoice` grant
  // (DISPATCHER/ADMIN, the only roles with `update Invoice`, both read Invoice unconditionally) -
  // so there is no realistic default-role 403 to exercise here. This proves the MECHANISM is
  // correctly wired for Invoice too (not skipped), for the day a per-user override or a future
  // role narrows `read Invoice` to conditional while keeping `update Invoice`.
  it('403s a DISPATCHER whose read Invoice grant is narrowed to conditional and does not match this invoice', async () => {
    mockAuthAs('dispatcher');
    (prisma.rolePermission.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([
      ...DEFAULT_GRANTS.filter((g) => g.role === 'DISPATCHER' && !(g.action === 'read' && g.subject === 'Invoice')),
      { role: 'DISPATCHER', action: 'read', subject: 'Invoice', conditions: { job: { assignees: { some: { user_id: '{{userId}}' } } } } },
    ]);
    mockPrisma.invoice.findFirst.mockImplementation((args: { where: Record<string, unknown> }) =>
      Promise.resolve(args.where.job ? null : { id: INVOICE_FIXTURE.id }));

    const res = await request(app)
      .post(`/api/invoices/${INVOICE_FIXTURE.id}/tags`)
      .set(authHeader('dispatcher'))
      .send({ tag_id: TAG_FIXTURE.id });

    expect(res.status).toBe(403);
    expect(mockPrisma.tagAssignment.create).not.toHaveBeenCalled();
  });
});

// ─── POST /api/customers/bulk-tag ───────────────────────
// Exercises bulkAddTagToCustomers(), which resolves the tag ONCE for the whole batch (so a new
// `name` mints exactly one Tag row, not N racing creates against @@unique(organization_id, name)),
// then loops ensureEntityInOrg + attachTagAssignment per id - same order the single-row factory
// (addTagToEntity) uses.
describe('POST /api/customers/bulk-tag', () => {
  const CUST_A = 'd1000000-0000-0000-0000-000000000001';
  const CUST_B = 'd1000000-0000-0000-0000-000000000002';
  const CUST_C = 'd1000000-0000-0000-0000-000000000003';
  const TAGGED_ID = 'd1000000-0000-0000-0000-000000000004';
  const MISSING_ID = 'd1000000-0000-0000-0000-000000000005';

  it('creates a named tag exactly once for the whole batch', async () => {
    mockAuthAs('admin');
    mockPrisma.customer.findFirst.mockResolvedValue({ id: CUST_A });
    mockPrisma.tag.findUnique.mockResolvedValue(null);
    mockPrisma.tag.create.mockResolvedValue({ id: 'new-tag-id', name: 'New', color: '#6B7280' });
    mockPrisma.tagAssignment.findUnique.mockResolvedValue(null);
    mockPrisma.tagAssignment.create.mockResolvedValue({});

    const res = await request(app)
      .post('/api/customers/bulk-tag')
      .set(authHeader('admin'))
      .send({ ids: [CUST_A, CUST_B, CUST_C], name: 'New' });

    expect(res.status).toBe(200);
    expect(mockPrisma.tag.create).toHaveBeenCalledTimes(1);
    expect(mockPrisma.tagAssignment.create).toHaveBeenCalledTimes(3);
    expect(res.body.tagged.sort()).toEqual([CUST_A, CUST_B, CUST_C].sort());
  });

  it('isolates an already-tagged id and a cross-org id into failed', async () => {
    mockAuthAs('admin');
    mockPrisma.customer.findFirst.mockImplementation((args: { where: { id: string } }) =>
      Promise.resolve(args.where.id === MISSING_ID ? null : { id: args.where.id }));
    mockPrisma.tagAssignment.findUnique.mockImplementation((args: { where: { tag_id_entity_type_entity_id: { entity_id: string } } }) =>
      Promise.resolve(args.where.tag_id_entity_type_entity_id.entity_id === TAGGED_ID ? { tag_id: TAG_FIXTURE.id } : null));
    mockPrisma.tagAssignment.create.mockResolvedValue({});

    const res = await request(app)
      .post('/api/customers/bulk-tag')
      .set(authHeader('admin'))
      .send({ ids: [CUST_A, TAGGED_ID, MISSING_ID], tag_id: TAG_FIXTURE.id });

    expect(res.status).toBe(200);
    expect(res.body.tagged).toEqual([CUST_A]);
    expect(res.body.failed).toEqual(
      expect.arrayContaining([
        { id: TAGGED_ID, error: 'Tag already attached to this customer' },
        { id: MISSING_ID, error: 'customer not found' },
      ]),
    );
  });

  it('rejects more than 100 ids at the validation layer', async () => {
    mockAuthAs('admin');
    const ids = Array.from({ length: 101 }, (_, i) => `d2000000-0000-0000-0000-${String(i).padStart(12, '0')}`);

    const res = await request(app)
      .post('/api/customers/bulk-tag')
      .set(authHeader('admin'))
      .send({ ids, tag_id: TAG_FIXTURE.id });

    expect(res.status).toBe(400);
  });
});
