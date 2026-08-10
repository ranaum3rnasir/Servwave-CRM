import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { DateFacet } from './DateFacet';
import type { FacetConfig, FilterValue } from '@/lib/filters/types';

const facet: FacetConfig = {
  key: 'created',
  label: 'Created',
  icon: 'M0 0',
  kind: 'dateRange',
  param: 'created',
};

describe('DateFacet', () => {
  it('defaults to the "Any time" preset when value is undefined', () => {
    render(<DateFacet facet={facet} value={undefined} onChange={() => {}} />);
    expect(screen.getByRole('combobox')).toHaveTextContent('Any time');
  });

  it('reflects an existing dateRange value into DateRangeField (matches the "Today" preset)', () => {
    const value: FilterValue = { kind: 'dateRange', from: '', to: '' };
    render(<DateFacet facet={facet} value={value} onChange={() => {}} />);
    expect(screen.getByRole('combobox')).toHaveTextContent('Any time');
  });

  it('wraps DateRangeField onChange into a proper dateRange FilterValue', async () => {
    const onChange = vi.fn();
    render(<DateFacet facet={facet} value={undefined} onChange={onChange} />);

    await userEvent.click(screen.getByRole('combobox'));
    await userEvent.click(await screen.findByRole('option', { name: 'Today' }));

    expect(onChange).toHaveBeenCalledTimes(1);
    const arg = onChange.mock.calls[0]![0] as FilterValue;
    expect(arg.kind).toBe('dateRange');
    if (arg.kind === 'dateRange') {
      expect(arg.from).toBe(arg.to); // "Today" preset: from === to
      expect(arg.from).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
  });

  it('passes facet.label through as the aria label', () => {
    render(<DateFacet facet={facet} value={undefined} onChange={() => {}} />);
    expect(screen.getByLabelText('Created range')).toBeInTheDocument();
  });
});
