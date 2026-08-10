import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import api from '@/lib/axios';
import { renderWithProviders } from './helpers';
import { EditJobLocationDialog } from '@/components/jobs/EditJobLocationDialog';

const mockApi = vi.mocked(api);

const CURRENT_LOCATION = {
  id: 'loc-tx',
  address_line1: '1 Austin Way',
  city: 'Austin',
  state: 'TX',
  zip: '78701',
};

const CUSTOMER_WITH_LOCATIONS = {
  id: 'cust-1',
  service_locations: [
    CURRENT_LOCATION,
    { id: 'loc-ca', address_line1: '2 Bay St', city: 'San Francisco', state: 'CA', zip: '94105' },
  ],
};

beforeEach(() => {
  vi.clearAllMocks();
  mockApi.get.mockResolvedValue({ data: { customer: CUSTOMER_WITH_LOCATIONS } });
  // PATCH returns the cross-state tax warning.
  mockApi.patch.mockResolvedValue({
    data: { job: {}, tax_warning: { tax_warning: true, old_state: 'TX', new_state: 'CA' } },
  });
});

describe('EditJobLocationDialog', () => {
  it('lists the customer locations and surfaces the tax warning after switching state', async () => {
    const user = userEvent.setup();
    renderWithProviders(
      <EditJobLocationDialog
        open
        onOpenChange={vi.fn()}
        jobId="job-1"
        customerId="cust-1"
        currentLocation={CURRENT_LOCATION}
      />,
    );

    // Existing locations load from GET /api/customers/:id.
    await waitFor(() => {
      expect(screen.getByText(/2 Bay St, San Francisco, CA 94105/)).toBeInTheDocument();
    });

    // Pick the different-state (CA) location, then save.
    await user.click(screen.getByText(/2 Bay St, San Francisco, CA 94105/));
    await user.click(screen.getByRole('button', { name: 'Save Location' }));

    await waitFor(() => {
      expect(mockApi.patch).toHaveBeenCalledWith(
        '/api/jobs/job-1',
        { service_location_id: 'loc-ca' },
      );
    });

    // The tax warning is rendered (informational; mutation already succeeded).
    await waitFor(() => {
      expect(screen.getByText(/from TX to CA/)).toBeInTheDocument();
    });
  });
});
