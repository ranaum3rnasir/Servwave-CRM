import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { Mock } from 'vitest';
import request from 'supertest';
import app from '../app';
import { mockAuthAs, authHeader, ALPHA_ORG_ID, ORG_B_ID } from './helpers';
import { prisma } from '../lib/prisma';

// Email slice 10 (guided domain verification) — POST/GET/verify/DELETE under
// /api/organization/email-domain. Overrides the global '../lib/email' mock
// (setup.ts) with fully-controllable resend.domains.* + sendDomainVerifiedEmail
// doubles — this suite tests the CONTROLLER wiring, not dispatchEmail's own
// logic (covered separately by email-custom-domain-dispatch.test.ts).
const {
  resendDomainsCreate,
  resendDomainsGet,
  resendDomainsVerify,
  resendDomainsRemove,
  sendDomainVerifiedEmailMock,
} = vi.hoisted(() => ({
  resendDomainsCreate: vi.fn(),
  resendDomainsGet: vi.fn(),
  resendDomainsVerify: vi.fn(),
  resendDomainsRemove: vi.fn(),
  sendDomainVerifiedEmailMock: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../lib/email', () => ({
  resend: {
    domains: {
      create: resendDomainsCreate,
      get: resendDomainsGet,
      verify: resendDomainsVerify,
      remove: resendDomainsRemove,
    },
  },
  sendDomainVerifiedEmail: sendDomainVerifiedEmailMock,
}));

// Never make real network calls in tests — mock Node's dns module (used by
// the controller's best-effort DNS-provider detection on create).
const { resolveNs } = vi.hoisted(() => ({ resolveNs: vi.fn() }));
vi.mock('dns', () => ({
  promises: { resolveNs },
  default: { promises: { resolveNs } },
}));

/* eslint-disable @typescript-eslint/no-explicit-any */
const p = prisma as any;

const RECORDS_FIXTURE = [
  { record: 'SPF', name: 'send', value: 'v=spf1 include:amazonses.com ~all', type: 'TXT', ttl: 'Auto', status: 'not_started' },
  { record: 'DKIM', name: 'resend._domainkey', value: 'p=abc123', type: 'TXT', ttl: 'Auto', status: 'not_started' },
];

const ORG_A_DOMAIN_ROW = {
  id: 'orgdomain-a',
  organization_id: ALPHA_ORG_ID,
  domain_name: 'acmeplumbing.com',
  resend_domain_id: 'dom_a',
  status: 'pending',
  records: RECORDS_FIXTURE,
  detected_dns_provider: 'Cloudflare',
  verified_at: null as Date | null,
  created_at: new Date('2026-08-01T00:00:00Z'),
  updated_at: new Date('2026-08-01T00:00:00Z'),
};

const ORG_B_DOMAIN_ROW = {
  ...ORG_A_DOMAIN_ROW,
  id: 'orgdomain-b',
  organization_id: ORG_B_ID,
  domain_name: 'orgb-hvac.com',
  resend_domain_id: 'dom_b',
};

beforeEach(() => {
  vi.clearAllMocks();
  resolveNs.mockResolvedValue(['ana.ns.cloudflare.com', 'bob.ns.cloudflare.com']);
  p.organizationDomain.findUnique.mockResolvedValue(null);
  p.organizationDomain.create.mockImplementation((args: any) => Promise.resolve({ ...ORG_A_DOMAIN_ROW, ...args.data }));
  p.organizationDomain.update.mockImplementation((args: any) => {
    const base = args.where.id === ORG_B_DOMAIN_ROW.id ? ORG_B_DOMAIN_ROW : ORG_A_DOMAIN_ROW;
    return Promise.resolve({ ...base, ...args.data });
  });
  p.organizationDomain.delete.mockResolvedValue({});
  p.user.findMany.mockResolvedValue([{ email: 'admin@acmeplumbing.com' }]);
});

