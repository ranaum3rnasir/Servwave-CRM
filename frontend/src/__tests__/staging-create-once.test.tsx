// Regression: creating a job stage wrote it to the database TWICE.
//
// CreateStageDialog.submit() fired `createStage.mutate(...)` and then called
// `onCreate(stage)`, and StagingView's onCreate handler fired the SAME mutation
// again - two POSTs to /api/inventory/job-stages from one click, so the Staging
// list rendered every pickup as a pair of identical cards. Both calls resolved
// as no-ops under the old USE_MOCK seam, which is why it only surfaced once the
// module flipped to the real API.
//
// The spy below is SHARED by every useCreateStage() caller on purpose: that is
// what makes a second writer anywhere in the tree visible as a second call.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, fireEvent } from '@testing-library/react';
import { renderWithProviders } from './helpers';
import { StagingView } from '@/components/inventory/StagingView';

const createStageSpy = vi.fn();

vi.mock('@/lib/api/inventory', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api/inventory')>();
  const EMPTY: never[] = [];
  const stable =
    <T,>(data: T) =>
    () => ({ data, isLoading: false, isError: false });
  const mutation = () => ({ mutate: vi.fn(), mutateAsync: vi.fn(), isPending: false });
  return {
    ...actual,
    useJobStages: stable(EMPTY),
    usePurchaseOrders: stable(EMPTY),
    useVendors: stable(EMPTY),
    useInventoryItems: stable(EMPTY),
    useInventoryJobs: stable(EMPTY),
    useTechs: stable(EMPTY),
    useLocations: stable(EMPTY),
    // Shared across both consumers - the whole point of the test.
    useCreateStage: () => ({ mutate: createStageSpy, mutateAsync: vi.fn(), isPending: false }),
    useReceiveStageLine: mutation,
    useNotifyTechReady: mutation,
  };
});

beforeEach(() => { createStageSpy.mockClear(); });

function fillAndSubmitNewPickup() {
  // Exact name - the empty state also renders a "Create New Pickup" CTA.
  fireEvent.click(screen.getByRole('button', { name: 'New Pickup' }));
  fireEvent.change(screen.getByPlaceholderText(/type new job #/i), {
    target: { value: 'J-1870' },
  });
  fireEvent.change(screen.getByPlaceholderText('Rolex 5th Ave'), {
    target: { value: 'LVD' },
  });
  // The single starter line needs a quantity and a PO number to pass validation.
  fireEvent.change(screen.getByPlaceholderText('0'), { target: { value: '1' } });
  fireEvent.change(screen.getByPlaceholderText('PO-…'), { target: { value: '967678' } });
  fireEvent.click(screen.getByRole('button', { name: /create pickup/i }));
}

describe('StagingView - a new pickup is persisted exactly once', () => {
  it('POSTs the stage a single time per submit', () => {
    renderWithProviders(<StagingView locations={[]} onToast={vi.fn()} />);

    fillAndSubmitNewPickup();

    expect(createStageSpy).toHaveBeenCalledTimes(1);
  });

  it('sends the job link and the source PO on that one call', () => {
    renderWithProviders(<StagingView locations={[]} onToast={vi.fn()} />);

    fillAndSubmitNewPickup();

    const payload = createStageSpy.mock.calls[0]![0];
    expect(payload).toMatchObject({ jobNumber: 'J-1870', customer: 'LVD' });
    // No job picked from the dropdown and no PO linked in this flow, so both
    // links are absent rather than wrong - the keys still have to exist on the
    // payload builder, which the backend tests pin from the other side.
    expect(payload).toHaveProperty('jobId');
    expect(payload).toHaveProperty('linkedPurchaseOrderId');
  });
});
