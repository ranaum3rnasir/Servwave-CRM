import { useMemo } from 'react';
import { useTasksStore } from '@/stores/tasksStore';
import { useTaskFilterStore } from '@/stores/taskFilterStore';
import { applyTaskFilter } from './tasks-logic';
import { useAssignableUsers } from '@/lib/api/users';
import { useAuthStore } from '@/stores/auth.store';

/**
 * `scopeToSelf` narrows the result to tasks the signed-in user is actually on - assignee or
 * watcher. It exists for the Board.
 *
 * The API already scopes this way for everyone EXCEPT an ADMIN, whose `taskVisibilityWhere`
 * short-circuits to the whole org (design section 4). That is right for the List, which is the
 * management surface, and wrong for the Board, which is a personal work surface: an admin in a
 * real org would open it onto every task the company has.
 *
 * An explicit member filter WINS over it. Otherwise the member filter would be dead chrome on
 * the Board - the one tab where "show me Dana's board" is a reasonable thing to ask - and the
 * filter bar is shared by every tab, so it cannot simply be hidden there.
 */
export function useFilteredTasks(options?: { applyCategory?: boolean; scopeToSelf?: boolean }) {
  const tasks = useTasksStore((s) => s.tasks);
  const memberId = useTaskFilterStore((s) => s.memberId);
  const departmentId = useTaskFilterStore((s) => s.departmentId);
  const tag = useTaskFilterStore((s) => s.tag);
  const category = useTaskFilterStore((s) => s.category);
  const overdue = useTaskFilterStore((s) => s.overdue);
  const atRisk = useTaskFilterStore((s) => s.atRisk);
  const dueFrom = useTaskFilterStore((s) => s.dueFrom);
  const dueTo = useTaskFilterStore((s) => s.dueTo);
  const createdFrom = useTaskFilterStore((s) => s.createdFrom);
  const createdTo = useTaskFilterStore((s) => s.createdTo);
  const { data: rawUsers = [] } = useAssignableUsers({ eligibleFor: 'task' });

  const currentUserId = useAuthStore((s) => s.user?.id) ?? '';

  const now = useMemo(() => new Date(), []);
  const applyCategory = options?.applyCategory !== false;
  const scopeToSelf = options?.scopeToSelf === true;

  const people = useMemo(
    () => rawUsers.map((u) => ({
      id: u.id,
      name: `${u.first_name} ${u.last_name}`,
      role: u.role.toLowerCase(),
      department: u.department?.id ?? '',
    })),
    [rawUsers],
  );

  return useMemo(
    () => {
      const filtered = applyTaskFilter(
        tasks,
        {
          memberId, departmentId, tag,
          category: applyCategory ? category ?? 'all' : 'all',
          overdue, atRisk, dueFrom, dueTo, createdFrom, createdTo,
        },
        people,
        now,
      );
      // The filter store's "no filter" sentinel is the STRING 'all', not null or '' - a plain
      // truthiness test here would read the default as an active member filter and disable the
      // self-scope entirely. A real member filter means the user asked for somebody in
      // particular, and wins.
      //
      // No `currentUserId` means auth has not resolved yet; narrowing to nobody would flash an
      // empty board, so leave the list alone and let the next render scope it.
      if (!scopeToSelf || (memberId && memberId !== 'all') || !currentUserId) return filtered;
      return filtered.filter(
        (t) => t.assignee_ids.includes(currentUserId) || t.watcher_ids.includes(currentUserId),
      );
    },
    [tasks, memberId, departmentId, tag, category, applyCategory, overdue, atRisk, dueFrom, dueTo, createdFrom, createdTo, people, now, scopeToSelf, currentUserId],
  );
}
