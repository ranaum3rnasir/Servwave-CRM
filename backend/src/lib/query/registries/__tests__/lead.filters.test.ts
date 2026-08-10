import { describe, it, expect } from 'vitest';
import { applyFilters } from '../../filterEngine';
import { leadFacets } from '../lead.filters';

function reqWith(query: Record<string, unknown>) {
  return { query } as any;
}

describe('leadFacets: status (enum-validated)', () => {
  it('single valid status uses equals', async () => {
    const where: any = {};
    await applyFilters(where, reqWith({ status: 'NEW' }), leadFacets({}));
    expect(where.status).toBe('NEW');
  });

  it('multiple valid statuses use in', async () => {
    const where: any = {};
    await applyFilters(where, reqWith({ status: ['NEW', 'CONTACTED'] }), leadFacets({}));
    expect(where.status).toEqual({ in: ['NEW', 'CONTACTED'] });
  });

  it('drops an invalid status value instead of passing it through to Prisma', async () => {
    const where: any = {};
    await applyFilters(where, reqWith({ status: 'NOT_A_REAL_STATUS' }), leadFacets({}));
    expect(where.status).toBeUndefined();
  });

  it('keeps only the valid values when mixed with an invalid one', async () => {
    const where: any = {};
    await applyFilters(where, reqWith({ status: ['NEW', 'NOT_A_REAL_STATUS'] }), leadFacets({}));
    expect(where.status).toBe('NEW');
  });
});

describe('leadFacets: job_type', () => {
  it('is a plain equalsOrIn column facet', async () => {
    const where: any = {};
    await applyFilters(where, reqWith({ job_type: ['Plumbing', 'HVAC'] }), leadFacets({}));
    expect(where.job_type).toEqual({ in: ['Plumbing', 'HVAC'] });
  });
});

describe('leadFacets: customer_id', () => {
  it('single value is scalar (not wrapped in `in`)', async () => {
    const where: any = {};
    await applyFilters(where, reqWith({ customer_id: 'cust-1' }), leadFacets({}));
    expect(where.customer_id).toBe('cust-1');
  });

  it('multiple values use in', async () => {
    const where: any = {};
    await applyFilters(where, reqWith({ customer_id: ['cust-1', 'cust-2'] }), leadFacets({}));
    expect(where.customer_id).toEqual({ in: ['cust-1', 'cust-2'] });
  });
});

describe('leadFacets: ad_source (Customer relation)', () => {
  it('writes through where.customer.ad_source, not a direct column', async () => {
    const where: any = {};
    await applyFilters(where, reqWith({ ad_source: 'Google' }), leadFacets({}));
    expect(where.customer).toEqual({ ad_source: 'Google' });
  });

  it('multiple values use in', async () => {
    const where: any = {};
    await applyFilters(where, reqWith({ ad_source: ['Google', 'Referral'] }), leadFacets({}));
    expect(where.customer).toEqual({ ad_source: { in: ['Google', 'Referral'] } });
  });

  it('merges into an existing where.customer instead of clobbering it', async () => {
    const where: any = { customer: { kind: 'PERSON' } };
    await applyFilters(where, reqWith({ ad_source: 'Google' }), leadFacets({}));
    expect(where.customer).toEqual({ kind: 'PERSON', ad_source: 'Google' });
  });
});

// Walkthrough-as-entity redesign, PR-B2: the bucket collapses to Walkthrough.status =
// REQUESTED — no lead status default/involved at all.
describe('leadFacets: walkthrough_status (synthetic/derived)', () => {
  it("'needs_scheduling' expands to a walkthroughs relation filter on REQUESTED", async () => {
    const where: any = {};
    await applyFilters(where, reqWith({ walkthrough_status: 'needs_scheduling' }), leadFacets({}));
    expect(where.walkthroughs).toEqual({ some: { status: 'REQUESTED' } });
    expect(where.status).toBeUndefined();
  });

  it('coexists with an explicit status filter (no longer defaults or overrides it)', async () => {
    const where: any = {};
    await applyFilters(
      where,
      reqWith({ status: 'CONTACTED', walkthrough_status: 'needs_scheduling' }),
      leadFacets({}),
    );
    expect(where.status).toBe('CONTACTED');
    expect(where.walkthroughs).toEqual({ some: { status: 'REQUESTED' } });
  });

  it('any value other than needs_scheduling is a no-op (only value in the system today)', async () => {
    const where: any = {};
    await applyFilters(where, reqWith({ walkthrough_status: 'bogus' }), leadFacets({}));
    expect(where.walkthroughs).toBeUndefined();
    expect(where.status).toBeUndefined();
  });

  it('SECURITY: merges into an existing scopeWhere.walkthroughs (TECHNICIAN OWN_WALKTHROUGH) instead of clobbering it', async () => {
    const scopeWhere = { walkthroughs: { some: { performers: { some: { user_id: 'the-tech' } } } } };
    const where: any = { ...scopeWhere };
    await applyFilters(where, reqWith({ walkthrough_status: 'needs_scheduling' }), leadFacets(scopeWhere));
    expect(where.walkthroughs).toEqual({
      some: { performers: { some: { user_id: 'the-tech' } }, status: 'REQUESTED' },
    });
  });
});

describe('leadFacets: assigned_to (SECURITY: scope-guard)', () => {
  it('applies normally when scopeWhere does not already constrain lead_assignees', async () => {
    const where: any = {};
    await applyFilters(where, reqWith({ assigned_to: ['u1', 'u2'] }), leadFacets({}));
    expect(where.lead_assignees).toEqual({ some: { user_id: { in: ['u1', 'u2'] } } });
  });

  it('UNASSIGNED sentinel sets none:{}', async () => {
    const where: any = {};
    await applyFilters(where, reqWith({ assigned_to: 'UNASSIGNED' }), leadFacets({}));
    expect(where.lead_assignees).toEqual({ none: {} });
  });

  it('is a NO-OP when scopeWhere already set lead_assignees (row-scoped role) — the RBAC-critical case', async () => {
    const scopeWhere = { lead_assignees: { some: { user_id: 'the-sales-rep' } } };
    const where: any = { ...scopeWhere };
    await applyFilters(where, reqWith({ assigned_to: 'someone-else' }), leadFacets(scopeWhere));
    // Must still be the scope's own restriction — NOT widened/replaced by the query param.
    expect(where.lead_assignees).toEqual({ some: { user_id: 'the-sales-rep' } });
  });

  it('is a NO-OP even for the UNASSIGNED sentinel when scope already constrains lead_assignees', async () => {
    const scopeWhere = { lead_assignees: { some: { user_id: 'the-sales-rep' } } };
    const where: any = { ...scopeWhere };
    await applyFilters(where, reqWith({ assigned_to: 'UNASSIGNED' }), leadFacets(scopeWhere));
    expect(where.lead_assignees).toEqual({ some: { user_id: 'the-sales-rep' } });
  });
});

describe('leadFacets: created dateRange', () => {
  it('created_after/before -> gte/lte Date on created_at', async () => {
    const where: any = {};
    await applyFilters(where, reqWith({ created_after: '2026-01-01', created_before: '2026-02-01' }), leadFacets({}));
    expect(where.created_at.gte).toBeInstanceOf(Date);
    expect(where.created_at.lte).toBeInstanceOf(Date);
  });
});
