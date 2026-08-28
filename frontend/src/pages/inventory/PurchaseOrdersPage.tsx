import type React from "react";
import { useEffect, useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";
import {
  AlertTriangle,
  CalendarClock,
  ChevronRight,
  ClipboardList,
  Eye,
  FileText,
  Mail,
  PackageCheck,
  PackageOpen,
  Plus,
  Search,
  ShoppingCart,
  Truck,
} from "lucide-react";
import { TabStrip, type TabStripTab } from "@/components/patterns/TabStrip";
import { Toolbar } from "@/components/patterns/Toolbar";
import { ResizableTable } from "@/components/data/ResizableTable";
import { EmptyState } from "@/components/ui/empty-state";
import { Button } from "@/components/ui/button";
import { Heading } from "@/components/ui/heading";
import {
  usePurchaseOrders,
  useEstimateReservations,
  useInventoryJobs,
  useVendors,
  useInventoryItems,
  useCategories,
  useBrands,
  useLocations,
  useCreatePO,
  useReceivePO,
  useConvertReservation,
  useDismissReservation,
} from "@/lib/api/inventory";
import type {
  NewPOInput,
  PurchaseOrder,
  EstimateReservation,
  Brand,
  Category,
  Item,
  Vendor,
} from "@/lib/api/inventory";
import { extractApiError, formatCurrency } from "@/lib/utils";
import { formatExactDay } from "@/lib/format-date";
import { toast } from "@/components/ui/use-toast";
import { SelectField } from "@/components/form/SelectField";
import { StatusBadge } from "@/components/data/status-badge";
import { PODetailDialog, type ReceiveSubmit } from "@/components/inventory/PODetailDialog";
import { POPreviewDialog } from "@/components/inventory/POPreviewDialog";
import { POEmailDialog } from "@/components/inventory/POEmailDialog";
import { PrePODetailDialog } from "@/components/inventory/PrePODetailDialog";
import { NewPODialog } from "@/components/inventory/NewPODialog";

/**
 * PurchaseOrdersPage — (PRD §7.X; RFQ affordances removed in P0 §C / QA-903
 * with the RFQ feature-parking).
 *
 * Three tabs:
 *   1. Pre-PO  — Draft POs + Estimate Reservations. The "decide what to do
 *                next" surface.
 *   2. Open    — sent + partial POs. In-flight with the vendor.
 *   3. History — received + closed. Audit + lead-time analysis surface.
 *
 * Estimate-Reservation rows open the PrePODetailDialog; real PO rows open
 * PODetailDialog. Create PO opens NewPODialog — the PO number is
 * server-assigned on create (P0 §A) and read back off the response.
 *
 * Data seam: reads come from `@/lib/api/inventory` hooks (usePurchaseOrders /
 * useEstimateReservations / useInventoryJobs + the catalog hooks for
 * NewPODialog). Writes go through useCreatePO() / useReceivePO(). The page
 * holds a local working copy of the PO/catalog arrays — seeded from the query
 * data — so in-session drafts + receives stay visible between refetches.
 *
 * Scaffold honesty (preserved from Emanuel's prototype): `poTotal` assumes a
 * flat $50/unit (no per-line cost on POLine yet), and the History tab's
 * Variance / 3-Way-Match column is stubbed.
 */

type Tab = "pre-po" | "open" | "history";

// Which KPI tile is currently "active". Only one can ever be true at a time
// — clicking another moves the active state to it; clicking the active one
// again toggles it off (and clears the filter the tile was applying).
type ActiveKPI = null | "prepo" | "open" | "late" | "week";

type PrePORowType = "draft" | "reservation";

// Discriminated union so the table can render mixed Pre-PO row types.
type PrePORow =
  | { kind: "draft"; data: PurchaseOrder }
  | { kind: "reservation"; data: EstimateReservation };

const TODAY = new Date(); // live clock — drives Late / Arriving-this-week KPIs and Pre-PO ages
const MS_PER_DAY = 24 * 60 * 60 * 1000;
const ONE_WEEK_MS = 7 * MS_PER_DAY;

function daysBetween(aISO: string, b: Date): number {
  return Math.round((b.getTime() - new Date(aISO).getTime()) / MS_PER_DAY);
}

function isLate(po: PurchaseOrder): boolean {
  if (!po.expectedDate) return false;
  if (po.status === "received" || po.status === "closed") return false;
  return new Date(po.expectedDate).getTime() < TODAY.getTime();
}

function isArrivingThisWeek(po: PurchaseOrder): boolean {
  if (!po.expectedDate) return false;
  if (po.status === "received" || po.status === "closed") return false;
  const exp = new Date(po.expectedDate).getTime();
  return exp >= TODAY.getTime() && exp <= TODAY.getTime() + ONE_WEEK_MS;
}

function poTotal(po: PurchaseOrder): number {
  // Real per-line unit costs (P2). Cost-stripped/absent values count as $0 —
  // the row-level display shows "—" for those (PODetailDialog), this is only
  // the table's aggregate column.
  return po.lines.reduce((sum, l) => sum + l.qtyOrdered * (l.unitCost ?? 0), 0);
}

const fmtMoney = formatCurrency;

function fmtDate(iso: string | undefined): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
  });
}

// expectedDate is a calendar day, not an instant, so it is read in UTC.
function fmtDay(iso: string | undefined): string {
  if (!iso) return "—";
  return formatExactDay(iso, {
    month: "short",
    day: "numeric",
  });
}

