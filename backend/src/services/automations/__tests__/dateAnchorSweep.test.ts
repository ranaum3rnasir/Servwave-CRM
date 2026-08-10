import { describe, it, expect, beforeEach, vi } from 'vitest';
import { prisma } from '../../../lib/prisma';
import { anchorWindow, AFTER_GRACE_MS, candidatesForAnchor } from '../dateAnchorSweep';

const mockPrisma = prisma as any;

const now = new Date('2026-07-18T12:00:00.000Z');
const DAY = 24 * 60 * 60 * 1000;

describe('anchorWindow', () => {
  it('before: selects anchors from now through now+offset', () => {
    const w = anchorWindow('before', DAY, now);
    expect(w.gte.toISOString()).toBe(now.toISOString());
    expect(w.lte.toISOString()).toBe(new Date(now.getTime() + DAY).toISOString());
  });

  it('before: a still-upcoming anchor inside the lead time IS in the window (late but useful)', () => {
    const w = anchorWindow('before', DAY, now);
    const inTwelveHours = new Date(now.getTime() + DAY / 2);
    expect(inTwelveHours >= w.gte && inTwelveHours <= w.lte).toBe(true);
  });

  it('before: an already-past anchor is NOT in the window (no stale reminder)', () => {
    const w = anchorWindow('before', DAY, now);
    const yesterday = new Date(now.getTime() - DAY);
    expect(yesterday >= w.gte).toBe(false);
  });

  it('after: selects anchors whose fire moment (anchor+offset) has just arrived', () => {
    const w = anchorWindow('after', DAY, now);
    expect(w.lte.toISOString()).toBe(new Date(now.getTime() - DAY).toISOString());
    expect(w.gte.toISOString()).toBe(new Date(now.getTime() - DAY - AFTER_GRACE_MS).toISOString());
  });

  it('after: bounded below so enabling a workflow never blasts history', () => {
    const w = anchorWindow('after', DAY, now);
    const ancient = new Date(now.getTime() - 365 * DAY);
    expect(ancient >= w.gte).toBe(false);
  });
});

describe('candidatesForAnchor', () => {
  const ORG = 'org-1';
  const WINDOW = { gte: now, lte: new Date(now.getTime() + DAY) };

  beforeEach(() => {
    vi.clearAllMocks();
    mockPrisma.job.findMany.mockResolvedValue([]);
    mockPrisma.lead.findMany.mockResolvedValue([]);
    mockPrisma.walkthrough.findMany.mockResolvedValue([]);
    mockPrisma.invoice.findMany.mockResolvedValue([]);
    mockPrisma.estimate.findMany.mockResolvedValue([]);
  });

  it('job.scheduled_start: selects SCHEDULED jobs by scheduled_start and keys the occurrence on it', async () => {
    const start = new Date('2026-07-19T09:00:00.000Z');
    mockPrisma.job.findMany.mockResolvedValueOnce([
      { id: 'job-1', job_number: 'J00042', scheduled_start: start },
    ]);

    const out = await candidatesForAnchor('job.scheduled_start', ORG, WINDOW);

    const q = mockPrisma.job.findMany.mock.calls[0][0];
    expect(q.where).toEqual({ organization_id: ORG, status: 'SCHEDULED', scheduled_start: WINDOW });
    expect(out).toEqual([
      { entityType: 'job', entityId: 'job-1', entityLabel: 'J00042', occurrence: start.toISOString() },
    ]);
  });

  // Walkthrough-as-entity redesign, PR-B2: repointed onto the Walkthrough table directly
  // (scanning visit rows, not a single flat column per lead), still with no status filter —
  // terminalStale's LEAD_DATE_ANCHORED case re-checks the visit's own status at execution time.
  it('lead.walkthrough_scheduled_at: selects walkthrough rows by scheduled_at with no status filter and keys the occurrence on it (entity = the LEAD)', async () => {
    const walkthrough = new Date('2026-07-19T09:00:00.000Z');
    mockPrisma.walkthrough.findMany.mockResolvedValueOnce([
      { scheduled_at: walkthrough, lead: { id: 'lead-1', lead_number: 'L00007' } },
    ]);

    const out = await candidatesForAnchor('lead.walkthrough_scheduled_at', ORG, WINDOW);

    const q = mockPrisma.walkthrough.findMany.mock.calls[0][0];
    expect(q.where).toEqual({ organization_id: ORG, scheduled_at: WINDOW });
    expect(out).toEqual([
      { entityType: 'lead', entityId: 'lead-1', entityLabel: 'L00007', occurrence: walkthrough.toISOString() },
    ]);
  });

  it('invoice.due_date: selects open invoices by due date and keys the occurrence on the due date', async () => {
    const due = new Date('2026-08-01T12:00:00.000Z');
    mockPrisma.invoice.findMany.mockResolvedValueOnce([
      { id: 'inv-1', invoice_number: 'I00001', due_date: due },
    ]);
    const window = { gte: new Date('2026-07-18T12:00:00.000Z'), lte: due };

    const out = await candidatesForAnchor('invoice.due_date', ORG, window);

    expect(mockPrisma.invoice.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          organization_id: ORG,
          status: { in: ['SENT', 'PARTIAL'] },
          amount_due: { gt: 0 },
          due_date: window,
        }),
      }),
    );
    expect(out).toEqual([
      { entityType: 'invoice', entityId: 'inv-1', entityLabel: 'I00001', occurrence: due.toISOString() },
    ]);
  });

  // SENT only: a PENDING estimate is already accepted and signed (D6) and no longer expires, so
  // anchoring an automation to its validity date would fire against a closed decision.
  it('estimate.valid_until: selects SENT estimates by expiration and keys the occurrence on it', async () => {
    const validUntil = new Date('2026-08-05T12:00:00.000Z');
    mockPrisma.estimate.findMany.mockResolvedValueOnce([
      { id: 'est-1', estimate_number: 'E00099', valid_until: validUntil },
    ]);

    const out = await candidatesForAnchor('estimate.valid_until', ORG, WINDOW);

    const q = mockPrisma.estimate.findMany.mock.calls[0][0];
    expect(q.where).toEqual({ organization_id: ORG, status: 'SENT', valid_until: WINDOW });
    expect(out).toEqual([
      { entityType: 'estimate', entityId: 'est-1', entityLabel: 'E00099', occurrence: validUntil.toISOString() },
    ]);
  });
});
