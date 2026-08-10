import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Request, Response, NextFunction } from 'express';
import { authenticate, clearTokenCache } from '../authenticate';
import { supabaseAdmin } from '../../lib/supabase';
import { prisma } from '../../lib/prisma';

function mockRes(): Response {
  return { status: vi.fn().mockReturnThis(), json: vi.fn().mockReturnThis() } as unknown as Response;
}
function mockNext(): NextFunction {
  return vi.fn() as unknown as NextFunction;
}

const ORG = { is_demo: false, plan: 'SCALE', trial_ends_at: null, feature_overrides: {} };

describe('authenticate - SRVW-138 custom-role bridge', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearTokenCache();
  });

  it('carries custom_role_id and custom_role.key from the DB row onto req.user', async () => {
    (supabaseAdmin.auth.getUser as ReturnType<typeof vi.fn>).mockResolvedValue({
      data: { user: { id: 'u1', email: 'u1@test.com' } },
      error: null,
    });
    (prisma.user.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({
      id: 'u1',
      email: 'u1@test.com',
      first_name: 'T',
      last_name: 'U',
      role: 'ADMIN',
      custom_role_id: 'cr-1',
      custom_role: { key: 'office-manager' },
      is_active: true,
      has_login: true,
      organization_id: 'org-1',
      department_id: null,
      location_id: null,
      phone: null,
      phone_ext: null,
      organization: ORG,
    });

    const req = { headers: { authorization: 'Bearer token-abc' } } as unknown as Request;
    const res = mockRes();
    const next = mockNext();

    await authenticate(req, res, next);

    expect(next).toHaveBeenCalled();
    expect(req.user?.custom_role_id).toBe('cr-1');
    expect((req.user as { custom_role?: { key: string } }).custom_role?.key).toBe('office-manager');
  });

  it('a plain (non-custom) user carries a null custom_role_id, not undefined-by-omission', async () => {
    (supabaseAdmin.auth.getUser as ReturnType<typeof vi.fn>).mockResolvedValue({
      data: { user: { id: 'u2', email: 'u2@test.com' } },
      error: null,
    });
    (prisma.user.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({
      id: 'u2',
      email: 'u2@test.com',
      first_name: 'T',
      last_name: 'U',
      role: 'SALES',
      custom_role_id: null,
      custom_role: null,
      is_active: true,
      has_login: true,
      organization_id: 'org-1',
      department_id: null,
      location_id: null,
      phone: null,
      phone_ext: null,
      organization: ORG,
    });

    const req = { headers: { authorization: 'Bearer token-def' } } as unknown as Request;
    const res = mockRes();
    const next = mockNext();

    await authenticate(req, res, next);

    expect(next).toHaveBeenCalled();
    expect(req.user?.custom_role_id).toBeNull();
  });

  it('a cached auth entry (second request, same token) still carries custom_role_id', async () => {
    (supabaseAdmin.auth.getUser as ReturnType<typeof vi.fn>).mockResolvedValue({
      data: { user: { id: 'u3', email: 'u3@test.com' } },
      error: null,
    });
    (prisma.user.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({
      id: 'u3',
      email: 'u3@test.com',
      first_name: 'T',
      last_name: 'U',
      role: 'ADMIN',
      custom_role_id: 'cr-2',
      custom_role: { key: 'ops-lead' },
      is_active: true,
      has_login: true,
      organization_id: 'org-1',
      department_id: null,
      location_id: null,
      phone: null,
      phone_ext: null,
      organization: ORG,
    });

    const firstReq = { headers: { authorization: 'Bearer token-ghi' } } as unknown as Request;
    await authenticate(firstReq, mockRes(), mockNext());

    // Second request with the same token hits the in-memory cache path, not resolveAppUser again.
    const secondReq = { headers: { authorization: 'Bearer token-ghi' } } as unknown as Request;
    const res2 = mockRes();
    const next2 = mockNext();
    await authenticate(secondReq, res2, next2);

    expect(next2).toHaveBeenCalled();
    expect(secondReq.user?.custom_role_id).toBe('cr-2');
    expect((secondReq.user as { custom_role?: { key: string } }).custom_role?.key).toBe('ops-lead');
  });
});
