import { useState } from 'react';
import { Check, ChevronDown, ChevronRight, Plus } from 'lucide-react';

import { Button } from '@/ui-kit/components/ui/button';
import { cn } from '@/ui-kit/lib/utils';
import { groupFields, type FieldGroup } from '@/components/workflows/MergeFieldChips';
import type { WorkflowCatalog } from '@/lib/api/workflows';

/**
 * The tap-to-insert merge-field row, grouped into collapsible per-entity
 * sections so the wall of chips does not grow unbounded as more trigger fields
 * ship.
 *
 * `groupFields` is imported from the legacy component rather than copied. It is
 * the prefix-to-section map plus the canonical group order, it is exported and
 * unit-tested there, and a second copy would silently drift the day a new merge
 * field lands.
 *
 * Each section toggle is named `{label} ({count})`; the existing spec queries
 * those by accessible name.
 */

/** Company, Customer and Recipient ship on every trigger, so they are never a trigger's primary entity. */
const BASE_GROUP_LABELS = new Set(['Company', 'Customer', 'Recipient']);

export interface MergeFieldChipsProps {
  fields: string[];
  used: Set<string>;
  catalog?: WorkflowCatalog;
  onInsert: (field: string) => void;
}

/**
 * Which group starts expanded. Ideally the trigger's primary entity, but the
 * trigger type is not threaded in, so it is approximated: the first non-base
 * group with an already-used field, else the first non-base group outright.
 */
function defaultOpenGroup(groups: FieldGroup[], used: Set<string>): string | undefined {
  const withUsedField = groups.find((g) => !BASE_GROUP_LABELS.has(g.label) && g.fields.some((f) => used.has(f)));
  if (withUsedField) return withUsedField.label;
  return groups.find((g) => !BASE_GROUP_LABELS.has(g.label))?.label ?? groups[0]?.label;
}

export default function MergeFieldChips({ fields, used, catalog, onInsert }: MergeFieldChipsProps) {
  const groups = groupFields(fields);
  const [open, setOpen] = useState<Set<string>>(() => {
    const primary = defaultOpenGroup(groups, used);
    return new Set(primary ? [primary] : []);
  });

  if (fields.length === 0) return null;

  const toggleGroup = (label: string) => {
    setOpen((prev) => {
      const next = new Set(prev);
      if (next.has(label)) next.delete(label);
      else next.add(label);
      return next;
    });
  };

  return (
    <div>
      <p className="text-muted-foreground mb-1.5 text-[11px] font-semibold uppercase tracking-wide">Insert a field</p>
      <div className="space-y-0.5">
        {groups.map((group) => {
          const isOpen = open.has(group.label);
          return (
            <div key={group.label}>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => toggleGroup(group.label)}
                aria-expanded={isOpen}
                aria-label={`${group.label} (${group.fields.length})`}
                className="w-full justify-start gap-1.5 rounded-md px-0.5 text-left"
              >
                {isOpen ? (
                  <ChevronDown className="shrink-0" aria-hidden />
                ) : (
                  <ChevronRight className="shrink-0" aria-hidden />
                )}
                <span className="text-[11px] font-semibold uppercase tracking-wide">{group.label}</span>
                <span className="text-subtle-foreground ml-auto text-[11px] font-medium">{group.fields.length}</span>
              </Button>
              {isOpen && (
                <div className="flex flex-wrap gap-1.5 py-1 pl-4">
                  {group.fields.map((field) => {
                    const label = catalog?.merge_field_labels[field] ?? field;
                    const isUsed = used.has(field);
                    return (
                      <Button
                        key={field}
                        type="button"
                        variant="outline"
                        onClick={() => onInsert(field)}
                        aria-pressed={isUsed}
                        title={`{{${field}}}`}
                        className={cn(
                          'min-h-11 gap-1 rounded-full px-3 text-[12px] font-semibold',
                          isUsed
                            ? 'border-brand bg-brand-subtle text-brand-emphasis'
                            : 'border-input text-muted-foreground hover:border-brand hover:text-foreground',
                        )}
                      >
                        {isUsed ? <Check aria-hidden /> : <Plus aria-hidden />}
                        {label}
                      </Button>
                    );
                  })}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
