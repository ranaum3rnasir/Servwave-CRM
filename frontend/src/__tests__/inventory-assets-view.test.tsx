// Inventory P4 — Assets tab (AssetsView inside InventoryPage).
//
// Contract under test:
//   • /inventory/assets deep-links onto the Assets view (route → view mapping)
//     and the table renders name/serial/status/assignee/updated per row.
//   • Retired filter: the default query sends status ACTIVE; ticking "Show
//     retired" re-queries WITHOUT status and the RETIRED pill row appears.
//   • Row click opens the history drawer: timeline rows render in server
//     order with type labels + actor names; a null by_user (hard-deleted
//     actor) renders "Unknown user".
//
// The inventory seam is mocked DIRECTLY with stable, already-resolved data —
// never axios — per the jsdom seed-loop learning (template:
// purchase-orders-deeplink.test.tsx).
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, fireEvent, waitFor, within } from '@testing-library/react';
import { renderWithProviders } from './helpers';
import InventoryPage from '@/pages/inventory/InventoryPage';

const h = vi.hoisted(() => {
  const ACTIVE_ASSET = {
    id: 'a0000000-0000-0000-0000-00000000a001',
    name: 'DeWalt Hammer Drill',
    serial: 'SN-100',
    status: 'ACTIVE' as const,
    notes: null,
    photo_url: null,
    price_book_item: { id: 'b0000000-0000-0000-0000-00000000b001', name: 'Hammer Drill 20V' },
    assigned_user: { id: 'u0000000-0000-0000-0000-00000000u001', first_name: 'John', last_name: 'Tech' },
    created_at: '2026-07-01T00:00:00.000Z',
    updated_at: '2026-07-10T00:00:00.000Z',
  };
  const RETIRED_ASSET = {
    id: 'a0000000-0000-0000-0000-00000000a002',
    name: 'Old Jigsaw',
    serial: 'SN-200',
    status: 'RETIRED' as const,
    notes: null,
    photo_url: null,
    price_book_item: null,
    assigned_user: null,
    created_at: '2026-06-01T00:00:00.000Z',
    updated_at: '2026-06-20T00:00:00.000Z',
  };
  // Stable response objects — the mock returns the SAME reference per filter
  // shape so no render loop can start from fresh identities.
  const ACTIVE_RESP = {
    data: { data: [ACTIVE_ASSET], meta: { total: 1 } },
    isLoading: false,
    isError: false,
  };
  const ALL_RESP = {
    data: { data: [ACTIVE_ASSET, RETIRED_ASSET], meta: { total: 2 } },
    isLoading: false,
    isError: false,
  };
  const EVENTS = [
    // Server order (at desc): newest first.
    {
      id: 'e0000000-0000-0000-0000-00000000e002',
      type: 'NOTE' as const,
      note: 'Chuck is wobbly',
      at: '2026-07-11T10:00:00.000Z',
      user: null,
      by_user: null, // hard-deleted actor → "Unknown user"
    },
    {
      id: 'e0000000-0000-0000-0000-00000000e001',
      type: 'ASSIGNED' as const,
      note: null,
      at: '2026-07-10T09:00:00.000Z',
      user: { id: 'u0000000-0000-0000-0000-00000000u001', first_name: 'John', last_name: 'Tech' },
      by_user: { id: 'u0000000-0000-0000-0000-00000000u009', first_name: 'Ana', last_name: 'Admin' },
    },
  ];
  const USERS = [
    {
      id: 'u0000000-0000-0000-0000-00000000u001',
      email: 'john@x.com', first_name: 'John', last_name: 'Tech', role: 'TECHNICIAN',
      is_active: true, has_login: true, phone: null, phone_ext: null,
      department_id: null, department: null,
      enforce_clock_in_location: false, can_approve_clock_overrides: false,
      created_at: '2026-01-01T00:00:00.000Z', updated_at: '2026-01-01T00:00:00.000Z',
    },
  ];
  return {
    ACTIVE_ASSET,
    RETIRED_ASSET,
    EVENTS,
    USERS,
    useAssetsMock: vi.fn((filters?: { status?: string }) =>
      filters?.status === 'ACTIVE' ? ACTIVE_RESP : ALL_RESP,
    ),
  };
});