export default function PurchaseOrdersPage() {
  const [tab, setTabRaw] = useState<Tab>("open"); // §1: default landing tab
  const [search, setSearch] = useState("");
  const [vendorFilter, setVendorFilter] = useState("");
  const [tradeFilter, setTradeFilter] = useState("");
  const [activeKPI, setActiveKPI] = useState<ActiveKPI>(null);
  const [searchParams] = useSearchParams();

  // Deep-link seeding (e.g. Dialer PO link): `?q=` pre-fills the text search
  // and `?status=` selects the tab whose bucket contains that status —
  // mirrors the draft/open/history partitioning below. Uses setTabRaw so a
  // fresh deep-link doesn't touch the KPI-tile active state.
  useEffect(() => {
    const q = searchParams.get("q");
    const status = searchParams.get("status");
    if (status) {
      const t: Tab =
        status === "draft"
          ? "pre-po"
          : status === "received" || status === "closed"
            ? "history"
            : "open";
      setTabRaw(t);
    }
    if (q) setSearch(q);
  }, [searchParams]);

  // ─── Data seam reads ───
  const { data: seedPOs = [] } = usePurchaseOrders();
  const { data: seedReservations = [] } = useEstimateReservations();
  const { data: seedJobs = [] } = useInventoryJobs();
  const { data: seedVendors = [] } = useVendors();
  const { data: seedItems = [] } = useInventoryItems();
  const { data: seedCategories = [] } = useCategories();
  const { data: seedBrands = [] } = useBrands();
  // Resolves the receive destination's display name for the success toast.
  const { data: seedLocations = [] } = useLocations();

  // ─── Seam writes ───
  const createPO = useCreatePO();
  const receivePO = useReceivePO();
  const convertReservation = useConvertReservation();
  const dismissReservation = useDismissReservation();

  // ─── KPI tile click handler: single-active semantics ───
  // - Clicking a different tile moves the active state to it (+ navigates to
  //   the right tab and applies the right filter).
  // - Clicking the currently-active tile toggles it OFF, clearing whatever
  //   filter it was applying. Tab stays where it is.
  function handleKPIClick(key: NonNullable<ActiveKPI>) {
    if (activeKPI === key) {
      setActiveKPI(null);
      return;
    }
    setActiveKPI(key);
    if (key === "prepo") setTabRaw("pre-po");
    else setTabRaw("open"); // open · late · week all live in the Open tab
  }

  // Manual tab navigation always clears any active KPI filter — otherwise
  // the user could land on Open, click Pre-PO, and still see the "Late"
  // filter ring on a hidden tile. Reset = honest UI.
  function setTab(next: Tab) {
    setTabRaw(next);
    setActiveKPI(null);
  }

  // Hoisted PO state — receiving updates flow through here so every tab,
  // KPI tile, and detail dialog re-renders off the latest values. Seeded
  // from the query data; useReceivePO()/useCreatePO() resolve on the mock
  // without persisting, so the optimistic local copy is what the UI shows.
  const [allPOs, setAllPOs] = useState<PurchaseOrder[]>(seedPOs);
  const [receiveToast, setReceiveToast] = useState<string | null>(null);

  // ─── Local catalog state, seeded from query data (rev 2026-05-28) ───
  // Lives at the page level so items / vendors / categories added from
  // inside NewPODialog (via the inline "+ Add a new item" picker footer)
  // persist across the rest of the page session — the new item shows
  // up in subsequent PO drafts, the new vendor shows up in the vendor
  // dropdown, etc. Resets on full app reload (prototype convention).
  const [allItems, setAllItems] = useState<Item[]>(seedItems);
  const [allVendorsCatalog, setAllVendorsCatalog] = useState<Vendor[]>(seedVendors);
  const [allCategoriesCatalog, setAllCategoriesCatalog] =
    useState<Category[]>(seedCategories);
  const [allBrandsCatalog, setAllBrandsCatalog] = useState<Brand[]>(seedBrands);

  // Sync the local working copies when the seam data arrives/changes. We only
  // overwrite from the source of truth — once the user has added/received in
  // session, the optimistic local state is preserved by reference equality
  // (the seam returns the same seed array each time on the mock).
  useEffect(() => {
    setAllPOs(seedPOs);
  }, [seedPOs]);
  useEffect(() => {
    setAllItems(seedItems);
  }, [seedItems]);
  useEffect(() => {
    setAllVendorsCatalog(seedVendors);
  }, [seedVendors]);
  useEffect(() => {
    setAllCategoriesCatalog(seedCategories);
  }, [seedCategories]);
  useEffect(() => {
    setAllBrandsCatalog(seedBrands);
  }, [seedBrands]);

  // ─── Split POs by lifecycle bucket for tab counts + tables ───
  const draftPOs = useMemo(
    () => allPOs.filter((p) => p.status === "draft"),
    [allPOs],
  );
  const openPOs = useMemo(
    () => allPOs.filter((p) => p.status === "sent" || p.status === "partial"),
    [allPOs],
  );
  const historyPOs = useMemo(
    () => allPOs.filter((p) => p.status === "received" || p.status === "closed"),
    [allPOs],
  );

  // ─── Pre-PO unified rows: Drafts + Estimate Reservations ───
  // Default rows = drafts + OPEN reservations; "Show resolved" adds
  // converted/dismissed reservations back (QA-602 — dismissed rows reappear
  // nowhere by default, but stay auditable).
  const [showResolved, setShowResolved] = useState(false);
  const prePORows: PrePORow[] = useMemo(() => {
    const r: PrePORow[] = [
      ...draftPOs.map((d): PrePORow => ({ kind: "draft", data: d })),
      ...seedReservations
        .filter((e) => (showResolved ? true : (e.status ?? "open") === "open"))
        .map((e): PrePORow => ({ kind: "reservation", data: e })),
    ];
    // Age DESC (oldest first — they're stalest and need attention most)
    r.sort((a, b) => prePOAge(b) - prePOAge(a));
    return r;
  }, [draftPOs, seedReservations, showResolved]);

  // ─── KPI computations (each tile is clickable + jumps to its tab) ───
  // Pre-PO pending counts drafts + OPEN reservations only — resolved rows are
  // history, not pending work.
  const kpiPrePOPending =
    draftPOs.length +
    seedReservations.filter((e) => (e.status ?? "open") === "open").length;
  const kpiOpenCount = openPOs.length;
  const kpiOpenSpend = openPOs.reduce((sum, p) => sum + poTotal(p), 0);
  const kpiLate = openPOs.filter(isLate).length;
  const kpiArrivingThisWeek = openPOs.filter(isArrivingThisWeek).length;

  // ─── Search + filter (applies to whichever tab is active) ───
  const applyTextFilter = <T extends { vendor?: string; jobNumber?: string; customer?: string }>(
    rows: T[],
    hay: (r: T) => string,
  ): T[] => {
    const q = search.trim().toLowerCase();
    return rows.filter((r) => {
      if (vendorFilter && (r.vendor ?? "") !== vendorFilter) return false;
      if (tradeFilter && (r as unknown as { trade?: string }).trade !== tradeFilter) return false;
      if (!q) return true;
      return hay(r).toLowerCase().includes(q);
    });
  };

  const filteredOpen = useMemo(
    () =>
      applyTextFilter(openPOs, (p) =>
        [p.poNumber, p.vendor, p.jobNumber, p.customer, p.lines.map((l) => l.itemSku).join(" ")].join(" "),
      ),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [openPOs, search, vendorFilter, tradeFilter],
  );

  const filteredHistory = useMemo(
    () =>
      applyTextFilter(historyPOs, (p) =>
        [p.poNumber, p.vendor, p.jobNumber, p.customer].join(" "),
      ),
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
      const hay = `${prePORef(r)} ${v ?? ""} ${prePOJobLabel(r)}`.toLowerCase();
      return hay.includes(q);
    });
  }, [prePORows, search, vendorFilter, tradeFilter]);

  // ─── Vendor + trade options for filter dropdowns ───
  const vendors = useMemo(() => {
    const set = new Set<string>();
    allPOs.forEach((p) => set.add(p.vendor));
    seedReservations.forEach(
      (e) => e.preferredVendor && set.add(e.preferredVendor),
    );
    return Array.from(set).sort();
  }, [allPOs, seedReservations]);

  const trades = ["locksmith", "door", "security", "hvac", "plumbing", "multi"];

  // ─── Dialog state ───
  // Clicking a real PO row (Open / History / Draft in Pre-PO) opens
  // PODetailDialog. Estimate-Reservation rows in Pre-PO open the
  // PrePODetailDialog instead — the items / estimate / email-thread surface
  // for everything that doesn't have a PO number yet.
  const [detailPO, setDetailPO] = useState<PurchaseOrder | null>(null);
  const [previewPO, setPreviewPO] = useState<PurchaseOrder | null>(null);
  const [emailPO, setEmailPO] = useState<PurchaseOrder | null>(null);
  const [newPOOpen, setNewPOOpen] = useState(false);

  // Persist a freshly drafted PO (PRD §7.X.4). The PO number is
  // server-assigned (P0 §A): await the create, then fold the returned
  // purchaseOrder into local state and switch to the Pre-PO tab so the new
  // row is immediately visible. A short toast echoes the assigned number.
  async function handleCreatePO(input: NewPOInput) {
    try {
      const r = await createPO.mutateAsync(input);
      setAllPOs((prev) => [r.purchaseOrder, ...prev]);
      setTab("pre-po");
      setReceiveToast(`${r.purchaseOrder.poNumber} saved as draft`);
    } catch {
      setReceiveToast("Could not save the PO — try again");
    }
    setTimeout(() => setReceiveToast(null), 2500);
  }
  const [prePOActive, setPrePOActive] = useState<
    | { kind: "reservation"; data: EstimateReservation }
    | null
  >(null);

  function handlePOClick(po: PurchaseOrder) {
    setDetailPO(po);
  }
  // §3.5 debt paid: NO optimistic fold — the server's {purchaseOrder} response
  // is the truth. On success the open dialog re-syncs via setDetailPO(serverPO)
  // (a NEW object — PODetailDialog exits receive mode off that identity change)
  // and the table refreshes via the ['inventory'] invalidation the mutation
  // already performs. On error (400 OVER_RECEIVE et al.) nothing is folded:
  // the dialog stays open in receive mode with a destructive toast.
  function handleReceive(event: ReceiveSubmit) {
    receivePO.mutate(event, {
      onSuccess: (r) => {
        const serverPO = r.purchaseOrder;
        setAllPOs((prev) => prev.map((p) => (p.id === serverPO.id ? serverPO : p)));
        setDetailPO(serverPO);
        const locationName =
          seedLocations.find((l) => l.id === event.destinationLocationId)?.name ??
          "stock";
        setReceiveToast(`✓ ${serverPO.poNumber} updated · received into ${locationName}`);
        window.setTimeout(() => setReceiveToast(null), 4500);
      },
      onError: (err) => {
        // Match the REAL server contracts (inv-po.controller.receivePurchaseOrder):
        //   400 OVER_RECEIVE → { error, item_sku, qty_ordered, qty_received }
        //   409 STAGED_PO    → { error, message, staged_skus: string[] }
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

        if (data?.error === "OVER_RECEIVE") {
          toast({
            title: "Received can't exceed ordered",
            description: data.item_sku
              ? `${data.item_sku}: tried to receive ${data.qty_received ?? "?"}, only ${data.qty_ordered ?? "?"} ordered`
              : undefined,
            variant: "destructive",
          });
          return;
        }

        if (data?.error === "STAGED_PO") {
          const skus = (data.staged_skus ?? []).join(", ");
          toast({
            title: "Receive staged items from the Staging view",
            description: skus ? `Staged line${skus.includes(",") ? "s" : ""}: ${skus}` : data.message,
            variant: "destructive",
          });
          return;
        }

        toast({ title: extractApiError(err, "Failed to save the receipt"), variant: "destructive" });
      },
    });
  }
  function handlePrePOClick(r: PrePORow) {
    if (r.kind === "draft") {
      setDetailPO(r.data);
      return;
    }
    setPrePOActive(r);
  }

  // Server-side conversion (P2 §3a): POST /estimate-reservations/:id/convert
  // builds the draft PO in the same tx that flips the reservation to
  // `converted` — nothing client-minted (QA-601). The old client mapping
  // (reservationToDraftPO) is gone.
  function handleConvertReservationToPO(reservation: EstimateReservation) {
    convertReservation.mutate(reservation.id, {
      onSuccess: (r) => {
        setPrePOActive(null);
        setTab("pre-po");
        setReceiveToast(`${r.purchaseOrder.poNumber} drafted from ${reservation.estimateNumber}`);
        window.setTimeout(() => setReceiveToast(null), 4500);
      },
      onError: (err) => {
        toast({ title: extractApiError(err, "Failed to convert the reservation"), variant: "destructive" });
      },
    });
  }

  function handleDismissReservation(reservation: EstimateReservation, reason?: string) {
    dismissReservation.mutate(
      { id: reservation.id, reason },
      {
        onSuccess: () => {
          setPrePOActive(null);
          setReceiveToast("Reservation dismissed");
          window.setTimeout(() => setReceiveToast(null), 3000);
        },
        onError: (err) => {
          toast({ title: extractApiError(err, "Failed to dismiss the reservation"), variant: "destructive" });
        },
      },
    );
  }

  // Converted rows: jump to the linked PO. Fallback (PO not in the loaded
  // list) → seed the text search with the PO number so the operator lands on it.
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

  // Sub-tab trigger content - icon + label + a count badge whose tone flips
  // when its own tab is active. Was the page-local `TabStripTrigger` helper
  // (a reinvention of TabStrip's own `label: ReactNode` prop); inlined here
  // now that TabStrip covers it directly.
  function tabBadgeClass(active: boolean) {
    return [
      "rounded-full px-1.5 py-0.5 text-[10px] font-semibold",
      active ? "bg-primary text-on-fill" : "bg-secondary-light text-text-secondary",
    ].join(" ");
  }
  const subTabs: TabStripTab[] = [
    {
      value: "pre-po",
      label: (
        <>
          <ClipboardList className="h-3.5 w-3.5" />
          Pre-PO
          <span className={tabBadgeClass(tab === "pre-po")}>{prePORows.length}</span>
        </>
      ),
    },
    {
      value: "open",
      label: (
        <>
          <PackageOpen className="h-3.5 w-3.5" />
          Open
          <span className={tabBadgeClass(tab === "open")}>{openPOs.length}</span>
        </>
      ),
    },
    {
      value: "history",
      label: (
        <>
          <PackageCheck className="h-3.5 w-3.5" />
          History
          <span className={tabBadgeClass(tab === "history")}>{historyPOs.length}</span>
        </>
      ),
    },
  ];

  return (
    <div className="flex flex-1 flex-col overflow-hidden">
      {/* ─── Header ─── */}
      <div className="border-b border-border bg-surface-light px-6 py-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <div className="flex items-center gap-2 text-xs text-text-secondary">
              <span>Operations</span>
              <ChevronRight className="h-3 w-3" />
              <span>Inventory</span>
              <ChevronRight className="h-3 w-3" />
              <span className="font-medium text-text-primary">Purchase Orders</span>
            </div>
            {/* tracking-tight dropped: Heading has no letter-spacing axis (heading.tsx
                header comment, "NOT COVERED, DELIBERATELY"). mt-1 kept, it's layout. */}
            <Heading className="mt-1">Purchase Orders</Heading>
            <p className="mt-0.5 text-sm text-text-secondary">
              Track every order from quote to receipt. Pre-PO quotes · open
              orders with vendors · received history.
            </p>
          </div>
          {/* solid/brand (default size): idle fill, text colour and
              font-weight (font-semibold) all match exactly. hover:bg-primary/90
              becomes solid/brand's own hover:bg-primary-dark - a real,
              disclosed hover-token delta. Raw's px-3 (vs the default rung's
              px-4) and shadow-sm are both dropped - disclosed, not restored. */}
          <Button onClick={() => setNewPOOpen(true)}>
            <Plus className="h-4 w-4" />
            Create PO
          </Button>
        </div>

        {/* ─── 4 KPI tiles ─── */}
        <div className="mt-4 grid grid-cols-2 gap-3 lg:grid-cols-4">
          <KPITile
            label="Pre-PO pending"
            value={String(kpiPrePOPending)}
            hint="quotes + drafts + reservations awaiting decision"
            icon={ClipboardList}
            tone="amber"
            active={activeKPI === "prepo"}
            onClick={() => handleKPIClick("prepo")}
          />
          <KPITile
            label="Open POs"
            value={String(kpiOpenCount)}
            hint={`${fmtMoney(kpiOpenSpend)} in flight · click to view`}
            icon={ShoppingCart}
            tone="primary"
            active={activeKPI === "open"}
            onClick={() => handleKPIClick("open")}
          />
          <KPITile
            label="Late"
            value={String(kpiLate)}
            hint="past expected date · needs vendor follow-up"
            icon={AlertTriangle}
            tone="rose"
            active={activeKPI === "late"}
            onClick={() => handleKPIClick("late")}
          />
          <KPITile
            label="Arriving this week"
            value={String(kpiArrivingThisWeek)}
            hint="expected within 7 days · prep the dock"
            icon={CalendarClock}
            tone="sky"
            active={activeKPI === "week"}
            onClick={() => handleKPIClick("week")}
          />
        </div>
      </div>

      {/* ─── Sub-tabs ─── */}
      {/* No `<TabsContent>` here - the tab body lives in a fully separate
          sibling block below ("─── Body ───"), exactly as before, so
          TabStrip gets no children. The wrapping rail div previously wrapped
          the whole (bare) `<Tabs>` - which held nothing but the TabsList -
          so it keeps wrapping the whole (still bare) `<TabStrip>` unchanged. */}
      <div className="border-b border-border bg-surface-light px-6">
        <TabStrip
          tabs={subTabs}
          active={tab}
          onChange={(v) => setTab(v as Tab)}
          triggerVariant="underline"
          triggerClassName="gap-1.5 px-3 py-2.5"
        >
          {null}
        </TabStrip>
      </div>

      {/* ─── Search + filter row ─── */}
      <Toolbar
        className="border-b border-border bg-surface-light px-6 py-3"
        searchValue={search}
        onSearchChange={setSearch}
        searchPlaceholder="Search purchase orders…"
        searchIcon={<Search className="h-3.5 w-3.5 text-text-secondary" />}
        searchInputProps={{ size: "xs", className: "pl-8" }}
        filters={
          <>
            <FilterSelect value={vendorFilter} onChange={setVendorFilter} allLabel="All vendors" options={vendors} />
            <FilterSelect value={tradeFilter} onChange={setTradeFilter} allLabel="All trades" options={trades} />
            {tab === "pre-po" && (
              <label className="inline-flex cursor-pointer items-center gap-1.5 text-xs font-medium text-text-secondary">
                <input
                  type="checkbox"
                  checked={showResolved}
                  onChange={(e) => setShowResolved(e.target.checked)}
                  className="h-3.5 w-3.5 rounded border-border accent-primary"
                />
                Show resolved
              </label>
            )}
            {/* Raw, deferred: a filter chip with an idle bg-background-light -
                no ghost/outline cell on Button carries an idle background. */}
            {activeKPI && (
              <button
                onClick={() => setActiveKPI(null)}
                className="rounded-full bg-background-light px-2.5 py-1 text-xs font-medium text-text-secondary hover:bg-secondary-light"
                title="Click the lit KPI tile again, or use this button, to clear the filter"
              >
                Clear KPI filter ×
              </button>
            )}
          </>
        }
      />

      {/* ─── Body ─── */}
      <div className="flex-1 overflow-y-auto bg-background-light px-6 py-5">
        {tab === "pre-po" && (
          <PrePOTable
            rows={filteredPrePO}
            onRowClick={handlePrePOClick}
            onViewConvertedPO={handleViewConvertedPO}
          />
        )}
        {tab === "open" && (
          <OpenTable
            rows={
              activeKPI === "late"
                ? filteredOpen.filter(isLate)
                : activeKPI === "week"
                  ? filteredOpen.filter(isArrivingThisWeek)
                  : filteredOpen
            }
            onRowClick={handlePOClick}
            onPreview={setPreviewPO}
            onEmail={setEmailPO}
          />
        )}
        {tab === "history" && (
          <HistoryTable
            rows={filteredHistory}
            onRowClick={handlePOClick}
            onPreview={setPreviewPO}
          />
        )}
      </div>

      {/* ─── Dialogs (single set, shared across all three tabs) ─── */}
      <PODetailDialog
        open={!!detailPO}
        onClose={() => setDetailPO(null)}
        po={detailPO}
        onReceive={handleReceive}
      />

      {/* Toast on a successful receive */}
      {receiveToast && (
        <div className="pointer-events-none fixed bottom-6 left-1/2 z-[90] -translate-x-1/2 rounded-md bg-success px-4 py-2 text-sm font-medium text-on-fill shadow-lg">
          {receiveToast}
        </div>
      )}
      <POPreviewDialog
        open={!!previewPO}
        onClose={() => setPreviewPO(null)}
        po={previewPO}
      />
      <POEmailDialog
        open={!!emailPO}
        onClose={() => setEmailPO(null)}
        po={emailPO}
        onSent={(payload) => {
          // Mirror PODetailDialog's own emailed-toast for the Open-tab icon path.
          if (emailPO) setReceiveToast(`✉ ${emailPO.poNumber} emailed to ${payload.to[0]}`);
          window.setTimeout(() => setReceiveToast(null), 3500);
          setEmailPO(null);
        }}
      />
      <PrePODetailDialog
        open={!!prePOActive}
        onClose={() => setPrePOActive(null)}
        row={prePOActive}
        onConvertToPO={handleConvertReservationToPO}
        onDismiss={handleDismissReservation}
        onViewConvertedPO={() => {
          if (prePOActive) handleViewConvertedPO(prePOActive.data);
        }}
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
        onAddCategory={(c) =>
          setAllCategoriesCatalog((prev) => [...prev, c])
        }
        brands={allBrandsCatalog}
      />
    </div>
  );
}

