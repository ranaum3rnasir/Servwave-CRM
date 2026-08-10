import type React from "react";
import { useEffect, useMemo, useState } from "react";
import {
  Award,
  BarChart3,
  Building2,
  ChevronRight,
  DollarSign,
  Layers,
  Plus,
  Search,
  TrendingDown,
  TrendingUp,
  Truck,
  Users,
} from "lucide-react";
import { TabsContent } from "@/components/ui/tabs";
import { TabStrip, type TabStripTab } from "@/components/patterns/TabStrip";
import { Toolbar } from "@/components/patterns/Toolbar";
import { Button } from "@/components/ui/button";
import { Heading } from "@/components/ui/heading";
import { useAppAbility } from "@/contexts/AbilityContext";
import {
  useVendors,
  usePurchaseOrders,
  useInventoryItems,
  useUpsertVendor,
  useDeleteVendor,
  type Vendor,
} from "@/lib/api/inventory";
import {
  computeAllVendorSpend,
  fmtMoney,
  fmtMoneyFull,
  fmtRelativeDate,
  topVendorByYTD,
  totalSpendYTD,
  type VendorSpend,
} from "@/lib/inventory/vendor-spend";
import { VendorCard } from "@/components/inventory/VendorCard";
import { VendorDetailDialog } from "@/components/inventory/VendorDetailDialog";
import { DeleteVendorDialog } from "@/components/inventory/DeleteVendorDialog";
import { AddVendorDialog } from "@/components/inventory/AddVendorDialog";
import { CategoryManagerDropdown } from "@/components/inventory/CategoryManagerDropdown";
import { ResizableTable } from "@/components/data/ResizableTable";
import { EmptyState } from "@/components/ui/empty-state";

type Tab = "directory" | "category" | "analytics";

