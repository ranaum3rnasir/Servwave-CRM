import { describe, it, expect } from 'vitest';
import { applyTaskFilter, computeHistory } from '@/lib/tasks/tasks-logic';
import type { TaskFilter } from '@/lib/tasks/tasks-logic';
import { MOCK_PEOPLE, MOCK_NOW } from '@/lib/tasks/tasks-mock';
import type { Task, TaskPerson } from '@/lib/tasks/types';

const NOW = MOCK_NOW; // 2026-06-07T12:00:00.000Z

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

const PEOPLE: TaskPerson[] = [
  { id: 'u_alice', name: 'Alice', role: 'admin', department: 'mgmt' },
  { id: 'u_bob',   name: 'Bob',   role: 'tech',  department: 'field' },
  { id: 'u_carol', name: 'Carol', role: 'sales',  department: 'sales' },
];

// --- applyTaskFilter ---

describe('applyTaskFilter', () => {
  const tasks = [
    makeTask({ id: 'a', owner_id: 'u_alice', tags: ['urgent'] }),
    makeTask({ id: 'b', owner_id: 'u_bob',   tags: ['parts'] }),
    makeTask({ id: 'c', owner_id: 'u_carol', tags: ['urgent', 'parts'] }),
  ];

  it("'all' on every dimension returns all tasks", () => {
    const filter: TaskFilter = { memberId: 'all', departmentId: 'all', tag: 'all' };
    expect(applyTaskFilter(tasks, filter, PEOPLE)).toHaveLength(3);
  });

  it('member filter keeps only that owner', () => {
    const filter: TaskFilter = { memberId: 'u_alice', departmentId: 'all', tag: 'all' };
    const result = applyTaskFilter(tasks, filter, PEOPLE);
    expect(result).toHaveLength(1);
    expect(result[0]?.id).toBe('a');
  });

  it('department filter keeps only tasks whose owner belongs to the department', () => {
    const filter: TaskFilter = { memberId: 'all', departmentId: 'field', tag: 'all' };
    const result = applyTaskFilter(tasks, filter, PEOPLE);
    expect(result).toHaveLength(1);
    expect(result[0]?.id).toBe('b');
  });

  it('tag filter keeps only tasks that include the tag', () => {
    const filter: TaskFilter = { memberId: 'all', departmentId: 'all', tag: 'urgent' };
    const result = applyTaskFilter(tasks, filter, PEOPLE);
    expect(result.map((t) => t.id).sort()).toEqual(['a', 'c']);
  });

  it('combined filters are ANDed together', () => {
    // carol is in 'sales', has tags ['urgent', 'parts']
    const filter: TaskFilter = { memberId: 'all', departmentId: 'sales', tag: 'parts' };
    const result = applyTaskFilter(tasks, filter, PEOPLE);
    expect(result).toHaveLength(1);
    expect(result[0]?.id).toBe('c');
  });

  it('returns empty array when no task matches combined filter', () => {
    const filter: TaskFilter = { memberId: 'u_alice', departmentId: 'sales', tag: 'all' };
    // alice is in mgmt, not sales
    expect(applyTaskFilter(tasks, filter, PEOPLE)).toHaveLength(0);
  });
});

// --- applyTaskFilter — category dimension (#517 KPI drill-down) ---

