import { useMemo } from 'react';

import { useFilteredTasks } from '@/lib/tasks/useFilteredTasks';
import { isOverdue } from '@/lib/tasks/tasks-logic';
import { isTerminalTaskStatus } from '@/lib/tasks/types';
import { taskAI } from '@/lib/tasks/taskAI';
import { useAuthStore } from '@/stores/auth.store';
import { useTaskDetailStore } from '@/stores/taskDetailStore';

import { Badge } from '@/ui-kit/components/ui/badge';
import { Card } from '@/ui-kit/components/ui/card';

import { PriorityDot } from '../components/atoms';

/**
 * The UTC calendar day a task is due on, or null.
 *
 * UTC, like every other date in this module: a due date is stored as a day, not
 * an instant, and reading it in the browser's zone moves a task to the previous
 * day for anyone west of Greenwich.
 */
function dueDay(dueAt: string | null | undefined): string | null {
  return dueAt ? dueAt.slice(0, 10) : null;
}

/**
 * My Day - what is actually on the plate today, and nothing else.
 *
 * WHAT THIS TAB USED TO BE: a "Your day, planned" header with a Plan my day
 * button, a Suggested tasks panel, and then the list. The button made no
 * network call and fetched nothing - it bumped a nonce so the ranking memo
 * recomputed against a fresh `new Date()` and raised a toast. Since the list
 * already recomputes whenever the task store changes, the button's whole
 * observable effect was the toast, and the panel above it was demo content
 * wired to nothing. Both are gone; the tab opens straight onto the work.
 *
 * WHAT COUNTS AS TODAY. A task due today, and a task already overdue and still
 * open. The second is the load-bearing half: an overdue task is on your plate
 * today by definition, and a "today" list that hides it is how things stay
 * overdue. Anything due later is deliberately absent - that is what the List
 * and Calendar tabs are for.
 *
 * ORDER is `rankMyDay`'s, not due date: the ranking already weighs priority,
 * age and ownership, and re-sorting the survivors by date would throw that away.
 */
export default function MyDayView() {
  const tasks = useFilteredTasks();
  const open = useTaskDetailStore((s) => s.open);
  const currentUserId = useAuthStore((s) => s.user?.id) ?? '';

  const today = useMemo(() => {
    const now = new Date();
    // The same UTC day the due dates are expressed in.
    return new Date(Date.UTC(now.getFullYear(), now.getMonth(), now.getDate()))
      .toISOString()
      .slice(0, 10);
  }, []);

  const todays = useMemo(() => {
    const ranked = taskAI.rankMyDay(tasks, currentUserId, new Date());
    return ranked.filter((task) => {
      if (isTerminalTaskStatus(task.status)) return false;
      const day = dueDay(task.due_at);
      // No due date at all is not "today" - it is unscheduled work, and it
      // belongs on the List tab where it can be triaged.
      return day !== null && day <= today;
    });
  }, [tasks, currentUserId, today]);

  return (
    <Card data-testid="my-day-surface" className="overflow-hidden">
      {todays.length === 0 ? (
        <p className="text-subtle-foreground py-10 text-center text-[13px]">
          Nothing due today.
        </p>
      ) : (
        <ol className="divide-input divide-y">
          {todays.map((t, idx) => {
            const overdue = isOverdue(t, new Date());
            return (
              <li
                key={t.id}
                className="hover:bg-muted flex cursor-pointer items-start gap-4 px-5 py-4 transition-colors"
                onClick={() => open(t.id)}
              >
                <span className="bg-muted text-muted-foreground grid size-7 shrink-0 place-items-center rounded-full text-[12px] font-bold tabular-nums">
                  {idx + 1}
                </span>

                <div className="flex min-w-0 flex-1 flex-col gap-1">
                  <p className="text-[13px] font-medium leading-snug">{t.title}</p>
                  <div className="flex flex-wrap items-center gap-2">
                    <PriorityDot priority={t.priority} />
                    {t.due_at && (
                      <Badge variant={overdue ? 'softRed' : 'outline'} size="sm">
                        {overdue ? 'Overdue · ' : 'Due · '}
                        {new Intl.DateTimeFormat('en-US', {
                          month: 'short',
                          day: 'numeric',
                          timeZone: 'UTC',
                        }).format(new Date(t.due_at))}
                      </Badge>
                    )}
                  </div>
                </div>
              </li>
            );
          })}
        </ol>
      )}
    </Card>
  );
}
