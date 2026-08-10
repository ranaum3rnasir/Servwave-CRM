// LO-3 (plan §3 Placements / spec §12 rec 4) — Inventory module "Logistic Orders" tab.
//
// Contract under test:
//   • A "Logistic Orders" ViewTab renders with a total-count pill and an amber pending-approval
//     `highlight` badge fed by a dedicated `status: PENDING_APPROVAL, limit: 1` query (`.total`).
//   • Navigating to /inventory/logistic-orders dispatches the body to the LOList surface.
//
// Inventory seam hooks are stub-mocked (same idiom as inventory-approvals-removed) so the page
// mounts without axios; useLogisticOrders is mocked to hand back deterministic totals.
import { describe, it, expect, vi } from 'vitest';
import { screen, within } from '@testing-library/react';
import { Routes, Route } from 'react-router-dom';
import { renderWithProviders } from './helpers';
import InventoryPage from '@/pages/inventory/InventoryPage';

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
    useLowStock: stable(EMPTY),
    useAssets: stable({ data: EMPTY, meta: { total: 0 } }),
    usePurchaseOrders: stable(EMPTY),
    useEstimateReservations: stable(EMPTY),
    useInventoryJobs: stable(EMPTY),
    useTechs: stable(EMPTY),
    useStockApprovals: stable(EMPTY),
    useUpsertItem: mutation,
    useUpsertLocation: mutation,
    useUpsertBranch: mutation,
    useRestock: mutation,
    useTransferStock: mutation,
    useImportItemsCSV: mutation,
    useCreatePO: mutation,
    useReceivePO: mutation,
    useCreateStage: mutation,
    useReceiveStageLine: mutation,
    useNotifyTechReady: mutation,
    useCreateApproval: mutation,
    useDecideApproval: mutation,
    useUpsertVendor: mutation,
    useDeleteVendor: mutation,
  };
});

// Pending badge = 3, total LO count = 7.
vi.mock('@/lib/api/logisticOrders', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api/logisticOrders')>();
  return {
    ...actual,
    useLogisticOrders: (filters?: { status?: string; limit?: number }) => ({
      data: {
        data: [],
        page: 1,
        limit: filters?.limit ?? 50,
        total: filters?.status === 'PENDING_APPROVAL' ? 3 : 7,
      },
      isLoading: false,
      isError: false,
    }),
  };
});

function InventoryRoutes() {
  return (
    <Routes>
      <Route path="/inventory" element={<InventoryPage />} />
      <Route path="/inventory/logistic-orders" element={<InventoryPage />} />
    </Routes>
  );
}

describe('InventoryPage — Logistic Orders tab', () => {
  it('renders the tab with a total-count pill and an amber pending-approval badge', () => {
    renderWithProviders(<InventoryRoutes />, { initialEntries: ['/inventory'] });

    const tab = screen.getByRole('button', { name: /Logistic Orders/i });
    // Total-count pill …
    expect(within(tab).getByText('7')).toBeInTheDocument();
    // … and the pending-approval highlight badge.
    expect(within(tab).getByText('3 pending')).toBeInTheDocument();
  });

  it('dispatches /inventory/logistic-orders to the LOList surface', () => {
    renderWithProviders(<InventoryRoutes />, {
      initialEntries: ['/inventory/logistic-orders'],
    });

    // LOList's empty state (its own copy) proves the body dispatched to it.
    expect(
      screen.getByText(/No logistic orders yet/),
    ).toBeInTheDocument();
  });
});
