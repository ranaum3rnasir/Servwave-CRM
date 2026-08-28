import { useEffect, useMemo, useState } from 'react';
import { BarChart3, Building2, Download, Layers, Plus, Truck } from 'lucide-react';

import { useAppAbility } from '@/contexts/AbilityContext';
import { downloadCSV, toCSV } from '@/lib/inventory/csv';
import { useScopedRowSelection } from '@/lib/useScopedRowSelection';
import {
  useDeleteVendor, useInventoryItems, usePurchaseOrders, useUpsertVendor, useVendors,
  type Vendor,
} from '@/lib/api/inventory';
import {
  computeAllVendorSpend, fmtMoney, fmtMoneyFull, topVendorByYTD, totalSpendYTD,
  type VendorSpend,
} from '@/lib/inventory/vendor-spend';

// Legacy components reused unchanged - each owns real behaviour (the vendor
// form, the delete/archive decision tree, the category rename cascade) and is
// a row in the module's gap ledger.
import { AddVendorDialog } from '@/components/inventory/AddVendorDialog';
import { CategoryManagerDropdown } from '@/components/inventory/CategoryManagerDropdown';
import { DeleteVendorDialog } from '@/components/inventory/DeleteVendorDialog';
import { VendorCard } from '@/components/inventory/VendorCard';
import { VendorDetailDialog } from '@/components/inventory/VendorDetailDialog';

import { DataTable } from '@/ui-kit/components/data/dataTable/dataTable';
import { EmptyState } from '@/ui-kit/components/data/emptyState';
import { StatCard, StatCardGroup } from '@/ui-kit/components/data/statCard';
import { PageHeader } from '@/ui-kit/components/layout/pageHeader';
import { SearchInput } from '@/ui-kit/components/form/searchInput';
import { Badge } from '@/ui-kit/components/ui/badge';
import { Button } from '@/ui-kit/components/ui/button';
import { Card, CardContent, CardFooter, CardHeader } from '@/ui-kit/components/ui/card';
import { toast } from '@/ui-kit/components/ui/sonner';
import { cn } from '@/ui-kit/lib/utils';

import { useRecordVisit } from '../pageBreadcrumbs';
import { TabPanel, TabStrip } from '../_shared/tabs';
import { ExportBulkBar } from './components/exportBulkBar';
import { EM_DASH } from './glyphs';
import { buildVendorSpendColumns, type RankedVendor } from './vendorSpendColumns';

type Tab = 'directory' | 'category' | 'analytics';
type StatusFilter = 'all' | 'active' | 'inactive';

const STATUS_FILTERS: StatusFilter[] = ['all', 'active', 'inactive'];

/**
 * /v2/inventory/vendors - the vendor directory on the CRM UI kit.
 *
 * Every query, mutation, filter rule and toast string is the legacy page's.
 * Presentation only: the three bespoke KPI tiles become kit StatCards, the
 * app's TabStrip pattern becomes the kit-built one the v2 modules share, the
 * bespoke search/filter rail becomes kit SearchInput plus a segmented Button
 * group, and the Spend Analytics ResizableTable becomes the kit DataTable.
 *
 * `VendorCard`, and all four dialogs, are the legacy components - the cards
 * carry the spend maths and the dialogs carry the delete/archive contract,
 * including the 409 VENDOR_HAS_POS fallback.
 */
