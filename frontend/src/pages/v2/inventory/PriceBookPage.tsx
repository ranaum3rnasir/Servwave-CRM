import { useEffect, useMemo, useState } from 'react';
import {
  Construction, Download, ExternalLink, Image as ImageIcon, Layers, List, Package,
  Pencil, Plus, Tag, Trash2,
} from 'lucide-react';

import { safeHref } from '@/lib/safe-href';
import { useConfirm } from '@/hooks/useConfirm';
import { downloadCSV, toCSV } from '@/lib/inventory/csv';
import {
  adoptServerId, startingThresholdsFor,
  useBrands, useCategories, useDeleteBrand, useDeleteCategory, useDeleteItemGroup,
  useFinishes, useInventoryItems, useItemGroups, useSetThresholds, useUpsertBrand, useUpsertCategory,
  useUpsertItem, useUpsertItemGroup, useUpsertVendor, useVendors,
  type Brand, type Category, type Item, type ItemGroup, type ItemGroupLine,
  type ItemVisibility, type Vendor,
} from '@/lib/api/inventory';
import { formatCurrency } from '@/lib/utils';

// Legacy dialogs reused unchanged.
import { AddBrandDialog } from '@/components/inventory/AddBrandDialog';
import { AddCategoryDialog } from '@/components/inventory/AddCategoryDialog';
import { AddGroupDialog } from '@/components/inventory/AddGroupDialog';
import { AddItemDialog } from '@/components/inventory/AddItemDialog';

import { DataTable } from '@/ui-kit/components/data/dataTable/dataTable';
import { DataTableToolbar } from '@/ui-kit/components/data/dataTable/dataTableToolbar';
import { EmptyState } from '@/ui-kit/components/data/emptyState';
import { StatCard, StatCardGroup } from '@/ui-kit/components/data/statCard';
import { PageHeader } from '@/ui-kit/components/layout/pageHeader';
import { SearchInput } from '@/ui-kit/components/form/searchInput';
import { Avatar } from '@/ui-kit/components/ui/avatar';
import { Badge } from '@/ui-kit/components/ui/badge';
import { Button } from '@/ui-kit/components/ui/button';
import { Card, CardContent, CardFooter, CardHeader } from '@/ui-kit/components/ui/card';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/ui-kit/components/ui/select';
import { toast } from '@/ui-kit/components/ui/sonner';
import { cn } from '@/ui-kit/lib/utils';

import { useRecordVisit } from '../pageBreadcrumbs';
import { TabPanel, TabStrip } from '../_shared/tabs';
import { buildPriceBookColumns } from './priceBookColumns';

type Tab = 'items' | 'brands' | 'groups' | 'categories' | 'catalog';

const TAB_DEFS: { id: Tab; label: string; icon: typeof Package }[] = [
  { id: 'items', label: 'Items', icon: Package },
  { id: 'brands', label: 'Brands', icon: Tag },
  { id: 'groups', label: 'Groups', icon: Layers },
  { id: 'categories', label: 'Categories', icon: List },
  { id: 'catalog', label: 'Catalog', icon: ImageIcon },
];

const TABS = TAB_DEFS.map((t) => ({
  value: t.id,
  label: (
    <span className="flex items-center gap-1.5">
      <t.icon className="size-3.5" />
      {t.label}
    </span>
  ),
}));

/**
 * A hero banner backed by a photo URL.
 *
 * The legacy cards used a raw `<img>` inside an `aspect-[2/1]` box. A raw
 * `<img>` outside the primitives is on the component-api ratchet's floor, and
 * the kit's only image primitive is Avatar - which is a 46px chip, not a
 * banner. So the photo rides as a CSS background on the box the card already
 * needed. It is decorative either way: the card's own heading carries the name.
 */
function HeroBanner({ photoUrl, fallback }: { photoUrl?: string | null; fallback: React.ReactNode }) {
  return (
    <div
      aria-hidden
      className={cn('bg-muted relative aspect-[2/1] w-full overflow-hidden', !photoUrl && 'flex items-center justify-center')}
      style={photoUrl ? { backgroundImage: `url("${photoUrl}")`, backgroundSize: 'cover', backgroundPosition: 'center' } : undefined}
    >
      {!photoUrl && fallback}
    </div>
  );
}

/** The hover-revealed edit/delete pair the Groups and Categories cards share. */
function CardTools({
  name, onEdit, onDelete, editTitle, deleteTitle,
}: {
  name: string;
  onEdit: () => void;
  onDelete: () => void;
  editTitle: string;
  deleteTitle: string;
}) {
  return (
    <div className="absolute top-2 right-2 flex gap-1">
      <Button variant="outline" size="icon-sm" title={editTitle} aria-label={`Edit ${name}`} onClick={onEdit}>
        <Pencil />
      </Button>
      <Button variant="outline" size="icon-sm" title={deleteTitle} aria-label={`Delete ${name}`} onClick={onDelete}>
        <Trash2 />
      </Button>
    </div>
  );
}

