import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';
import app from '../app';
import { prisma } from '../lib/prisma';
import { mockAuthAs, authHeader, CUSTOMER_FIXTURE, LOCATION_FIXTURE } from './helpers';
import { clearPermissionCache } from '../lib/permissions/permissionCache';

type MockFn = ReturnType<typeof vi.fn>;
const mockPrisma = prisma as unknown as {
  servicePlan: Record<string, MockFn>;
  serviceLocation: Record<string, MockFn>;
  customer: Record<string, MockFn>;
  planVisit: Record<string, MockFn>;
  stateTaxRate: Record<string, MockFn>;
  $transaction: MockFn;
};

const PLAN_ID = 'sp000000-0000-0000-0000-000000000001';
const TECH_ID = '00000000-0000-0000-0000-0000000000aa';
const BAD_LOCATION_ID = '00000000-0000-0000-0000-0000000000bd';

const D = (s: string) => new Date(s);

/** A complete plan row (DRAFT, MONTHLY, 1-year term) with overridable fields. */
const planRow = (over: Record<string, unknown> = {}) => ({
  id: PLAN_ID,
  service_plan_number: 'SP00001',
  customer_id: CUSTOMER_FIXTURE.id,
  service_location_id: LOCATION_FIXTURE.id,
  name: 'MONITORING — Annual',
  status: 'DRAFT',
  visit_cadence: 'MONTHLY',
  start_date: D('2026-01-01T00:00:00.000Z'),
  end_date: D('2026-12-31T00:00:00.000Z'),
  contract_price: '1200.00',
  sold_by: null,
  renewals_count: 0,
  template_id: null,
  line_items: [{ name: 'Annual monitoring', quantity: 1, unit_price: '1200.00', position: 0 }],
  // scheduleVisit loads material_lines via the widened include (LO-5): default empty so the
  // materials-LO mint is a no-op unless a test opts in.
  material_lines: [],
  visits: [],
  customer: { tax_exempt: false },
  service_location: { state: 'CA' },
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  clearPermissionCache();
});

describe('POST /api/service-plans', () => {
  it('creates a DRAFT plan with an allocated SP number (admin)', async () => {
    mockAuthAs('admin');
    mockPrisma.customer.findUnique.mockResolvedValue({ id: CUSTOMER_FIXTURE.id });
    mockPrisma.serviceLocation.findFirst.mockResolvedValue({ id: LOCATION_FIXTURE.id });
    mockPrisma.$transaction.mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) =>
      fn({ servicePlan: { create: vi.fn().mockResolvedValue(planRow()) } }),
    );

    const res = await request(app).post('/api/service-plans').set(authHeader('admin')).send({
      customer_id: CUSTOMER_FIXTURE.id,
      service_location_id: LOCATION_FIXTURE.id,
      name: 'MONITORING — Annual',
      visit_cadence: 'MONTHLY',
      start_date: '2026-01-01T00:00:00.000Z',
      end_date: '2026-12-31T00:00:00.000Z',
      contract_price: 1200,
      line_items: [{ name: 'Annual monitoring', quantity: 1, unit_price: 1200 }],
    });

    expect(res.status).toBe(201);
    expect(res.body.servicePlan.service_plan_number).toBe('SP00001');
  });

  it('creates an open-ended plan when end_date is omitted (P3) → 201, persists end_date null', async () => {
    mockAuthAs('admin');
    mockPrisma.customer.findUnique.mockResolvedValue({ id: CUSTOMER_FIXTURE.id });
    mockPrisma.serviceLocation.findFirst.mockResolvedValue({ id: LOCATION_FIXTURE.id });
    const createSpy = vi.fn().mockResolvedValue(planRow({ end_date: null }));
    mockPrisma.$transaction.mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) =>
      fn({ servicePlan: { create: createSpy } }),
    );

    const res = await request(app).post('/api/service-plans').set(authHeader('admin')).send({
      customer_id: CUSTOMER_FIXTURE.id,
      service_location_id: LOCATION_FIXTURE.id,
      name: 'Recurring septic — ongoing',
      visit_cadence: 'MONTHLY',
      start_date: '2026-01-01T00:00:00.000Z',
      // end_date intentionally omitted → open-ended plan
      contract_price: 600,
      line_items: [],
    });

    expect(res.status).toBe(201);
    expect(createSpy).toHaveBeenCalled();
    expect(createSpy.mock.calls[0][0].data.end_date).toBeNull();
    // Derived fields reflect "ongoing": no finite visits-left.
    expect(res.body.servicePlan.visits_remaining).toBeNull();
    expect(res.body.servicePlan.planned_visit_count).toBeNull();
  });

  it('rejects a location that does not belong to the customer (404)', async () => {
    mockAuthAs('admin');
    mockPrisma.customer.findUnique.mockResolvedValue({ id: CUSTOMER_FIXTURE.id });
    mockPrisma.serviceLocation.findFirst.mockResolvedValue(null);
    const res = await request(app).post('/api/service-plans').set(authHeader('admin')).send({
      customer_id: CUSTOMER_FIXTURE.id, service_location_id: BAD_LOCATION_ID, name: 'X',
      visit_cadence: 'MONTHLY', start_date: '2026-01-01T00:00:00.000Z',
      end_date: '2026-12-31T00:00:00.000Z', contract_price: 100, line_items: [],
    });
    expect(res.status).toBe(404);
  });

  it('rejects unauthenticated (401)', async () => {
    const res = await request(app).post('/api/service-plans').send({});
    expect(res.status).toBe(401);
  });
});