describe('applyTaskFilter — category dimension', () => {
  const DAY = 24 * 60 * 60 * 1000;
  const ALL = { memberId: 'all', departmentId: 'all', tag: 'all' } as const;

  const openTodo = makeTask({ id: 'open1', status: 'TODO' });
  const inProgress = makeTask({ id: 'ip1', status: 'IN_PROGRESS' });
  const blocked = makeTask({ id: 'blk1', status: 'BLOCKED' });
  const doneOnTime = makeTask({
    id: 'done-ot', status: 'DONE',
    due_at: '2026-06-06T00:00:00.000Z',
    completed_at: '2026-06-05T00:00:00.000Z', // completed before due → on-time
  });
  const doneLate = makeTask({
    id: 'done-late', status: 'DONE',
    due_at: '2026-06-04T00:00:00.000Z',
    completed_at: '2026-06-06T00:00:00.000Z', // completed after due → late
  });
  // Overdue (+45) and 4 days in stage (+10) → score 55 ≥ 50 → atRisk.
  const overdueAtRisk = makeTask({
    id: 'risk1', status: 'TODO',
    due_at: new Date(NOW.getTime() - 2 * DAY).toISOString(),
    updated_at: new Date(NOW.getTime() - 4 * DAY).toISOString(),
  });

  const tasks = [openTodo, inProgress, blocked, doneOnTime, doneLate, overdueAtRisk];

  it("'open' excludes DONE tasks", () => {
    const result = applyTaskFilter(tasks, { ...ALL, category: 'open' }, PEOPLE, NOW);
    expect(result.every((t) => t.status !== 'DONE')).toBe(true);
    expect(result.map((t) => t.id).sort()).toEqual(['blk1', 'ip1', 'open1', 'risk1']);
  });

  it("'blocked' keeps only BLOCKED tasks", () => {
    const result = applyTaskFilter(tasks, { ...ALL, category: 'blocked' }, PEOPLE, NOW);
    expect(result.map((t) => t.id)).toEqual(['blk1']);
  });

  it("'onTime' keeps only DONE tasks completed on or before due", () => {
    const result = applyTaskFilter(tasks, { ...ALL, category: 'onTime' }, PEOPLE, NOW);
    expect(result.map((t) => t.id)).toEqual(['done-ot']);
  });

  it("'atRisk' keeps exactly the assessRisk-flagged tasks", () => {
    const result = applyTaskFilter(tasks, { ...ALL, category: 'atRisk' }, PEOPLE, NOW);
    expect(result.map((t) => t.id)).toEqual(['risk1']);
  });

  it("omitted / 'all' category returns the member/dept/tag base unchanged", () => {
    const withAll = applyTaskFilter(tasks, { ...ALL, category: 'all' }, PEOPLE, NOW);
    const omitted = applyTaskFilter(tasks, { ...ALL }, PEOPLE, NOW);
    expect(withAll).toHaveLength(tasks.length);
    expect(omitted).toHaveLength(tasks.length);
  });
});

// --- computeHistory ---

describe('computeHistory — snapshot', () => {
  it('counts each status correctly', () => {
    const tasks = [
      makeTask({ id: '1', status: 'TODO' }),
      makeTask({ id: '2', status: 'TODO' }),
      makeTask({ id: '3', status: 'IN_PROGRESS' }),
      makeTask({ id: '4', status: 'BLOCKED' }),
      makeTask({ id: '5', status: 'DONE', completed_at: '2026-06-01T00:00:00.000Z' }),
    ];
    const { snapshot } = computeHistory(tasks, NOW);
    expect(snapshot.todo).toBe(2);
    expect(snapshot.inProgress).toBe(1);
    expect(snapshot.blocked).toBe(1);
    expect(snapshot.done).toBe(1);
  });
});

describe('computeHistory — flow buckets', () => {
  const WEEK = 7 * 24 * 60 * 60 * 1000;

  it('places a task created this week into flow[7].created', () => {
    const created_at = new Date(NOW.getTime() - 2 * 24 * 60 * 60 * 1000).toISOString(); // 2 days ago
    const tasks = [makeTask({ id: '1', created_at })];
    const { flow } = computeHistory(tasks, NOW);
    expect(flow[7]?.created).toBe(1);
  });

  it('places a DONE task completed 1 week ago into flow[6].closed', () => {
    const completed_at = new Date(NOW.getTime() - WEEK - 60 * 60 * 1000).toISOString(); // 1 week + 1h ago
    const tasks = [makeTask({ id: '1', status: 'DONE', completed_at })];
    const { flow } = computeHistory(tasks, NOW);
    expect(flow[6]?.closed).toBe(1);
  });

  it('tasks created >8 weeks ago are excluded from flow', () => {
    const created_at = new Date(NOW.getTime() - 9 * WEEK).toISOString();
    const tasks = [makeTask({ id: '1', created_at })];
    const { flow } = computeHistory(tasks, NOW);
    const totalCreated = flow.reduce((s, p) => s + p.created, 0);
    expect(totalCreated).toBe(0);
  });

  it('flow has exactly 8 points with sequential weekIndex 0..7', () => {
    const { flow } = computeHistory([], NOW);
    expect(flow).toHaveLength(8);
    flow.forEach((p, i) => expect(p.weekIndex).toBe(i));
  });
});

