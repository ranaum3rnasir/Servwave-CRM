import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';
import app from '../app';
import { prisma } from '../lib/prisma';
import { supabaseAdmin } from '../lib/supabase';
import { TEST_USERS, ALPHA_ORG_ID, mockAuthAs, authHeader } from './helpers';
import { EMAIL_ALREADY_REGISTERED_MSG } from '../lib/user-email-guard';

vi.mock('../lib/email', () => ({
  sendUserInviteEmail: vi.fn().mockResolvedValue(true),
}));
import { sendUserInviteEmail } from '../lib/email';
const mockSendInvite = sendUserInviteEmail as ReturnType<typeof vi.fn>;

const mockPrisma = prisma as unknown as {
  user: {
    findMany: ReturnType<typeof vi.fn>;
    findUnique: ReturnType<typeof vi.fn>;
    findFirst: ReturnType<typeof vi.fn>;
    create: ReturnType<typeof vi.fn>;
    update: ReturnType<typeof vi.fn>;
    delete: ReturnType<typeof vi.fn>;
  };
  department: {
    findFirst: ReturnType<typeof vi.fn>;
  };
};

const mockSupabaseAdmin = supabaseAdmin as unknown as {
  auth: {
    admin: {
      createUser: ReturnType<typeof vi.fn>;
      deleteUser: ReturnType<typeof vi.fn>;
      listUsers: ReturnType<typeof vi.fn>;
    };
  };
};

beforeEach(() => {
  vi.clearAllMocks();
});

// ═══════════════════════════════════════════════════════
// POST /api/users/invite
// ═══════════════════════════════════════════════════════