describe('POST /api/service-plans (structured recurrence)', () => {
  const structuredBody = {
    customer_id: CUSTOMER_FIXTURE.id,
    service_location_id: LOCATION_FIXTURE.id,
    name: 'Biweekly Mon/Thu route',
    interval_unit: 'WEEK',
    interval_count: 2,
    byweekday: [1, 4],
    occurrence_count: 6,
    start_date: '2026-01-01T00:00:00.000Z',
    contract_price: 800,
    line_items: [{ name: 'Route visit', quantity: 1, unit_price: 800 }],
  };
  const structuredRow = () =>
    planRow({ visit_cadence: 'BIWEEKLY', interval_unit: 'WEEK', interval_count: 2, byweekday: [1, 4], occurrence_count: 6, end_date: null });

  it('persists the structured fields + computes a best-fit visit_cadence (no enum sent)', async () => {
    mockAuthAs('admin');
    mockPrisma.customer.findUnique.mockResolvedValue({ id: CUSTOMER_FIXTURE.id });
    mockPrisma.serviceLocation.findFirst.mockResolvedValue({ id: LOCATION_FIXTURE.id });
    const createSpy = vi.fn().mockResolvedValue(structuredRow());
    mockPrisma.$transaction.mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) =>
      fn({ servicePlan: { create: createSpy } }),
    );

    const res = await request(app).post('/api/service-plans').set(authHeader('admin')).send(structuredBody);

    expect(res.status).toBe(201);
    const data = createSpy.mock.calls[0][0].data;
    expect(data.interval_unit).toBe('WEEK');
    expect(data.interval_count).toBe(2);
    expect(data.byweekday).toEqual([1, 4]);
    expect(data.occurrence_count).toBe(6);
    expect(data.visit_cadence).toBe('BIWEEKLY'); // best-fit, since the client sent no enum
  });

  it('round-trips the structured fields + derives from them in the response', async () => {
    mockAuthAs('admin');
    mockPrisma.customer.findUnique.mockResolvedValue({ id: CUSTOMER_FIXTURE.id });
    mockPrisma.serviceLocation.findFirst.mockResolvedValue({ id: LOCATION_FIXTURE.id });
    mockPrisma.$transaction.mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) =>
      fn({ servicePlan: { create: vi.fn().mockResolvedValue(structuredRow()) } }),
    );

    const res = await request(app).post('/api/service-plans').set(authHeader('admin')).send(structuredBody);

    expect(res.status).toBe(201);
    expect(res.body.servicePlan).toMatchObject({ interval_unit: 'WEEK', interval_count: 2, byweekday: [1, 4], occurrence_count: 6 });
    // open-ended by occurrence-count → planned reflects the count terminator
    expect(res.body.servicePlan.planned_visit_count).toBe(6);
  });

  it('still accepts a legacy create with only visit_cadence', async () => {
    mockAuthAs('admin');
    mockPrisma.customer.findUnique.mockResolvedValue({ id: CUSTOMER_FIXTURE.id });
    mockPrisma.serviceLocation.findFirst.mockResolvedValue({ id: LOCATION_FIXTURE.id });
    const createSpy = vi.fn().mockResolvedValue(planRow());
    mockPrisma.$transaction.mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) =>
      fn({ servicePlan: { create: createSpy } }),
    );
    const res = await request(app).post('/api/service-plans').set(authHeader('admin')).send({
      customer_id: CUSTOMER_FIXTURE.id, service_location_id: LOCATION_FIXTURE.id, name: 'Legacy',
      visit_cadence: 'MONTHLY', start_date: '2026-01-01T00:00:00.000Z', contract_price: 100,
      line_items: [{ name: 'x', quantity: 1, unit_price: 100 }],
    });
    expect(res.status).toBe(201);
    expect(createSpy.mock.calls[0][0].data.visit_cadence).toBe('MONTHLY');
    expect(createSpy.mock.calls[0][0].data.interval_unit).toBeUndefined();
  });

  it('rejects a create with neither a cadence nor structured recurrence (400)', async () => {
    mockAuthAs('admin');
    const res = await request(app).post('/api/service-plans').set(authHeader('admin')).send({
      customer_id: CUSTOMER_FIXTURE.id, service_location_id: LOCATION_FIXTURE.id, name: 'X',
      start_date: '2026-01-01T00:00:00.000Z', contract_price: 100, line_items: [],
    });
    expect(res.status).toBe(400);
  });

  it('rejects an out-of-range weekday (400)', async () => {
    mockAuthAs('admin');
    const res = await request(app).post('/api/service-plans').set(authHeader('admin')).send({ ...structuredBody, byweekday: [1, 7] });
    expect(res.status).toBe(400);
  });
});