// ─── Pre-PO helpers (extract a comparable field across the union) ─────────────
function prePOAge(r: PrePORow): number {
  const iso = r.kind === "draft" ? r.data.orderedAt : r.data.approvedAt;
  return daysBetween(iso, TODAY);
}
function prePORef(r: PrePORow): string {
  return r.kind === "draft" ? r.data.poNumber : r.data.estimateNumber;
}
function prePOVendor(r: PrePORow): string | undefined {
  if (r.kind === "draft") return r.data.vendor;
  return r.data.preferredVendor;
}
function prePOTrade(r: PrePORow): string | undefined {
  return r.data.trade;
}
function prePOJobLabel(r: PrePORow): string {
  const job = r.data.jobNumber;
  const cust = r.data.customer;
  if (job && cust) return `${job} · ${cust}`;
  return job || cust || "—";
}
function prePOTotal(r: PrePORow): number {
  if (r.kind === "draft") return poTotal(r.data);
  return r.data.reservedTotal;
}

// ─── PrePO table ──────────────────────────────────────────────────────────────
function PrePOTable({
  rows,
  onRowClick,
  onViewConvertedPO,
}: {
  rows: PrePORow[];
  onRowClick: (r: PrePORow) => void;
  onViewConvertedPO: (reservation: EstimateReservation) => void;
}) {
  if (rows.length === 0) return <PoEmptyState tab="pre-po" />;
  return (
    <ResizableTable
      rows={rows}
      getRowKey={(r) => r.kind + "_" + r.data.id}
      onRowClick={(r) => onRowClick(r)}
      columns={[
        {
          id: "type",
          header: "Type",
          width: 150,
          min: 110,
          grow: 0,
          cell: (r) => (
            <span className="inline-flex flex-col items-start gap-1">
              <TypeChip kind={r.kind} />
              {r.kind === "reservation" && (
                <StatusBadge domain="estimateReservation" status={r.data.status ?? "open"} />
              )}
            </span>
          ),
        },
        {
          id: "ref",
          header: "Ref #",
          width: 110,
          min: 90,
          cellClassName: "font-mono text-xs text-text-primary",
          cell: (r) => prePORef(r),
        },
        {
          id: "vendor",
          header: "Vendor(s)",
          width: 200,
          min: 140,
          grow: 2,
          cell: (r) => (
            <span className="text-sm text-text-secondary">
              {prePOVendor(r) ?? "—"}
            </span>
          ),
        },
        {
          id: "job",
          header: "Job / Customer",
          width: 200,
          min: 140,
          grow: 2,
          cellClassName: "text-sm text-text-secondary",
          cell: (r) => (
            <span className="flex flex-col leading-tight">
              <span>{prePOJobLabel(r)}</span>
              {/* D3/§3.1 human-call context: an approved estimate's reservation
                  stays open even when the lead is lost — show why. */}
              {r.kind === "reservation" &&
                (r.data.estimateStatus || r.data.leadStatus) && (
                  <span className="text-[11px] text-text-secondary/80">
                    Est {r.data.estimateStatus ?? "—"} · Lead {r.data.leadStatus ?? "—"}
                  </span>
                )}
            </span>
          ),
        },
        {
          id: "lines",
          header: "Lines / Units",
          width: 160,
          min: 120,
          cellClassName: "text-sm text-text-secondary",
          cell: (r) =>
            r.kind === "draft"
              ? `${r.data.lines.length} items · ${r.data.lines.reduce((s, l) => s + l.qtyOrdered, 0)} units`
              : `${r.data.linesSummary.items} items · ${r.data.linesSummary.units} units`,
        },
        {
          id: "total",
          header: "Est. Total",
          align: "right",
          width: 120,
          min: 90,
          cellClassName: "tabular-nums text-text-primary",
          cell: (r) => fmtMoney(prePOTotal(r)),
        },
        {
          id: "age",
          header: "Age",
          width: 100,
          min: 80,
          cell: (r) => {
            const age = prePOAge(r);
            const ageTone =
              age > 7 ? "text-danger" : age > 3 ? "text-warning" : "text-text-secondary";
            return (
              <span className={`text-xs font-medium ${ageTone}`}>{age}d ago</span>
            );
          },
        },
        {
          id: "next",
          header: "Next action",
          align: "right",
          width: 150,
          min: 130,
          grow: 0,
          cell: (r) => {
            // Status-aware for reservations: open → convert (detail dialog);
            // converted → jump to the linked PO; dismissed → no action.
            if (r.kind === "reservation") {
              const status = r.data.status ?? "open";
              if (status === "converted") {
                return (
                  <NextActionLabel
                    label="View PO →"
                    onClick={() => onViewConvertedPO(r.data)}
                  />
                );
              }
              if (status === "dismissed") {
                return <span className="text-xs text-text-secondary">—</span>;
              }
            }
            return (
              <NextActionLabel
                label={r.kind === "draft" ? "Send to vendor →" : "Convert to PO →"}
                onClick={() => onRowClick(r)}
              />
            );
          },
        },
      ]}
    />
  );
}