describe('POST /api/organization/email-domain', () => {
  beforeEach(() => {
    mockAuthAs('admin');
  });

  it('creates a domain: calls resend.domains.create, best-effort NS lookup, stores the row + records', async () => {
    resendDomainsCreate.mockResolvedValue({
      data: { id: 'dom_a', name: 'acmeplumbing.com', status: 'not_started', records: RECORDS_FIXTURE },
      error: null,
    });

    const res = await request(app)
      .post('/api/organization/email-domain')
      .set(authHeader('admin'))
      .send({ domain: 'acmeplumbing.com' });

    expect(res.status).toBe(201);
    expect(resendDomainsCreate).toHaveBeenCalledWith({ name: 'acmeplumbing.com' });
    expect(resolveNs).toHaveBeenCalledWith('acmeplumbing.com');
    const createCall = p.organizationDomain.create.mock.calls[0][0];
    expect(createCall.data).toMatchObject({
      organization_id: ALPHA_ORG_ID,
      domain_name: 'acmeplumbing.com',
      resend_domain_id: 'dom_a',
      status: 'not_started',
      records: RECORDS_FIXTURE,
      detected_dns_provider: 'Cloudflare',
    });
    expect(res.body).toMatchObject({
      domain: 'acmeplumbing.com',
      status: 'not_started',
      records: RECORDS_FIXTURE,
      detected_dns_provider: 'Cloudflare',
      verified_at: null,
    });
  });

  it('detects the apex domain for NS lookup, not a submitted subdomain', async () => {
    resendDomainsCreate.mockResolvedValue({
      data: { id: 'dom_a', name: 'mail.acmeplumbing.com', status: 'not_started', records: [] },
      error: null,
    });

    await request(app)
      .post('/api/organization/email-domain')
      .set(authHeader('admin'))
      .send({ domain: 'mail.acmeplumbing.com' });

    expect(resolveNs).toHaveBeenCalledWith('acmeplumbing.com');
  });

  it('rejects a syntactically implausible domain with 400 before ever calling Resend', async () => {
    const res = await request(app)
      .post('/api/organization/email-domain')
      .set(authHeader('admin'))
      .send({ domain: 'not a domain' });

    expect(res.status).toBe(400);
    expect(resendDomainsCreate).not.toHaveBeenCalled();
  });

  it('returns 409 when the organization already has a domain configured', async () => {
    p.organizationDomain.findUnique.mockResolvedValue({ ...ORG_A_DOMAIN_ROW });

    const res = await request(app)
      .post('/api/organization/email-domain')
      .set(authHeader('admin'))
      .send({ domain: 'another.com' });

    expect(res.status).toBe(409);
    expect(resendDomainsCreate).not.toHaveBeenCalled();
  });

  it('returns 502 when Resend rejects the domain creation', async () => {
    resendDomainsCreate.mockResolvedValue({ data: null, error: { message: 'domain already exists on another account' } });

    const res = await request(app)
      .post('/api/organization/email-domain')
      .set(authHeader('admin'))
      .send({ domain: 'acmeplumbing.com' });

    expect(res.status).toBe(502);
    expect(p.organizationDomain.create).not.toHaveBeenCalled();
  });

  it('scopes the created row to the caller\'s own organization (tenant scoping)', async () => {
    mockAuthAs('orgB_admin');
    resendDomainsCreate.mockResolvedValue({
      data: { id: 'dom_b', name: 'orgb-hvac.com', status: 'not_started', records: [] },
      error: null,
    });

    await request(app)
      .post('/api/organization/email-domain')
      .set(authHeader('orgB_admin'))
      .send({ domain: 'orgb-hvac.com' });

    expect(p.organizationDomain.findUnique).toHaveBeenCalledWith({ where: { organization_id: ORG_B_ID } });
    const createCall = p.organizationDomain.create.mock.calls[0][0];
    expect(createCall.data.organization_id).toBe(ORG_B_ID);
  });

  it.each(['sales', 'dispatcher', 'technician'] as const)('returns 403 for %s (admin-only)', async (role) => {
    mockAuthAs(role);

    const res = await request(app)
      .post('/api/organization/email-domain')
      .set(authHeader(role))
      .send({ domain: 'acmeplumbing.com' });

    expect(res.status).toBe(403);
    expect(resendDomainsCreate).not.toHaveBeenCalled();
  });

  it('returns 401 when unauthenticated', async () => {
    const res = await request(app).post('/api/organization/email-domain').send({ domain: 'acmeplumbing.com' });
    expect(res.status).toBe(401);
  });
});

