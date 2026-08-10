import { useEffect, useRef, useState } from 'react';
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription } from '@/components/ui/sheet';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Button } from '@/components/ui/button';
import { useTaskDetailStore } from '@/stores/taskDetailStore';
import { useTasksStore } from '@/stores/tasksStore';
import { TASK_STATUSES, TASK_PRIORITIES, type TaskStatus, type TaskPriority } from '@/lib/tasks/types';
import { isOverdue, assessRisk } from '@/lib/tasks/tasks-logic';
import { formatExactInstant } from '@/lib/format-date';
import { StatusBadge } from '@/components/data/status-badge';
import { PriorityDot } from './PriorityDot';
import { RiskBadge } from './RiskBadge';
import { LinkedEntityChip } from './LinkedEntityChip';
import { AssigneeSelect } from '@/components/crm/AssigneeSelect';
import { MultiAssigneeSelect } from '@/components/crm/MultiAssigneeSelect';
import { SelectField } from '@/components/form/SelectField';
import { DateTimePicker } from '@/components/form/DateTimePicker';
import { useScheduleTimezone, pickerValueToIso, isoToPickerValue } from '@/lib/schedule-tz';
import { STATUS_REGISTRY } from '@/design-system/status-registry';

const ACTIVITY_LABELS: Record<string, string> = {
  created: 'Created',
  assigned: 'Assigned',
  status_changed: 'Status changed',
  priority_changed: 'Priority changed',
  due_changed: 'Due date changed',
  commented: 'Commented',
  nudged: 'Nudged',
  completed: 'Completed',
};

