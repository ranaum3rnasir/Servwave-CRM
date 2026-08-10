import { describe, it, expect, vi } from 'vitest';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithProviders } from '@/__tests__/helpers';
import MergeFieldChips, { groupFields } from './MergeFieldChips';
import type { WorkflowCatalog } from '@/lib/api/workflows';

/** Minimal catalog fixture — only the merge_field_labels MergeFieldChips reads. */
const CATALOG = {
  merge_field_labels: {
    'org.name': 'Company name',
    'org.phone': 'Company phone',
    'customer.first_name': 'Customer first name',
    'job.number': 'Job number',
    'technician.names': 'Technician name(s)',
    'estimate.total': 'Estimate total',
  },
} as unknown as WorkflowCatalog;

/** A job trigger's mergeFields: 2 Company + 1 Customer + 2 Job (job. + technician.). */
const JOB_TRIGGER_FIELDS = ['org.name', 'org.phone', 'customer.first_name', 'job.number', 'technician.names'];

describe('groupFields', () => {
  it('buckets by entity prefix, merging job. + technician. into one "Job" group, in canonical order', () => {
    expect(groupFields(JOB_TRIGGER_FIELDS)).toEqual([
      { label: 'Company', fields: ['org.name', 'org.phone'] },
      { label: 'Customer', fields: ['customer.first_name'] },
      { label: 'Job', fields: ['job.number', 'technician.names'] },
    ]);
  });

  it('skips groups with no fields', () => {
    const labels = groupFields(['org.name', 'job.number']).map((g) => g.label);
    expect(labels).toEqual(['Company', 'Job']);
  });

  it('returns an empty array for an empty field list', () => {
    expect(groupFields([])).toEqual([]);
  });

  // recipient.first_name ships in BASE alongside org./customer. on every trigger
  // (backend catalog.ts). Without its own bucket it fell into "Other", which
  // reads as a leftover rather than "who this is addressed to".
  it('buckets recipient. into its own "Recipient" group, ordered after Customer', () => {
    expect(groupFields(['org.name', 'customer.first_name', 'recipient.first_name', 'job.number'])).toEqual([
      { label: 'Company', fields: ['org.name'] },
      { label: 'Customer', fields: ['customer.first_name'] },
      { label: 'Recipient', fields: ['recipient.first_name'] },
      { label: 'Job', fields: ['job.number'] },
    ]);
  });
});

describe('MergeFieldChips — empty state', () => {
  it('renders nothing when there are no fields (preserves the existing null render)', () => {
    const { container } = renderWithProviders(
      <MergeFieldChips fields={[]} used={new Set()} catalog={CATALOG} onInsert={vi.fn()} />,
    );
    expect(container.firstChild).toBeNull();
  });
});

describe('MergeFieldChips — collapsible groups', () => {
  it('renders one header per non-empty group, each with its field count', () => {
    renderWithProviders(
      <MergeFieldChips fields={JOB_TRIGGER_FIELDS} used={new Set()} catalog={CATALOG} onInsert={vi.fn()} />,
    );
    expect(screen.getByRole('button', { name: 'Company (2)' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Customer (1)' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Job (2)' })).toBeInTheDocument();
  });

  it('collapses every group by default except the primary (first non-base) entity group', () => {
    renderWithProviders(
      <MergeFieldChips fields={JOB_TRIGGER_FIELDS} used={new Set()} catalog={CATALOG} onInsert={vi.fn()} />,
    );
    expect(screen.getByRole('button', { name: 'Company (2)' })).toHaveAttribute('aria-expanded', 'false');
    expect(screen.getByRole('button', { name: 'Customer (1)' })).toHaveAttribute('aria-expanded', 'false');
    expect(screen.getByRole('button', { name: 'Job (2)' })).toHaveAttribute('aria-expanded', 'true');

    // A collapsed group's chips are not in the document…
    expect(screen.queryByRole('button', { name: /Company name/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /Customer first name/i })).toBeNull();
    // …the expanded (primary) group's chips are.
    expect(screen.getByRole('button', { name: /Job number/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Technician name/i })).toBeInTheDocument();
  });

  it('opens the group containing an already-used field instead of the naive first entity group', () => {
    renderWithProviders(
      <MergeFieldChips
        fields={['org.name', 'job.number', 'estimate.total']}
        used={new Set(['estimate.total'])}
        catalog={CATALOG}
        onInsert={vi.fn()}
      />,
    );
    expect(screen.getByRole('button', { name: 'Estimate (1)' })).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByRole('button', { name: 'Job (1)' })).toHaveAttribute('aria-expanded', 'false');
  });

  it('clicking a collapsed header reveals its chips; clicking again re-collapses it', async () => {
    renderWithProviders(
      <MergeFieldChips fields={JOB_TRIGGER_FIELDS} used={new Set()} catalog={CATALOG} onInsert={vi.fn()} />,
    );
    const companyHeader = screen.getByRole('button', { name: 'Company (2)' });
    expect(screen.queryByRole('button', { name: /Company name/i })).toBeNull();

    await userEvent.click(companyHeader);
    expect(companyHeader).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByRole('button', { name: /Company name/i })).toBeInTheDocument();

    await userEvent.click(companyHeader);
    expect(companyHeader).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByRole('button', { name: /Company name/i })).toBeNull();
  });

  it('clicking a chip in an expanded group still calls onInsert with the raw field key', async () => {
    const onInsert = vi.fn();
    renderWithProviders(
      <MergeFieldChips fields={JOB_TRIGGER_FIELDS} used={new Set()} catalog={CATALOG} onInsert={onInsert} />,
    );
    // "Job" is the primary group, expanded by default.
    await userEvent.click(screen.getByRole('button', { name: /Job number/i }));
    expect(onInsert).toHaveBeenCalledWith('job.number');
  });

  it('an in-use field still renders with aria-pressed="true" (the ✓ state)', () => {
    renderWithProviders(
      <MergeFieldChips
        fields={JOB_TRIGGER_FIELDS}
        used={new Set(['job.number'])}
        catalog={CATALOG}
        onInsert={vi.fn()}
      />,
    );
    expect(screen.getByRole('button', { name: /Job number/i })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: /Technician name/i })).toHaveAttribute('aria-pressed', 'false');
  });
});
