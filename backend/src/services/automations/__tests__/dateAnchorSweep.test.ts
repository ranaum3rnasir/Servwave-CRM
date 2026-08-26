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
    mockPrisma.visit.findMany.mockResolvedValue([]);
    mockPrisma.invoice.findMany.mockResolvedValue([]);
    mockPrisma.estimate.findMany.mockResolvedValue([]);
  });

  // S8 §2 (A4, RATIFIED): repointed onto `visits` and made PER-VISIT — the same shape as the
  // LEAD arm just below. A single-visit job still yields exactly one candidate, so this proves
  // the query shape without yet proving the multi-visit fan-out (see the dedicated test below).
  it('job.scheduled_start: selects LIVE visits by scheduled_at and keys the occurrence on it (entity = the JOB)', async () => {
    const start = new Date('2026-07-19T09:00:00.000Z');
    mockPrisma.visit.findMany.mockResolvedValueOnce([
      { scheduled_at: start, job: { id: 'job-1', job_number: 'J00042' } },
    ]);

    const out = await candidatesForAnchor('job.scheduled_start', ORG, WINDOW);

    const q = mockPrisma.visit.findMany.mock.calls[0][0];
    expect(q.where).toEqual({
      organization_id: ORG,
      job_id: { not: null },
      status: { in: ['SCHEDULED', 'EN_ROUTE', 'ON_SITE', 'IN_PROGRESS'] },
      scheduled_at: WINDOW,
    });
    expect(out).toEqual([
      { entityType: 'job', entityId: 'job-1', entityLabel: 'J00042', occurrence: start.toISOString() },
    ]);
  });

  // Contract A4's headline behaviour change: a rule anchored on job.scheduled_start now fires
  // once PER VISIT rather than once per job (spec user story 43 — "fires on all three
  // mornings"). Three distinct visit times on the SAME job must yield three candidates sharing
  // one entityId but carrying three distinct occurrence strings.
  it('job.scheduled_start: a 3-visit job yields THREE candidates with distinct occurrence strings (1 fire becomes 3)', async () => {
    const v1 = new Date('2026-07-19T09:00:00.000Z');
    const v2 = new Date('2026-07-20T09:00:00.000Z');
    const v3 = new Date('2026-07-21T09:00:00.000Z');
    mockPrisma.visit.findMany.mockResolvedValueOnce([
      { scheduled_at: v1, job: { id: 'job-1', job_number: 'J00042' } },
      { scheduled_at: v2, job: { id: 'job-1', job_number: 'J00042' } },
      { scheduled_at: v3, job: { id: 'job-1', job_number: 'J00042' } },
    ]);

    const out = await candidatesForAnchor('job.scheduled_start', ORG, WINDOW);

    expect(out).toEqual([
      { entityType: 'job', entityId: 'job-1', entityLabel: 'J00042', occurrence: v1.toISOString() },
      { entityType: 'job', entityId: 'job-1', entityLabel: 'J00042', occurrence: v2.toISOString() },
      { entityType: 'job', entityId: 'job-1', entityLabel: 'J00042', occurrence: v3.toISOString() },
    ]);
    // Every candidate shares the parent job id but carries its OWN occurrence, so
    // buildDedupeKey (JOB_DATE_ANCHORED is occurrence-scoped) mints three distinct keys —
    // the mechanism that lets all three actually enroll instead of colliding.
    const occurrences = new Set(out.map((c) => c.occurrence));
    expect(occurrences.size).toBe(3);
  });

  // The where-clause's LIVE_VISIT_STATUSES filter is what makes this true against a real
  // Postgres — CANCELLED (and COMPLETED) are not in the set, so such rows never reach the
  // window comparison in the first place.
  it('job.scheduled_start: the status filter excludes CANCELLED — a cancelled visit is never a candidate', async () => {
    await candidatesForAnchor('job.scheduled_start', ORG, WINDOW);
    const q = mockPrisma.visit.findMany.mock.calls[0][0];
    expect(q.where.status.in).not.toContain('CANCELLED');
    expect(q.where.status.in).not.toContain('COMPLETED');
  });

  it('job.scheduled_start: a job with every visit cancelled yields no candidates', async () => {
    // A real DB query with the LIVE_VISIT_STATUSES filter above would simply return nothing for
    // an all-cancelled job — modelled here as the mocked resolver finding no rows.
    mockPrisma.visit.findMany.mockResolvedValueOnce([]);
    const out = await candidatesForAnchor('job.scheduled_start', ORG, WINDOW);
    expect(out).toEqual([]);
  });

  // Walkthrough-as-entity redesign, PR-B2: repointed onto the Walkthrough table directly
  // (scanning visit rows, not a single flat column per lead), still with no status filter —
  // terminalStale's LEAD_DATE_ANCHORED case re-checks the visit's own status at execution time.
  it('lead.walkthrough_scheduled_at: selects walkthrough rows by scheduled_at with no status filter and keys the occurrence on it (entity = the LEAD)', async () => {
    const walkthrough = new Date('2026-07-19T09:00:00.000Z');
    mockPrisma.visit.findMany.mockResolvedValueOnce([
      { scheduled_at: walkthrough, lead: { id: 'lead-1', lead_number: 'L00007' } },
    ]);

    const out = await candidatesForAnchor('lead.walkthrough_scheduled_at', ORG, WINDOW);

    const q = mockPrisma.visit.findMany.mock.calls[0][0];
    expect(q.where).toEqual({ organization_id: ORG, lead_id: { not: null }, scheduled_at: WINDOW });
    expect(out).toEqual([
      { entityType: 'lead', entityId: 'lead-1', entityLabel: 'L00007', occurrence: walkthrough.toISOString() },
    ]);
  });

  // Multi-visit S2 puts a JOB's trips in the same `visits` table (D5: exactly one parent, so a job
  // visit carries no lead), and the migration backfills one per already-scheduled job. A sweep that
  // reads every visit in the window therefore meets a lead-less row roughly whenever a job is
  // booked 24h out - and the throw is swallowed by cron.ts's per-workflow catch, so the org's
  // walkthrough reminders silently stop enrolling instead of reporting an error.
  it('lead.walkthrough_scheduled_at: ignores a JOB visit sharing the window instead of throwing on its missing lead', async () => {
    const walkthrough = new Date('2026-07-19T09:00:00.000Z');
    mockPrisma.visit.findMany.mockResolvedValueOnce([
      { scheduled_at: new Date('2026-07-19T08:00:00.000Z'), lead: null },
      { scheduled_at: walkthrough, lead: { id: 'lead-1', lead_number: 'L00007' } },
    ]);

    const out = await candidatesForAnchor('lead.walkthrough_scheduled_at', ORG, WINDOW);

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
