import { DateRangeField } from '@/components/form/DateRangeField';
import type { FacetControlProps } from './facetControlProps';

/**
 * Pane control for `kind: 'dateRange'` facets: a thin wrapper around the
 * existing `DateRangeField` (presets + custom range), mapping between its
 * plain `{from, to}` strings and the facet's `{kind:'dateRange', from, to}`
 * `FilterValue`.
 */
export function DateFacet({ facet, value, onChange }: FacetControlProps) {
  const from = value?.kind === 'dateRange' ? value.from : '';
  const to = value?.kind === 'dateRange' ? value.to : '';

  return (
    <DateRangeField
      label={facet.label}
      from={from}
      to={to}
      onChange={(next) => onChange({ kind: 'dateRange', from: next.from, to: next.to })}
    />
  );
}
