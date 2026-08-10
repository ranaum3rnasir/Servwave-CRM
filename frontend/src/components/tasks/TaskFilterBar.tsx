import { useMemo } from 'react';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { X } from 'lucide-react';
import { Checkbox } from '@/components/ui/checkbox';
import { DateRangeFilter } from '@/components/form/DateRangeFilter';
import { useTasksStore } from '@/stores/tasksStore';
import { useTaskFilterStore } from '@/stores/taskFilterStore';
import type { TaskCategory } from '@/lib/tasks/tasks-logic';
import { useAssignableUsers } from '@/lib/api/users';
import { useDepartments } from '@/lib/api/departments';

const CATEGORY_LABEL: Record<Exclude<TaskCategory, 'all'>, string> = {
  open: 'Open',
  atRisk: 'At Risk',
  onTime: 'On-Time',
  blocked: 'Blocked',
};

export default function TaskFilterBar() {
  const {
    memberId, departmentId, tag, category, overdue, atRisk, dueFrom, dueTo, createdFrom, createdTo,
    setMember, setDepartment, setTag, setCategory, setOverdue, setAtRisk, setDueRange, setCreatedRange, reset,
  } = useTaskFilterStore();

  const allTasks = useTasksStore((s) => s.tasks);
  const tags = useMemo(
    () => Array.from(new Set(allTasks.flatMap((t) => t.tags))).sort(),
    [allTasks],
  );

  const { data: people = [] } = useAssignableUsers({ eligibleFor: 'task' });
  const { data: departments = [] } = useDepartments();

  const activeCategory = category ?? 'all';
  const isFiltered = memberId !== 'all' || departmentId !== 'all' || tag !== 'all'
    || activeCategory !== 'all'
    || overdue || atRisk
    || dueFrom !== '' || dueTo !== '' || createdFrom !== '' || createdTo !== '';

  return (
    <div className="flex flex-wrap items-end gap-2">
      {/* Team member */}
      <div className="flex flex-col gap-1">
        <span className="text-[10px] font-semibold uppercase tracking-wide text-text-secondary">
          Member
        </span>
        <Select value={memberId} onValueChange={setMember}>
          {/* text-sm dropped: SelectTrigger's base string carries text-sm
              unconditionally regardless of size. h-9 replaced by size="sm"
              (its own default rung is exactly h-9 - these 3 sites are the
              cited h-9 evidence in select.tsx's own header note). */}
          <SelectTrigger size="sm" className="w-44">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">Everybody</SelectItem>
            {people.map((p) => (
              <SelectItem key={p.id} value={p.id}>
                {p.first_name} {p.last_name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {/* Department */}
      <div className="flex flex-col gap-1">
        <span className="text-[10px] font-semibold uppercase tracking-wide text-text-secondary">
          Department
        </span>
        <Select value={departmentId} onValueChange={setDepartment}>
          {/* text-sm dropped: SelectTrigger's base string carries text-sm
              unconditionally regardless of size. h-9 replaced by size="sm"
              (its own default rung is exactly h-9 - these 3 sites are the
              cited h-9 evidence in select.tsx's own header note). */}
          <SelectTrigger size="sm" className="w-44">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All departments</SelectItem>
            {departments.map((d) => (
              <SelectItem key={d.id} value={d.id}>
                {d.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {/* Tag */}
      <div className="flex flex-col gap-1">
        <span className="text-[10px] font-semibold uppercase tracking-wide text-text-secondary">
          Tag
        </span>
        <Select value={tag} onValueChange={setTag}>
          {/* text-sm dropped: SelectTrigger's base string carries text-sm
              unconditionally regardless of size. h-9 replaced by size="sm"
              (its own default rung is exactly h-9 - these 3 sites are the
              cited h-9 evidence in select.tsx's own header note). */}
          <SelectTrigger size="sm" className="w-44">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All tags</SelectItem>
            {tags.map((t) => (
              <SelectItem key={t} value={t}>
                {t}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {/* Drill-down category pill (set by clicking a Dashboard KPI card) */}
      {activeCategory !== 'all' && (
        // outline/neutral's bg (bg-surface-light) and hover (bg-background-light) both
        // match, but it sets no idle text colour (button.tsx's own trap note) and this
        // pill's ambient wrapper supplies none either - the label would silently go
        // near-black. No matching cell - left raw.
        <button
          type="button"
          onClick={() => setCategory('all')}
          className="flex h-9 items-center gap-1.5 rounded border border-border bg-surface-light px-3 text-xs font-semibold text-text-secondary transition-colors hover:bg-background-light hover:text-text-primary"
        >
          {CATEGORY_LABEL[activeCategory]}
          <X className="h-3.5 w-3.5" />
        </button>
      )}

      {/* Overdue / At risk - not converted to FormField: each label WRAPS a Checkbox + its
          own text, not a caption above the control - outside FormField's shape. */}
      <div className="flex h-9 items-center gap-3">
        <label className="flex items-center gap-2 text-sm text-text-primary">
          <Checkbox checked={overdue} onCheckedChange={(v) => setOverdue(v === true)} />
          Overdue
        </label>
        <label className="flex items-center gap-2 text-sm text-text-primary">
          <Checkbox checked={atRisk} onCheckedChange={(v) => setAtRisk(v === true)} />
          At risk
        </label>
      </div>

      {/* Date ranges */}
      <DateRangeFilter label="Due" from={dueFrom} to={dueTo} onChange={setDueRange} />
      <DateRangeFilter label="Created" from={createdFrom} to={createdTo} onChange={setCreatedRange} />

      {/* Reset */}
      {isFiltered && (
        // Same outline/neutral idle-text trap as the category pill above (no ambient
        // colour source) - left raw.
        <button
          type="button"
          onClick={reset}
          className="h-9 rounded border border-border bg-surface-light px-3 text-xs font-semibold text-text-secondary transition-colors hover:bg-background-light hover:text-text-primary"
        >
          Clear filters
        </button>
      )}
    </div>
  );
}
