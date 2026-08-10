import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';
import app from '../app';
import { prisma } from '../lib/prisma';
import { mockAuthAs, authHeader } from './helpers';

// ─────────────────────────────────────────────────────────────────────────────
// Walkthrough-as-entity redesign, PR-B2 — PR-D2 gap #4: `GET /api/search?scope=schedule`
// was the last site still filtering/sorting/serializing off the raw legacy
// `Lead.walkthrough_scheduled_at` column instead of the new `Walkthrough` relation. A later
// stage that tried to drop the legacy columns found this made the drop unsafe. These tests
// assert the schedule-scope lead query is fully repointed onto the relation while the JSON
// response's `date` field keeps behaving exactly as before (D15 "current visit" sourced).
// ─────────────────────────────────────────────────────────────────────────────

const m = prisma as unknown as {
  lead: { findMany: ReturnType<typeof vi.fn> };
  job: { findMany: ReturnType<typeof vi.fn> };
  customer: { findMany: ReturnType<typeof vi.fn> };
  estimate: { findMany: ReturnType<typeof vi.fn> };
  invoice: { findMany: ReturnType<typeof vi.fn> };
};

function reset() {
  vi.clearAllMocks();
  m.lead.findMany.mockResolvedValue([]);
  m.job.findMany.mockResolvedValue([]);
  m.customer.findMany.mockResolvedValue([]);
  m.estimate.findMany.mockResolvedValue([]);
  m.invoice.findMany.mockResolvedValue([]);
}

function wheresOf(mock: ReturnType<typeof vi.fn>): Record<string, unknown>[] {
  return mock.mock.calls.map((c) => c[0].where as Record<string, unknown>);
}

function deepHas(node: unknown, key: string): boolean {
  if (Array.isArray(node)) return node.some((n) => deepHas(n, key));
  if (node && typeof node === 'object') {
    if (key in (node as Record<string, unknown>)) return true;
    return Object.values(node as Record<string, unknown>).some((v) => deepHas(v, key));
  }
  return false;
}

describe('GET /api/search?scope=schedule — repointed onto the Walkthrough relation (PR-D2 gap)', () => {
  beforeEach(reset);

  it('filters leads by the walkthroughs relation, never the raw walkthrough_scheduled_at column', async () => {
    mockAuthAs('admin');
    const res = await request(app).get('/api/search').query({ q: 'doe', scope: 'schedule' }).set(authHeader('admin'));
    expect(res.status).toBe(200);

    expect(m.lead.findMany).toHaveBeenCalled();
    for (const w of wheresOf(m.lead.findMany)) {
      expect(deepHas(w, 'walkthrough_scheduled_at')).toBe(false);
      expect(deepHas(w, 'walkthroughs')).toBe(true);
    }
  });

  it("sources a schedule-scope lead's date from its CURRENT (SCHEDULED) visit, not a raw column", async () => {
    mockAuthAs('admin');
    const scheduledAt = new Date('2026-08-15T14:00:00.000Z');
    m.lead.findMany.mockResolvedValue([
      {
        id: 'lead-1',
        lead_number: 'L00203',
        service_request: 'Furnace inspection',
        status: 'CONTACTED',
        created_at: new Date('2026-08-01T00:00:00.000Z'),
        service_address_line1: '100 Test Ave',
        service_city: 'Austin',
        service_state: 'TX',
        customer: { first_name: 'John', last_name: 'Doe', company_name: null, phone: '5551234567' },
        // A COMPLETED older visit plus the CURRENT SCHEDULED one — the raw
        // walkthrough_scheduled_at column (dual-write) never clears on completion, so this
        // fixture only proves the fix if the resolver picks the SCHEDULED row over it.
        walkthroughs: [
          {
            id: 'w-old', status: 'COMPLETED', scheduled_at: new Date('2026-07-01T09:00:00.000Z'),
            duration_minutes: 60, completed_at: new Date('2026-07-01T10:00:00.000Z'), notes: null,
            cancelled_at: null, cancelled_reason: null, cancelled_by: null,
            customer_email_sent_at: null, created_at: new Date('2026-06-25T00:00:00.000Z'), canceller: null,
          },
          {
            id: 'w-current', status: 'SCHEDULED', scheduled_at: scheduledAt,
            duration_minutes: 60, completed_at: null, notes: null,
            cancelled_at: null, cancelled_reason: null, cancelled_by: null,
            customer_email_sent_at: null, created_at: new Date('2026-08-01T00:00:00.000Z'), canceller: null,
          },
        ],
      },
    ]);

    const res = await request(app).get('/api/search').query({ q: 'doe', scope: 'schedule' }).set(authHeader('admin'));
    expect(res.status).toBe(200);

    const lead = res.body.results.leads.find((l: { id: string }) => l.id === 'lead-1');
    expect(lead).toBeDefined();
    expect(lead.date).toBe(scheduledAt.toISOString());
    // Schedule rows are titled by the L-number, mirroring the board card (and job rows).
    expect(lead.title).toBe('L00203');
  });
});