describe('GET /api/service-plans', () => {
  it('lists plans scoped to the org with derived fields (admin)', async () => {
    mockAuthAs('admin');
    mockPrisma.servicePlan.findMany.mockResolvedValue([planRow({ status: 'ACTIVE', visits: [] })]);
    const res = await request(app).get('/api/service-plans').set(authHeader('admin'));
    expect(res.status).toBe(200);
    expect(res.body.servicePlans).toHaveLength(1);
    expect(res.body.servicePlans[0]).toHaveProperty('visits_remaining');
    expect(res.body.servicePlans[0]).toHaveProperty('next_due');
    expect(res.body.servicePlans[0]).toHaveProperty('effective_status');
    expect(mockPrisma.servicePlan.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ organization_id: expect.any(String) }) }),
    );
  });
});

describe('POST /api/service-plans/:id/activate', () => {
  it('mints exactly one job-less kind=PLAN invoice with tax and flips the plan ACTIVE', async () => {
    mockAuthAs('admin');
    mockPrisma.servicePlan.findFirst.mockResolvedValue(planRow({ status: 'DRAFT' }));
    mockPrisma.stateTaxRate.findFirst.mockResolvedValue({ tax_rate: '0.0875' });
    const invoiceCreate = vi.fn().mockResolvedValue({ id: 'inv1', invoice_number: 'I00001', kind: 'PLAN' });
    const planUpdate = vi.fn().mockResolvedValue(planRow({ status: 'ACTIVE' }));
    mockPrisma.$transaction.mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) =>
      fn({ invoice: { create: invoiceCreate }, servicePlan: { update: planUpdate } }),
    );

    const res = await request(app).post(`/api/service-plans/${PLAN_ID}/activate`).set(authHeader('admin'));

    expect(res.status).toBe(200);
    expect(invoiceCreate).toHaveBeenCalledTimes(1);
    expect(invoiceCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          kind: 'PLAN', status: 'SENT', service_plan_id: PLAN_ID, job_id: null,
          subtotal: 1200, tax_amount: 105, total_amount: 1305,
        }),
      }),
    );
    expect(planUpdate).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ status: 'ACTIVE' }) }));
  });

  it('zeroes tax for a tax-exempt customer', async () => {
    mockAuthAs('admin');
    mockPrisma.servicePlan.findFirst.mockResolvedValue(planRow({ status: 'DRAFT', customer: { tax_exempt: true } }));
    const invoiceCreate = vi.fn().mockResolvedValue({ id: 'inv1' });
    mockPrisma.$transaction.mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) =>
      fn({ invoice: { create: invoiceCreate }, servicePlan: { update: vi.fn().mockResolvedValue(planRow({ status: 'ACTIVE' })) } }),
    );
    const res = await request(app).post(`/api/service-plans/${PLAN_ID}/activate`).set(authHeader('admin'));
    expect(res.status).toBe(200);
    expect(invoiceCreate).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ tax_amount: 0, total_amount: 1200 }) }),
    );
    expect(mockPrisma.stateTaxRate.findFirst).not.toHaveBeenCalled();
  });

  it('rejects activating a non-draft plan (400)', async () => {
    mockAuthAs('admin');
    mockPrisma.servicePlan.findFirst.mockResolvedValue(planRow({ status: 'ACTIVE' }));
    const res = await request(app).post(`/api/service-plans/${PLAN_ID}/activate`).set(authHeader('admin'));
    expect(res.status).toBe(400);
  });
});