export function VendorsPage() {
  // Seam data. Local `vendors` mirrors the query so the prototype's
  // optimistic add/edit/archive/delete still feels live on mock; the seam
  // mutations fire alongside (no-op resolve + invalidate today, real POST in
  // Track 2). Pure spend math (vendor-spend.ts) is fed the live query data.
  const { data: seedVendors = [] } = useVendors();
  const { data: purchaseOrders = [] } = usePurchaseOrders();
  const { data: allItems = [] } = useInventoryItems();
  const upsertVendor = useUpsertVendor();
  const deleteVendor = useDeleteVendor();

  const [vendors, setVendors] = useState<Vendor[]>(seedVendors);
  useEffect(() => {
    setVendors(seedVendors);
  }, [seedVendors]);

  const [toast, setToast] = useState<string | null>(null);
  function onToast(msg: string) {
    setToast(msg);
    setTimeout(() => setToast(null), 3500);
  }
  const [tab, setTab] = useState<Tab>("directory");
  const [search, setSearch] = useState("");
  const [categoryFilter, setCategoryFilter] = useState<string>("all");
  const [statusFilter, setStatusFilter] = useState<"all" | "active" | "inactive">(
    "active",
  );
  const [openVendorId, setOpenVendorId] = useState<string | null>(null);
  const [showAdd, setShowAdd] = useState(false);
  const [deleteCandidate, setDeleteCandidate] = useState<Vendor | null>(null);

  const ability = useAppAbility();
  const editable = ability.can("manage", "Inventory");

  const spendIndex = useMemo(
    () => computeAllVendorSpend(vendors, purchaseOrders, allItems),
    [vendors, purchaseOrders, allItems],
  );

  const totalYTD = totalSpendYTD(spendIndex);
  // Still computed so DirectoryView + ByCategoryView can highlight the top
  // vendor inline. The Top Vendor *tile* moved into the Spend Analytics view
  // (rev 2026-05-27) — see AnalyticsView for the banner.
  const top = topVendorByYTD(spendIndex);

  // Extra categories added via the filter-row CategoryManagerDropdown that
  // don't (yet) have a vendor attached to them. They live in component
  // state in the v1 prototype; production persists to a `vendor_category`
  // lookup table (see PRD §7.6.A "Category management").
  const [extraCategories, setExtraCategories] = useState<string[]>([]);

  const categories = useMemo(() => {
    const set = new Set<string>();
    vendors.forEach((v) => set.add(v.category));
    extraCategories.forEach((c) => set.add(c));
    return Array.from(set).sort();
  }, [vendors, extraCategories]);

  function handleAddCategory(name: string) {
    setExtraCategories((prev) =>
      prev.some((c) => c.toLowerCase() === name.toLowerCase())
        ? prev
        : [...prev, name],
    );
    onToast(`🏷 Category "${name}" added`);
  }

  function handleRenameCategory(oldName: string, newName: string) {
    // Cascade: rename every vendor that points at the old category.
    setVendors((prev) =>
      prev.map((v) =>
        v.category === oldName ? { ...v, category: newName } : v,
      ),
    );
    // Also update the orphan list if the renamed category lived there.
    setExtraCategories((prev) =>
      prev.map((c) => (c === oldName ? newName : c)),
    );
    onToast(`✏️ Category renamed: "${oldName}" → "${newName}"`);
  }

  const activeCount = vendors.filter((v) => v.status !== "inactive").length;

  const filtered = useMemo(() => {
    return vendors.filter((v) => {
      if (statusFilter !== "all" && (v.status ?? "active") !== statusFilter)
        return false;
      if (categoryFilter !== "all" && v.category !== categoryFilter)
        return false;
      if (search.trim()) {
        const q = search.toLowerCase();
        if (
          !v.name.toLowerCase().includes(q) &&
          !(v.contactPersonName ?? "").toLowerCase().includes(q) &&
          !(v.accountNumber ?? "").toLowerCase().includes(q) &&
          !(v.contactEmail ?? "").toLowerCase().includes(q) &&
          !v.category.toLowerCase().includes(q)
        )
          return false;
      }
      return true;
    });
  }, [vendors, statusFilter, categoryFilter, search]);

  const topShareOfYTD = top ? top.ytd / Math.max(totalYTD, 1) : 0;

  const openVendor = vendors.find((v) => v.id === openVendorId) ?? null;
  const openSpend = openVendor ? spendIndex.get(openVendor.name) ?? null : null;

  function handleAdd(v: Vendor) {
    setVendors((prev) => [v, ...prev]);
    upsertVendor.mutate(v);
    onToast(`🏷 Vendor "${v.name}" added`);
  }

  function handleSave(id: string, patch: Partial<Vendor>) {
    const before = vendors.find((v) => v.id === id);
    setVendors((prev) => prev.map((v) => (v.id === id ? { ...v, ...patch } : v)));
    upsertVendor.mutate({ id, ...patch });
    onToast(`✏️ ${before?.name ?? "Vendor"} updated`);
  }

  // P2 (QA-610/A-17): NO optimistic pre-removal — with the server's has-POs 409
  // guard live, the row only disappears on success. A 409 VENDOR_HAS_POS flips
  // the vendor to archived instead (the guided fallback); any other error
  // leaves everything untouched.
  function handleDelete(id: string) {
    const v = vendors.find((x) => x.id === id);
    const name = v?.name ?? id;
    deleteVendor.mutate(
      { id },
      {
        onSuccess: () => {
          setVendors((prev) => prev.filter((x) => x.id !== id));
          setOpenVendorId(null);
          onToast(`🗑 Vendor "${name}" deleted`);
        },
        onError: (err) => {
          const resp = (err as { response?: { status?: number; data?: { error?: string } } })?.response;
          if (resp?.status === 409 && resp.data?.error === "VENDOR_HAS_POS") {
            // Archive as the guided fallback — ONLY from the 409 path.
            if (v && v.status !== "inactive") handleArchiveToggle(v);
            setOpenVendorId(null);
            onToast(`"${name}" has purchase orders — archived instead of deleted`);
            return;
          }
          onToast(`Could not delete "${name}" — try again`);
        },
      },
    );
  }

  function handleArchiveToggle(v: Vendor) {
    const next = v.status === "inactive" ? "active" : "inactive";
    setVendors((prev) =>
      prev.map((x) => (x.id === v.id ? { ...x, status: next } : x)),
    );
    upsertVendor.mutate({ id: v.id, status: next });
    onToast(
      next === "inactive"
        ? `📦 Archived ${v.name} · still on historical POs`
        : `✓ Reactivated ${v.name}`,
    );
  }

  const tabs: TabStripTab[] = [
    {
      value: "directory",
      label: (
        <>
          <Building2 className="h-3.5 w-3.5" />
          Directory
          <TabCount value={filtered.length} active={tab === "directory"} />
        </>
      ),
    },
    {
      value: "category",
      label: (
        <>
          <Layers className="h-3.5 w-3.5" />
          By Category
          <TabCount value={categories.length} active={tab === "category"} />
        </>
      ),
    },
    {
      value: "analytics",
      label: (
        <>
          <BarChart3 className="h-3.5 w-3.5" />
          Spend Analytics
          <TabCount value={vendors.length} active={tab === "analytics"} />
        </>
      ),
    },
  ];

  return (
    <div className="flex flex-1 flex-col overflow-hidden">
      {/* Header */}
      <div className="border-b border-border bg-surface-light px-6 py-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <div className="flex items-center gap-2 text-xs text-text-secondary">
              <span>Operations</span>
              <ChevronRight className="h-3 w-3" />
              <span>Inventory</span>
              <ChevronRight className="h-3 w-3" />
              <span className="font-medium text-text-primary">Vendors</span>
            </div>
            {/* tracking-tight dropped: Heading has no letter-spacing axis (heading.tsx
                header comment, "NOT COVERED, DELIBERATELY"). mt-1 kept, it's layout. */}
            <Heading className="mt-1">Vendors</Heading>
            <p className="mt-0.5 text-sm text-text-secondary">
              Master vendor list · spend tracking · purchasing power. Track who
              you buy from, how much, and what they cost you year to date —
              ammunition for negotiation.
            </p>
          </div>
          {/* solid/brand (default size): idle fill, text colour and font-weight
              (font-semibold) all match exactly. hover:bg-primary/90 becomes
              solid/brand's own hover:bg-primary-dark - a real, disclosed hover-
              token delta, not exact. Raw's px-3 (vs the default rung's px-4)
              and shadow-sm are both dropped - disclosed, not restored. */}
          {editable && (
            <Button onClick={() => setShowAdd(true)}>
              <Plus className="h-4 w-4" />
              Add Vendor
            </Button>
          )}
        </div>

        {/* KPI tiles — each is a clickable filter trigger, same locked
            pattern as the Items KPI tiles (§5.4.A) and the Staging KPI
            tiles (§7.4.A.2). Click jumps to the matching sub-tab and (where
            appropriate) flips a row-filter so the page reflects what the
            tile is showing. Top Vendor was removed from this row in rev
            2026-05-27 — its info now lives prominently inside the Spend
            Analytics view, where total-spend conversations actually happen. */}
        <div className="mt-4 grid grid-cols-3 gap-3">
          <KPITile
            label="Active Vendors"
            value={String(activeCount)}
            hint={`of ${vendors.length} total · click to show only active`}
            icon={Users}
            tone="primary"
            active={tab === "directory" && statusFilter === "active"}
            ariaLabel="Show only active vendors in the Directory"
            onClick={() => {
              setTab("directory");
              setStatusFilter("active");
            }}
          />
          <KPITile
            label="Total Spend YTD"
            value={fmtMoneyFull(totalYTD)}
            hint="across all vendors · click for spend leaderboard"
            icon={DollarSign}
            tone="emerald"
            active={tab === "analytics"}
            ariaLabel="Open the Spend Analytics view"
            onClick={() => setTab("analytics")}
          />
          <KPITile
            label="Categories"
            value={String(categories.length)}
            hint="distinct vendor types · click to group by category"
            icon={Layers}
            tone="sky"
            active={tab === "category"}
            ariaLabel="Open the By Category view"
            onClick={() => setTab("category")}
          />
        </div>
      </div>

      {/*
        TabStrip fuses TabsList and its children into one `<Tabs>` root with
        no seam a wrapper could sit between (phase 11.6 constraint - see
        TabStrip.tsx's own header comment and the same note on TasksHubPage /
        JobDetailPage). The old rail div
        (`border-b border-border bg-surface-light px-6`, wrapping ONLY
        TabsList) can't survive as a literal wrapper for that reason, but
        every rendered pixel it produced is reproduced without it:
          - `border-b border-border` -> TabStrip's default `listVariant`
            ("line") already puts that exact border directly on TabsList, at
            the same Y position the rail div drew it at (the rail div carried
            no vertical padding of its own beyond `px-6`, so its border sat
            flush against TabsList's own bottom edge either way - the old
            `border-0` on TabsList just avoided a redundant second line at
            that identical spot).
          - `px-6` -> moved onto TabsList itself via `padX={6}`
            (`design-system/spacing.ts` PadStep 6 = `px-6`, byte-identical).
          - `bg-surface-light` -> moved up to this outer div. TabsList paints
            no background of its own, so this is the only place left to carry
            it; every other band already paints its OWN background
            explicitly (Toolbar's `bg-surface-light`, the content div's
            `bg-background-light`), so nothing below this line actually shows
            the outer div's color except the strip where TabsList used to
            reveal the rail div's - same color, same spot.
        Net effect: the same 3 stacked bands (tab row / Toolbar / content),
        same borders, same background per band, same Toolbar position
        relative to the tabs - just re-homed onto TabStrip's prop surface
        plus this one outer div instead of a dedicated rail div. TabsContent
        stays real (passed as TabStrip's own children), so panel ARIA/focus
        wiring is unchanged.
        One disclosed, unreproduced diff: the old TabsList's own `gap-1`
        (4px between triggers) has no home on TabStrip's prop surface (no
        `listClassName`/gap override), so this reverts to TabsList's baked-in
        `gap-[26px]` default - the same category of loss already accepted for
        CustomerDetailPage's `gap-0` override, see TabStrip.tsx's own header
        comment. `justify-start`/`h-auto` on the old TabsList were no-ops
        (equivalent to the unstyled default either way) and are not missed.
        TabStrip forwards no `className` to the `<Tabs>` root it renders
        (deliberate, see TabStrip.tsx's own header comment), so the old
        `flex flex-1 flex-col overflow-hidden` that used to live directly on
        `<Tabs>` - the thing that makes the content pane below scroll
        internally instead of the whole page - has nowhere to attach inside
        TabStrip. Re-applied via a `[&>div]:` child selector on this
        outer div, targeting the `<Tabs>` root it wraps (a plain div, no
        `asChild`) - same pattern already used elsewhere in this tree for
        styling a child a component doesn't expose className for (see
        `components/inventory/StageDetailDialog.tsx`'s `[&>button]:hidden`).
      */}
      <div className="flex flex-1 flex-col overflow-hidden bg-surface-light [&>div]:flex [&>div]:min-h-0 [&>div]:flex-1 [&>div]:flex-col [&>div]:overflow-hidden">
      <TabStrip
        tabs={tabs}
        active={tab}
        onChange={(v) => setTab(v as Tab)}
        triggerVariant="underline"
        triggerClassName="gap-1.5 px-3 py-2"
        padX={6}
      >
        {/* Search + filter row (shared across all three tabs) */}
        <Toolbar
          className="border-b border-border bg-surface-light px-6 py-3"
          searchValue={search}
          onSearchChange={setSearch}
          searchPlaceholder="Search vendors…"
          searchIcon={<Search className="h-3.5 w-3.5 text-text-secondary" />}
          searchInputProps={{ size: "xs", className: "pl-8" }}
          filters={
            <>
              <CategoryManagerDropdown
                value={categoryFilter}
                categories={categories}
                onSelect={setCategoryFilter}
                onAddCategory={handleAddCategory}
                onRenameCategory={handleRenameCategory}
              />
              {/* Raw, deferred: a segmented status-filter toggle group, not a
                  Button - three joined pill states sharing one border. */}
              <div className="inline-flex overflow-hidden rounded-md border border-border">
                {(["all", "active", "inactive"] as const).map((s) => (
                  <button
                    key={s}
                    onClick={() => setStatusFilter(s)}
                    className={[
                      "px-2.5 py-1.5 text-xs font-medium capitalize",
                      statusFilter === s
                        ? "bg-primary text-on-fill"
                        : "bg-surface-light text-text-secondary hover:bg-background-light",
                    ].join(" ")}
                  >
                    {s}
                  </button>
                ))}
              </div>
              <span className="text-xs text-text-secondary">
                {filtered.length} of {vendors.length} vendors
              </span>
            </>
          }
        />

        {/* Tab content */}
        <div className="flex-1 overflow-y-auto bg-background-light px-6 py-4">
          <TabsContent value="directory" className="mt-0">
            <DirectoryView
              vendors={filtered}
              spendIndex={spendIndex}
              totalYTD={totalYTD}
              topShareOfYTD={topShareOfYTD}
              onOpen={(id) => setOpenVendorId(id)}
            />
          </TabsContent>
          <TabsContent value="category" className="mt-0">
            <ByCategoryView
              vendors={filtered}
              spendIndex={spendIndex}
              totalYTD={totalYTD}
              topShareOfYTD={topShareOfYTD}
              onOpen={(id) => setOpenVendorId(id)}
            />
          </TabsContent>
          <TabsContent value="analytics" className="mt-0">
            <AnalyticsView
              vendors={filtered}
              spendIndex={spendIndex}
              totalYTD={totalYTD}
              onOpen={(id) => setOpenVendorId(id)}
            />
          </TabsContent>
        </div>
      </TabStrip>
      </div>

      {/* Dialogs */}
      <AddVendorDialog
        open={showAdd}
        onClose={() => setShowAdd(false)}
        onCreate={handleAdd}
        existingCategories={categories}
      />
      <VendorDetailDialog
        open={!!openVendor}
        onClose={() => setOpenVendorId(null)}
        vendor={openVendor}
        spend={openSpend}
        pos={purchaseOrders}
        items={allItems}
        existingCategories={categories}
        onSave={handleSave}
        onDeleteRequest={(v) => setDeleteCandidate(v)}
        onArchiveToggle={handleArchiveToggle}
      />
      <DeleteVendorDialog
        open={!!deleteCandidate}
        onClose={() => setDeleteCandidate(null)}
        vendor={deleteCandidate}
        items={allItems}
        pos={purchaseOrders}
        onDelete={handleDelete}
        onArchive={(id) => {
          const v = vendors.find((x) => x.id === id);
          if (v) handleArchiveToggle(v);
        }}
      />

      {/* Toast */}
      {toast && (
        <div className="fixed bottom-6 right-6 z-[60] rounded-card border border-success/20 bg-success/10 px-4 py-3 text-sm font-medium text-success shadow-lg ring-1 ring-success/20">
          {toast}
        </div>
      )}
    </div>
  );
}

