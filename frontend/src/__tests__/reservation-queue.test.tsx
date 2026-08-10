// Inventory P2 §4 (QA-601/602) — reservation queue lifecycle on the Purchase
// Orders Pre-PO tab.
//
// Contract under test:
//   • Default rows show OPEN reservations only; "Show resolved" reveals
//     converted/dismissed with their status pills.
//   • Convert fires POST /api/inventory/estimate-reservations/:id/convert and
//     NEVER the old client-mapped POST /api/inventory/purchase-orders (the
//     reservationToDraftPO path is deleted).
//   • Dismiss requires the two-step inline confirm and sends {reason} when typed.
//   • A converted row's "View PO →" opens PODetailDialog for the linked PO.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithProviders } from './helpers';
import PurchaseOrdersPage from '@/pages/inventory/PurchaseOrdersPage';
import api from '@/lib/axios';
import type { EstimateReservation, PurchaseOrder } from '@/lib/api/inventory';

const hoisted = vi.hoisted(() => {
  const CONV_PO = {
    id: 'po-conv-1',
    poNumber: 'PO-02412',
    vendor: 'ADI / Anixter',
    status: 'sent' as const,
    orderedAt: '2026-05-20T00:00:00Z',
    lines: [
      { itemSku: 'SKU-001', itemName: 'Strike', uom: 'EA', qtyOrdered: 2, qtyReceived: 0, unitCost: 100 },
    ],
  };
  const reservation = (overrides: Record<string, unknown>) => ({
    id: 'res-x',
    estimateNumber: 'EST-0000',
    customer: 'Some Customer',
    approvedAt: '2026-05-25T00:00:00Z',
    reservedTotal: 1000,
    linesSummary: { items: 1, units: 2 },
    lines: [{ itemSku: 'SKU-001', itemName: 'Strike', qty: 2, uom: 'EA' }],
    emails: [],
    status: 'open' as const,
    ...overrides,
  });
  return {
    toast: vi.fn(),
    CONV_PO,
    OPEN_RES: reservation({
      id: 'res-open-1',
      estimateNumber: 'EST-5521',
      customer: 'PS-321',
      estimateStatus: 'WON',
      leadStatus: 'LOST',
    }),
    CONV_RES: reservation({
      id: 'res-conv-1',
      estimateNumber: 'EST-5524',
      customer: 'Hudson Yards',
      status: 'converted',
      convertedPurchaseOrderId: CONV_PO.id,
      convertedPoNumber: CONV_PO.poNumber,
    }),
    DISM_RES: reservation({
      id: 'res-dism-1',
      estimateNumber: 'EST-5530',
      customer: 'Brooklyn Brewery',
      status: 'dismissed',
    }),
  };
});
const CONV_PO = hoisted.CONV_PO as PurchaseOrder;
const OPEN_RES = hoisted.OPEN_RES as EstimateReservation;

vi.mock('@/components/ui/use-toast', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/components/ui/use-toast')>();
  return { ...actual, toast: hoisted.toast };
});

// Stable resolved seam mocks (jsdom seed-loop learning). The convert/dismiss
// MUTATION hooks stay REAL so the axios spy asserts the exact URLs.
vi.mock('@/lib/api/inventory', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api/inventory')>();
  const EMPTY: never[] = [];
  const stable =
    <T,>(data: T) =>
    () => ({ data, isLoading: false, isError: false });
  return {
    ...actual,
    usePurchaseOrders: stable([hoisted.CONV_PO]),
    useEstimateReservations: stable([hoisted.OPEN_RES, hoisted.CONV_RES, hoisted.DISM_RES]),
    useInventoryJobs: stable(EMPTY),
    useVendors: stable(EMPTY),
    useInventoryItems: stable(EMPTY),
    useCategories: stable(EMPTY),
    useBrands: stable(EMPTY),
    useLocations: stable(EMPTY),
  };
});

vi.mock('@/lib/api/organization', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api/organization')>();
  const org = { id: 'org-1', default_inventory_location_id: null };
  return { ...actual, useOrganization: () => ({ data: org, isLoading: false, isError: false }) };
});