describe('POST /api/service-plans/:id/renew', () => {
  it('rolls the term window, bumps renewals, and mints a fresh PLAN invoice', async () => {
    mockAuthAs('admin');
    mockPrisma.servicePlan.findFirst.mockResolvedValue(planRow({ status: 'ACTIVE' }));
    mockPrisma.stateTaxRate.findFirst.mockResolvedValue({ tax_rate: '0' });
    const invoiceCreate = vi.fn().mockResolvedValue({ id: 'inv2', kind: 'PLAN' });
    const planUpdate = vi.fn().mockResolvedValue(planRow({ status: 'ACTIVE', renewals_count: 1 }));
    mockPrisma.$transaction.mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) =>
      fn({ invoice: { create: invoiceCreate }, servicePlan: { update: planUpdate } }),
    );

    const res = await request(app).post(`/api/service-plans/${PLAN_ID}/renew`).set(authHeader('admin'));

    expect(res.status).toBe(200);
    expect(invoiceCreate).toHaveBeenCalledTimes(1);
    const updateData = planUpdate.mock.calls[0][0].data;
    expect(updateData.renewals_count).toEqual({ increment: 1 });
    expect(updateData.status).toBe('ACTIVE');
    // New term starts where the old one ended.
    expect(new Date(updateData.start_date).toISOString()).toBe('2026-12-31T00:00:00.000Z');
  });

  it('rejects renewing a non-active plan (400)', async () => {
    mockAuthAs('admin');
    mockPrisma.servicePlan.findFirst.mockResolvedValue(planRow({ status: 'DRAFT' }));
    const res = await request(app).post(`/api/service-plans/${PLAN_ID}/renew`).set(authHeader('admin'));
    expect(res.status).toBe(400);
  });
});

describe('POST /api/service-plans/:id/cancel', () => {
  it('cancels an active plan', async () => {
    mockAuthAs('admin');
    mockPrisma.servicePlan.findFirst.mockResolvedValue({ id: PLAN_ID, status: 'ACTIVE' });
    mockPrisma.servicePlan.update.mockResolvedValue(planRow({ status: 'CANCELLED' }));
    const res = await request(app).post(`/api/service-plans/${PLAN_ID}/cancel`).set(authHeader('admin'));
    expect(res.status).toBe(200);
    expect(mockPrisma.servicePlan.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: { status: 'CANCELLED' }, where: { id: PLAN_ID } }),
    );
  });

  it('rejects cancelling a draft plan (400)', async () => {
    mockAuthAs('admin');
    mockPrisma.servicePlan.findFirst.mockResolvedValue({ id: PLAN_ID, status: 'DRAFT' });
    const res = await request(app).post(`/api/service-plans/${PLAN_ID}/cancel`).set(authHeader('admin'));
    expect(res.status).toBe(400);
  });
});

