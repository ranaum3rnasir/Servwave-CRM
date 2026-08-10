import { Request, Response } from 'express';
import { z } from 'zod';
import { prisma } from '../lib/prisma';
import { logger } from '../lib/logger';
import { tenantWhere } from '../lib/tenant';
import { allocateNumber } from '../lib/numbering';
import { taskVisibilityWhere, canAccessTask, canAccessLinkedEntity } from '../lib/tasks/visibility';
import { resolveEntityLabels, resolveUserNames } from '../lib/tasks/enrich';
import { computeTaskRisk } from '../lib/tasks/risk';
import { recordTaskActivity, diffTaskActivities } from '../lib/tasks/activity';

// ─── Zod Schemas ───────────────────────────────────────

export const createTaskSchema = z.object({
  title: z.string().min(1),
  description: z.string().optional(),
  status: z.enum(['TODO', 'IN_PROGRESS', 'BLOCKED', 'DONE']).optional(),
  priority: z.enum(['LOW', 'MEDIUM', 'HIGH', 'URGENT']).optional(),
  owner_id: z.string().uuid().nullable().optional(),
  due_at: z.string().datetime({ offset: true }).nullable().optional(),
  linked_entity_type: z.enum(['JOB', 'LEAD', 'CUSTOMER', 'ESTIMATE']).optional(),
  linked_entity_id: z.string().uuid().optional(),
  tags: z.array(z.string()).optional(),
  watcher_ids: z.array(z.string().uuid()).optional(),
  ai_source: z.enum(['MANUAL', 'AI_NL', 'AI_TEMPLATE', 'AI_EXTRACT']).optional(),
  ai_suggested_by: z.string().optional(),
}).refine(
  (d) => (d.linked_entity_type == null) === (d.linked_entity_id == null),
  { message: 'linked_entity_type and linked_entity_id must both be provided or both omitted', path: ['linked_entity_id'] }
);

export const updateTaskSchema = z.object({
  title: z.string().min(1).optional(),
  description: z.string().optional(),
  status: z.enum(['TODO', 'IN_PROGRESS', 'BLOCKED', 'DONE']).optional(),
  priority: z.enum(['LOW', 'MEDIUM', 'HIGH', 'URGENT']).optional(),
  owner_id: z.string().uuid().nullable().optional(),
  due_at: z.string().datetime({ offset: true }).nullable().optional(),
  tags: z.array(z.string()).optional(),
  watcher_ids: z.array(z.string().uuid()).optional(),
});

export const commentSchema = z.object({
  body: z.string().min(1),
});

export const subtaskCreateSchema = z.object({
  text: z.string().min(1),
});

export const subtaskUpdateSchema = z.object({
  text: z.string().min(1).optional(),
  done: z.boolean().optional(),
});

// ─── Helpers ───────────────────────────────────────────

const param = (req: Request, name: string): string => req.params[name] as string;

// ─── Handlers ──────────────────────────────────────────

/** GET /api/tasks — list tasks within the tenant; optionally filter by linked entity */
export async function list(req: Request, res: Response) {
  try {
    const { linked_entity_type, linked_entity_id } = req.query as Record<string, string | undefined>;

    // #245 — listing an entity's tasks requires access to that entity (SQL row check).
    if (linked_entity_type && linked_entity_id && req.user!.role !== 'ADMIN') {
      if (!(await canAccessLinkedEntity(req, linked_entity_type, linked_entity_id))) {
        res.status(403).json({ error: 'Insufficient permissions' });
        return;
      }
    }

    const where = taskVisibilityWhere(req, { linked_entity_type, linked_entity_id });

    const tasks = await prisma.task.findMany({
      where,
      orderBy: { created_at: 'desc' },
      include: { _count: { select: { subtasks: true } } },
    });

    const orgId = req.user!.organization_id;
    const labels = await resolveEntityLabels(orgId,
      tasks.filter((t) => t.linked_entity_type && t.linked_entity_id)
           .map((t) => ({ type: t.linked_entity_type as string, id: t.linked_entity_id as string })));
    const names = await resolveUserNames(orgId, tasks.map((t) => t.owner_id).filter(Boolean) as string[]);
    const now = new Date();

    res.json({
      tasks: tasks.map((t) => ({
        ...t,
        owner_name: t.owner_id ? names.get(t.owner_id) ?? null : null,
        linked_entity_label:
          t.linked_entity_type && t.linked_entity_id
            ? labels.get(`${t.linked_entity_type}:${t.linked_entity_id}`) ?? null
            : null,
        risk: computeTaskRisk(t, now),
      })),
    });
  } catch (err) {
    logger.error('List tasks error:', err);
    res.status(500).json({ error: 'Failed to list tasks' });
  }
}

