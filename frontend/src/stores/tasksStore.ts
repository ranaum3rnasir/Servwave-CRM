import { create } from 'zustand';
import type { Task, TaskStatus } from '@/lib/tasks/types';
import {
  listTasks,
  createTask,
  updateTaskApi,
  deleteTaskApi,
  getTask,
  addCommentApi,
  addSubtaskApi,
  updateSubtaskApi,
  deleteSubtaskApi,
  nudgeApi,
  type CreateTaskInput,
} from '@/lib/api/tasks';
import { toast } from '@/components/ui/use-toast';

interface TasksState {
  tasks: Task[];
  loaded: boolean;
  loading: boolean;
  fetchTasks: () => Promise<void>;
  fetchTaskDetail: (id: string) => Promise<void>;
  addTask: (input: CreateTaskInput) => Promise<Task>;
  updateStatus: (id: string, status: TaskStatus) => Promise<void>;
  updateTask: (id: string, patch: Partial<Task>) => Promise<void>;
  reschedule: (id: string, due_at: string) => Promise<void>;
  deleteTask: (id: string) => Promise<void>;
  addComment: (id: string, body: string) => Promise<void>;
  addSubtask: (id: string, text: string) => Promise<void>;
  toggleSubtask: (id: string, sid: string, done: boolean) => Promise<void>;
  deleteSubtask: (id: string, sid: string) => Promise<void>;
  setWatchers: (id: string, ids: string[]) => Promise<void>;
  nudge: (id: string) => Promise<void>;
}

export const useTasksStore = create<TasksState>()((set, get) => ({
  tasks: [],
  loaded: false,
  loading: false,

  fetchTasks: async () => {
    // Dedup concurrent mounts: skip if already in-flight or hydrated
    if (get().loading || get().loaded) return;
    set({ loading: true });
    try {
      const tasks = await listTasks();
      set({ tasks, loaded: true });
    } finally {
      set({ loading: false });
    }
  },

  fetchTaskDetail: async (id: string) => {
    const full = await getTask(id);
    set((s) => {
      const exists = s.tasks.some((t) => t.id === id);
      return { tasks: exists ? s.tasks.map((t) => (t.id === id ? full : t)) : [...s.tasks, full] };
    });
  },

  addTask: async (input: CreateTaskInput) => {
    const t = await createTask(input);
    set((s) => ({ tasks: [t, ...s.tasks] }));
    return t;
  },

  updateStatus: async (id, status) => {
    const t = await updateTaskApi(id, { status });
    set((s) => ({
      tasks: s.tasks.map((x) => (x.id === id ? t : x)),
    }));
  },

  updateTask: async (id, patch) => {
    // Only send API-supported scalar fields; ignore client-only fields (subtasks, etc.)
    const apiPatch: Parameters<typeof updateTaskApi>[1] = {};
    if (patch.title !== undefined) apiPatch.title = patch.title;
    if (patch.description !== undefined) apiPatch.description = patch.description;
    if (patch.status !== undefined) apiPatch.status = patch.status;
    if (patch.priority !== undefined) apiPatch.priority = patch.priority;
    if (patch.owner_id !== undefined) apiPatch.owner_id = patch.owner_id;
    if (patch.due_at !== undefined) apiPatch.due_at = patch.due_at;
    if (patch.tags !== undefined) apiPatch.tags = patch.tags;

    const serverRow = await updateTaskApi(id, apiPatch);
    // Re-merge any client-only keys so the UI doesn't lose them
    set((s) => ({
      tasks: s.tasks.map((x) =>
        x.id === id
          ? {
              ...serverRow,
              ...pick(patch, ['subtasks', 'activity', 'comments', 'ai', 'watcher_ids']),
            }
          : x,
      ),
    }));
  },

  reschedule: async (id, due_at) => {
    const prev = get().tasks.find((t) => t.id === id);
    if (!prev) return;
    const prevDueAt = prev.due_at;
    // Optimistic: move the chip to the new day immediately so the calendar re-renders.
    set((s) => ({ tasks: s.tasks.map((t) => (t.id === id ? { ...t, due_at } : t)) }));
    try {
      const serverRow = await updateTaskApi(id, { due_at });
      // Reconcile with the server row; re-apply client-only keys the list-row mapper drops.
      set((s) => ({
        tasks: s.tasks.map((t) =>
          t.id === id
            ? { ...serverRow, ...pick(t, ['subtasks', 'activity', 'comments', 'ai', 'watcher_ids']) }
            : t,
        ),
      }));
    } catch {
      // Rollback to the pre-drag due_at and notify.
      set((s) => ({ tasks: s.tasks.map((t) => (t.id === id ? { ...t, due_at: prevDueAt } : t)) }));
      toast({
        title: 'Reschedule failed',
        description: 'Could not move the task. Please try again.',
        variant: 'destructive',
      });
    }
  },

  deleteTask: async (id) => {
    await deleteTaskApi(id);
    set((s) => ({ tasks: s.tasks.filter((x) => x.id !== id) }));
  },

  addComment: async (id, body) => {
    await addCommentApi(id, body);
    await get().fetchTaskDetail(id);
  },

  addSubtask: async (id, text) => {
    await addSubtaskApi(id, text);
    await get().fetchTaskDetail(id);
  },

  toggleSubtask: async (id, sid, done) => {
    await updateSubtaskApi(id, sid, { done });
    await get().fetchTaskDetail(id);
  },

  deleteSubtask: async (id, sid) => {
    await deleteSubtaskApi(id, sid);
    await get().fetchTaskDetail(id);
  },

  setWatchers: async (id, ids) => {
    await updateTaskApi(id, { watcher_ids: ids });
    await get().fetchTaskDetail(id);
  },

  nudge: async (id) => {
    await nudgeApi(id);
    await get().fetchTaskDetail(id);
  },
}));

// Helper: pick a subset of keys from an object (avoids a lodash dep)
function pick<T extends object, K extends keyof T>(obj: T, keys: K[]): Pick<T, K> {
  const result = {} as Pick<T, K>;
  for (const k of keys) {
    if (k in obj) result[k] = obj[k];
  }
  return result;
}
