import type { Prisma, PrismaClient } from '@prisma/client';

export const TASK_ENTITY_TYPE = 'TASK';

export type TaskActivityType =
  | 'CREATED' | 'ASSIGNED' | 'STATUS_CHANGED' | 'PRIORITY_CHANGED'
  | 'DUE_CHANGED' | 'COMMENTED' | 'NUDGED' | 'COMPLETED';

type Tx = PrismaClient | Prisma.TransactionClient;

export async function recordTaskActivity(
  tx: Tx,
  a: { taskId: string; orgId: string; actorId: string; type: TaskActivityType; description: string; metadata?: Prisma.InputJsonValue },
): Promise<void> {
  await tx.timelineEvent.create({
    data: {
      organization_id: a.orgId,
      entity_type: TASK_ENTITY_TYPE,
      entity_id: a.taskId,
      event_type: a.type,
      description: a.description,
      metadata: a.metadata,
      created_by: a.actorId,
    },
  });
}

interface BA { status?: string; priority?: string; owner_id?: string | null; due_at?: Date | string | null; }

export function diffTaskActivities(before: BA, after: BA): { type: TaskActivityType; description: string }[] {
  const out: { type: TaskActivityType; description: string }[] = [];
  if (after.status !== undefined && after.status !== before.status) {
    out.push(after.status === 'DONE'
      ? { type: 'COMPLETED', description: 'marked the task complete' }
      : { type: 'STATUS_CHANGED', description: `changed status to ${after.status}` });
  }
  if (after.priority !== undefined && after.priority !== before.priority)
    out.push({ type: 'PRIORITY_CHANGED', description: `changed priority to ${after.priority}` });
  if (after.owner_id !== undefined && after.owner_id !== before.owner_id)
    out.push({ type: 'ASSIGNED', description: after.owner_id ? 'reassigned the task' : 'unassigned the task' });
  if (after.due_at !== undefined && String(after.due_at ?? '') !== String(before.due_at ?? ''))
    out.push({ type: 'DUE_CHANGED', description: after.due_at ? 'changed the due date' : 'cleared the due date' });
  return out;
}