function TypeChip({ kind }: { kind: PrePORowType }) {
  const def = {
    draft: { label: "Draft", cls: "bg-secondary-light text-text-secondary" },
    reservation: { label: "Est. Reservation", cls: "bg-info/10 text-info" },
  }[kind];
  return (
    <span
      className={`inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${def.cls}`}
    >
      {def.label}
    </span>
  );
}

function NextActionLabel({
  label,
  onClick,
}: {
  label: string;
  onClick: () => void;
}) {
  return (
    // Raw, deferred: a brand-tinted filled pill (bg-primary-subtle
    // text-primary) - no matching outline/brand or subtle-fill cell on
    // Button.
    <button
      onClick={(e) => {
        e.stopPropagation();
        onClick();
      }}
      className="rounded-md bg-primary-subtle px-2.5 py-1 text-xs font-semibold text-primary hover:bg-primary/10"
    >
      {label}
    </button>
  );
}

// ─── Open table ───────────────────────────────────────────────────────────────
function OpenTable({
  rows,
  onRowClick,
  onPreview,
  onEmail,
}: {
  rows: PurchaseOrder[];
  onRowClick: (p: PurchaseOrder) => void;
  onPreview: (p: PurchaseOrder) => void;
  onEmail: (p: PurchaseOrder) => void;
}) {
  if (rows.length === 0) return <PoEmptyState tab="open" />;
  // Sort: late first, then by expected ASC
  const sorted = [...rows].sort((a, b) => {
    const aLate = isLate(a) ? 0 : 1;
    const bLate = isLate(b) ? 0 : 1;
    if (aLate !== bLate) return aLate - bLate;
    const aExp = a.expectedDate ? new Date(a.expectedDate).getTime() : Infinity;
    const bExp = b.expectedDate ? new Date(b.expectedDate).getTime() : Infinity;
    return aExp - bExp;
  });
  return (
    <ResizableTable
      rows={sorted}
      getRowKey={(p) => p.id}
      onRowClick={(p) => onRowClick(p)}
      columns={[
        {
          id: "status",
          header: "Status",
          width: 110,
          min: 90,
          grow: 0,
          cell: (p) => <StatusBadge domain="purchaseOrder" status={p.status} />,
        },
        {
          id: "po",
          header: "PO #",
          width: 110,
          min: 90,
          cellClassName: "font-mono text-xs text-text-primary",
          cell: (p) => p.poNumber,
        },
        {
          id: "vendor",
          header: "Vendor",
          width: 180,
          min: 130,
          grow: 2,
          cellClassName: "text-sm text-text-secondary",
          cell: (p) => (
            <div className="flex items-center gap-1.5">
              <Truck className="h-3.5 w-3.5 text-text-secondary" />
              {p.vendor}
            </div>
          ),
        },
        {
          id: "job",
          header: "Job / Customer",
          width: 180,
          min: 130,
          grow: 2,
          cellClassName: "text-sm text-text-secondary",
          cell: (p) =>
            p.jobNumber ? (
              <div className="flex flex-col leading-tight">
                <span className="font-mono text-[11px] text-primary">
                  {p.jobNumber}
                </span>
                <span className="text-[12px] text-text-secondary">
                  {p.customer ?? "—"}
                </span>
              </div>
            ) : (
              <span className="text-xs text-text-secondary">— no job link —</span>
            ),
        },
        {
          id: "ordered",
          header: "Ordered",
          width: 100,
          min: 80,
          cellClassName: "text-xs text-text-secondary",
          cell: (p) => fmtDate(p.orderedAt),
        },
        {
          id: "expected",
          header: "Expected",
          width: 110,
          min: 90,
          cellClassName: "text-xs",
          cell: (p) => {
            const late = isLate(p);
            const arrivingSoon = isArrivingThisWeek(p);
            return late ? (
              <span className="inline-flex items-center gap-1 font-semibold text-danger">
                <span className="h-1.5 w-1.5 rounded-full bg-danger" />
                {fmtDay(p.expectedDate)}
              </span>
            ) : arrivingSoon ? (
              <span className="font-medium text-warning">
                {fmtDay(p.expectedDate)}
              </span>
            ) : (
              <span className="text-text-secondary">{fmtDay(p.expectedDate)}</span>
            );
          },
        },
        {
          id: "lines",
          header: "Lines",
          width: 80,
          min: 60,
          cellClassName: "text-sm text-text-secondary",
          cell: (p) => p.lines.length,
        },
        {
          id: "total",
          header: "Total",
          align: "right",
          width: 120,
          min: 90,
          cellClassName: "tabular-nums text-text-primary",
          cell: (p) => fmtMoney(poTotal(p)),
        },
        {
          id: "received",
          header: "Received",
          width: 140,
          min: 110,
          cell: (p) => {
            const totalOrd = p.lines.reduce((s, l) => s + l.qtyOrdered, 0);
            const totalRec = p.lines.reduce((s, l) => s + l.qtyReceived, 0);
            const pct = totalOrd === 0 ? 0 : Math.round((totalRec / totalOrd) * 100);
            return (
              <div className="flex items-center gap-2">
                <div className="h-1.5 w-16 overflow-hidden rounded-full bg-secondary-light">
                  <div
                    className={`h-full ${pct === 100 ? "bg-success" : "bg-warning"}`}
                    style={{ width: `${pct}%` }}
                  />
                </div>
                <span className="text-[11px] tabular-nums text-text-secondary">
                  {totalRec}/{totalOrd}
                </span>
              </div>
            );
          },
        },
        {
          id: "actions",
          header: "Actions",
          align: "right",
          width: 130,
          min: 110,
          grow: 0,
          cell: (p) => (
            <RowActions
              onPreview={() => onPreview(p)}
              onEmail={() => onEmail(p)}
              onReceive={() => onRowClick(p)}
              stagedHint={p.stagedAsJobStageId != null}
            />
          ),
        },
      ]}
    />
  );
}

