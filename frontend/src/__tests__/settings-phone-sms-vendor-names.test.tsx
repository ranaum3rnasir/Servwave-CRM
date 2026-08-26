// Settings -> Phone & SMS, guarding the naming boundary in CLAUDE.md: no vendor
// or customer name is visible to a user, and no provider account identifier is
// ever rendered.
//
// The page shipped naming the telephony vendor in five places and printing the
// vendor account id on screen. It also asked an unconfigured org to type that
// account id into a labelled field, which cannot be de-branded - the value IS
// the vendor's identifier - so provisioning moved to ops and the form is gone.
//
// The assertions read the whole rendered DOM rather than named elements on
// purpose: a future edit that reintroduces the vendor anywhere on this page
// should fail here, not only an edit to the strings this test knows about.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen } from '@testing-library/react';
import api from '@/lib/axios';
import { buildAbility } from '@/lib/ability';
import { renderWithProviders } from './helpers';
import PhoneSmsPage from '@/pages/v2/settings/PhoneSmsPage';

const mockApi = vi.mocked(api);

const adminAbility = buildAbility([{ action: 'update', subject: 'Organization' }]);

/** The provider account id as it really looks - six digits, and a plausible
 *  substring of unrelated copy only if the page prints it verbatim. */
const ACCOUNT_ID = '596375';

const BANNED = [/\bCTM\b/i, /CallTrackingMetrics/i, /A2P/i, /sub-account/i, /Alpha Doors/i];

function mockOrg(over: { ctm_account_id?: string | null; ctm_sms_ready?: boolean } = {}) {
  mockApi.get.mockImplementation(async (url: string) => {
    if (url === '/api/organization') {
      return {
        data: {
          id: '00000000-0000-0000-0000-000000000001',
          name: 'Test Org',
          ctm_account_id: 'ctm_account_id' in over ? over.ctm_account_id : ACCOUNT_ID,
          ctm_sms_ready: over.ctm_sms_ready ?? true,
        },
      };
    }
    return { data: {} };
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mockOrg();
});

const render = () => renderWithProviders(<PhoneSmsPage />, { ability: adminAbility });

describe('PhoneSmsPage - the provider is never named or identified', () => {
  it('names no vendor and prints no account id when the service is active', async () => {
    render();
    expect(await screen.findByText('Phone System')).toBeInTheDocument();

    const text = document.body.textContent ?? '';
    for (const banned of BANNED) expect(text).not.toMatch(banned);
    expect(text).not.toContain(ACCOUNT_ID);
  });

  it('shows the service as active without exposing how it is wired', async () => {
    render();
    // Two Active badges: the phone service and, because sms_ready is true here,
    // text messaging. Both are status, neither is an identifier.
    expect(await screen.findAllByText('Active')).toHaveLength(2);
    expect(screen.getByRole('button', { name: /turn off/i })).toBeInTheDocument();
  });

  it('reports a pending carrier registration without naming the campaign type', async () => {
    mockOrg({ ctm_sms_ready: false });
    render();

    expect(await screen.findByText('Pending registration')).toBeInTheDocument();
    expect(screen.getByText('Awaiting carrier approval')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /refresh status/i })).toBeInTheDocument();
    expect(document.body.textContent ?? '').not.toMatch(/A2P/i);
  });

  it('points an unconfigured org at support instead of asking for an account id', async () => {
    mockOrg({ ctm_account_id: null });
    render();

    expect(await screen.findByText(/contact support to\s+enable it/i)).toBeInTheDocument();
    // The account-id field is the whole reason this branch changed: an input
    // here would be a labelled vendor identifier no matter what it is called.
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^connect$/i })).not.toBeInTheDocument();
  });

  it('does not tell the customer that anything is configured outside ServWave', async () => {
    render();
    expect(await screen.findByText('Phone System')).toBeInTheDocument();

    const text = document.body.textContent ?? '';
    expect(text).not.toMatch(/dashboard/i);
    expect(text).not.toMatch(/manual setup/i);
    expect(text).not.toMatch(/recording-consent/i);
  });
});
