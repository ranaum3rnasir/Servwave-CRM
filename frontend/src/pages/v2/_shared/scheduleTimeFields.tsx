// The ONE v2 scheduling field set. Every v2 surface that schedules something - the board
// popover, the drop modal, the job form, the lead's walkthrough tab - renders THIS, so
// "when does it start, when does it end" reads the same everywhere: start date, start
// time, end date, end time. Four fields, no duration control; a duration is arithmetic
// the surfaces that STORE one do for themselves at their own seam.
//
// This is the v2 chrome for the same contract `components/schedule/ScheduleTimeFields`
// paints in the legacy token vocabulary. The two share their brain and not their body:
// all the field-moves-field behaviour lives in `scheduleTimeValue`, a pure wall-clock
// arithmetic module with no React and no design system in it, so the DST handling and
// the end-rolls-forward rule cannot drift between v1 and v2. Copying that module here
// is the thing to avoid; importing it is not a cross-module reach (it is app-wide logic,
// like `@/lib/filters`, and this file lives in `_shared`, not in a module folder).
//
// Controlled and computation-free at the edges: it renders `value`, emits the next
// `value`, and never fetches or posts.
import type { ReactNode } from 'react';
import { Label } from '@/ui-kit/components/ui/label';
import { cn } from '@/lib/utils';
import {
  allDayRange,
  isInvertedRange,
  lastDayOf,
  withEndDate,
  withEndTime,
  withStartDate,
  withStartTime,
  type ScheduleTimeValue,
} from '@/components/schedule/scheduleTimeValue';
import { DatePicker } from './datePicker';
import { TimeCombobox } from './timeCombobox';

export interface ScheduleTimeFieldsProps {
  value: ScheduleTimeValue;
  onChange: (next: ScheduleTimeValue) => void;
  disabled?: boolean;
  /** Ring/highlight for the drop modal's auto-filled fields. */
  dateClassName?: string;
  startTimeClassName?: string;
  className?: string;
  /** Prefix for the generated field ids, so two sets can co-exist on one page. */
  idPrefix?: string;
  /**
   * All-day mode: two DATE fields, no times. Both read INCLUSIVE ("Aug 17 to Aug 19" runs through
   * the end of the 19th) - `value` itself keeps the usual exclusive-midnight end underneath,
   * converted at this component's own edge via `allDayRange`/`lastDayOf`, so every other consumer
   * of `value` (the save mutation, isInvertedRange) never has to know all-day mode exists.
   */
  allDay?: boolean;
}

/** Label + control + error text, the a11y contract the kit ships no primitive for. */
function Field({
  label, htmlFor, error, children,
}: {
  label: ReactNode;
  htmlFor: string;
  error?: string;
  children: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor={htmlFor}>{label}</Label>
      {children}
      {error && <p className="text-destructive text-[12px] font-medium">{error}</p>}
    </div>
  );
}

export function ScheduleTimeFields({
  value,
  onChange,
  disabled = false,
  dateClassName,
  startTimeClassName,
  className,
  idPrefix = 'schedule',
  allDay = false,
}: ScheduleTimeFieldsProps) {
  // Only ever shown for an end DATE before the start; an end TIME before the start on
  // the same day rolls the end date forward instead, which is visible in the field.
  const inverted = isInvertedRange(value);

  if (allDay) {
    // '' while the form is still empty - never a day derived from an end that was never set.
    const allDayLastDay = value.endDate ? lastDayOf(value) : '';
    return (
      <div className={cn('grid grid-cols-2 gap-3', className)}>
        <Field label="Start date" htmlFor={`${idPrefix}-start-date`}>
          <DatePicker
            id={`${idPrefix}-start-date`}
            value={value.date}
            onChange={(v) => {
              if (!v) return;
              // Dragging the start past the end takes the end with it, rather than leaving a
              // backwards range the user has to notice and repair.
              const last = lastDayOf(value);
              onChange(allDayRange(v, last && last >= v ? last : v));
            }}
            disabled={disabled}
            className={dateClassName}
          />
        </Field>
        <Field
          label="End date"
          htmlFor={`${idPrefix}-end-date`}
          error={inverted ? 'Ends before it starts' : undefined}
        >
          <DatePicker
            id={`${idPrefix}-end-date`}
            value={allDayLastDay}
            onChange={(v) => { if (v) onChange(allDayRange(value.date || v, v)); }}
            disabled={disabled}
          />
        </Field>
      </div>
    );
  }

  return (
    <div className={cn('grid grid-cols-2 gap-3', className)}>
      <Field label="Start date" htmlFor={`${idPrefix}-start-date`}>
        <DatePicker
          id={`${idPrefix}-start-date`}
          value={value.date}
          onChange={(v) => onChange(withStartDate(value, v))}
          disabled={disabled}
          className={dateClassName}
        />
      </Field>
      <Field label="Start time" htmlFor={`${idPrefix}-start-time`}>
        <TimeCombobox
          id={`${idPrefix}-start-time`}
          value={value.startTime}
          onChange={(v) => onChange(withStartTime(value, v))}
          disabled={disabled}
          className={startTimeClassName}
        />
      </Field>
      <Field
        label="End date"
        htmlFor={`${idPrefix}-end-date`}
        error={inverted ? 'Ends before it starts' : undefined}
      >
        <DatePicker
          id={`${idPrefix}-end-date`}
          value={value.endDate}
          onChange={(v) => onChange(withEndDate(value, v))}
          disabled={disabled}
        />
      </Field>
      <Field label="End time" htmlFor={`${idPrefix}-end-time`}>
        <TimeCombobox
          id={`${idPrefix}-end-time`}
          value={value.endTime}
          onChange={(v) => onChange(withEndTime(value, v))}
          disabled={disabled}
        />
      </Field>
    </div>
  );
}
