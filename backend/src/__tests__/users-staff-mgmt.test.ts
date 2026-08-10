import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';
import app from '../app';
import { prisma } from '../lib/prisma';
import { supabaseAdmin } from '../lib/supabase';
import { TEST_USERS, TEST_ORG, mockAuthAs, authHeader } from './helpers';
import { EMAIL_ALREADY_REGISTERED_MSG } from '../lib/user-email-guard';

// inviteUser needs a real sendUserInviteEmail mock (setup.ts's email mock omits it).
vi.mock('../lib/email', () => ({
  sendUserInviteEmail: vi.fn().mockResolvedValue(true),
}));

const mockPrisma = prisma as unknown as {
  user: {
    findUnique: ReturnType<typeof vi.fn>;
    findFirst: ReturnType<typeof vi.fn>;
    findMany: ReturnType<typeof vi.fn>;
    update: ReturnType<typeof vi.fn>;
    create: ReturnType<typeof vi.fn>;
    count: ReturnType<typeof vi.fn>;
  };
};

const mockSupabaseAdmin = supabaseAdmin as unknown as {
  auth: {
    signInWithPassword: ReturnType<typeof vi.fn>;
    admin: {
      createUser: ReturnType<typeof vi.fn>;
      deleteUser: ReturnType<typeof vi.fn>;
      updateUserById: ReturnType<typeof vi.fn>;
      listUsers: ReturnType<typeof vi.fn>;
    };
  };
};

beforeEach(() => {
  vi.clearAllMocks();
});

// After mockAuthAs(...), resolve both the admin (auth middleware's resolveAppUser
// looks up by id) AND a specific target row. Stub findUnique AND findFirst because
// the controllers are mixed: revoke-login looks the target up by findUnique, while
// update/deactivate use tenant-scoped findFirst.
function authPlusTarget(target: Record<string, unknown> & { id: string }) {
  const resolve = ({ where }: { where: { id?: string; email?: string } }) => {
    if (where.id === target.id) return Promise.resolve({ ...target, organization: TEST_ORG });
    if (where.id === TEST_USERS.admin.id) return Promise.resolve({ ...TEST_USERS.admin, has_login: true, organization: TEST_ORG });
    return Promise.resolve(null);
  };
  (mockPrisma.user.findUnique as ReturnType<typeof vi.fn>).mockImplementation(resolve);
  (mockPrisma.user.findFirst as ReturnType<typeof vi.fn>).mockImplementation(resolve);
}

// ═══════════════════════════════════════════════════════
// Phone on create / invite / update (Task 3)
// ═══════════════════════════════════════════════════════
describe('phone on user invite/update', () => {
  it('persists phone + phone_ext when inviting a user', async () => {
    mockAuthAs('admin');
    mockPrisma.user.create.mockResolvedValue({
      id: 'u-ph', email: 'p@test.com', first_name: 'P', last_name: 'H', role: 'TECHNICIAN',
      is_active: true, has_login: true, phone: '5551112222', phone_ext: '12',
      department_id: null, department: null, created_at: new Date(), updated_at: new Date(),
    });
    const res = await request(app)
      .post('/api/users/invite').set(authHeader('admin'))
      .send({ first_name: 'P', last_name: 'H', email: 'p@test.com', role: 'TECHNICIAN', phone: '5551112222', phone_ext: '12' });
    expect(res.status).toBe(201);
    expect(mockPrisma.user.create.mock.calls[0][0].data).toMatchObject({ phone: '5551112222', phone_ext: '12' });
  });

  it('persists phone on PATCH /:id', async () => {
    mockAuthAs('admin');
    const TARGET = '00000000-0000-0000-0000-0000000000c1';
    authPlusTarget({ id: TARGET, role: 'TECHNICIAN', is_active: true });
    mockPrisma.user.update.mockResolvedValue({ id: TARGET, phone: '5559998888' });
    const res = await request(app)
      .patch(`/api/users/${TARGET}`).set(authHeader('admin')).send({ phone: '5559998888' });
    expect(res.status).toBe(200);
    expect(mockPrisma.user.update.mock.calls[0][0].data).toMatchObject({ phone: '5559998888' });
  });
});

