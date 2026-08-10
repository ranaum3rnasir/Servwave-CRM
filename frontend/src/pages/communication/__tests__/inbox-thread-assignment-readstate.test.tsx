/// <reference types="@testing-library/jest-dom/vitest" />
// Email slice 8b (conversation assignment) + 8c (per-user read state).
//
// Contract under test (frontend half - the backend contract this locks onto
// is Slice 8b/8c's own commit, comm-whatsapp-email.controller.ts):
//   - Unassigned / Mine / All tabs on the Inbox thread list are an ADDITIONAL
//     filter (Missive's rule: assigned to one, visible to all) - GET /emails
//     already does the real filtering server-side; the frontend's job is
//     only to pass the right `assignment` view through and render whatever
//     comes back.
//   - The reading pane's Assign control PATCHes the thread (not the message)
//     with { user_id }, offering every assignable org user plus Unassigned.
//   - The unread indicator trusts the server's own per-caller `unread` field
//     verbatim - it is never re-derived client-side.
//   - Traffic Cop: a 409 THREAD_CHANGED response blocks with an explicit
//     Send anyway / Edit / Discard dialog; a clean send never shows it.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, fireEvent, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithProviders } from '@/__tests__/helpers';
import { buildAbility } from '@/lib/ability';
import { useAuthStore } from '@/stores/auth.store';
import api from '@/lib/axios';
import type { Email } from '@/lib/api/communication-shared';
import type { AssignableUser } from '@/lib/api/users';

const mockApi = vi.mocked(api);
const ADMIN = buildAbility([{ action: 'manage', subject: 'all' }]);

const CURRENT_USER_ID = 'u-current-0000-0000-0000-000000000001';
const OTHER_USER_ID = 'u-other-00000-0000-0000-000000000002';

const ASSIGNABLE_USERS: AssignableUser[] = [
  { id: CURRENT_USER_ID, first_name: 'Riley', last_name: 'Current', role: 'ADMIN', is_active: true, has_login: true, department: null },
  { id: OTHER_USER_ID, first_name: 'Casey', last_name: 'Other', role: 'DISPATCHER', is_active: true, has_login: true, department: null },
];

vi.mock('@/lib/api/users', () => ({
  useAssignableUsers: vi.fn(() => ({ data: ASSIGNABLE_USERS })),
}));

// Emails state the mocked useEmails() reads/filters from - a stand-in for
// the real server, which does this exact filtering in assignmentFilter().
const emailSeed = vi.hoisted(() => ({ current: [] as Email[] }));
// Stable reference for useEmailGroups/useForwardRules/useTeamMembers below -
// see their mock's own doc for why a fresh `[]` per call is a real bug here.
const EMPTY_SEED = vi.hoisted(() => [] as never[]);
// See useEmails' own mock doc below for why this cache exists.
const filterCache = vi.hoisted(() => ({
  source: null as Email[] | null,
  mine: [] as Email[],
  unassigned: [] as Email[],
}));
const sendMock = vi.hoisted(() => ({
  current: { mutate: vi.fn() } as {
    mutate: (v: unknown, o?: { onError?: (e: unknown) => void }) => void;
  },
}));
const assignMock = vi.hoisted(() => ({ current: { mutate: vi.fn(), isPending: false } }));
// GET /communication/sending-identity. `data: undefined` is the pre-load and
// no-access state, which is exactly when the honest placeholder should show.
const sendingIdentityMock = vi.hoisted(() => ({
  current: { data: undefined } as { data?: { address: string; name: string | null; customDomain: boolean; sendingEnabled: boolean } },
}));
const markReadMock = vi.hoisted(() => ({ current: { mutate: vi.fn() } }));

