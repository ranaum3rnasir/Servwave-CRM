import { useMemo } from 'react';
import { useTasksStore } from '@/stores/tasksStore';
import { useTaskFilterStore } from '@/stores/taskFilterStore';
import { applyTaskFilter } from './tasks-logic';
import { useAssignableUsers } from '@/lib/api/users';

export function useFilteredTasks(options?: { applyCategory?: boolean }) {
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

  const now = useMemo(() => new Date(), []);
  const applyCategory = options?.applyCategory !== false;

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
    () => applyTaskFilter(
      tasks,
      {
        memberId, departmentId, tag,
        category: applyCategory ? category ?? 'all' : 'all',
        overdue, atRisk, dueFrom, dueTo, createdFrom, createdTo,
      },
      people,
      now,
    ),
    [tasks, memberId, departmentId, tag, category, applyCategory, overdue, atRisk, dueFrom, dueTo, createdFrom, createdTo, people, now],
  );
}