// ═══════════════════════════════════════════════════════
// POST /api/users/:id/revoke-login (Task 4)
// ═══════════════════════════════════════════════════════
describe('POST /api/users/:id/revoke-login', () => {
  const TARGET = '00000000-0000-0000-0000-0000000000e1';

  it('clears has_login, blanks password_hash, and deletes the Supabase auth user', async () => {
    mockAuthAs('admin');
    authPlusTarget({ id: TARGET, email: 'rev@test.com', role: 'TECHNICIAN', is_active: true, has_login: true });
    mockSupabaseAdmin.auth.admin.listUsers.mockResolvedValue({
      data: { users: [{ id: 'sb1', email: 'rev@test.com' }], nextPage: null }, error: null,
    });
    mockSupabaseAdmin.auth.admin.deleteUser.mockResolvedValue({ data: {}, error: null });
    mockPrisma.user.update.mockResolvedValue({ id: TARGET, has_login: false });

    const res = await request(app).post(`/api/users/${TARGET}/revoke-login`).set(authHeader('admin')).send({});
    expect(res.status).toBe(200);
    expect(mockSupabaseAdmin.auth.admin.deleteUser).toHaveBeenCalledWith('sb1');
    expect(mockPrisma.user.update.mock.calls[0][0].data).toMatchObject({ has_login: false, password_hash: '' });
  });

  it('is idempotent when has_login is already false (no Supabase call, no update)', async () => {
    mockAuthAs('admin');
    authPlusTarget({ id: TARGET, email: 'rev@test.com', role: 'TECHNICIAN', is_active: true, has_login: false });
    const res = await request(app).post(`/api/users/${TARGET}/revoke-login`).set(authHeader('admin')).send({});
    expect(res.status).toBe(200);
    expect(mockSupabaseAdmin.auth.admin.deleteUser).not.toHaveBeenCalled();
    expect(mockPrisma.user.update).not.toHaveBeenCalled();
  });

  it('blocks revoking login from the last active admin (409)', async () => {
    mockAuthAs('admin');
    authPlusTarget({ id: TARGET, email: 'admin2@test.com', role: 'ADMIN', is_active: true, has_login: true });
    mockPrisma.user.count.mockResolvedValue(1);
    const res = await request(app).post(`/api/users/${TARGET}/revoke-login`).set(authHeader('admin')).send({});
    expect(res.status).toBe(409);
    expect(mockPrisma.user.update).not.toHaveBeenCalled();
  });

  it('requires user-management permission (dispatcher 403)', async () => {
    mockAuthAs('dispatcher');
    const res = await request(app).post(`/api/users/${TARGET}/revoke-login`).set(authHeader('dispatcher')).send({});
    expect(res.status).toBe(403);
  });
});

// ═══════════════════════════════════════════════════════
// DELETE /api/users/:id (deactivate force-revokes login) (Task 4)
// ═══════════════════════════════════════════════════════
describe('DELETE /api/users/:id (deactivate)', () => {
  const TARGET = '00000000-0000-0000-0000-0000000000e2';

  it('sets is_active:false AND clears login (deletes Supabase auth, clears has_login)', async () => {
    mockAuthAs('admin');
    authPlusTarget({ id: TARGET, email: 'deact@test.com', role: 'TECHNICIAN', is_active: true, has_login: true });
    mockSupabaseAdmin.auth.admin.listUsers.mockResolvedValue({
      data: { users: [{ id: 'sb2', email: 'deact@test.com' }], nextPage: null }, error: null,
    });
    mockSupabaseAdmin.auth.admin.deleteUser.mockResolvedValue({ data: {}, error: null });
    mockPrisma.user.update.mockResolvedValue({ id: TARGET });

    const res = await request(app).delete(`/api/users/${TARGET}`).set(authHeader('admin'));
    expect(res.status).toBe(200);
    expect(mockSupabaseAdmin.auth.admin.deleteUser).toHaveBeenCalledWith('sb2');
    expect(mockPrisma.user.update.mock.calls[0][0].data).toMatchObject({ is_active: false, has_login: false, password_hash: '' });
  });

  it('blocks deactivating the last active admin (409)', async () => {
    mockAuthAs('admin');
    authPlusTarget({ id: TARGET, email: 'admin3@test.com', role: 'ADMIN', is_active: true, has_login: true });
    mockPrisma.user.count.mockResolvedValue(1);
    const res = await request(app).delete(`/api/users/${TARGET}`).set(authHeader('admin'));
    expect(res.status).toBe(409);
    expect(mockPrisma.user.update).not.toHaveBeenCalled();
  });
});

// ═══════════════════════════════════════════════════════
// PATCH /api/users/:id last-admin guard (Task 4)
// ═══════════════════════════════════════════════════════
describe('PATCH /api/users/:id last-admin guard', () => {
  it('blocks demoting the last active admin (409)', async () => {
    mockAuthAs('admin');
    const TARGET = '00000000-0000-0000-0000-0000000000e3';
    authPlusTarget({ id: TARGET, email: 'a@test.com', role: 'ADMIN', is_active: true, has_login: true });
    mockPrisma.user.count.mockResolvedValue(1);
    const res = await request(app).patch(`/api/users/${TARGET}`).set(authHeader('admin')).send({ role: 'SALES' });
    expect(res.status).toBe(409);
    expect(mockPrisma.user.update).not.toHaveBeenCalled();
  });

  it('allows editing the last admin name (not a demote/deactivate)', async () => {
    mockAuthAs('admin');
    const TARGET = '00000000-0000-0000-0000-0000000000e4';
    authPlusTarget({ id: TARGET, email: 'a@test.com', role: 'ADMIN', is_active: true, has_login: true });
    mockPrisma.user.count.mockResolvedValue(1);
    mockPrisma.user.update.mockResolvedValue({ id: TARGET, first_name: 'New' });
    const res = await request(app).patch(`/api/users/${TARGET}`).set(authHeader('admin')).send({ first_name: 'New' });
    expect(res.status).toBe(200);
    expect(mockPrisma.user.update).toHaveBeenCalled();
  });
});