/** POST /api/tasks — create a task; allocates task_number inside a transaction */
export async function create(req: Request, res: Response) {
  try {
    const {
      title,
      description,
      status,
      priority,
      owner_id,
      due_at,
      linked_entity_type,
      linked_entity_id,
      tags,
      watcher_ids,
      ai_source,
      ai_suggested_by,
    } = req.body;

    // #245 — linking a task to an entity requires that entity to exist in the tenant and
    // be within the caller's read scope (one tenant+scope findFirst; fail-closed).
    if (linked_entity_type && linked_entity_id) {
      if (!(await canAccessLinkedEntity(req, linked_entity_type, linked_entity_id))) {
        res.status(403).json({ error: 'Insufficient permissions' });
        return;
      }
    }

    const orgId = req.user!.organization_id;
    const actorId = req.user!.id;

    const task = await prisma.$transaction(async (tx) => {
      const taskNumber = await allocateNumber(tx, 'task', orgId);

      const created = await tx.task.create({
        data: {
          task_number: taskNumber,
          organization_id: orgId,
          created_by: actorId,
          title,
          description: description ?? '',
          status:      status   ?? 'TODO',
          priority:    priority ?? 'MEDIUM',
          owner_id:    owner_id  ?? null,
          due_at:      due_at   ? new Date(due_at) : null,
          linked_entity_type: linked_entity_type ?? null,
          linked_entity_id:   linked_entity_id   ?? null,
          tags: tags ?? [],
          watcher_ids: [...new Set([actorId, ...(watcher_ids ?? [])])],
          ai_source: ai_source ?? 'MANUAL',
          ...(ai_suggested_by !== undefined && { ai_suggested_by }),
        },
      });

      await recordTaskActivity(tx, {
        taskId: created.id,
        orgId,
        actorId,
        type: 'CREATED',
        description: 'created the task',
      });

      return created;
    });

    res.status(201).json({ task });
  } catch (err) {
    logger.error('Create task error:', err);
    res.status(500).json({ error: 'Failed to create task' });
  }
}

/** PATCH /api/tasks/:id — update a task; status→DONE sets completed_at, others clear it */
export async function update(req: Request, res: Response) {
  try {
    const id = param(req, 'id');

    const existing = await prisma.task.findFirst({
      where: { id, ...tenantWhere(req) },
    });
    if (!existing) {
      res.status(404).json({ error: 'Task not found' });
      return;
    }
    if (!(await canAccessTask(req, existing))) {
      res.status(403).json({ error: 'Insufficient permissions' });
      return;
    }

    const {
      title,
      description,
      status,
      priority,
      owner_id,
      due_at,
      tags,
      watcher_ids,
    } = req.body;

    const data: Record<string, unknown> = {};
    if (title       !== undefined) data.title       = title;
    if (description !== undefined) data.description = description;
    if (priority    !== undefined) data.priority    = priority;
    if (owner_id    !== undefined) data.owner_id    = owner_id;
    if (due_at      !== undefined) data.due_at      = due_at ? new Date(due_at) : null;
    if (tags        !== undefined) data.tags        = tags;
    if (watcher_ids !== undefined) data.watcher_ids = watcher_ids;

    if (status !== undefined) {
      data.status = status;
      data.completed_at = status === 'DONE' ? new Date() : null;
    }

    const orgId   = req.user!.organization_id;
    const actorId = req.user!.id;
    const events  = diffTaskActivities(existing, data);

    const task = await prisma.$transaction(async (tx) => {
      const updated = await tx.task.update({
        where: { id },
        data,
      });

      for (const event of events) {
        await recordTaskActivity(tx, {
          taskId: id,
          orgId,
          actorId,
          type: event.type,
          description: event.description,
        });
      }

      return updated;
    });

    res.json({ task });
  } catch (err) {
    logger.error('Update task error:', err);
    res.status(500).json({ error: 'Failed to update task' });
  }
}

