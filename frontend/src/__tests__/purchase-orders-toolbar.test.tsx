// Phase 11a "pattern-toolbar" batch — pins the byte-exact rendered class
// strings of the Toolbar-adopted search+filter row on PurchaseOrdersPage,
// matching the rigor components/patterns/__tests__/Toolbar.test.tsx already
// established for the pattern itself. This is the page-level half: proof
// that adopting Toolbar on a real call site renders exactly what the
// pattern's own unit tests say it should, with no stray appearance class
// slipping in through the page's `className` prop.
import { describe, it, expect, vi } from 'vitest';
import { screen } from '@testing-library/react';
import { renderWithProviders } from './helpers';
import PurchaseOrdersPage from '@/pages/inventory/PurchaseOrdersPage';

const cls = (el: Element | null) => el?.getAttribute('class') ?? '';

// Every data + mutation seam PurchaseOrdersPage reads goes through a stable,
// empty resolved query so the page renders its header/search-row shell with
// no live network activity - the same shape vendor-archive.test.tsx uses for
// VendorsPage. `vi.hoisted` because `vi.mock`'s factory is itself hoisted
// above these declarations.
const hoisted = vi.hoisted(() => {
  const EMPTY: never[] = [];
  const stableQuery =
    <T,>(data: T) =>
    () => ({ data, isLoading: false, isError: false });
  const noopMutation = () => ({
    mutate: () => {},
    mutateAsync: async () => undefined,
    isPending: false,
  });
  return { EMPTY, stableQuery, noopMutation };
});

vi.mock('@/lib/api/inventory', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api/inventory')>();
  const { EMPTY, stableQuery, noopMutation } = hoisted;
  return {
    ...actual,
    usePurchaseOrders: stableQuery(EMPTY),
    useEstimateReservations: stableQuery(EMPTY),
    useInventoryJobs: stableQuery(EMPTY),
    useVendors: stableQuery(EMPTY),
    useInventoryItems: stableQuery(EMPTY),
    useCategories: stableQuery(EMPTY),
    useBrands: stableQuery(EMPTY),
    useLocations: stableQuery(EMPTY),
    useCreatePO: noopMutation,
    useReceivePO: noopMutation,
    useConvertReservation: noopMutation,
    useDismissReservation: noopMutation,
  };
});

class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
global.ResizeObserver = ResizeObserverStub as unknown as typeof ResizeObserver;

describe('PurchaseOrdersPage - Toolbar-adopted search+filter row (phase 11a)', () => {
  it('renders the search Input through the shared primitive with the exact xs/pl-8 class string', () => {
    renderWithProviders(<PurchaseOrdersPage />);
    const box = screen.getByPlaceholderText('Search purchase orders…');
    expect(box.tagName).toBe('INPUT');
    expect(cls(box)).toBe(
      'flex w-full rounded border-2 border-transparent bg-text-primary/5 px-4 py-2 transition-colors duration-300 file:border-0 file:bg-transparent file:text-sm file:font-medium file:text-text-primary placeholder:text-text-soft hover:border-primary focus-visible:outline-none focus-visible:border-primary disabled:cursor-not-allowed disabled:opacity-50 md:text-sm h-8 text-sm pl-8',
    );
  });

  it('wraps the caller-supplied Search icon in Toolbar\'s own LAYOUT-only positioning slot', () => {
    renderWithProviders(<PurchaseOrdersPage />);
    const box = screen.getByPlaceholderText('Search purchase orders…');
    const searchWrapper = box.parentElement as HTMLElement;
    expect(cls(searchWrapper)).toBe('relative min-w-[240px] flex-1');
    const icon = searchWrapper.querySelector('svg') as SVGElement;
    const iconWrapper = icon.parentElement as HTMLElement;
    expect(cls(iconWrapper)).toBe('pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2');
    expect(cls(icon)).toBe('lucide lucide-search h-3.5 w-3.5 text-text-secondary');
  });

  it('renders the Toolbar root row with the page\'s border/bg/padding merged onto Inline\'s own flex classes', () => {
    renderWithProviders(<PurchaseOrdersPage />);
    const box = screen.getByPlaceholderText('Search purchase orders…');
    // search wrapper -> Toolbar's own Inline root
    const toolbarRoot = box.parentElement?.parentElement as HTMLElement;
    expect(cls(toolbarRoot)).toBe(
      'flex flex-row flex-wrap gap-2 items-center border-b border-border bg-surface-light px-6 py-3',
    );
  });
});
