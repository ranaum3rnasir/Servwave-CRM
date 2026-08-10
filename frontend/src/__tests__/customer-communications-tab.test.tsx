import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import api from '@/lib/axios';
import { renderWithProviders } from './helpers';
import { buildAbility } from '@/lib/ability';
import { CustomerCommunicationsTab } from '@/components/communication/CustomerCommunicationsTab';

const mockApi = vi.mocked(api);

// Comms access gate — default OFF (matches the auth store's test default) so the
// existing timeline specs render the read-only surface; the drawer spec flips it.
const commAccess = vi.hoisted(() => ({ value: false }));
vi.mock('@/lib/entitlements', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/entitlements')>()),
  useFeature: () => commAccess.value,
}));

// Stub the detail drawer (it lazy-loads the CallsView/Dialer graph) so this spec
// stays on the tab's wiring.
vi.mock('@/components/communication/shared/EntityCallDrawer', () => ({
  EntityCallDrawer: ({ callId, onClose }: { callId: string; onClose: () => void }) => (
    <div data-testid="entity-call-drawer" data-call-id={callId}>
      <button type="button" onClick={onClose}>
        close-drawer
      </button>
    </div>
  ),
}));

vi.mock('@/components/communication/shared/EntitySmsDrawer', () => ({
  EntitySmsDrawer: ({ customerId, onClose }: { customerId: string; onClose: () => void }) => (
    <div data-testid="entity-sms-drawer" data-customer-id={customerId}>
      <button type="button" onClick={onClose}>
        close-sms-drawer
      </button>
    </div>
  ),
}));

const CUSTOMER_ID = 'c0000000-0000-0000-0000-000000000001';

// Shared CommItem contract fixtures — 3 channels, ascending by `at` (the
// backend's order). The SMS row carries no job → muted "no job" pill.
const ITEMS = [
  {
    id: 'cs-00000000-0000-0000-0000-000000000001',
    channel: 'call',
    direction: 'in',
    who: 'Maria Garcia',
    title: 'Inbound call · 4m 07s',
    preview: 'Asked about rescheduling the vault corridor work.',
    at: '2026-06-01T14:00:00.000Z',
    jobId: 'b0000000-0000-0000-0000-000000000001',
    jobLabel: 'J00018',
    meta: 'Answered',
  },
  {
    id: 'em-00000000-0000-0000-0000-000000000001',
    channel: 'email',
    direction: 'out',
    who: 'Maria Garcia',
    title: 'Estimate E00012 — ready for review',
    preview: 'Hi Maria, your estimate is ready for review…',
    at: '2026-06-02T09:30:00.000Z',
    jobId: 'b0000000-0000-0000-0000-000000000001',
    jobLabel: 'J00018',
    transactional: true,
  },
  {
    id: 'sm-00000000-0000-0000-0000-000000000001',
    channel: 'sms',
    direction: 'in',
    who: 'Maria Garcia',
    title: 'Text message',
    preview: 'Sounds good, see you then!',
    at: '2026-06-03T16:45:00.000Z',
  },
];

describe('CustomerCommunicationsTab', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    commAccess.value = false;
  });

  it('renders the unified timeline: titles, job pills, one no-job pill, transactional chip', async () => {
    mockApi.get.mockResolvedValue({ data: { items: ITEMS } });

    renderWithProviders(<CustomerCommunicationsTab customerId={CUSTOMER_ID} />);

    // All three channel rows render by title.
    expect(await screen.findByText('Inbound call · 4m 07s')).toBeInTheDocument();
    expect(screen.getByText('Estimate E00012 — ready for review')).toBeInTheDocument();
    expect(screen.getByText('Text message')).toBeInTheDocument();

    // Fetched from the per-customer aggregation endpoint.
    expect(mockApi.get).toHaveBeenCalledWith(`/api/customers/${CUSTOMER_ID}/communications`);

    // Job pills on the two attributed rows; the job-less SMS gets exactly one
    // muted "no job" pill ("badge it, don't hide it").
    expect(screen.getAllByText('J00018')).toHaveLength(2);
    expect(screen.getAllByText('no job')).toHaveLength(1);

    // Transactional email is chipped.
    expect(screen.getByText('auto · transactional')).toBeInTheDocument();
  });

  it('shows the empty state when the customer has no communications', async () => {
    mockApi.get.mockResolvedValue({ data: { items: [] } });

    renderWithProviders(<CustomerCommunicationsTab customerId={CUSTOMER_ID} />);

    expect(
      await screen.findByText('No communication with this customer yet.')
    ).toBeInTheDocument();
  });

  it('opens the call detail drawer when a call row is clicked (comms-enabled)', async () => {
    commAccess.value = true;
    const user = userEvent.setup();
    mockApi.get.mockResolvedValue({ data: { items: ITEMS } });

    renderWithProviders(<CustomerCommunicationsTab customerId={CUSTOMER_ID} />);
    await screen.findByText('Inbound call · 4m 07s');

    await user.click(screen.getByText('Inbound call · 4m 07s'));

    expect(screen.getByTestId('entity-call-drawer')).toHaveAttribute(
      'data-call-id',
      'cs-00000000-0000-0000-0000-000000000001',
    );
  });

  it('opens the SMS conversation drawer when a text row is clicked (comms-enabled)', async () => {
    commAccess.value = true;
    const user = userEvent.setup();
    mockApi.get.mockResolvedValue({ data: { items: ITEMS } });

    renderWithProviders(<CustomerCommunicationsTab customerId={CUSTOMER_ID} />);
    await screen.findByText('Text message');

    await user.click(screen.getByText('Text message'));

    expect(screen.getByTestId('entity-sms-drawer')).toHaveAttribute('data-customer-id', CUSTOMER_ID);
    expect(screen.queryByTestId('entity-call-drawer')).not.toBeInTheDocument();
  });

  // Email joined call/sms on the per-row reassign seam. This tab is one of the
  // three sibling roll-ups that must all show it - an email that could not be
  // re-attributed while the call and text beside it could was the odd one out.
  it('gives an email row the attach/move/detach menu when gated (customer scope)', async () => {
    commAccess.value = true;
    mockApi.get.mockImplementation(async (url: string) => {
      if (url === `/api/customers/${CUSTOMER_ID}/communications`) return { data: { items: ITEMS } };
      if (url === `/api/customers/${CUSTOMER_ID}`) return { data: { customer: { jobs: [] } } };
      return { data: {} };
    });

    renderWithProviders(<CustomerCommunicationsTab customerId={CUSTOMER_ID} />, {
      ability: buildAbility([
        { action: 'read', subject: 'Communication' },
        { action: 'update', subject: 'Communication' },
      ]),
    });

    const emailRow = (await screen.findByText('Estimate E00012 — ready for review')).closest('li')!;
    expect(
      within(emailRow).getByTitle('Attached to J00018 — click to move or detach')
    ).toBeInTheDocument();
  });
});
