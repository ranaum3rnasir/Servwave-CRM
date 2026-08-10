import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, fireEvent, waitFor, act } from '@testing-library/react';
import api from '@/lib/axios';
import { useAuthStore } from '@/stores/auth.store';
import { renderWithProviders } from './helpers';
import { buildAbility } from '@/lib/ability';
import PhoneNumbersSettingsPage from '@/pages/settings/PhoneNumbersSettingsPage';

// Slice 3 — Settings → Caller ID. Admins map users↔numbers, per-user defaults,
// and the org default; that's what the backend outbound resolver reads to pick
// the "from" number. This spec guards: render + org-default indicator, the
// assign-user mutation, the org-default mutation, and admin gating.
const mockApi = vi.mocked(api);

// Admin = manage all. Read-only viewer = read Organization but not update.
const ADMIN = buildAbility([{ action: 'manage', subject: 'all' }]);
const READ_ONLY = buildAbility([{ action: 'read', subject: 'Organization' }]);

const RESPONSE = {
  numbers: [
    {
      id: 'num-1',
      e164: '+15555550212',
      label: 'Main line',
      is_org_default: true,
      assignments: [{ user_id: 'u-emanuel', user_name: 'Emanuel Dahan', is_default: true }],
    },
    {
      id: 'num-2',
      e164: '+15555550219',
      label: 'Dispatch',
      is_org_default: false,
      assignments: [],
    },
  ],
  users: [
    { id: 'u-emanuel', name: 'Emanuel Dahan' },
    { id: 'u-ran', name: 'Art Nakamura' },
  ],
};

/** Grant communication access by mocking an org on the `phone` entitlement. */
function mockCommAccessUser() {
  vi.mocked(useAuthStore).mockImplementation((selector: (s: Record<string, unknown>) => unknown) =>
    selector({
      user: {
        id: 'u-emanuel',
        email: 'admin@test.com',
        first_name: 'Test',
        last_name: 'Admin',
        role: 'ADMIN',
        org_is_demo: true,
        organization_id: 'org-demo',
        org_features: ['phone'],
      },
      isAuthenticated: true,
      isLoading: false,
      error: null,
    }),
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  mockCommAccessUser();
  mockApi.get.mockImplementation((url: string) => {
    if (url === '/api/communication/number-assignments') {
      return Promise.resolve({ data: RESPONSE });
    }
    return Promise.resolve({ data: {} });
  });
  mockApi.put.mockResolvedValue({ data: { ok: true } });
});

