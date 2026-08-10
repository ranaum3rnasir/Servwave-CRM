import { X } from 'lucide-react';

import { DatePicker } from '@/components/form/DatePicker';
import { TimeCombobox } from '@/components/form/TimeCombobox';
import { localDateToIsoDay } from '@/lib/date-input';
import { cn } from '@/lib/utils';

interface DateTimePickerProps {
  /** '' or 'YYYY-MM-DDTHH:MM' (local) — same contract as <input type="datetime-local">. */
  value: string;
  onChange: (v: string) => void;
  stepMinutes?: number;
  disabled?: boolean;
  className?: string;
  /** Overrides both sub-fields' own geometry (height/padding/font) for compact call
   *  sites - see DatePicker's identical prop for why this can't just be `className`. */
  inputClassName?: string;
}

/**
 * In-DOM date+time picker for use INSIDE modal Radix dialogs (#430).
 *
 * Native datetime-local popups render in the BROWSER's locale (often DD/MM/YYYY) and are
 * OS-level widgets that a modal Radix Dialog's dismissable-layer regime cannot close — the
 * picker gets orphaned on screen. Composes two typeable fields (DatePicker + TimeCombobox),
 * each a portaled Radix Popover that participates in the dialog's layer stack instead, so
 * outside-click / Escape dismiss deterministically while the dialog stays open. Time
 * choices are generated every `stepMinutes` (default 15 — #416), but typed off-grid times
 * are accepted too.
 */
export function DateTimePicker({
  value,
  onChange,
  stepMinutes = 15,
  disabled,
  className,
  inputClassName,
}: DateTimePickerProps) {
  const datePart = value ? value.slice(0, 10) : '';
  const timePart = value ? value.slice(11, 16) : '';

  function handleDateChange(d: string) {
    onChange(d ? `${d}T${timePart || '09:00'}` : '');
  }

  function handleTimeChange(t: string) {
    if (!t) {
      onChange('');
      return;
    }
    onChange(`${datePart || localDateToIsoDay(new Date())}T${t}`);
  }

  return (
    <div className={cn('flex items-stretch gap-2', className)}>
      <DatePicker
        value={datePart}
        onChange={handleDateChange}
        disabled={disabled}
        className="flex-[3]"
        inputClassName={inputClassName}
      />
      <TimeCombobox
        value={timePart}
        onChange={handleTimeChange}
        stepMinutes={stepMinutes}
        disabled={disabled}
        className="flex-[2]"
        inputClassName={inputClassName}
      />
      {value && (
        <button
          type="button"
          disabled={disabled}
          aria-label="Clear date and time"
          onClick={() => onChange('')}
          className="flex shrink-0 items-center justify-center self-stretch rounded-lg border border-border px-2 text-text-secondary hover:bg-primary-subtle hover:text-text-primary disabled:pointer-events-none disabled:opacity-50"
        >
          <X className="size-4" />
        </button>
      )}
    </div>
  );
}
