import { useMemo } from 'react';
import { X } from 'lucide-react';
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { useAssignableUsers, type AssignableUser } from '@/lib/api/users';

interface MultiAssigneeSelectProps {
  value: string[];
  onChange: (ids: string[]) => void;
  placeholder?: string;
  disabled?: boolean;
  enabled?: boolean;
  eligibleFor?: 'owner' | 'task';
}

interface DeptGroup {
  key: string;
  label: string;
  users: AssignableUser[];
}

function group(users: AssignableUser[]): DeptGroup[] {
  const map = new Map<string, DeptGroup>();
  for (const u of users) {
    const key = u.department?.id ?? '__none__';
    const label = u.department?.name ?? 'No department';
    if (!map.has(key)) map.set(key, { key, label, users: [] });
    map.get(key)!.users.push(u);
  }
  const groups = Array.from(map.values());
  groups.sort((a, b) => {
    if (a.key === '__none__') return 1;
    if (b.key === '__none__') return -1;
    return a.label.localeCompare(b.label);
  });
  return groups;
}

/**
 * Multi-select crew picker. Renders the chosen users as removable chips plus an
 * "add member" combobox over the assignable-users query (the dropdown excludes
 * users already in `value`). REPLACE semantics: `value` is the full crew array.
 */
export function MultiAssigneeSelect({
  value,
  onChange,
  placeholder = 'Add member...',
  disabled,
  enabled = true,
  eligibleFor,
}: MultiAssigneeSelectProps) {
  const { data: users = [] } = useAssignableUsers({ enabled, eligibleFor });

  const byId = useMemo(() => {
    const m = new Map<string, AssignableUser>();
    for (const u of users) m.set(u.id, u);
    return m;
  }, [users]);

  // Dropdown lists only users NOT already selected.
  const available = useMemo(
    () => users.filter((u) => !value.includes(u.id)),
    [users, value],
  );
  const groups = useMemo(() => group(available), [available]);

  const addMember = (id: string) => {
    if (!value.includes(id)) onChange([...value, id]);
  };
  const removeMember = (id: string) => onChange(value.filter((v) => v !== id));

  return (
    <div className="space-y-2">
      {value.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {value.map((id) => {
            const u = byId.get(id);
            const label = u ? `${u.first_name} ${u.last_name}` : 'Unknown';
            return (
              <span
                key={id}
                className="inline-flex items-center gap-1 rounded-full bg-primary-subtle px-2.5 py-1 text-xs font-medium text-primary"
              >
                {label}
                {!disabled && (
                  // Small close-X affordance inside a chip, not Button-shaped - left raw.
                  <button
                    type="button"
                    onClick={() => removeMember(id)}
                    className="rounded-full hover:bg-primary/10"
                    aria-label={`Remove ${label}`}
                  >
                    <X className="h-3 w-3" />
                  </button>
                )}
              </span>
            );
          })}
        </div>
      )}

      <Select
        // Always reset to empty so the trigger keeps showing the placeholder and
        // re-picking the same user fires onValueChange again.
        value=""
        onValueChange={addMember}
        disabled={disabled || available.length === 0}
      >
        <SelectTrigger>
          <SelectValue placeholder={available.length === 0 ? 'No more members' : placeholder} />
        </SelectTrigger>
        <SelectContent>
          {groups.map((g) => (
            <SelectGroup key={g.key}>
              <SelectLabel>{g.label}</SelectLabel>
              {g.users.map((u) => (
                <SelectItem key={u.id} value={u.id}>
                  {u.first_name} {u.last_name}
                </SelectItem>
              ))}
            </SelectGroup>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}