function DirectoryView({
  vendors,
  spendIndex,
  totalYTD,
  topShareOfYTD,
  onOpen,
}: {
  vendors: Vendor[];
  spendIndex: Map<string, VendorSpend>;
  totalYTD: number;
  topShareOfYTD: number;
  onOpen: (id: string) => void;
}) {
  if (vendors.length === 0) {
    return <EmptyState variant="card" icon={Truck} title="No vendors match your filters." />;
  }
  return (
    <div className="grid grid-cols-1 gap-3 md:grid-cols-2 lg:grid-cols-3">
      {vendors.map((v) => {
        const spend = spendIndex.get(v.name);
        if (!spend) return null;
        const share = totalYTD > 0 ? spend.ytd / totalYTD : 0;
        return (
          <VendorCard
            key={v.id}
            vendor={v}
            spend={spend}
            shareOfYTD={share}
            topShareOfYTD={topShareOfYTD}
            onClick={() => onOpen(v.id)}
          />
        );
      })}
    </div>
  );
}

function ByCategoryView({
  vendors,
  spendIndex,
  totalYTD,
  topShareOfYTD,
  onOpen,
}: {
  vendors: Vendor[];
  spendIndex: Map<string, VendorSpend>;
  totalYTD: number;
  topShareOfYTD: number;
  onOpen: (id: string) => void;
}) {
  const groups = useMemo(() => {
    const map = new Map<string, Vendor[]>();
    for (const v of vendors) {
      const list = map.get(v.category) ?? [];
      list.push(v);
      map.set(v.category, list);
    }
    return Array.from(map.entries()).sort((a, b) => a[0].localeCompare(b[0]));
  }, [vendors]);

  if (groups.length === 0) {
    return <EmptyState variant="card" title="No vendors match your filters." />;
  }

  return (
    <div className="flex flex-col gap-4">
      {groups.map(([cat, list]) => {
        const catYTD = list.reduce(
          (sum, v) => sum + (spendIndex.get(v.name)?.ytd ?? 0),
          0,
        );
        return (
          <section key={cat}>
            <div className="mb-2 flex items-baseline justify-between gap-2 px-1">
              <Heading level={3}>
                {cat}{" "}
                <span className="ml-1 rounded-full bg-background-light px-1.5 py-0.5 text-[10px] font-semibold text-text-secondary">
                  {list.length}
                </span>
              </Heading>
              <span className="text-xs text-text-secondary">
                {fmtMoney(catYTD)} YTD
              </span>
            </div>
            <div className="grid grid-cols-1 gap-3 md:grid-cols-2 lg:grid-cols-3">
              {list.map((v) => {
                const spend = spendIndex.get(v.name);
                if (!spend) return null;
                const share = totalYTD > 0 ? spend.ytd / totalYTD : 0;
                return (
                  <VendorCard
                    key={v.id}
                    vendor={v}
                    spend={spend}
                    shareOfYTD={share}
                    topShareOfYTD={topShareOfYTD}
                    onClick={() => onOpen(v.id)}
                  />
                );
              })}
            </div>
          </section>
        );
      })}
    </div>
  );
}