// ─── History table ────────────────────────────────────────────────────────────
function HistoryTable({
  rows,
  onRowClick,
  onPreview,
}: {
  rows: PurchaseOrder[];
  onRowClick: (p: PurchaseOrder) => void;
  onPreview: (p: PurchaseOrder) => void;
}) {
  if (rows.length === 0) return <PoEmptyState tab="history" />;
  // Sort by orderedAt DESC as a proxy for receivedAt (which isn't on the model yet)
  const sorted = [...rows].sort(
    (a, b) => new Date(b.orderedAt).getTime() - new Date(a.orderedAt).getTime(),
  );
  return (
    <ResizableTable
      rows={sorted}
      getRowKey={(p) => p.id}
      onRowClick={(p) => onRowClick(p)}
      columns={[
        {
          id: "status",
          header: "Status",
          width: 110,
          min: 90,
          grow: 0,
          cell: (p) => <StatusBadge domain="purchaseOrder" status={p.status} />,
        },
        {
          id: "po",
          header: "PO #",
          width: 110,
          min: 90,
          cellClassName: "font-mono text-xs text-text-primary",
          // Raw, deferred: an idle-neutral/hover-brand text link (idle
          // text-text-primary, hover text-primary + underline) - link/brand is
          // always brand-coloured at rest, so it does not reproduce this pair.
          cell: (p) => (
            <button
              onClick={(e) => {
                e.stopPropagation();
                onPreview(p);
              }}
              className="inline-flex items-center gap-1 text-text-primary hover:text-primary hover:underline"
              title="Preview PO document"
            >
              {p.poNumber}
            </button>
          ),
        },
        {
          id: "vendor",
          header: "Vendor",
          width: 180,
          min: 130,
          grow: 2,
          cellClassName: "text-sm text-text-secondary",
          cell: (p) => (
            <div className="flex items-center gap-1.5">
              <Truck className="h-3.5 w-3.5 text-text-secondary" />
              {p.vendor}
            </div>
          ),
        },
        {
          id: "job",
          header: "Job / Customer",
          width: 180,
          min: 130,
          grow: 2,
          cellClassName: "text-sm text-text-secondary",
          cell: (p) =>
            p.jobNumber ? (
              <div className="flex flex-col leading-tight">
                <span className="font-mono text-[11px] text-primary">
                  {p.jobNumber}
                </span>
                <span className="text-[12px] text-text-secondary">
                  {p.customer ?? "—"}
                </span>
              </div>
            ) : (
              <span className="text-xs text-text-secondary">— no job link —</span>
            ),
        },
        {
          id: "ordered",
          header: "Ordered",
          width: 100,
          min: 80,
          cellClassName: "text-xs text-text-secondary",
          cell: (p) => fmtDate(p.orderedAt),
        },
        {
          id: "received-on",
          header: "Received on",
          width: 110,
          min: 90,
          cellClassName: "text-xs text-text-secondary",
          // Fake a receivedAt = expectedDate for the scaffold; real field
          // lands when the model gains `receivedAt`.
          // `!= null` (not truthiness) keeps the original `??` semantics: an
          // empty expectedDate stays on the day path and renders the dash.
          cell: (p) =>
            p.expectedDate != null ? fmtDay(p.expectedDate) : fmtDate(p.orderedAt),
        },
        {
          id: "lead",
          header: "Lead time",
          width: 100,
          min: 80,
          cellClassName: "text-xs text-text-secondary",
          cell: (p) => {
            const receivedAt = p.expectedDate ?? p.orderedAt;
            const lead = daysBetween(p.orderedAt, new Date(receivedAt));
            return `${lead}d`;
          },
        },
        {
          id: "total",
          header: "Total",
          align: "right",
          width: 120,
          min: 90,
          cellClassName: "tabular-nums text-text-primary",
          cell: (p) => fmtMoney(poTotal(p)),
        },
        {
          id: "variance",
          header: "Variance",
          align: "right",
          width: 110,
          min: 90,
          cellClassName: "text-xs text-text-secondary",
          cell: () => (
            <>
              — <span title="Variance is calculated once the vendor bill is matched">i</span>
            </>
          ),
        },
      ]}
    />
  );
}

