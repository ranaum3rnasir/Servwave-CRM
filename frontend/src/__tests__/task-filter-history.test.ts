import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  applyTaskFilter,
  computeHistory,
  formatCompletionDayLabel,
  formatCompletionTime,
  formatTimeToClose,
  groupCompletionsByLocalDay,
  localDayKey,
  selectCompletionLog,
} from '@/lib/tasks/tasks-logic';
import type { TaskFilter } from '@/lib/tasks/tasks-logic';
import { MOCK_PEOPLE, MOCK_NOW } from '@/lib/tasks/tasks-mock';
import { isTerminalTaskStatus } from '@/lib/tasks/types';
import type { Task, TaskPerson } from '@/lib/tasks/types';

const NOW = MOCK_NOW; // 2026-06-07T12:00:00.000Z

function makeTask(overrides: Partial<Task> = {}): Task {
  const task: Task = {
    id: 't1', task_number: 'T00001', title: 'x', description: '',
    status: 'TODO', priority: 'MEDIUM',
    assignee_ids: ['u1'], assignees: [], watcher_ids: [],
    due_at: null, linked_entity: null, tags: [], subtasks: [],
    created_by: 'u1', created_at: '2026-06-01T00:00:00.000Z',
    updated_at: '2026-06-05T12:00:00.000Z', completed_at: null,
    activity: [], comments: [],
    ai: { risk_score: 0, risk_reason: null, suggested_by: null, source: 'manual' },
    ...overrides,
  };
  // A case that only states `assignee_ids` gets matching resolved names for
  // free; one that states `assignees` (e.g. a null name) keeps exactly what it
  // wrote. Both halves of the wire contract stay expressible.
  if (task.assignees.length === 0) {
    task.assignees = task.assignee_ids.map((id) => ({ id, name: id }));
  }
  return task;
}

const PEOPLE: TaskPerson[] = [
  { id: 'u_alice', name: 'Alice', role: 'admin', department: 'mgmt' },
  { id: 'u_bob',   name: 'Bob',   role: 'tech',  department: 'field' },
  { id: 'u_carol', name: 'Carol', role: 'sales',  department: 'sales' },
];

// --- applyTaskFilter ---

