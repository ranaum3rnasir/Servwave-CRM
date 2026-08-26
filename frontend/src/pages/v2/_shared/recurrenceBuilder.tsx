import type { IntervalUnit } from '@/lib/api/service-plans';
import type { EndMode, RecurrenceValue } from '@/components/service-plans/RecurrenceBuilder';

import { Button } from '@/ui-kit/components/ui/button';
import { Input } from '@/ui-kit/components/ui/input';
import { Label } from '@/ui-kit/components/ui/label';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/ui-kit/components/ui/select';

import { DatePicker } from './datePicker';

/**
 * The Google-Calendar-style recurrence editor, repainted on the kit.
 *
 * Only the surface is new. The value type, the default value and
 * `recurrenceToPayload` all still live in
 * `@/components/service-plans/RecurrenceBuilder` and are imported by the
 * builder dialog - that reducer is pure, unit-tested and shared with the legacy
 * page, so forking it here would be forking business logic.
 *
 * Every `aria-label` below is byte-identical to the legacy component's. They
 * are this control's entire selector surface (it has no data-testid at all), so
 * they are the contract, not decoration.
 *
 * TWO CONTROLS CHANGED SHAPE, both because the kit ships no primitive for them
 * and the design system's raw-tag ratchet forbids adding new bare markup:
 *
 *  - the weekday chips were raw round `<button>`s; they are kit Buttons now,
 *    still `aria-pressed` toggles with the same full-day-name labels;
 *  - "Ends" was a native radio group; it is a `role="radiogroup"` of kit
 *    Buttons carrying `role="radio"` + `aria-checked`, with the same three
 *    accessible names and the same "the paired input is disabled, not hidden"
 *    rule.
 */

const UNIT_OPTIONS: { value: IntervalUnit; label: string }[] = [
  { value: 'DAY', label: 'days' },
  { value: 'WEEK', label: 'weeks' },
  { value: 'MONTH', label: 'months' },
  { value: 'YEAR', label: 'years' },
];

// 0=Sun..6=Sat (matches the API byweekday convention). Sunday-first like Google's US layout.
const WEEKDAY_CHIPS: { d: number; short: string; name: string }[] = [
  { d: 0, short: 'S', name: 'Sunday' },
  { d: 1, short: 'M', name: 'Monday' },
  { d: 2, short: 'T', name: 'Tuesday' },
  { d: 3, short: 'W', name: 'Wednesday' },
  { d: 4, short: 'T', name: 'Thursday' },
  { d: 5, short: 'F', name: 'Friday' },
  { d: 6, short: 'S', name: 'Saturday' },
];

const END_MODES: { mode: EndMode; label: string; ariaLabel: string }[] = [
  { mode: 'never', label: 'Never', ariaLabel: 'Never ends' },
  { mode: 'on', label: 'On', ariaLabel: 'Ends on a date' },
  { mode: 'after', label: 'After', ariaLabel: 'Ends after a number of occurrences' },
];

function RecurrenceBuilder({
  value, onChange,
}: {
  value: RecurrenceValue;
  onChange: (v: RecurrenceValue) => void;
}) {
  const set = (patch: Partial<RecurrenceValue>) => onChange({ ...value, ...patch });
  const toggleDay = (d: number) =>
    set({
      byweekday: value.byweekday.includes(d)
        ? value.byweekday.filter((x) => x !== d)
        : [...value.byweekday, d].sort((a, b) => a - b),
    });

  const endModeButton = (mode: EndMode) => {
    const entry = END_MODES.find((e) => e.mode === mode)!;
    return (
      <Button
        role="radio"
        aria-checked={value.end_mode === mode}
        aria-label={entry.ariaLabel}
        variant={value.end_mode === mode ? 'default' : 'outline'}
        size="sm"
        onClick={() => set({ end_mode: mode })}
      >
        {entry.label}
      </Button>
    );
  };

  // Two columns so the card fills the dialog's width: "how often" on the left
  // (with the weekday chips for weekly), "when it ends" on the right. Stacks to
  // one column on narrow screens.
  return (
    <div className="rounded-lg border p-4">
      <div className="grid grid-cols-1 gap-x-6 gap-y-4 sm:grid-cols-2">
        {/* Left: how often it repeats (+ which weekdays, for weekly) */}
        <div className="flex flex-col gap-3">
          <div>
            {/* Heads a compound control (Input + Select), so it is a plain Label
                with no htmlFor rather than a single-control field. */}
            <Label>Repeats every</Label>
            <div className="mt-1 flex items-center gap-2">
              <Input
                type="number"
                min={1}
                value={value.interval_count}
                onChange={(e) => set({ interval_count: Math.max(1, Number(e.target.value) || 1) })}
                className="w-20"
                aria-label="Interval count"
              />
              <Select value={value.interval_unit} onValueChange={(v) => set({ interval_unit: v as IntervalUnit })}>
                <SelectTrigger className="flex-1" aria-label="Interval unit">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {UNIT_OPTIONS.map((u) => (
                    <SelectItem key={u.value} value={u.value}>{u.label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          {/* Weekday chips - weekly only, exactly as today. */}
          {value.interval_unit === 'WEEK' && (
            <div>
              <Label>Repeat on</Label>
              <div className="mt-1 flex flex-wrap gap-1">
                {WEEKDAY_CHIPS.map((c) => (
                  <Button
                    key={c.d}
                    size="icon-sm"
                    variant={value.byweekday.includes(c.d) ? 'default' : 'secondary'}
                    aria-pressed={value.byweekday.includes(c.d)}
                    aria-label={c.name}
                    onClick={() => toggleDay(c.d)}
                  >
                    {c.short}
                  </Button>
                ))}
              </div>
            </div>
          )}
        </div>

        {/* Right: when it ends */}
        <div>
          <Label id="v2-recurrence-ends-label">Ends</Label>
          <div role="radiogroup" aria-labelledby="v2-recurrence-ends-label" className="mt-1 flex flex-col gap-2">
            <div className="flex items-center gap-2">{endModeButton('never')}</div>
            <div className="flex items-center gap-2">
              {endModeButton('on')}
              <DatePicker
                value={value.end_date}
                disabled={value.end_mode !== 'on'}
                onChange={(v) => set({ end_date: v })}
                className="min-w-0 flex-1"
                aria-label="End date"
              />
            </div>
            <div className="flex items-center gap-2">
              {endModeButton('after')}
              <Input
                type="number"
                min={1}
                value={value.occurrence_count}
                disabled={value.end_mode !== 'after'}
                onChange={(e) => set({ occurrence_count: Math.max(1, Number(e.target.value) || 1) })}
                className="w-16"
                aria-label="Occurrence count"
              />
              <span className="text-muted-foreground shrink-0 text-sm">occurrences</span>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

export { RecurrenceBuilder };
