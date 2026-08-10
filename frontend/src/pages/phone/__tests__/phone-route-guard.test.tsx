/// <reference types="@testing-library/jest-dom/vitest" />
// Task A3 — the dedicated `/phone` tab (sole CTM device-owner surface) is
// gated on BOTH the org-level Communication access flag
// (useFeature('phone') — the org's plan entitlement) AND the
// user-level CASL grant (ability.can('create', 'Communication')) — never a
// hardcoded role list (master plan Global Constraints). A user failing
// EITHER check must never reach the shell; only a user passing both does.
// PhoneShell itself (the actual softphone UI + CTM device boot) is mocked
// out here — this file tests the ROUTE GUARD, not the shell's internals
// (covered separately by the Softphone/useCtmSoftphone suites).
import { describe, it, expect, vi } from 'vitest';
import { screen } from '@testing-library/react';
import { Route, Routes } from 'react-router-dom';
import { renderWithProviders } from '@/__tests__/helpers';
import { buildAbility, emptyAbility, type AppAbility } from '@/lib/ability';

vi.mock('@/lib/entitlements', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/entitlements')>()),
  useFeature: vi.fn(),
}));
vi.mock('@/pages/phone/PhoneShell', () => ({
  PhoneShell: () => <div>Phone Shell</div>,
}));

import { useFeature } from '@/lib/entitlements';
import RequireCommunicationCreate from '@/components/RequireCommunicationCreate';
import PhonePage from '@/pages/phone/PhonePage';

function Dashboard() {
  return <div>Dashboard Screen</div>;
}

function renderPhoneRoute(options: { ability: AppAbility }) {
  return renderWithProviders(
    <Routes>
      <Route path="/" element={<Dashboard />} />
      <Route element={<RequireCommunicationCreate />}>
        <Route path="/phone" element={<PhonePage />} />
      </Route>
    </Routes>,
    { initialEntries: ['/phone'], ability: options.ability },
  );
}

describe('/phone route guard (Task A3)', () => {
  it('redirects to "/" when the org lacks Communication access, even with the CASL grant', () => {
    vi.mocked(useFeature).mockReturnValue(false);
    const ability = buildAbility([{ action: 'create', subject: 'Communication' }]);

    renderPhoneRoute({ ability });

    expect(screen.getByText('Dashboard Screen')).toBeInTheDocument();
    expect(screen.queryByText('Phone Shell')).not.toBeInTheDocument();
  });

  it('redirects to "/" when the user lacks the create-Communication grant, even with org access', () => {
    vi.mocked(useFeature).mockReturnValue(true);

    renderPhoneRoute({ ability: emptyAbility });

    expect(screen.getByText('Dashboard Screen')).toBeInTheDocument();
    expect(screen.queryByText('Phone Shell')).not.toBeInTheDocument();
  });

  it('renders the /phone shell for a permitted user (org access + CASL grant)', () => {
    vi.mocked(useFeature).mockReturnValue(true);
    const ability = buildAbility([{ action: 'create', subject: 'Communication' }]);

    renderPhoneRoute({ ability });

    expect(screen.getByText('Phone Shell')).toBeInTheDocument();
    expect(screen.queryByText('Dashboard Screen')).not.toBeInTheDocument();
  });
});