describe('computeHistory — upcoming buckets', () => {
  const DAY = 24 * 60 * 60 * 1000;
  const WEEK = 7 * DAY;

  it('task due in 3 days lands in thisWeek', () => {
    const due_at = new Date(NOW.getTime() + 3 * DAY).toISOString();
    const tasks = [makeTask({ id: '1', due_at, status: 'TODO' })];
    const { upcoming } = computeHistory(tasks, NOW);
    expect(upcoming.thisWeek).toHaveLength(1);
    expect(upcoming.nextWeek).toHaveLength(0);
    expect(upcoming.later).toHaveLength(0);
  });

  it('task due in 10 days lands in nextWeek', () => {
    const due_at = new Date(NOW.getTime() + 10 * DAY).toISOString();
    const tasks = [makeTask({ id: '1', due_at, status: 'IN_PROGRESS' })];
    const { upcoming } = computeHistory(tasks, NOW);
    expect(upcoming.thisWeek).toHaveLength(0);
    expect(upcoming.nextWeek).toHaveLength(1);
  });

  it('task due in 20 days lands in later', () => {
    const due_at = new Date(NOW.getTime() + 20 * DAY).toISOString();
    const tasks = [makeTask({ id: '1', due_at, status: 'BLOCKED' })];
    const { upcoming } = computeHistory(tasks, NOW);
    expect(upcoming.later).toHaveLength(1);
  });

  it('DONE tasks are excluded from upcoming', () => {
    const due_at = new Date(NOW.getTime() + 3 * DAY).toISOString();
    const tasks = [makeTask({ id: '1', due_at, status: 'DONE', completed_at: NOW.toISOString() })];
    const { upcoming } = computeHistory(tasks, NOW);
    expect(upcoming.thisWeek).toHaveLength(0);
  });

  it('overdue tasks (due in the past) are excluded from upcoming', () => {
    const due_at = new Date(NOW.getTime() - DAY).toISOString();
    const tasks = [makeTask({ id: '1', due_at, status: 'TODO' })];
    const { upcoming } = computeHistory(tasks, NOW);
    expect(upcoming.thisWeek).toHaveLength(0);
    expect(upcoming.nextWeek).toHaveLength(0);
    expect(upcoming.later).toHaveLength(0);
  });

  it('tasks with no due_at are excluded from upcoming', () => {
    const tasks = [makeTask({ id: '1', due_at: null, status: 'IN_PROGRESS' })];
    const { upcoming } = computeHistory(tasks, NOW);
    expect(upcoming.thisWeek).toHaveLength(0);
    expect(upcoming.nextWeek).toHaveLength(0);
    expect(upcoming.later).toHaveLength(0);
  });

  it('all three buckets fill correctly in one batch', () => {
    const tasks = [
      makeTask({ id: 'tw', due_at: new Date(NOW.getTime() + 2 * DAY).toISOString(), status: 'TODO' }),
      makeTask({ id: 'nw', due_at: new Date(NOW.getTime() + WEEK + DAY).toISOString(), status: 'TODO' }),
      makeTask({ id: 'lt', due_at: new Date(NOW.getTime() + 3 * WEEK).toISOString(), status: 'TODO' }),
    ];
    const { upcoming } = computeHistory(tasks, NOW);
    expect(upcoming.thisWeek.map((t) => t.id)).toEqual(['tw']);
    expect(upcoming.nextWeek.map((t) => t.id)).toEqual(['nw']);
    expect(upcoming.later.map((t) => t.id)).toEqual(['lt']);
  });
});

// Integration: uses MOCK_PEOPLE (which will have department after impl)
describe('applyTaskFilter with MOCK_PEOPLE', () => {
  it('department mgmt filter returns only mgmt-owned tasks', () => {
    const tasks = [
      makeTask({ id: 'e', owner_id: 'u_emanuel' }),
      makeTask({ id: 'o', owner_id: 'u_oved' }),
    ];
    const filter: TaskFilter = { memberId: 'all', departmentId: 'mgmt', tag: 'all' };
    const result = applyTaskFilter(tasks, filter, MOCK_PEOPLE);
    expect(result.every((t) => t.owner_id === 'u_emanuel')).toBe(true);
  });
});