describe('applyTaskFilter', () => {
  const tasks = [
    makeTask({ id: 'a', assignee_ids: ['u_alice'], tags: ['urgent'] }),
    makeTask({ id: 'b', assignee_ids: ['u_bob'],   tags: ['parts'] }),
    makeTask({ id: 'c', assignee_ids: ['u_carol'], tags: ['urgent', 'parts'] }),
  ];

  it("'all' on every dimension returns all tasks", () => {
    const filter: TaskFilter = { memberId: 'all', departmentId: 'all', tag: 'all' };
    expect(applyTaskFilter(tasks, filter, PEOPLE)).toHaveLength(3);
  });

  it('member filter keeps only that assignee', () => {
    const filter: TaskFilter = { memberId: 'u_alice', departmentId: 'all', tag: 'all' };
    const result = applyTaskFilter(tasks, filter, PEOPLE);
    expect(result).toHaveLength(1);
    expect(result[0]?.id).toBe('a');
  });

  it('department filter keeps only tasks with an assignee in the department', () => {
    const filter: TaskFilter = { memberId: 'all', departmentId: 'field', tag: 'all' };
    const result = applyTaskFilter(tasks, filter, PEOPLE);
    expect(result).toHaveLength(1);
    expect(result[0]?.id).toBe('b');
  });

  // --- multi-assignee: every arm is an ANY-ASSIGNEE test, not equality -------

  it('member filter matches a task via its SECOND assignee, not just the first', () => {
    // The single-owner version tested `owner_id === memberId`, so a task Bob was
    // added to as a second holder vanished from his own filter. This is the case
    // the whole feature exists for.
    const shared = makeTask({ id: 'shared', assignee_ids: ['u_alice', 'u_bob'] });
    const filter: TaskFilter = { memberId: 'u_bob', departmentId: 'all', tag: 'all' };
    const result = applyTaskFilter([shared, ...tasks], filter, PEOPLE);
    expect(result.map((t) => t.id).sort()).toEqual(['b', 'shared']);
  });

  it('a shared task appears under BOTH of its assignees\' department filters', () => {
    // alice is 'mgmt', bob is 'field'. A task they hold together belongs to both
    // departments' views - hiding it from either would hide it from someone who
    // is genuinely on it.
    const shared = makeTask({ id: 'shared', assignee_ids: ['u_alice', 'u_bob'] });
    const inMgmt = applyTaskFilter([shared], { memberId: 'all', departmentId: 'mgmt', tag: 'all' }, PEOPLE);
    const inField = applyTaskFilter([shared], { memberId: 'all', departmentId: 'field', tag: 'all' }, PEOPLE);
    expect(inMgmt.map((t) => t.id)).toEqual(['shared']);
    expect(inField.map((t) => t.id)).toEqual(['shared']);
    // ...and still not under a department neither of them is in.
    expect(applyTaskFilter([shared], { memberId: 'all', departmentId: 'sales', tag: 'all' }, PEOPLE))
      .toHaveLength(0);
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

  it("'open' excludes every FINISHED task", () => {
    const result = applyTaskFilter(tasks, { ...ALL, category: 'open' }, PEOPLE, NOW);
    expect(result.every((t) => !isTerminalTaskStatus(t.status))).toBe(true);
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
      makeTask({ id: 'e', assignee_ids: ['u_emanuel'] }),
      makeTask({ id: 'o', assignee_ids: ['u_oved'] }),
    ];
    const filter: TaskFilter = { memberId: 'all', departmentId: 'mgmt', tag: 'all' };
    const result = applyTaskFilter(tasks, filter, MOCK_PEOPLE);
    expect(result.every((t) => t.assignee_ids.includes('u_emanuel'))).toBe(true);
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
        id: 'risky', status: 'BLOCKED', assignee_ids: ['u_alice'],
        due_at: '2026-06-01T00:00:00.000Z',
        updated_at: '2026-06-05T12:00:00.000Z',
      }),
      makeTask({
        id: 'fresh', status: 'TODO', assignee_ids: ['u_bob'],
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
      makeTask({ id: 'alice-overdue', assignee_ids: ['u_alice'], due_at: '2026-06-01T00:00:00.000Z' }),
      makeTask({ id: 'bob-overdue', assignee_ids: ['u_bob'], due_at: '2026-06-01T00:00:00.000Z' }),
    ];
    const filter: TaskFilter = {
      memberId: 'u_alice', departmentId: 'all', tag: 'all', overdue: true,
    };
    const result = applyTaskFilter(tasks, filter, PEOPLE, NOW);
    expect(result.map((t) => t.id)).toEqual(['alice-overdue']);
  });
});

// ---------------------------------------------------------------------------
// Completion log (History tab)
// ---------------------------------------------------------------------------

const DAY_MS = 24 * 60 * 60 * 1000;

function closed(id: string, completed_at: string, overrides: Partial<Task> = {}): Task {
  return makeTask({ id, task_number: id.toUpperCase(), status: 'DONE', completed_at, ...overrides });
}

