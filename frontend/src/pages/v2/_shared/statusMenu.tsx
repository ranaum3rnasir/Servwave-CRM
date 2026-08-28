import { Check, ChevronDown } from 'lucide-react';

import { STATUS_REGISTRY, type StatusDomain } from '@/design-system/status-registry';

import { cn } from '@/ui-kit/lib/utils';
import { Button } from '@/ui-kit/components/ui/button';
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger,
} from '@/ui-kit/components/ui/dropdownMenu';

import { statusVariantFor } from './statusChip';

/**
 * The dot that stands in for the chip inside the menu.
 *
 * One class per variant, written out in full rather than composed from the
 * variant name, because Tailwind scans source TEXT: a class assembled at
 * runtime from a template literal never appears in the source, so no rule is
 * ever generated for it and the dot renders transparent.
 */
const DOT: Record<ReturnType<typeof statusVariantFor>, string> = {
  green: 'bg-status-green',
  amber: 'bg-status-amber',
  red: 'bg-status-red',
  blue: 'bg-status-blue',
  slate: 'bg-status-slate',
  purple: 'bg-status-purple',
};

export interface StatusMenuProps {
  domain: StatusDomain;
  /** The record's current status. */
  value: string;
  /** Everything it can be set to, in lifecycle order. */
  options: readonly string[];
  onValueChange: (status: string) => void;
  disabled?: boolean;
  /** Announced on the trigger, e.g. "Lead status". */
  label: string;
  className?: string;
}

/**
 * Change a record's status, from its detail page.
 *
 * WHY THIS IS NOT A ROW OF CHIPS. The previous control put the status chip
 * inside an outline Button and then listed the other statuses as bare chips,
 * one per menu row. Every row was therefore a saturated solid fill - six loud
 * pills stacked in a panel twice their width, left-aligned in all that space,
 * with the current one indistinguishable from the rest except by reading the
 * words. The chip is a good way to show ONE status on a dense row; it is a bad
 * way to show six at once, because a chip earns its colour by being the only
 * one in view.
 *
 * So the menu drops to a dot plus a label - the colour still carries the
 * lifecycle stage, at a weight that lets six of them sit together - and the
 * CURRENT value is marked by a check, which is what a picker is supposed to do
 * and what the chip list never did.
 *
 * The trigger keeps the dot and reads as a control: a bordered, chevroned
 * button sized like every other control on the header row, rather than a badge
 * with a chevron bolted to its side.
 *
 * Disabled loses the chevron AND the border, so a status the user cannot change
 * reads as a label. The kit's Button already greys a disabled control; what it
 * cannot know is that here there is nothing to click at all.
 */
export function StatusMenu({
  domain, value, options, onValueChange, disabled = false, label, className,
}: StatusMenuProps) {
  const entry = STATUS_REGISTRY[domain][value] ?? { label: value, intent: 'neutral' as const };
  const variant = statusVariantFor(domain, value);

  if (disabled) {
    return (
      <span
        className={cn(
          'border-input text-foreground inline-flex h-8.5 items-center gap-2 rounded-md border border-dashed px-3 text-[13px] font-semibold',
          className,
        )}
      >
        <span className={cn('size-2 shrink-0 rounded-full', DOT[variant])} aria-hidden />
        <span className="sr-only">{label}: </span>
        {entry.label}
      </span>
    );
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="outline" size="sm" aria-label={`${label}: ${entry.label}`} className={className}>
          <span className={cn('size-2 shrink-0 rounded-full', DOT[variant])} aria-hidden />
          {entry.label}
          <ChevronDown className="text-subtle-foreground" />
        </Button>
      </DropdownMenuTrigger>

      {/* Width matched to the longest label rather than left at the menu's
          default, so the check column lines up and the panel is not three times
          the width of its contents. */}
      <DropdownMenuContent align="start" className="w-56">
        {options.map((option) => {
          const optionEntry = STATUS_REGISTRY[domain][option] ?? { label: option, intent: 'neutral' as const };
          const isCurrent = option === value;
          return (
            <DropdownMenuItem
              key={option}
              onClick={() => onValueChange(option)}
              className={cn('gap-2.5', isCurrent && 'font-semibold')}
            >
              <span
                className={cn('size-2 shrink-0 rounded-full', DOT[statusVariantFor(domain, option)])}
                aria-hidden
              />
              <span className="flex-1">{optionEntry.label}</span>
              {isCurrent && <Check className="text-brand size-4 shrink-0" aria-label="current" />}
            </DropdownMenuItem>
          );
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
