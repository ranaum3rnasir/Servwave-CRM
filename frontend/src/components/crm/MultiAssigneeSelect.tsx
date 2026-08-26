import { useMemo, useState } from 'react';
import { AlertTriangle, X } from 'lucide-react';
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
  /**
   * Forwarded to the trigger so a caller's <Label htmlFor> actually names this control. Optional
   * and additive: every existing call site keeps its current markup, and this one is SHARED by
   * two routed surfaces, so it must not change for them.
   */
  id?: string;
  /**
   * Advisory marking (#05). Ids listed here render a marker on their chip and on their dropdown
   * row; `flagNote` is the single explanation shown under the control, and is the only place the
   * reason is spelled out. Purely presentational and deliberately so - this component knows
   * nothing about WHY a candidate is flagged, and a flagged candidate stays selectable,
   * removable and never disabled. Both default to nothing, so every existing call site is
   * unchanged. Ignored entirely when the control itself is `disabled` - see the note below.
   */
  flaggedIds?: string[];
  flagNote?: string | null;
  flagBadge?: string;
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
 *
 * `flaggedIds`/`flagNote` add an advisory marking on top of that without narrowing it - see the
 * prop docs.
 */
export function MultiAssigneeSelect({
  value,
  onChange,
  placeholder = 'Add member...',
  disabled,
  enabled = true,
  eligibleFor,
  id,
  flaggedIds,
  flagNote,
  flagBadge = 'No access',
}: MultiAssigneeSelectProps) {
  const { data: users = [] } = useAssignableUsers({ enabled, eligibleFor });

  const [menuOpen, setMenuOpen] = useState(false);

  // A control the user cannot change carries no advisory marking. `disabled` is how the task
  // surfaces render the assignee picker for someone without the `assign` grant, and an amber
  // warning about a choice that control will not let them make is pure noise. Enforced here
  // rather than at each call site so a fifth surface cannot forget it.
  const flagged = useMemo(
    () => (disabled ? new Set<string>() : new Set(flaggedIds ?? [])),
    [disabled, flaggedIds],
  );

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

  /**
   * The note appears when it is about to matter: this picker already HOLDS a flagged person, or
   * the dropdown is open on one.
   *
   * Testing the whole assignable roster instead is what the first cut did, and it is worse than
   * useless. TECHNICIAN holds no `read Customer`, so on a technician-heavy org every
   * CUSTOMER-linked task carried this sentence permanently, on every surface, whether or not the
   * user had gone anywhere near a flagged person. A warning that is always on screen is one
   * people learn to stop reading, which costs attention on every unrelated task.
   *
   * The per-control duplication is deliberate and stays: a picker showing amber pills with no
   * sentence is a puzzle. Under this condition the two copies will rarely be on screen together.
   */
  const showNote = useMemo(
    () =>
      Boolean(flagNote) &&
      (value.some((v) => flagged.has(v)) || (menuOpen && available.some((u) => flagged.has(u.id)))),
    [flagNote, value, flagged, menuOpen, available],
  );

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
            const isFlagged = flagged.has(id);
            return (
              <span
                key={id}
                className={
                  isFlagged
                    ? 'inline-flex items-center gap-1 rounded-full bg-warning-surface px-2.5 py-1 text-xs font-medium text-warning-text'
                    : 'inline-flex items-center gap-1 rounded-full bg-primary-subtle px-2.5 py-1 text-xs font-medium text-primary'
                }
              >
                {label}
                {isFlagged && (
                  // whitespace-nowrap: the chip's label is the flexible part. Without it a long
                  // name pushes the marker to the chip's second line and breaks it across
                  // "No" / "access" - measured at the drawer's 440px in QA.
                  <span
                    className="inline-flex shrink-0 items-center gap-0.5 whitespace-nowrap"
                    title={flagNote ?? undefined}
                  >
                    <AlertTriangle aria-hidden="true" className="h-3 w-3" />
                    {flagBadge}
                  </span>
                )}
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
        // Uncontrolled still - this only OBSERVES the open state, for `showNote` above. Passing
        // `open` as well would make every call site's dropdown this component's business.
        onOpenChange={setMenuOpen}
        disabled={disabled || available.length === 0}
      >
        <SelectTrigger id={id}>
          <SelectValue placeholder={available.length === 0 ? 'No more members' : placeholder} />
        </SelectTrigger>
        <SelectContent>
          {groups.map((g) => (
            <SelectGroup key={g.key}>
              <SelectLabel>{g.label}</SelectLabel>
              {g.users.map((u) => (
                <SelectItem key={u.id} value={u.id}>
                  {u.first_name} {u.last_name}
                  {flagged.has(u.id) && (
                    <span
                      className="ml-1.5 inline-flex shrink-0 items-center gap-0.5 whitespace-nowrap rounded-full bg-warning-surface px-1.5 py-0.5 text-[11px] font-medium text-warning-text"
                      title={flagNote ?? undefined}
                    >
                      <AlertTriangle aria-hidden="true" className="h-3 w-3" />
                      {flagBadge}
                    </span>
                  )}
                </SelectItem>
              ))}
            </SelectGroup>
          ))}
        </SelectContent>
      </Select>

      {showNote && (
        <p className="flex items-start gap-1 text-xs text-warning-text">
          <AlertTriangle aria-hidden="true" className="mt-0.5 h-3 w-3 shrink-0" />
          <span>{flagNote}</span>
        </p>
      )}
    </div>
  );
}