function RowActions({
  onPreview,
  onEmail,
  onReceive,
  stagedHint,
}: {
  onPreview: () => void;
  onEmail: () => void;
  onReceive: () => void;
  /** §3.6 single-receive-path: staged POs receive via the Staging view only. */
  stagedHint?: boolean;
}) {
  return (
    <div className="inline-flex items-center gap-1 opacity-60 transition group-hover:opacity-100">
      <IconBtn label="Preview PO" onClick={onPreview} icon={Eye} />
      <IconBtn label="Email PO" onClick={onEmail} icon={Mail} />
      {stagedHint ? (
        // ghost/subtle size="icon", disabled: idle text colour matches
        // exactly (hover is moot - disabled). Button's own
        // disabled:pointer-events-none disabled:opacity-50 replaces the raw's
        // cursor-not-allowed + opacity-40 - a real, disclosed delta: the
        // cursor shows the default arrow (no pointer events at all) rather
        // than "not-allowed", and the fade is 50% rather than 40%. Same
        // h-6 w-6 layout override as the sibling IconBtn below.
        <Button
          variant="ghost"
          tone="subtle"
          size="icon"
          className="h-6 w-6"
          disabled
          title="Receive via Staging — this PO is staged to a job"
          onClick={(e) => e.stopPropagation()}
        >
          <PackageCheck className="h-3.5 w-3.5" />
        </Button>
      ) : (
        <IconBtn label="Receive items" onClick={onReceive} icon={PackageCheck} />
      )}
    </div>
  );
}

