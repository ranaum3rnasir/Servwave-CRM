import { useMemo } from 'react';

import { useTasksStore } from '@/stores/tasksStore';
import { useTaskFilterStore } from '@/stores/taskFilterStore';
import type { TaskCategory } from '@/lib/tasks/tasks-logic';
import { useAssignableUsers } from '@/lib/api/users';
import { useDepartments } from '@/lib/api/departments';
import { formatDayLabel } from '@/lib/date-range';

import { FilterBar, type ActiveFilter } from '@/ui-kit/components/crm/filterBar';

import { TaskFilterPopover, type FilterOption } from './filterPopover';

const CATEGORY_LABEL: Record<Exclude<TaskCategory, 'all'>, string> = {
  open: 'Open',
  atRisk: 'At Risk',
  onTime: 'On-Time',
  blocked: 'Blocked',
};

function dateChipText(from: string, to: string): string {
  if (from && to) return `${formatDayLabel(from)} - ${formatDayLabel(to)}`;
  if (from) return `From ${formatDayLabel(from)}`;
  return `Until ${formatDayLabel(to)}`;
}

function labelFor(options: FilterOption[], value: string): string {
  return options.find((o) => o.value === value)?.label ?? value;
}

/**
 * The Tasks filter toolbar, in two halves that render in two places.
 *
 * The six controls used to sit in an always-visible grid inside a bordered card
 * that also held an AI command bar. The command bar is gone and the grid moved
 * into a filter WINDOW (`./filterPopover`), so what was left was a toolbar row:
 * the Filter trigger, and one removable chip per active constraint.
 *
 * That row then held a full line of its own ABOVE the tabs to carry a single
 * button, and pushed every view down the screen for it. So the halves split:
 * the trigger rides the tab strip's right slot, and the chips render under the
 * strip and only when there ARE chips. With no filters active the hub costs
 * nothing between the page header and the view.
 *
 * The chips are the reason a window is safe. A closed panel is the most common
 * way a CRM lies to someone - a stale member filter, and they swear a task has
 * vanished - so every active constraint stays visible and individually
 * removable OUTSIDE the popover, each naming its own field. That is exactly
 * what the kit's `crm/FilterBar` renders, and it is the primitive
 * `_shared/appliedFilters` is itself built on; the `_shared` wrapper is not
 * reused directly because it is registry-driven (`FacetConfig[]` +
 * `FilterState`) and the Tasks filter is a plain zustand store - the same
 * mismatch that made the popover a module-local fork. Sitting on the kit
 * primitive instead of forking the wrapper keeps the chips identical to the
 * ones Leads shows without an adapter in between.
 *
 * Every control still writes `stores/taskFilterStore`, which is module-level,
 * so a filter survives a tab switch. All six views read it through
 * `useFilteredTasks`, so this toolbar scopes every tab - unchanged.
 *
 * The tag options are the sorted distinct union of tags across the UNFILTERED
 * store list, so narrowing by tag never removes the other tags from the menu.
 */
function useTaskFilterModel() {
  const {
    memberId, departmentId, tag, category, overdue, atRisk,
    dueFrom, dueTo, createdFrom, createdTo,
    setMember, setDepartment, setTag, setCategory, setOverdue, setAtRisk,
    setDueRange, setCreatedRange, reset,
  } = useTaskFilterStore();

  const allTasks = useTasksStore((s) => s.tasks);
  const { data: people = [] } = useAssignableUsers({ eligibleFor: 'task' });
  const { data: departments = [] } = useDepartments();

  // Resolved here rather than inside the popover so the menu and the chip that
  // reports it read off ONE list - a chip that falls back to a raw uuid is the
  // classic symptom of two option sources drifting apart.
  const memberOptions = useMemo<FilterOption[]>(
    () => people.map((p) => ({ value: p.id, label: `${p.first_name} ${p.last_name}` })),
    [people],
  );
  const departmentOptions = useMemo<FilterOption[]>(
    () => departments.map((d) => ({ value: d.id, label: d.name })),
    [departments],
  );
  const tagOptions = useMemo<FilterOption[]>(
    () => Array.from(new Set(allTasks.flatMap((t) => t.tags))).sort().map((t) => ({ value: t, label: t })),
    [allTasks],
  );

  const activeCategory = category ?? 'all';

  const chips: ActiveFilter[] = [];
  if (memberId !== 'all') {
    chips.push({ id: 'member', label: 'Member', value: labelFor(memberOptions, memberId) });
  }
  if (departmentId !== 'all') {
    chips.push({ id: 'department', label: 'Department', value: labelFor(departmentOptions, departmentId) });
  }
  if (tag !== 'all') {
    chips.push({ id: 'tag', label: 'Tag', value: tag });
  }
  if (dueFrom || dueTo) {
    chips.push({ id: 'due', label: 'Due', value: dateChipText(dueFrom, dueTo) });
  }
  if (createdFrom || createdTo) {
    chips.push({ id: 'created', label: 'Created', value: dateChipText(createdFrom, createdTo) });
  }
  if (overdue) chips.push({ id: 'overdue', label: 'Only show', value: 'Overdue' });
  if (atRisk) chips.push({ id: 'atRisk', label: 'Only show', value: 'At risk' });
  // The drill-down set by clicking a Dashboard KPI card. It is a chip like any
  // other so it can be dropped without going back to the Dashboard for it.
  if (activeCategory !== 'all') {
    chips.push({ id: 'category', label: 'Category', value: CATEGORY_LABEL[activeCategory] });
  }

  const remove = (id: string) => {
    switch (id) {
      case 'member': setMember('all'); break;
      case 'department': setDepartment('all'); break;
      case 'tag': setTag('all'); break;
      case 'due': setDueRange({ from: '', to: '' }); break;
      case 'created': setCreatedRange({ from: '', to: '' }); break;
      case 'overdue': setOverdue(false); break;
      case 'atRisk': setAtRisk(false); break;
      case 'category': setCategory('all'); break;
    }
  };

  return { memberOptions, departmentOptions, tagOptions, chips, remove, reset };
}

/**
 * The Filter trigger alone, for the tab strip's right slot.
 *
 * Both halves call `useTaskFilterModel`, and two instances cannot drift: the
 * options come from the same two react-query caches and the constraints from
 * the same module-level zustand store, so they are two readers of one state.
 */
export function TaskFilterTrigger() {
  const { memberOptions, departmentOptions, tagOptions } = useTaskFilterModel();
  return (
    <TaskFilterPopover
      members={memberOptions}
      departments={departmentOptions}
      tags={tagOptions}
    />
  );
}

/**
 * The active constraints, under the strip. Renders nothing when there are none
 * - an empty chip rail is exactly the blank band this split exists to remove.
 */
export function TaskFilterChips() {
  const { chips, remove, reset } = useTaskFilterModel();
  if (chips.length === 0) return null;
  // `gap-0`: FilterBar stacks a controls row over the chips row, and this half
  // passes no controls, so the gap would be measured against an empty div.
  return <FilterBar className="mt-3 gap-0" filters={chips} onRemove={remove} onClearAll={reset} />;
}