vi.mock('@/lib/api/inventory', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api/inventory')>();
  const EMPTY: never[] = [];
  const stable =
    <T,>(data: T) =>
    () => ({ data, isLoading: false, isError: false });
  const mutation = () => ({ mutate: vi.fn(), mutateAsync: vi.fn(), isPending: false });
  return {
    ...actual,
    useInventoryItems: stable(EMPTY),
    useLocations: stable(EMPTY),
    useVendors: stable(EMPTY),
    useCategories: stable(EMPTY),
    useBranches: stable(EMPTY),
    useBrands: stable(EMPTY),
    useJobStages: stable(EMPTY),
    useMovements: stable(EMPTY),
    usePurchaseOrders: stable(EMPTY),
    useUpsertItem: mutation,
    useAssets: h.useAssetsMock,
    useAssetEvents: stable(h.EVENTS),
    useCreateAsset: mutation,
    useUpdateAsset: mutation,
    useDeleteAsset: mutation,
    useAssetAction: mutation,
    useUploadAssetPhoto: mutation,
  };
});

vi.mock('@/lib/api/users', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api/users')>();
  return {
    ...actual,
    useUsers: () => ({ data: h.USERS, isLoading: false, isError: false }),
  };
});

function renderAssetsView() {
  return renderWithProviders(<InventoryPage />, {
    initialEntries: ['/inventory/assets'],
  });
}

describe('InventoryPage — Assets tab (P4)', () => {
  beforeEach(() => {
    h.useAssetsMock.mockClear();
  });

  it('deep-links /inventory/assets onto the Assets view and renders the table row', async () => {
    renderAssetsView();

    // Assets view is active (its search box), items view is not.
    expect(await screen.findByPlaceholderText('Search assets…')).toBeInTheDocument();
    expect(screen.queryByPlaceholderText('Search inventory…')).not.toBeInTheDocument();

    // Row cells: name / catalog subtext / serial / status / assignee / updated.
    // Scoped to the table — "John Tech" also exists as an assignee-filter option.
    const table = within(screen.getByRole('table'));
    expect(table.getByText('DeWalt Hammer Drill')).toBeInTheDocument();
    expect(table.getByText('Hammer Drill 20V')).toBeInTheDocument();
    expect(table.getByText('SN-100')).toBeInTheDocument();
    expect(table.getByText('Active')).toBeInTheDocument();
    expect(table.getByText('John Tech')).toBeInTheDocument();
    expect(
      table.getByTitle(new Date(h.ACTIVE_ASSET.updated_at).toLocaleString()),
    ).toBeInTheDocument();
  });

  it('retired filter: defaults to status ACTIVE, toggling re-queries without status and shows the RETIRED pill', async () => {
    renderAssetsView();
    await screen.findByText('DeWalt Hammer Drill');

    // Default: every query so far carried status ACTIVE — retired row hidden.
    expect(h.useAssetsMock.mock.calls.length).toBeGreaterThan(0);
    expect(
      h.useAssetsMock.mock.calls.every((c) => c[0]?.status === 'ACTIVE'),
    ).toBe(true);
    expect(screen.queryByText('Old Jigsaw')).not.toBeInTheDocument();

    fireEvent.click(screen.getByLabelText('Show retired'));

    // Re-query dropped the status key (all rows) and the retired row renders.
    await screen.findByText('Old Jigsaw');
    expect(
      h.useAssetsMock.mock.calls.some((c) => c[0] && !('status' in c[0])),
    ).toBe(true);
    expect(screen.getByText('Retired')).toBeInTheDocument();
  });

  it('row click opens the history drawer with the timeline in order; null by_user renders "Unknown user"', async () => {
    renderAssetsView();
    fireEvent.click(await screen.findByText('DeWalt Hammer Drill'));

    await screen.findByText('History');
    await waitFor(() => {
      const rows = screen.getAllByRole('listitem');
      expect(rows).toHaveLength(2);
      // Server order preserved: newest (NOTE) first.
      expect(rows[0]).toHaveTextContent('Note');
      expect(rows[0]).toHaveTextContent('Chuck is wobbly');
      expect(rows[0]).toHaveTextContent('Unknown user');
      expect(rows[1]).toHaveTextContent('Assigned');
      expect(rows[1]).toHaveTextContent('John Tech');
      expect(rows[1]).toHaveTextContent('Ana Admin');
    });
  });
});
