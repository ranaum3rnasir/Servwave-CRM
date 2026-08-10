import { describe, it, expect } from 'vitest';
import { applyFilters, equalsOrIn, relationSome } from '../filterEngine';

function reqWith(query: Record<string, unknown>) {
  return { query } as any;
}

const statusFacet = { key: 'status', kind: 'multi' as const, param: 'status', apply: equalsOrIn('status') };
const createdFacet = { key: 'created', kind: 'dateRange' as const, afterParam: 'created_after', beforeParam: 'created_before', column: 'created_at' };
const assigneeFacet = { key: 'assigned_to', kind: 'multi' as const, param: 'assigned_to', apply: relationSome('lead_assignees', 'user_id') };

describe('filterEngine: multi', () => {
  it('single value uses equals', async () => {
    const where: any = {};
    await applyFilters(where, reqWith({ status: 'NEW' }), [statusFacet]);
    expect(where.status).toBe('NEW');
  });
  it('many values use in', async () => {
    const where: any = {};
    await applyFilters(where, reqWith({ status: ['NEW', 'WON'] }), [statusFacet]);
    expect(where.status).toEqual({ in: ['NEW', 'WON'] });
  });
  it('relation helper nests under the relation key and AND-appends', async () => {
    const where: any = {};
    await applyFilters(where, reqWith({ assigned_to: ['u1', 'u2'] }), [assigneeFacet]);
    expect(where.lead_assignees).toEqual({ some: { user_id: { in: ['u1', 'u2'] } } });
  });
  it('missing param leaves where untouched', async () => {
    const where: any = {};
    await applyFilters(where, reqWith({}), [statusFacet]);
    expect(where.status).toBeUndefined();
  });

  it('two multi facets sharing one relation both land under the same .some without clobbering each other', async () => {
    // This is the exact scenario Task 10 (Jobs) depends on: "Assigned To" and
    // "Department" both write into where.assignees.some via relationSome, on
    // different fields. Neither facet may overwrite the other's contribution.
    const assignedToFacet = {
      key: 'assigned_to',
      kind: 'multi' as const,
      param: 'assigned_to',
      apply: relationSome('assignees', 'user_id'),
    };
    const departmentFacet = {
      key: 'department',
      kind: 'multi' as const,
      param: 'department',
      apply: relationSome('assignees', 'department'),
    };
    const where: any = {};
    await applyFilters(
      where,
      reqWith({ assigned_to: ['u1', 'u2'], department: 'HVAC' }),
      [assignedToFacet, departmentFacet],
    );
    expect(where.assignees).toEqual({
      some: { user_id: { in: ['u1', 'u2'] }, department: 'HVAC' },
    });
  });
});

describe('filterEngine: dateRange', () => {
  it('created_after/before -> gte/lte Date', async () => {
    const where: any = {};
    await applyFilters(where, reqWith({ created_after: '2026-01-01' }), [createdFacet]);
    expect((where.created_at as any).gte).toBeInstanceOf(Date);
  });
  it('only sets the bound that is present', async () => {
    const where: any = {};
    await applyFilters(where, reqWith({ created_before: '2026-02-01' }), [createdFacet]);
    expect(where.created_at).toEqual({ lte: new Date('2026-02-01') });
  });
});

describe('filterEngine: range', () => {
  // Self-defined facet for this pure-engine test — deliberately using param
  // names distinct from any real entity's wire contract, since this suite
  // tests the mechanism (min/max -> gte/lte on the mapped column), not any
  // specific entity's param naming.
  const totalFacet = {
    key: 'total',
    kind: 'range' as const,
    minParam: 'min_total',
    maxParam: 'max_total',
    column: 'total_amount',
  };

  it('min+max -> gte/lte on the mapped column', async () => {
    const where: any = {};
    await applyFilters(where, reqWith({ min_total: '100', max_total: '500' }), [totalFacet]);
    expect(where.total_amount).toEqual({ gte: 100, lte: 500 });
  });

  it('blank max is open-ended (gte only)', async () => {
    const where: any = {};
    await applyFilters(where, reqWith({ min_total: '100' }), [totalFacet]);
    expect(where.total_amount).toEqual({ gte: 100 });
  });

  it('blank min is open-ended (lte only)', async () => {
    const where: any = {};
    await applyFilters(where, reqWith({ max_total: '500' }), [totalFacet]);
    expect(where.total_amount).toEqual({ lte: 500 });
  });

  it('neither bound present is a no-op', async () => {
    const where: any = {};
    await applyFilters(where, reqWith({}), [totalFacet]);
    expect(where.total_amount).toBeUndefined();
  });
});
