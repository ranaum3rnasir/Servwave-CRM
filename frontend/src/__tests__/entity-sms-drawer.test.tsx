// EntitySmsDrawer — the entity-tab wrapper behind a clicked SMS row on the
// Job / Customer / Lead Communication tabs: a right-side slide-in showing the
// customer's SMS conversation (chat parity with the call detail drawer).
// useMessageThreads is mocked so this suite stays focused on the drawer.
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const useMessageThreadsMock = vi.hoisted(() => vi.fn());
vi.mock('@/lib/api/communication', async () => ({
  useMessageThreads: useMessageThreadsMock,
  fmtPhone: (n: string) => n,
  // Real (pure) delivery-presentation helpers - stubbing these would make the
  // bubble assertions test the stub instead of the honest-status mapping.
  ...(await vi.importActual<
    typeof import('@/lib/api/communication-shared/messageDelivery')
  >('@/lib/api/communication-shared/messageDelivery')),
}));

import { EntitySmsDrawer } from '@/components/communication/shared/EntitySmsDrawer';

const THREAD = {
  id: 't1',
  customerId: 'cust-1',
  channel: 'sms',
  campaignType: 'customer_care',
  unread: 0,
  messages: [
    { id: 'm1', direction: 'in', body: 'Is my tech still coming?', ts: '2026-07-15T14:00:00Z' },
    { id: 'm2', direction: 'out', body: 'Yes — ETA 2pm.', ts: '2026-07-15T14:01:00Z' },
  ],
};

describe('EntitySmsDrawer', () => {
  it('renders the customer conversation bubbles (both directions)', () => {
    useMessageThreadsMock.mockReturnValue({ data: [THREAD], isLoading: false });
    render(<EntitySmsDrawer customerId="cust-1" customerName="Jane Doe" onClose={vi.fn()} />);

    expect(screen.getByText('Is my tech still coming?')).toBeInTheDocument();
    expect(screen.getByText('Yes — ETA 2pm.')).toBeInTheDocument();
    expect(screen.getByText('Jane Doe')).toBeInTheDocument();
  });

  it('shows an empty state when the customer has no SMS thread', () => {
    useMessageThreadsMock.mockReturnValue({ data: [THREAD], isLoading: false });
    render(<EntitySmsDrawer customerId="no-thread-cust" customerName="Bob" onClose={vi.fn()} />);

    expect(screen.getByText(/no messages in this conversation yet/i)).toBeInTheDocument();
    expect(screen.queryByText('Yes — ETA 2pm.')).not.toBeInTheDocument();
  });

  it('shows a loading state while threads load', () => {
    useMessageThreadsMock.mockReturnValue({ data: undefined, isLoading: true });
    render(<EntitySmsDrawer customerId="cust-1" onClose={vi.fn()} />);

    expect(screen.getByRole('status')).toBeInTheDocument();
  });

  it('closes on Escape (Sheet dismiss)', async () => {
    const onClose = vi.fn();
    useMessageThreadsMock.mockReturnValue({ data: [THREAD], isLoading: false });
    render(<EntitySmsDrawer customerId="cust-1" onClose={onClose} />);

    await userEvent.keyboard('{Escape}');
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
