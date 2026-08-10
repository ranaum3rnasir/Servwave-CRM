// Smoke coverage for the Communication module's email inbox (InboxPage).
//
// Regression target: folder-nav clicks (e.g. clicking "Sent") used to hang the
// whole test process indefinitely. Root cause was in InboxPage itself, not a
// test-environment quirk — `useEmailGroups`/`useForwardRules` seed local state
// via `useEffect(() => setGroups(groupSeed), [groupSeed])`, where
// `groupSeed` came from `const { data: groupSeed = [] } = useEmailGroups()`.
// Whenever the query's `data` stays `undefined` across renders (still loading,
// or — as in this suite's default axios mock shape — permanently erroring),
// that inline `[]` default allocates a NEW array every render, so the effect's
// dependency never stabilizes: it re-fires every render, calling `setGroups`
// with a new-but-equal array, which schedules another render, forever. The
// first render is always a same-reference no-op (the effect's `groupSeed` and
// the `useState` initializer close over the identical value), so mounting
// alone never triggers it — only a SECOND render (any subsequent state
// update, e.g. a folder click) does. Fixed by hoisting the fallback to a
// module-level singleton (EMPTY_GROUPS et al.) in InboxPage.tsx so repeated
// "still no data" renders keep comparing equal.
//
// Gotcha for future specs on this page: a hook mock like
// `useEmails: () => ({ data: [] })` reproduces the exact same hang on its own,
// because it allocates a fresh array on every call — bypassing InboxPage's
// fallback entirely. Mock hook `data` with a stable reference (a module-level
// constant, or drive it through the axios mock so react-query's own caching
// keeps it stable) — never a literal recreated per call.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import api from '@/lib/axios';
import { useAuthStore } from '@/stores/auth.store';
import { buildAbility } from '@/lib/ability';
import { renderWithProviders } from './helpers';
import InboxPage from '@/pages/communication/InboxPage';
import type { Email, EmailGroup, ForwardRule, TeamMember } from '@/lib/api/communication';

const mockApi = vi.mocked(api);

const readAbility = buildAbility([
  { action: 'read', subject: 'Communication' },
  { action: 'update', subject: 'Communication' },
]);

const EMAILS_FIXTURE: Email[] = [
  {
    id: 'e_inbox_1',
    account: 'gmail',
    from: { name: 'Dana Lee', email: 'dana@example.com' },
    to: 'emanuel@example.com',
    subject: 'AC still not cooling',
    snippet: 'Following up on the visit from last week...',
    body: ['Following up on the visit from last week.'],
    at: '9:41 AM',
    ts: 3,
    unread: true,
    starred: false,
    folder: 'inbox',
  },
  {
    id: 'e_sent_1',
    account: 'gmail',
    from: { name: 'Emanuel Dahan', email: 'emanuel@example.com' },
    to: 'dana@example.com',
    subject: 'Re: AC still not cooling',
    snippet: "We'll have a tech out Thursday.",
    body: ["We'll have a tech out Thursday."],
    at: '9:50 AM',
    ts: 4,
    unread: false,
    starred: false,
    folder: 'sent',
  },
  {
    id: 'e_draft_1',
    account: 'gmail',
    from: { name: 'Emanuel Dahan', email: 'emanuel@example.com' },
    to: '',
    subject: 'Quarterly maintenance reminder',
    snippet: '(draft)',
    body: ['(draft)'],
    at: 'Yesterday',
    ts: 2,
    unread: false,
    starred: false,
    folder: 'drafts',
  },
  {
    id: 'e_archive_1',
    account: 'gmail',
    from: { name: 'Vendor Co', email: 'billing@vendor.com' },
    to: 'emanuel@example.com',
    subject: 'Invoice #4821',
    snippet: 'Attached is your invoice.',
    body: ['Attached is your invoice.'],
    at: 'Mon',
    ts: 1,
    unread: false,
    starred: false,
    folder: 'archive',
  },
];

const GROUPS_FIXTURE: EmailGroup[] = [{ id: 'g1', name: 'Dispatch', memberIds: ['m1'] }];
const FORWARDS_FIXTURE: ForwardRule[] = [
  { id: 'f1', from: 'billing@servwave.app', toMemberId: 'm1', enabled: true },
];
const MEMBERS_FIXTURE: TeamMember[] = [
  { id: 'm1', name: 'Sam Rivera', email: 'sam@example.com', role: 'Dispatcher' },
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
        // Non-empty org_features flips useEntitlementsReady() true; useEmails
        // gates on its own 'email' entitlement (STARTER, distinct from 'phone').
        org_features: ['email'],
      },
      isAuthenticated: true,
      isLoading: false,
      error: null,
    }),
  );
  mockApi.get.mockImplementation(async (url: string) => {
    if (url === '/api/communication/emails') return { data: { emails: EMAILS_FIXTURE } };
    if (url === '/api/communication/email-groups') return { data: { groups: GROUPS_FIXTURE } };
    if (url === '/api/communication/forward-rules') return { data: { rules: FORWARDS_FIXTURE } };
    if (url === '/api/communication/team-members') return { data: { members: MEMBERS_FIXTURE } };
    if (url === '/api/communication/email-accounts')
      return { data: { accounts: [], configured: false } };
    return { data: {} };
  });
});

