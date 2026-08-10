export type TaskStatus = 'TODO' | 'IN_PROGRESS' | 'BLOCKED' | 'DONE';
export type TaskPriority = 'LOW' | 'MEDIUM' | 'HIGH' | 'URGENT';
export type LinkedEntityType = 'JOB' | 'LEAD' | 'CUSTOMER' | 'ESTIMATE';

export const TASK_STATUSES: TaskStatus[] = ['TODO', 'IN_PROGRESS', 'BLOCKED', 'DONE'];
export const TASK_PRIORITIES: TaskPriority[] = ['LOW', 'MEDIUM', 'HIGH', 'URGENT'];

export interface LinkedEntity {
  type: LinkedEntityType;
  id: string;
  label: string;
}

export interface Subtask {
  id: string;
  text: string;
  done: boolean;
}

export interface TaskActivity {
  id: string;
  type: 'created' | 'assigned' | 'status_changed' | 'priority_changed' | 'due_changed' | 'commented' | 'nudged' | 'completed';
  actor_id: string;
  at: string; // ISO
  meta?: Record<string, string>;
  description?: string;
  actor_name?: string | null;
}

export interface TaskComment {
  id: string;
  author_id: string;
  body: string;
  at: string; // ISO
  author_name?: string | null;
}

export type TaskSource = 'manual' | 'ai_nl' | 'ai_template' | 'ai_extract';

export interface TaskAI {
  risk_score: number;        // 0–100
  risk_reason: string | null;
  suggested_by: string | null;
  source: TaskSource;
}

export interface Task {
  id: string;
  task_number: string;       // e.g. "T00001"
  title: string;
  description: string;
  status: TaskStatus;
  priority: TaskPriority;
  owner_id: string;
  owner_name?: string | null;
  watcher_ids: string[];
  watchers?: { id: string; name: string }[];
  due_at: string | null;     // ISO
  linked_entity: LinkedEntity | null;
  tags: string[];
  subtasks: Subtask[];
  created_by: string;
  created_by_name?: string | null;
  created_at: string;        // ISO
  updated_at: string;        // ISO
  completed_at: string | null;
  activity: TaskActivity[];
  comments: TaskComment[];
  ai: TaskAI;
}

/** A reference person the NL parser and assignee suggester match against. */
export interface TaskPerson {
  id: string;
  name: string;
  role: string;
  department: string;
}
