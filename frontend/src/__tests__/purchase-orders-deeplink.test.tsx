// Issue #357 — Purchase Orders page: deep-link seeding of tab + search.
//
// Contract under test:
//   • `?q=<PO>&status=<status>` (the Dialer PO-link target) lands the page on
//     the CORRECT tab for that status — sent/partial→Open, received/closed→
//     History, draft→Pre-PO — with the search box pre-populated and the
//     matching PO row VISIBLE.
//   • An old-style `?q=`-only link (no status) seeds search but leaves the
//     tab at its default (Open) — no regression.
//
// The tab assertion is mandatory: the page's text filter only applies WITHIN
// the active tab, so a received/draft PO deep-linked onto the default Open
// tab would render an empty list even with the search seeded.
import { describe, it, expect, vi } from 'vitest';
import { screen } from '@testing-library/react';
import { renderWithProviders } from './helpers';
import PurchaseOrdersPage from '@/pages/inventory/PurchaseOrdersPage';

// Mock the inventory seam DIRECTLY with stable, already-resolved data.
// Mocking axios instead would leave the hooks in a pending phase for the
// first renders, and the page's `const { data = [] } = useX()` defaults mint
// a fresh [] each render, re-firing its seed effects (`setX(seedX)` keyed on
// [seedX]) in an infinite loop that hangs jsdom. Stable references from the
// very first render sidestep the loop without touching product code.
vi.mock('@/lib/api/inventory', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api/inventory')>();
  const { purchaseOrders } = await import(
    '@/lib/api/_mock/inventory/purchase-orders'
  );
  const EMPTY: never[] = [];
  const stable =
    <T,>(data: T) =>
    () => ({ data, isLoading: false, isError: false });
  const mutation = () => ({ mutate: vi.fn(), mutateAsync: vi.fn(), isPending: false });
  // useCreatePO resolves the server envelope — the page reads the assigned
  // poNumber off the response (P0 §A).
  const createPOMutation = () => ({
    mutate: vi.fn(),
    mutateAsync: vi.fn(async (input: Record<string, unknown>) => ({
      purchaseOrder: { ...input, id: 'po_srv_1', poNumber: 'PO-02400' },
    })),
    isPending: false,
  });
  return {
    ...actual,
    usePurchaseOrders: stable(purchaseOrders),
    useEstimateReservations: stable(EMPTY),
    useInventoryJobs: stable(EMPTY),
    useVendors: stable(EMPTY),
    useInventoryItems: stable(EMPTY),
    useCategories: stable(EMPTY),
    useBrands: stable(EMPTY),
    useCreatePO: createPOMutation,
    useReceivePO: mutation,
  };
});

// ResizableTable does `new ResizeObserver(...)`; the arrow-fn mock from
// setup.ts is not constructible, so override with a class stub.
class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
global.ResizeObserver = ResizeObserverStub as unknown as typeof ResizeObserver;

function renderAt(url: string) {
  return renderWithProviders(<PurchaseOrdersPage />, {
    initialEntries: [url],
  });
}

function activeTab(name: RegExp) {
  return screen.getByRole('tab', { name });
}

describe('PurchaseOrdersPage — deep-link tab + search seeding (#357)', () => {
  it('?q=PO-2305&status=sent → Open tab active, search seeded, row visible', async () => {
    renderAt('/inventory/purchase-orders?q=PO-2305&status=sent');

    expect(
      await screen.findByText('PO-2305', undefined, { timeout: 3000 }),
    ).toBeInTheDocument();
    expect(activeTab(/^Open/)).toHaveAttribute('aria-selected', 'true');
    expect(
      screen.getByPlaceholderText('Search purchase orders…'),
    ).toHaveValue('PO-2305');
    // Only the matching PO shows in the filtered Open table
    expect(screen.queryByText('PO-2308')).not.toBeInTheDocument();
  });

  it('?q=PO-2275&status=received → History tab active, row visible (would fail on a q-only link)', async () => {
    renderAt('/inventory/purchase-orders?q=PO-2275&status=received');

    expect(
      await screen.findByText('PO-2275', undefined, { timeout: 3000 }),
    ).toBeInTheDocument();
    expect(activeTab(/History/)).toHaveAttribute('aria-selected', 'true');
    expect(
      screen.getByPlaceholderText('Search purchase orders…'),
    ).toHaveValue('PO-2275');
  });

  it('?q=PO-2317&status=draft → Pre-PO tab active, row visible', async () => {
    renderAt('/inventory/purchase-orders?q=PO-2317&status=draft');

    expect(
      await screen.findByText('PO-2317', undefined, { timeout: 3000 }),
    ).toBeInTheDocument();
    expect(activeTab(/Pre-PO/)).toHaveAttribute('aria-selected', 'true');
    expect(
      screen.getByPlaceholderText('Search purchase orders…'),
    ).toHaveValue('PO-2317');
  });

  it('old-style ?q= only (no status) seeds search and leaves the default Open tab', async () => {
    renderAt('/inventory/purchase-orders?q=PO-2305');

    expect(
      await screen.findByText('PO-2305', undefined, { timeout: 3000 }),
    ).toBeInTheDocument();
    expect(activeTab(/^Open/)).toHaveAttribute('aria-selected', 'true');
    expect(
      screen.getByPlaceholderText('Search purchase orders…'),
    ).toHaveValue('PO-2305');
  });

  it('no params → default Open tab, empty search (plain nav unchanged)', async () => {
    renderAt('/inventory/purchase-orders');

    expect(activeTab(/^Open/)).toHaveAttribute('aria-selected', 'true');
    expect(
      screen.getByPlaceholderText('Search purchase orders…'),
    ).toHaveValue('');
  });
});
