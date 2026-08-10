// Inventory P2 §5 (D14, QA-606, QA-611) — PODetailDialog receive mode:
// destination picker (org default pre-selected, required), over-receive
// clamp + belt-and-braces submit guard, staged-PO single-receive-path
// gating, and the page-level server-authority OVER_RECEIVE branch.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithProviders } from './helpers';
import { PODetailDialog } from '@/components/inventory/PODetailDialog';
import PurchaseOrdersPage from '@/pages/inventory/PurchaseOrdersPage';
import api from '@/lib/axios';
import type { PurchaseOrder } from '@/lib/api/inventory';

const hoisted = vi.hoisted(() => {
  const LOC_MAIN_ID = 'aaaaaaa1-0000-4000-8000-000000000001';
  const LOC_VAN_ID = 'aaaaaaa2-0000-4000-8000-000000000002';
  const SENT_PO = {
    id: 'po-sent-1',
    poNumber: 'PO-2305',
    vendor: 'ADI / Anixter',
    status: 'sent' as const,
    orderedAt: '2026-05-23T00:00:00Z',
    lines: [
      { id: 'line-1', itemSku: 'SKU-001', itemName: 'Strike', uom: 'EA', qtyOrdered: 5, qtyReceived: 0, unitCost: 100 },
      { id: 'line-2', itemSku: 'SKU-002', itemName: 'Reader', uom: 'EA', qtyOrdered: 3, qtyReceived: 0, unitCost: 50 },
    ],
  };
  return {
    LOC_MAIN_ID,
    LOC_VAN_ID,
    SENT_PO,
    toast: vi.fn(),
    // Mutable org — individual tests flip the default destination on/off.
    org: { id: 'org-1', default_inventory_location_id: LOC_MAIN_ID as string | null },
  };
});

vi.mock('@/components/ui/use-toast', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/components/ui/use-toast')>();
  return { ...actual, toast: hoisted.toast };
});

vi.mock('@/lib/api/inventory', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api/inventory')>();
  const locations = [
    { id: hoisted.LOC_MAIN_ID, name: 'Main Warehouse', type: 'warehouse', branch: 'HQ' },
    { id: hoisted.LOC_VAN_ID, name: 'Van 12', type: 'truck', branch: 'HQ' },
  ];
  const EMPTY: never[] = [];
  const stable =
    <T,>(data: T) =>
    () => ({ data, isLoading: false, isError: false });
  return {
    ...actual, // useReceivePO stays REAL — the page test asserts the wire call
    useLocations: stable(locations),
    usePurchaseOrders: stable([hoisted.SENT_PO]),
    useEstimateReservations: stable(EMPTY),
    useInventoryJobs: stable(EMPTY),
    useVendors: stable(EMPTY),
    useInventoryItems: stable(EMPTY),
    useCategories: stable(EMPTY),
    useBrands: stable(EMPTY),
  };
});

vi.mock('@/lib/api/organization', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api/organization')>();
  return {
    ...actual,
    useOrganization: () => ({ data: hoisted.org, isLoading: false, isError: false }),
  };
});

class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
global.ResizeObserver = ResizeObserverStub as unknown as typeof ResizeObserver;

const SENT_PO = hoisted.SENT_PO as PurchaseOrder;

beforeEach(() => {
  vi.clearAllMocks();
  hoisted.org.default_inventory_location_id = hoisted.LOC_MAIN_ID;
});