function renderInbox() {
  return renderWithProviders(<InboxPage />, { ability: readAbility });
}

// The folder rail's "Inbox" label collides with the page's <h1>Inbox</h1> —
// scope to the nav button. Each folder button's accessible name concatenates
// its label with the adjacent count badge with no separator (e.g. "Sent1"),
// so match on the label as a prefix rather than a whole word.
function folderButton(label: string) {
  return screen.getByRole('button', { name: new RegExp(`^${label}`) });
}

describe('InboxPage — smoke', () => {
  it('mounts and shows the default Inbox folder', async () => {
    renderInbox();
    expect(screen.getByRole('heading', { name: 'Inbox' })).toBeInTheDocument();
    expect(await screen.findByText('AC still not cooling')).toBeInTheDocument();
    // Sent-folder mail is not shown while Inbox is active.
    expect(screen.queryByText('Re: AC still not cooling')).not.toBeInTheDocument();
  });

  it('switches folders on click without hanging, showing only that folder\'s mail', async () => {
    const user = userEvent.setup();
    renderInbox();
    await screen.findByText('AC still not cooling');

    await user.click(folderButton('Sent'));
    expect(await screen.findByText('Re: AC still not cooling')).toBeInTheDocument();
    expect(screen.queryByText('AC still not cooling')).not.toBeInTheDocument();

    await user.click(folderButton('Drafts'));
    expect(await screen.findByText('Quarterly maintenance reminder')).toBeInTheDocument();
    expect(screen.queryByText('Re: AC still not cooling')).not.toBeInTheDocument();

    await user.click(folderButton('Archive'));
    expect(await screen.findByText('Invoice #4821')).toBeInTheDocument();

    await user.click(folderButton('Inbox'));
    expect(await screen.findByText('AC still not cooling')).toBeInTheDocument();
  });

  it('filters the visible list via the search box', async () => {
    const user = userEvent.setup();
    renderInbox();
    await screen.findByText('AC still not cooling');

    await user.type(screen.getByPlaceholderText('Search mail'), 'cooling');
    expect(screen.getByText('AC still not cooling')).toBeInTheDocument();

    await user.clear(screen.getByPlaceholderText('Search mail'));
    await user.type(screen.getByPlaceholderText('Search mail'), 'nothing matches this');
    expect(screen.getByText('Nothing here.')).toBeInTheDocument();
  });

  it('opens a conversation into the reading pane', async () => {
    const user = userEvent.setup();
    renderInbox();
    await user.click(await screen.findByText('AC still not cooling'));

    // Both the desktop and mobile-overlay reading panes are present in the
    // DOM at once (visibility is CSS-only, e.g. `lg:hidden`/`lg:flex`, which
    // jsdom doesn't apply) — assert on presence, not a single unique match.
    expect((await screen.findAllByText('Following up on the visit from last week.')).length).toBeGreaterThan(
      0,
    );
  });

  it('renders team members and groups from the directory seam', async () => {
    renderInbox();
    expect(await screen.findByText('Sam Rivera')).toBeInTheDocument();
    expect(screen.getByText('Dispatch')).toBeInTheDocument();
  });
});

describe('InboxPage — folder nav stays safe when the seed queries never resolve', () => {
  it('does not hang when email-groups/forward-rules/team-members all error (undefined data)', async () => {
    // Mirrors the environment that originally triggered the hang: a generic
    // axios mock whose response shape doesn't match what these hooks expect,
    // so react-query rejects with "Query data cannot be undefined" and `data`
    // never resolves. Suppress the resulting console.error noise from
    // react-query's dev-mode warning so it doesn't obscure real failures.
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    mockApi.get.mockResolvedValue({ data: {} } as never);
    const user = userEvent.setup();
    renderInbox();

    await user.click(folderButton('Sent'));
    await user.click(folderButton('Drafts'));
    await user.click(folderButton('Inbox'));
    expect(screen.getByText('Nothing here.')).toBeInTheDocument();

    errorSpy.mockRestore();
  });
});
