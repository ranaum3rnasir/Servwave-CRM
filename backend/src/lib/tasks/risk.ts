type Priority = 'LOW' | 'MEDIUM' | 'HIGH' | 'URGENT';
type Status = 'TODO' | 'IN_PROGRESS' | 'BLOCKED' | 'DONE';

export interface TaskRisk { score: number; reason: string | null; }

const PRIORITY_WEIGHT: Record<Priority, number> = { LOW: 0, MEDIUM: 20, HIGH: 45, URGENT: 70 };

export function computeTaskRisk(
  task: { status: Status; priority: Priority; due_at: Date | string | null; completed_at: Date | string | null },
  now: Date,
): TaskRisk {
  if (task.status === 'DONE' || task.completed_at) return { score: 0, reason: null };

  let score = PRIORITY_WEIGHT[task.priority] ?? 0;
  const reasons: string[] = [];
  if (task.priority === 'URGENT' || task.priority === 'HIGH') reasons.push(`${task.priority.toLowerCase()} priority`);

  if (task.due_at) {
    const overdueMs = now.getTime() - new Date(task.due_at).getTime();
    if (overdueMs >= 86_400_000) {
      const days = Math.floor(overdueMs / 86_400_000);
      score += Math.min(30, 10 + days * 5);
      reasons.push(`${days}d overdue`);
    } else if (overdueMs >= 0) {
      score += 12; reasons.push('due today');
    }
  }
  if (task.status === 'BLOCKED') { score += 20; reasons.push('blocked'); }

  score = Math.min(100, score);
  return { score, reason: reasons.length ? reasons.join(' · ') : null };
}
