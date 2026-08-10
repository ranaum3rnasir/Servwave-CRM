// A personal Gmail reply arrives with NO display name - just a bare address -
// so the backend records `from.name: null` (it declines to invent one, see
// senderIdentityOf in backend/src/lib/inbound-email.ts). The UI typed that
// field as `string` and read it straight through, which produced a blank name
// beside a `?` avatar in the list and the reading pane, the literal word
// "null" in the quoted reply header, and two outright crashes: searching the
// inbox called `null.toLowerCase()`, and AI-drafting a reply called
// `null.trim()`.
//
// Also covers the removal of the "via <account>" badge: exactly one sending
// identity exists, so it distinguished nothing on any row, and the constant
// behind it still named the retired `no-reply@servwave.app`.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import api from '@/lib/axios';
import { useAuthStore } from '@/stores/auth.store';
import { buildAbility } from '@/lib/ability';
import { renderWithProviders } from './helpers';
import InboxPage from '@/pages/communication/InboxPage';
import { senderLabel, type Email } from '@/lib/api/communication';

const mockApi = vi.mocked(api);

const readAbility = buildAbility([
  { action: 'read', subject: 'Communication' },
  { action: 'update', subject: 'Communication' },
]);

const NAMELESS_ADDRESS = 'info@servwave.com';

// Module-level, never re-allocated per call - a fresh array here re-fires
// InboxPage's seeding effect forever (see InboxPage.test.tsx's header).
const EMAILS_FIXTURE: Email[] = [
  {
    id: 'e_nameless',
    account: 'gmail',
    // The shape the Resend inbound path actually persists for a bare address.
    from: { name: null, email: NAMELESS_ADDRESS },
    to: 'servwavetest@mail.servwave.com',
    subject: 'Re: hello',
    snippet: 'Good thank you!',
    body: ['Good thank you!'],
    at: '12:54 PM',
    ts: 2,
    unread: true,
    starred: false,
    folder: 'inbox',
  },
  {
    id: 'e_named',
    account: 'gmail',
    from: { name: 'Dana Lee', email: 'dana@example.com' },
    to: 'servwavetest@mail.servwave.com',
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
  mockApi.get.mockImplementation(async (url: string) => {
    if (url === '/api/communication/emails') return { data: { emails: EMAILS_FIXTURE } };
    if (url === '/api/communication/email-groups') return { data: { groups: [] } };
    if (url === '/api/communication/forward-rules') return { data: { rules: [] } };
    if (url === '/api/communication/team-members') return { data: { members: [] } };
    if (url === '/api/communication/email-accounts')
      return { data: { accounts: [], configured: false } };
    return { data: {} };
  });
});

const renderInbox = () => renderWithProviders(<InboxPage />, { ability: readAbility });

describe('senderLabel', () => {
  it('uses the display name when the sender set one', () => {
    expect(senderLabel({ name: 'Dana Lee', email: 'dana@example.com' })).toBe('Dana Lee');
  });

  it('falls back to the address when there is no name', () => {
    expect(senderLabel({ name: null, email: NAMELESS_ADDRESS })).toBe(NAMELESS_ADDRESS);
  });

  it('treats a whitespace-only name as no name', () => {
    // `"   " <addr>` is a legal header and renders as a blank gap on screen.
    expect(senderLabel({ name: '   ', email: NAMELESS_ADDRESS })).toBe(NAMELESS_ADDRESS);
  });

  it('never returns an empty string, even with nothing to work from', () => {
    // The avatar derives its initials from this, so '' would put the `?` back.
    expect(senderLabel({ name: null, email: '' })).toBe('Unknown sender');
  });
});

describe('InboxPage - a sender with no display name', () => {
  it('shows the address in the list row instead of a blank name', async () => {
    renderInbox();

    expect(await screen.findByText(NAMELESS_ADDRESS)).toBeInTheDocument();
  });

  it('derives avatar initials from the address, not a "?" placeholder', async () => {
    renderInbox();
    await screen.findByText(NAMELESS_ADDRESS);

    // getInitials('info@servwave.com') -> 'IN'. The bug rendered '?' here.
    expect(screen.getAllByText('IN').length).toBeGreaterThan(0);
    expect(screen.queryByText('?')).not.toBeInTheDocument();
  });

  it('survives a search, which used to crash on null.toLowerCase()', async () => {
    const user = userEvent.setup();
    renderInbox();
    await screen.findByText(NAMELESS_ADDRESS);

    const search = screen.getByPlaceholderText(/search/i);
    await user.type(search, 'info');

    // Matching the nameless sender by address is the point; the assertion that
    // matters as much is that typing at all did not take the page down.
    expect(await screen.findByText(NAMELESS_ADDRESS)).toBeInTheDocument();
  });

  it('still matches a named sender by name when searching', async () => {
    const user = userEvent.setup();
    renderInbox();
    await screen.findByText('Dana Lee');

    await user.type(screen.getByPlaceholderText(/search/i), 'Dana');

    expect(await screen.findByText('Dana Lee')).toBeInTheDocument();
    expect(screen.queryByText(NAMELESS_ADDRESS)).not.toBeInTheDocument();
  });
});

describe('InboxPage - the "via <account>" badge is gone', () => {
  it('does not label every message with the single sending identity', async () => {
    const user = userEvent.setup();
    renderInbox();

    await user.click(await screen.findByText('AC still not cooling'));

    // "System" was the provider name on the sole hardcoded account, printed on
    // every expanded message. One identity distinguishes nothing.
    expect(screen.queryByText(/via/i)).not.toBeInTheDocument();
    expect(screen.queryByText('System')).not.toBeInTheDocument();
  });

  it('does not show the retired no-reply@servwave.app address anywhere', async () => {
    renderInbox();
    await screen.findByText('Dana Lee');

    expect(screen.queryByText(/no-reply@servwave\.app/)).not.toBeInTheDocument();
  });

  it('still shows who the message was addressed to', async () => {
    // The recipient line survived the badge removal - only the "· via X" tail
    // was dropped, not the "to <addr>" the line exists for.
    const user = userEvent.setup();
    renderInbox();

    await user.click(await screen.findByText('AC still not cooling'));

    // findAllByText, not findByText: the desktop and mobile reading panes are
    // BOTH in the DOM at once (visibility is CSS-only, which jsdom does not
    // apply), so every reading-pane assertion here matches twice.
    expect(
      (await screen.findAllByText(/to servwavetest@mail\.servwave\.com/)).length,
    ).toBeGreaterThan(0);
  });
});

describe('InboxPage - the address chip beside the name', () => {
  it('shows <address> next to a real name', async () => {
    const user = userEvent.setup();
    renderInbox();

    await user.click(await screen.findByText('AC still not cooling'));

    expect((await screen.findAllByText('<dana@example.com>')).length).toBeGreaterThan(0);
  });

  it('does not repeat the address beside itself for a nameless sender', async () => {
    // The fallback already put the address in the name slot, so the chip would
    // render `info@servwave.com <info@servwave.com>`.
    const user = userEvent.setup();
    renderInbox();

    await user.click(await screen.findByText('Re: hello'));
    // Anchor on something the expanded pane renders, so the negative assertion
    // below cannot pass merely because the pane never opened.
    await screen.findAllByText(/to servwavetest@mail\.servwave\.com/);

    expect(screen.queryAllByText(`<${NAMELESS_ADDRESS}>`)).toHaveLength(0);
  });
});
