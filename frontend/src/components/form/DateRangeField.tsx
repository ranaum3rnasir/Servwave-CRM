import { useState, useEffect } from 'react';
import { SelectField } from '@/components/form/SelectField';
import { DatePicker } from '@/components/form/DatePicker';
import {
  todayDay,
  daysAgoDay,
  startOfWeekDay,
  startOfMonthDay,
  endOfMonthDay,
  startOfYearDay,
} from '@/lib/date-range';

export interface DateRangeFieldProps {
  /** Optional label, used only for aria — the surrounding FilterSection shows the visible title. */
  label?: string;
  from: string; // 'YYYY-MM-DD' | ''
  to: string;   // 'YYYY-MM-DD' | ''
  onChange: (next: { from: string; to: string }) => void;
}

interface Preset {
  key: string;
  label: string;
  range: () => { from: string; to: string };
}

// Presets compute concrete {from,to} day-strings; the underlying state contract
// (two 'YYYY-MM-DD' strings) is unchanged, so API params + active-filter chips stay identical.
const PRESETS: Preset[] = [
  { key: 'any', label: 'Any time', range: () => ({ from: '', to: '' }) },
  { key: 'today', label: 'Today', range: () => ({ from: todayDay(), to: todayDay() }) },
  { key: 'week', label: 'This week', range: () => ({ from: startOfWeekDay(), to: todayDay() }) },
  { key: 'month', label: 'This month', range: () => ({ from: startOfMonthDay(), to: endOfMonthDay() }) },
  { key: 'last7', label: 'Last 7 days', range: () => ({ from: daysAgoDay(6), to: todayDay() }) },
  { key: 'last30', label: 'Last 30 days', range: () => ({ from: daysAgoDay(29), to: todayDay() }) },
  { key: 'last90', label: 'Last 90 days', range: () => ({ from: daysAgoDay(89), to: todayDay() }) },
  { key: 'year', label: 'This year', range: () => ({ from: startOfYearDay(), to: todayDay() }) },
];

/** Which preset (if any) the current {from,to} exactly matches; else 'custom'/'any'. */
function matchPreset(from: string, to: string): string {
  for (const p of PRESETS) {
    const r = p.range();
    if (r.from === from && r.to === to) return p.key;
  }
  return from || to ? 'custom' : 'any';
}

/**
 * Preset-driven date-range picker for use inside the Filter popover. Replaces the
 * dual native date inputs with a presets dropdown (Today / This week / This month /
 * Last 7-90 / This year / Custom); "Custom…" reveals the two native date inputs.
 */
export function DateRangeField({ label, from, to, onChange }: DateRangeFieldProps) {
  // customMode is sticky: picking "Custom…" must not snap back to a preset that
  // happens to match the typed dates (e.g. today–today === "Today"). Reset when
  // both bounds are cleared (e.g. via "Clear all").
  const [customMode, setCustomMode] = useState(() => matchPreset(from, to) === 'custom');
  useEffect(() => {
    if (!from && !to) setCustomMode(false);
  }, [from, to]);

  const selected = customMode ? 'custom' : matchPreset(from, to);

  const handleSelect = (key: string) => {
    if (key === 'custom') {
      setCustomMode(true); // reveal inputs, keep any existing dates
      return;
    }
    setCustomMode(false);
    const preset = PRESETS.find((p) => p.key === key);
    if (preset) onChange(preset.range());
  };

  return (
    <div className="space-y-2">
      <SelectField
        value={selected}
        onValueChange={handleSelect}
        className="h-9 w-full text-sm text-text-primary focus:border-primary/40 focus:ring-2 focus:ring-primary/10"
        aria-label={label ? `${label} range` : 'Date range'}
        options={[...PRESETS.map((p) => ({ value: p.key, label: p.label })), { value: 'custom', label: 'Custom…' }]}
      />
      {selected === 'custom' && (
        <div className="flex items-center gap-2">
          <DatePicker
            value={from} max={to || undefined}
            onChange={(v) => onChange({ from: v, to })}
            inputClassName="h-9" aria-label={label ? `${label} from` : 'From'}
          />
          <span className="text-text-secondary">–</span>
          <DatePicker
            value={to} min={from || undefined}
            onChange={(v) => onChange({ from, to: v })}
            inputClassName="h-9" aria-label={label ? `${label} to` : 'To'}
          />
        </div>
      )}
    </div>
  );
}