// ═══════════════════════════════════════════════════════
// Self-service /me (Task 5)
// ═══════════════════════════════════════════════════════
describe('PATCH /api/users/me', () => {
  it('updates own first_name/phone via req.user.id', async () => {
    mockAuthAs('admin');
    mockPrisma.user.update.mockResolvedValue({ id: TEST_USERS.admin.id, first_name: 'Renamed', phone: '5550001111' });
    const res = await request(app).patch('/api/users/me').set(authHeader('admin')).send({ first_name: 'Renamed', phone: '5550001111' });
    expect(res.status).toBe(200);
    const args = mockPrisma.user.update.mock.calls[0][0];
    expect(args.where).toEqual({ id: TEST_USERS.admin.id });
    expect(args.data).toMatchObject({ first_name: 'Renamed', phone: '5550001111' });
  });

  it('rejects privileged keys (role) with 400 (.strict)', async () => {
    mockAuthAs('admin');
    const res = await request(app).patch('/api/users/me').set(authHeader('admin')).send({ role: 'SALES' });
    expect(res.status).toBe(400);
    expect(mockPrisma.user.update).not.toHaveBeenCalled();
  });
});

describe('POST /api/users/me/password', () => {
  it('updates the Supabase password for a has_login user (resolved by email), after current-password re-auth (#4)', async () => {
    mockAuthAs('admin');
    (mockPrisma.user.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({ ...TEST_USERS.admin, has_login: true, organization: TEST_ORG });
    mockSupabaseAdmin.auth.admin.listUsers.mockResolvedValue({
      data: { users: [{ id: 'sb-admin', email: TEST_USERS.admin.email }], nextPage: null }, error: null,
    });
    mockSupabaseAdmin.auth.signInWithPassword.mockResolvedValue({ data: { user: { id: 'sb-admin' } }, error: null });
    mockSupabaseAdmin.auth.admin.updateUserById.mockResolvedValue({ data: {}, error: null });
    const res = await request(app)
      .post('/api/users/me/password')
      .set(authHeader('admin'))
      .send({ current_password: 'oldpass123', password: 'newpass123' });
    expect(res.status).toBe(200);
    expect(mockSupabaseAdmin.auth.signInWithPassword).toHaveBeenCalledWith({ email: TEST_USERS.admin.email, password: 'oldpass123' });
    expect(mockSupabaseAdmin.auth.admin.updateUserById).toHaveBeenCalledWith('sb-admin', { password: 'newpass123' });
  });

  it('returns 400 when the caller has_login is false', async () => {
    mockAuthAs('admin');
    (mockPrisma.user.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({ ...TEST_USERS.admin, has_login: false, organization: TEST_ORG });
    const res = await request(app)
      .post('/api/users/me/password')
      .set(authHeader('admin'))
      .send({ current_password: 'oldpass123', password: 'newpass123' });
    expect(res.status).toBe(400);
    expect(mockSupabaseAdmin.auth.admin.updateUserById).not.toHaveBeenCalled();
  });

  it('rejects a missing current_password with 400 (#4 — schema requires it)', async () => {
    mockAuthAs('admin');
    const res = await request(app).post('/api/users/me/password').set(authHeader('admin')).send({ password: 'newpass123' });
    expect(res.status).toBe(400);
    expect(mockSupabaseAdmin.auth.admin.updateUserById).not.toHaveBeenCalled();
  });

  it('rejects a too-short password with 400', async () => {
    mockAuthAs('admin');
    const res = await request(app)
      .post('/api/users/me/password')
      .set(authHeader('admin'))
      .send({ current_password: 'oldpass123', password: 'short' });
    expect(res.status).toBe(400);
  });
});

// ═══════════════════════════════════════════════════════
// POST /api/users/invite (email guard)
// ═══════════════════════════════════════════════════════
describe('POST /api/users/invite', () => {
  it('409s with the canonical message and does NOT call prisma.user.create when the email already exists in another org', async () => {
    mockAuthAs('admin');
    mockPrisma.user.findFirst.mockResolvedValue({ id: 'existing-elsewhere' });

    const res = await request(app)
      .post('/api/users/invite')
      .set(authHeader('admin'))
      .send({ first_name: 'Jane', last_name: 'Doe', email: 'taken@test.com', role: 'TECHNICIAN' });

    expect(res.status).toBe(409);
    expect(res.body.error).toBe(EMAIL_ALREADY_REGISTERED_MSG);
    expect(mockPrisma.user.create).not.toHaveBeenCalled();
  });
});