vi.mock('@/lib/api/communication', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api/communication')>();
  return {
    ...actual,
    useEmails: (assignment: 'unassigned' | 'mine' | 'all' = 'all') => {
      // Cached per assignment value, invalidated only when emailSeed.current
      // itself changes (a fresh test) - NOT recomputed on every render.
      // InboxPage re-seeds local state via `useEffect(() => setEmails(...),
      // [emailSeed])`, so a mock that hands back a freshly-`.filter()`ed
      // array on every call (a new reference with the same content) would
      // trip that effect on every render and infinite-loop, unlike the real
      // useQuery, whose `data` reference is stable across renders that don't
      // actually refetch.
      const all = emailSeed.current;
      if (filterCache.source !== all) {
        filterCache.source = all;
        filterCache.mine = all.filter((e) => e.threadAssignedToUserId === CURRENT_USER_ID);
        filterCache.unassigned = all.filter((e) => !e.threadAssignedToUserId);
      }
      if (assignment === 'mine') return { data: filterCache.mine };
      if (assignment === 'unassigned') return { data: filterCache.unassigned };
      return { data: all };
    },
    // EMPTY_SEED, not a fresh `[]` per call: InboxPage re-seeds local state off
    // each of these via `useEffect(() => setX(seed), [seed])`. A mock handing
    // back a brand-new (if content-empty) array on every render trips that
    // effect EVERY render and genuinely infinite-loops under userEvent (each
    // interaction step gives React another scheduling pass to compound it) -
    // the real useQuery-backed hooks never do this, since react-query's `data`
    // reference is stable across renders that do not actually refetch.
    useEmailGroups: () => ({ data: EMPTY_SEED }),
    useForwardRules: () => ({ data: EMPTY_SEED }),
    useTeamMembers: () => ({ data: EMPTY_SEED }),
    useMarkEmailThreadRead: () => markReadMock.current,
    useAssignEmailThread: () => assignMock.current,
    useSendEmail: () => sendMock.current,
    useSendingIdentity: () => sendingIdentityMock.current,
  };
});

import InboxPage from '@/pages/communication/InboxPage';

function baseEmail(overrides: Partial<Email> = {}): Email {
  return {
    id: 'e1',
    account: 'system',
    from: { name: 'Dana Ops', email: 'dana@example.com' },
    to: 'me@example.com',
    subject: 'Subject',
    snippet: 'snippet',
    body: ['snippet'],
    at: '9:00 AM',
    ts: 1,
    unread: false,
    starred: false,
    folder: 'inbox',
    ...overrides,
  };
}

function mockAuthedUser() {
  // Cast, not an explicit selector-parameter type, matching the established
  // pattern for this exact mock in this same directory (phone-masking-demo-
  // gate.test.tsx) - `src/__tests__` is tsc-excluded (tsconfig.json), so
  // compose-from-identity.test.tsx's near-identical Record<string, unknown>
  // spelling never actually typechecks; this file's directory is not excluded.
  vi.mocked(useAuthStore).mockImplementation((selector: unknown) =>
    (selector as (s: Record<string, unknown>) => unknown)({
      user: {
        id: CURRENT_USER_ID,
        email: 'riley@test.com',
        first_name: 'Riley',
        last_name: 'Current',
        role: 'ADMIN',
        organization_id: 'org-1',
        org_features: ['email'],
      },
      isAuthenticated: true,
      isLoading: false,
      error: null,
    }),
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  mockAuthedUser();
  emailSeed.current = [];
  sendMock.current = { mutate: vi.fn() };
  assignMock.current = { mutate: vi.fn(), isPending: false };
  markReadMock.current = { mutate: vi.fn() };
  // Fallback for the real (unmocked) hooks InlineComposer touches when a
  // reply is open (useAttachSources, useTextTemplates) - never asserted on,
  // just needs to resolve instead of throwing on an unconfigured `.then`.
  mockApi.get.mockImplementation(async () => ({ data: { templates: [] } }));
});

// Radix Dropdown/Tabs internals touch scrollIntoView, which jsdom lacks -
// same polyfill sms-inbox-job-pills.test.tsx installs for the same reason.
window.HTMLElement.prototype.scrollIntoView = vi.fn();

