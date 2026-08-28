import type { Prisma, PrismaClient } from '@prisma/client';
import { prisma } from '../prisma';
import { TASK_ENTITY_TYPE, recordTaskActivity } from './activity';

/**
 * A task's timeline OUTLIVES the task (issue 04). `remove` still deletes the row and its notes,
 * but the timeline is the audit trail that makes `created_by` worth keeping as a permission-free
 * audit field, so it stays.
 *
 * The cost is that every reader of TimelineEvent that does NOT filter by entity (the activity
 * report and the dashboard feed, both org-wide) can now meet an event whose `entity_id` names
 * nothing. Both halves of that contract live here so they cannot drift: the final event the
 * delete writes, and the lookup that turns a dangling `entity_id` back into something readable.
 */
export const TASK_DELETED_EVENT_TYPE = 'DELETED';

/** Everything a reader needs about a task that is gone. There is nothing left to join to. */
export interface DeletedTaskSnapshot {
  task_title: string;
  task_number: string;
}

/** Never blank: the number stands in on its own if the title was empty. */
export function deletedTaskLabel(s: DeletedTaskSnapshot): string {
  const title = s.task_title.trim();
  return title ? `${s.task_number} · ${title}` : s.task_number;
}

/** `metadata` is untyped Json on the row, and pre-issue-04 task events carry none at all. */
function readSnapshot(metadata: unknown): DeletedTaskSnapshot | null {
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return null;
  const m = metadata as Record<string, unknown>;
  if (typeof m.task_number !== 'string' || !m.task_number) return null;
  return { task_number: m.task_number, task_title: typeof m.task_title === 'string' ? m.task_title : '' };
}

type Tx = PrismaClient | Prisma.TransactionClient;

/**
 * The last event on a task's timeline. MUST be written inside the delete transaction and from
 * the row already in hand: after `task.delete` there is no title and no number left to read.
 */
export async function recordTaskDeletion(
  tx: Tx,
  a: { taskId: string; orgId: string; actorId: string; title: string; taskNumber: string },
): Promise<void> {
  const snapshot: DeletedTaskSnapshot = { task_title: a.title, task_number: a.taskNumber };
  await recordTaskActivity(tx, {
    taskId: a.taskId,
    orgId: a.orgId,
    actorId: a.actorId,
    type: 'DELETED',
    description: 'deleted the task',
    metadata: { ...snapshot },
  });
}

/**
 * `entity_id` to label, for the TASK events in `events` whose task is gone.
 *
 * Deleted-ness is decided by the final DELETED event rather than by probing the Task table: the
 * snapshot on that row is the only surviving copy of the title, so the same query has to answer
 * both "is it gone" and "what was it called". An absent key means the entity is NOT known to be
 * deleted, and callers must then render the event exactly as they do today rather than invent a
 * label for it.
 */
export async function resolveDeletedTaskLabels(
  orgId: string,
  events: { entity_type: string; entity_id: string }[],
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const ids = [...new Set(events.filter((e) => e.entity_type === TASK_ENTITY_TYPE).map((e) => e.entity_id))];
  if (!ids.length) return out;

  const rows = await prisma.timelineEvent.findMany({
    where: {
      organization_id: orgId,
      entity_type: TASK_ENTITY_TYPE,
      entity_id: { in: ids },
      event_type: TASK_DELETED_EVENT_TYPE,
    },
    select: { entity_id: true, metadata: true },
  });
  for (const r of rows) {
    const snap = readSnapshot(r.metadata);
    if (snap) out.set(r.entity_id, deletedTaskLabel(snap));
  }
  return out;
}
