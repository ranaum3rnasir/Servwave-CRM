import { useMemo } from 'react';
import { format } from 'date-fns';

import { cn } from '@/ui-kit/lib/utils';

import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/ui-kit/components/ui/select';

interface TimeSelectProps {
  /** 'HH:MM' (24-hour) or '' - same string contract as <input type="time">. */
  value: string;
  onChange: (v: string) => void;
  stepMinutes?: number;
  /** Sizing at the call site. The default 140px suits a form, not a popup. */
  className?: string;
  /**
   * Keep-out margin for the open list, in px, passed straight to Radix. A form
   * wants the default (the viewport edge); a trigger sitting ON a page whose
   * top is its own chrome - the schedule's toolbar and day header - wants that
   * chrome named as the boundary, so a list that flips upward stops beneath it
   * instead of painting over it. Radix folds this into
   * `--radix-select-content-available-height`, so the list caps and scrolls
   * rather than being clipped, and flips to the other side when the padded
   * space runs out.
   */
  collisionPadding?: number | Partial<Record<'top' | 'right' | 'bottom' | 'left', number>>;
}

/**
 * v2 port of `components/form/TimeSelect`: a 15-minute grid across the day with
 * `h:mm a` labels, an empty sentinel of `NONE`, and an off-grid saved value
 * prepended so it stays selected. Value contract unchanged.
 *
 * SHARED, not leads-local, since the schedule's quick-create card needs it too.
 * That card used to reach for the LEGACY `components/form/TimeSelect`, whose
 * portalled list paints at z-50 while the card itself sits above that - so the
 * list opened behind the card that opened it and the times could not be read.
 * The kit's Select paints on the `floating` layer, above every page surface by
 * construction. See the zIndex scale in tailwind.config.js.
 */
export function TimeSelect({
  value, onChange, stepMinutes = 15, className, collisionPadding,
}: TimeSelectProps) {
  const timeOptions = useMemo(() => {
    const opts: { value: string; label: string }[] = [];
    for (let m = 0; m < 24 * 60; m += stepMinutes) {
      const hh = String(Math.floor(m / 60)).padStart(2, '0');
      const mm = String(m % 60).padStart(2, '0');
      opts.push({
        value: `${hh}:${mm}`,
        label: format(new Date(2000, 0, 1, Math.floor(m / 60), m % 60), 'h:mm a'),
      });
    }
    return opts;
  }, [stepMinutes]);

  const options =
    value && !timeOptions.some((o) => o.value === value)
      ? [{ value, label: format(new Date(`2000-01-01T${value}`), 'h:mm a') }, ...timeOptions]
      : timeOptions;

  return (
    <Select value={value || 'NONE'} onValueChange={(v) => onChange(v === 'NONE' ? '' : v)}>
      <SelectTrigger className={cn('w-[140px]', className)}>
        <SelectValue />
      </SelectTrigger>
      <SelectContent collisionPadding={collisionPadding}>
        <SelectItem value="NONE">Select time…</SelectItem>
        {options.map((o) => (
          <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