export function TaskDetailDrawer() {
  // Task due times mean the ORG's clock, never the viewer's browser.
  const timezone = useScheduleTimezone();

  const { openTaskId, close } = useTaskDetailStore();
  const { tasks, updateStatus, updateTask, fetchTaskDetail, addComment, addSubtask, toggleSubtask, deleteSubtask, setWatchers, nudge } = useTasksStore();

  const task = openTaskId ? tasks.find((t) => t.id === openTaskId) ?? null : null;

  // Fetch full detail (subtasks / comments / activity / watchers) whenever the open id changes.
  useEffect(() => {
    if (openTaskId) {
      fetchTaskDetail(openTaskId);
    }
  }, [openTaskId, fetchTaskDetail]);

  // Comment composer state
  const [commentBody, setCommentBody] = useState('');
  const [postingComment, setPostingComment] = useState(false);

  // New subtask input state
  const [subtaskText, setSubtaskText] = useState('');
  const subtaskInputRef = useRef<HTMLInputElement>(null);

  const handlePostComment = async () => {
    const body = commentBody.trim();
    if (!body || !task) return;
    setPostingComment(true);
    try {
      await addComment(task.id, body);
      setCommentBody('');
    } finally {
      setPostingComment(false);
    }
  };

  const handleAddSubtask = async () => {
    const text = subtaskText.trim();
    if (!text || !task) return;
    await addSubtask(task.id, text);
    setSubtaskText('');
  };

  const risk = task
    ? assessRisk(task, { now: new Date(), ownerOpenCount: 0 })
    : { score: 0, reason: null, atRisk: false };

  const overdue = task ? isOverdue(task, new Date()) : false;

  const doneSubs = task ? task.subtasks.filter((s) => s.done).length : 0;
  const totalSubs = task ? task.subtasks.length : 0;

  const sortedActivity = task
    ? [...task.activity].sort((a, b) => new Date(b.at).getTime() - new Date(a.at).getTime())
    : [];

  return (
    <Sheet open={!!task} onOpenChange={(o) => { if (!o) close(); }}>
      <SheetContent
        side="right"
        className="w-[440px] sm:max-w-[440px] flex flex-col p-0 overflow-hidden"
      >
        {task && (
          <>
            {/* Visually-hidden description for a11y */}
            <SheetDescription className="sr-only">
              Task detail for {task.task_number}
            </SheetDescription>

            {/* Header */}
            <div className="px-6 pt-6 pb-4 border-b border-border shrink-0">
              <SheetHeader className="mb-3">
                <p className="text-xs font-mono text-text-secondary mb-1">{task.task_number}</p>
                <SheetTitle asChild>
                  {/* Not converted to Input: styled to read as an editable heading (invisible
                      border until hover/focus), not a text box - Input's own default border/
                      background would visibly box in what is meant to look like a title. */}
                  <input
                    className="text-base font-semibold leading-snug text-text-primary pr-6 bg-transparent border-0 border-b border-transparent hover:border-border focus:border-primary focus:outline-none w-full"
                    defaultValue={task.title}
                    key={task.id + '-title'}
                    onBlur={(e) => {
                      const val = e.currentTarget.value.trim();
                      if (val && val !== task.title) updateTask(task.id, { title: val });
                    }}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') e.currentTarget.blur();
                    }}
                  />
                </SheetTitle>
              </SheetHeader>

              {/* Status + Priority + Risk + Nudge row */}
              <div className="flex items-center gap-2 flex-wrap">
                <StatusBadge domain="task" status={task.status} />
                <PriorityDot priority={task.priority} />
                <RiskBadge result={risk} />
                {/* Bordered chip with an explicit idle text-text-secondary and a two-tone
                    idle-to-hover background swap - outline/neutral's bg (bg-surface-light)
                    and hover (bg-background-light) both differ, and it sets no idle text
                    colour at all (button.tsx's own trap note), so nothing would supply the
                    muted label. No matching cell - left raw. */}
                <button
                  type="button"
                  onClick={() => nudge(task.id)}
                  className="ml-auto inline-flex items-center gap-1 rounded-md border border-border bg-background-light px-2.5 py-1 text-xs font-medium text-text-secondary hover:bg-border hover:text-text-primary transition-colors"
                  aria-label="Nudge assignee"
                >
                  Nudge
                </button>
              </div>
            </div>

            {/* Scrollable body */}
            <div className="flex-1 overflow-y-auto px-6 py-4 space-y-6">

              {/* Quick actions */}
              <section>
                <p className="text-xs font-semibold uppercase tracking-wide text-text-secondary mb-2">
                  Quick actions
                </p>
                <div className="flex items-center gap-2">
                  <Select
                    value={task.status}
                    onValueChange={(val) => updateStatus(task.id, val as TaskStatus)}
                  >
                    <SelectTrigger className="h-8 text-xs w-[160px]">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {TASK_STATUSES.map((s) => (
                        <SelectItem key={s} value={s} className="text-xs">
                          {STATUS_REGISTRY.task[s]?.label ?? s}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <span className="text-xs text-text-secondary">Change status</span>
                </div>
              </section>

              {/* Details grid */}
              <section>
                <p className="text-xs font-semibold uppercase tracking-wide text-text-secondary mb-2">
                  Details
                </p>
                <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-xs">
                  <dt className="text-text-secondary font-medium whitespace-nowrap self-center">Owner</dt>
                  <dd>
                    <AssigneeSelect
                      value={task.owner_id || null}
                      onChange={(id) => updateTask(task.id, { owner_id: id })}
                      placeholder="Unassigned"
                      eligibleFor="task"
                    />
                  </dd>

                  <dt className="text-text-secondary font-medium whitespace-nowrap self-start pt-1">Watchers</dt>
                  <dd>
                    <MultiAssigneeSelect
                      value={task.watcher_ids}
                      onChange={(ids) => setWatchers(task.id, ids)}
                      eligibleFor="task"
                    />
                  </dd>

                  <dt className="text-text-secondary font-medium whitespace-nowrap self-center">Due</dt>
                  <dd className="flex items-center gap-1">
                    <DateTimePicker
                      value={isoToPickerValue(task.due_at, timezone)}
                      onChange={(val) => updateTask(task.id, { due_at: pickerValueToIso(val, timezone) ?? null })}
                      inputClassName="h-7 px-1.5 py-0.5 text-xs"
                    />
                    {overdue && <span className="text-xs text-danger-text font-medium">(overdue)</span>}
                  </dd>

                  <dt className="text-text-secondary font-medium whitespace-nowrap self-center">Priority</dt>
                  <dd>
                    <SelectField
                      className="h-auto text-xs text-text-primary bg-transparent rounded px-1.5 py-0.5 focus:border-primary"
                      value={task.priority}
                      onValueChange={(v) => updateTask(task.id, { priority: v as TaskPriority })}
                      options={TASK_PRIORITIES.map((p) => ({ value: p, label: p.charAt(0) + p.slice(1).toLowerCase() }))}
                    />
                  </dd>

                  <dt className="text-text-secondary font-medium whitespace-nowrap">Linked</dt>
                  <dd>
                    {task.linked_entity
                      ? <LinkedEntityChip entity={task.linked_entity} />
                      : <span className="text-text-secondary">—</span>}
                  </dd>

                  <dt className="text-text-secondary font-medium whitespace-nowrap">Tags</dt>
                  <dd>
                    {task.tags.length > 0 ? (
                      <div className="flex flex-wrap gap-1">
                        {task.tags.map((tag) => (
                          <span
                            key={tag}
                            className="inline-flex items-center rounded-md border border-border bg-background-light px-2 py-0.5 text-xs text-text-secondary"
                          >
                            {tag}
                          </span>
                        ))}
                      </div>
                    ) : (
                      <span className="text-text-secondary">—</span>
                    )}
                  </dd>

                  <dt className="text-text-secondary font-medium whitespace-nowrap">Created by</dt>
                  <dd className="text-text-primary">
                    {task.created_by_name ?? task.created_by}
                    <span className="ml-1 text-text-secondary">· {formatExactInstant(task.created_at)}</span>
                  </dd>

                  <dt className="text-text-secondary font-medium whitespace-nowrap">Completed</dt>
                  <dd className="text-text-primary">
                    {task.completed_at
                      ? formatExactInstant(task.completed_at)
                      : <span className="text-text-secondary">—</span>}
                  </dd>
                </dl>
              </section>

              {/* Description */}
              <section>
                <p className="text-xs font-semibold uppercase tracking-wide text-text-secondary mb-2">
                  Description
                </p>
                <Textarea
                  key={task.id + '-desc'}
                  className="w-full px-2 py-1.5 resize-none min-h-[72px]"
                  defaultValue={task.description}
                  placeholder="Add a description…"
                  rows={3}
                  onBlur={(e) => {
                    const val = e.currentTarget.value;
                    if (val !== task.description) updateTask(task.id, { description: val });
                  }}
                />
              </section>

              {/* Subtasks */}
              <section>
                <div className="flex items-center justify-between mb-2">
                  <p className="text-xs font-semibold uppercase tracking-wide text-text-secondary">
                    Subtasks
                  </p>
                  {totalSubs > 0 && (
                    <span className="text-xs text-text-secondary tabular-nums">
                      {doneSubs}/{totalSubs} done
                    </span>
                  )}
                </div>
                {task.subtasks.length === 0 ? (
                  <p className="text-sm text-text-secondary opacity-60">No subtasks.</p>
                ) : (
                  <ul className="space-y-2 mb-3">
                    {task.subtasks.map((sub) => (
                      <li key={sub.id} className="flex items-center gap-2">
                        <input
                          type="checkbox"
                          checked={sub.done}
                          onChange={() => toggleSubtask(task.id, sub.id, !sub.done)}
                          className="h-4 w-4 rounded border-border accent-primary cursor-pointer"
                        />
                        <span
                          className={
                            sub.done
                              ? 'flex-1 text-sm text-text-secondary line-through'
                              : 'flex-1 text-sm text-text-primary'
                          }
                        >
                          {sub.text}
                        </span>
                        {/* List-row delete-x affordance; its hover token (--danger-text, AA-
                            contrast-tuned) also differs from ghost/danger's --danger, so no
                            cell reproduces it exactly - not Button-shaped, left raw. */}
                        <button
                          type="button"
                          onClick={() => deleteSubtask(task.id, sub.id)}
                          aria-label="Delete subtask"
                          className="shrink-0 text-text-secondary hover:text-danger-text transition-colors px-1"
                        >
                          ×
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
                {/* Add subtask input */}
                <div className="flex items-center gap-2">
                  <Input
                    ref={subtaskInputRef}
                    type="text"
                    value={subtaskText}
                    onChange={(e) => setSubtaskText(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') {
                        e.preventDefault();
                        handleAddSubtask();
                      }
                    }}
                    placeholder="Add subtask…"
                    className="flex-1 px-2 py-1"
                  />
                  {/* solid/brand matches the bg-primary fill and text-on-fill label.
                      Two disclosed, not-restored deltas: the raw's text-xs font-medium
                      becomes the primitive's base font-semibold (bolder), and its
                      hover:bg-primary/90 becomes solid/brand's own hover:bg-primary-dark
                      (a different token, close but not identical). No exact size match
                      either: original px-2 py-1 text-xs had no explicit height - nearest
                      rung is 3xs (h-6/px-2/text-xs). */}
                  <Button
                    type="button"
                    onClick={handleAddSubtask}
                    disabled={!subtaskText.trim()}
                    aria-label="Add subtask"
                    size="3xs"
                    className="shrink-0"
                  >
                    Add subtask
                  </Button>
                </div>
              </section>

              {/* Activity / History */}
              <section>
                <p className="text-xs font-semibold uppercase tracking-wide text-text-secondary mb-2">
                  Activity
                </p>
                {sortedActivity.length === 0 && task.comments.length === 0 ? (
                  <p className="text-sm text-text-secondary opacity-60">No activity yet.</p>
                ) : (
                  <ol className="space-y-3">
                    {sortedActivity.map((entry) => (
                      <li key={entry.id} className="flex items-start gap-2 text-xs">
                        <span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-text-secondary opacity-60" />
                        <div className="min-w-0">
                          <span className="font-medium text-text-primary">
                            {ACTIVITY_LABELS[entry.type] ?? entry.type}
                          </span>
                          {' '}
                          <span className="text-text-secondary">
                            by {entry.actor_name ?? entry.actor_id}
                          </span>
                          <span className="block text-text-secondary opacity-60 mt-0.5">
                            {new Date(entry.at).toLocaleString('en-US', {
                              month: 'short', day: 'numeric', year: 'numeric',
                              hour: 'numeric', minute: '2-digit',
                            })}
                          </span>
                        </div>
                      </li>
                    ))}
                  </ol>
                )}

                {/* Comments */}
                {task.comments.length > 0 && (
                  <div className="mt-4 space-y-3 border-t border-border pt-4">
                    <p className="text-xs font-semibold uppercase tracking-wide text-text-secondary mb-2">
                      Comments
                    </p>
                    {task.comments.map((c) => (
                      <div key={c.id} className="rounded-lg border border-border bg-background-light p-3 text-xs">
                        <div className="flex items-center justify-between mb-1">
                          <span className="font-medium text-text-primary">{c.author_name ?? c.author_id}</span>
                          <span className="text-text-secondary opacity-60">
                            {new Date(c.at).toLocaleString('en-US', {
                              month: 'short', day: 'numeric',
                              hour: 'numeric', minute: '2-digit',
                            })}
                          </span>
                        </div>
                        <p className="text-text-primary leading-relaxed">{c.body}</p>
                      </div>
                    ))}
                  </div>
                )}

                {/* Comment composer */}
                <div className="mt-4 border-t border-border pt-4">
                  <p className="text-xs font-semibold uppercase tracking-wide text-text-secondary mb-2">
                    Add comment
                  </p>
                  <Textarea
                    value={commentBody}
                    onChange={(e) => setCommentBody(e.target.value)}
                    placeholder="Add a comment…"
                    rows={3}
                    className="w-full px-2 py-1.5 resize-none mb-2"
                  />
                  {/* solid/brand matches the bg-primary fill and text-on-fill label.
                      Two disclosed, not-restored deltas: the raw's text-xs font-medium
                      becomes the primitive's base font-semibold (bolder), and its
                      hover:bg-primary/90 becomes solid/brand's own hover:bg-primary-dark
                      (a different token, close but not identical). No exact size match
                      either: original px-3 py-1.5 had no explicit height - nearest
                      rung is 3xs (h-6/px-2/text-xs). */}
                  <Button
                    type="button"
                    onClick={handlePostComment}
                    disabled={!commentBody.trim() || postingComment}
                    size="3xs"
                  >
                    {postingComment ? 'Posting…' : 'Post'}
                  </Button>
                </div>
              </section>
            </div>
          </>
        )}
      </SheetContent>
    </Sheet>
  );
}
