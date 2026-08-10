import { useMemo, useState } from 'react';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/empty-state';
import { cn } from '@/lib/utils';
import { Check, ChevronDown } from 'lucide-react';
import { useAssignableUsers, type AssignableUser } from '@/lib/api/users';
import { useScrollLockEscape } from '@/hooks/useScrollLockEscape';

interface AssigneeSelectProps {
  value: string | null;
  onChange: (id: string) => void;
  placeholder?: string;
  disabled?: boolean;
  enabled?: boolean;
  eligibleFor?: 'owner' | 'task' | 'dispatcher';
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

export function AssigneeSelect({
  value,
  onChange,
  placeholder = 'Select assignee...',
  disabled,
  enabled = true,
  eligibleFor,
}: AssigneeSelectProps) {
  const { data: users = [] } = useAssignableUsers({ enabled, eligibleFor });
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const selected = useMemo(() => users.find((u) => u.id === value) ?? null, [users, value]);
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return q ? users.filter((u) => `${u.first_name} ${u.last_name}`.toLowerCase().includes(q)) : users;
  }, [users, query]);
  const groups = useMemo(() => group(filtered), [filtered]);

  // This list is portalled outside any surrounding Dialog's scroll lock, which
  // would otherwise swallow its wheel/touch events - see the hook.
  const attachScrollLockEscape = useScrollLockEscape();

  return (
    <Popover open={open} onOpenChange={(o) => { setOpen(o); if (!o) setQuery(''); }}>
      <PopoverTrigger asChild>
        {/* outline/neutral matches border+bg exactly (bg-surface-light). The button itself
            carried no explicit idle text colour (the inner span supplies its own
            conditional text-text-secondary for the placeholder state) - no outline/
            neutral idle-text trap here. h-10/px-3 is within default size's h-10/px-4;
            font-normal mirrors the identical combobox-trigger pattern already on
            CustomerPickerWithCreate.tsx:201 in this same batch. */}
        <Button
          type="button"
          role="combobox"
          aria-expanded={open}
          disabled={disabled}
          variant="outline"
          className="w-full justify-between font-normal"
        >
          <span className={cn('line-clamp-1', !selected && 'text-text-secondary')}>
            {selected ? `${selected.first_name} ${selected.last_name}` : placeholder}
          </span>
          <ChevronDown className="h-4 w-4 opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-[var(--radix-popover-trigger-width)] p-0">
        <div className="border-b border-border p-1">
          <Input
            autoFocus
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search…"
            // Deferred: this is a fully borderless/ringless search field (blends into
            // the popover's own bordered wrapper above). Input's `tone`/`invalid` props
            // only ever ADD a border colour, never remove the border/ring entirely - no
            // shipped prop reproduces "no border, no ring" here.
            className="h-8 border-0 focus-visible:ring-0"
          />
        </div>
        <div ref={attachScrollLockEscape} data-testid="assignee-options" className="max-h-60 overflow-y-auto overscroll-contain p-1">
          {groups.length === 0 ? (
            <EmptyState density="compact" title="No users found" />
          ) : (
            groups.map((g) => (
              <div key={g.key}>
                <div className="px-2 py-1.5 text-xs font-semibold text-text-secondary">{g.label}</div>
                {g.users.map((u) => (
                  // Dropdown-menu-item option row (role="option"), not Button-shaped - left raw.
                  <button
                    key={u.id}
                    type="button"
                    role="option"
                    aria-selected={u.id === value}
                    onClick={() => { onChange(u.id); setOpen(false); setQuery(''); }}
                    className={cn(
                      'flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-sm hover:bg-background-light',
                      u.id === value && 'bg-primary-subtle text-primary'
                    )}
                  >
                    <Check className={cn('h-3.5 w-3.5 shrink-0', u.id === value ? 'opacity-100' : 'opacity-0')} />
                    {u.first_name} {u.last_name}
                  </button>
                ))}
              </div>
            ))
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}