describe('selectCompletionLog', () => {
  const BASE = { scope: 'everyone', viewerId: 'u1', range: 'all', search: '' } as const;

  it('keeps only DONE tasks that carry a completed_at', () => {
    const tasks = [
      closed('a', '2026-06-06T10:00:00.000Z'),
      makeTask({ id: 'open', status: 'TODO' }),
      makeTask({ id: 'ghost', status: 'DONE', completed_at: null }),
    ];
    expect(selectCompletionLog(tasks, BASE, NOW).map((e) => e.task.id)).toEqual(['a']);
  });

  it('sorts newest first', () => {
    const tasks = [
      closed('old', '2026-06-01T10:00:00.000Z'),
      closed('new', '2026-06-06T10:00:00.000Z'),
      closed('mid', '2026-06-03T10:00:00.000Z'),
    ];
    expect(selectCompletionLog(tasks, BASE, NOW).map((e) => e.task.id)).toEqual(['new', 'mid', 'old']);
  });

  it("scope 'mine' keeps only the viewer's own closures", () => {
    const tasks = [
      closed('mine', '2026-06-06T10:00:00.000Z', { assignee_ids: ['u_alice'] }),
      closed('theirs', '2026-06-06T11:00:00.000Z', { assignee_ids: ['u_bob'] }),
    ];
    const result = selectCompletionLog(tasks, { ...BASE, scope: 'mine', viewerId: 'u_alice' }, NOW);
    expect(result.map((e) => e.task.id)).toEqual(['mine']);
  });

  it('range drops closures older than the window, "all" keeps them', () => {
    const tasks = [
      closed('recent', new Date(NOW.getTime() - 3 * DAY_MS).toISOString()),
      closed('older', new Date(NOW.getTime() - 45 * DAY_MS).toISOString()),
    ];
    expect(selectCompletionLog(tasks, { ...BASE, range: '30d' }, NOW).map((e) => e.task.id)).toEqual(['recent']);
    expect(selectCompletionLog(tasks, { ...BASE, range: '90d' }, NOW).map((e) => e.task.id)).toEqual(['recent', 'older']);
    expect(selectCompletionLog(tasks, { ...BASE, range: 'all' }, NOW)).toHaveLength(2);
  });

  it('search matches a task by its SECOND assignee name', () => {
    const tasks = [
      closed('shared', '2026-06-06T10:00:00.000Z', {
        assignee_ids: ['u_alice', 'u_priya'],
        assignees: [{ id: 'u_alice', name: 'Alice Anderson' }, { id: 'u_priya', name: 'Priya Nair' }],
      }),
      closed('other', '2026-06-06T10:00:00.000Z', { title: 'unrelated' }),
    ];
    const ids = (q: string) => selectCompletionLog(tasks, { ...BASE, search: q }, NOW).map((e) => e.task.id);
    expect(ids('priya')).toEqual(['shared']);
    expect(ids('alice')).toEqual(['shared']);
  });

  it("'mine' scope keeps a task the viewer holds as a SECOND assignee", () => {
    const tasks = [
      closed('shared', '2026-06-06T10:00:00.000Z', { assignee_ids: ['u_alice', 'u1'] }),
      closed('theirs', '2026-06-06T11:00:00.000Z', { assignee_ids: ['u_alice'] }),
    ];
    const result = selectCompletionLog(tasks, { ...BASE, scope: 'mine', viewerId: 'u1' }, NOW);
    expect(result.map((e) => e.task.id)).toEqual(['shared']);
  });

  it('search matches title, task number, assignee name, linked entity and tags', () => {
    const tasks = [
      closed('t1', '2026-06-06T10:00:00.000Z', { title: 'Replace condenser fan' }),
      closed('t2', '2026-06-06T10:00:00.000Z', { task_number: 'T00042' }),
      closed('t3', '2026-06-06T10:00:00.000Z', {
        assignee_ids: ['u_priya'], assignees: [{ id: 'u_priya', name: 'Priya Nair' }],
      }),
      closed('t4', '2026-06-06T10:00:00.000Z', { linked_entity: { type: 'JOB', id: 'j1', label: 'Maple St repair' } }),
      closed('t5', '2026-06-06T10:00:00.000Z', { tags: ['warranty'] }),
      closed('t6', '2026-06-06T10:00:00.000Z', { title: 'unrelated' }),
    ];
    const ids = (q: string) => selectCompletionLog(tasks, { ...BASE, search: q }, NOW).map((e) => e.task.id);
    expect(ids('condenser')).toEqual(['t1']);
    expect(ids('t00042')).toEqual(['t2']);
    expect(ids('priya')).toEqual(['t3']);
    expect(ids('maple')).toEqual(['t4']);
    expect(ids('warranty')).toEqual(['t5']);
    expect(ids('   ')).toHaveLength(6); // whitespace-only is not a search
  });

  it('measures time-to-close from created_at and clamps bad data at zero', () => {
    const tasks = [
      closed('normal', '2026-06-03T00:00:00.000Z', { created_at: '2026-06-01T00:00:00.000Z' }),
      closed('backwards', '2026-06-01T00:00:00.000Z', { created_at: '2026-06-03T00:00:00.000Z' }),
    ];
    const byId = new Map(selectCompletionLog(tasks, BASE, NOW).map((e) => [e.task.id, e.timeToCloseMs]));
    expect(byId.get('normal')).toBe(2 * DAY_MS);
    expect(byId.get('backwards')).toBe(0);
  });
});

