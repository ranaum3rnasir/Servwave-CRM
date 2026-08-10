import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { Mock } from 'vitest';
import request from 'supertest';
import app from '../app';
import { prisma } from '../lib/prisma';
import { mockAuthAs, authHeader } from './helpers';
import { clearTokenCache } from '../middleware/authenticate';

// Walkthrough-as-entity redesign, PR-B2: dashboard.controller.ts's attention-item "needs
// scheduling" query and its schedule-widget "today's walkthroughs" query both repointed off the
// legacy Lead.walkthrough_* columns onto the Walkthrough table.

function stubEveryDashboardQuery() {
  (prisma.job.groupBy as Mock).mockResolvedValue([]);
  (prisma.job.count as Mock).mockResolvedValue(0);
  (prisma.invoice.aggregate as Mock).mockResolvedValue({ _sum: {}, _avg: {}, _count: { _all: 0 } });
  (prisma.estimate.aggregate as Mock).mockResolvedValue({ _sum: {} });
  (prisma.job.aggregate as Mock).mockResolvedValue({ _sum: {} });
  (prisma.payment.aggregate as Mock).mockResolvedValue({ _sum: {} });
  (prisma.appSetting.findUnique as Mock).mockResolvedValue(null);
  (prisma.lead.findMany as Mock).mockResolvedValue([]);
  (prisma.lead.groupBy as Mock).mockResolvedValue([]);
  (prisma.lead.count as Mock).mockResolvedValue(0);
  (prisma.estimate.findMany as Mock).mockResolvedValue([]);
  (prisma.job.findMany as Mock).mockResolvedValue([]);
  (prisma.servicePlan.findMany as Mock).mockResolvedValue([]);
  (prisma.user.findMany as Mock).mockResolvedValue([]);
  (prisma.timelineEvent.findMany as Mock).mockResolvedValue([]);
  (prisma.invoice.findMany as Mock).mockResolvedValue([]);
  (prisma.walkthrough.findMany as Mock).mockResolvedValue([]);
  (prisma.$queryRaw as Mock).mockResolvedValue([]);
}

beforeEach(() => {
  vi.clearAllMocks();
  clearTokenCache();
  stubEveryDashboardQuery();
});

describe('GET /api/dashboard — walkthrough attention query', () => {
  it('filters the "needs scheduling" attention query by Walkthrough.status = REQUESTED, not lead status/columns', async () => {
    mockAuthAs('orgB_admin');

    const res = await request(app).get('/api/dashboard').set(authHeader('orgB_admin'));

    expect(res.status).toBe(200);
    const leadFindManyCalls = (prisma.lead.findMany as Mock).mock.calls;
    const attentionCall = leadFindManyCalls.find((c: any[]) => c[0]?.where?.walkthroughs !== undefined);
    expect(attentionCall).toBeDefined();
    expect(attentionCall![0].where.walkthroughs).toEqual({ some: { status: 'REQUESTED' } });
    // The old legacy-column filters must be gone.
    expect(attentionCall![0].where.walkthrough_needed).toBeUndefined();
    expect(attentionCall![0].where.walkthrough_scheduled_at).toBeUndefined();
  });
});

describe('GET /api/dashboard — schedule widget walkthroughs', () => {
  it('queries the Walkthrough table (SCHEDULED/COMPLETED) instead of Lead.walkthrough_scheduled_at', async () => {
    mockAuthAs('orgB_admin');

    const res = await request(app).get('/api/dashboard').set(authHeader('orgB_admin'));

    expect(res.status).toBe(200);
    expect(prisma.walkthrough.findMany).toHaveBeenCalled();
    const call = (prisma.walkthrough.findMany as Mock).mock.calls[0][0];
    expect(call.where.status).toEqual({ in: ['SCHEDULED', 'COMPLETED'] });
    expect(call.where.scheduled_at).toBeDefined();
  });

  it('the schedule lane entity keeps the LEAD id (not the Walkthrough row id) for the frontend link contract', async () => {
    mockAuthAs('orgB_admin');
    (prisma.walkthrough.findMany as Mock).mockResolvedValue([
      {
        id: 'wt-1',
        scheduled_at: new Date(),
        duration_minutes: 60,
        completed_at: null,
        lead: {
          id: 'lead-1',
          lead_number: 'L00001',
          service_request: 'AC repair',
          customer: { first_name: 'John', last_name: 'Doe', company_name: null },
          service_location: { address_line1: '123 Main St', city: 'Austin' },
        },
        performers: [{ user: { id: 'u1', first_name: 'Test', last_name: 'Tech' } }],
      },
    ]);

    const res = await request(app).get('/api/dashboard').set(authHeader('orgB_admin'));

    expect(res.status).toBe(200);
    const lanes = res.body.schedule_today ?? [];
    const walkthroughEntry = lanes
      .flatMap((lane: any) => lane.jobs ?? [])
      .find((item: any) => item.entity === 'walkthrough');
    expect(walkthroughEntry).toBeDefined();
    expect(walkthroughEntry.id).toBe('lead-1');
  });
});
