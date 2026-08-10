// Date helpers shared by every list page's date filter.
// Controls deal in native 'YYYY-MM-DD' strings; the API wants ISO at day boundaries.

import { getOrgDateFormat } from './org-format';

function toDayString(dt: Date): string {
  const y = dt.getFullYear();
  const m = String(dt.getMonth() + 1).padStart(2, '0');
  const d = String(dt.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/** 'YYYY-MM-DD' → ISO at local start of day (00:00:00). '' → undefined. */
export function dayStartISO(d: string): string | undefined {
  if (!d) return undefined;
  return new Date(`${d}T00:00:00`).toISOString();
}

/** 'YYYY-MM-DD' → ISO at local end of day (23:59:59.999). '' → undefined. */
export function dayEndISO(d: string): string | undefined {
  if (!d) return undefined;
  return new Date(`${d}T23:59:59.999`).toISOString();
}

/** Local start-of-week (Sunday), matching the backend new_this_week stat. */
export function startOfWeekDay(): string {
  const now = new Date();
  const d = new Date(now);
  d.setDate(now.getDate() - now.getDay());
  return toDayString(d);
}

/** Local start-of-month. */
export function startOfMonthDay(): string {
  const now = new Date();
  return toDayString(new Date(now.getFullYear(), now.getMonth(), 1));
}

/** Local last day of current month as 'YYYY-MM-DD'. */
export function endOfMonthDay(): string {
  const now = new Date();
  return toDayString(new Date(now.getFullYear(), now.getMonth() + 1, 0));
}

/** Today as 'YYYY-MM-DD' (local). */
export function todayDay(): string {
  return toDayString(new Date());
}

/** N days before today as 'YYYY-MM-DD' (local). daysAgoDay(0) === today. */
export function daysAgoDay(n: number): string {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return toDayString(d);
}

/** Local start-of-year (Jan 1). */
export function startOfYearDay(): string {
  const now = new Date();
  return toDayString(new Date(now.getFullYear(), 0, 1));
}

/**
 * 'YYYY-MM-DD' → filter-chip label. Honors the org's numeric date_format
 * (e.g. 'MM/DD/YYYY' → '06/01/2026'); otherwise keeps the compact
 * 'Jun 1, 2026' short form for filter chips. (#126)
 */
export function formatDayLabel(d: string): string {
  const [y, m, day] = d.split('-');
  const pattern = getOrgDateFormat();
  if (y && m && day) {
    switch (pattern) {
      case 'MM/DD/YYYY':
        return `${m}/${day}/${y}`;
      case 'DD/MM/YYYY':
        return `${day}/${m}/${y}`;
      case 'YYYY-MM-DD':
        return `${y}-${m}-${day}`;
    }
  }
  return new Date(`${d}T00:00:00`).toLocaleDateString('en-US', {
    month: 'short', day: 'numeric', year: 'numeric',
  });
}

/** Chip text for a date range, e.g. 'Created: ≥ Jun 1, 2026'. */
export function dateChipLabel(label: string, from: string, to: string): string {
  if (!from && !to) return label;
  if (from && to) return `${label}: ${formatDayLabel(from)} – ${formatDayLabel(to)}`;
  if (from) return `${label}: ≥ ${formatDayLabel(from)}`;
  return `${label}: ≤ ${formatDayLabel(to)}`;
}

/**
 * Inclusive [from, to] membership test for a Date; a null bound is open-ended.
 * Was duplicated byte-for-byte in reports/arAging.data.ts and
 * reports/expenses-logic.ts before consolidation.
 */
export function withinRange(d: Date, from: Date | null, to: Date | null): boolean {
  if (from && d < from) return false;
  if (to && d > to) return false;
  return true;
}
