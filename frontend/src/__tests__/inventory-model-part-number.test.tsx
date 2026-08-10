// Model Number + Part Number on the Add/Edit Item dialog (Ran's 2026-08-07 ask).
//
// Contract under test:
//   - The dialog exposes both identifiers, and a create ships them as
//     `modelNumber` / `mpn` on the upsert payload.
//   - Edit prefills both from the server row and round-trips an edit.
//   - Both mount points ship them: InventoryPage (Stock > Items) and
//     PriceBookPage (Price Book > Items).
//
// `mpn` is the pre-existing column - CSV import, the Items search and the
// barcode scanner already matched on it, but no form field ever wrote one.
// `modelNumber` is the new column. Hence both are asserted, not just the new one.
//
// Seam hooks are mocked with stable resolved data (jsdom seed-loop landmine -
// see purchase-orders-deeplink.test.tsx, the sanctioned pattern).
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithProviders } from './helpers';
import InventoryPage from '@/pages/inventory/InventoryPage';
import PriceBookPage from '@/pages/inventory/PriceBookPage';
import { buildAbility } from '@/lib/ability';

const h = vi.hoisted(() => ({
  ITEM_ID: 'bbbbbbb2-0000-4000-8000-000000000001',
  upsertItemMutateAsync: vi.fn(async (p: Record<string, unknown>) => ({
    id: 'bbbbbbb2-0000-4000-8000-000000000009',
    ...p,
  })),
}));

vi.mock('@/lib/api/inventory', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api/inventory')>();
  const EMPTY: never[] = [];
  const stable =
    <T,>(data: T) =>
    () => ({ data, isLoading: false, isError: false });
  const mutation = () => ({ mutate: vi.fn(), mutateAsync: vi.fn(), isPending: false });
  const items = [
    {
      id: h.ITEM_ID,
      sku: 'LOCK-100',
      mpn: '114',
      modelNumber: 'MT5+',
      name: 'Deadbolt',
      category: 'Hardware',
      trade: 'locksmith',
      kind: 'material',
      uom: 'EA',
      unitCost: 20,
      sellPrice: 45,
      serialized: false,
      hazmat: false,
      trackInventory: false,
      status: 'active',
      vendor: 'Acme Supply',
      stock: [],
      updatedAt: '2026-07-01T00:00:00.000Z',
    },
  ];
  return {
    ...actual,
    useInventoryItems: stable(items),
    useBrands: stable(EMPTY),
    useItemGroups: stable(EMPTY),
    useCategories: stable(EMPTY),
    useVendors: stable(EMPTY),
    useLocations: stable(EMPTY),
    useBranches: stable(EMPTY),
    useJobStages: stable(EMPTY),
    useMovements: stable(EMPTY),
    useAssets: stable({ data: EMPTY, meta: { total: 0 } }),
    useLowStock: stable(EMPTY),
    useUpsertItem: () => ({
      mutate: vi.fn(),
      mutateAsync: h.upsertItemMutateAsync,
      isPending: false,
    }),
    useUpsertLocation: mutation,
    useDeleteItem: mutation,
    useRestoreItem: mutation,
    useImportItemsCSV: mutation,
    useTransferStock: mutation,
    useUpsertBrand: mutation,
    useUpsertItemGroup: mutation,
    useUpsertCategory: mutation,
    useDeleteBrand: mutation,
    useDeleteItemGroup: mutation,
    useDeleteCategory: mutation,
  };
});

const NAME_PLACEHOLDER = 'e.g. Dual Run Capacitor 45/5 MFD 440V';

const inventoryAbility = () =>
  buildAbility([
    { action: 'manage', subject: 'Inventory' },
    { action: 'read', subject: 'Invoice' },
  ]);

beforeEach(() => {
  vi.clearAllMocks();
});

describe('Add Item dialog - Model Number + Part Number', () => {
  it('InventoryPage create ships both identifiers on the upsert payload', async () => {
    renderWithProviders(<InventoryPage />, {
      initialEntries: ['/inventory'],
      ability: inventoryAbility(),
    });

    await userEvent.click(await screen.findByRole('button', { name: /Add Item/ }));
    await userEvent.type(await screen.findByPlaceholderText(NAME_PLACEHOLDER), 'New Deadbolt');
    await userEvent.type(screen.getByLabelText('Model Number'), 'MT5+');
    await userEvent.type(screen.getByLabelText('Part Number'), '114');
    await userEvent.click(screen.getByRole('button', { name: 'Save Item' }));

    expect(h.upsertItemMutateAsync).toHaveBeenCalledWith(
      expect.objectContaining({ modelNumber: 'MT5+', mpn: '114' }),
    );
  });

  it('omits both when left blank rather than sending empty strings', async () => {
    renderWithProviders(<InventoryPage />, {
      initialEntries: ['/inventory'],
      ability: inventoryAbility(),
    });

    await userEvent.click(await screen.findByRole('button', { name: /Add Item/ }));
    await userEvent.type(await screen.findByPlaceholderText(NAME_PLACEHOLDER), 'Bare Item');
    await userEvent.click(screen.getByRole('button', { name: 'Save Item' }));

    expect(h.upsertItemMutateAsync).toHaveBeenCalledWith(
      expect.objectContaining({ modelNumber: undefined, mpn: undefined }),
    );
  });

  it('PriceBookPage edit prefills both from the server row and round-trips an edit', async () => {
    renderWithProviders(<PriceBookPage />, {
      initialEntries: ['/inventory/price-book'],
      ability: inventoryAbility(),
    });

    await userEvent.click(await screen.findByText('Deadbolt'));

    const model = await screen.findByLabelText('Model Number');
    const part = screen.getByLabelText('Part Number');
    expect(model).toHaveValue('MT5+');
    expect(part).toHaveValue('114');

    await userEvent.clear(model);
    await userEvent.type(model, 'MT5-C');
    await userEvent.click(screen.getByRole('button', { name: 'Save Changes' }));

    expect(h.upsertItemMutateAsync).toHaveBeenCalledWith(
      expect.objectContaining({ id: h.ITEM_ID, modelNumber: 'MT5-C', mpn: '114' }),
    );
  });
});
