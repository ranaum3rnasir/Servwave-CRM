import { describe, it, expect } from 'vitest';
import { computeTaskRisk } from '../lib/tasks/risk';
import { taskVisibilityWhere } from '../lib/tasks/visibility';
import { diffTaskActivities } from '../lib/tasks/activity';

const NOW = new Date('2026-06-17T12:00:00Z');

describe('computeTaskRisk', () => {
  it('DONE tasks are always zero-risk', () => {
    expect(computeTaskRisk({ status: 'DONE', priority: 'URGENT', due_at: '2026-06-01T00:00:00Z', completed_at: NOW }, NOW))
      .toEqual({ score: 0, reason: null });
  });
  it('overdue + urgent + blocked stacks toward high risk', () => {
    const r = computeTaskRisk({ status: 'BLOCKED', priority: 'URGENT', due_at: '2026-06-14T12:00:00Z', completed_at: null }, NOW);
    expect(r.score).toBeGreaterThanOrEqual(90);
    expect(r.reason).toContain('overdue');
    expect(r.reason).toContain('blocked');
  });
  it('low priority, no due date → low score, null-ish reason', () => {
    expect(computeTaskRisk({ status: 'TODO', priority: 'LOW', due_at: null, completed_at: null }, NOW).score).toBe(0);
  });
});

const reqAs = (role: string, id: string) =>
  ({ user: { id, role, organization_id: 'org-1' } } as any);

describe('taskVisibilityWhere', () => {
  it('ADMIN hub → org-only, no OR scoping', () => {
    const w = taskVisibilityWhere(reqAs('ADMIN', 'u-admin'), {});
    expect(w.organization_id).toBe('org-1');
    expect(w.OR).toBeUndefined();
  });
  it('non-admin hub → owner OR creator OR watcher', () => {
    const w = taskVisibilityWhere(reqAs('TECHNICIAN', 'u-tech'), {});
    expect(w.OR).toEqual([
      { owner_id: 'u-tech' },
      { created_by: 'u-tech' },
      { watcher_ids: { has: 'u-tech' } },
    ]);
  });
  it('entity filter → entity-wide, no personal scoping even for non-admin', () => {
    const w = taskVisibilityWhere(reqAs('SALES', 'u-sales'), { linked_entity_type: 'JOB', linked_entity_id: 'job-1' });
    expect(w.linked_entity_type).toBe('JOB');
    expect(w.linked_entity_id).toBe('job-1');
    expect(w.OR).toBeUndefined();
  });
});

describe('diffTaskActivities', () => {
  it('status→DONE yields COMPLETED', () => {
    expect(diffTaskActivities({ status: 'TODO' }, { status: 'DONE' })[0].type).toBe('COMPLETED');
  });
  it('owner change yields ASSIGNED; due change yields DUE_CHANGED', () => {
    const evs = diffTaskActivities(
      { owner_id: null, due_at: null },
      { owner_id: 'u-2', due_at: '2026-07-01T00:00:00Z' },
    );
    expect(evs.map((e) => e.type).sort()).toEqual(['ASSIGNED', 'DUE_CHANGED']);
  });
  it('no changes → empty', () => {
    expect(diffTaskActivities({ status: 'TODO' }, {})).toEqual([]);
  });
});

import { userFullName, customerLabel } from '../lib/tasks/enrich';

describe('enrich formatters', () => {
  it('userFullName joins first + last', () => {
    expect(userFullName({ first_name: 'Oved', last_name: 'Adani' })).toBe('Oved Adani');
  });
  it('customerLabel prefers company_name, falls back to person, then number', () => {
    expect(customerLabel({ company_name: 'Acme', first_name: null, last_name: null, customer_number: 'C00001' })).toBe('Acme');
    expect(customerLabel({ company_name: null, first_name: 'Gail', last_name: 'Levi', customer_number: 'C00002' })).toBe('Gail Levi');
    expect(customerLabel({ company_name: null, first_name: null, last_name: null, customer_number: 'C00003' })).toBe('C00003');
  });
});