function IconBtn({
  label,
  onClick,
  icon: Icon,
}: {
  label: string;
  onClick: () => void;
  icon: React.ComponentType<{ className?: string }>;
}) {
  return (
    // ghost/subtle size="icon": idle text + hover text/bg are a byte-exact
    // match. className="h-6 w-6" restores the raw's ~22px box (p-1 + h-3.5
    // icon) over the "icon" rung's 40px default - width/height is LAYOUT,
    // not appearance.
    <Button
      variant="ghost"
      tone="subtle"
      size="icon"
      className="h-6 w-6"
      title={label}
      onClick={(e) => {
        e.stopPropagation();
        onClick();
      }}
    >
      <Icon className="h-3.5 w-3.5" />
    </Button>
  );
}

// ─── Empty state copy ─────────────────────────────────────────────────────────
const PO_EMPTY_COPY: Record<Tab, { title: string; description: string }> = {
  "pre-po": {
    title: "No drafts or reservations in flight",
    description: 'Hit "+ Create PO" to draft one manually, or convert an approved estimate reservation.',
  },
  open: {
    title: "No open POs",
    description: "Everything you've sent has been received or closed. Quiet day at the dock.",
  },
  history: {
    title: "No closed POs yet",
    description: "Received and closed POs will land here for audit + lead-time analysis.",
  },
};
function PoEmptyState({ tab }: { tab: Tab }) {
  return (
    <EmptyState
      variant="card"
      icon={FileText}
      className="mx-auto max-w-[560px]"
      title={PO_EMPTY_COPY[tab].title}
      description={PO_EMPTY_COPY[tab].description}
    />
  );
}