describe('PATCH /api/service-plans/:id (edit-lock)', () => {
  it('lets a DRAFT plan change its cadence', async () => {
    mockAuthAs('admin');
    mockPrisma.servicePlan.findFirst.mockResolvedValue({ id: PLAN_ID, status: 'DRAFT' });
    mockPrisma.$transaction.mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) =>
      fn({ servicePlan: { update: vi.fn().mockResolvedValue(planRow({ visit_cadence: 'WEEKLY' })) } }),
    );
    const res = await request(app).patch(`/api/service-plans/${PLAN_ID}`).set(authHeader('admin')).send({ visit_cadence: 'WEEKLY' });
    expect(res.status).toBe(200);
  });

  it('relabels visit_cadence from the merged recurrence when a draft PATCH changes only the interval', async () => {
    mockAuthAs('admin');
    // Stored WEEK/1 (→ WEEKLY); PATCH bumps interval_count to 2 → best-fit should become BIWEEKLY.
    mockPrisma.servicePlan.findFirst.mockResolvedValue({
      id: PLAN_ID, status: 'DRAFT', visit_cadence: 'WEEKLY', interval_unit: 'WEEK', interval_count: 1, byweekday: [], occurrence_count: null,
    });
    const updateSpy = vi.fn().mockResolvedValue(planRow({ visit_cadence: 'BIWEEKLY', interval_unit: 'WEEK', interval_count: 2 }));
    mockPrisma.$transaction.mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) =>
      fn({ servicePlan: { update: updateSpy }, servicePlanLineItem: { deleteMany: vi.fn(), createMany: vi.fn() } }),
    );
    const res = await request(app).patch(`/api/service-plans/${PLAN_ID}`).set(authHeader('admin')).send({ interval_count: 2 });
    expect(res.status).toBe(200);
    expect(updateSpy.mock.calls[0][0].data.visit_cadence).toBe('BIWEEKLY');
  });

  it('blocks a cadence edit on an ACTIVE plan (400)', async () => {
    mockAuthAs('admin');
    mockPrisma.servicePlan.findFirst.mockResolvedValue({ id: PLAN_ID, status: 'ACTIVE' });
    const res = await request(app).patch(`/api/service-plans/${PLAN_ID}`).set(authHeader('admin')).send({ visit_cadence: 'WEEKLY' });
    expect(res.status).toBe(400);
  });

  it('allows a name edit on an ACTIVE plan', async () => {
    mockAuthAs('admin');
    mockPrisma.servicePlan.findFirst.mockResolvedValue({ id: PLAN_ID, status: 'ACTIVE' });
    mockPrisma.servicePlan.update.mockResolvedValue(planRow({ status: 'ACTIVE', name: 'Renamed' }));
    const res = await request(app).patch(`/api/service-plans/${PLAN_ID}`).set(authHeader('admin')).send({ name: 'Renamed' });
    expect(res.status).toBe(200);
  });
});

describe('DELETE /api/service-plans/:id (draft-only)', () => {
  it('deletes a DRAFT plan', async () => {
    mockAuthAs('admin');
    mockPrisma.servicePlan.findFirst.mockResolvedValue({ id: PLAN_ID, status: 'DRAFT' });
    mockPrisma.servicePlan.deleteMany.mockResolvedValue({ count: 1 });
    const res = await request(app).delete(`/api/service-plans/${PLAN_ID}`).set(authHeader('admin'));
    expect(res.status).toBe(204);
  });

  it('refuses to delete an ACTIVE plan (400)', async () => {
    mockAuthAs('admin');
    mockPrisma.servicePlan.findFirst.mockResolvedValue({ id: PLAN_ID, status: 'ACTIVE' });
    const res = await request(app).delete(`/api/service-plans/${PLAN_ID}`).set(authHeader('admin'));
    expect(res.status).toBe(400);
  });
});

