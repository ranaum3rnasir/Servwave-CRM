import { HelpCircle, Check } from 'lucide-react';

import { Button } from '@/ui-kit/components/ui/button';
import { Popover, PopoverTrigger, PopoverContent } from '@/ui-kit/components/ui/popover';
import { Separator } from '@/ui-kit/components/ui/separator';

import { EVENT_TYPE_META, type EventType } from '@/components/schedule/scheduleModel';

interface SettingsGearDropdownProps {
  roleFilter: string;
  onRoleFilterChange: (value: string) => void;
  isGroupedView: boolean;
}

/**
 * THE LEGEND SWATCHES ARE NOT CHROME. Read this before re-tokening them.
 *
 * Each swatch is a KEY to a colour react-big-calendar is actually painting, and
 * those colours come from `eventStyleGetter` in the page - which is calendar
 * behaviour and a no-touch boundary for this migration. The page paints
 * job = `!bg-info/10 !border-l-info`, walkthrough = `!bg-warning/10
 * !border-l-warning`, needs-crew = `!bg-danger`, double-booked =
 * `!bg-surface-light !border-danger`, completed = `!bg-text-soft`. So the
 * swatches below stay on those exact tokens. Swapping them for the kit's
 * `status-*` family would leave the legend describing colours that are not on
 * the board - a legend that lies is worse than no legend.
 *
 * Everything else in this file IS chrome and did move: the trigger is a kit
 * Button, the panel is the kit Popover, the section rule is a kit Separator, and
 * the staff-filter rows are kit Buttons instead of raw button elements.
 */

// Literal class names, not template fragments - Tailwind's JIT cannot expand a
// dynamic class. Labels come from the shared META so the legend and the board
// can never disagree about what a type is called.
const TYPE_SWATCH: Record<EventType, string> = {
  job: 'bg-info',
  walkthrough: 'bg-warning',
  'service-plan': 'bg-ai',
  'calendar-entry': 'bg-event', // Slice 03 - "Event"; same muted accent eventStyleGetter paints
};
const EVENT_TYPES: EventType[] = ['job', 'walkthrough', 'service-plan', 'calendar-entry'];

const STAFF_FILTERS = [
  { label: 'All Staff', value: 'all' },
  { label: 'Technicians', value: 'TECHNICIAN' },
  { label: 'Sales', value: 'SALES' },
] as const;

const sectionHeaderClass =
  'text-[10px] font-semibold text-muted-foreground tracking-wider uppercase mb-2';

export function SettingsGearDropdown({
  roleFilter,
  onRoleFilterChange,
  isGroupedView,
}: SettingsGearDropdownProps) {
  return (
    <Popover>
      <PopoverTrigger asChild>
        {/* A question mark, not a gear. What opens below is a KEY to the
            board's colours - it explains, it does not configure - and a gear
            promised settings this panel never held.

            The legacy trigger was raw because the OLD outline cell carried an
            idle surface fill this control did not want. The kit's outline does
            the same thing, so this uses `ghost` with a hairline instead - idle
            border, fill only on hover, which is the treatment the original was
            reaching for. */}
        <Button variant="ghost" size="icon-sm" className="border" aria-label="Schedule legend">
          <HelpCircle />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-64 p-0" align="end">
        {/* Legend */}
        <div className="px-4 py-3">
          <p className={sectionHeaderClass}>Legend</p>
          <div className="space-y-1.5">
            {/* Event-type accents (the left bar on a calendar event) */}
            {EVENT_TYPES.map((t) => (
              <div key={t} className="flex items-center gap-2">
                <span className={`h-4 w-1.5 rounded-sm flex-shrink-0 ${TYPE_SWATCH[t]}`} />
                <span className="text-xs">{EVENT_TYPE_META[t].label}</span>
              </div>
            ))}
            {/* The two reds: needs-crew is a FILL, double-booked is an OUTLINE */}
            <div className="flex items-center gap-2">
              <span className="h-4 w-4 rounded-sm flex-shrink-0 bg-danger" />
              <span className="text-xs">Needs crew (unstaffed)</span>
            </div>
            <div className="flex items-center gap-2">
              <span className="h-4 w-4 rounded-sm flex-shrink-0 border-2 border-danger bg-surface-light" />
              <span className="text-xs">Double-booked</span>
            </div>
            {/* Terminal */}
            <div className="flex items-center gap-2">
              <span className="h-4 w-4 rounded-sm flex-shrink-0 bg-text-soft" />
              <span className="text-xs">Completed</span>
            </div>
          </div>
        </div>

        {/* Staff Filter - grouped (member) view only */}
        {isGroupedView && (
          <>
            <Separator />
            <div className="px-4 py-3">
              <p className={sectionHeaderClass}>Staff Filter</p>
              <div className="space-y-0.5" role="group" aria-label="Staff filter">
                {STAFF_FILTERS.map(({ label, value }) => {
                  const isActive = roleFilter === value;
                  return (
                    <Button
                      key={value}
                      variant={isActive ? 'secondary' : 'ghost'}
                      size="sm"
                      aria-pressed={isActive}
                      className="h-auto w-full justify-between px-2 py-1.5 text-xs"
                      onClick={() => onRoleFilterChange(value)}
                    >
                      <span>{label}</span>
                      {isActive && <Check />}
                    </Button>
                  );
                })}
              </div>
            </div>
          </>
        )}
      </PopoverContent>
    </Popover>
  );
}