describe('PODetailDialog — receive destination (D14)', () => {
  it('pre-selects the org default and emits { poId, destinationLocationId, lines }', async () => {
    const onReceive = vi.fn();
    renderWithProviders(
      <PODetailDialog open onClose={vi.fn()} po={SENT_PO} onReceive={onReceive} />,
    );

    await userEvent.click(screen.getByRole('button', { name: /receive items/i }));

    // Org default pre-selected in the "Receive into" picker.
    expect(screen.getByRole('combobox', { name: 'Receive into' })).toHaveTextContent(
      'Main Warehouse · HQ',
    );

    await userEvent.click(screen.getByRole('button', { name: /receive all/i }));
    await userEvent.click(screen.getByRole('button', { name: /save receipt/i }));

    expect(onReceive).toHaveBeenCalledWith({
      poId: 'po-sent-1',
      destinationLocationId: hoisted.LOC_MAIN_ID,
      lines: [
        { lineId: 'line-1', qtyReceived: 5 },
        { lineId: 'line-2', qtyReceived: 3 },
      ],
    });
    // Receive mode exits ONLY when the parent hands back the server's updated
    // PO — after a bare save the dialog is still in receive mode (§5b/§5d).
    expect(screen.getByRole('combobox', { name: 'Receive into' })).toBeInTheDocument();
  });

  it('two blank-SKU lines keep independent received quantities — no draft-key collision (D2)', async () => {
    const onReceive = vi.fn();
    const po: PurchaseOrder = {
      ...SENT_PO,
      id: 'po-free',
      lines: [
        { id: 'free-1', itemSku: '', itemName: 'Bracket', uom: 'EA', qtyOrdered: 3, qtyReceived: 0, unitCost: 7 },
        { id: 'free-2', itemSku: '', itemName: 'Shim', uom: 'EA', qtyOrdered: 2, qtyReceived: 0, unitCost: 3 },
      ],
    };
    renderWithProviders(
      <PODetailDialog open onClose={vi.fn()} po={po} onReceive={onReceive} />,
    );
    await userEvent.click(screen.getByRole('button', { name: /receive items/i }));
    await userEvent.click(screen.getByRole('button', { name: /receive all/i }));
    await userEvent.click(screen.getByRole('button', { name: /save receipt/i }));

    expect(onReceive).toHaveBeenCalledWith(
      expect.objectContaining({
        lines: [
          { lineId: 'free-1', qtyReceived: 3 },
          { lineId: 'free-2', qtyReceived: 2 },
        ],
      }),
    );
  });

  it('disables Save until a destination is picked (no org default)', async () => {
    hoisted.org.default_inventory_location_id = null;
    renderWithProviders(
      <PODetailDialog open onClose={vi.fn()} po={SENT_PO} onReceive={vi.fn()} />,
    );

    await userEvent.click(screen.getByRole('button', { name: /receive items/i }));
    expect(screen.getByRole('button', { name: /save receipt/i })).toBeDisabled();

    await userEvent.click(screen.getByRole('combobox', { name: 'Receive into' }));
    await userEvent.click(await screen.findByText('Van 12 · HQ'));
    expect(screen.getByRole('button', { name: /save receipt/i })).toBeEnabled();
  });

  it('exits receive mode when the parent passes back the updated PO object', async () => {
    const onReceive = vi.fn();
    const view = renderWithProviders(
      <PODetailDialog open onClose={vi.fn()} po={SENT_PO} onReceive={onReceive} />,
    );
    await userEvent.click(screen.getByRole('button', { name: /receive items/i }));
    await userEvent.click(screen.getByRole('button', { name: /save receipt/i }));
    expect(screen.getByRole('combobox', { name: 'Receive into' })).toBeInTheDocument();

    // Parent success path: a NEW po object identity → dialog leaves receive mode.
    const serverPO: PurchaseOrder = {
      ...SENT_PO,
      status: 'received',
      lines: SENT_PO.lines.map((l) => ({ ...l, qtyReceived: l.qtyOrdered })),
    };
    view.rerender(
      <PODetailDialog open onClose={vi.fn()} po={serverPO} onReceive={onReceive} />,
    );
    await waitFor(() =>
      expect(screen.queryByRole('combobox', { name: 'Receive into' })).not.toBeInTheDocument(),
    );
  });
});

