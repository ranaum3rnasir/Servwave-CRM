import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';
import app from '../app';
import { prisma } from '../lib/prisma';
import { mockAuthAs, authHeader, ALPHA_ORG_ID, ORG_B_ID } from './helpers';

const LOCATION_FIXTURE = {
  id: 'a0000000-0000-0000-0000-0000000000aa',
  organization_id: ALPHA_ORG_ID,
  name: 'Main Branch',
  code: 'MAIN',
  address_line1: '1 Main St',
  city: 'Austin',
  state: 'TX',
  postal_code: '78701',
  country: 'US',
  timezone: 'America/Chicago',
  phone: null,
  manager_id: null,
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe('GET /api/locations', () => {
  it('lists scoped to org', async () => {
    mockAuthAs('admin');
    (prisma.location.findMany as any).mockResolvedValue([LOCATION_FIXTURE]);
    const res = await request(app).get('/api/locations').set(authHeader('admin'));
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect((prisma.location.findMany as any).mock.calls[0][0].where).toMatchObject({
      organization_id: ALPHA_ORG_ID,
    });
  });
});

describe('POST /api/locations', () => {
  it('creates with requesting org', async () => {
    mockAuthAs('admin');
    (prisma.location.create as any).mockResolvedValue(LOCATION_FIXTURE);
    const res = await request(app)
      .post('/api/locations')
      .set(authHeader('admin'))
      .send({ name: 'Main Branch', code: 'MAIN', city: 'Austin', state: 'TX' });
    expect(res.status).toBe(201);
    expect((prisma.location.create as any).mock.calls[0][0].data).toMatchObject({
      organization_id: ALPHA_ORG_ID,
      name: 'Main Branch',
      code: 'MAIN',
    });
  });
  it('rejects missing name (400)', async () => {
    mockAuthAs('admin');
    const res = await request(app).post('/api/locations').set(authHeader('admin')).send({ code: 'X' });
    expect(res.status).toBe(400);
  });
  it('creates without a code (code is no longer required)', async () => {
    mockAuthAs('admin');
    (prisma.location.create as any).mockResolvedValue({ ...LOCATION_FIXTURE, code: null });
    const res = await request(app)
      .post('/api/locations')
      .set(authHeader('admin'))
      .send({ name: 'Warehouse', city: 'Austin' });
    expect(res.status).toBe(201);
    expect((prisma.location.create as any).mock.calls[0][0].data).toMatchObject({
      organization_id: ALPHA_ORG_ID,
      name: 'Warehouse',
    });
  });
});

describe('PATCH /api/locations/:id', () => {
  it('updates only within org', async () => {
    mockAuthAs('admin');
    (prisma.location.updateMany as any).mockResolvedValue({ count: 1 });
    (prisma.location.findFirst as any).mockResolvedValue({ ...LOCATION_FIXTURE, name: 'Renamed' });
    const res = await request(app)
      .patch(`/api/locations/${LOCATION_FIXTURE.id}`)
      .set(authHeader('admin'))
      .send({ name: 'Renamed' });
    expect(res.status).toBe(200);
    expect((prisma.location.updateMany as any).mock.calls[0][0].where).toMatchObject({
      id: LOCATION_FIXTURE.id,
      organization_id: ALPHA_ORG_ID,
    });
  });
  it('accepts a full echoed row (created_at/updated_at/null optionals) without 400', async () => {
    // #107 (C2): the FE row-click loads the raw API row; an edit must round-trip
    // even with server-echoed read-only keys and null optionals present.
    mockAuthAs('admin');
    (prisma.location.updateMany as any).mockResolvedValue({ count: 1 });
    (prisma.location.findFirst as any).mockResolvedValue({ ...LOCATION_FIXTURE, name: 'Renamed' });
    const res = await request(app)
      .patch(`/api/locations/${LOCATION_FIXTURE.id}`)
      .set(authHeader('admin'))
      .send({
        ...LOCATION_FIXTURE,
        name: 'Renamed',
        address_line2: null,
        postal_code: null,
        created_at: '2026-01-01T00:00:00.000Z',
        updated_at: '2026-01-02T00:00:00.000Z',
        manager: null,
        _count: { members: 0 },
      });
    expect(res.status).toBe(200);
    // read-only / relational keys must not reach the Prisma write payload
    const data = (prisma.location.updateMany as any).mock.calls[0][0].data;
    expect(data).not.toHaveProperty('created_at');
    expect(data).not.toHaveProperty('updated_at');
    expect(data).not.toHaveProperty('manager');
    expect(data).not.toHaveProperty('_count');
    expect(data).not.toHaveProperty('id');
  });

  it('accepts manager_id = null (— None — selection)', async () => {
    // #107 (C3): "— None —" must clear the manager, not 400.
    mockAuthAs('admin');
    (prisma.location.updateMany as any).mockResolvedValue({ count: 1 });
    (prisma.location.findFirst as any).mockResolvedValue({ ...LOCATION_FIXTURE, manager_id: null });
    const res = await request(app)
      .patch(`/api/locations/${LOCATION_FIXTURE.id}`)
      .set(authHeader('admin'))
      .send({ manager_id: null });
    expect(res.status).toBe(200);
    expect((prisma.location.updateMany as any).mock.calls[0][0].data).toMatchObject({ manager_id: null });
  });

  it('404 when cross-org (count 0)', async () => {
    mockAuthAs('orgB_admin');
    (prisma.location.updateMany as any).mockResolvedValue({ count: 0 });
    const res = await request(app)
      .patch(`/api/locations/${LOCATION_FIXTURE.id}`)
      .set(authHeader('orgB_admin'))
      .send({ name: 'x' });
    expect(res.status).toBe(404);
    expect((prisma.location.updateMany as any).mock.calls[0][0].where).toMatchObject({
      organization_id: ORG_B_ID,
    });
  });
});

describe('DELETE /api/locations/:id', () => {
  it('blocks delete when users reference it (409)', async () => {
    mockAuthAs('admin');
    (prisma.user.count as any).mockResolvedValue(2);
    const res = await request(app).delete(`/api/locations/${LOCATION_FIXTURE.id}`).set(authHeader('admin'));
    expect(res.status).toBe(409);
  });
  it('deletes within org when unreferenced', async () => {
    mockAuthAs('admin');
    (prisma.user.count as any).mockResolvedValue(0);
    (prisma.location.deleteMany as any).mockResolvedValue({ count: 1 });
    const res = await request(app).delete(`/api/locations/${LOCATION_FIXTURE.id}`).set(authHeader('admin'));
    expect(res.status).toBe(204);
    expect((prisma.location.deleteMany as any).mock.calls[0][0].where).toMatchObject({
      id: LOCATION_FIXTURE.id,
      organization_id: ALPHA_ORG_ID,
    });
  });
});

describe('locations isolation', () => {
  it('technician (no Location grant) gets 403 on create', async () => {
    mockAuthAs('technician');
    const res = await request(app)
      .post('/api/locations')
      .set(authHeader('technician'))
      .send({ name: 'X', code: 'X' });
    expect(res.status).toBe(403);
  });
});
