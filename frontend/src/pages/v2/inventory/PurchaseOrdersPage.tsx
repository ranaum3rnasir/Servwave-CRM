import { useEffect, useId, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import {
  ClipboardList, Download, FileText, PackageCheck, PackageOpen, Plus, ShoppingCart, X,
} from 'lucide-react';

import {
  useBrands, useCategories, useConvertReservation, useCreatePO, useDismissReservation,
  useEstimateReservations, useInventoryItems, useInventoryJobs, useLocations,
  usePurchaseOrders, useReceivePO, useVendors,
} from '@/lib/api/inventory';
import type {
  Brand, Category, EstimateReservation, Item, NewPOInput, PurchaseOrder, Vendor,
} from '@/lib/api/inventory';
import { extractApiError, formatCurrency } from '@/lib/utils';
import { downloadCSV, toCSV } from '@/lib/inventory/csv';
import { useScopedRowSelection } from '@/lib/useScopedRowSelection';

// Legacy dialogs reused unchanged - each owns the receive/convert/dismiss
// contracts and their server error handling.
import { NewPODialog } from '@/components/inventory/NewPODialog';
import { PODetailDialog, type ReceiveSubmit } from '@/components/inventory/PODetailDialog';
import { POEmailDialog } from '@/components/inventory/POEmailDialog';
import { POPreviewDialog } from '@/components/inventory/POPreviewDialog';
import { PrePODetailDialog } from '@/components/inventory/PrePODetailDialog';

import { DataTable } from '@/ui-kit/components/data/dataTable/dataTable';
import { EmptyState } from '@/ui-kit/components/data/emptyState';
import { StatCard, StatCardGroup } from '@/ui-kit/components/data/statCard';
import { PageHeader } from '@/ui-kit/components/layout/pageHeader';
import { SearchInput } from '@/ui-kit/components/form/searchInput';
import { Badge } from '@/ui-kit/components/ui/badge';
import { Button } from '@/ui-kit/components/ui/button';
import { Checkbox } from '@/ui-kit/components/ui/checkbox';
import { Label } from '@/ui-kit/components/ui/label';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/ui-kit/components/ui/select';
import { toast } from '@/ui-kit/components/ui/sonner';

import { useRecordVisit } from '../pageBreadcrumbs';
import { TabPanel, TabStrip } from '../_shared/tabs';
import { ExportBulkBar } from './components/exportBulkBar';
import {
  buildHistoryPOColumns, buildOpenPOColumns, buildPrePOColumns, fmtDate, poTotal,
  prePOAge, prePOJobLabel, prePORef, prePOTotal, prePOTrade, prePOVendor, type PrePORow,
} from './poColumns';

type Tab = 'pre-po' | 'open' | 'history';

// Which KPI tile is currently "active". Only one can ever be true at a time.
type ActiveKPI = null | 'prepo' | 'open' | 'late' | 'week';

const TODAY = new Date(); // live clock - drives Late / Arriving-this-week KPIs and Pre-PO ages
const MS_PER_DAY = 24 * 60 * 60 * 1000;
const ONE_WEEK_MS = 7 * MS_PER_DAY;

function isLate(po: PurchaseOrder): boolean {
  if (!po.expectedDate) return false;
  if (po.status === 'received' || po.status === 'closed') return false;
  return new Date(po.expectedDate).getTime() < TODAY.getTime();
}

function isArrivingThisWeek(po: PurchaseOrder): boolean {
  if (!po.expectedDate) return false;
  if (po.status === 'received' || po.status === 'closed') return false;
  const exp = new Date(po.expectedDate).getTime();
  return exp >= TODAY.getTime() && exp <= TODAY.getTime() + ONE_WEEK_MS;
}

const TRADES = ['locksmith', 'door', 'security', 'hvac', 'plumbing', 'multi'];

const EMPTY_COPY: Record<Tab, { title: string; description: string }> = {
  'pre-po': {
    title: 'No drafts or reservations in flight',
    description: 'Hit "+ Create PO" to draft one manually, or convert an approved estimate reservation.',
  },
  open: {
    title: 'No open POs',
    description: "Everything you've sent has been received or closed. Quiet day at the dock.",
  },
  history: {
    title: 'No closed POs yet',
    description: 'Received and closed POs will land here for audit + lead-time analysis.',
  },
};

/**
 * /v2/inventory/purchase-orders - the PO workspace on the CRM UI kit.
 *
 * Three tabs, same three buckets: Pre-PO (drafts + estimate reservations),
 * Open (sent + partial) and History (received + closed). Every query,
 * mutation, deep-link rule, sort order and server-error branch is the legacy
 * page's; the four KPI tiles become kit StatCards, the app TabStrip becomes
 * the v2 one, and the three ResizableTables become kit DataTables.
 */
export default function PurchaseOrdersPage() {
  useRecordVisit('inventory', 'Purchase Orders');
  const [tab, setTabRaw] = useState<Tab>('open'); // default landing tab
  const [search, setSearch] = useState('');
  const [vendorFilter, setVendorFilter] = useState('');
  const [tradeFilter, setTradeFilter] = useState('');
  const [activeKPI, setActiveKPI] = useState<ActiveKPI>(null);
  const [searchParams] = useSearchParams();
  const resolvedCheckboxId = useId();

  // Deep-link seeding (e.g. Dialer PO link): `?q=` pre-fills the text search and
  // `?status=` selects the tab whose bucket contains that status.
  useEffect(() => {
    const q = searchParams.get('q');
    const status = searchParams.get('status');
    if (status) {
      const t: Tab =
        status === 'draft'
          ? 'pre-po'
          : status === 'received' || status === 'closed'
            ? 'history'
            : 'open';
      // eslint-disable-next-line react-hooks/set-state-in-effect -- the tab is seeded once from the URL query string, which lives outside React state
      setTabRaw(t);
    }
    if (q) setSearch(q);
  }, [searchParams]);

  // NO `= []` DEFAULT on the five a seed effect keys on (below). That default
  // mints a FRESH array every render while the query is pending, so the effect
  // sees a changed dependency every render and re-fires forever - the loop
  // `src/__tests__/purchase-orders-deeplink.test.tsx` mocks the seam to dodge.
  // `seedReservations` and `seedJobs` keep theirs: they are read straight in
  // render, never seeded into state.
  const { data: seedPOs } = usePurchaseOrders();
  const { data: seedReservations = [] } = useEstimateReservations();
  const { data: seedJobs = [] } = useInventoryJobs();
  const { data: seedVendors } = useVendors();
  const { data: seedItems } = useInventoryItems();
  const { data: seedCategories } = useCategories();
  const { data: seedBrands } = useBrands();
  // Resolves the receive destination's display name for the success toast.
  const { data: seedLocations = [] } = useLocations();

  const createPO = useCreatePO();
  const receivePO = useReceivePO();
  const convertReservation = useConvertReservation();
  const dismissReservation = useDismissReservation();

  // KPI click: clicking a different tile moves the active state to it (and
  // navigates to the right tab); clicking the active one toggles it off.
  function handleKPIClick(key: NonNullable<ActiveKPI>) {
    if (activeKPI === key) {
      setActiveKPI(null);
      return;
    }
    setActiveKPI(key);
    if (key === 'prepo') setTabRaw('pre-po');
    else setTabRaw('open'); // open, late and week all live in the Open tab
  }

  // Manual tab navigation always clears any active KPI filter.
  function setTab(next: Tab) {
    setTabRaw(next);
    setActiveKPI(null);
  }

  const [allPOs, setAllPOs] = useState<PurchaseOrder[]>([]);

  // Local catalog state so items / vendors / categories added from inside
  // NewPODialog persist across the rest of the page session.
  const [allItems, setAllItems] = useState<Item[]>([]);
  const [allVendorsCatalog, setAllVendorsCatalog] = useState<Vendor[]>([]);
  const [allCategoriesCatalog, setAllCategoriesCatalog] = useState<Category[]>([]);
  const [allBrandsCatalog, setAllBrandsCatalog] = useState<Brand[]>([]);

  // eslint-disable-next-line react-hooks/set-state-in-effect -- PO mirror is seeded from the query, then mutated optimistically on create / receive
  useEffect(() => { if (seedPOs) setAllPOs(seedPOs); }, [seedPOs]);
  // eslint-disable-next-line react-hooks/set-state-in-effect -- items mirror is seeded here, then extended by items created inside NewPODialog
  useEffect(() => { if (seedItems) setAllItems(seedItems); }, [seedItems]);
  // eslint-disable-next-line react-hooks/set-state-in-effect -- vendors mirror is seeded here, then extended by vendors created inside NewPODialog
  useEffect(() => { if (seedVendors) setAllVendorsCatalog(seedVendors); }, [seedVendors]);
  // eslint-disable-next-line react-hooks/set-state-in-effect -- categories mirror is seeded here, then extended by categories created inside NewPODialog
  useEffect(() => { if (seedCategories) setAllCategoriesCatalog(seedCategories); }, [seedCategories]);
  // eslint-disable-next-line react-hooks/set-state-in-effect -- brands mirror is seeded here, then extended by brands created inside NewPODialog
  useEffect(() => { if (seedBrands) setAllBrandsCatalog(seedBrands); }, [seedBrands]);

  const draftPOs = useMemo(() => allPOs.filter((p) => p.status === 'draft'), [allPOs]);
  const openPOs = useMemo(
    () => allPOs.filter((p) => p.status === 'sent' || p.status === 'partial'),
    [allPOs],
  );
  const historyPOs = useMemo(
    () => allPOs.filter((p) => p.status === 'received' || p.status === 'closed'),
    [allPOs],
  );

  // Pre-PO unified rows: drafts + OPEN reservations; "Show resolved" adds
  // converted/dismissed reservations back.
  const [showResolved, setShowResolved] = useState(false);
  const prePORows: PrePORow[] = useMemo(() => {
    const r: PrePORow[] = [
      ...draftPOs.map((d): PrePORow => ({ kind: 'draft', data: d })),
      ...seedReservations
        .filter((e) => (showResolved ? true : (e.status ?? 'open') === 'open'))
        .map((e): PrePORow => ({ kind: 'reservation', data: e })),
    ];
    // Age DESC - oldest first, they are the stalest and need attention most.
    r.sort((a, b) => prePOAge(b, TODAY) - prePOAge(a, TODAY));
    return r;
  }, [draftPOs, seedReservations, showResolved]);

  const kpiPrePOPending =
    draftPOs.length + seedReservations.filter((e) => (e.status ?? 'open') === 'open').length;
  const kpiOpenCount = openPOs.length;
  const kpiOpenSpend = openPOs.reduce((sum, p) => sum + poTotal(p), 0);
  const kpiLate = openPOs.filter(isLate).length;
  const kpiArrivingThisWeek = openPOs.filter(isArrivingThisWeek).length;

  const applyTextFilter = <T extends { vendor?: string; jobNumber?: string; customer?: string }>(
    rows: T[],
    hay: (r: T) => string,
  ): T[] => {
    const q = search.trim().toLowerCase();
    return rows.filter((r) => {
      if (vendorFilter && (r.vendor ?? '') !== vendorFilter) return false;
      if (tradeFilter && (r as unknown as { trade?: string }).trade !== tradeFilter) return false;
      if (!q) return true;
      return hay(r).toLowerCase().includes(q);
    });
  };

  const filteredOpen = useMemo(
    () =>
      applyTextFilter(openPOs, (p) =>
        [p.poNumber, p.vendor, p.jobNumber, p.customer, p.lines.map((l) => l.itemSku).join(' ')].join(' '),
      ),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [openPOs, search, vendorFilter, tradeFilter],
  );

  const filteredHistory = useMemo(
    () => applyTextFilter(historyPOs, (p) => [p.poNumber, p.vendor, p.jobNumber, p.customer].join(' ')),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [historyPOs, search, vendorFilter, tradeFilter],
  );

  const filteredPrePO = useMemo(() => {
    const q = search.trim().toLowerCase();
    return prePORows.filter((r) => {
      const v = prePOVendor(r);
      const t = prePOTrade(r);
      if (vendorFilter && v !== vendorFilter) return false;
      if (tradeFilter && t !== tradeFilter) return false;
      if (!q) return true;
      return `${prePORef(r)} ${v ?? ''} ${prePOJobLabel(r)}`.toLowerCase().includes(q);
    });
  }, [prePORows, search, vendorFilter, tradeFilter]);

  const vendorOptions = useMemo(() => {
    const set = new Set<string>();
    allPOs.forEach((p) => set.add(p.vendor));
    seedReservations.forEach((e) => e.preferredVendor && set.add(e.preferredVendor));
    return Array.from(set).sort();
  }, [allPOs, seedReservations]);

  const [detailPO, setDetailPO] = useState<PurchaseOrder | null>(null);
  const [previewPO, setPreviewPO] = useState<PurchaseOrder | null>(null);
  const [emailPO, setEmailPO] = useState<PurchaseOrder | null>(null);
  const [newPOOpen, setNewPOOpen] = useState(false);
  const [prePOActive, setPrePOActive] = useState<{ kind: 'reservation'; data: EstimateReservation } | null>(null);

  // The PO number is server-assigned: await the create, fold the returned PO
  // into local state and switch to the Pre-PO tab so the row is visible.
  async function handleCreatePO(input: NewPOInput) {
    try {
      const r = await createPO.mutateAsync(input);
      setAllPOs((prev) => [r.purchaseOrder, ...prev]);
      setTab('pre-po');
      toast(`${r.purchaseOrder.poNumber} saved as draft`);
    } catch {
      toast('Could not save the PO - try again');
    }
  }

  // NO optimistic fold - the server's {purchaseOrder} response is the truth.
  function handleReceive(event: ReceiveSubmit) {
    receivePO.mutate(event, {
      onSuccess: (r) => {
        const serverPO = r.purchaseOrder;
        setAllPOs((prev) => prev.map((p) => (p.id === serverPO.id ? serverPO : p)));
        setDetailPO(serverPO);
        const locationName =
          seedLocations.find((l) => l.id === event.destinationLocationId)?.name ?? 'stock';
        toast(`✓ ${serverPO.poNumber} updated · received into ${locationName}`);
      },
      onError: (err) => {
        // Matches the real server contracts (inv-po.controller.receivePurchaseOrder):
        //   400 OVER_RECEIVE -> { error, item_sku, qty_ordered, qty_received }
        //   409 STAGED_PO    -> { error, message, staged_skus: string[] }
        const data = (err as {
          response?: {
            data?: {
              error?: string;
              message?: string;
              item_sku?: string;
              qty_ordered?: number;
              qty_received?: number;
              staged_skus?: string[];
            };
          };
        })?.response?.data;

        if (data?.error === 'OVER_RECEIVE') {
          toast.error("Received can't exceed ordered", {
            description: data.item_sku
              ? `${data.item_sku}: tried to receive ${data.qty_received ?? '?'}, only ${data.qty_ordered ?? '?'} ordered`
              : undefined,
          });
          return;
        }

        if (data?.error === 'STAGED_PO') {
          const skus = (data.staged_skus ?? []).join(', ');
          toast.error('Receive staged items from the Staging view', {
            description: skus ? `Staged line${skus.includes(',') ? 's' : ''}: ${skus}` : data.message,
          });
          return;
        }

        toast.error(extractApiError(err, 'Failed to save the receipt'));
      },
    });
  }

  function handlePrePOClick(r: PrePORow) {
    if (r.kind === 'draft') {
      setDetailPO(r.data);
      return;
    }
    setPrePOActive(r);
  }

  // Server-side conversion: POST /estimate-reservations/:id/convert builds the
  // draft PO in the same tx that flips the reservation to `converted`.
  function handleConvertReservationToPO(reservation: EstimateReservation) {
    convertReservation.mutate(reservation.id, {
      onSuccess: (r) => {
        setPrePOActive(null);
        setTab('pre-po');
        toast(`${r.purchaseOrder.poNumber} drafted from ${reservation.estimateNumber}`);
      },
      onError: (err) => {
        toast.error(extractApiError(err, 'Failed to convert the reservation'));
      },
    });
  }

  function handleDismissReservation(reservation: EstimateReservation, reason?: string) {
    dismissReservation.mutate(
      { id: reservation.id, reason },
      {
        onSuccess: () => {
          setPrePOActive(null);
          toast('Reservation dismissed');
        },
        onError: (err) => {
          toast.error(extractApiError(err, 'Failed to dismiss the reservation'));
        },
      },
    );
  }

  // Converted rows jump to the linked PO. Fallback (PO not in the loaded list):
  // seed the text search with the PO number so the operator lands on it.
  function handleViewConvertedPO(reservation: EstimateReservation) {
    const po = allPOs.find((p) => p.id === reservation.convertedPurchaseOrderId);
    if (po) {
      setPrePOActive(null);
      setDetailPO(po);
      return;
    }
    if (reservation.convertedPoNumber) {
      setPrePOActive(null);
      setSearch(reservation.convertedPoNumber);
    }
  }

  const prePOColumns = useMemo(
    () =>
      buildPrePOColumns({
        today: TODAY,
        onRowClick: handlePrePOClick,
        onViewConvertedPO: handleViewConvertedPO,
        selectable: true,
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [allPOs],
  );

  const openColumns = useMemo(
    () =>
      buildOpenPOColumns({
        isLate,
        isArrivingThisWeek,
        onPreview: setPreviewPO,
        onEmail: setEmailPO,
        onReceive: setDetailPO,
        selectable: true,
      }),
    [],
  );

  const historyColumns = useMemo(
    () => buildHistoryPOColumns({ onPreview: setPreviewPO, selectable: true }),
    [],
  );

  // Open rows sort late first, then by expected ASC.
  const openRows = useMemo(() => {
    const rows =
      activeKPI === 'late'
        ? filteredOpen.filter(isLate)
        : activeKPI === 'week'
          ? filteredOpen.filter(isArrivingThisWeek)
          : filteredOpen;
    return [...rows].sort((a, b) => {
      const aLate = isLate(a) ? 0 : 1;
      const bLate = isLate(b) ? 0 : 1;
      if (aLate !== bLate) return aLate - bLate;
      const aExp = a.expectedDate ? new Date(a.expectedDate).getTime() : Infinity;
      const bExp = b.expectedDate ? new Date(b.expectedDate).getTime() : Infinity;
      return aExp - bExp;
    });
  }, [filteredOpen, activeKPI]);

  // History sorts by orderedAt DESC as a proxy for receivedAt.
  const historyRows = useMemo(
    () => [...filteredHistory].sort((a, b) => new Date(b.orderedAt).getTime() - new Date(a.orderedAt).getTime()),
    [filteredHistory],
  );

  // --- Selection --------------------------------------------------------------
  // THREE selections, one per grid, because they are three tables over two
  // different row types. Each scope key is the set of inputs its OWN rows are
  // derived from, so a filter that only moves one tab's rows only drops that
  // tab's selection. `tab` is in every key as well: the panels unmount on a tab
  // switch, and carrying a hidden selection back would be a surprise.
  const prePOSelection = useScopedRowSelection(
    JSON.stringify([tab, search, vendorFilter, tradeFilter, showResolved]),
  );
  const openSelection = useScopedRowSelection(
    JSON.stringify([tab, search, vendorFilter, tradeFilter, activeKPI]),
  );
  const historySelection = useScopedRowSelection(
    JSON.stringify([tab, search, vendorFilter, tradeFilter]),
  );

  // A Pre-PO row id is `${kind}_${id}` (its `getRowId`), not a bare uuid.
  const selectedPrePO = useMemo(
    () => filteredPrePO.filter((r) => prePOSelection.selectedIds.includes(`${r.kind}_${r.data.id}`)),
    [filteredPrePO, prePOSelection.selectedIds],
  );
  const selectedOpen = useMemo(
    () => openRows.filter((p) => openSelection.selectedIds.includes(p.id)),
    [openRows, openSelection.selectedIds],
  );
  const selectedHistory = useMemo(
    () => historyRows.filter((p) => historySelection.selectedIds.includes(p.id)),
    [historyRows, historySelection.selectedIds],
  );

  // --- CSV export -------------------------------------------------------------
  /**
   * NEW: neither this page nor its legacy counterpart had a CSV export, so
   * there was no exporter to reuse. One mapping per grid, because the three
   * grids print three different column sets - a single shared mapping would
   * have to null out half its columns per tab.
   *
   * Each mapping is its grid's own columns, in the grid's order, computed by
   * the same helpers the cells use (`poTotal`, `prePOTotal`, `prePOAge`,
   * `fmtDate`), so the file and the screen cannot drift. Both the toolbar
   * Export and Export selected go through `exportRows`, which is the shared
   * `toCSV`/`downloadCSV` writer the CSV export guard requires.
   */
  const toPrePOExportRow = (r: PrePORow) => ({
    Type: r.kind === 'draft' ? 'Draft' : 'Est. Reservation',
    'Ref #': prePORef(r),
    'Vendor(s)': prePOVendor(r) ?? '',
    'Job / Customer': prePOJobLabel(r),
    Trade: prePOTrade(r) ?? '',
    Items: r.kind === 'draft' ? r.data.lines.length : r.data.linesSummary.items,
    Units: r.kind === 'draft'
      ? r.data.lines.reduce((sum, l) => sum + l.qtyOrdered, 0)
      : r.data.linesSummary.units,
    'Est. Total': prePOTotal(r),
    'Age (days)': prePOAge(r, TODAY),
  });

  const toOpenExportRow = (p: PurchaseOrder) => ({
    Status: p.status,
    'PO #': p.poNumber,
    Vendor: p.vendor,
    Job: p.jobNumber ?? '',
    Customer: p.customer ?? '',
    Ordered: fmtDate(p.orderedAt),
    Expected: fmtDate(p.expectedDate),
    Lines: p.lines.length,
    Total: poTotal(p),
    'Qty Ordered': p.lines.reduce((sum, l) => sum + l.qtyOrdered, 0),
    'Qty Received': p.lines.reduce((sum, l) => sum + l.qtyReceived, 0),
  });

  const toHistoryExportRow = (p: PurchaseOrder) => ({
    Status: p.status,
    'PO #': p.poNumber,
    Vendor: p.vendor,
    Job: p.jobNumber ?? '',
    Customer: p.customer ?? '',
    Ordered: fmtDate(p.orderedAt),
    // The grid stands receivedAt in as expectedDate until the model gains the
    // real field; the export says the same thing rather than a different one.
    'Received on': fmtDate(p.expectedDate ?? p.orderedAt),
    Total: poTotal(p),
  });

  function exportRows(rows: Record<string, unknown>[], name: string) {
    if (rows.length === 0) {
      toast('Nothing to export', { description: 'No purchase orders match the current filters.' });
      return;
    }
    downloadCSV(toCSV(rows), `purchase-orders-${name}-${new Date().toISOString().slice(0, 10)}.csv`);
  }

  /** The toolbar Export acts on the CURRENT tab's whole filtered set. */
  function handleExportTab() {
    if (tab === 'pre-po') { exportRows(filteredPrePO.map(toPrePOExportRow), 'pre-po'); return; }
    if (tab === 'history') { exportRows(historyRows.map(toHistoryExportRow), 'history'); return; }
    exportRows(openRows.map(toOpenExportRow), 'open');
  }

  const tabs = [
    {
      value: 'pre-po',
      label: (
        <span className="flex items-center gap-1.5">
          <ClipboardList className="size-3.5" />
          Pre-PO
          <Badge variant="softNeutral" size="pill">{prePORows.length}</Badge>
        </span>
      ),
    },
    {
      value: 'open',
      label: (
        <span className="flex items-center gap-1.5">
          <PackageOpen className="size-3.5" />
          Open
          <Badge variant="softNeutral" size="pill">{openPOs.length}</Badge>
        </span>
      ),
    },
    {
      value: 'history',
      label: (
        <span className="flex items-center gap-1.5">
          <PackageCheck className="size-3.5" />
          History
          <Badge variant="softNeutral" size="pill">{historyPOs.length}</Badge>
        </span>
      ),
    },
  ];

  return (
    <div>
      <PageHeader
        title="Purchase Orders"
        description="Track every order from quote to receipt. Pre-PO quotes · open orders with vendors · received history."
        actions={
          <Button onClick={() => setNewPOOpen(true)}>
            <Plus />
            Create PO
          </Button>
        }
      />

      <StatCardGroup className="mb-4 xl:grid-cols-4">
        <StatCard
          label="Pre-PO pending"
          value={String(kpiPrePOPending)}
          active={activeKPI === 'prepo'}
          onClick={() => handleKPIClick('prepo')}
        />
        <StatCard
          label="Open POs"
          value={String(kpiOpenCount)}
          active={activeKPI === 'open'}
          onClick={() => handleKPIClick('open')}
        />
        <StatCard
          label="Late"
          value={String(kpiLate)}
          active={activeKPI === 'late'}
          onClick={() => handleKPIClick('late')}
        />
        <StatCard
          label="Arriving this week"
          value={String(kpiArrivingThisWeek)}
          active={activeKPI === 'week'}
          onClick={() => handleKPIClick('week')}
        />
      </StatCardGroup>

      <TabStrip tabs={tabs} value={tab} onValueChange={(v) => setTab(v as Tab)} />

      {/* Search + filter row, shared across all three tabs. */}
      <div className="flex flex-wrap items-center gap-2 border-b px-2 py-3">
        <div className="min-w-[12rem] flex-1">
          <SearchInput value={search} onValueChange={setSearch} placeholder="Search purchase orders…" />
        </div>
        <Select
          value={vendorFilter || 'all'}
          onValueChange={(v) => setVendorFilter(v === 'all' ? '' : v)}
        >
          <SelectTrigger size="sm" aria-label="All vendors">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All vendors</SelectItem>
            {vendorOptions.map((v) => (
              <SelectItem key={v} value={v}>{v}</SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select value={tradeFilter || 'all'} onValueChange={(v) => setTradeFilter(v === 'all' ? '' : v)}>
          <SelectTrigger size="sm" aria-label="All trades">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All trades</SelectItem>
            {TRADES.map((t) => (
              <SelectItem key={t} value={t}>{t}</SelectItem>
            ))}
          </SelectContent>
        </Select>
        {tab === 'pre-po' && (
          <span className="flex items-center gap-1.5">
            <Checkbox
              id={resolvedCheckboxId}
              checked={showResolved}
              onCheckedChange={(c) => setShowResolved(c === true)}
            />
            <Label htmlFor={resolvedCheckboxId} className="text-muted-foreground text-xs font-medium">
              Show resolved
            </Label>
          </span>
        )}
        {activeKPI && (
          <Button
            variant="ghost"
            size="sm"
            title="Click the lit KPI tile again, or use this button, to clear the filter"
            onClick={() => setActiveKPI(null)}
          >
            Clear KPI filter
            <X />
          </Button>
        )}
        {/* Exports the ACTIVE tab's whole filtered set. It sits in the shared
            search/filter row because that row is what scopes all three grids;
            its selected-row sibling lives in each grid's own bulk bar and
            shares that grid's mapping. */}
        <Button variant="outline" size="sm" onClick={handleExportTab}>
          <Download />
          Export
        </Button>
      </div>

      <div className="pt-4">
        <TabPanel value="pre-po" activeValue={tab}>
          <DataTable
            columns={prePOColumns}
            data={filteredPrePO}
            getRowId={(r) => `${r.kind}_${r.data.id}`}
            onRowClick={handlePrePOClick}
            rowSelection={prePOSelection.rowSelection}
            onRowSelectionChange={prePOSelection.setRowSelection}
            enableColumnResizing
            mobileCards
            empty={
              <EmptyState
                icon={<FileText />}
                title={EMPTY_COPY['pre-po'].title}
                description={EMPTY_COPY['pre-po'].description}
              />
            }
          >
            {() => (
              <ExportBulkBar
                count={selectedPrePO.length}
                noun={['row', 'rows']}
                onClear={() => prePOSelection.setRowSelection({})}
                onExportSelected={() =>
                  exportRows(selectedPrePO.map(toPrePOExportRow), 'pre-po-selected')}
              />
            )}
          </DataTable>
        </TabPanel>

        <TabPanel value="open" activeValue={tab}>
          <DataTable
            columns={openColumns}
            data={openRows}
            getRowId={(p) => p.id}
            onRowClick={(p) => setDetailPO(p)}
            rowSelection={openSelection.rowSelection}
            onRowSelectionChange={openSelection.setRowSelection}
            enableColumnResizing
            mobileCards
            empty={
              <EmptyState
                icon={<ShoppingCart />}
                title={EMPTY_COPY.open.title}
                description={EMPTY_COPY.open.description}
              />
            }
          >
            {() => (
              <ExportBulkBar
                count={selectedOpen.length}
                noun={['purchase order', 'purchase orders']}
                onClear={() => openSelection.setRowSelection({})}
                onExportSelected={() =>
                  exportRows(selectedOpen.map(toOpenExportRow), 'open-selected')}
              />
            )}
          </DataTable>
        </TabPanel>

        <TabPanel value="history" activeValue={tab}>
          <DataTable
            columns={historyColumns}
            data={historyRows}
            getRowId={(p) => p.id}
            onRowClick={(p) => setDetailPO(p)}
            rowSelection={historySelection.rowSelection}
            onRowSelectionChange={historySelection.setRowSelection}
            enableColumnResizing
            mobileCards
            empty={
              <EmptyState
                icon={<PackageCheck />}
                title={EMPTY_COPY.history.title}
                description={EMPTY_COPY.history.description}
              />
            }
          >
            {() => (
              <ExportBulkBar
                count={selectedHistory.length}
                noun={['purchase order', 'purchase orders']}
                onClear={() => historySelection.setRowSelection({})}
                onExportSelected={() =>
                  exportRows(selectedHistory.map(toHistoryExportRow), 'history-selected')}
              />
            )}
          </DataTable>
        </TabPanel>
      </div>

      <PODetailDialog
        open={!!detailPO}
        onClose={() => setDetailPO(null)}
        po={detailPO}
        onReceive={handleReceive}
      />
      <POPreviewDialog open={!!previewPO} onClose={() => setPreviewPO(null)} po={previewPO} />
      <POEmailDialog
        open={!!emailPO}
        onClose={() => setEmailPO(null)}
        po={emailPO}
        onSent={(payload) => {
          // Mirrors PODetailDialog's own emailed toast for the Open-tab icon path.
          if (emailPO) toast(`✉ ${emailPO.poNumber} emailed to ${payload.to[0]}`);
          setEmailPO(null);
        }}
      />
      <PrePODetailDialog
        open={!!prePOActive}
        onClose={() => setPrePOActive(null)}
        row={prePOActive}
        onConvertToPO={handleConvertReservationToPO}
        onDismiss={handleDismissReservation}
        onViewConvertedPO={() => { if (prePOActive) handleViewConvertedPO(prePOActive.data); }}
        converting={convertReservation.isPending}
        dismissing={dismissReservation.isPending}
      />
      <NewPODialog
        open={newPOOpen}
        onClose={() => setNewPOOpen(false)}
        onCreate={handleCreatePO}
        vendors={allVendorsCatalog}
        items={allItems}
        existingPOs={allPOs}
        jobs={seedJobs}
        reservations={seedReservations}
        onAddItem={(item) => setAllItems((prev) => [item, ...prev])}
        onAddVendor={(v) => setAllVendorsCatalog((prev) => [...prev, v])}
        categories={allCategoriesCatalog}
        onAddCategory={(c) => setAllCategoriesCatalog((prev) => [...prev, c])}
        brands={allBrandsCatalog}
      />
    </div>
  );
}
