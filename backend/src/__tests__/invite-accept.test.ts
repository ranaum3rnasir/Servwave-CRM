import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';
import app from '../app';
import { prisma } from '../lib/prisma';
import { supabaseAdmin } from '../lib/supabase';
import { signInviteToken } from '../lib/invite-token';
import { ALPHA_ORG_ID } from './helpers';

const mockPrisma = prisma as unknown as {
  user: {
    findUnique: ReturnType<typeof vi.fn>;
    findFirst: ReturnType<typeof vi.fn>;
  };
  termsAcceptance: {
    create: ReturnType<typeof vi.fn>;
    findFirst: ReturnType<typeof vi.fn>;
  };
};
const mockSupabase = supabaseAdmin as unknown as {
  auth: {
    signInWithPassword: ReturnType<typeof vi.fn>;
    admin: { createUser: ReturnType<typeof vi.fn> };
  };
};

const UID = '00000000-0000-0000-0000-0000000007aa';
const EMAIL = 'invitee@test.com';
const invitedRow = {
  id: UID, email: EMAIL, first_name: 'In', last_name: 'Vitee', role: 'TECHNICIAN',
  is_active: true, organization_id: ALPHA_ORG_ID, department_id: null, location_id: null,
};

beforeEach(() => vi.clearAllMocks());

describe('POST /api/auth/invite', () => {
  // Token moved from the query string to the POST body so it can never be
  // captured by the request logger / proxy access logs (single-use secret).
  it('returns the invitee email + first name for a valid token', async () => {
    mockPrisma.user.findUnique.mockResolvedValue(invitedRow);
    const token = signInviteToken(UID, EMAIL);
    const res = await request(app).post('/api/auth/invite').send({ token });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ email: EMAIL, first_name: 'In' });
  });

  it('returns 400 for a bad token', async () => {
    const res = await request(app).post('/api/auth/invite').send({ token: 'garbage' });
    expect(res.status).toBe(400);
  });
});

describe('POST /api/auth/accept-invite', () => {
  it('creates a confirmed Supabase account with the chosen password', async () => {
    mockPrisma.user.findUnique.mockResolvedValue(invitedRow);
    mockSupabase.auth.admin.createUser.mockResolvedValue({ data: { user: { id: 'supa-new' } }, error: null });
    mockPrisma.termsAcceptance.create.mockResolvedValue({ id: 'ta-1' });
    const token = signInviteToken(UID, EMAIL);

    const res = await request(app)
      .post('/api/auth/accept-invite')
      .send({ token, password: 'sup3rsecret', accepted_terms: true });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    const args = mockSupabase.auth.admin.createUser.mock.calls[0][0];
    expect(args).toMatchObject({ email: EMAIL, password: 'sup3rsecret', email_confirm: true });
  });

  it('rejects a short password with 400', async () => {
    const token = signInviteToken(UID, EMAIL);
    const res = await request(app).post('/api/auth/accept-invite').send({ token, password: 'short', accepted_terms: true });
    expect(res.status).toBe(400);
    expect(mockSupabase.auth.admin.createUser).not.toHaveBeenCalled();
  });

  it('returns 409 when the account already exists (e.g. they used Google first)', async () => {
    mockPrisma.user.findUnique.mockResolvedValue(invitedRow);
    mockSupabase.auth.admin.createUser.mockResolvedValue({ data: { user: null }, error: { code: 'email_exists', message: 'A user with this email already exists' } });
    const token = signInviteToken(UID, EMAIL);
    const res = await request(app).post('/api/auth/accept-invite').send({ token, password: 'sup3rsecret', accepted_terms: true });
    expect(res.status).toBe(409);
  });

  it('returns 400 for an invalid token', async () => {
    const res = await request(app).post('/api/auth/accept-invite').send({ token: 'nope', password: 'sup3rsecret', accepted_terms: true });
    expect(res.status).toBe(400);
  });

  it('returns 400 when the invited user no longer exists', async () => {
    mockPrisma.user.findUnique.mockResolvedValue(null);
    const token = signInviteToken(UID, EMAIL);
    const res = await request(app).post('/api/auth/accept-invite').send({ token, password: 'sup3rsecret', accepted_terms: true });
    expect(res.status).toBe(400);
  });

  it('rejects when the terms are not accepted (400, no account, no record)', async () => {
    mockPrisma.user.findUnique.mockResolvedValue(invitedRow);
    const token = signInviteToken(UID, EMAIL);
    const res = await request(app)
      .post('/api/auth/accept-invite')
      .send({ token, password: 'sup3rsecret' }); // accepted_terms omitted
    expect(res.status).toBe(400);
    expect(mockSupabase.auth.admin.createUser).not.toHaveBeenCalled();
    expect(mockPrisma.termsAcceptance.create).not.toHaveBeenCalled();
  });

  it('records a terms_acceptances row on success', async () => {
    mockPrisma.user.findUnique.mockResolvedValue(invitedRow);
    mockSupabase.auth.admin.createUser.mockResolvedValue({ data: { user: { id: 'supa-new' } }, error: null });
    mockPrisma.termsAcceptance.create.mockResolvedValue({ id: 'ta-1' });
    const token = signInviteToken(UID, EMAIL);

    const res = await request(app)
      .post('/api/auth/accept-invite')
      .send({ token, password: 'sup3rsecret', accepted_terms: true });

    expect(res.status).toBe(200);
    expect(mockPrisma.termsAcceptance.create).toHaveBeenCalledTimes(1);
    const data = mockPrisma.termsAcceptance.create.mock.calls[0][0].data;
    expect(data).toMatchObject({
      user_id: UID,
      user_email: EMAIL,
      organization_id: ALPHA_ORG_ID,
      terms_version: '2026-06-30',
      terms_url: 'https://www.servwave.com/terms/',
      privacy_url: 'https://www.servwave.com/privacy/',
      context: 'invite_acceptance',
    });
  });

  it('does not write a second terms row if one already exists (Google recorded it first)', async () => {
    mockPrisma.user.findUnique.mockResolvedValue(invitedRow);
    mockSupabase.auth.admin.createUser.mockResolvedValue({ data: { user: { id: 'supa-new' } }, error: null });
    mockPrisma.termsAcceptance.findFirst.mockResolvedValue({ id: 'existing-from-google' });
    const token = signInviteToken(UID, EMAIL);

    const res = await request(app)
      .post('/api/auth/accept-invite')
      .send({ token, password: 'sup3rsecret', accepted_terms: true });

    expect(res.status).toBe(200);
    expect(mockPrisma.termsAcceptance.create).not.toHaveBeenCalled();
  });

  // #607 defense-in-depth: refuse acceptance if the email is ever tied to a
  // different account, before any Supabase account is created.
  it('rejects acceptance when the email is tied to a different account (defense-in-depth)', async () => {
    mockPrisma.user.findUnique.mockResolvedValue(invitedRow);
    mockPrisma.user.findFirst.mockResolvedValue({ id: 'another-account' });
    const token = signInviteToken(UID, EMAIL);
    const res = await request(app).post('/api/auth/accept-invite').send({ token, password: 'sup3rsecret', accepted_terms: true });
    expect(res.status).toBe(409);
    expect(mockSupabase.auth.admin.createUser).not.toHaveBeenCalled();
  });
});

