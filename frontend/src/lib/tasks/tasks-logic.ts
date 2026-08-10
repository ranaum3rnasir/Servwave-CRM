import type { Task, TaskPerson } from './types';

export function isOverdue(task: Task, now: Date): boolean {
  if (!task.due_at || task.status === 'DONE') return false;
  return new Date(task.due_at).getTime() < now.getTime();
}

export function ageInStageMs(task: Task, now: Date): number {
  return now.getTime() - new Date(task.updated_at).getTime();
}

export interface RiskContext {
  now: Date;
  ownerOpenCount: number;
}

export interface RiskResult {
  score: number;
  reason: string | null;
  atRisk: boolean;
}

const DAY = 24 * 60 * 60 * 1000;

export function assessRisk(task: Task, ctx: RiskContext): RiskResult {
  if (task.status === 'DONE') return { score: 0, reason: null, atRisk: false };

  const reasons: string[] = [];
  let score = 0;

  if (task.due_at) {
    const msToDue = new Date(task.due_at).getTime() - ctx.now.getTime();
    if (msToDue < 0) { score += 45; reasons.push('overdue'); }
    else if (msToDue < DAY) { score += 30; reasons.push('due within 24h'); }
    else if (msToDue < 2 * DAY) { score += 18; reasons.push('due within 48h'); }
  }

  const ageDays = ageInStageMs(task, ctx.now) / DAY;
  if (ageDays >= 5) { score += 20; reasons.push(`sat ${Math.floor(ageDays)}d in ${task.status.toLowerCase()}`); }
  else if (ageDays >= 3) { score += 10; }

  if (ctx.ownerOpenCount >= 8) { score += 20; reasons.push('owner overloaded'); }
  else if (ctx.ownerOpenCount >= 5) { score += 10; }

  if (task.status === 'BLOCKED') { score += 15; reasons.push('blocked'); }

  score = Math.min(100, score);
  return {
    score,
    reason: reasons.length ? reasons.join(', ') : null,
    atRisk: score >= 50,
  };
}

const PRIORITY_RANK: Record<Task['priority'], number> = { URGENT: 0, HIGH: 1, MEDIUM: 2, LOW: 3 };

function isSameUtcDay(a: Date, b: Date): boolean {
  return a.getUTCFullYear() === b.getUTCFullYear()
    && a.getUTCMonth() === b.getUTCMonth()
    && a.getUTCDate() === b.getUTCDate();
}

function myDayBucket(task: Task, now: Date): number {
  if (isOverdue(task, now)) return 0;
  if (task.due_at && isSameUtcDay(new Date(task.due_at), now)) return 1;
  return 2;
}

export function rankMyDay(tasks: Task[], userId: string, now: Date): Task[] {
  return tasks
    .filter((t) => t.owner_id === userId && t.status !== 'DONE')
    .sort((a, b) => {
      const ba = myDayBucket(a, now);
      const bb = myDayBucket(b, now);
      if (ba !== bb) return ba - bb;
      const pa = PRIORITY_RANK[a.priority];
      const pb = PRIORITY_RANK[b.priority];
      if (pa !== pb) return pa - pb;
      return ageInStageMs(b, now) - ageInStageMs(a, now);
    });
}

export interface AssigneeStat { userId: string; open: number; overdue: number; }
export interface TrendPoint { weekIndex: number; done: number; }
export interface TaskStats {
  open: number;
  atRisk: number;
  onTimePct: number;
  blocked: number;
  topCloserId: string | null;
  byAssignee: AssigneeStat[];
  trend: TrendPoint[];
}

function ownerOpenCounts(tasks: Task[]): Map<string, number> {
  const m = new Map<string, number>();
  for (const t of tasks) {
    if (t.status === 'DONE') continue;
    m.set(t.owner_id, (m.get(t.owner_id) ?? 0) + 1);
  }
  return m;
}

export function computeStats(tasks: Task[], now: Date): TaskStats {
  const openCounts = ownerOpenCounts(tasks);

  const open = tasks.filter((t) => t.status !== 'DONE').length;
  const blocked = tasks.filter((t) => t.status === 'BLOCKED').length;

  const atRisk = tasks.filter(
    (t) => assessRisk(t, { now, ownerOpenCount: openCounts.get(t.owner_id) ?? 0 }).atRisk,
  ).length;

  const done = tasks.filter((t) => t.status === 'DONE' && t.completed_at);
  const onTime = done.filter((t) => t.due_at && new Date(t.completed_at!).getTime() <= new Date(t.due_at).getTime()).length;
  const onTimePct = done.length === 0 ? 100 : Math.round((onTime / done.length) * 100);

  const closeCounts = new Map<string, number>();
  for (const t of done) closeCounts.set(t.owner_id, (closeCounts.get(t.owner_id) ?? 0) + 1);
  let topCloserId: string | null = null;
  let topCount = -1;
  for (const [uid, c] of closeCounts) if (c > topCount) { topCount = c; topCloserId = uid; }

  const byAssignee: AssigneeStat[] = Array.from(openCounts.keys()).map((userId) => ({
    userId,
    open: openCounts.get(userId) ?? 0,
    overdue: tasks.filter((t) => t.owner_id === userId && isOverdue(t, now)).length,
  })).sort((a, b) => b.open - a.open);

  const WEEK = 7 * DAY;
  const trend: TrendPoint[] = Array.from({ length: 8 }, (_, i) => ({ weekIndex: i, done: 0 }));
  for (const t of done) {
    const weeksAgo = Math.floor((now.getTime() - new Date(t.completed_at!).getTime()) / WEEK);
    if (weeksAgo >= 0 && weeksAgo < 8) { const pt = trend[7 - weeksAgo]; if (pt) pt.done += 1; }
  }

  return { open, atRisk, onTimePct, blocked, topCloserId, byAssignee, trend };
}

