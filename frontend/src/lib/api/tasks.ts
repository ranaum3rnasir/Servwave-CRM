import api from '@/lib/axios';
import type { Task, TaskStatus, TaskPriority, LinkedEntityType } from '@/lib/tasks/types';

export interface TaskRow {
  id: string;
  task_number: string;
  title: string;
  description: string;
  status: TaskStatus;
  priority: TaskPriority;
  owner_id: string | null;
  owner_name?: string | null;
  due_at: string | null;
  linked_entity_type: LinkedEntityType | null;
  linked_entity_id: string | null;
  linked_entity_label?: string | null;
  tags: string[];
  created_by: string;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
  risk?: { score: number; reason: string | null };
  _count?: { subtasks: number };
}

export interface CreateTaskInput {
  title: string;
  description?: string;
  status?: TaskStatus;
  priority?: TaskPriority;
  owner_id?: string | null;
  due_at?: string | null;
  linked_entity?: { type: LinkedEntityType; id: string } | null;
  tags?: string[];
  watcher_ids?: string[];
}

// Row → full Task (list rows: fill rich client-only fields with empty defaults).
export function mapRowToTask(r: TaskRow): Task {
  return {
    id: r.id,
    task_number: r.task_number,
    title: r.title,
    description: r.description ?? '',
    status: r.status,
    priority: r.priority,
    owner_id: r.owner_id ?? '',
    owner_name: r.owner_name ?? null,
    watcher_ids: [],
    due_at: r.due_at,
    linked_entity:
      r.linked_entity_type && r.linked_entity_id
        ? { type: r.linked_entity_type, id: r.linked_entity_id, label: r.linked_entity_label ?? '' }
        : null,
    tags: r.tags ?? [],
    subtasks: [],
    created_by: r.created_by,
    created_at: r.created_at,
    updated_at: r.updated_at,
    completed_at: r.completed_at,
    activity: [],
    comments: [],
    ai: {
      risk_score: r.risk?.score ?? 0,
      risk_reason: r.risk?.reason ?? null,
      suggested_by: null,
      source: 'manual',
    },
  };
}

// Detail row type: TaskRow + rich arrays returned by GET /api/tasks/:id
interface TaskDetailRow extends TaskRow {
  subtasks: Array<{ id: string; text: string; done: boolean; position?: number }>;
  comments: Array<{ id: string; body: string; author_id: string; author_name?: string | null; at: string }>;
  activity: Array<{ id: string; type: string; actor_id: string; actor_name?: string | null; at: string; description?: string; metadata?: Record<string, string> | null }>;
  watchers: Array<{ id: string; name: string }>;
  created_by_name?: string | null;
}

// Detail row → full Task (includes subtasks, comments, activity, watchers).
export function mapDetailToTask(d: TaskDetailRow): Task {
  const base = mapRowToTask(d);
  return {
    ...base,
    created_by_name: d.created_by_name ?? null,
    subtasks: d.subtasks.map(({ id, text, done }) => ({ id, text, done })),
    comments: d.comments.map((c) => ({
      id: c.id,
      author_id: c.author_id,
      body: c.body,
      at: c.at,
      author_name: c.author_name ?? null,
    })),
    activity: d.activity.map((e) => ({
      id: e.id,
      type: (e.type as string).toLowerCase() as Task['activity'][number]['type'],
      actor_id: e.actor_id,
      at: e.at,
      description: e.description,
      actor_name: e.actor_name ?? null,
      meta: (e.metadata as Record<string, string> | null | undefined) ?? undefined,
    })),
    watchers: d.watchers,
    watcher_ids: d.watchers.map((w) => w.id),
  };
}

export function getTask(id: string): Promise<Task> {
  return api.get('/api/tasks/' + id).then((r) => mapDetailToTask(r.data.task as TaskDetailRow));
}

export function listTasks(params?: {
  linked_entity_type?: LinkedEntityType;
  linked_entity_id?: string;
}): Promise<Task[]> {
  return api
    .get('/api/tasks', { params })
    .then((res) => (res.data.tasks as TaskRow[]).map(mapRowToTask));
}

export function createTask(input: CreateTaskInput): Promise<Task> {
  const body: Record<string, unknown> = {
    title: input.title,
    description: input.description,
    status: input.status,
    priority: input.priority,
    owner_id: input.owner_id,
    due_at: input.due_at,
    tags: input.tags,
    linked_entity_type: input.linked_entity?.type,
    linked_entity_id: input.linked_entity?.id,
  };
  if (input.watcher_ids && input.watcher_ids.length > 0) {
    body.watcher_ids = input.watcher_ids;
  }
  return api.post('/api/tasks', body).then((res) => mapRowToTask(res.data.task as TaskRow));
}

export function updateTaskApi(
  id: string,
  patch: Partial<
    Pick<Task, 'title' | 'description' | 'status' | 'priority' | 'owner_id' | 'due_at' | 'tags' | 'watcher_ids'>
  >,
): Promise<Task> {
  return api
    .patch(`/api/tasks/${id}`, patch)
    .then((res) => mapRowToTask(res.data.task as TaskRow));
}

export function addCommentApi(id: string, body: string): Promise<void> {
  return api.post(`/api/tasks/${id}/comments`, { body }).then(() => undefined);
}

export function addSubtaskApi(id: string, text: string): Promise<void> {
  return api.post(`/api/tasks/${id}/subtasks`, { text }).then(() => undefined);
}

export function updateSubtaskApi(
  id: string,
  sid: string,
  patch: { text?: string; done?: boolean },
): Promise<void> {
  return api.patch(`/api/tasks/${id}/subtasks/${sid}`, patch).then(() => undefined);
}

export function deleteSubtaskApi(id: string, sid: string): Promise<void> {
  return api.delete(`/api/tasks/${id}/subtasks/${sid}`).then(() => undefined);
}

export function nudgeApi(id: string): Promise<void> {
  return api.post(`/api/tasks/${id}/nudge`).then(() => undefined);
}

export function deleteTaskApi(id: string): Promise<void> {
  return api.delete(`/api/tasks/${id}`).then(() => undefined);
}