// ─── Shared atoms (mirror VendorsPage / PriceBookPage patterns) ───────────────
function KPITile({
  label,
  value,
  hint,
  icon: Icon,
  tone,
  active,
  onClick,
}: {
  label: string;
  value: string;
  hint: string;
  icon: React.ComponentType<{ className?: string }>;
  tone: "primary" | "emerald" | "amber" | "rose" | "sky";
  active?: boolean;
  onClick?: () => void;
}) {
  const TONE = {
    primary: { ring: "ring-primary/40", icon: "text-primary", bg: "bg-primary-subtle" },
    emerald: { ring: "ring-success/20", icon: "text-success", bg: "bg-success/10" },
    amber: { ring: "ring-warning/20", icon: "text-warning", bg: "bg-warning/10" },
    rose: { ring: "ring-danger/20", icon: "text-danger", bg: "bg-danger/10" },
    sky: { ring: "ring-info/20", icon: "text-info", bg: "bg-info/10" },
  }[tone];
  return (
    // Raw, deferred: a KPI-tile click-filter target with heterogeneous
    // content (icon + label + value + hint), not a Button.
    <button
      onClick={onClick}
      className={[
        "group flex items-start gap-3 rounded-card border border-border bg-surface-light p-3 text-left transition hover:shadow-sm",
        active ? `ring-2 ${TONE.ring}` : "",
      ].join(" ")}
    >
      <div
        className={`flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-md ${TONE.bg}`}
      >
        <Icon className={`h-4 w-4 ${TONE.icon}`} />
      </div>
      <div className="flex min-w-0 flex-col leading-tight">
        <div className="text-[11px] font-semibold uppercase tracking-wide text-text-secondary">
          {label}
        </div>
        <div className="text-xl font-bold text-text-primary">{value}</div>
        <div className="mt-0.5 text-[11px] text-text-secondary">{hint}</div>
      </div>
    </button>
  );
}

function FilterSelect({
  value,
  onChange,
  allLabel,
  options,
}: {
  value: string;
  onChange: (v: string) => void;
  allLabel: string;
  options: string[];
}) {
  return (
    <SelectField
      aria-label={allLabel}
      value={value || "all"}
      onValueChange={(v) => onChange(v === "all" ? "" : v)}
      className="h-9 rounded-md border border-border bg-surface-light px-2.5 py-1.5 text-sm text-text-secondary focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/20"
      options={[{ value: "all", label: allLabel }, ...options.map((o) => ({ value: o, label: o }))]}
    />
  );
}