function AnalyticsView({
  vendors,
  spendIndex,
  totalYTD,
  onOpen,
}: {
  vendors: Vendor[];
  spendIndex: Map<string, VendorSpend>;
  totalYTD: number;
  onOpen: (id: string) => void;
}) {
  const ranked = useMemo(
    () =>
      [...vendors]
        .map((v) => ({ vendor: v, spend: spendIndex.get(v.name) }))
        .filter(
          (r): r is { vendor: Vendor; spend: VendorSpend } => !!r.spend,
        )
        .sort((a, b) => b.spend.ytd - a.spend.ytd),
    [vendors, spendIndex],
  );
  const top = ranked[0];

  if (ranked.length === 0) {
    return <EmptyState variant="card" title="No vendors match your filters." />;
  }

  return (
    <div className="rounded-md border border-border bg-surface-light">
      <div className="border-b border-border px-3 py-2 text-[10px] font-semibold uppercase tracking-wide text-text-secondary">
        Spend leaderboard · YTD
      </div>
      <ResizableTable
        rows={ranked}
        getRowKey={(r) => r.vendor.id}
        onRowClick={(r) => onOpen(r.vendor.id)}
        columns={[
          {
            id: "rank",
            header: "#",
            width: 64,
            min: 48,
            grow: 0,
            cellClassName: "text-text-secondary",
            cell: (r) => {
              const idx = ranked.indexOf(r);
              return idx === 0 ? (
                <span className="inline-flex items-center gap-1 font-semibold text-warning">
                  <Award className="h-3 w-3" /> 1
                </span>
              ) : (
                <span>{idx + 1}</span>
              );
            },
          },
          {
            id: "vendor",
            header: "Vendor",
            grow: 3,
            cell: (r) => (
              <>
                <p className="font-semibold text-text-primary">
                  {r.vendor.name}
                </p>
                {r.vendor.contactPersonName && (
                  <p className="text-[10px] text-text-secondary">
                    {r.vendor.contactPersonName}
                  </p>
                )}
              </>
            ),
          },
          {
            id: "category",
            header: "Category",
            cellClassName: "text-text-secondary",
            cell: (r) => r.vendor.category,
          },
          {
            id: "ytd",
            header: "YTD Spend",
            align: "right",
            cellClassName: "tabular-nums font-mono font-semibold text-text-primary",
            cell: (r) => fmtMoneyFull(r.spend.ytd),
          },
          {
            id: "share",
            header: "Share",
            cell: (r) => {
              const share = totalYTD > 0 ? r.spend.ytd / totalYTD : 0;
              const barWidth =
                top && top.spend.ytd > 0
                  ? Math.max(2, (r.spend.ytd / top.spend.ytd) * 100)
                  : 0;
              return (
                <div className="flex items-center gap-1.5">
                  <div className="h-1.5 w-24 overflow-hidden rounded-full bg-success/10">
                    <div
                      className="h-full rounded-full bg-success"
                      style={{ width: `${barWidth}%` }}
                    />
                  </div>
                  <span className="font-mono text-[10px] text-text-secondary">
                    {(share * 100).toFixed(1)}%
                  </span>
                </div>
              );
            },
          },
          {
            id: "mom",
            header: "MoM",
            cell: (r) =>
              r.spend.lastMonth > 0 ? (
                <span
                  className={[
                    "inline-flex items-center gap-0.5 text-[11px]",
                    r.spend.momDelta >= 0
                      ? "text-success"
                      : "text-danger",
                  ].join(" ")}
                >
                  {r.spend.momDelta >= 0 ? (
                    <TrendingUp className="h-3 w-3" />
                  ) : (
                    <TrendingDown className="h-3 w-3" />
                  )}
                  {Math.abs(r.spend.momDeltaPct * 100).toFixed(0)}%
                </span>
              ) : (
                <span className="text-[11px] text-text-secondary">—</span>
              ),
          },
          {
            id: "pos",
            header: "POs",
            align: "right",
            cellClassName: "tabular-nums font-mono text-text-secondary",
            cell: (r) => r.spend.ytdPoCount,
          },
          {
            id: "last",
            header: "Last ordered",
            cellClassName: "text-text-secondary",
            cell: (r) => fmtRelativeDate(r.spend.lastOrderedAt),
          },
        ]}
      />
      <div className="border-t border-border bg-background-light px-3 py-2 text-[10px] italic text-text-secondary">
        Purchasing power = your share of total inventory spend. Vendors at the
        top of this list are your strongest negotiation levers — when you're
        about to start a big job, lead with your YTD volume to ask for better
        terms, faster ship, or discount tiers.
      </div>
    </div>
  );
}

