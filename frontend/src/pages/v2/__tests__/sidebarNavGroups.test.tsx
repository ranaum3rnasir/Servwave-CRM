/// <reference types="@testing-library/jest-dom/vitest" />
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { AbilityProvider } from '@/contexts/AbilityContext';
import { buildAbility } from '@/lib/ability';
import { useAuthStore } from '@/stores/auth.store';

import V2AppLayout from '../V2AppLayout';

/**
 * Inventory and Communication are EXPANDABLE GROUPS in the v2 sidebar.
 *
 * The port flattened them: the kit's nav shipped no disclosure control, so a
 * group's children were lifted to flat siblings and the parent became one more
 * link. That put four extra rows in the Operations section permanently and left
 * nothing saying which module they belonged to. The kit has a disclosure now
 * (`SidebarItem expanded`), so the group behaves as it does in the legacy
 * sidebar - the row toggles, the children are hidden until it opens, and it
 * opens itself when one of them is the current page.
 *
 * The mocks match `shellCustomizeSidebar.test.tsx`: everything the shell mounts
 * that is not the destination list.
 */

vi.mock('@/components/copilot/CopilotProvider', () => ({ default: () => null }));
vi.mock('@/components/ai-center/AiCenterModal', () => ({ AiCenterModal: () => null }));
vi.mock('@/components/communication/phone/OfficeSoftphoneWarmup', () => ({
  OfficeSoftphoneWarmup: () => null,
}));
vi.mock('@/components/communication/phone/Dialer', () => ({ GlobalDialer: () => null }));
vi.mock('@/components/notifications/NotificationBell', () => ({ NotificationBell: () => null }));
vi.mock('@/components/layout/GlobalSearch', () => ({ default: () => null }));
vi.mock('@/components/timeclock/ClockInOutMenu', () => ({ ClockInOutMenu: () => null }));
vi.mock('@/lib/api/communication', () => ({
  useUnreadCounts: () => ({ sms: 0, whatsapp: 0, email: 0 }),
}));
vi.mock('@/lib/api/organization', () => ({ useOrganization: () => ({ data: undefined }) }));

const USER_ID = '00000000-0000-0000-0000-000000000001';

/** A real (non-demo) org ADMIN whose entitlements have loaded. */
const ORG_ADMIN = {
  id: USER_ID,
  email: 'admin@test.com',
  first_name: 'Test',
  last_name: 'Admin',
  role: 'ADMIN',
  org_features: [] as string[],
};

function mockAuthUser(user: Record<string, unknown>) {
  vi.mocked(useAuthStore).mockImplementation((selector: (s: never) => unknown) =>
    selector({ user, isAuthenticated: true, isLoading: false, error: null } as never),
  );
}

function renderShell(entry = '/') {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[entry]}>
        <AbilityProvider ability={buildAbility([{ action: 'manage', subject: 'all' }])}>
          <Routes>
            <Route element={<V2AppLayout />}>
              <Route path="/" element={<div>dashboard page</div>} />
              <Route path="/inventory/vendors" element={<div>vendors page</div>} />
            </Route>
          </Routes>
        </AbilityProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

/** The group's own row - a toggle, so it is a button and not a link. */
const inventoryToggle = () => screen.getByRole('button', { name: 'Inventory' });

describe('v2 sidebar - expandable groups', () => {
  beforeEach(() => {
    localStorage.clear();
    // Inventory entitled, so the group is unlocked and has children at all.
    mockAuthUser({ ...ORG_ADMIN, org_features: ['inventory'] });
  });

  it('starts closed - the children are not in the column', () => {
    renderShell();

    expect(inventoryToggle()).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByText('Vendors')).toBeNull();
    expect(screen.queryByText('Purchase Orders')).toBeNull();
  });

  it('opens on click and reveals its children, then closes again', async () => {
    const user = userEvent.setup();
    renderShell();

    await user.click(inventoryToggle());

    expect(inventoryToggle()).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByText('Vendors')).toBeInTheDocument();
    // Stock carries the group's own href, so opening the group is still the
    // way to reach /inventory - the parent itself no longer navigates.
    expect(screen.getByText('Stock')).toBeInTheDocument();

    await user.click(inventoryToggle());
    expect(screen.queryByText('Vendors')).toBeNull();
  });

  it('navigates when a child is picked', async () => {
    const user = userEvent.setup();
    renderShell();

    await user.click(inventoryToggle());
    await user.click(screen.getByText('Vendors'));

    expect(screen.getByText('vendors page')).toBeInTheDocument();
  });

  it('opens itself when a child is the page you land on', () => {
    renderShell('/inventory/vendors');

    expect(inventoryToggle()).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByText('Vendors')).toBeInTheDocument();
    // The active row is the child, not the group - the parent is a toggle, so
    // the travelling indicator belongs to the page you are actually on. Stock
    // shares the `/inventory` prefix and must NOT light up with it.
    expect(screen.getByText('Vendors').closest('[data-slot="sidebar-item"]'))
      .toHaveAttribute('data-active', 'true');
    expect(screen.getByText('Stock').closest('[data-slot="sidebar-item"]'))
      .not.toHaveAttribute('data-active');
    expect(inventoryToggle()).not.toHaveAttribute('data-active');
  });

  it('gives a locked group no disclosure and no children', () => {
    // The entitlement bug this sidebar shipped twice, at the render layer: an
    // org without `inventory` sees one greyed row with a plan badge, and no
    // way to open anything underneath it.
    mockAuthUser(ORG_ADMIN);
    renderShell();

    const row = screen.getByText('Inventory').closest('[data-slot="sidebar-item"]');
    expect(row).toHaveAttribute('aria-disabled', 'true');
    expect(row).not.toHaveAttribute('aria-expanded');
    expect(screen.queryByText('Vendors')).toBeNull();
    expect(screen.queryByText('Purchase Orders')).toBeNull();
  });
});
