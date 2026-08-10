// E2 — Job-page call entry. The Customer & Contact card's Call tile and phone
// row route into the /phone tab (Task B4 cross-tab handoff) with FULL entity
// attribution (jobId/jobLabel/customerId/customerName) — but ONLY when the
// org can use the comms module (useFeature('phone')) AND the user holds
// create:Communication. Every other combination keeps the native tel: anchor
// exactly as before (technicians, locked orgs) — a link can never 403.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import api from '@/lib/axios';
import { renderWithProviders } from './helpers';
import { buildAbility } from '@/lib/ability';
import { requestCall } from '@/lib/communication/phoneTabHandoff';
import { CustomerContactCard } from '@/components/jobs/overview/CustomerContactCard';

const mockApi = vi.mocked(api);
const mockRequestCall = vi.mocked(requestCall);

// Org-level comms access — toggled per test (settings-unsaved-guard precedent).
const commAccess = vi.hoisted(() => ({ value: true }));
vi.mock('@/lib/entitlements', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/entitlements')>()),
  useFeature: () => commAccess.value,
}));

// Task B4 — the call tile/row route through the cross-tab dial handoff, not
// the legacy in-app GlobalDialer popup; stub it so these specs assert the
// call was requested without needing a real window.open.
vi.mock('@/lib/communication/phoneTabHandoff', () => ({
  requestCall: vi.fn(),
}));

const JOB = {
  id: 'b0000000-0000-0000-0000-000000000001',
  job_number: 'J00042',
  customer: {
    id: 'c0000000-0000-0000-0000-000000000001',
    first_name: 'Daniel',
    last_name: 'Cohen',
    company_name: null,
    email: 'daniel@vaultcorp.com',
    phone: '5551234567',
  },
  service_location: null,
};

const EXPECTED_CONTEXT = {
  jobId: JOB.id,
  jobLabel: 'J00042',
  customerId: JOB.customer.id,
  customerName: 'Daniel Cohen',
};

const fullAbility = buildAbility([
  { action: 'read', subject: 'Communication' },
  { action: 'create', subject: 'Communication' },
]);
const readOnlyAbility = buildAbility([{ action: 'read', subject: 'Communication' }]);

beforeEach(() => {
  vi.clearAllMocks();
  commAccess.value = true;
  // Recent-communications preview (fires only with read:Communication).
  mockApi.get.mockResolvedValue({ data: { items: [] } });
});

describe('CustomerContactCard Text entry gating (s1b)', () => {
  it('comm access + read ability: the Text tile routes to the in-app Text inbox, not sms:', () => {
    // Live QA 2026-07-21: the sms: anchor opened the OS Messages app even for
    // comm-enabled orgs. The tile must deep-link the in-app inbox composer
    // (?customerId= preselects the thread/customer) exactly like Call does.
    renderWithProviders(<CustomerContactCard job={JOB} />, { ability: fullAbility });

    const text = screen.getByRole('link', { name: 'Text' });
    expect(text).toHaveAttribute(
      'href',
      `/communication/text?customerId=${JOB.customer.id}`,
    );
  });

  it('locked org (no comm access): the Text tile keeps the native sms: anchor', () => {
    commAccess.value = false;
    renderWithProviders(<CustomerContactCard job={JOB} />, { ability: readOnlyAbility });

    expect(screen.getByRole('link', { name: 'Text' })).toHaveAttribute(
      'href',
      'sms:5551234567',
    );
  });
});

describe('CustomerContactCard call entry gating (E2)', () => {
  it('comm access + create ability: the Call tile routes into the /phone tab with full job context', async () => {
    renderWithProviders(<CustomerContactCard job={JOB} />, { ability: fullAbility });

    await userEvent.click(screen.getByRole('button', { name: 'Call' }));

    expect(mockRequestCall).toHaveBeenCalledWith('5551234567', EXPECTED_CONTEXT);
    // No tel: fallback remains for the tile.
    expect(screen.queryByRole('link', { name: 'Call' })).not.toBeInTheDocument();
  });

  it('comm access + create ability: the phone row is a dialer button with the same context', async () => {
    renderWithProviders(<CustomerContactCard job={JOB} />, { ability: fullAbility });

    await userEvent.click(screen.getByRole('button', { name: '(555) 123-4567' }));

    expect(mockRequestCall).toHaveBeenCalledWith('5551234567', EXPECTED_CONTEXT);
  });

  it('without create:Communication (technician) both stay native tel: anchors', async () => {
    renderWithProviders(<CustomerContactCard job={JOB} />, { ability: readOnlyAbility });

    expect(screen.getByRole('link', { name: 'Call' })).toHaveAttribute(
      'href',
      'tel:5551234567',
    );
    expect(screen.getByRole('link', { name: '(555) 123-4567' })).toHaveAttribute(
      'href',
      'tel:5551234567',
    );
    expect(screen.queryByRole('button', { name: 'Call' })).not.toBeInTheDocument();
    expect(mockRequestCall).not.toHaveBeenCalled();
  });

  it('without org comms access both stay native tel: anchors even with the ability', () => {
    commAccess.value = false;
    renderWithProviders(<CustomerContactCard job={JOB} />, { ability: fullAbility });

    expect(screen.getByRole('link', { name: 'Call' })).toHaveAttribute(
      'href',
      'tel:5551234567',
    );
    expect(screen.getByRole('link', { name: '(555) 123-4567' })).toHaveAttribute(
      'href',
      'tel:5551234567',
    );
    expect(screen.queryByRole('button', { name: 'Call' })).not.toBeInTheDocument();
  });
});
