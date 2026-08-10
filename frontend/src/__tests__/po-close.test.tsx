// D3 — PODetailDialog "Close PO" action: a received PO closes without a
// confirm; a partial PO force-closes behind a window.confirm (open items).
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithProviders } from './helpers';
import { PODetailDialog } from '@/components/inventory/PODetailDialog';
import api from '@/lib/axios';
import type { PurchaseOrder } from '@/lib/api/inventory';

const hoisted = vi.hoisted(() => ({
  LOC_MAIN_ID: 'aaaaaaa1-0000-4000-8000-000000000001',
  org: { id: 'org-1', default_inventory_location_id: 'aaaaaaa1-0000-4000-8000-000000000001' as string | null },
}));

vi.mock('@/lib/api/inventory', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api/inventory')>();
  const EMPTY: never[] = [];
  const stable =
    <T,>(data: T) =>
    () => ({ data, isLoading: false, isError: false });
  return {
    ...actual, // useUpdatePO stays REAL — the test asserts the PATCH wire call
    useLocations: stable([{ id: hoisted.LOC_MAIN_ID, name: 'Main Warehouse', type: 'warehouse', branch: 'HQ' }]),
    usePurchaseOrders: stable(EMPTY),
    useVendors: stable(EMPTY),
    useInventoryItems: stable(EMPTY),
    useBranches: stable(EMPTY),
  };
});

vi.mock('@/lib/api/organization', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api/organization')>();
  return { ...actual, useOrganization: () => ({ data: hoisted.org, isLoading: false, isError: false }) };
});

class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
global.ResizeObserver = ResizeObserverStub as unknown as typeof ResizeObserver;

const RECEIVED_PO: PurchaseOrder = {
  id: 'po-recv-1', poNumber: 'PO-9001', vendor: 'Acme', status: 'received', orderedAt: '2026-05-20T00:00:00Z',
  lines: [{ id: 'l1', itemSku: 'A', itemName: 'Item A', uom: 'EA', qtyOrdered: 5, qtyReceived: 5, unitCost: 10 }],
};
const PARTIAL_PO: PurchaseOrder = {
  id: 'po-part-1', poNumber: 'PO-9002', vendor: 'Acme', status: 'partial', orderedAt: '2026-05-20T00:00:00Z',
  lines: [{ id: 'l1', itemSku: 'A', itemName: 'Item A', uom: 'EA', qtyOrdered: 5, qtyReceived: 2, unitCost: 10 }],
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe('PODetailDialog — Close PO (D3)', () => {
  it('received PO: Close PO patches status:closed without a confirm', async () => {
    const patchSpy = vi.spyOn(api, 'patch').mockResolvedValue({ data: { purchaseOrder: {} } });
    renderWithProviders(<PODetailDialog open onClose={vi.fn()} po={RECEIVED_PO} onReceive={vi.fn()} />);

    await userEvent.click(screen.getByRole('button', { name: /close po/i }));
    expect(patchSpy).toHaveBeenCalledWith('/api/inventory/purchase-orders/po-recv-1', { status: 'closed' });
  });

  it('partial PO: Close PO asks to confirm; proceeds only when confirmed', async () => {
    const patchSpy = vi.spyOn(api, 'patch').mockResolvedValue({ data: { purchaseOrder: {} } });
    const confirmSpy = vi.spyOn(window, 'confirm');
    renderWithProviders(<PODetailDialog open onClose={vi.fn()} po={PARTIAL_PO} onReceive={vi.fn()} />);

    // Cancel path.
    await userEvent.click(screen.getByRole('button', { name: /close po/i }));
    expect(await screen.findByText(/still open - close this PO anyway\?/i)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(patchSpy).not.toHaveBeenCalled(); // cancelled at the confirm

    // Confirm path.
    await userEvent.click(screen.getByRole('button', { name: /close po/i }));
    await userEvent.click(await screen.findByRole('button', { name: 'Close anyway' }));
    expect(patchSpy).toHaveBeenCalledWith('/api/inventory/purchase-orders/po-part-1', { status: 'closed' });

    // The prompt is the app's own dialog now, never the browser's.
    expect(confirmSpy).not.toHaveBeenCalled();
  });
});