describe('Inbox - Unassigned / Mine / All filter tabs', () => {
  beforeEach(() => {
    emailSeed.current = [
      baseEmail({ id: 'e-unassigned', threadId: 'c0000000-0000-4000-8000-000000000003', subject: 'Needs an owner', threadAssignedToUserId: null }),
      baseEmail({ id: 'e-mine', threadId: 'c0000000-0000-4000-8000-000000000004', subject: 'My conversation', threadAssignedToUserId: CURRENT_USER_ID }),
      baseEmail({ id: 'e-other', threadId: 'c0000000-0000-4000-8000-000000000005', subject: 'Someone else has this', threadAssignedToUserId: OTHER_USER_ID }),
    ];
  });

  it('defaults to All - every thread visible regardless of assignment', () => {
    renderWithProviders(<InboxPage />, { ability: ADMIN });
    expect(screen.getByText('Needs an owner')).toBeInTheDocument();
    expect(screen.getByText('My conversation')).toBeInTheDocument();
    expect(screen.getByText('Someone else has this')).toBeInTheDocument();
  });

  it('Unassigned hides every assigned thread, mine or otherwise', async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    renderWithProviders(<InboxPage />, { ability: ADMIN });

    await user.click(screen.getByRole('tab', { name: 'Unassigned' }));

    expect(screen.getByText('Needs an owner')).toBeInTheDocument();
    expect(screen.queryByText('My conversation')).not.toBeInTheDocument();
    expect(screen.queryByText('Someone else has this')).not.toBeInTheDocument();
  });

  it('Mine shows only the signed-in user\'s own assigned threads', async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    renderWithProviders(<InboxPage />, { ability: ADMIN });

    await user.click(screen.getByRole('tab', { name: 'Mine' }));

    expect(screen.getByText('My conversation')).toBeInTheDocument();
    expect(screen.queryByText('Needs an owner')).not.toBeInTheDocument();
    expect(screen.queryByText('Someone else has this')).not.toBeInTheDocument();
  });
});

describe('Inbox - Assign control on the open thread', () => {
  beforeEach(() => {
    emailSeed.current = [
      baseEmail({ id: 'e-open', threadId: 'c0000000-0000-4000-8000-000000000002', subject: 'Please assign me', threadAssignedToUserId: null }),
    ];
  });

  // Opening the email itself uses fireEvent (plain click is enough - proven
  // stable). Opening the DropdownMenu needs real userEvent though: Radix's
  // menu trigger opens off a genuine pointerdown, which fireEvent.click alone
  // never synthesizes (confirmed by dumping the DOM mid-test - the trigger
  // button renders correctly, but a fireEvent click on it never flips
  // `aria-expanded`/mounts the menu content, so a `menuitem` query polls
  // against zero matches forever). `pointerEventsCheck: 0` matches the
  // existing precedent for this exact trigger shape in
  // sms-inbox-job-pills.test.tsx.
  //
  // getAllBy[0]/findAllBy, not getBy/findBy, for the TRIGGER specifically:
  // InboxPage renders BOTH a desktop and a CSS-hidden-on-desktop mobile copy
  // of ReadingPane simultaneously (only Tailwind's `hidden`/`lg:hidden`
  // classes distinguish them, which jsdom does not honour for query
  // purposes), so the trigger exists twice. Each DropdownMenu manages its own
  // open/closed state independently though, so once the FIRST (desktop)
  // trigger is clicked, only that copy's menu items exist in the DOM -
  // `menuitem` queries stay singular correctly.
  it('shows Unassigned by default and assigns to a picked user', async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    renderWithProviders(<InboxPage />, { ability: ADMIN });

    fireEvent.click(screen.getByText('Please assign me'));
    const [trigger] = await screen.findAllByRole('button', { name: /unassigned/i });
    await user.click(trigger!);

    const item = await screen.findByRole('menuitem', { name: 'Casey Other' });
    await user.click(item);

    expect(assignMock.current.mutate).toHaveBeenCalledWith(
      { threadId: 'c0000000-0000-4000-8000-000000000002', userId: OTHER_USER_ID },
      expect.anything(),
    );
  });

  it('clears assignment via the Unassigned menu item, sending null', async () => {
    emailSeed.current = [
      baseEmail({ id: 'e-open', threadId: 'c0000000-0000-4000-8000-000000000002', subject: 'Already assigned', threadAssignedToUserId: OTHER_USER_ID }),
    ];
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    renderWithProviders(<InboxPage />, { ability: ADMIN });

    fireEvent.click(screen.getByText('Already assigned'));
    const [trigger] = await screen.findAllByRole('button', { name: /casey other/i });
    await user.click(trigger!);

    const unassignedItem = await screen.findByRole('menuitem', { name: 'Unassigned' });
    await user.click(unassignedItem);

    expect(assignMock.current.mutate).toHaveBeenCalledWith(
      { threadId: 'c0000000-0000-4000-8000-000000000002', userId: null },
      expect.anything(),
    );
  });
});