describe('POST /api/service-plans/:id/schedule-visit', () => {
  it('creates a PlanVisit + a visit-job in one transaction and assigns the tech', async () => {
    mockAuthAs('admin');
    mockPrisma.servicePlan.findFirst.mockResolvedValue(planRow({ status: 'ACTIVE', visits: [] }));
    const jobCreate = vi.fn().mockResolvedValue({ id: 'job1', job_number: 'J00001' });
    const visitCreate = vi.fn().mockResolvedValue({ id: 'pv1', visit_number: 1 });
    const visitCount = vi.fn().mockResolvedValue(0);
    const timelineCreate = vi.fn().mockResolvedValue({});
    mockPrisma.$transaction.mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) =>
      fn({ job: { create: jobCreate }, planVisit: { count: visitCount, create: visitCreate }, timelineEvent: { create: timelineCreate } }),
    );

    const res = await request(app).post(`/api/service-plans/${PLAN_ID}/schedule-visit`).set(authHeader('admin')).send({
      scheduled_start: '2026-04-01T15:00:00.000Z', assigned_to: TECH_ID,
    });

    expect(res.status).toBe(201);
    expect(jobCreate).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ source_plan_id: PLAN_ID, status: 'SCHEDULED', assignees: { create: expect.objectContaining({ user_id: TECH_ID }) } }) }),
    );
    expect(visitCreate).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ job_id: 'job1', status: 'SCHEDULED', visit_number: 1 }) }),
    );
  });

  it('spawns the visit-job SCHEDULED with no crew (state-4) when no tech is picked', async () => {
    mockAuthAs('admin');
    mockPrisma.servicePlan.findFirst.mockResolvedValue(planRow({ status: 'ACTIVE', visits: [] }));
    const jobCreate = vi.fn().mockResolvedValue({ id: 'job1', job_number: 'J00001' });
    mockPrisma.$transaction.mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) =>
      fn({ job: { create: jobCreate }, planVisit: { count: vi.fn().mockResolvedValue(0), create: vi.fn().mockResolvedValue({ id: 'pv1' }) }, timelineEvent: { create: vi.fn() } }),
    );
    const res = await request(app).post(`/api/service-plans/${PLAN_ID}/schedule-visit`).set(authHeader('admin')).send({ scheduled_start: '2026-04-01T15:00:00.000Z' });
    expect(res.status).toBe(201);
    // Scheduler-redesign: status is time-based — a visit with a time is SCHEDULED even with
    // no crew (state 4, "needs assignment"); crew is the independent M2M, so no assignees here.
    expect(jobCreate).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ status: 'SCHEDULED' }) }));
    expect((jobCreate.mock.calls[0][0] as { data: { assignees?: unknown } }).data.assignees).toBeUndefined();
  });

  it('rejects scheduling when the plan is not active (400)', async () => {
    mockAuthAs('admin');
    mockPrisma.servicePlan.findFirst.mockResolvedValue(planRow({ status: 'DRAFT', visits: [] }));
    const res = await request(app).post(`/api/service-plans/${PLAN_ID}/schedule-visit`).set(authHeader('admin')).send({ scheduled_start: '2026-04-01T15:00:00.000Z' });
    expect(res.status).toBe(400);
  });

  it('rejects scheduling when no visits remain (400)', async () => {
    mockAuthAs('admin');
    // ANNUAL term => 1 planned slot; one in-term COMPLETED visit => 0 remaining.
    mockPrisma.servicePlan.findFirst.mockResolvedValue(planRow({
      status: 'ACTIVE', visit_cadence: 'ANNUAL',
      visits: [{ status: 'COMPLETED', scheduled_date: D('2026-01-01T00:00:00.000Z') }],
    }));
    const res = await request(app).post(`/api/service-plans/${PLAN_ID}/schedule-visit`).set(authHeader('admin')).send({ scheduled_start: '2026-06-01T15:00:00.000Z' });
    expect(res.status).toBe(400);
  });
});

describe('GET /api/service-plans/scheduler-bucket', () => {
  it('returns active plans with remaining visits and derived fields', async () => {
    mockAuthAs('admin');
    mockPrisma.servicePlan.findMany.mockResolvedValue([
      planRow({
        status: 'ACTIVE', visits: [],
        customer: { company_name: 'Acme HVAC', first_name: null, last_name: null },
        service_location: { city: 'Austin', state: 'TX', address_line1: '1 Main St' },
      }),
    ]);
    const res = await request(app).get('/api/service-plans/scheduler-bucket').set(authHeader('admin'));
    expect(res.status).toBe(200);
    expect(res.body.plans).toHaveLength(1);
    expect(res.body.plans[0]).toMatchObject({ service_plan_number: 'SP00001', customer: 'Acme HVAC' });
    expect(res.body.plans[0]).toHaveProperty('next_due');
    expect(res.body.plans[0]).toHaveProperty('visits_remaining');
    expect(res.body.plans[0]).toHaveProperty('overdue');
    expect(mockPrisma.servicePlan.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ status: 'ACTIVE', organization_id: expect.any(String) }) }),
    );
  });
});
