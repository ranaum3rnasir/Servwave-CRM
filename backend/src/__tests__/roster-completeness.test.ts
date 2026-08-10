import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';
import app from '../app';
import { prisma } from '../lib/prisma';
import { mockAuthAs, authHeader, ALPHA_ORG_ID } from './helpers';
import { DEFAULT_GRANTS } from '../lib/permissions/defaultGrants';
import { clearPermissionCache } from '../lib/permissions/permissionCache';

const mockPrisma = prisma as any;

beforeEach(() => {
  vi.clearAllMocks();
  clearPermissionCache();
  mockAuthAs('admin');
  mockPrisma.rolePermission.findMany.mockImplementation((a: any) =>
    Promise.resolve(DEFAULT_GRANTS.filter((g) => g.role === a.where.role)));
  mockPrisma.user.findMany.mockResolvedValue([]);
});

describe('GET /api/users?include_referenced_in=jobs', () => {
  it('ORs referenced job assignees into the roster where-clause', async () => {
    await request(app).get('/api/users?include_referenced_in=jobs').set(authHeader('admin'));
    const where = mockPrisma.user.findMany.mock.calls[0][0].where;
    expect(where.OR).toEqual(expect.arrayContaining([
      expect.objectContaining({ job_crew_memberships: { some: {} } }),
    ]));
    // still tenant-scoped
    expect(where.organization_id ?? where.AND).toBeDefined();
  });
});

describe('GET /api/users?include_referenced_in=leads', () => {
  it('ORs referenced lead owners + crew into the roster where-clause', async () => {
    await request(app).get('/api/users?include_referenced_in=leads').set(authHeader('admin'));
    const where = mockPrisma.user.findMany.mock.calls[0][0].where;
    expect(where.OR).toEqual(expect.arrayContaining([
      expect.objectContaining({ lead_crew_memberships: { some: {} } }),
      expect.objectContaining({ commission_owned_leads: { some: {} } }),
    ]));
  });
});

describe('GET /api/estimates/creators', () => {
  it('unions active ADMIN/SALES with distinct actual creators (any role/status)', async () => {
    await request(app).get('/api/estimates/creators').set(authHeader('admin'));
    const where = mockPrisma.user.findMany.mock.calls[0][0].where;
    expect(where.OR).toEqual(expect.arrayContaining([
      expect.objectContaining({ is_active: true, role: { in: ['ADMIN', 'SALES'] } }),
      expect.objectContaining({ created_estimates: { some: {} } }),
    ]));
  });
});