/**
 * /v2/inventory/price-book - the INVENTORY price book on the CRM UI kit.
 *
 * Distinct from the app's own `/price-book`. Five tabs: Items, Brands, Groups,
 * Categories and the Phase-B Catalog placeholder. Every query, mutation,
 * filter rule, mutual-exclusion rule between the KPI tiles and the visibility
 * dropdown, delete guard and confirm string is the legacy page's.
 */
export function PriceBookPage() {
  useRecordVisit('pricebook');
  const { confirm, confirmDialog } = useConfirm();
  const [tab, setTab] = useState<Tab>('items');

  // NO `= []` DEFAULT on a value a seed effect keys on.
  //
  // `const { data: seedX = [] } = useX()` mints a FRESH array on every render
  // while the query is pending, so the effect below sees a changed dependency
  // every render and re-fires forever. It is a documented landmine on these
  // pages - `src/__tests__/purchase-orders-deeplink.test.tsx` and
  // `price-book-persistence.test.tsx` both mock the seam with stable data
  // specifically to dodge it, and a jsdom mount that goes through axios hangs
  // outright. Reading the raw `data` and guarding the effect is what
  // `InventoryPage` already does, and it removes the loop at the source.
  const { data: seedBrands } = useBrands();
  // Finish is read-only on this page - it is edited from the item dialog and
  // only resolved here - so it needs no local mirror and no seed effect.
  const { data: finishes } = useFinishes();
  const { data: seedGroups } = useItemGroups();
  const { data: seedItems } = useInventoryItems();
  const { data: seedVendors } = useVendors();
  const { data: seedCategories } = useCategories();

  const upsertItem = useUpsertItem();
  const upsertBrand = useUpsertBrand();
  const upsertItemGroup = useUpsertItemGroup();
  const upsertCategory = useUpsertCategory();
  const upsertVendor = useUpsertVendor();
  const deleteBrandMut = useDeleteBrand();
  const deleteItemGroupMut = useDeleteItemGroup();
  const deleteCategoryMut = useDeleteCategory();
  const setThresholds = useSetThresholds();

  const [brands, setBrands] = useState<Brand[]>([]);
  const [groups, setGroups] = useState<ItemGroup[]>([]);
  const [items, setItems] = useState<Item[]>([]);
  const [allVendors, setAllVendors] = useState<Vendor[]>([]);
  const [allCategories, setAllCategories] = useState<Category[]>([]);

  // eslint-disable-next-line react-hooks/set-state-in-effect -- brands mirror is seeded from the query, then mutated by in-page brand add / edit / delete
  useEffect(() => { if (seedBrands) setBrands(seedBrands); }, [seedBrands]);
  // eslint-disable-next-line react-hooks/set-state-in-effect -- item-groups mirror is seeded here, then mutated by in-page group add / edit / delete
  useEffect(() => { if (seedGroups) setGroups(seedGroups); }, [seedGroups]);
  // eslint-disable-next-line react-hooks/set-state-in-effect -- items mirror is seeded here, then mutated as prices and thresholds are edited in-page
  useEffect(() => { if (seedItems) setItems(seedItems); }, [seedItems]);
  // eslint-disable-next-line react-hooks/set-state-in-effect -- vendors mirror is seeded here, then extended by a vendor created from inside the item dialog
  useEffect(() => { if (seedVendors) setAllVendors(seedVendors); }, [seedVendors]);
  // eslint-disable-next-line react-hooks/set-state-in-effect -- categories mirror is seeded here, then mutated by in-page category add / delete
  useEffect(() => { if (seedCategories) setAllCategories(seedCategories); }, [seedCategories]);

  const [editingItem, setEditingItem] = useState<Item | null>(null);
  const [showAddItem, setShowAddItem] = useState(false);
  const [showAddBrand, setShowAddBrand] = useState(false);
  const [editingBrand, setEditingBrand] = useState<Brand | null>(null);
  const [showAddGroup, setShowAddGroup] = useState(false);
  const [editingGroup, setEditingGroup] = useState<ItemGroup | null>(null);
  const [showAddCategory, setShowAddCategory] = useState(false);
  const [editingCategory, setEditingCategory] = useState<Category | null>(null);

  const [itemSearch, setItemSearch] = useState('');
  const [filterBrand, setFilterBrand] = useState<string>('');
  const [filterCategory, setFilterCategory] = useState<string>('');
  const [filterVisibility, setFilterVisibilityRaw] = useState<'all' | ItemVisibility>('all');
  // KPI-tile-driven filter dimensions with no dropdown counterpart.
  const [filterPhoto, setFilterPhoto] = useState<'all' | 'with'>('all');
  const [filterPrice, setFilterPrice] = useState<'all' | 'missing'>('all');

  const [groupSearch, setGroupSearch] = useState('');
  const [groupTypeFilter, setGroupTypeFilter] = useState<'all' | 'individual' | 'flat_rate'>('all');

  // The Visibility dropdown is the dropdown counterpart of the In Catalog /
  // Hidden tiles, so picking ANY value here clears the photo + price tile
  // filters, keeping the "only one tile active at a time" invariant.
  function setFilterVisibility(v: 'all' | ItemVisibility) {
    if (v !== 'all') {
      setFilterPhoto('all');
      setFilterPrice('all');
    }
    setFilterVisibilityRaw(v);
  }

  // Finish is a foreign key: resolve id -> name once, not per rendered row.
  const finishNameById = useMemo(
    () => new Map((finishes ?? []).map((f) => [f.id, f.name])),
    [finishes],
  );

  const itemsByBrand = useMemo(() => {
    const map = new Map<string, number>();
    items.forEach((i) => { if (i.brandId) map.set(i.brandId, (map.get(i.brandId) ?? 0) + 1); });
    return map;
  }, [items]);

  // Item count keyed by category NAME (items carry category as a name string).
  const itemsByCategoryName = useMemo(() => {
    const map = new Map<string, number>();
    items.forEach((i) => { if (i.category) map.set(i.category, (map.get(i.category) ?? 0) + 1); });
    return map;
  }, [items]);

  const filteredItems = useMemo(() => {
    const q = itemSearch.trim().toLowerCase();
    return items.filter((it) => {
      if (filterBrand && it.brandId !== filterBrand) return false;
      if (filterCategory && it.category !== filterCategory) return false;
      if (filterVisibility !== 'all' && (it.visibility ?? 'catalog') !== filterVisibility) return false;
      if (filterPhoto === 'with' && !it.photoUrl) return false;
      if (filterPrice === 'missing' && (it.sellPrice || it.listPrice)) return false;
      if (q) {
        // The three identifiers are in the haystack because they are now both
        // storable and shown: an operator who saves a part number goes looking
        // for the item BY that part number, and a supplier quote names the
        // model number rather than our SKU. Finish is a foreign key, so it is
        // matched on the resolved NAME - the id is an opaque uuid nobody types.
        const hay = [
          it.name,
          it.customerName ?? '',
          it.sku,
          it.modelNumber ?? '',
          it.mpn ?? '',
          finishNameById.get(it.finishId ?? '') ?? '',
        ].join(' ').toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
  }, [items, itemSearch, filterBrand, filterCategory, filterVisibility, filterPhoto, filterPrice, finishNameById]);

  const filteredGroups = useMemo(() => {
    const q = groupSearch.trim().toLowerCase();
    return groups.filter((g) => {
      if (groupTypeFilter !== 'all' && g.groupType !== groupTypeFilter) return false;
      if (q) return `${g.name} ${g.description ?? ''}`.toLowerCase().includes(q);
      return true;
    });
  }, [groups, groupSearch, groupTypeFilter]);

  const catalogCount = items.filter((i) => (i.visibility ?? 'catalog') === 'catalog').length;
  const internalCount = items.filter((i) => i.visibility === 'internal_only').length;
  const withPhoto = items.filter((i) => !!i.photoUrl).length;
  const withoutPrice = items.filter((i) => !i.sellPrice && !i.listPrice).length;

  /**
   * The Items tab's CSV export. NEW - neither this page nor its legacy
   * counterpart had one, so there was no exporter to reuse.
   *
   * It takes the whole filtered set: the grid has no row selection any more, so
   * "what the table is showing" is the only thing there is to export. It still
   * goes through the shared `toCSV`/`downloadCSV` writer
   * (`src/__tests__/csv-export-guard.test.ts` requires it of every exporter).
   * The columns are the grid's own, in the grid's order, resolved the same way
   * the cells resolve them - the customer-facing name where one is set, the
   * brand NAME rather than its uuid, and the same listPrice -> sellPrice price
   * fallback.
   */
  const toExportRow = (it: Item) => ({
    SKU: it.sku,
    Item: it.customerName ?? it.name,
    Brand: brands.find((b) => b.id === it.brandId)?.name ?? '',
    Category: it.category,
    Type: it.type === 'MATERIAL' ? 'Material' : 'Service',
    Price: it.listPrice ?? it.sellPrice ?? '',
    Taxable: it.taxable === false ? 'N' : 'Y',
    Visibility: (it.visibility ?? 'catalog') === 'catalog' ? 'Catalog' : 'Internal',
  });

  function exportItems(list: Item[]) {
    if (list.length === 0) return;
    const date = new Date().toISOString().slice(0, 10);
    downloadCSV(toCSV(list.map(toExportRow)), `price-book-${date}.csv`);
  }

  const itemColumns = useMemo(
    () =>
      // No `selectable`: the grid has no bulk action to select FOR, and a
      // tick column that only ever feeds an export the toolbar already offers
      // is a column of dead weight on every row.
      buildPriceBookColumns({
        brands,
        finishNameById,
        onToggleVisibility: (itemId) =>
          setItems((prev) =>
            prev.map((it) =>
              it.id === itemId
                ? {
                    ...it,
                    visibility: (it.visibility ?? 'catalog') === 'catalog' ? 'internal_only' : 'catalog',
                  }
                : it,
            ),
          ),
      }),
    // finishNameById is a dependency because the Item cell reads it - leaving it
    // out prints the finish only for whatever map existed on first render.
    [brands, finishNameById],
  );

  // Effective price/cost lookup mirrors the dialog - an override falls back to
  // the referenced item's listPrice/sellPrice/unitCost.
  function linePrice(line: ItemGroupLine): number {
    if (line.priceOverride != null) return line.priceOverride;
    if (line.itemId) {
      const it = items.find((x) => x.id === line.itemId);
      if (it) return it.listPrice ?? it.sellPrice ?? 0;
    }
    return 0;
  }
  function lineCost(line: ItemGroupLine): number {
    if (line.costOverride != null) return line.costOverride;
    if (line.itemId) {
      const it = items.find((x) => x.id === line.itemId);
      if (it) return it.unitCost ?? 0;
    }
    return 0;
  }
  function groupSubtotal(g: ItemGroup): number {
    return g.lines.reduce((sum, l) => sum + linePrice(l) * l.quantity, 0);
  }
  function groupCostBasis(g: ItemGroup): number {
    return g.lines.reduce((sum, l) => sum + lineCost(l) * l.quantity, 0);
  }
  function customerSeesPrice(g: ItemGroup): number {
    if (g.groupType === 'individual') return groupSubtotal(g);
    return g.flatRatePriceOverride ?? groupSubtotal(g);
  }
  function marginPct(g: ItemGroup): number | null {
    const p = customerSeesPrice(g);
    const c = groupCostBasis(g);
    if (p <= 0) return null;
    if (c <= 0) return 100;
    return ((p - c) / p) * 100;
  }

  return (
    <div>
      <PageHeader
        title="Price Book"
        description="Customer-facing pricing catalog · brands · groups · categories. Items auto-mirror from Inventory; the customer never sees stock numbers or vendor cost."
      />

      <TabStrip className="mb-4" tabs={TABS} value={tab} onValueChange={(v) => setTab(v as Tab)} />

      <TabPanel value="items" activeValue={tab}>
        {/* Each tile is a one-click filter trigger; clicking the active tile
            clears it back to "all". Selecting any tile clears the other two
            dimensions - the legacy mutual-exclusion rule. */}
        <StatCardGroup className="mb-4 xl:grid-cols-4">
          <StatCard
            label="In Catalog"
            value={catalogCount}
            active={filterVisibility === 'catalog'}
            aria-label="Show only items currently in the customer-facing catalog"
            onClick={() =>
              filterVisibility === 'catalog' ? setFilterVisibility('all') : setFilterVisibility('catalog')
            }
          />
          <StatCard
            label="Hidden from Catalog"
            value={internalCount}
            active={filterVisibility === 'internal_only'}
            aria-label="Show only items hidden from the customer-facing catalog"
            onClick={() =>
              filterVisibility === 'internal_only'
                ? setFilterVisibility('all')
                : setFilterVisibility('internal_only')
            }
          />
          <StatCard
            label="With Photo"
            value={withPhoto}
            active={filterPhoto === 'with'}
            aria-label="Show only items that already have a product photo"
            onClick={() => {
              if (filterPhoto === 'with') { setFilterPhoto('all'); return; }
              setFilterPhoto('with');
              setFilterVisibilityRaw('all');
              setFilterPrice('all');
            }}
          />
          <StatCard
            label="No Price Set"
            value={withoutPrice}
            active={filterPrice === 'missing'}
            aria-label="Show only items missing both list price and sell price"
            onClick={() => {
              if (filterPrice === 'missing') { setFilterPrice('all'); return; }
              setFilterPrice('missing');
              setFilterVisibilityRaw('all');
              setFilterPhoto('all');
            }}
          />
        </StatCardGroup>

        <DataTable
          columns={itemColumns}
          data={filteredItems}
          getRowId={(it) => it.id}
          onRowClick={(it) => setEditingItem(it)}
          enableColumnResizing
          mobileCards
          empty={<EmptyState title="No items match the active filters." />}
        >
          {(table) => (
            <DataTableToolbar
              table={table}
              searchValue={itemSearch}
              onSearchChange={setItemSearch}
              searchPlaceholder="Search price book…"
              filters={
                <>
                  {/* Each filter names its own width. SelectTrigger is `w-full`
                      by default, which is right for a form field and wrong in a
                      toolbar: inside a flex row a 100%-wide item demands the
                      whole row, so the three filters and the search box each
                      took a line of their own and the actions dropped to a
                      fifth. Same call-site width idiom the rest of v2 already
                      uses (`w-32` on the automations unit pickers, `w-[140px]`
                      on the shared time select). */}
                  <Select
                    value={filterBrand || 'all'}
                    onValueChange={(v) => setFilterBrand(v === 'all' ? '' : v)}
                  >
                    <SelectTrigger size="sm" className="w-44" aria-label="Brand"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="all">All Brands</SelectItem>
                      {brands.map((b) => <SelectItem key={b.id} value={b.id}>{b.name}</SelectItem>)}
                    </SelectContent>
                  </Select>
                  <Select
                    value={filterCategory || 'all'}
                    onValueChange={(v) => setFilterCategory(v === 'all' ? '' : v)}
                  >
                    <SelectTrigger size="sm" className="w-44" aria-label="Category"><SelectValue /></SelectTrigger>
                    {/* `avoidCollisions={false}` pins it BELOW the trigger. The
                        category list is the long one of the three, so it was
                        the only filter Radix ever flipped upwards - opening in
                        the opposite direction to its two neighbours. SelectContent's
                        own cap on the Radix available-height variable still
                        clamps it to the room below and scrolls inside. */}
                    <SelectContent avoidCollisions={false}>
                      <SelectItem value="all">All Categories</SelectItem>
                      {allCategories.map((c) => <SelectItem key={c.id} value={c.name}>{c.name}</SelectItem>)}
                    </SelectContent>
                  </Select>
                  <Select
                    value={filterVisibility}
                    onValueChange={(v) => setFilterVisibility(v as 'all' | ItemVisibility)}
                  >
                    <SelectTrigger size="sm" className="w-44" aria-label="Visibility"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="all">All visibility</SelectItem>
                      <SelectItem value="catalog">Catalog only</SelectItem>
                      <SelectItem value="internal_only">Internal only</SelectItem>
                    </SelectContent>
                  </Select>
                </>
              }
              actions={
                <>
                  <span className="text-muted-foreground text-xs">
                    {filteredItems.length} of {items.length} items
                  </span>
                  <Button size="sm" type="button" onClick={() => setShowAddItem(true)}>
                    <Plus />
                    Add Item
                  </Button>
                  {/* Exports what the table is showing, so it sits with the
                      other table controls. */}
                  <Button
                    variant="outline"
                    size="sm"
                    type="button"
                    title={`Export ${filteredItems.length} items as CSV`}
                    onClick={() => exportItems(filteredItems)}
                  >
                    <Download />
                    Export
                  </Button>
                </>
              }
            />
          )}
        </DataTable>
      </TabPanel>

      <TabPanel value="brands" activeValue={tab}>
        <div className="mb-4 flex items-center justify-between">
          <span className="text-muted-foreground text-sm">
            {brands.length} brand{brands.length === 1 ? '' : 's'} configured
          </span>
          <Button size="sm" onClick={() => { setEditingBrand(null); setShowAddBrand(true); }}>
            <Plus />
            Add Brand
          </Button>
        </div>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {brands.map((b) => (
            <Card key={b.id}>
              <CardHeader className="flex items-start justify-between gap-3">
                <div className="flex min-w-0 flex-1 items-start gap-3">
                  <Avatar name={b.name} src={b.logoUrl ?? undefined} size="lg" className="rounded-lg" />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span role="heading" aria-level={3} className="truncate font-semibold">{b.name}</span>
                      {b.isActive === false && <Badge variant="softNeutral" size="pill">Inactive</Badge>}
                    </div>
                    {b.description && (
                      <p className="text-muted-foreground mt-1 text-xs">{b.description}</p>
                    )}
                  </div>
                </div>
                <div className="flex gap-1">
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    title="Edit brand"
                    aria-label={`Edit ${b.name}`}
                    onClick={() => { setEditingBrand(b); setShowAddBrand(true); }}
                  >
                    <Tag />
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    title="Delete brand"
                    aria-label={`Delete ${b.name}`}
                    onClick={async () => {
                      const count = itemsByBrand.get(b.id) ?? 0;
                      if (count > 0) {
                        toast.error("Can't delete this brand", {
                          description: `${count} item${count > 1 ? 's' : ''} still reference it. Re-assign first.`,
                        });
                        return;
                      }
                      if (
                        await confirm({
                          title: 'Delete this brand?',
                          description: "This can't be undone.",
                          confirmLabel: 'Delete',
                          tone: 'danger',
                        })
                      ) {
                        deleteBrandMut.mutate({ id: b.id });
                        setBrands((prev) => prev.filter((x) => x.id !== b.id));
                      }
                    }}
                  >
                    <Trash2 />
                  </Button>
                </div>
              </CardHeader>
              <CardContent className="flex flex-col gap-2 text-[11px]">
                <div className="bg-muted rounded px-2 py-1.5">
                  <div className="text-muted-foreground">Items</div>
                  <div className="font-semibold">{itemsByBrand.get(b.id) ?? 0}</div>
                </div>
                {b.defaultMarkupPct != null && (
                  <div className="text-muted-foreground">
                    Default markup:{' '}
                    <span className="text-foreground font-medium">
                      {b.defaultMarkupPct - 1 >= 0
                        ? `${Math.round((b.defaultMarkupPct - 1) * 100)}%`
                        : `${b.defaultMarkupPct}×`}
                    </span>
                  </div>
                )}
                {/* Opened rather than linked: a raw <a> outside the primitives
                    sits on the component-api ratchet's floor and the kit ships
                    no anchor primitive. `safeHref` still vets the URL, and
                    noopener/noreferrer are passed to window.open instead. */}
                {b.website && (
                  <Button
                    variant="link"
                    size="sm"
                    className="h-auto justify-start p-0"
                    onClick={() => window.open(safeHref(b.website), '_blank', 'noopener,noreferrer')}
                  >
                    <ExternalLink />
                    Website
                  </Button>
                )}
              </CardContent>
            </Card>
          ))}
        </div>
      </TabPanel>

      <TabPanel value="groups" activeValue={tab}>
        <Card className="mb-4">
          <CardContent className="px-4 text-sm">
            <strong>Preset bundles</strong> for fast estimate + invoice creation. Build a bundle once
            (parts + labor + dispatch fees), then drop it onto any estimate by name - every line
            populates automatically. Pick <em>Individual items</em> to show the breakdown to the
            customer, or <em>Flat rate</em> to charge a single lump sum.
          </CardContent>
        </Card>

        {/* Same two-group toolbar the Items tab gets from DataTableToolbar and
            the Brands / Categories tabs build by hand: everything that NARROWS
            the list on the left, the count and the one thing that ADDS to it on
            the right. New Bundle used to sit at the end of a single wrapping
            run of controls, so it landed wherever the search field happened to
            stop - mid-row on a wide screen, and somewhere else again on a
            narrow one - while every other tab's primary action was pinned to
            the right edge. `ml-auto` opens the gap; the two halves still wrap
            as one unit on a phone. */}
        <div className="mb-4 flex flex-wrap items-center gap-2">
          <div className="min-w-[12rem] max-w-sm flex-1">
            <SearchInput value={groupSearch} onValueChange={setGroupSearch} placeholder="Search bundles…" />
          </div>
          <Select
            value={groupTypeFilter}
            onValueChange={(v) => setGroupTypeFilter(v as 'all' | 'individual' | 'flat_rate')}
          >
            <SelectTrigger size="sm" className="w-44" aria-label="Bundle format"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All formats</SelectItem>
              <SelectItem value="individual">Individual items</SelectItem>
              <SelectItem value="flat_rate">Flat rate</SelectItem>
            </SelectContent>
          </Select>
          <div className="ml-auto flex items-center gap-2">
            <span className="text-muted-foreground text-sm">
              {filteredGroups.length} of {groups.length} bundle{groups.length === 1 ? '' : 's'}
            </span>
            <Button size="sm" onClick={() => { setEditingGroup(null); setShowAddGroup(true); }}>
              <Plus />
              New Bundle
            </Button>
          </div>
        </div>

        {filteredGroups.length === 0 ? (
          <EmptyState
            icon={<Layers />}
            title="No bundles yet"
            description="Create your first preset bundle. Standard rekey jobs, lockout service, HVAC capacitor swap - bundle them once and reuse on every estimate."
            action={
              <Button size="sm" onClick={() => { setEditingGroup(null); setShowAddGroup(true); }}>
                <Plus />
                New Bundle
              </Button>
            }
          />
        ) : (
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {filteredGroups.map((g) => {
              const customerPrice = customerSeesPrice(g);
              const subtotal = groupSubtotal(g);
              const margin = marginPct(g);
              const isFlat = g.groupType === 'flat_rate';
              return (
                <Card key={g.id} className="gap-0 overflow-hidden">
                  <div className="relative">
                    <HeroBanner
                      photoUrl={g.photoUrl}
                      fallback={<Layers className="text-subtle-foreground size-8" />}
                    />
                    <div className="absolute top-2 left-2 flex flex-col gap-1">
                      <Badge variant={isFlat ? 'softAmber' : 'softBlue'} size="pill">
                        {isFlat ? 'Flat rate' : 'Itemized'}
                      </Badge>
                      {!g.isActive && <Badge variant="softNeutral" size="pill">Inactive</Badge>}
                    </div>
                    <CardTools
                      name={g.name}
                      editTitle="Edit bundle"
                      deleteTitle="Delete bundle"
                      onEdit={() => { setEditingGroup(g); setShowAddGroup(true); }}
                      onDelete={async () => {
                        if (
                          await confirm({
                            title: `Delete bundle "${g.name}"?`,
                            description: 'Estimates already saved with this bundle are unaffected.',
                            confirmLabel: 'Delete',
                            tone: 'danger',
                          })
                        ) {
                          deleteItemGroupMut.mutate({ id: g.id });
                          setGroups((prev) => prev.filter((x) => x.id !== g.id));
                        }
                      }}
                    />
                  </div>
                  <CardContent className="flex flex-1 flex-col gap-2 p-4">
                    <span role="heading" aria-level={3} className="font-semibold">{g.name}</span>
                    {g.description && <p className="text-muted-foreground text-xs">{g.description}</p>}
                    <div className="bg-muted mt-1 rounded-md px-2 py-1.5">
                      <div className="text-muted-foreground text-[10px] uppercase">
                        {g.lines.length} line{g.lines.length === 1 ? '' : 's'}
                      </div>
                      <ul className="mt-0.5 text-[11px]">
                        {g.lines.slice(0, 3).map((l) => (
                          <li key={l.id} className="truncate">
                            <span className="text-muted-foreground tabular-nums">{l.quantity}×</span>{' '}
                            {l.name || '-'}
                          </li>
                        ))}
                        {g.lines.length > 3 && (
                          <li className="text-muted-foreground text-[10px]">
                            +{g.lines.length - 3} more…
                          </li>
                        )}
                      </ul>
                    </div>
                    <div className="mt-auto flex items-end justify-between border-t pt-2">
                      <div>
                        <div className="text-muted-foreground text-[10px] uppercase">Customer sees</div>
                        <div className="text-brand text-lg font-bold tabular-nums">
                          {formatCurrency(customerPrice)}
                        </div>
                        {isFlat && g.flatRatePriceOverride != null && subtotal !== customerPrice && (
                          <div className="text-muted-foreground text-[10px]">
                            items sum: {formatCurrency(subtotal)}
                          </div>
                        )}
                      </div>
                      {margin != null && (
                        <div className="text-right">
                          <div className="text-muted-foreground text-[10px] uppercase">Margin</div>
                          <div
                            className={cn(
                              'text-sm font-semibold tabular-nums',
                              margin >= 50
                                ? 'text-status-green-emphasis'
                                : margin >= 25
                                  ? 'text-status-amber-emphasis'
                                  : 'text-status-red-emphasis',
                            )}
                          >
                            {margin.toFixed(0)}%
                          </div>
                        </div>
                      )}
                    </div>
                  </CardContent>
                </Card>
              );
            })}
          </div>
        )}
      </TabPanel>

      <TabPanel value="categories" activeValue={tab}>
        <div className="mb-4 flex items-center justify-between">
          <span className="text-muted-foreground text-sm">
            {allCategories.length} categor{allCategories.length === 1 ? 'y' : 'ies'} · cross-brand
            part-type axis (Cylinders, Strikes, Capacitors…)
          </span>
          <Button size="sm" onClick={() => { setEditingCategory(null); setShowAddCategory(true); }}>
            <Plus />
            Add Category
          </Button>
        </div>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {allCategories.map((c) => (
            <Card key={c.id} className="gap-0 overflow-hidden">
              <div className="relative">
                <HeroBanner
                  photoUrl={c.photoUrl}
                  fallback={<List className="text-subtle-foreground size-8" />}
                />
                <CardTools
                  name={c.name}
                  editTitle="Edit category"
                  deleteTitle="Delete category"
                  onEdit={() => { setEditingCategory(c); setShowAddCategory(true); }}
                  onDelete={async () => {
                    const count = itemsByCategoryName.get(c.name) ?? 0;
                    if (count > 0) {
                      toast.error(`Can't delete "${c.name}"`, {
                        description: `${count} item${count === 1 ? '' : 's'} still in this category. Re-categorize them first.`,
                      });
                      return;
                    }
                    if (
                      await confirm({
                        title: `Delete category "${c.name}"?`,
                        description: "This can't be undone.",
                        confirmLabel: 'Delete',
                        tone: 'danger',
                      })
                    ) {
                      deleteCategoryMut.mutate({ id: c.id });
                      setAllCategories((prev) => prev.filter((x) => x.id !== c.id));
                    }
                  }}
                />
              </div>
              <CardContent className="flex flex-col gap-1 p-4">
                <div className="flex items-center justify-between gap-2">
                  <span role="heading" aria-level={3} className="font-semibold">{c.name}</span>
                  {c.trade && <Badge variant="softNeutral" size="pill">{c.trade}</Badge>}
                </div>
                {c.description && <p className="text-muted-foreground text-xs">{c.description}</p>}
                <div className="text-muted-foreground mt-2 text-[11px]">
                  Items: <span className="text-foreground font-semibold">
                    {itemsByCategoryName.get(c.name) ?? 0}
                  </span>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      </TabPanel>

      <TabPanel value="catalog" activeValue={tab}>
        <Card role="status" className="mx-auto max-w-[640px]">
          <CardHeader className="flex items-center gap-3">
            <Construction className="text-status-amber-emphasis size-5" />
            <span role="heading" aria-level={2} className="text-lg font-semibold">
              Catalog view ships in Phase B
            </span>
          </CardHeader>
          <CardContent className="flex flex-col gap-5">
            <p className="text-muted-foreground text-sm leading-relaxed">
              The Catalog tab is the customer-facing surface - a grid of product cards with hero
              photos, marketing-friendly names, key features, and list prices. Phase A (this rev)
              ships the data spine (Brand + Group entities, taxonomy, visibility flag); Phase B
              layers the photo upload UX + customer-copy editing surface + the grid rendering you
              see here.
            </p>
            <div className="bg-muted rounded-md p-4">
              <div className="text-muted-foreground text-[11px] font-semibold uppercase">Coming next</div>
              <ul className="mt-2 flex flex-col gap-1.5 text-sm">
                <li>Multi-photo upload per item (drag-to-reorder, hero shot, mobile camera capture)</li>
                <li>Customer-facing name + description + key-features editor</li>
                <li>Grid of photo cards filterable by Brand / Group / Category</li>
                <li>Internal-only items hard-filtered from the customer view</li>
              </ul>
            </div>
          </CardContent>
          <CardFooter className="flex flex-wrap gap-1.5">
            <Badge variant="softNeutral" size="pill">Owner: Emanuel</Badge>
            <Badge variant="softNeutral" size="pill">Phase A → B transition</Badge>
          </CardFooter>
        </Card>
      </TabPanel>

      <AddBrandDialog
        open={showAddBrand}
        vendors={allVendors}
        onClose={() => { setShowAddBrand(false); setEditingBrand(null); }}
        editBrand={editingBrand}
        onCreate={async (b) => {
          const saved = adoptServerId(b, await upsertBrand.mutateAsync(b));
          setBrands((prev) => [saved, ...prev]);
          return saved;
        }}
        onUpdate={(b) => {
          upsertBrand.mutate(b);
          setBrands((prev) => prev.map((x) => (x.id === b.id ? b : x)));
        }}
      />
      <AddGroupDialog
        open={showAddGroup}
        onClose={() => { setShowAddGroup(false); setEditingGroup(null); }}
        editGroup={editingGroup}
        items={items}
        onCreate={(g) => {
          upsertItemGroup.mutate(g);
          setGroups((prev) => [g, ...prev]);
        }}
        onUpdate={(g) => {
          upsertItemGroup.mutate(g);
          setGroups((prev) => prev.map((x) => (x.id === g.id ? g : x)));
        }}
      />
      <AddCategoryDialog
        open={showAddCategory}
        onClose={() => { setShowAddCategory(false); setEditingCategory(null); }}
        editCategory={editingCategory}
        onCreate={async (c) => {
          const saved = adoptServerId(c, await upsertCategory.mutateAsync(c));
          setAllCategories((prev) => [saved, ...prev]);
          return saved;
        }}
        onUpdate={(updated) => {
          upsertCategory.mutate(updated);
          const oldName = editingCategory?.name;
          setAllCategories((prev) => prev.map((x) => (x.id === updated.id ? updated : x)));
          // Propagate a rename to every item still tagged with the old category
          // string so they do not suddenly look uncategorized.
          if (oldName && oldName !== updated.name) {
            setItems((prev) =>
              prev.map((it) => (it.category === oldName ? { ...it, category: updated.name } : it)),
            );
          }
        }}
      />

      {/* One mount serves create AND edit, exactly as the legacy page wires it. */}
      <AddItemDialog
        open={showAddItem || !!editingItem}
        onClose={() => { setShowAddItem(false); setEditingItem(null); }}
        editItem={editingItem}
        brands={brands}
        vendors={allVendors}
        onAddVendor={async (v) => {
          const saved = adoptServerId(v, await upsertVendor.mutateAsync(v));
          setAllVendors((prev) => [...prev, saved]);
          return saved;
        }}
        categories={allCategories}
        onAddCategory={async (c) => {
          const saved = adoptServerId(c, await upsertCategory.mutateAsync(c));
          setAllCategories((prev) => [...prev, saved]);
          return saved;
        }}
        onSave={async (payload, editId) => {
          // Persist through the price-book single write path. The ['inventory']
          // invalidation re-seeds the local mirror with the server row; the edit
          // branch also patches the mirror in place for instant feedback.
          let created: { id: string } | undefined;
          try {
            created = await upsertItem.mutateAsync({
              id: editId,
              name: payload.name,
              sku: payload.sku,
              mpn: payload.mpn,
              modelNumber: payload.modelNumber,
              categoryId: payload.categoryId,
              vendorId: payload.vendorId,
              brandId: payload.brandId,
              finishId: payload.finishId,
              trade: payload.trade,
              kind: payload.kind,
              uom: payload.uom,
              unitCost: payload.unitCost,
              sellPrice: payload.sellPrice,
              serialized: payload.serialized,
              hazmat: payload.hazmat,
              visibility: payload.visibility,
              photoUrl: payload.photoUrl,
              trackInventory: payload.trackInventory,
              taxable: payload.taxable,
            });
          } catch {
            toast.error('Could not save the item', {
              description: 'Check the fields and try again.',
            });
            return;
          }
          if (editId) {
            setItems((prev) =>
              prev.map((i) =>
                i.id === editId
                  ? {
                      ...i,
                      sku: payload.sku,
                      mpn: payload.mpn,
                      modelNumber: payload.modelNumber,
                      name: payload.name,
                      category: payload.category,
                      trade: payload.trade as Item['trade'],
                      kind: payload.kind as Item['kind'],
                      uom: payload.uom,
                      unitCost: payload.unitCost,
                      sellPrice: payload.sellPrice,
                      serialized: payload.serialized,
                      hazmat: payload.hazmat,
                      trackInventory: payload.trackInventory,
                      // `type` is deliberately NOT mirrored - it is
                      // server-derived and the invalidation re-seeds it.
                      taxable: payload.taxable,
                      vendor: payload.vendor,
                      photoUrl: payload.photoUrl ?? i.photoUrl,
                      brandId: payload.brandId,
                      finishId: payload.finishId,
                      visibility: payload.visibility,
                      updatedAt: new Date().toISOString(),
                    }
                  : i,
              ),
            );
            setEditingItem(null);
            return;
          }
          // Create mode - the refetch supplies the real server row. Reserve
          // levels ride a separate write against the SERVER id.
          const thresholds = startingThresholdsFor(payload.startingStock);
          if (thresholds && created?.id) {
            try {
              await setThresholds.mutateAsync({
                itemId: created.id,
                locationId: thresholds.locationId,
                min: thresholds.min,
                max: thresholds.max,
              });
            } catch {
              // Default tone, not error: the item itself saved fine - only the
              // optional reserve levels failed, and the user has a way out.
              toast('Item saved, but the reserve levels could not be saved', {
                description: 'Set them from the item panel.',
              });
            }
          }
          setShowAddItem(false);
        }}
      />
      {confirmDialog}
    </div>
  );
}

export default PriceBookPage;