// ---------------------------------------------------------------------------
// Filter
// ---------------------------------------------------------------------------

export type TaskCategory = 'all' | 'open' | 'atRisk' | 'onTime' | 'blocked';

export interface TaskFilter {
  memberId: string;     // 'all' or a person id
  departmentId: string; // 'all' or a department id
  tag: string;          // 'all' or a tag string
  category?: TaskCategory; // optional drill-down from the dashboard KPI cards
  overdue?: boolean;
  atRisk?: boolean;
  dueFrom?: string;     // 'YYYY-MM-DD' | ''
  dueTo?: string;       // 'YYYY-MM-DD' | ''
  createdFrom?: string; // 'YYYY-MM-DD' | ''
  createdTo?: string;   // 'YYYY-MM-DD' | ''
}

export const ALL_FILTER: TaskFilter = { memberId: 'all', departmentId: 'all', tag: 'all', category: 'all' };

// people: list used to resolve an owner's department for the department filter.
export function applyTaskFilter(tasks: Task[], filter: TaskFilter, people: TaskPerson[], now: Date = new Date()): Task[] {
  const deptOf = (ownerId: string) => people.find((p) => p.id === ownerId)?.department ?? null;
  const openCounts = filter.atRisk ? ownerOpenCounts(tasks) : null;
  const base = tasks.filter((t) => {
    if (filter.memberId !== 'all' && t.owner_id !== filter.memberId) return false;
    if (filter.departmentId !== 'all' && deptOf(t.owner_id) !== filter.departmentId) return false;
    if (filter.tag !== 'all' && !t.tags.includes(filter.tag)) return false;
    if (filter.overdue && !isOverdue(t, now)) return false;
    if (filter.atRisk && !assessRisk(t, { now, ownerOpenCount: openCounts!.get(t.owner_id) ?? 0 }).atRisk) return false;
    if (filter.dueFrom || filter.dueTo) {
      if (!t.due_at) return false;
      const d = t.due_at.slice(0, 10);
      if (filter.dueFrom && d < filter.dueFrom) return false;
      if (filter.dueTo && d > filter.dueTo) return false;
    }
    if (filter.createdFrom || filter.createdTo) {
      const c = t.created_at.slice(0, 10);
      if (filter.createdFrom && c < filter.createdFrom) return false;
      if (filter.createdTo && c > filter.createdTo) return false;
    }
    return true;
  });

  const category = filter.category ?? 'all';
  if (category === 'all') return base;
  if (category === 'open') return base.filter((t) => t.status !== 'DONE');
  if (category === 'blocked') return base.filter((t) => t.status === 'BLOCKED');
  if (category === 'onTime') {
    return base.filter((t) =>
      t.status === 'DONE' && !!t.completed_at && !!t.due_at &&
      new Date(t.completed_at).getTime() <= new Date(t.due_at).getTime());
  }
  // atRisk — compute owner open-counts over `base` so the drilled list exactly
  // matches computeStats' At Risk card for the same member/dept/tag scope.
  const catOpenCounts = ownerOpenCounts(base);
  return base.filter((t) => assessRisk(t, { now, ownerOpenCount: catOpenCounts.get(t.owner_id) ?? 0 }).atRisk);
}

// ---------------------------------------------------------------------------
// History analytics
// ---------------------------------------------------------------------------

export interface HistorySnapshot { todo: number; inProgress: number; blocked: number; done: number; }
export interface FlowPoint { weekIndex: number; created: number; closed: number; }
export interface UpcomingBuckets { thisWeek: Task[]; nextWeek: Task[]; later: Task[]; }
export interface TaskHistory {
  snapshot: HistorySnapshot;
  flow: FlowPoint[];        // last 8 weeks, index 0 = oldest, 7 = current
  upcoming: UpcomingBuckets;
}

export function computeHistory(tasks: Task[], now: Date): TaskHistory {
  const DAY_MS = 24 * 60 * 60 * 1000;
  const WEEK_MS = 7 * DAY_MS;

  const snapshot: HistorySnapshot = {
    todo:       tasks.filter((t) => t.status === 'TODO').length,
    inProgress: tasks.filter((t) => t.status === 'IN_PROGRESS').length,
    blocked:    tasks.filter((t) => t.status === 'BLOCKED').length,
    done:       tasks.filter((t) => t.status === 'DONE').length,
  };

  const flow: FlowPoint[] = Array.from({ length: 8 }, (_, i) => ({ weekIndex: i, created: 0, closed: 0 }));
  const bucketIdx = (iso: string) => {
    const weeksAgo = Math.floor((now.getTime() - new Date(iso).getTime()) / WEEK_MS);
    return weeksAgo >= 0 && weeksAgo < 8 ? 7 - weeksAgo : -1;
  };
  for (const t of tasks) {
    const ci = bucketIdx(t.created_at);
    if (ci >= 0) flow[ci]!.created += 1;
    if (t.status === 'DONE' && t.completed_at) {
      const di = bucketIdx(t.completed_at);
      if (di >= 0) flow[di]!.closed += 1;
    }
  }

  const upcoming: UpcomingBuckets = { thisWeek: [], nextWeek: [], later: [] };
  for (const t of tasks) {
    if (t.status === 'DONE' || !t.due_at) continue;
    const ms = new Date(t.due_at).getTime() - now.getTime();
    if (ms < 0) continue;                 // overdue is not "upcoming"
    if (ms <= WEEK_MS) upcoming.thisWeek.push(t);
    else if (ms <= 2 * WEEK_MS) upcoming.nextWeek.push(t);
    else upcoming.later.push(t);
  }

  return { snapshot, flow, upcoming };
}