describe('Inbox - per-user unread rendering', () => {
  it('bolds only the message the server reports unread FOR THIS CALLER, trusting the field verbatim', () => {
    emailSeed.current = [
      baseEmail({ id: 'e-read', threadId: 'c0000000-0000-4000-8000-000000000006', subject: 'Already read by me', from: { name: 'Read Sender', email: 'r@example.com' }, unread: false }),
      baseEmail({ id: 'e-unread', threadId: 'c0000000-0000-4000-8000-000000000007', subject: 'Unread for me', from: { name: 'Unread Sender', email: 'u@example.com' }, unread: true }),
    ];
    renderWithProviders(<InboxPage />, { ability: ADMIN });

    const readSenderName = screen.getByText('Read Sender');
    const unreadSenderName = screen.getByText('Unread Sender');
    expect(readSenderName.className).not.toMatch(/font-bold/);
    expect(unreadSenderName.className).toMatch(/font-bold/);
  });
});

describe('Inbox - Traffic Cop (compose-time race guard)', () => {
  const CONFLICT_MESSAGE = {
    id: 'new-msg-1',
    account: 'system',
    from: { name: 'Someone Else', email: 'someone@example.com' },
    to: 'me@example.com',
    subject: 'Re: Hi',
    snippet: 'wait, one more thing',
    body: ['wait, one more thing'],
    at: '10:05 AM',
    ts: 999,
    unread: true,
    starred: false,
    folder: 'inbox',
  };
  const CONFLICT_ERROR = {
    response: {
      status: 409,
      data: {
        error: 'This conversation has new messages - refresh before sending.',
        code: 'THREAD_CHANGED',
        messages: [CONFLICT_MESSAGE],
      },
    },
  };

  beforeEach(() => {
    emailSeed.current = [
      baseEmail({ id: 'e-orig', threadId: 'c0000000-0000-4000-8000-000000000001', subject: 'Racing thread', from: { name: 'Dana Ops', email: 'dana@example.com' } }),
    ];
  });

  // fireEvent throughout, not userEvent - the same call the codebase's own
  // WhatsAppPage honesty spec makes (whatsapp-honesty.test.tsx) when fake
  // timers are active: userEvent's realistic multi-step pointer sequence
  // never resolves against this page's render tree with `vi.useFakeTimers()`
  // active (confirmed by a bisection - the exact same click resolves fine via
  // fireEvent, and userEvent hangs even outside the fake-timer describes).
  // getAllBy[0], not getBy: same desktop+mobile ReadingPane duplication as
  // the Assign control describe above - every reading-pane/composer element
  // (Reply button, the reply textarea, Send) renders twice. Both copies are
  // controlled off the SAME `reply` state in InboxPage, so touching only the
  // first copy still updates the shared draft the second copy re-renders.
  function openAndSendReply(body: string) {
    fireEvent.click(screen.getByText('Racing thread'));
    fireEvent.click(screen.getAllByRole('button', { name: /^reply$/i })[0]!);
    const textarea = screen.getAllByPlaceholderText(/reply to dana ops/i)[0]!;
    fireEvent.change(textarea, { target: { value: body } });
    fireEvent.click(screen.getAllByRole('button', { name: /^send$/i })[0]!);
  }

  it('blocks with Send anyway / Edit / Discard when the thread changed since composing', async () => {
    vi.useFakeTimers();
    // Mirrors the real backend contract exactly (comm-whatsapp-email.
    // controller.ts's threadChangedSince): the guard only fires when
    // `composing_since` rides along. "Send anyway"'s retry deliberately
    // omits it (trafficCopSendAnyway strips it from the replayed payload),
    // so a mock that conflicted unconditionally would make the retry ALSO
    // "fail" with the same conflict, masking whether the app truly stopped
    // re-triggering it.
    sendMock.current.mutate = vi.fn((args, opts) => {
      const hasComposingSince = (args as { composing_since?: string }).composing_since != null;
      if (hasComposingSince) {
        (opts as { onError?: (e: unknown) => void } | undefined)?.onError?.(CONFLICT_ERROR);
      }
    });

    try {
      renderWithProviders(<InboxPage />, { ability: ADMIN });
      openAndSendReply('On my way over');

      // Nothing hits the network until the undo-send window elapses.
      expect(sendMock.current.mutate).not.toHaveBeenCalled();
      act(() => {
        vi.advanceTimersByTime(10_000);
      });

      expect(screen.getByText(/this conversation has new messages/i)).toBeInTheDocument();
      expect(screen.getByText('Someone Else', { exact: false })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Send anyway' })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Edit' })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Discard' })).toBeInTheDocument();

      // "Send anyway" replays the exact payload with no composing_since -
      // the guard has nothing to compare against and does not re-fire.
      fireEvent.click(screen.getByRole('button', { name: 'Send anyway' }));
      expect(sendMock.current.mutate).toHaveBeenCalledTimes(2);
      const retryArgs = (sendMock.current.mutate as ReturnType<typeof vi.fn>).mock.calls[1]![0] as Record<string, unknown>;
      expect(retryArgs.composing_since).toBeUndefined();
      expect(retryArgs.thread_id).toBe('c0000000-0000-4000-8000-000000000001');
      expect(screen.queryByText(/this conversation has new messages/i)).not.toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });

  it('Discard dismisses the conflict without retrying or reopening the composer', () => {
    vi.useFakeTimers();
    // Mirrors the real backend contract exactly (comm-whatsapp-email.
    // controller.ts's threadChangedSince): the guard only fires when
    // `composing_since` rides along. "Send anyway"'s retry deliberately
    // omits it (trafficCopSendAnyway strips it from the replayed payload),
    // so a mock that conflicted unconditionally would make the retry ALSO
    // "fail" with the same conflict, masking whether the app truly stopped
    // re-triggering it.
    sendMock.current.mutate = vi.fn((args, opts) => {
      const hasComposingSince = (args as { composing_since?: string }).composing_since != null;
      if (hasComposingSince) {
        (opts as { onError?: (e: unknown) => void } | undefined)?.onError?.(CONFLICT_ERROR);
      }
    });

    try {
      renderWithProviders(<InboxPage />, { ability: ADMIN });
      openAndSendReply('On my way over');
      act(() => {
        vi.advanceTimersByTime(10_000);
      });
      expect(screen.getByText(/this conversation has new messages/i)).toBeInTheDocument();

      fireEvent.click(screen.getByRole('button', { name: 'Discard' }));

      expect(screen.queryByText(/this conversation has new messages/i)).not.toBeInTheDocument();
      // Discard never replays the send - exactly one attempt total, ever.
      expect(sendMock.current.mutate).toHaveBeenCalledTimes(1);
      expect(screen.queryByPlaceholderText(/reply to dana ops/i)).not.toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });

  it('Edit closes the conflict and reopens the reply composer with the original draft', () => {
    vi.useFakeTimers();
    // Mirrors the real backend contract exactly (comm-whatsapp-email.
    // controller.ts's threadChangedSince): the guard only fires when
    // `composing_since` rides along. "Send anyway"'s retry deliberately
    // omits it (trafficCopSendAnyway strips it from the replayed payload),
    // so a mock that conflicted unconditionally would make the retry ALSO
    // "fail" with the same conflict, masking whether the app truly stopped
    // re-triggering it.
    sendMock.current.mutate = vi.fn((args, opts) => {
      const hasComposingSince = (args as { composing_since?: string }).composing_since != null;
      if (hasComposingSince) {
        (opts as { onError?: (e: unknown) => void } | undefined)?.onError?.(CONFLICT_ERROR);
      }
    });

    try {
      renderWithProviders(<InboxPage />, { ability: ADMIN });
      openAndSendReply('On my way over');
      act(() => {
        vi.advanceTimersByTime(10_000);
      });
      expect(screen.getByText(/this conversation has new messages/i)).toBeInTheDocument();

      fireEvent.click(screen.getByRole('button', { name: 'Edit' }));

      expect(screen.queryByText(/this conversation has new messages/i)).not.toBeInTheDocument();
      const textarea = screen.getAllByPlaceholderText(/reply to dana ops/i)[0]!;
      expect(textarea).toHaveValue('On my way over');
      // Edit never auto-retries the send either.
      expect(sendMock.current.mutate).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('never shows the conflict dialog on a clean send', () => {
    vi.useFakeTimers();
    sendMock.current.mutate = vi.fn(); // resolves happily, calls neither onError nor onSuccess

    try {
      renderWithProviders(<InboxPage />, { ability: ADMIN });
      openAndSendReply('On my way over');
      act(() => {
        vi.advanceTimersByTime(10_000);
      });

      expect(sendMock.current.mutate).toHaveBeenCalledTimes(1);
      expect(screen.queryByText(/this conversation has new messages/i)).not.toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });
});

// The reply composer used to show a flat "No mailbox connected" because nothing
// ever supplied `fromAddress` - honest when there was no per-org sending
// identity to supply, and a lie once every org had one. It told an owner that
// sending was impossible while the send path worked.
describe('Inbox - the composer names the address it will actually send from', () => {
  beforeEach(() => {
    emailSeed.current = [
      baseEmail({
        id: 'e-orig',
        threadId: 'c0000000-0000-4000-8000-000000000001',
        subject: 'Racing thread',
        from: { name: 'Dana Ops', email: 'dana@example.com' },
      }),
    ];
    sendingIdentityMock.current = { data: undefined };
  });

  function openReply() {
    fireEvent.click(screen.getByText('Racing thread'));
    fireEvent.click(screen.getAllByRole('button', { name: /^reply$/i })[0]!);
  }

  it('renders the org sending address once it resolves', () => {
    sendingIdentityMock.current = {
      data: {
        address: 'alphadoors@mail.servwave.com',
        name: 'Alpha Doors',
        customDomain: false,
        sendingEnabled: true,
      },
    };

    renderWithProviders(<InboxPage />, { ability: ADMIN });
    openReply();

    expect(screen.getAllByText('alphadoors@mail.servwave.com').length).toBeGreaterThan(0);
    expect(screen.queryByText('No mailbox connected')).not.toBeInTheDocument();
  });

  it('keeps the honest placeholder while the address is still unknown', () => {
    // Not a regression - inventing an address before we know it is the exact
    // dishonesty the placeholder exists to prevent.
    renderWithProviders(<InboxPage />, { ability: ADMIN });
    openReply();

    expect(screen.getAllByText('No mailbox connected').length).toBeGreaterThan(0);
  });
});