function TabCount({ value, active }: { value: number; active: boolean }) {
  return (
    <span
      className={[
        "rounded-full px-1.5 py-0.5 text-[10px] font-semibold",
        active
          ? "bg-primary-subtle text-primary"
          : "bg-background-light text-text-secondary",
      ].join(" ")}
    >
      {value}
    </span>
  );
}

function KPITile({
  label,
  value,
  hint,
  icon: Icon,
  tone,
  valueClass,
  onClick,
  active,
  ariaLabel,
}: {
  label: string;
  value: string;
  hint: string;
  icon: React.ComponentType<{ className?: string }>;
  tone: "emerald" | "primary" | "amber" | "sky";
  valueClass?: string;
  /** When provided, the tile becomes a clickable filter trigger — same locked
   *  pattern as the Items KPI tiles (§5.4.A) and Staging KPI tiles
   *  (§7.4.A.2): active state gets a charcoal/primary ring + "filtered" pill. */
  onClick?: () => void;
  active?: boolean;
  ariaLabel?: string;
}) {
  const tones: Record<typeof tone, string> = {
    emerald: "border-success/20 bg-success/10",
    primary: "border-primary/30 bg-primary-subtle/40",
    amber: "border-warning/20 bg-warning/10",
    sky: "border-info/20 bg-info/10",
  };
  const iconTones: Record<typeof tone, string> = {
    emerald: "text-success",
    primary: "text-primary",
    amber: "text-warning",
    sky: "text-info",
  };
  const body = (
    <>
      <div className="flex items-center justify-between">
        <span className="flex items-center gap-1 text-[10px] font-semibold uppercase tracking-wide text-text-secondary">
          {label}
          {active && (
            <span className="rounded-full bg-primary px-1.5 py-0 text-[9px] font-bold uppercase tracking-wide text-on-fill">
              filtered
            </span>
          )}
        </span>
        <Icon className={`h-3.5 w-3.5 ${iconTones[tone]}`} />
      </div>
      <p className={`mt-1 font-bold text-text-primary ${valueClass ?? "text-xl"}`}>
        {value}
      </p>
      <p className="text-[10px] text-text-secondary">{hint}</p>
    </>
  );

  const baseCls = `rounded-md border p-3 ${tones[tone]}`;
  if (!onClick) {
    return <div className={baseCls}>{body}</div>;
  }
  return (
    // Raw, deferred: a KPI-tile click-filter target with heterogeneous
    // content (icon + label + value + hint), not a Button.
    <button
      type="button"
      onClick={onClick}
      aria-label={ariaLabel ?? `${label} · click to filter`}
      aria-pressed={active}
      title={ariaLabel ?? `${label} · click to filter`}
      className={[
        baseCls,
        "text-left transition hover:shadow-sm focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/40",
        active ? "ring-2 ring-primary" : "",
      ].join(" ")}
    >
      {body}
    </button>
  );
}

export default VendorsPage;