describe('GET /api/organization/email-domain', () => {
  beforeEach(() => {
    mockAuthAs('admin');
  });

  it('returns 404 when no domain is configured', async () => {
    const res = await request(app).get('/api/organization/email-domain').set(authHeader('admin'));
    expect(res.status).toBe(404);
  });

  it('refreshes status from a live resend.domains.get() re-fetch and persists whatever comes back', async () => {
    p.organizationDomain.findUnique.mockResolvedValue({ ...ORG_A_DOMAIN_ROW, status: 'pending' });
    resendDomainsGet.mockResolvedValue({
      data: { id: 'dom_a', name: 'acmeplumbing.com', status: 'verified', records: RECORDS_FIXTURE.map((r) => ({ ...r, status: 'verified' })) },
      error: null,
    });

    const res = await request(app).get('/api/organization/email-domain').set(authHeader('admin'));

    expect(res.status).toBe(200);
    expect(resendDomainsGet).toHaveBeenCalledWith('dom_a');
    const updateCall = p.organizationDomain.update.mock.calls[0][0];
    expect(updateCall.data.status).toBe('verified');
    expect(res.body.status).toBe('verified');
  });

  it('falls back to serving the last-known stored row when the live Resend fetch fails', async () => {
    p.organizationDomain.findUnique.mockResolvedValue({ ...ORG_A_DOMAIN_ROW, status: 'pending' });
    resendDomainsGet.mockResolvedValue({ data: null, error: { message: 'upstream timeout' } });

    const res = await request(app).get('/api/organization/email-domain').set(authHeader('admin'));

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('pending');
    expect(p.organizationDomain.update).not.toHaveBeenCalled();
  });

  it('scopes the read to the caller\'s own organization (tenant scoping)', async () => {
    mockAuthAs('orgB_admin');
    p.organizationDomain.findUnique.mockImplementation((args: any) =>
      Promise.resolve(args.where.organization_id === ORG_B_ID ? { ...ORG_B_DOMAIN_ROW } : { ...ORG_A_DOMAIN_ROW }));
    resendDomainsGet.mockResolvedValue({ data: { id: 'dom_b', name: 'orgb-hvac.com', status: 'pending', records: [] }, error: null });

    const res = await request(app).get('/api/organization/email-domain').set(authHeader('orgB_admin'));

    expect(res.status).toBe(200);
    expect(res.body.domain).toBe('orgb-hvac.com');
    expect(resendDomainsGet).toHaveBeenCalledWith('dom_b');
  });

  it.each(['sales', 'dispatcher', 'technician'] as const)('returns 403 for %s (admin-only)', async (role) => {
    mockAuthAs(role);
    const res = await request(app).get('/api/organization/email-domain').set(authHeader(role));
    expect(res.status).toBe(403);
  });
});