describe('formatTimeToClose', () => {
  it('steps through minutes, hours, days and weeks', () => {
    expect(formatTimeToClose(0)).toBe('<1m');
    expect(formatTimeToClose(45 * 60 * 1000)).toBe('45m');
    expect(formatTimeToClose(6 * 60 * 60 * 1000)).toBe('6h');
    expect(formatTimeToClose(3 * DAY_MS)).toBe('3d');
    expect(formatTimeToClose(21 * DAY_MS)).toBe('3w');
  });

  it('returns null when there is nothing to measure', () => {
    expect(formatTimeToClose(null)).toBeNull();
    expect(formatTimeToClose(Number.NaN)).toBeNull();
  });
});

/**
 * THE LOCAL-DAY GUARANTEE.
 *
 * `completed_at` is an instant, not a calendar date, so it is bucketed and
 * printed in the VIEWER'S day - the opposite of `due_at`, which this module
 * reads in UTC on purpose (`isSameUtcDay`). Every assertion below is picked so
 * a UTC implementation gives a visibly different answer, and the timezone is
 * pinned to New York for the duration: under a UTC runner local and UTC agree
 * and none of this would be testing anything.
 */
describe('completion log buckets in the viewer local day, not UTC', () => {
  const ORIGINAL_TZ = process.env.TZ;
  beforeAll(() => { process.env.TZ = 'America/New_York'; });
  afterAll(() => {
    if (ORIGINAL_TZ === undefined) delete process.env.TZ;
    else process.env.TZ = ORIGINAL_TZ;
  });

  const EVERYONE = { scope: 'everyone', viewerId: 'u1', range: 'all', search: '' } as const;

  // 2026-06-06T03:30Z is Friday 2026-06-05, 11:30 PM in New York.
  const FRIDAY_NIGHT_ET = '2026-06-06T03:30:00.000Z';

  it('files a Friday-evening close under Friday, not the following Saturday', () => {
    expect(localDayKey(new Date(FRIDAY_NIGHT_ET))).toBe('2026-06-05'); // UTC would say 2026-06-06

    const groups = groupCompletionsByLocalDay(
      selectCompletionLog([closed('f', FRIDAY_NIGHT_ET)], EVERYONE, NOW),
    );

    expect(groups).toHaveLength(1);
    expect(groups[0]?.key).toBe('2026-06-05');
    // Under UTC bucketing this label reads 'Sat, Jun 6'.
    expect(formatCompletionDayLabel(groups[0]!.date, NOW)).toBe('Fri, Jun 5');
  });

  it('prints the wall-clock time the operator saw, not the UTC one', () => {
    // A UTC formatter would print '3:30 AM', on the wrong day.
    expect(formatCompletionTime(new Date(FRIDAY_NIGHT_ET))).toBe('11:30 PM');
  });

  it("labels a late-evening close 'Yesterday' where UTC would say 'Today'", () => {
    // NOW is 2026-06-07T12:00Z = Sunday 8:00 AM ET. 2026-06-07T02:00Z is
    // Saturday 10:00 PM ET - yesterday to the viewer, same UTC day as NOW.
    const groups = groupCompletionsByLocalDay(
      selectCompletionLog([closed('y', '2026-06-07T02:00:00.000Z')], EVERYONE, NOW),
    );
    expect(formatCompletionDayLabel(groups[0]!.date, NOW)).toBe('Yesterday');
  });

  it("labels a close from the viewer's current day 'Today'", () => {
    const groups = groupCompletionsByLocalDay(
      selectCompletionLog([closed('t', new Date(NOW.getTime() - 60 * 60 * 1000).toISOString())], EVERYONE, NOW),
    );
    expect(formatCompletionDayLabel(groups[0]!.date, NOW)).toBe('Today');
  });

  it('keeps groups newest-first and preserves entry order inside a day', () => {
    const entries = selectCompletionLog([
      closed('fri-late', FRIDAY_NIGHT_ET),
      closed('fri-early', '2026-06-05T14:00:00.000Z'), // Fri 10:00 AM ET
      closed('sun', '2026-06-07T11:00:00.000Z'),       // Sun 7:00 AM ET
    ], EVERYONE, NOW);

    const groups = groupCompletionsByLocalDay(entries);
    expect(groups.map((g) => g.key)).toEqual(['2026-06-07', '2026-06-05']);
    expect(groups[1]?.entries.map((e) => e.task.id)).toEqual(['fri-late', 'fri-early']);
  });
});