describe('POST /api/users/invite', () => {
  it('creates a login-capable user (has_login:true) and emails an invite — no Supabase account yet', async () => {
    mockAuthAs('admin');
    mockPrisma.user.create.mockResolvedValue({
      id: 'new-user-id',
      email: 'jane@test.com',
      first_name: 'Jane',
      last_name: 'Doe',
      role: 'TECHNICIAN',
      is_active: true,
      has_login: true,
      department_id: null,
      department: null,
      created_at: new Date(),
      updated_at: new Date(),
    });

    const res = await request(app)
      .post('/api/users/invite')
      .set(authHeader('admin'))
      .send({ first_name: 'Jane', last_name: 'Doe', email: 'jane@test.com', role: 'TECHNICIAN', department_id: null });

    expect(res.status).toBe(201);
    expect(res.body.user).toMatchObject({ email: 'jane@test.com', has_login: true });
    expect(res.body.email_sent).toBe(true);
    expect(typeof res.body.invite_url).toBe('string');
    expect(res.body.invite_url).toContain('/accept-invite?token=');
    expect(mockSupabaseAdmin.auth.admin.createUser).not.toHaveBeenCalled();
    expect(mockSendInvite).toHaveBeenCalledOnce();

    const createArgs = mockPrisma.user.create.mock.calls[0][0];
    expect(createArgs.data).toMatchObject({
      email: 'jane@test.com',
      first_name: 'Jane',
      last_name: 'Doe',
      role: 'TECHNICIAN',
      has_login: true,
      organization_id: ALPHA_ORG_ID,
      department_id: null,
    });
  });

  it('validates the department belongs to the same org', async () => {
    mockAuthAs('admin');
    mockPrisma.department.findFirst.mockResolvedValue(null);
    const res = await request(app)
      .post('/api/users/invite')
      .set(authHeader('admin'))
      .send({ first_name: 'Jane', last_name: 'Doe', email: 'jane2@test.com', role: 'TECHNICIAN', department_id: '00000000-0000-0000-0000-0000000000aa' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/department/i);
    expect(mockPrisma.user.create).not.toHaveBeenCalled();
  });

  it('returns 409 (canonical message) via the P2002 backstop — race between the guard check and the write', async () => {
    mockAuthAs('admin');
    const prismaError = Object.assign(new Error('Unique constraint'), { code: 'P2002', meta: { target: ['email'] } });
    mockPrisma.user.create.mockRejectedValue(prismaError);
    const res = await request(app)
      .post('/api/users/invite')
      .set(authHeader('admin'))
      .send({ first_name: 'Jane', last_name: 'Doe', email: 'dup@test.com', role: 'TECHNICIAN' });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe(EMAIL_ALREADY_REGISTERED_MSG);
  });

  it('still returns 201 with email_sent:false when the email fails', async () => {
    mockAuthAs('admin');
    mockSendInvite.mockResolvedValueOnce(false);
    mockPrisma.user.create.mockResolvedValue({
      id: 'new-user-id-2', email: 'k@test.com', first_name: 'K', last_name: 'L', role: 'SALES',
      is_active: true, has_login: true, department_id: null, department: null, created_at: new Date(), updated_at: new Date(),
    });
    const res = await request(app)
      .post('/api/users/invite').set(authHeader('admin'))
      .send({ first_name: 'K', last_name: 'L', email: 'k@test.com', role: 'SALES' });
    expect(res.status).toBe(201);
    expect(res.body.email_sent).toBe(false);
  });

  it('requires ADMIN role', async () => {
    mockAuthAs('dispatcher');
    const res = await request(app)
      .post('/api/users/invite').set(authHeader('dispatcher'))
      .send({ first_name: 'Jane', last_name: 'Doe', email: 'x@test.com', role: 'TECHNICIAN' });
    expect(res.status).toBe(403);
  });

  it('rejects invalid email', async () => {
    mockAuthAs('admin');
    const res = await request(app)
      .post('/api/users/invite').set(authHeader('admin'))
      .send({ first_name: 'Jane', last_name: 'Doe', email: 'not-an-email', role: 'TECHNICIAN' });
    expect(res.status).toBe(400);
  });
});

// ═══════════════════════════════════════════════════════
// POST /api/users (create)
// ═══════════════════════════════════════════════════════

describe('POST /api/users (create)', () => {
  it('creates a Supabase auth user + Prisma user for a brand-new email', async () => {
    mockAuthAs('admin');
    mockPrisma.user.findFirst.mockResolvedValue(null);
    mockSupabaseAdmin.auth.admin.createUser.mockResolvedValue({
      data: { user: { id: 'supa-new-id' } }, error: null,
    });
    mockPrisma.user.create.mockResolvedValue({
      id: 'supa-new-id', email: 'brandnew@test.com', first_name: 'Brand', last_name: 'New',
      role: 'TECHNICIAN', is_active: true, has_login: true, department_id: null, department: null,
      created_at: new Date(), updated_at: new Date(),
    });

    const res = await request(app)
      .post('/api/users')
      .set(authHeader('admin'))
      .send({ email: 'brandnew@test.com', password: 'StrongPass!1', first_name: 'Brand', last_name: 'New', role: 'TECHNICIAN' });

    expect(res.status).toBe(201);
    expect(res.body.user).toMatchObject({ email: 'brandnew@test.com' });
  });

  it('409s with the canonical message and never calls Supabase when the email already exists in another org', async () => {
    mockAuthAs('admin');
    mockPrisma.user.findFirst.mockResolvedValue({ id: 'existing-elsewhere' });

    const res = await request(app)
      .post('/api/users')
      .set(authHeader('admin'))
      .send({ email: 'taken@test.com', password: 'StrongPass!1', first_name: 'A', last_name: 'B', role: 'SALES' });

    expect(res.status).toBe(409);
    expect(res.body.error).toBe(EMAIL_ALREADY_REGISTERED_MSG);
    expect(mockSupabaseAdmin.auth.admin.createUser).not.toHaveBeenCalled();
    expect(mockPrisma.user.create).not.toHaveBeenCalled();
  });

  it('409s with the canonical message when Supabase itself reports the email already exists (orphaned auth account)', async () => {
    mockAuthAs('admin');
    mockPrisma.user.findFirst.mockResolvedValue(null);
    mockSupabaseAdmin.auth.admin.createUser.mockResolvedValue({
      data: { user: null },
      error: { code: 'email_exists', message: 'A user with this email address has already been registered' },
    });

    const res = await request(app)
      .post('/api/users')
      .set(authHeader('admin'))
      .send({ email: 'orphaned@test.com', password: 'StrongPass!1', first_name: 'A', last_name: 'B', role: 'SALES' });

    expect(res.status).toBe(409);
    expect(res.body.error).toBe(EMAIL_ALREADY_REGISTERED_MSG);
    expect(mockPrisma.user.create).not.toHaveBeenCalled();
  });
});

// ═══════════════════════════════════════════════════════
// GET /api/users?assignable=true
// ═══════════════════════════════════════════════════════

describe('GET /api/users?assignable=true', () => {
  it('returns active users (login + staff) with department grouping fields', async () => {
    mockAuthAs('admin');
    mockPrisma.user.findMany.mockResolvedValue([
      {
        id: 'u1', first_name: 'John', last_name: 'Smith', role: 'TECHNICIAN',
        is_active: true, has_login: true,
        department: { id: 'd1', name: 'HVAC Techs' },
      },
      {
        id: 'u2', first_name: 'Jane', last_name: 'Doe', role: 'TECHNICIAN',
        is_active: true, has_login: false,
        department: null,
      },
    ]);

    const res = await request(app)
      .get('/api/users?assignable=true')
      .set(authHeader('admin'));

    expect(res.status).toBe(200);
    expect(res.body.users).toHaveLength(2);
    expect(res.body.users[0]).toMatchObject({
      id: 'u1', first_name: 'John', has_login: true,
      department: { id: 'd1', name: 'HVAC Techs' },
    });
    expect(res.body.users[1].department).toBeNull();

    const findArgs = mockPrisma.user.findMany.mock.calls[0][0];
    expect(findArgs.where).toMatchObject({
      organization_id: ALPHA_ORG_ID,
      is_active: true,
    });
    expect(findArgs.orderBy).toBeDefined();
  });

  it('filters by the assignable-role set (all active-user roles, #366) when assignable=true', async () => {
    mockAuthAs('admin');
    mockPrisma.user.findMany.mockResolvedValue([]);

    await request(app)
      .get('/api/users?assignable=true')
      .set(authHeader('admin'));

    const findArgs = mockPrisma.user.findMany.mock.calls[0][0];
    expect(findArgs.where.role).toEqual({ in: ['ADMIN', 'SALES', 'DISPATCHER', 'TECHNICIAN'] });
  });

  it('ignores the ad-hoc role query param when assignable=true (all active-user roles, #366)', async () => {
    mockAuthAs('admin');
    mockPrisma.user.findMany.mockResolvedValue([]);

    await request(app)
      .get('/api/users?assignable=true&role=TECHNICIAN')
      .set(authHeader('admin'));

    const findArgs = mockPrisma.user.findMany.mock.calls[0][0];
    // assignable always uses the fixed eligibility set, never the raw role filter
    expect(findArgs.where.role).toEqual({ in: ['ADMIN', 'SALES', 'DISPATCHER', 'TECHNICIAN'] });
  });

  it('uses the owner-eligible set (all active-user roles, #366) when eligible_for=owner', async () => {
    mockAuthAs('admin');
    mockPrisma.user.findMany.mockResolvedValue([]);

    await request(app)
      .get('/api/users?assignable=true&eligible_for=owner')
      .set(authHeader('admin'));

    const findArgs = mockPrisma.user.findMany.mock.calls[0][0];
    // Bug #11 + #366: owner-eligibility equals the assignable pool (all four roles).
    expect(findArgs.where.role).toEqual({ in: ['ADMIN', 'SALES', 'DISPATCHER', 'TECHNICIAN'] });
  });

  it('omits the role filter for eligible_for=task (all active users incl. DISPATCHER)', async () => {
    mockAuthAs('admin');
    mockPrisma.user.findMany.mockResolvedValue([]);

    await request(app)
      .get('/api/users?assignable=true&eligible_for=task')
      .set(authHeader('admin'));

    const findArgs = mockPrisma.user.findMany.mock.calls[0][0];
    // #434: tasks can be owned/watched by ANY active org user — no role restriction.
    expect(findArgs.where.role).toBeUndefined();
    expect(findArgs.where).toMatchObject({
      organization_id: ALPHA_ORG_ID,
      is_active: true,
    });
  });

  it('still applies the department scope for eligible_for=task without a role filter', async () => {
    mockAuthAs('admin');
    mockPrisma.user.findMany.mockResolvedValue([]);

    await request(app)
      .get('/api/users?assignable=true&eligible_for=task&department_id=d1')
      .set(authHeader('admin'));

    const findArgs = mockPrisma.user.findMany.mock.calls[0][0];
    expect(findArgs.where.role).toBeUndefined();
    expect(findArgs.where).toMatchObject({
      organization_id: ALPHA_ORG_ID,
      is_active: true,
      department_id: 'd1',
    });
  });

  it('scopes to a department when department_id is provided with assignable=true', async () => {
    mockAuthAs('admin');
    mockPrisma.user.findMany.mockResolvedValue([]);

    await request(app)
      .get('/api/users?assignable=true&department_id=d1')
      .set(authHeader('admin'));

    const findArgs = mockPrisma.user.findMany.mock.calls[0][0];
    expect(findArgs.where).toMatchObject({
      organization_id: ALPHA_ORG_ID,
      is_active: true,
      department_id: 'd1',
      role: { in: ['ADMIN', 'SALES', 'DISPATCHER', 'TECHNICIAN'] },
    });
  });

  it('does not apply a department filter when department_id is absent (org-wide borrow pool)', async () => {
    mockAuthAs('admin');
    mockPrisma.user.findMany.mockResolvedValue([]);

    await request(app)
      .get('/api/users?assignable=true')
      .set(authHeader('admin'));

    const findArgs = mockPrisma.user.findMany.mock.calls[0][0];
    expect(findArgs.where.department_id).toBeUndefined();
  });

  it('preserves existing list behavior when assignable is absent', async () => {
    mockAuthAs('admin');
    mockPrisma.user.findMany.mockResolvedValue([]);

    await request(app)
      .get('/api/users?role=SALES')
      .set(authHeader('admin'));

    const findArgs = mockPrisma.user.findMany.mock.calls[0][0];
    expect(findArgs.where.role).toBe('SALES');
    expect(findArgs.where.is_active).toBeUndefined();
  });
});

// ═══════════════════════════════════════════════════════
// POST /api/users/:id/invite (resend invite for an existing row)
// ═══════════════════════════════════════════════════════

describe('POST /api/users/:id/invite (resend invite for an existing row)', () => {
  it('emails an invite for an existing user and flips has_login:true', async () => {
    mockAuthAs('admin');
    const existing = {
      id: '00000000-0000-0000-0000-000000000777',
      email: 'legacy@test.com', first_name: 'Leg', last_name: 'Acy', role: 'TECHNICIAN',
      is_active: true, has_login: false, organization_id: ALPHA_ORG_ID, department_id: null,
    };
    // The controller resolves the existing row via findFirst (org-scoped);
    // mockAuthAs already wires findUnique for the authenticate middleware.
    mockPrisma.user.findFirst.mockResolvedValue(existing);
    mockPrisma.user.update.mockResolvedValue({ ...existing, has_login: true, department: null, enforce_clock_in_location: false, can_approve_clock_overrides: false, created_at: new Date(), updated_at: new Date() });

    const res = await request(app)
      .post(`/api/users/${existing.id}/invite`).set(authHeader('admin')).send({});

    expect(res.status).toBe(200);
    expect(res.body.email_sent).toBe(true);
    expect(mockSendInvite).toHaveBeenCalledOnce();
    const updateArgs = mockPrisma.user.update.mock.calls[0][0];
    expect(updateArgs.data).toMatchObject({ has_login: true });
  });

  it('returns 404 for an unknown user', async () => {
    mockAuthAs('admin');
    // Controller resolves the row via findFirst; an unknown id is invisible.
    mockPrisma.user.findFirst.mockResolvedValue(null);
    const res = await request(app)
      .post('/api/users/00000000-0000-0000-0000-000000000999/invite').set(authHeader('admin')).send({});
    expect(res.status).toBe(404);
  });
});

// ═══════════════════════════════════════════════════════
// PATCH /api/users/:id — self-role-change guard
// ═══════════════════════════════════════════════════════

describe('PATCH /api/users/:id (self-role-change guard)', () => {
  it('rejects an admin changing their OWN role (lockout protection)', async () => {
    mockAuthAs('admin');
    // Even if the row would resolve, the self-role-change guard must short-circuit.
    mockPrisma.user.findFirst.mockResolvedValue(TEST_USERS.admin);

    const res = await request(app)
      .patch(`/api/users/${TEST_USERS.admin.id}`)
      .set(authHeader('admin'))
      .send({ role: 'SALES' });

    expect([400, 403]).toContain(res.status);
    expect(mockPrisma.user.update).not.toHaveBeenCalled();
  });

  it('allows an admin to edit their OWN non-role fields (e.g. first_name)', async () => {
    mockAuthAs('admin');
    mockPrisma.user.findFirst.mockResolvedValue(TEST_USERS.admin);
    mockPrisma.user.update.mockResolvedValue({
      ...TEST_USERS.admin, first_name: 'Renamed', department: null,
      has_login: true, enforce_clock_in_location: false, can_approve_clock_overrides: false,
      created_at: new Date(), updated_at: new Date(),
    });

    const res = await request(app)
      .patch(`/api/users/${TEST_USERS.admin.id}`)
      .set(authHeader('admin'))
      .send({ first_name: 'Renamed' });

    expect(res.status).toBe(200);
    expect(mockPrisma.user.update).toHaveBeenCalledOnce();
  });

  it("allows an admin to change ANOTHER user's role", async () => {
    mockAuthAs('admin');
    mockPrisma.user.findFirst.mockResolvedValue({ ...TEST_USERS.sales });
    mockPrisma.user.update.mockResolvedValue({
      ...TEST_USERS.sales, role: 'TECHNICIAN', department: null,
      has_login: true, enforce_clock_in_location: false, can_approve_clock_overrides: false,
      created_at: new Date(), updated_at: new Date(),
    });

    const res = await request(app)
      .patch(`/api/users/${TEST_USERS.sales.id}`)
      .set(authHeader('admin'))
      .send({ role: 'TECHNICIAN' });

    expect(res.status).toBe(200);
    expect(mockPrisma.user.update).toHaveBeenCalledOnce();
  });
});

// ═══════════════════════════════════════════════════════
// GET /api/auth/me endpoint
// ═══════════════════════════════════════════════════════

describe('GET /api/auth/me endpoint', () => {
  it('returns abilityRules array for admin user', async () => {
    mockAuthAs('admin');

    const res = await request(app)
      .get('/api/auth/me')
      .set(authHeader('admin'));

    expect(res.status).toBe(200);
    expect(res.body.user).toBeDefined();
    expect(res.body.user.role).toBe('ADMIN');
    expect(res.body.abilityRules).toBeDefined();
    expect(Array.isArray(res.body.abilityRules)).toBe(true);
  });

  it('admin ability rules contain manage all', async () => {
    mockAuthAs('admin');

    const res = await request(app)
      .get('/api/auth/me')
      .set(authHeader('admin'));

    const rules: { action: string; subject: string }[] = res.body.abilityRules;
    expect(rules.some((r) => r.action === 'manage' && r.subject === 'all')).toBe(true);
  });

  it('returns abilityRules array for non-admin user', async () => {
    mockAuthAs('sales');

    const res = await request(app)
      .get('/api/auth/me')
      .set(authHeader('sales'));

    expect(res.status).toBe(200);
    expect(res.body.user).toBeDefined();
    expect(res.body.user.role).toBe('SALES');
    expect(res.body.abilityRules).toBeDefined();
    expect(Array.isArray(res.body.abilityRules)).toBe(true);
  });

  it('sales ability rules do not contain manage all', async () => {
    mockAuthAs('sales');

    const res = await request(app)
      .get('/api/auth/me')
      .set(authHeader('sales'));

    const rules: { action: string; subject: string }[] = res.body.abilityRules;
    expect(rules.some((r) => r.action === 'manage' && r.subject === 'all')).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════
// DELETE /api/users/:id/permanent
// ═══════════════════════════════════════════════════════

describe('DELETE /api/users/:id/permanent', () => {
  const TARGET_ID = '00000000-0000-0000-0000-0000000000d1';

  const ZERO_COUNTS = {
    created_estimates: 0, created_notes: 0, uploaded_attachments: 0,
    time_entries: 0, timeclock_ot_reviews: 0, issued_refunds: 0, created_credits: 0,
    collected_payments: 0, voided_payments: 0, refunded_invoices: 0,
    commission_owned_leads: 0, dispatched_jobs: 0, service_plans_sold: 0,
    timeline_events: 0, cancelled_walkthroughs: 0,
  };

  const inactiveNoHistory = {
    id: TARGET_ID,
    email: 'gone@test.com',
    is_active: false,
    _count: { ...ZERO_COUNTS },
  };

  it('requires ADMIN role', async () => {
    mockAuthAs('dispatcher');
    const res = await request(app)
      .delete(`/api/users/${TARGET_ID}/permanent`)
      .set(authHeader('dispatcher'));
    expect(res.status).toBe(403);
  });

  it('refuses to delete your own account', async () => {
    mockAuthAs('admin');
    const res = await request(app)
      .delete(`/api/users/${TEST_USERS.admin.id}/permanent`)
      .set(authHeader('admin'));
    expect(res.status).toBe(400);
    expect(mockPrisma.user.delete).not.toHaveBeenCalled();
  });

  it('404s when the user is outside the caller org', async () => {
    mockAuthAs('admin');
    mockPrisma.user.findFirst.mockResolvedValue(null);
    const res = await request(app)
      .delete(`/api/users/${TARGET_ID}/permanent`)
      .set(authHeader('admin'));
    expect(res.status).toBe(404);
  });

  it('409s when the user is still active (deactivate first)', async () => {
    mockAuthAs('admin');
    mockPrisma.user.findFirst.mockResolvedValue({ ...inactiveNoHistory, is_active: true });
    const res = await request(app)
      .delete(`/api/users/${TARGET_ID}/permanent`)
      .set(authHeader('admin'));
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/deactivate/i);
    expect(mockPrisma.user.delete).not.toHaveBeenCalled();
  });

  it('409s with a reason when the user has history', async () => {
    mockAuthAs('admin');
    mockPrisma.user.findFirst.mockResolvedValue({
      ...inactiveNoHistory,
      _count: { ...ZERO_COUNTS, created_estimates: 3, collected_payments: 1 },
    });
    const res = await request(app)
      .delete(`/api/users/${TARGET_ID}/permanent`)
      .set(authHeader('admin'));
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/history/i);
    expect(res.body.error).toMatch(/estimates/i);
    expect(mockPrisma.user.delete).not.toHaveBeenCalled();
  });

  it('hard-deletes an inactive user with no history and removes the auth account', async () => {
    mockAuthAs('admin');
    mockPrisma.user.findFirst.mockResolvedValue(inactiveNoHistory);
    mockPrisma.user.delete.mockResolvedValue({ id: TARGET_ID });
    mockSupabaseAdmin.auth.admin.listUsers.mockResolvedValue({
      data: { users: [{ id: 'supa-xyz', email: 'gone@test.com' }] }, error: null,
    });
    mockSupabaseAdmin.auth.admin.deleteUser.mockResolvedValue({ data: {}, error: null });

    const res = await request(app)
      .delete(`/api/users/${TARGET_ID}/permanent`)
      .set(authHeader('admin'));

    expect(res.status).toBe(200);
    expect(res.body.message).toMatch(/deleted/i);
    expect(mockPrisma.user.delete).toHaveBeenCalledWith({ where: { id: TARGET_ID } });
    expect(mockSupabaseAdmin.auth.admin.deleteUser).toHaveBeenCalledWith('supa-xyz');
  });

  it('still succeeds when there is no Supabase auth account to remove', async () => {
    mockAuthAs('admin');
    mockPrisma.user.findFirst.mockResolvedValue(inactiveNoHistory);
    mockPrisma.user.delete.mockResolvedValue({ id: TARGET_ID });
    mockSupabaseAdmin.auth.admin.listUsers.mockResolvedValue({ data: { users: [] }, error: null });

    const res = await request(app)
      .delete(`/api/users/${TARGET_ID}/permanent`)
      .set(authHeader('admin'));

    expect(res.status).toBe(200);
    expect(mockSupabaseAdmin.auth.admin.deleteUser).not.toHaveBeenCalled();
  });
});

// Reference TEST_USERS to keep the import marked as used by ESLint.
void TEST_USERS;