/** GET /api/tasks/:id — task detail: base fields + subtasks, comments, activity, watchers */
export async function getOne(req: Request, res: Response) {
  try {
    const id = param(req, 'id');
    const orgId = req.user!.organization_id;

    const task = await prisma.task.findFirst({
      where: { id, ...tenantWhere(req) },
      include: { _count: { select: { subtasks: true } } },
    });
    if (!task) {
      res.status(404).json({ error: 'Task not found' });
      return;
    }
    if (!(await canAccessTask(req, task))) {
      res.status(403).json({ error: 'Insufficient permissions' });
      return;
    }

    // Load includes in parallel
    const [subtasks, notes, events] = await Promise.all([
      prisma.taskSubtask.findMany({ where: { task_id: id }, orderBy: { position: 'asc' } }),
      prisma.note.findMany({ where: { entity_type: 'TASK', entity_id: id, organization_id: req.user!.organization_id }, orderBy: { created_at: 'asc' } }),
      prisma.timelineEvent.findMany({ where: { entity_type: 'TASK', entity_id: id, organization_id: req.user!.organization_id }, orderBy: { created_at: 'desc' } }),
    ]);

    // Collect all user IDs that need names
    const watcherIds: string[] = Array.isArray(task.watcher_ids) ? (task.watcher_ids as string[]) : [];
    const allUserIds = [
      task.owner_id,
      task.created_by,
      ...watcherIds,
      ...notes.map((n: { created_by: string }) => n.created_by),
      ...events.map((e) => e.created_by).filter((x): x is string => !!x),
    ].filter(Boolean) as string[];

    const [names, labels] = await Promise.all([
      resolveUserNames(orgId, allUserIds),
      task.linked_entity_type && task.linked_entity_id
        ? resolveEntityLabels(orgId, [{ type: task.linked_entity_type, id: task.linked_entity_id }])
        : Promise.resolve(new Map<string, string>()),
    ]);

    const now = new Date();

    res.json({
      task: {
        ...task,
        owner_name: task.owner_id ? names.get(task.owner_id) ?? null : null,
        created_by_name: names.get(task.created_by) ?? null,
        linked_entity_label:
          task.linked_entity_type && task.linked_entity_id
            ? labels.get(`${task.linked_entity_type}:${task.linked_entity_id}`) ?? null
            : null,
        risk: computeTaskRisk(task, now),
        subtasks,
        comments: notes.map((n: { id: string; content: string; created_by: string; created_at: Date }) => ({
          id: n.id,
          body: n.content,
          author_id: n.created_by,
          author_name: names.get(n.created_by) ?? null,
          at: n.created_at,
        })),
        activity: events.map((e) => ({
          id: e.id,
          type: e.event_type,
          description: e.description,
          actor_id: e.created_by,
          actor_name: e.created_by ? names.get(e.created_by) ?? null : null,
          at: e.created_at,
          metadata: e.metadata,
        })),
        watchers: watcherIds.map((uid) => ({ id: uid, name: names.get(uid) ?? null })),
      },
    });
  } catch (err) {
    logger.error('Get task error:', err);
    res.status(500).json({ error: 'Failed to get task' });
  }
}

