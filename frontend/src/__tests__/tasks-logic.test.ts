import { describe, it, expect } from 'vitest';
import {
  isOverdue, ageInStageMs, assessRisk, rankMyDay, computeStats,
} from '@/lib/tasks/tasks-logic';
import type { Task } from '@/lib/tasks/types';

const NOW = new Date('2026-06-07T12:00:00.000Z');

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: 't1', task_number: 'T00001', title: 'x', description: '',
    status: 'TODO', priority: 'MEDIUM', owner_id: 'u1', watcher_ids: [],
    due_at: null, linked_entity: null, tags: [], subtasks: [],
    created_by: 'u1', created_at: '2026-06-01T00:00:00.000Z',
    updated_at: '2026-06-05T12:00:00.000Z', completed_at: null,
    activity: [], comments: [],
    ai: { risk_score: 0, risk_reason: null, suggested_by: null, source: 'manual' },
    ...overrides,
  };
}

describe('isOverdue', () => {
  it('is true when due in the past and not done', () => {
    expect(isOverdue(makeTask({ due_at: '2026-06-06T00:00:00.000Z' }), NOW)).toBe(true);
  });
  it('is false when due in the future', () => {
    expect(isOverdue(makeTask({ due_at: '2026-06-08T00:00:00.000Z' }), NOW)).toBe(false);
  });
  it('is false when done even if past due', () => {
    expect(isOverdue(makeTask({ due_at: '2026-06-06T00:00:00.000Z', status: 'DONE' }), NOW)).toBe(false);
  });
  it('is false when no due date', () => {
    expect(isOverdue(makeTask({ due_at: null }), NOW)).toBe(false);
  });
});

describe('ageInStageMs', () => {
  it('is now minus updated_at', () => {
    const t = makeTask({ updated_at: '2026-06-05T12:00:00.000Z' });
    expect(ageInStageMs(t, NOW)).toBe(2 * 24 * 60 * 60 * 1000);
  });
});

describe('assessRisk', () => {
  it('done tasks are never at risk', () => {
    const r = assessRisk(makeTask({ status: 'DONE', due_at: '2026-06-01T00:00:00.000Z' }), { now: NOW, ownerOpenCount: 9 });
    expect(r.atRisk).toBe(false);
    expect(r.score).toBe(0);
  });
  it('overdue + high load is high risk with a reason', () => {
    const r = assessRisk(makeTask({ due_at: '2026-06-05T00:00:00.000Z', status: 'IN_PROGRESS' }), { now: NOW, ownerOpenCount: 9 });
    expect(r.atRisk).toBe(true);
    expect(r.score).toBeGreaterThanOrEqual(50);
    expect(r.reason).toMatch(/overdue/i);
  });
  it('due far out, low load, fresh stage is low risk', () => {
    const r = assessRisk(makeTask({ due_at: '2026-06-30T00:00:00.000Z', updated_at: NOW.toISOString() }), { now: NOW, ownerOpenCount: 1 });
    expect(r.atRisk).toBe(false);
    expect(r.score).toBeLessThan(50);
  });
  it('blocked tasks carry extra risk', () => {
    const open = assessRisk(makeTask({ status: 'IN_PROGRESS', due_at: '2026-06-09T00:00:00.000Z' }), { now: NOW, ownerOpenCount: 3 });
    const blocked = assessRisk(makeTask({ status: 'BLOCKED', due_at: '2026-06-09T00:00:00.000Z' }), { now: NOW, ownerOpenCount: 3 });
    expect(blocked.score).toBeGreaterThan(open.score);
  });
});

describe('rankMyDay', () => {
  it('returns only the user open tasks, overdue first then due-today then priority', () => {
    const overdue = makeTask({ id: 'overdue', owner_id: 'u1', due_at: '2026-06-05T00:00:00.000Z' });
    const dueToday = makeTask({ id: 'today', owner_id: 'u1', due_at: '2026-06-07T20:00:00.000Z' });
    const urgentFuture = makeTask({ id: 'urgent', owner_id: 'u1', due_at: '2026-06-20T00:00:00.000Z', priority: 'URGENT' });
    const lowFuture = makeTask({ id: 'low', owner_id: 'u1', due_at: '2026-06-20T00:00:00.000Z', priority: 'LOW' });
    const other = makeTask({ id: 'other', owner_id: 'u2' });
    const done = makeTask({ id: 'done', owner_id: 'u1', status: 'DONE' });

    const ranked = rankMyDay([lowFuture, urgentFuture, dueToday, overdue, other, done], 'u1', NOW);
    expect(ranked.map((t) => t.id)).toEqual(['overdue', 'today', 'urgent', 'low']);
  });
});

describe('computeStats', () => {
  it('counts open, blocked, and per-assignee', () => {
    const tasks: Task[] = [
      makeTask({ id: 'a', owner_id: 'u1', status: 'TODO' }),
      makeTask({ id: 'b', owner_id: 'u1', status: 'BLOCKED' }),
      makeTask({ id: 'c', owner_id: 'u2', status: 'IN_PROGRESS' }),
      makeTask({ id: 'd', owner_id: 'u2', status: 'DONE', completed_at: '2026-06-06T00:00:00.000Z', due_at: '2026-06-07T00:00:00.000Z' }),
    ];
    const s = computeStats(tasks, NOW);
    expect(s.open).toBe(3);
    expect(s.blocked).toBe(1);
    const u1 = s.byAssignee.find((r) => r.userId === 'u1');
    expect(u1?.open).toBe(2);
  });

  it('on-time % = done-before-due / done, rounded', () => {
    const tasks: Task[] = [
      makeTask({ id: 'ontime', status: 'DONE', completed_at: '2026-06-05T00:00:00.000Z', due_at: '2026-06-06T00:00:00.000Z' }),
      makeTask({ id: 'late', status: 'DONE', completed_at: '2026-06-08T00:00:00.000Z', due_at: '2026-06-06T00:00:00.000Z' }),
    ];
    expect(computeStats(tasks, NOW).onTimePct).toBe(50);
  });
});