describe('POST /api/organization/email-domain/verify', () => {
  beforeEach(() => {
    mockAuthAs('admin');
    p.organizationDomain.findUnique.mockResolvedValue({ ...ORG_A_DOMAIN_ROW });
  });

  it('triggers an explicit recheck via resend.domains.verify(), then reads the resulting status', async () => {
    resendDomainsVerify.mockResolvedValue({ data: { id: 'dom_a', object: 'domain' }, error: null });
    resendDomainsGet.mockResolvedValue({
      data: { id: 'dom_a', name: 'acmeplumbing.com', status: 'pending', records: RECORDS_FIXTURE },
      error: null,
    });

    const res = await request(app).post('/api/organization/email-domain/verify').set(authHeader('admin'));

    expect(res.status).toBe(200);
    expect(resendDomainsVerify).toHaveBeenCalledWith('dom_a');
    expect(resendDomainsGet).toHaveBeenCalledWith('dom_a');
    expect(res.body.status).toBe('pending');
  });

  it('returns 404 when no domain is configured', async () => {
    p.organizationDomain.findUnique.mockResolvedValue(null);
    const res = await request(app).post('/api/organization/email-domain/verify').set(authHeader('admin'));
    expect(res.status).toBe(404);
    expect(resendDomainsVerify).not.toHaveBeenCalled();
  });

  it('returns 502 when Resend rejects the verify call', async () => {
    resendDomainsVerify.mockResolvedValue({ data: null, error: { message: 'domain not found' } });

    const res = await request(app).post('/api/organization/email-domain/verify').set(authHeader('admin'));

    expect(res.status).toBe(502);
    expect(p.organizationDomain.update).not.toHaveBeenCalled();
  });

  it('sets verified_at and sends the success email on the FIRST transition into verified', async () => {
    resendDomainsVerify.mockResolvedValue({ data: { id: 'dom_a', object: 'domain' }, error: null });
    resendDomainsGet.mockResolvedValue({
      data: { id: 'dom_a', name: 'acmeplumbing.com', status: 'verified', records: RECORDS_FIXTURE },
      error: null,
    });

    const res = await request(app).post('/api/organization/email-domain/verify').set(authHeader('admin'));

    expect(res.status).toBe(200);
    const updateCall = p.organizationDomain.update.mock.calls[0][0];
    expect(updateCall.data.verified_at).toBeInstanceOf(Date);
    expect(sendDomainVerifiedEmailMock).toHaveBeenCalledTimes(1);
  });

  it.each(['sales', 'dispatcher', 'technician'] as const)('returns 403 for %s (admin-only)', async (role) => {
    mockAuthAs(role);
    const res = await request(app).post('/api/organization/email-domain/verify').set(authHeader(role));
    expect(res.status).toBe(403);
  });
});

describe('DELETE /api/organization/email-domain', () => {
  beforeEach(() => {
    mockAuthAs('admin');
    p.organizationDomain.findUnique.mockResolvedValue({ ...ORG_A_DOMAIN_ROW });
  });

  it('removes the domain: calls resend.domains.remove, deletes the row', async () => {
    resendDomainsRemove.mockResolvedValue({ data: { id: 'dom_a', object: 'domain', deleted: true }, error: null });

    const res = await request(app).delete('/api/organization/email-domain').set(authHeader('admin'));

    expect(res.status).toBe(200);
    expect(resendDomainsRemove).toHaveBeenCalledWith('dom_a');
    expect(p.organizationDomain.delete).toHaveBeenCalledWith({ where: { id: 'orgdomain-a' } });
    expect(res.body).toEqual({ deleted: true });
  });

  it('returns 404 when no domain is configured', async () => {
    p.organizationDomain.findUnique.mockResolvedValue(null);
    const res = await request(app).delete('/api/organization/email-domain').set(authHeader('admin'));
    expect(res.status).toBe(404);
    expect(resendDomainsRemove).not.toHaveBeenCalled();
  });

  it('returns 502 and does NOT delete the local row when Resend rejects the removal', async () => {
    resendDomainsRemove.mockResolvedValue({ data: null, error: { message: 'provider error' } });

    const res = await request(app).delete('/api/organization/email-domain').set(authHeader('admin'));

    expect(res.status).toBe(502);
    expect(p.organizationDomain.delete).not.toHaveBeenCalled();
  });

  it('scopes the deletion to the caller\'s own organization (tenant scoping)', async () => {
    mockAuthAs('orgB_admin');
    p.organizationDomain.findUnique.mockResolvedValue({ ...ORG_B_DOMAIN_ROW });
    resendDomainsRemove.mockResolvedValue({ data: { id: 'dom_b', object: 'domain', deleted: true }, error: null });

    await request(app).delete('/api/organization/email-domain').set(authHeader('orgB_admin'));

    expect(p.organizationDomain.findUnique).toHaveBeenCalledWith({ where: { organization_id: ORG_B_ID } });
    expect(resendDomainsRemove).toHaveBeenCalledWith('dom_b');
    expect(p.organizationDomain.delete).toHaveBeenCalledWith({ where: { id: 'orgdomain-b' } });
  });

  it.each(['sales', 'dispatcher', 'technician'] as const)('returns 403 for %s (admin-only)', async (role) => {
    mockAuthAs(role);
    const res = await request(app).delete('/api/organization/email-domain').set(authHeader(role));
    expect(res.status).toBe(403);
  });
});