describe('PhoneNumbersSettingsPage — Caller ID admin', () => {
  it('renders each number with assigned-user chips and an org-default indicator', async () => {
    renderWithProviders(<PhoneNumbersSettingsPage />, { ability: ADMIN });

    // Numbers render human-formatted (never raw E.164).
    expect(await screen.findByText('(555) 555-0212')).toBeInTheDocument();
    expect(screen.getByText('(555) 555-0219')).toBeInTheDocument();

    // Assigned-user chip is shown.
    expect(screen.getByText('Emanuel Dahan')).toBeInTheDocument();

    // Org-default indicator: exactly one number reads as the current org default
    // (its toggle offers to *remove* it), the other offers to *set* it.
    expect(
      screen.getByRole('button', { name: /remove as organization default/i }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: /set as organization default/i }),
    ).toBeInTheDocument();
  });

  it('assigning a user PUTs the new assignment set for that number', async () => {
    renderWithProviders(<PhoneNumbersSettingsPage />, { ability: ADMIN });
    await screen.findByText('(555) 555-0219');

    // Open the second number's assignment checklist (it has no users yet).
    const editButtons = screen.getAllByRole('button', { name: /edit users/i });
    fireEvent.click(editButtons[1]);

    // Check "Art Nakamura" in that number's checklist → assign them.
    const ranCheckbox = await screen.findByRole('checkbox', { name: 'Art Nakamura' });
    fireEvent.click(ranCheckbox);

    await waitFor(() =>
      expect(mockApi.put).toHaveBeenCalledWith(
        '/api/communication/numbers/num-2/assignments',
        { user_ids: ['u-ran'] },
      ),
    );
  });

  it('setting a number as org default PUTs the org-default endpoint', async () => {
    renderWithProviders(<PhoneNumbersSettingsPage />, { ability: ADMIN });
    await screen.findByText('(555) 555-0219');

    // The second number is not the org default yet.
    fireEvent.click(screen.getByRole('button', { name: /set as organization default/i }));

    await waitFor(() =>
      expect(mockApi.put).toHaveBeenCalledWith(
        '/api/communication/numbers/num-2/org-default',
        { is_org_default: true },
      ),
    );
  });

  it("toggling a user's default-number star PUTs the default-number endpoint (set + clear) — the at-most-one-per-user invariant, wired from the UI", async () => {
    // num-1 has two assigned users: Emanuel is already the default, Ran is
    // assigned but not the default — covers both the "set" and "clear" edges.
    mockApi.get.mockImplementation((url: string) => {
      if (url === '/api/communication/number-assignments') {
        return Promise.resolve({
          data: {
            numbers: [
              {
                id: 'num-1',
                e164: '+15555550212',
                label: 'Main line',
                is_org_default: true,
                assignments: [
                  { user_id: 'u-emanuel', user_name: 'Emanuel Dahan', is_default: true },
                  { user_id: 'u-ran', user_name: 'Art Nakamura', is_default: false },
                ],
              },
            ],
            users: RESPONSE.users,
          },
        });
      }
      return Promise.resolve({ data: {} });
    });

    renderWithProviders(<PhoneNumbersSettingsPage />, { ability: ADMIN });
    await screen.findByText('(555) 555-0212');

    // Ran is assigned but not default → clicking his star makes him default.
    fireEvent.click(screen.getByRole('button', { name: "Make this Art Nakamura's default number" }));
    await waitFor(() =>
      expect(mockApi.put).toHaveBeenCalledWith('/api/communication/users/u-ran/default-number', {
        phone_number_id: 'num-1',
      }),
    );

    // Emanuel IS default → clicking his star clears it (never a swap, always
    // clear-then-set, so two users can't both read as default at once).
    fireEvent.click(
      screen.getByRole('button', { name: "Clear Emanuel Dahan's default number" }),
    );
    await waitFor(() =>
      expect(mockApi.put).toHaveBeenCalledWith(
        '/api/communication/users/u-emanuel/default-number',
        { phone_number_id: null },
      ),
    );
  });

  it('a non-admin (read-only) is fully gated: the admin data is NEVER fetched and no controls render', async () => {
    renderWithProviders(<PhoneNumbersSettingsPage />, { ability: READ_ONLY });

    // Flush enough that an *enabled* query would have fired its queryFn on mount.
    await act(async () => {
      await new Promise((r) => setTimeout(r, 20));
    });

    // The discriminator: the disabled query never hits the admin endpoint. (This
    // fails if the fetch gate is removed — unlike a bare absence-during-loading check.)
    expect(mockApi.get).not.toHaveBeenCalledWith('/api/communication/number-assignments');
    // No management controls can render — they only exist in the data branch.
    expect(screen.queryByRole('button', { name: /edit users/i })).toBeNull();
    expect(screen.queryByText('(555) 555-0212')).toBeNull();
  });

  it('shows the manual CTM-scaffold guidance after a successful assignment (Task D2)', async () => {
    mockApi.put.mockResolvedValue({
      data: {
        ok: true,
        routing: {
          synced: true,
          voice_menu_id: 'VOM1',
          voice_menu_name: 'Art Nakamura — Voicemail',
          manual_scaffold: {
            title: 'One-time setup step needed for (555) 555-0219',
            summary:
              'One call-routing step still has to be completed by ServWave support. Contact support with the details below.',
            steps: [
              'Number to set up: (555) 555-0219.',
              'Ring this number to: "Art Nakamura".',
              'Send unanswered calls to voicemail box "Art Nakamura — Voicemail" (reference: VOM1).',
            ],
          },
        },
      },
    });

    renderWithProviders(<PhoneNumbersSettingsPage />, { ability: ADMIN });
    await screen.findByText('(555) 555-0219');

    const editButtons = screen.getAllByRole('button', { name: /edit users/i });
    fireEvent.click(editButtons[1]);
    const ranCheckbox = await screen.findByRole('checkbox', { name: 'Art Nakamura' });
    fireEvent.click(ranCheckbox);

    expect(
      await screen.findByText('One-time setup step needed for (555) 555-0219'),
    ).toBeInTheDocument();
    expect(screen.getByText(/VOM1/)).toBeInTheDocument();
    expect(screen.getByText(/Art Nakamura — Voicemail/)).toBeInTheDocument();
    expect(screen.getByText(/Number to set up: \(555\) 555-0219/)).toBeInTheDocument();
  });

  it('shows a plain warning (no scaffold) when the routing sync did not happen (synced:false)', async () => {
    mockApi.put.mockResolvedValue({
      data: {
        ok: true,
        routing: { synced: false, reason: 'Organization is not connected to a phone system.' },
      },
    });

    renderWithProviders(<PhoneNumbersSettingsPage />, { ability: ADMIN });
    await screen.findByText('(555) 555-0219');

    fireEvent.click(screen.getByRole('button', { name: /set as organization default/i }));

    expect(
      await screen.findByText(/Organization is not connected to a phone system\./),
    ).toBeInTheDocument();
  });

  it('the guidance panel is dismissible', async () => {
    mockApi.put.mockResolvedValue({
      data: {
        ok: true,
        routing: {
          synced: true,
          voice_menu_id: 'VOM1',
          voice_menu_name: 'Voicemail',
          manual_scaffold: {
            title: 'One-time setup step needed for (555) 555-0219',
            summary: 'summary text',
            steps: ['step one'],
          },
        },
      },
    });

    renderWithProviders(<PhoneNumbersSettingsPage />, { ability: ADMIN });
    await screen.findByText('(555) 555-0219');
    fireEvent.click(screen.getByRole('button', { name: /set as organization default/i }));

    const panelTitle = await screen.findByText('One-time setup step needed for (555) 555-0219');
    expect(panelTitle).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /dismiss/i }));
    await waitFor(() =>
      expect(
        screen.queryByText('One-time setup step needed for (555) 555-0219'),
      ).toBeNull(),
    );
  });

  it('a comm-disabled org is gated even for a full admin (no admin fetch, no controls)', async () => {
    // Admin ability, but the org lacks the `phone` entitlement → useFeature('phone')
    // = false. org_features must be explicit here (an empty array, not omitted) —
    // useFeature fails OPEN when org_features is undefined (unknown ≠ denied), so
    // omitting it would make this org look entitled and defeat the test.
    vi.mocked(useAuthStore).mockImplementation((selector: (s: Record<string, unknown>) => unknown) =>
      selector({
        user: {
          id: 'u-real', email: 'admin@real.com', first_name: 'Real', last_name: 'Admin',
          role: 'ADMIN', org_is_demo: false, organization_id: 'org-real', org_features: [],
        },
        isAuthenticated: true, isLoading: false, error: null,
      }),
    );

    renderWithProviders(<PhoneNumbersSettingsPage />, { ability: ADMIN });

    await act(async () => {
      await new Promise((r) => setTimeout(r, 20));
    });

    expect(mockApi.get).not.toHaveBeenCalledWith('/api/communication/number-assignments');
    expect(screen.queryByRole('button', { name: /edit users/i })).toBeNull();
  });
});