/** POST /api/tasks/:id/comments — add a comment (reuses polymorphic Note, entity_type=TASK) */
export async function addComment(req: Request, res: Response) {
  try {
    const id = param(req, 'id');
    const { body } = req.body as { body: string };
    const orgId   = req.user!.organization_id;
    const actorId = req.user!.id;

    const existing = await prisma.task.findFirst({
      where: { id, ...tenantWhere(req) },
    });
    if (!existing) {
      res.status(404).json({ error: 'Task not found' });
      return;
    }
    if (!(await canAccessTask(req, existing))) {
      res.status(403).json({ error: 'Insufficient permissions' });
      return;
    }

    const note = await prisma.$transaction(async (tx) => {
      const created = await tx.note.create({
        data: {
          entity_type:     'TASK',
          entity_id:       id,
          content:         body,
          created_by:      actorId,
          organization_id: orgId,
        },
      });

      await recordTaskActivity(tx, {
        taskId:      id,
        orgId,
        actorId,
        type:        'COMMENTED',
        description: 'commented',
      });

      return created;
    });

    res.status(201).json({
      comment: {
        id:        note.id,
        body:      note.content,
        author_id: note.created_by,
        at:        note.created_at,
      },
    });
  } catch (err) {
    logger.error('Add comment error:', err);
    res.status(500).json({ error: 'Failed to add comment' });
  }
}

/** POST /api/tasks/:id/nudge — record a NUDGED activity event; no external notification */
export async function nudge(req: Request, res: Response) {
  try {
    const id     = param(req, 'id');
    const orgId   = req.user!.organization_id;
    const actorId = req.user!.id;

    const task = await prisma.task.findFirst({
      where: { id, ...tenantWhere(req) },
    });
    if (!task) {
      res.status(404).json({ error: 'Task not found' });
      return;
    }
    if (!(await canAccessTask(req, task))) {
      res.status(403).json({ error: 'Insufficient permissions' });
      return;
    }

    await prisma.$transaction((tx) =>
      recordTaskActivity(tx, {
        taskId: id,
        orgId,
        actorId,
        type: 'NUDGED',
        description: 'nudged the task',
      }),
    );

    res.json({ task });
  } catch (err) {
    logger.error('Nudge task error:', err);
    res.status(500).json({ error: 'Failed to nudge task' });
  }
}

/** DELETE /api/tasks/:id — delete a task (admin/dispatcher/sales only; technician → 403 via canDo) */
export async function remove(req: Request, res: Response) {
  try {
    const id = param(req, 'id');

    const existing = await prisma.task.findFirst({
      where: { id, ...tenantWhere(req) },
    });
    if (!existing) {
      res.status(404).json({ error: 'Task not found' });
      return;
    }
    if (!(await canAccessTask(req, existing))) {
      res.status(403).json({ error: 'Insufficient permissions' });
      return;
    }

    await prisma.$transaction(async (tx) => {
      // Clean up polymorphic rows (no FK cascade for Note/TimelineEvent)
      await tx.note.deleteMany({ where: { entity_type: 'TASK', entity_id: id, organization_id: req.user!.organization_id } });
      await tx.timelineEvent.deleteMany({ where: { entity_type: 'TASK', entity_id: id, organization_id: req.user!.organization_id } });
      await tx.task.delete({ where: { id } });
    });

    res.status(204).send();
  } catch (err) {
    logger.error('Delete task error:', err);
    res.status(500).json({ error: 'Failed to delete task' });
  }
}

