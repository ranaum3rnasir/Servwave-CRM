// Page-level companion to compose-sending-disabled.test.tsx.
//
// That spec proves ComposeWindow does the right thing GIVEN the prop. This one
// proves the prop actually arrives: `sendingEnabled` starts life on
// GET /sending-identity and has to survive InboxPage -> ComposeWindow and
// InboxPage -> ReadingPane -> InlineComposer. The threading is where a site is
// easy to miss, and a missed site fails silently - the surface just goes on
// looking sendable.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import api from '@/lib/axios';
import { useAuthStore } from '@/stores/auth.store';
import { buildAbility } from '@/lib/ability';
import { renderWithProviders } from './helpers';
import InboxPage from '@/pages/communication/InboxPage';
import { SENDING_DISABLED_LABEL } from '@/components/communication/inbox/ComposeWindow';
import type { Email } from '@/lib/api/communication';

const mockApi = vi.mocked(api);

const readAbility = buildAbility([
  { action: 'read', subject: 'Communication' },
  { action: 'update', subject: 'Communication' },
]);

const ADDRESS = 'alphadoors@mail.servwave.com';
const BANNER = new RegExp(SENDING_DISABLED_LABEL, 'i');

// Module-level constant, never re-allocated (see InboxPage.test.tsx's header on
// the render loop a fresh array causes).
const EMAILS_FIXTURE: Email[] = [
  {
    id: 'e_1',
    account: 'gmail',
    from: { name: 'Dana Lee', email: 'dana@example.com' },
    to: ADDRESS,
    subject: 'AC still not cooling',
    snippet: 'Following up on the visit.',
    body: ['Following up on the visit.'],
    at: '9:41 AM',
    ts: 1,
    unread: false,
    starred: false,
    folder: 'inbox',
  },
];

/** Mount the inbox with the org's sending switch in a given state. */
function mockIdentity(sendingEnabled: boolean) {
  mockApi.get.mockImplementation(async (url: string) => {
    if (url === '/api/communication/emails') return { data: { emails: EMAILS_FIXTURE } };
    if (url === '/api/communication/sending-identity')
      return { data: { address: ADDRESS, name: 'Alpha Doors', customDomain: false, sendingEnabled } };
    if (url === '/api/communication/email-groups') return { data: { groups: [] } };
    if (url === '/api/communication/forward-rules') return { data: { rules: [] } };
    if (url === '/api/communication/team-members') return { data: { members: [] } };
    if (url === '/api/communication/email-accounts')
      return { data: { accounts: [], configured: false } };
    return { data: {} };
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(useAuthStore).mockImplementation((selector: (s: Record<string, unknown>) => unknown) =>
    selector({
      user: {
        id: '00000000-0000-0000-0000-000000000001',
        email: 'admin@test.com',
        first_name: 'Test',
        last_name: 'Admin',
        role: 'ADMIN',
        org_features: ['email'],
      },
      isAuthenticated: true,
      isLoading: false,
      error: null,
    }),
  );
  mockIdentity(false);
});

const renderInbox = () => renderWithProviders(<InboxPage />, { ability: readAbility });

describe('InboxPage - sendingEnabled reaches the compose window', () => {
  it('warns in the compose window when the org has sending switched off', async () => {
    const user = userEvent.setup();
    renderInbox();

    await user.click(await screen.findByRole('button', { name: /compose/i }));

    expect(await screen.findByText(BANNER)).toBeInTheDocument();
  });

  it('disables that window Send button', async () => {
    const user = userEvent.setup();
    renderInbox();

    await user.click(await screen.findByRole('button', { name: /compose/i }));
    await screen.findByText(BANNER);

    expect(screen.getByRole('button', { name: /^send$/i })).toBeDisabled();
  });

  it('shows no banner when the org can send', async () => {
    mockIdentity(true);
    const user = userEvent.setup();
    renderInbox();

    await user.click(await screen.findByRole('button', { name: /compose/i }));
    // Anchor on the From address so this cannot pass by the window never opening.
    expect((await screen.findAllByText(ADDRESS)).length).toBeGreaterThan(0);

    expect(screen.queryByText(BANNER)).not.toBeInTheDocument();
  });
});

describe('InboxPage - sendingEnabled reaches the inline reply composer', () => {
  it('warns in the inline composer too, not only the pop-out window', async () => {
    // The separate path: InboxPage -> ReadingPane -> InlineComposer. Missing it
    // would leave every REPLY - the common case - silently unguarded.
    const user = userEvent.setup();
    renderInbox();

    await user.click(await screen.findByText('AC still not cooling'));
    const replyButtons = await screen.findAllByRole('button', { name: /^reply$/i });
    await user.click(replyButtons[0]!);

    expect((await screen.findAllByText(BANNER)).length).toBeGreaterThan(0);
  });
});