describe('PODetailDialog — over-receive guards (QA-606)', () => {
  it('clamps typed input to the ordered quantity', async () => {
    renderWithProviders(
      <PODetailDialog open onClose={vi.fn()} po={SENT_PO} onReceive={vi.fn()} />,
    );
    await userEvent.click(screen.getByRole('button', { name: /receive items/i }));

    const inputs = screen.getAllByRole('spinbutton');
    await userEvent.clear(inputs[0]);
    await userEvent.type(inputs[0], '7');
    expect(inputs[0]).toHaveValue(5); // clamped to qtyOrdered
  });

  it('a forced-invalid draft (received > ordered from stale data) disables Save with the inline message', async () => {
    const corrupt: PurchaseOrder = {
      ...SENT_PO,
      id: 'po-corrupt',
      status: 'partial',
      lines: [{ id: 'line-x', itemSku: 'SKU-001', itemName: 'Strike', uom: 'EA', qtyOrdered: 5, qtyReceived: 7 }],
    };
    renderWithProviders(
      <PODetailDialog open onClose={vi.fn()} po={corrupt} onReceive={vi.fn()} />,
    );
    await userEvent.click(screen.getByRole('button', { name: /receive remaining/i }));

    expect(screen.getByRole('button', { name: /save receipt/i })).toBeDisabled();
    expect(screen.getByText(/Received can't exceed ordered \(line SKU-001: 7\/5\)/)).toBeInTheDocument();
  });
});

describe('PODetailDialog — staged-PO gating (QA-611)', () => {
  it('disables the receive action with the staging hint + link; receive mode is unreachable', async () => {
    const staged: PurchaseOrder = { ...SENT_PO, id: 'po-staged', stagedAsJobStageId: 'stage-1' };
    renderWithProviders(
      <PODetailDialog open onClose={vi.fn()} po={staged} onReceive={vi.fn()} />,
    );

    const disabledBtn = screen.getByRole('button', { name: /received via staging/i });
    expect(disabledBtn).toBeDisabled();
    const stagingLink = screen.getByRole('link', { name: /open staging/i });
    expect(stagingLink).toHaveAttribute('href', '/inventory/staging');

    await userEvent.click(disabledBtn);
    expect(screen.queryByRole('combobox', { name: 'Receive into' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /save receipt/i })).not.toBeInTheDocument();
  });
});

describe('PurchaseOrdersPage — server 400 OVER_RECEIVE (authority)', () => {
  it('surfaces the REAL over-receive detail and keeps the dialog in receive mode', async () => {
    // The REAL backend shape (inv-po.controller.ts): item_sku + the two quantities
    // at the TOP LEVEL — NOT a `details.lines[]` array. The prior fixture matched
    // the frontend's wrong assumption, so the toast description silently rendered
    // empty in production while the test stayed green (a tautology, D8).
    vi.spyOn(api, 'post').mockRejectedValue({
      response: {
        status: 400,
        data: { error: 'OVER_RECEIVE', item_sku: 'SKU-001', qty_ordered: 5, qty_received: 7 },
      },
    });
    renderWithProviders(<PurchaseOrdersPage />, {
      initialEntries: ['/inventory/purchase-orders?status=sent'],
    });

    await userEvent.click(await screen.findByText('PO-2305'));
    await userEvent.click(await screen.findByRole('button', { name: /receive items/i }));
    await userEvent.click(screen.getByRole('button', { name: /save receipt/i }));

    await waitFor(() =>
      expect(hoisted.toast).toHaveBeenCalledWith(
        expect.objectContaining({
          title: expect.stringMatching(/can't exceed ordered/i),
          variant: 'destructive',
          // Names the offending line AND the real quantities (5 ordered / 7 tried).
          description: expect.stringMatching(/SKU-001.*7.*5|SKU-001.*5/),
        }),
      ),
    );
    // No optimistic fold — the dialog is still in receive mode.
    expect(screen.getByRole('combobox', { name: 'Receive into' })).toBeInTheDocument();
  });
});

describe('PurchaseOrdersPage — server 409 STAGED_PO (single-receive-path)', () => {
  it('surfaces a human staging message, not the raw STAGED_PO machine code', async () => {
    // Real shape: { error, message, staged_skus[] }. Before D8 this fell through
    // to extractApiError → toast titled the literal "STAGED_PO".
    vi.spyOn(api, 'post').mockRejectedValue({
      response: {
        status: 409,
        data: { error: 'STAGED_PO', message: 'Receive staged lines via the Staging view', staged_skus: ['SKU-001'] },
      },
    });
    renderWithProviders(<PurchaseOrdersPage />, {
      initialEntries: ['/inventory/purchase-orders?status=sent'],
    });

    await userEvent.click(await screen.findByText('PO-2305'));
    await userEvent.click(await screen.findByRole('button', { name: /receive items/i }));
    await userEvent.click(screen.getByRole('button', { name: /save receipt/i }));

    await waitFor(() =>
      expect(hoisted.toast).toHaveBeenCalledWith(
        expect.objectContaining({
          title: expect.stringMatching(/staging/i),
          description: expect.stringContaining('SKU-001'),
          variant: 'destructive',
        }),
      ),
    );
    // The bare machine code must never reach the user as the toast title.
    expect(hoisted.toast).not.toHaveBeenCalledWith(
      expect.objectContaining({ title: 'STAGED_PO' }),
    );
  });
});