export function VendorsPage() {
  useRecordVisit('inventory', 'Vendors');
  // NO `= []` DEFAULT: the seed effect below keys on this value, and that
  // default mints a FRESH array every render while the query is pending, so
  // the effect re-fires forever. Same landmine as the price book and the PO
  // page; `InventoryPage`'s guarded form is the fix.
  const { data: seedVendors } = useVendors();
  const { data: purchaseOrders = [] } = usePurchaseOrders();
  const { data: allItems = [] } = useInventoryItems();
  const upsertVendor = useUpsertVendor();
  const deleteVendor = useDeleteVendor();

  const [vendors, setVendors] = useState<Vendor[]>([]);
  // eslint-disable-next-line react-hooks/set-state-in-effect -- vendors mirror is seeded from the query, then mutated by in-page add / edit / deactivate
  useEffect(() => { if (seedVendors) setVendors(seedVendors); }, [seedVendors]);

  function onToast(msg: string) {
    toast(msg);
  }

  const [tab, setTab] = useState<Tab>('directory');
  const [search, setSearch] = useState('');
  const [categoryFilter, setCategoryFilter] = useState<string>('all');
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('active');
  const [openVendorId, setOpenVendorId] = useState<string | null>(null);
  const [showAdd, setShowAdd] = useState(false);
  const [deleteCandidate, setDeleteCandidate] = useState<Vendor | null>(null);

  const ability = useAppAbility();
  const editable = ability.can('manage', 'Inventory');

  const spendIndex = useMemo(
    () => computeAllVendorSpend(vendors, purchaseOrders, allItems),
    [vendors, purchaseOrders, allItems],
  );

  const totalYTD = totalSpendYTD(spendIndex);
  const top = topVendorByYTD(spendIndex);

  // Categories added from the filter-row dropdown that have no vendor attached
  // yet. Component state in the prototype; production persists them to a
  // `vendor_category` lookup table.
  const [extraCategories, setExtraCategories] = useState<string[]>([]);

  const categories = useMemo(() => {
    const set = new Set<string>();
    vendors.forEach((v) => set.add(v.category));
    extraCategories.forEach((c) => set.add(c));
    return Array.from(set).sort();
  }, [vendors, extraCategories]);

  function handleAddCategory(name: string) {
    setExtraCategories((prev) =>
      prev.some((c) => c.toLowerCase() === name.toLowerCase()) ? prev : [...prev, name],
    );
    onToast(`🏷 Category "${name}" added`);
  }

  function handleRenameCategory(oldName: string, newName: string) {
    // Cascade: rename every vendor that points at the old category.
    setVendors((prev) => prev.map((v) => (v.category === oldName ? { ...v, category: newName } : v)));
    setExtraCategories((prev) => prev.map((c) => (c === oldName ? newName : c)));
    onToast(`✏️ Category renamed: "${oldName}" → "${newName}"`);
  }

  const activeCount = vendors.filter((v) => v.status !== 'inactive').length;

  const filtered = useMemo(() => {
    return vendors.filter((v) => {
      if (statusFilter !== 'all' && (v.status ?? 'active') !== statusFilter) return false;
      if (categoryFilter !== 'all' && v.category !== categoryFilter) return false;
      if (search.trim()) {
        const q = search.toLowerCase();
        if (
          !v.name.toLowerCase().includes(q) &&
          !(v.contactPersonName ?? '').toLowerCase().includes(q) &&
          !(v.accountNumber ?? '').toLowerCase().includes(q) &&
          !(v.contactEmail ?? '').toLowerCase().includes(q) &&
          !v.category.toLowerCase().includes(q)
        ) {
          return false;
        }
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
    onToast(`✏️ ${before?.name ?? 'Vendor'} updated`);
  }

  // NO optimistic pre-removal - with the server's has-POs 409 guard live, the
  // row only disappears on success. A 409 VENDOR_HAS_POS flips the vendor to
  // archived instead; any other error leaves everything untouched.
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
          if (resp?.status === 409 && resp.data?.error === 'VENDOR_HAS_POS') {
            if (v && v.status !== 'inactive') handleArchiveToggle(v);
            setOpenVendorId(null);
            onToast(`"${name}" has purchase orders ${EM_DASH} archived instead of deleted`);
            return;
          }
          onToast(`Could not delete "${name}" ${EM_DASH} try again`);
        },
      },
    );
  }

  function handleArchiveToggle(v: Vendor) {
    const next = v.status === 'inactive' ? 'active' : 'inactive';
    setVendors((prev) => prev.map((x) => (x.id === v.id ? { ...x, status: next } : x)));
    upsertVendor.mutate({ id: v.id, status: next });
    onToast(
      next === 'inactive'
        ? `📦 Archived ${v.name} · still on historical POs`
        : `✓ Reactivated ${v.name}`,
    );
  }

  const ranked = useMemo<RankedVendor[]>(
    () =>
      [...filtered]
        .map((v) => ({ vendor: v, spend: spendIndex.get(v.name) }))
        .filter((r): r is RankedVendor => !!r.spend)
        .sort((a, b) => b.spend.ytd - a.spend.ytd),
    [filtered, spendIndex],
  );

  const spendColumns = useMemo(
    () => buildVendorSpendColumns({ ranked, totalYTD, selectable: true }),
    [ranked, totalYTD],
  );

  // A selected id only makes sense against the CURRENT leaderboard, and the
  // leaderboard is derived from `filtered` - so the scope key is exactly the
  // three inputs that narrow it. `tab` is in it too: the panel unmounts on a
  // tab switch, and carrying a hidden selection back would be a surprise.
  const selectionScope = JSON.stringify([tab, search, categoryFilter, statusFilter]);
  const { rowSelection, setRowSelection, selectedIds } = useScopedRowSelection(selectionScope);
  const selectedRanked = useMemo(
    () => ranked.filter((r) => selectedIds.includes(r.vendor.id)),
    [ranked, selectedIds],
  );

  /**
   * The leaderboard's CSV export. NEW - neither this page nor its legacy
   * counterpart had one, so there was no exporter to reuse.
   *
   * Written once and used twice: the panel's Export takes the whole ranked
   * leaderboard, Export selected takes the ticked rows, and both go through
   * the shared `toCSV`/`downloadCSV` writer. `Rank` and `Share` are the two
   * values the table computes rather than reads, and both are computed here
   * the same way the cells compute them - rank from the row's position in
   * `ranked` (not in the current sort), share against the TOTAL rather than
   * against the top vendor.
   */
  const toSpendExportRow = (r: RankedVendor) => ({
    Rank: ranked.indexOf(r) + 1,
    Vendor: r.vendor.name,
    Contact: r.vendor.contactPersonName ?? '',
    Category: r.vendor.category,
    'YTD Spend': r.spend.ytd,
    'Share of YTD': totalYTD > 0 ? Number((r.spend.ytd / totalYTD).toFixed(4)) : 0,
    'MoM Delta': r.spend.lastMonth > 0 ? Number(r.spend.momDeltaPct.toFixed(4)) : '',
    'POs YTD': r.spend.ytdPoCount,
    'Last ordered': r.spend.lastOrderedAt ?? '',
  });

  function exportSpend(list: RankedVendor[], suffix: string) {
    if (list.length === 0) return;
    const date = new Date().toISOString().slice(0, 10);
    downloadCSV(toCSV(list.map(toSpendExportRow)), `vendor-spend${suffix}-${date}.csv`);
  }

  const groups = useMemo(() => {
    const map = new Map<string, Vendor[]>();
    for (const v of filtered) {
      const list = map.get(v.category) ?? [];
      list.push(v);
      map.set(v.category, list);
    }
    return Array.from(map.entries()).sort((a, b) => a[0].localeCompare(b[0]));
  }, [filtered]);

  function renderCards(list: Vendor[]) {
    return (
      <div className="grid grid-cols-1 gap-3 md:grid-cols-2 lg:grid-cols-3">
        {list.map((v) => {
          const spend = spendIndex.get(v.name);
          if (!spend) return null;
          return (
            <VendorCard
              key={v.id}
              vendor={v}
              spend={spend}
              shareOfYTD={totalYTD > 0 ? spend.ytd / totalYTD : 0}
              topShareOfYTD={topShareOfYTD}
              onClick={() => setOpenVendorId(v.id)}
            />
          );
        })}
      </div>
    );
  }

  const tabs = [
    {
      value: 'directory',
      label: (
        <span className="flex items-center gap-1.5">
          <Building2 className="size-3.5" />
          Directory
          <Badge variant="softNeutral" size="pill">{filtered.length}</Badge>
        </span>
      ),
    },
    {
      value: 'category',
      label: (
        <span className="flex items-center gap-1.5">
          <Layers className="size-3.5" />
          By Category
          <Badge variant="softNeutral" size="pill">{categories.length}</Badge>
        </span>
      ),
    },
    {
      value: 'analytics',
      label: (
        <span className="flex items-center gap-1.5">
          <BarChart3 className="size-3.5" />
          Spend Analytics
          <Badge variant="softNeutral" size="pill">{vendors.length}</Badge>
        </span>
      ),
    },
  ];

  return (
    <div>
      <PageHeader
        title="Vendors"
        description="Master vendor list · spend tracking · purchasing power. Track who you buy from, how much, and what they cost you year to date - ammunition for negotiation."
        actions={
          editable ? (
            <Button onClick={() => setShowAdd(true)}>
              <Plus />
              Add Vendor
            </Button>
          ) : undefined
        }
      />

      {/* Each tile is a clickable filter trigger: click jumps to the matching
          sub-tab and, where appropriate, flips a row filter. */}
      <StatCardGroup className="mb-4 xl:grid-cols-3">
        <StatCard
          label="Active Vendors"
          value={String(activeCount)}
          active={tab === 'directory' && statusFilter === 'active'}
          aria-label="Show only active vendors in the Directory"
          onClick={() => { setTab('directory'); setStatusFilter('active'); }}
        />
        <StatCard
          label="Total Spend YTD"
          value={fmtMoneyFull(totalYTD)}
          active={tab === 'analytics'}
          aria-label="Open the Spend Analytics view"
          onClick={() => setTab('analytics')}
        />
        <StatCard
          label="Categories"
          value={String(categories.length)}
          active={tab === 'category'}
          aria-label="Open the By Category view"
          onClick={() => setTab('category')}
        />
      </StatCardGroup>

      <TabStrip tabs={tabs} value={tab} onValueChange={(v) => setTab(v as Tab)} />

      {/* Search + filter row, shared across all three tabs exactly as before. */}
      <div className="flex flex-wrap items-center gap-2 border-b px-2 py-3">
        <div className="min-w-[12rem] flex-1">
          <SearchInput value={search} onValueChange={setSearch} placeholder="Search vendors…" />
        </div>
        <CategoryManagerDropdown
          value={categoryFilter}
          categories={categories}
          onSelect={setCategoryFilter}
          onAddCategory={handleAddCategory}
          onRenameCategory={handleRenameCategory}
        />
        {/* The segmented status filter. Three kit Buttons sharing one border
            rather than the legacy hand-rolled pill group; `aria-pressed` is the
            state the legacy version only expressed with colour. */}
        <div role="group" aria-label="Vendor status" className="inline-flex overflow-hidden rounded-md border">
          {STATUS_FILTERS.map((s) => (
            <Button
              key={s}
              variant={statusFilter === s ? 'default' : 'ghost'}
              size="sm"
              aria-pressed={statusFilter === s}
              className={cn('rounded-none capitalize')}
              onClick={() => setStatusFilter(s)}
            >
              {s}
            </Button>
          ))}
        </div>
        <span className="text-muted-foreground text-xs">
          {filtered.length} of {vendors.length} vendors
        </span>
      </div>

      <div className="pt-4">
        <TabPanel value="directory" activeValue={tab}>
          {filtered.length === 0 ? (
            <EmptyState icon={<Truck />} title="No vendors match your filters." />
          ) : (
            renderCards(filtered)
          )}
        </TabPanel>

        <TabPanel value="category" activeValue={tab}>
          {groups.length === 0 ? (
            <EmptyState title="No vendors match your filters." />
          ) : (
            <div className="flex flex-col gap-4">
              {groups.map(([cat, list]) => {
                const catYTD = list.reduce((sum, v) => sum + (spendIndex.get(v.name)?.ytd ?? 0), 0);
                return (
                  <section key={cat}>
                    <div className="mb-2 flex items-baseline justify-between gap-2 px-1">
                      <span role="heading" aria-level={3} className="flex items-center gap-2 font-semibold">
                        {cat}
                        <Badge variant="softNeutral" size="pill">{list.length}</Badge>
                      </span>
                      <span className="text-muted-foreground text-xs">{fmtMoney(catYTD)} YTD</span>
                    </div>
                    {renderCards(list)}
                  </section>
                );
              })}
            </div>
          )}
        </TabPanel>

        <TabPanel value="analytics" activeValue={tab}>
          {ranked.length === 0 ? (
            <EmptyState title="No vendors match your filters." />
          ) : (
            <Card className="gap-0">
              <CardHeader className="text-muted-foreground flex flex-wrap items-center justify-between gap-2 border-b px-3 py-2 text-[10px] font-semibold uppercase">
                Spend leaderboard · YTD
                {/* Exports the whole ranked leaderboard. Its selected-row
                    sibling lives in the bulk bar below and shares this page's
                    one exporter. */}
                <Button
                  variant="outline"
                  size="sm"
                  title={`Export ${ranked.length} vendors as CSV`}
                  onClick={() => exportSpend(ranked, '')}
                >
                  <Download />
                  Export
                </Button>
              </CardHeader>
              <CardContent className="px-0 pb-0">
                <DataTable
                  columns={spendColumns}
                  data={ranked}
                  getRowId={(r) => r.vendor.id}
                  onRowClick={(r) => setOpenVendorId(r.vendor.id)}
                  rowSelection={rowSelection}
                  onRowSelectionChange={setRowSelection}
                  enableColumnResizing
                  mobileCards
                  empty={<EmptyState title="No vendors match your filters." />}
                >
                  {() => (
                    <ExportBulkBar
                      count={selectedRanked.length}
                      noun={['vendor', 'vendors']}
                      onClear={() => setRowSelection({})}
                      onExportSelected={() => exportSpend(selectedRanked, '-selected')}
                    />
                  )}
                </DataTable>
              </CardContent>
              <CardFooter className="text-muted-foreground border-t px-3 py-2 text-[10px] italic">
                Purchasing power = your share of total inventory spend. Vendors at the top of this list
                are your strongest negotiation levers - when you&apos;re about to start a big job, lead
                with your YTD volume to ask for better terms, faster ship, or discount tiers.
              </CardFooter>
            </Card>
          )}
        </TabPanel>
      </div>

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
        spend={openSpend as VendorSpend | null}
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
    </div>
  );
}

export default VendorsPage;