/** GET /api/tasks/summary — { open, overdue, at_risk, next_due_at } for a linked entity */
export async function summary(req: Request, res: Response) {
  try {
    const { linked_entity_type, linked_entity_id } = req.query as Record<string, string | undefined>;
    if (!linked_entity_type || !linked_entity_id) {
      res.status(400).json({ error: 'linked_entity_type and linked_entity_id are required' });
      return;
    }
    // #245 — a summary of an entity's tasks requires access to that entity (SQL row check).
    if (req.user!.role !== 'ADMIN') {
      if (!(await canAccessLinkedEntity(req, linked_entity_type, linked_entity_id))) {
        res.status(403).json({ error: 'Insufficient permissions' });
        return;
      }
    }
    const where = taskVisibilityWhere(req, { linked_entity_type, linked_entity_id });
    const tasks = await prisma.task.findMany({
      where, select: { status: true, priority: true, due_at: true, completed_at: true },
    });
    const now = new Date();
    let open = 0, overdue = 0, at_risk = 0;
    let next: Date | null = null;
    for (const t of tasks) {
      if (t.status === 'DONE') continue; // non-DONE (incl. BLOCKED) counts as open — still an unresolved obligation
      open++;
      if (t.due_at && t.due_at < now) overdue++;
      if (computeTaskRisk(t, now).score >= 50) at_risk++;
      if (t.due_at && t.due_at > now && (!next || t.due_at < next)) next = t.due_at;
    }
    res.json({ open, overdue, at_risk, next_due_at: next ? next.toISOString() : null });
  } catch (err) {
    logger.error('Task summary error:', err);
    res.status(500).json({ error: 'Failed to compute task summary' });
  }
}

/** POST /api/tasks/:id/subtasks — add a subtask checklist item */
export async function addSubtask(req: Request, res: Response) {
  try {
    const id = param(req, 'id');
    const { text } = req.body as { text: string };

    const task = await prisma.task.findFirst({
      where: { id, ...tenantWhere(req) },
    });
    if (!task) {
      res.status(404).json({ error: 'Task not found' });
      return;
    }
    if (!(await canAccessTask(req, task))) {
      res.status(403).json({ error: 'Insufficient permissions' });
      return;
    }

    const subtask = await prisma.taskSubtask.create({
      data: { task_id: id, text },
    });

    res.status(201).json({ subtask });
  } catch (err) {
    logger.error('Add subtask error:', err);
    res.status(500).json({ error: 'Failed to add subtask' });
  }
}

/** PATCH /api/tasks/:id/subtasks/:subtaskId — update a subtask (text and/or done) */
export async function updateSubtask(req: Request, res: Response) {
  try {
    const id = param(req, 'id');
    const subtaskId = param(req, 'subtaskId');

    const task = await prisma.task.findFirst({
      where: { id, ...tenantWhere(req) },
    });
    if (!task) {
      res.status(404).json({ error: 'Task not found' });
      return;
    }
    if (!(await canAccessTask(req, task))) {
      res.status(403).json({ error: 'Insufficient permissions' });
      return;
    }

    const existing = await prisma.taskSubtask.findFirst({
      where: { id: subtaskId, task_id: id },
    });
    if (!existing) {
      res.status(404).json({ error: 'Subtask not found' });
      return;
    }

    const { text, done } = req.body as { text?: string; done?: boolean };
    const data: Record<string, unknown> = {};
    if (text !== undefined) data.text = text;
    if (done !== undefined) data.done = done;

    const subtask = await prisma.taskSubtask.update({
      where: { id: subtaskId },
      data,
    });

    res.json({ subtask });
  } catch (err) {
    logger.error('Update subtask error:', err);
    res.status(500).json({ error: 'Failed to update subtask' });
  }
}

/** DELETE /api/tasks/:id/subtasks/:subtaskId — remove a subtask */
export async function deleteSubtask(req: Request, res: Response) {
  try {
    const id = param(req, 'id');
    const subtaskId = param(req, 'subtaskId');

    const task = await prisma.task.findFirst({
      where: { id, ...tenantWhere(req) },
    });
    if (!task) {
      res.status(404).json({ error: 'Task not found' });
      return;
    }
    if (!(await canAccessTask(req, task))) {
      res.status(403).json({ error: 'Insufficient permissions' });
      return;
    }

    const existing = await prisma.taskSubtask.findFirst({
      where: { id: subtaskId, task_id: id },
    });
    if (!existing) {
      res.status(404).json({ error: 'Subtask not found' });
      return;
    }

    await prisma.taskSubtask.delete({ where: { id: subtaskId } });

    res.status(204).send();
  } catch (err) {
    logger.error('Delete subtask error:', err);
    res.status(500).json({ error: 'Failed to delete subtask' });
  }
}
