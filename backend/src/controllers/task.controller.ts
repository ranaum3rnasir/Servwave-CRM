import { Request, Response } from 'express';
import { z } from 'zod';
import { prisma } from '../lib/prisma';
import { logger } from '../lib/logger';
import { tenantWhere } from '../lib/tenant';
import { allocateNumber } from '../lib/numbering';
import { taskVisibilityWhere, canAccessTask, canAccessLinkedEntity } from '../lib/tasks/visibility';
import { resolveEntityLabels, resolveUserNames, entityLabelFields } from '../lib/tasks/enrich';
import { entityRefKey, ENTITY_DELEGATES } from '../lib/tasks/entityAccess';
import { readersWithEntityAccess } from '../lib/tasks/entityAccessCohort';
import { computeTaskRisk } from '../lib/tasks/risk';
import { TASK_STATUSES, isTerminalTaskStatus } from '../lib/tasks/status';
import { recordTaskActivity, diffTaskActivities, diffIdSets, toIdSet } from '../lib/tasks/activity';
import { recordTaskDeletion } from '../lib/tasks/deletion';
import { emit } from '../services/notifications/notificationService';

// ─── Zod Schemas ───────────────────────────────────────

export const createTaskSchema = z.object({
  title: z.string().min(1),
  description: z.string().optional(),
  status: z.enum(TASK_STATUSES).optional(),
  priority: z.enum(['LOW', 'MEDIUM', 'HIGH', 'URGENT']).optional(),
  // Flat set of assignees (design §2). `owner_id` is gone; Zod strips it if a stale client sends it.
  assignee_ids: z.array(z.string().uuid()).optional(),
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
  status: z.enum(TASK_STATUSES).optional(),
  priority: z.enum(['LOW', 'MEDIUM', 'HIGH', 'URGENT']).optional(),
  assignee_ids: z.array(z.string().uuid()).optional(),
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

const ASSIGN_SELF_ONLY = 'You can only assign tasks to yourself.';
const AT_LEAST_ONE     = 'A task must have at least one assignee.';
const NOT_ORG_MEMBERS  = 'Assignees and watchers must be active users of your organization.';

/** Design §3 — assigning OTHER people is a grant (`assign` on Task), never a role test. */
const canAssignOthers = (req: Request): boolean => req.ability?.can('assign', 'Task') ?? false;

const sameSet = (a: string[], b: string[]): boolean =>
  a.length === b.length && a.every((x) => b.includes(x));

/**
 * Every assignee/watcher id must name an ACTIVE user of the caller's org — the arrays carry no FK,
 * so nothing else checks it. The actor is exempt: they authenticated as an active user of this org
 * one middleware ago, and exempting them keeps the overwhelmingly common "assign it to myself"
 * create free of an extra round-trip.
 */
async function allActiveOrgMembers(orgId: string, actorId: string, ids: string[]): Promise<boolean> {
  const probe = ids.filter((id) => id !== actorId);
  if (!probe.length) return true;
  const rows = await prisma.user.findMany({
    where: { id: { in: probe }, organization_id: orgId, is_active: true },
    select: { id: true },
  });
  const found = new Set(rows.map((u) => u.id));
  return probe.every((id) => found.has(id));
}

/**
 * How a task identifies itself to the notification layer (design §5).
 *
 * `title` is the label, not `task_number`: "T00042 assigned to you" tells the reader nothing,
 * and for `task.deleted` the title is the ONLY thing left that can say which task — it is a
 * SNAPSHOT taken from the row before the delete, never a re-read.
 */
type TaskRef = { id: string; title: string; task_number: string };

/**
 * Fire one task notification. Callers pass the raw people-lists; `resolveRecipients` owns the
 * matrix that turns them into recipients, and `dedupe()` drops the actor one layer below that.
 *
 * POST-COMMIT ONLY — never handed the caller's `tx` (#271, the job.controller precedent).
 * emit() writes rows; a transaction that later rolls back must not leave notifications behind
 * for an edit that never happened. It is also best-effort and never throws, so an await here
 * cannot fail the request.
 *
 * The empty-recipients guard is NOT redundant with the actor drop downstream: emit() loads the
 * org's role holders BEFORE it resolves recipients, so an emit destined for nobody still costs
 * a query. Skipping it keeps the overwhelmingly common assign-it-to-myself create free of one.
 */
async function emitTask(
  req: Request,
  verb: string,
  task: TaskRef,
  entity: Record<string, string[]>,
): Promise<void> {
  const actorId = req.user!.id;
  const someoneElse = Object.values(entity).flat().some((id) => id !== actorId);
  if (!someoneElse) return;
  await emit({
    verb,
    organizationId: req.user!.organization_id,
    actorId,
    object: { type: 'TASK', id: task.id, label: task.title },
    entity,
    data: { task_number: task.task_number },
  });
}

/** Contract shape: `assignees` / `watchers` are `{ id, name | null }`, order matching the id array. */
const withNames = (ids: string[], names: Map<string, string>) =>
  ids.map((id) => ({ id, name: names.get(id) ?? null }));

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
    // #01 - labels resolve WITHIN the caller's entity scope, batched for the whole page: one query
    // per entity type, never one per task. A link the caller cannot open comes back redacted.
    const labels = await resolveEntityLabels(
      req.user!,
      tasks.filter((t) => t.linked_entity_type && t.linked_entity_id)
           .map((t) => ({ type: t.linked_entity_type as string, id: t.linked_entity_id as string })),
      { ability: req.ability },
    );
    const names = await resolveUserNames(orgId, tasks.flatMap((t) => toIdSet(t.assignee_ids)));
    const now = new Date();

    res.json({
      tasks: tasks.map((t) => ({
        ...t,
        assignees: withNames(toIdSet(t.assignee_ids), names),
        ...entityLabelFields(t, labels),
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
      assignee_ids,
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

    // ── Design §3: who ends up on the task ────────────────────────────────────────────────
    // Without the grant the actor may only ever create work for themselves; asking for anyone
    // else (including an empty set) is refused rather than silently rewritten, so a stale or
    // hostile client learns it was denied. With the grant the body wins, and an omitted/empty
    // list falls back to the actor — the create dialog pre-fills self as a REMOVABLE default.
    const requested = assignee_ids === undefined ? undefined : toIdSet(assignee_ids);
    let assignees: string[];
    if (canAssignOthers(req)) {
      assignees = requested?.length ? requested : [actorId];
    } else {
      if (requested && !(requested.length === 1 && requested[0] === actorId)) {
        res.status(403).json({ error: ASSIGN_SELF_ONLY });
        return;
      }
      assignees = [actorId];
    }

    // Watchers are OBSERVERS now, and default to nobody. The actor is deliberately NOT
    // auto-added — that reverses the previous behaviour and is the point (design §1/§3).
    const watchers = toIdSet(watcher_ids ?? []);

    if (!(await allActiveOrgMembers(orgId, actorId, [...new Set([...assignees, ...watchers])]))) {
      res.status(400).json({ error: NOT_ORG_MEMBERS });
      return;
    }

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
          assignee_ids: assignees,
          due_at:      due_at   ? new Date(due_at) : null,
          linked_entity_type: linked_entity_type ?? null,
          linked_entity_id:   linked_entity_id   ?? null,
          tags: tags ?? [],
          watcher_ids: watchers,
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

    // ─── Notifications (design §5) — POST-COMMIT ───────────────────────────────────────────
    // At create every name on the task is a newly added one, so the whole list IS the delta.
    const ref: TaskRef = { id: task.id, title: task.title, task_number: task.task_number };
    await emitTask(req, 'task.assigned', ref, { added_assignee_ids: assignees });
    await emitTask(req, 'task.watching', ref, { added_watcher_ids: watchers });

    const names = await resolveUserNames(orgId, toIdSet(task.assignee_ids));
    res.status(201).json({ task: { ...task, assignees: withNames(toIdSet(task.assignee_ids), names) } });
  } catch (err) {
    logger.error('Create task error:', err);
    res.status(500).json({ error: 'Failed to create task' });
  }
}

/**
 * PATCH /api/tasks/:id - update a task; status→DONE sets completed_at, every other status
 * (CANCELLED included) clears it. A cancelled task never finished, so it must not carry a
 * completion timestamp (issue 03).
 */
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
      assignee_ids,
      due_at,
      tags,
      watcher_ids,
    } = req.body;

    const orgId   = req.user!.organization_id;
    const actorId = req.user!.id;

    const existingAssignees = toIdSet(existing.assignee_ids);
    const existingWatchers  = toIdSet(existing.watcher_ids);

    // A live task always has >= 1 assignee (design §2) — the invariant lives here, not in the DB.
    let nextAssignees: string[] | undefined;
    if (assignee_ids !== undefined) {
      nextAssignees = toIdSet(assignee_ids);
      if (!nextAssignees.length) {
        res.status(400).json({ error: AT_LEAST_ONE });
        return;
      }
      // A non-holder keeps every other field on a task they can see; only the roster is closed to
      // them. Re-sending the SAME set is not a change, so an untouched multi-select never 403s.
      if (!sameSet(nextAssignees, existingAssignees) && !canAssignOthers(req)) {
        res.status(403).json({ error: ASSIGN_SELF_ONLY });
        return;
      }
    }
    const nextWatchers = watcher_ids === undefined ? undefined : toIdSet(watcher_ids);

    const incoming = [...new Set([...(nextAssignees ?? []), ...(nextWatchers ?? [])])];
    if (incoming.length && !(await allActiveOrgMembers(orgId, actorId, incoming))) {
      res.status(400).json({ error: NOT_ORG_MEMBERS });
      return;
    }

    const data: Record<string, unknown> = {};
    if (title        !== undefined) data.title        = title;
    if (description  !== undefined) data.description  = description;
    if (priority     !== undefined) data.priority     = priority;
    if (nextAssignees !== undefined) data.assignee_ids = nextAssignees;
    if (due_at       !== undefined) data.due_at       = due_at ? new Date(due_at) : null;
    if (tags         !== undefined) data.tags         = tags;
    if (nextWatchers !== undefined) data.watcher_ids  = nextWatchers;

    if (status !== undefined) {
      data.status = status;
      // DONE only. NOT `isTerminalTaskStatus`: CANCELLED is terminal but did not complete,
      // and stamping it here is exactly the lie the new status exists to stop telling.
      data.completed_at = status === 'DONE' ? new Date() : null;
    }

    // One lookup covers both the named activity entries (design §6) and the response projection.
    const names = await resolveUserNames(orgId, [...new Set([
      ...existingAssignees, ...(nextAssignees ?? []),
      ...existingWatchers,  ...(nextWatchers ?? []),
    ])]);
    const events = diffTaskActivities(existing, data, names);

    // The SAME membership diff the activity events above are built from (diffIdSets is the one
    // implementation both go through), reused here as design §5's recipient lists rather than
    // re-derived — a second hand-rolled diff would eventually disagree with the feed.
    const assigneeDelta = diffIdSets(existingAssignees, nextAssignees);
    const watcherDelta  = diffIdSets(existingWatchers, nextWatchers);
    // Status is UNORDERED, so these are explicit transition tests, not `status >= DONE`.
    // They are also mutually exclusive by construction: one PATCH carries one status.
    const justCompleted = status === 'DONE'      && existing.status !== 'DONE';
    const justCancelled = status === 'CANCELLED' && existing.status !== 'CANCELLED';

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

    // ─── Notifications (design §5) — POST-COMMIT ───────────────────────────────────────────
    const ref: TaskRef = { id: task.id, title: task.title, task_number: task.task_number };
    await emitTask(req, 'task.assigned', ref, { added_assignee_ids: assigneeDelta.added });
    await emitTask(req, 'task.watching', ref, { added_watcher_ids: watcherDelta.added });
    // One notice per person taken off the task, whichever of the two lists they were on.
    await emitTask(req, 'task.removed', ref, {
      removed_ids: [...new Set([...assigneeDelta.removed, ...watcherDelta.removed])],
    });
    if (justCompleted || justCancelled) {
      // The roster AFTER the write, so someone added in this very PATCH still hears about it.
      // The actor is dropped downstream, hence "the OTHER assignees".
      //
      // Issue 03: a cancellation gets its OWN verb. `task.completed` is gated on the flip into
      // DONE above and so cannot fire here; reusing it would tell the other assignees the work
      // finished. Being dropped from work you were assigned is the surprise task.removed exists
      // to prevent, so silence is not an option either.
      await emitTask(req, justCompleted ? 'task.completed' : 'task.cancelled', ref, {
        assignee_ids: toIdSet(task.assignee_ids),
        watcher_ids:  toIdSet(task.watcher_ids),
      });
    }

    res.json({ task: { ...task, assignees: withNames(toIdSet(task.assignee_ids), names) } });
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
    const watcherIds:  string[] = toIdSet(task.watcher_ids);
    const assigneeIds: string[] = toIdSet(task.assignee_ids);
    const allUserIds = [
      ...assigneeIds,
      task.created_by,
      ...watcherIds,
      ...notes.map((n: { created_by: string }) => n.created_by),
      ...events.map((e) => e.created_by).filter((x): x is string => !!x),
    ].filter(Boolean) as string[];

    // #01 - same scoped resolver as the list. Reaching here does NOT imply entity access: an
    // assignee or watcher passes canAccessTask on that arm alone, so the link can still redact.
    const [names, labels] = await Promise.all([
      resolveUserNames(orgId, allUserIds),
      resolveEntityLabels(
        req.user!,
        task.linked_entity_type && task.linked_entity_id
          ? [{ type: task.linked_entity_type, id: task.linked_entity_id }]
          : [],
        { ability: req.ability },
      ),
    ]);

    const now = new Date();

    res.json({
      task: {
        ...task,
        assignees: withNames(assigneeIds, names),
        created_by_name: names.get(task.created_by) ?? null,
        ...entityLabelFields(task, labels),
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
        watchers: withNames(watcherIds, names),
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

/**
 * DELETE /api/tasks/:id — delete a task.
 *
 * The `delete Task` grant is enforced HERE, not on the route, because of design §3's escape
 * hatch: a technician holds no delete grant at all, yet must be able to get rid of a to-do they
 * made for themselves. A route-level `canDo('delete','Task')` fires before the row is loaded, so
 * the exception would be unreachable. Both paths are checked below, row in hand:
 *   • creator AND sole assignee → allowed regardless of grant, or
 *   • the `delete Task` grant.
 * The narrow exception is deliberate — a blanket technician delete grant would also let them
 * destroy an office task they merely reached through a linked job.
 */
export async function remove(req: Request, res: Response) {
  try {
    const id = param(req, 'id');
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

    const assignees = toIdSet(existing.assignee_ids);
    const ownTodo = existing.created_by === actorId && assignees.length === 1 && assignees[0] === actorId;
    if (!ownTodo && !(req.ability?.can('delete', 'Task') ?? false)) {
      res.status(403).json({ error: 'Insufficient permissions' });
      return;
    }

    // Design §5 — `task.deleted` outlives its object. Everything the notification needs (who
    // was on it, what it was called) is SNAPSHOT here from the row already in hand, because
    // after the transaction below there is nothing left to read it from.
    const watchers = toIdSet(existing.watcher_ids);
    const ref: TaskRef = { id: existing.id, title: existing.title, task_number: existing.task_number };

    await prisma.$transaction(async (tx) => {
      // Issue 04 - the two polymorphic tables are treated DIFFERENTLY here, and the asymmetry is
      // the whole fix. Notes are user-written content with no surface once the drawer is gone, so
      // they still go. Timeline events are the audit trail that makes design's permission-free
      // `created_by` worth keeping, so they stay, closed off by a final DELETED event that
      // snapshots the title and number the row can no longer supply.
      await tx.note.deleteMany({ where: { entity_type: 'TASK', entity_id: id, organization_id: req.user!.organization_id } });
      await recordTaskDeletion(tx, {
        taskId: id,
        orgId: req.user!.organization_id,
        actorId,
        title: existing.title,
        taskNumber: existing.task_number,
      });
      await tx.task.delete({ where: { id } });
    });

    // POST-COMMIT, on the snapshot. Its deep link dead-ends — design §5 accepts that.
    await emitTask(req, 'task.deleted', ref, { assignee_ids: assignees, watcher_ids: watchers });

    res.status(204).send();
  } catch (err) {
    logger.error('Delete task error:', err);
    res.status(500).json({ error: 'Failed to delete task' });
  }
}

/**
 * GET /api/tasks/entity-access?entity_type=&entity_id= - which assignable users CANNOT open the
 * entity a task is linked to (#05).
 *
 * ADVISORY ONLY. Assignment is unchanged: being assigned a task grants the TASK and nothing else,
 * and a candidate listed here is still perfectly assignable. This exists so the picker can say so
 * up front, instead of the assignee discovering a "Restricted job" placeholder later.
 *
 * The roster is `GET /api/users?assignable=true&eligible_for=task` (active users in the tenant),
 * resolved server-side so the picker needs ONE request for the whole list and none per keystroke.
 *
 * The entity's own label goes through `resolveEntityLabels` for the CALLER, so an assigner who
 * cannot see the entity gets #01's placeholder here too and the warning never becomes the leak it
 * is warning about.
 */
export async function entityAccess(req: Request, res: Response) {
  try {
    const { entity_type, entity_id } = req.query as Record<string, string | undefined>;
    if (!entity_type || !entity_id) {
      res.status(400).json({ error: 'entity_type and entity_id are required' });
      return;
    }
    if (!ENTITY_DELEGATES[entity_type]) {
      res.status(400).json({ error: 'Unknown entity_type' });
      return;
    }

    // Existence first: a link to a row that is gone would otherwise read as "nobody can see it"
    // and flag the entire roster.
    const exists = await ENTITY_DELEGATES[entity_type].findFirst({
      where: { id: entity_id, ...tenantWhere(req) },
      select: { id: true },
    });
    if (!exists) {
      res.status(404).json({ error: 'Linked entity not found' });
      return;
    }

    const candidates = await prisma.user.findMany({
      where: { ...tenantWhere(req), is_active: true },
      select: {
        id: true,
        role: true,
        organization_id: true,
        custom_role_id: true,
        // grantRoleKey throws when custom_role_id is set without the relation loaded - deliberately,
        // because the fallback would be the BASE role's wider grant set.
        custom_role: { select: { key: true } },
        department_id: true,
        location_id: true,
      },
    });

    const ref = { type: entity_type, id: entity_id };
    const [{ withAccess }, labels] = await Promise.all([
      readersWithEntityAccess(candidates, ref),
      resolveEntityLabels(req.user!, [ref], { ability: req.ability }),
    ]);
    const label = labels.get(entityRefKey(entity_type, entity_id));

    res.json({
      entity: {
        type: entity_type,
        id: entity_id,
        label: label?.label ?? null,
        redacted: label?.redacted ?? false,
      },
      checked_user_ids: candidates.map((c) => c.id),
      without_access: candidates.filter((c) => !withAccess.has(c.id)).map((c) => c.id),
    });
  } catch (err) {
    logger.error('Task entity-access error:', err);
    res.status(500).json({ error: 'Failed to resolve entity access' });
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
      // Terminal (DONE or CANCELLED) is finished either way; everything else, BLOCKED included,
      // counts as open: it is still an unresolved obligation. Reopening a cancelled task to
      // TODO puts it straight back in this count, with no transition rule to unwind.
      if (isTerminalTaskStatus(t.status)) continue;
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