class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
global.ResizeObserver = ResizeObserverStub as unknown as typeof ResizeObserver;

let postSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  vi.clearAllMocks();
  postSpy = vi.spyOn(api, 'post').mockImplementation(async (url: string) => {
    if (url.endsWith('/convert')) {
      return {
        data: {
          purchaseOrder: { ...CONV_PO, id: 'po-new', poNumber: 'PO-09999' },
          estimateReservation: { ...OPEN_RES, status: 'converted' },
        },
      };
    }
    if (url.endsWith('/dismiss')) {
      return { data: { estimateReservation: { ...OPEN_RES, status: 'dismissed' } } };
    }
    return { data: {} };
  });
});

function renderPrePO() {
  return renderWithProviders(<PurchaseOrdersPage />, {
    initialEntries: ['/inventory/purchase-orders?status=draft'],
  });
}

describe('PurchaseOrdersPage — reservation queue lifecycle (P2 §4)', () => {
  it('shows open reservations only by default; "Show resolved" reveals the rest with status pills', async () => {
    renderPrePO();

    expect(await screen.findByText('EST-5521')).toBeInTheDocument();
    expect(screen.queryByText('EST-5524')).not.toBeInTheDocument();
    expect(screen.queryByText('EST-5530')).not.toBeInTheDocument();

    // Est/lead context line renders for the open row (the D3 human-call surface).
    expect(screen.getByText(/Est WON · Lead LOST/)).toBeInTheDocument();

    await userEvent.click(screen.getByRole('checkbox', { name: /show resolved/i }));

    expect(await screen.findByText('EST-5524')).toBeInTheDocument();
    expect(screen.getByText('EST-5530')).toBeInTheDocument();
    expect(screen.getByText('Converted')).toBeInTheDocument();
    expect(screen.getByText('Dismissed')).toBeInTheDocument();
  });

  it('convert posts the server endpoint — never the old client PO create', async () => {
    renderPrePO();

    await userEvent.click(await screen.findByText('EST-5521'));
    await userEvent.click(
      await screen.findByRole('button', { name: /convert to purchase order/i }),
    );

    await waitFor(() =>
      expect(postSpy).toHaveBeenCalledWith(
        '/api/inventory/estimate-reservations/res-open-1/convert',
      ),
    );
    // The deleted reservationToDraftPO path would have POSTed the create
    // endpoint — assert it never fires from convert.
    expect(
      postSpy.mock.calls.filter((c) => c[0] === '/api/inventory/purchase-orders'),
    ).toHaveLength(0);
    // Server-assigned number in the toast (nothing client-minted, QA-601).
    expect(await screen.findByText(/PO-09999 drafted from EST-5521/)).toBeInTheDocument();
  });

  it('dismiss requires the inline confirm and sends {reason} when typed', async () => {
    renderPrePO();

    await userEvent.click(await screen.findByText('EST-5521'));
    await userEvent.click(await screen.findByRole('button', { name: /^dismiss$/i }));

    // No request yet — the first click only arms the confirm step.
    expect(postSpy).not.toHaveBeenCalled();

    await userEvent.type(screen.getByLabelText('Dismiss reason'), 'dup order');
    await userEvent.click(screen.getByRole('button', { name: /confirm dismiss\?/i }));

    await waitFor(() =>
      expect(postSpy).toHaveBeenCalledWith(
        '/api/inventory/estimate-reservations/res-open-1/dismiss',
        { reason: 'dup order' },
      ),
    );
  });

  it('a converted row\'s "View PO →" opens PODetailDialog for the linked PO', async () => {
    renderPrePO();

    await userEvent.click(screen.getByRole('checkbox', { name: /show resolved/i }));
    const convRow = (await screen.findByText('EST-5524')).closest('tr')!;
    await userEvent.click(within(convRow).getByRole('button', { name: /view po/i }));

    // PODetailDialog titles as `PO-02412 · ADI / Anixter`.
    expect(await screen.findByText(/PO-02412 · ADI \/ Anixter/)).toBeInTheDocument();
  });
});