// --- applyTaskFilter: overdue / at-risk / date-range (#625) ---

describe('applyTaskFilter — overdue', () => {
  it('keeps a past-due non-DONE task, drops a future-due task, drops a DONE-but-past-due task', () => {
    const tasks = [
      makeTask({ id: 'past', status: 'TODO', due_at: '2026-06-01T00:00:00.000Z' }),
      makeTask({ id: 'future', status: 'TODO', due_at: '2026-07-01T00:00:00.000Z' }),
      makeTask({ id: 'done-past', status: 'DONE', due_at: '2026-06-01T00:00:00.000Z' }),
    ];
    const filter: TaskFilter = { memberId: 'all', departmentId: 'all', tag: 'all', overdue: true };
    const result = applyTaskFilter(tasks, filter, PEOPLE, NOW);
    expect(result.map((t) => t.id)).toEqual(['past']);
  });
});

describe('applyTaskFilter — at risk', () => {
  it('keeps an overdue+BLOCKED task (score >= 50), drops a fresh TODO due far in the future', () => {
    const tasks = [
      makeTask({
        id: 'risky', status: 'BLOCKED', owner_id: 'u_alice',
        due_at: '2026-06-01T00:00:00.000Z',
        updated_at: '2026-06-05T12:00:00.000Z',
      }),
      makeTask({
        id: 'fresh', status: 'TODO', owner_id: 'u_bob',
        due_at: '2026-08-01T00:00:00.000Z',
        updated_at: '2026-06-07T10:00:00.000Z',
      }),
    ];
    const filter: TaskFilter = { memberId: 'all', departmentId: 'all', tag: 'all', atRisk: true };
    const result = applyTaskFilter(tasks, filter, PEOPLE, NOW);
    expect(result.map((t) => t.id)).toEqual(['risky']);
  });
});

describe('applyTaskFilter — due date range', () => {
  it('keeps a due_at inside the window (inclusive), drops one outside, drops a null due_at task', () => {
    const tasks = [
      makeTask({ id: 'inside', due_at: '2026-06-15T00:00:00.000Z' }),
      makeTask({ id: 'outside', due_at: '2026-07-01T00:00:00.000Z' }),
      makeTask({ id: 'no-due', due_at: null }),
    ];
    const filter: TaskFilter = {
      memberId: 'all', departmentId: 'all', tag: 'all',
      dueFrom: '2026-06-10', dueTo: '2026-06-20',
    };
    const result = applyTaskFilter(tasks, filter, PEOPLE, NOW);
    expect(result.map((t) => t.id)).toEqual(['inside']);
  });
});

describe('applyTaskFilter — created date range', () => {
  it('keeps a created_at inside the window (inclusive), drops one outside', () => {
    const tasks = [
      makeTask({ id: 'inside', created_at: '2026-06-15T00:00:00.000Z' }),
      makeTask({ id: 'outside', created_at: '2026-07-01T00:00:00.000Z' }),
    ];
    const filter: TaskFilter = {
      memberId: 'all', departmentId: 'all', tag: 'all',
      createdFrom: '2026-06-10', createdTo: '2026-06-20',
    };
    const result = applyTaskFilter(tasks, filter, PEOPLE, NOW);
    expect(result.map((t) => t.id)).toEqual(['inside']);
  });
});

describe('applyTaskFilter — combined AND semantics', () => {
  it('ANDs a new dimension (overdue) with a legacy dimension (memberId)', () => {
    const tasks = [
      makeTask({ id: 'alice-overdue', owner_id: 'u_alice', due_at: '2026-06-01T00:00:00.000Z' }),
      makeTask({ id: 'bob-overdue', owner_id: 'u_bob', due_at: '2026-06-01T00:00:00.000Z' }),
    ];
    const filter: TaskFilter = {
      memberId: 'u_alice', departmentId: 'all', tag: 'all', overdue: true,
    };
    const result = applyTaskFilter(tasks, filter, PEOPLE, NOW);
    expect(result.map((t) => t.id)).toEqual(['alice-overdue']);
  });
});
