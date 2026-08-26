/**
 * SRVW-261: the customer search dropdown must not cover the field it
 * belongs to.
 *
 * RED before the fix: the panel was `absolute ... w-full` with no
 * top/left, and it was the last child of a `relative flex flex-col`
 * wrapper. For an absolutely positioned child of a FLEX container, the
 * static position is the container's content-box start corner (not
 * "after the preceding siblings" as in a block container), so the panel
 * painted over the Label and Input instead of landing below them.
 *
 * jsdom performs no layout, so this pins the class-level anchor
 * (`top-full left-0 right-0`, the repo's established idiom) rather than
 * pretending to assert the rendered geometry.
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

import { PickCustomerFields } from '../pickCustomer';
import type { CustomerContactFields } from '@/components/crm/PickOrCreateCustomer';

vi.mock('@/lib/axios', () => ({
  default: { get: vi.fn().mockResolvedValue({ data: { customers: [] } }) },
}));

const EMPTY_FIELDS: CustomerContactFields = {
  first_name: '',
  last_name: '',
  company_name: '',
  phone: '',
  email: '',
};

function renderFields() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <PickCustomerFields
        fields={{ ...EMPTY_FIELDS, first_name: 'Jo' }}
        onFieldChange={() => {}}
        selectedCustomer={null}
        onSelectCustomer={() => {}}
      />
    </QueryClientProvider>,
  );
}

describe('CustomerDropdown anchoring', () => {
  it('anchors the panel below the field via top-full, not the flex static position', async () => {
    const user = userEvent.setup();
    renderFields();

    await user.click(screen.getByLabelText(/first name/i));

    const panel = await waitFor(() => screen.getByText('No customers found').closest('div'));
    expect(panel).toHaveClass('top-full');
    expect(panel).toHaveClass('left-0');
    expect(panel).toHaveClass('right-0');
  });
});