describe('POST /api/auth/login (confirmed-email fallback for invited users)', () => {
  it('logs in a user whose Prisma id differs from the Supabase id, via confirmed email', async () => {
    mockSupabase.auth.signInWithPassword.mockResolvedValue({
      data: {
        user: { id: 'supa-new', email: EMAIL, email_confirmed_at: '2026-06-12T00:00:00Z' },
        session: { access_token: 'a', refresh_token: 'r', expires_at: 123 },
      },
      error: null,
    });
    mockPrisma.user.findUnique.mockResolvedValue(null);
    mockPrisma.user.findFirst.mockImplementation(({ where }: { where: { email?: { equals?: string } } }) =>
      where.email?.equals === EMAIL ? Promise.resolve(invitedRow) : Promise.resolve(null),
    );

    const res = await request(app).post('/api/auth/login').send({ email: EMAIL, password: 'sup3rsecret' });

    expect(res.status).toBe(200);
    expect(res.body.user).toMatchObject({ email: EMAIL, organization_id: ALPHA_ORG_ID });
    expect(res.body.session.access_token).toBe('a');
  });
});

describe('POST /api/auth/accept-invite/terms (Google-path consent, no password)', () => {
  it('records a terms row (context invite_acceptance_google) and returns 200', async () => {
    mockPrisma.user.findUnique.mockResolvedValue(invitedRow);
    mockPrisma.termsAcceptance.findFirst.mockResolvedValue(null);
    mockPrisma.termsAcceptance.create.mockResolvedValue({ id: 'ta-g' });
    const token = signInviteToken(UID, EMAIL);

    const res = await request(app)
      .post('/api/auth/accept-invite/terms')
      .send({ token, accepted_terms: true });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(mockPrisma.termsAcceptance.create).toHaveBeenCalledTimes(1);
    const data = mockPrisma.termsAcceptance.create.mock.calls[0][0].data;
    expect(data).toMatchObject({
      user_id: UID,
      user_email: EMAIL,
      organization_id: ALPHA_ORG_ID,
      terms_version: '2026-06-30',
      terms_url: 'https://www.servwave.com/terms/',
      privacy_url: 'https://www.servwave.com/privacy/',
      context: 'invite_acceptance_google',
    });
  });

  it('is idempotent — does not write a second row when one already exists', async () => {
    mockPrisma.user.findUnique.mockResolvedValue(invitedRow);
    mockPrisma.termsAcceptance.findFirst.mockResolvedValue({ id: 'existing' });
    const token = signInviteToken(UID, EMAIL);

    const res = await request(app)
      .post('/api/auth/accept-invite/terms')
      .send({ token, accepted_terms: true });

    expect(res.status).toBe(200);
    expect(mockPrisma.termsAcceptance.create).not.toHaveBeenCalled();
  });

  it('rejects missing/false accepted_terms with 400 and writes no row', async () => {
    const token = signInviteToken(UID, EMAIL);
    const missing = await request(app).post('/api/auth/accept-invite/terms').send({ token });
    const explicitFalse = await request(app)
      .post('/api/auth/accept-invite/terms')
      .send({ token, accepted_terms: false });
    expect(missing.status).toBe(400);
    expect(explicitFalse.status).toBe(400);
    expect(mockPrisma.termsAcceptance.create).not.toHaveBeenCalled();
  });

  it('returns 400 for an invalid/expired token', async () => {
    const res = await request(app)
      .post('/api/auth/accept-invite/terms')
      .send({ token: 'garbage', accepted_terms: true });
    expect(res.status).toBe(400);
  });

  it('returns 400 when the invited user no longer exists', async () => {
    mockPrisma.user.findUnique.mockResolvedValue(null);
    const token = signInviteToken(UID, EMAIL);
    const res = await request(app)
      .post('/api/auth/accept-invite/terms')
      .send({ token, accepted_terms: true });
    expect(res.status).toBe(400);
  });
});
