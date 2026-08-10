import { cn, getInitials } from '@/lib/utils';
import { CheckCircle2, Circle } from 'lucide-react';
import { formatExactInstant } from '@/lib/format-date';
import type { Task, TaskStatus } from '@/lib/tasks/types';
import { isOverdue, assessRisk } from '@/lib/tasks/tasks-logic';
import type { RiskResult } from '@/lib/tasks/tasks-logic';
import { useTaskDetailStore } from '@/stores/taskDetailStore';
import { StatusBadge } from '@/components/data/status-badge';
import { PriorityDot } from './PriorityDot';
import { RiskBadge } from './RiskBadge';
import { LinkedEntityChip } from './LinkedEntityChip';

interface TaskCardProps {
  task: Task;
  /** When provided, a quick-complete toggle is shown that flips DONE/TODO. */
  onStatusChange?: (status: TaskStatus) => void;
  ownerOpenCount?: number;
  riskResult?: RiskResult;
  /** Suppress the linked-entity chip (redundant on a per-entity tab). */
  hideLinkedEntity?: boolean;
}

export function TaskCard({
  task,
  onStatusChange,
  ownerOpenCount = 0,
  riskResult,
  hideLinkedEntity = false,
}: TaskCardProps) {
  const now = new Date();
  const overdue = isOverdue(task, now);
  const risk = riskResult ?? assessRisk(task, { now, ownerOpenCount });
  const open = useTaskDetailStore((s) => s.open);
  const done = task.status === 'DONE';
  const ownerName = task.owner_name ?? '';
  const initials = ownerName ? getInitials(ownerName) : '';

  return (
    <div
      className={cn(
        'flex cursor-pointer flex-col gap-2 rounded-xl border border-border bg-surface-light p-4 shadow-card transition hover:shadow-md',
        done && 'opacity-70'
      )}
      onClick={() => open(task.id)}
    >
      {/* Title row (with optional quick-complete) */}
      <div className="flex items-start gap-2">
        {onStatusChange && (
          // Bespoke idle-muted/hover-to-sage-green quick-complete toggle - no minted
          // ghost cell reproduces that hover-to-brand-tone signal, not Button-shaped.
          <button
            type="button"
            aria-label={done ? 'Mark task as to-do' : 'Mark task done'}
            onClick={(e) => {
              e.stopPropagation();
              onStatusChange(done ? 'TODO' : 'DONE');
            }}
            className="mt-0.5 shrink-0 text-text-secondary/50 transition-colors hover:text-sage-700"
          >
            {done ? <CheckCircle2 className="h-4 w-4 text-sage-700" /> : <Circle className="h-4 w-4" />}
          </button>
        )}
        <p className={cn('text-sm font-medium leading-snug', done && 'text-text-secondary line-through')}>
          {task.title}
        </p>
      </div>

      {/* Status + Priority row */}
      <div className="flex flex-wrap items-center gap-2">
        <StatusBadge domain="task" status={task.status} />
        <PriorityDot priority={task.priority} />
      </div>

      {/* Owner */}
      {ownerName ? (
        <div className="flex items-center gap-1.5 text-xs text-text-secondary">
          <span className="flex h-5 w-5 items-center justify-center rounded-full bg-primary-subtle text-[9px] font-bold text-primary">
            {initials}
          </span>
          <span className="font-medium text-text-primary">{ownerName}</span>
        </div>
      ) : (
        <p className="text-xs italic text-text-secondary/70">Unassigned</p>
      )}

      {/* Due date */}
      {task.due_at ? (
        <p className={cn('text-xs', overdue ? 'font-medium text-danger' : 'text-text-secondary')}>
          {overdue ? 'Overdue · ' : 'Due · '}
          {formatExactInstant(task.due_at)}
        </p>
      ) : (
        <p className="text-xs text-text-secondary opacity-50">No due date</p>
      )}

      {/* Linked entity */}
      {!hideLinkedEntity && <LinkedEntityChip entity={task.linked_entity} />}

      {/* Risk badge */}
      <RiskBadge result={risk} />
    </div>
  );
}
