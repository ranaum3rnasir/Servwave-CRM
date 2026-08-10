import { useEffect, useMemo, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { UploadedImage } from "@/components/ui/uploaded-image";
import {
  AlertTriangle,
  ArrowRightLeft,
  Boxes,
  ChevronRight,
  ClipboardList,
  DollarSign,
  Download,
  Gauge,
  History,
  ImageIcon,
  MoreHorizontal,
  PackagePlus,
  Pencil,
  Search,
  ShoppingCart,
  Trash2,
  TrendingDown,
  Truck,
  Undo2,
  Upload,
  Warehouse,
  Wrench,
  X,
  type LucideIcon,
} from "lucide-react";
import {
  adoptServerId,
  useAssets,
  useInventoryItems,
  useLocations,
  useVendors,
  useCategories,
  useBranches,
  useBrands,
  useJobStages,
  useMovements,
  useLowStock,
  useUpsertItem,
  useUpsertLocation,
  useUpsertCategory,
  useUpsertVendor,
  useUpsertBranch,
  useDeleteCategory,
  useDeleteItem,
  useRestoreItem,
  useImportItemsCSV,
  useTransferStock,
  useSetThresholds,
  useSetQuantity,
  startingThresholdsFor,
  totalOnHand,
  isLowStock,
} from "@/lib/api/inventory";
import type {
  Branch,
  Category,
  Item,
  Location,
  Vendor,
  Movement,
} from "@/lib/api/inventory";
import { useAppAbility } from "@/contexts/AbilityContext";
import { formatCurrency, formatCurrencyWhole } from "@/lib/utils";
import { useInventoryAlertStore } from "@/stores/inventory-alert.store";
import { toCSV, downloadCSV } from "@/lib/inventory/csv";
import { KpiTile } from "@/components/data/KpiStrip";
import { Switch } from "@/components/ui/switch";
import { AddItemDialog, type NewItem } from "@/components/inventory/AddItemDialog";
import { DeleteItemDialog } from "@/components/inventory/DeleteItemDialog";
import { TransferDialog } from "@/components/inventory/TransferDialog";
import { AddLocationDialog } from "@/components/inventory/AddLocationDialog";
import { LocationSelector } from "@/components/inventory/LocationSelector";
import { CategorySelector } from "@/components/inventory/CategorySelector";
import { AddCategoryDialog } from "@/components/inventory/AddCategoryDialog";
import { RestockDialog } from "@/components/inventory/RestockDialog";
import { SetQuantityDialog } from "@/components/inventory/SetQuantityDialog";
import { SetThresholdsDialog } from "@/components/inventory/SetThresholdsDialog";
import { StagingView } from "@/components/inventory/StagingView";
import { AssetsView } from "@/components/inventory/assets/AssetsView";
import { LowStockView } from "@/components/inventory/LowStockView";
import { ActionLogView } from "@/components/inventory/ActionLogView";
import { ImportCSVDialog } from "@/components/inventory/ImportCSVDialog";
import { LocationStockHealth } from "@/components/inventory/LocationStockHealth";
import { POPreviewDialog } from "@/components/inventory/POPreviewDialog";
import { LowStockActionDialog } from "@/components/inventory/LowStockActionDialog";
import { GeneratePODialog } from "@/components/inventory/GeneratePODialog";
import { LOList } from "@/components/inventory/lo/LOList";
import { useLogisticOrders } from "@/lib/api/logisticOrders";
import { EmptyState } from "@/components/ui/empty-state";
import {
  ActiveFilterChips,
  FiltersPopover,
  emptyFilters,
  type Filters,
} from "@/components/inventory/FiltersPopover";
import { useInventoryFilters, useInventoryStats } from "@/components/inventory/useInventoryFilters";
import { Button } from "@/components/ui/button";
import { Heading } from "@/components/ui/heading";
import { Toolbar } from "@/components/patterns/Toolbar";
import { useConfirm } from "@/hooks/useConfirm";

type ActiveDialog =
  | null
  | "add"
  | "delete"
  | "transfer"
  | "restock"
  | "set_quantity"
  | "set_thresholds"
  | "add_location"
  | "add_category"
  | "import_csv"
  | "generate_po";

// Route → internal view. The tabs are deep-linkable routes (/inventory,
// /inventory/staging, /inventory/assets, /inventory/low-stock,
// /inventory/activity) so the alert store can jump straight to a view; the
// active tab is derived from the URL, not state. (/inventory/approvals now
// redirects to /inventory — App.tsx — with the stock-approvals parking.)
type InventoryView =
  | "items"
  | "staging"
  | "assets"
  | "low_stock"
  | "activity"
  | "logistic_orders";
function viewFromPath(pathname: string): InventoryView {
  if (pathname.startsWith("/inventory/staging")) return "staging";
  if (pathname.startsWith("/inventory/assets")) return "assets";
  if (pathname.startsWith("/inventory/low-stock")) return "low_stock";
  if (pathname.startsWith("/inventory/activity")) return "activity";
  if (pathname.startsWith("/inventory/logistic-orders")) return "logistic_orders";
  return "items";
}

export default function InventoryPage() {
  const { confirm, confirmDialog } = useConfirm();
  const location = useLocation();
  const navigate = useNavigate();
  const view = viewFromPath(location.pathname);

  // Data seam — read the mock-backed queries. Local mirror state preserves
  // Emanuel's in-memory mutation feel (handleSave/handleTransfer/etc. mutate
  // these copies); the seam mutations are mock no-ops, so we keep the
  // prototype's interactive behavior client-side. Seeded from query data once
  // it lands (and re-seeded if the query reference changes).
  // "Show archived" toggle (Items tab) - re-fetches with include_archived=true
  // so hybrid-delete-archived rows surface alongside active ones.
  const [showArchived, setShowArchived] = useState(false);
  const itemsQuery = useInventoryItems(showArchived);
  const locationsQuery = useLocations();
  const vendorsQuery = useVendors();
  const categoriesQuery = useCategories();
  const branchesQuery = useBranches();
  const brandsQuery = useBrands();
  const jobStagesQuery = useJobStages();
  // Assets tab count only — the same {status:'ACTIVE'} key AssetsView uses by
  // default, so TanStack dedupes this with the tab body's own query.
  const assetsQuery = useAssets({ status: "ACTIVE" }, 1);
  // P5 tab counts — meta.total only (limit 1 keeps the payloads tiny). Both
  // live under the ['inventory'] key prefix so stock mutations refresh them.
  const movementsCountQuery = useMovements({ limit: 1 });
  const lowStockCountQuery = useLowStock({ limit: 1 });
  // Logistic Orders tab — total count (tab badge) + pending-approval count (the amber
  // `highlight` badge, §12 rec 4: ViewTab idiom, limit 1, read `.total`). `retry:false`
  // in the hook keeps a non-reader 403 quiet.
  const loCountQuery = useLogisticOrders({ limit: 1 });
  const loPendingCountQuery = useLogisticOrders({ status: "PENDING_APPROVAL", limit: 1 });

  const ability = useAppAbility();
  const isLocationAdmin = ability.can("manage", "Inventory");
  // Inventory P2 (D16 entry #3) — the Generate-PO surfaces gate on create PurchaseOrder.
  const canCreatePO = ability.can("create", "PurchaseOrder");
  // Catalog single write path (P0 §D) — Stock-page item edits persist through it too.
  const upsertItem = useUpsertItem();
  // P3 §1b — location create/update persist for real (van↔tech binding included);
  // the ['inventory'] invalidation re-seeds allLocations from the server.
  const upsertLocation = useUpsertLocation();
  // Hybrid delete (Task 1/3) - archives referenced items instead of hard-deleting;
  // useRestoreItem reverses that (is_active back to true) for archived rows.
  const deleteItem = useDeleteItem();
  const restoreItem = useRestoreItem();
  // Slice 2 - CSV import posts to the real price-book import endpoint (per-row
  // upsert-by-sku); the ['inventory'] invalidation re-seeds allItems from the server.
  const importItemsCSV = useImportItemsCSV();
  // Slice 3 - real /api/inventory/transfer POST; a 409 SHORTAGE surfaces
  // inline in TransferDialog instead of silently succeeding client-side.
  const transferStock = useTransferStock();
  // SRVW-91 - the only writer of StockBalance.min/max, used both by the Reserve Levels
  // dialog and by the create-time follow-up write below.
  const setThresholds = useSetThresholds();
  // SRVW-93 - the nested category/vendor/branch creates on this page were fabricating
  // local ids and never calling these; opening stock reuses the existing count endpoint.
  const upsertCategory = useUpsertCategory();
  const upsertVendor = useUpsertVendor();
  const upsertBranch = useUpsertBranch();
  const deleteCategory = useDeleteCategory();
  const setQuantity = useSetQuantity();

  const jobStages = useMemo(
    () => jobStagesQuery.data ?? [],
    [jobStagesQuery.data],
  );
  const allBrands = useMemo(() => brandsQuery.data ?? [], [brandsQuery.data]);

  const [allItems, setAllItems] = useState<Item[]>([]);
  const [allVendors, setAllVendors] = useState<Vendor[]>([]);
  const [allLocations, setAllLocations] = useState<Location[]>([]);
  const [allCategories, setAllCategories] = useState<Category[]>([]);
  const [allBranches, setAllBranches] = useState<Branch[]>([]);

  // Seed local mirror state from the seam queries once data arrives.
  useEffect(() => {
    if (itemsQuery.data) setAllItems(itemsQuery.data);
  }, [itemsQuery.data]);
  useEffect(() => {
    if (vendorsQuery.data) setAllVendors(vendorsQuery.data);
  }, [vendorsQuery.data]);
  useEffect(() => {
    if (locationsQuery.data) setAllLocations(locationsQuery.data);
  }, [locationsQuery.data]);
  useEffect(() => {
    if (categoriesQuery.data) setAllCategories(categoriesQuery.data);
  }, [categoriesQuery.data]);
  useEffect(() => {
    if (branchesQuery.data) setAllBranches(branchesQuery.data);
  }, [branchesQuery.data]);

  const [editingItem, setEditingItem] = useState<Item | null>(null);
  const [filters, setFilters] = useState<Filters>(emptyFilters);
  const [editingCategory, setEditingCategory] = useState<Category | null>(null);
  const [editingLocation, setEditingLocation] = useState<Location | null>(null);
  const [search, setSearch] = useState("");
  const [activeLoc, setActiveLoc] = useState<string>("all");
  const [activeDialog, setActiveDialog] = useState<ActiveDialog>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [transferError, setTransferError] = useState<string | null>(null);
  const [openKebabId, setOpenKebabId] = useState<string | null>(null);
  const [generatePOLocId, setGeneratePOLocId] = useState<string | null>(null);
  // Alert-bus driven PO preview (TopBar bell → po_partial row).
  const [alertPreviewPONumber, setAlertPreviewPONumber] = useState<string | null>(null);
  // Pop-out shown when a low_stock or backorder alert row is clicked — gives
  // the operator a one-click Restock CTA + the option to walk away.
  const [lowStockAction, setLowStockAction] = useState<{
    itemId: string;
    kind: "low_stock" | "backorder";
  } | null>(null);
  // Pending intent forwarded to the staging sub-view — carries its own
  // `nonce` so the child's effect re-fires every click, even on the same id
  // (e.g. the user closes the dialog and re-clicks the same alert).
  const [pendingStageIntent, setPendingStageIntent] = useState<{ id: string; nonce: number } | null>(null);

  // Clear any stale shortage/transfer error whenever the Transfer dialog
  // opens or closes (and when switching to a different dialog entirely).
  useEffect(() => {
    setTransferError(null);
  }, [activeDialog]);

  // Inventory alert store (Zustand) — replaces Emanuel's `pendingAlert` prop +
  // monotonic-nonce remount. The TopBar bell emits an alert; this effect reduces
  // the intent into the right view/filter/dialog, then clears it. `nonce` bumps
  // on every emit so a repeat-emit of the same alert still re-fires the effect.
  const pendingAlert = useInventoryAlertStore((s) => s.pending);
  const alertNonce = useInventoryAlertStore((s) => s.nonce);
  const clearAlert = useInventoryAlertStore((s) => s.clear);

  useEffect(() => {
    if (!pendingAlert) return;
    const alert = pendingAlert;
    switch (alert.kind) {
        case "low_stock": {
          navigate("/inventory");
          setFilters((f) => ({
            ...f,
            stockStates: [
              ...f.stockStates.filter(
                (s) => s !== "in_stock" && s !== "out_of_stock" && s !== "backorder",
              ),
              "low_stock",
            ],
          }));
          if (alert.ref?.itemSku) {
            const hit = (itemsQuery.data ?? []).find((i) => i.sku === alert.ref?.itemSku);
            if (hit) {
              setSelectedId(hit.id);
              // Pop the action dialog — gives the operator Restock-now and
              // walk-away CTAs without making them scan the filtered list.
              setLowStockAction({ itemId: hit.id, kind: "low_stock" });
            }
          }
          break;
        }
        case "backorder": {
          navigate("/inventory");
          setFilters((f) => ({
            ...f,
            stockStates: [
              ...f.stockStates.filter(
                (s) => s !== "in_stock" && s !== "out_of_stock" && s !== "low_stock",
              ),
              "backorder",
            ],
          }));
          if (alert.ref?.itemSku) {
            const hit = (itemsQuery.data ?? []).find((i) => i.sku === alert.ref?.itemSku);
            if (hit) {
              setSelectedId(hit.id);
              setLowStockAction({ itemId: hit.id, kind: "backorder" });
            }
          }
          break;
        }
        case "po_partial": {
          if (alert.ref?.poNumber) {
            setAlertPreviewPONumber(alert.ref.poNumber);
          }
          break;
        }
        case "staging_no_area":
        case "staging_ready": {
          navigate("/inventory/staging");
          if (alert.ref?.stageId) {
            setPendingStageIntent({
              id: alert.ref.stageId,
              nonce: Date.now(),
            });
          }
          break;
        }
    }
    clearAlert();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [alertNonce]);

  const selectedItem = useMemo(
    () => allItems.find((i) => i.id === selectedId) || null,
    [allItems, selectedId],
  );

  // Per-item recent movements for the detail panel — server-filtered (P5 §2.2;
  // replaces the client SKU filter, which silently missed rows once movements
  // paginated). Runs unconditionally (hooks rule); tiny page when unscoped.
  const itemMovementsQuery = useMovements({ itemId: selectedItem?.id, limit: 25 });

  const { filteredItems } = useInventoryFilters({ allItems, search, activeLoc, filters });

  const activeLocation = useMemo(
    () => (activeLoc === "all" ? null : allLocations.find((l) => l.id === activeLoc)),
    [activeLoc, allLocations],
  );

  const stats = useInventoryStats(allItems);

  function showToast(msg: string) {
    setToast(msg);
    setTimeout(() => setToast(null), 3500);
  }

  // SRVW-93 - these three used to only push the dialog-synthesized row into local
  // state and never call the mutation, so the fabricated cat_new_*/vnd_new_*/br_new_*
  // id then 400ed the item/location save that read it back as a FK. adoptServerId
  // degrades to the local row if the mutation resolves with something unexpected
  // (a stubbed test mock), so these stay safe even where nothing is actually mocked out.
  async function persistCategory(c: Category) {
    const saved = adoptServerId(c, await upsertCategory.mutateAsync(c));
    setAllCategories((prev) => [...prev, saved]);
    return saved;
  }
  async function persistVendor(v: Vendor) {
    const saved = adoptServerId(v, await upsertVendor.mutateAsync(v));
    setAllVendors((prev) => [...prev, saved]);
    return saved;
  }
  async function persistBranch(b: Branch) {
    const saved = adoptServerId(b, await upsertBranch.mutateAsync(b));
    setAllBranches((prev) => [...prev, saved]);
    return saved;
  }

  // Inventory P1: item edits from the Stock page persist through the price-book single
  // write path (same wiring as PriceBookPage — P0 §D). The local mirror update below is
  // kept for instant feedback; the ['inventory'] invalidation re-seeds it with the server row.
  async function handleSave(payload: NewItem, editId?: string) {
    const created = await upsertItem
      .mutateAsync({
        id: editId,
        name: payload.name,
        sku: payload.sku,
        mpn: payload.mpn,
        modelNumber: payload.modelNumber,
        categoryId: payload.categoryId,
        vendorId: payload.vendorId,
        brandId: payload.brandId,
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
      })
      .catch((err) => {
        showToast("✗ Could not save the item — check the fields and try again.");
        // SRVW-93 - rethrow so AddItemDialog's await keeps the dialog open with
        // the typed values instead of discarding them on a failed save.
        throw err;
      });
    if (editId) {
      setAllItems((prev) =>
        prev.map((i) =>
          i.id === editId
            ? {
                ...i,
                sku: payload.sku,
                mpn: payload.mpn,
                modelNumber: payload.modelNumber,
                name: payload.name,
                category: payload.category,
                trade: payload.trade as Item["trade"],
                kind: payload.kind as Item["kind"],
                uom: payload.uom,
                unitCost: payload.unitCost,
                sellPrice: payload.sellPrice,
                serialized: payload.serialized,
                hazmat: payload.hazmat,
                trackInventory: payload.trackInventory,
                vendor: payload.vendor,
                photoUrl: payload.photoUrl ?? i.photoUrl,
                brandId: payload.brandId,
                visibility: payload.visibility,
                updatedAt: new Date().toISOString(),
              }
            : i,
        ),
      );
      showToast(`✓ ${payload.sku} updated · audit log entry written`);
      return;
    }
    const newItem: Item = {
      id: created.id,
      sku: payload.sku,
      mpn: payload.mpn,
      modelNumber: payload.modelNumber,
      name: payload.name,
      category: payload.category,
      trade: payload.trade as Item["trade"],
      kind: payload.kind as Item["kind"],
      uom: payload.uom,
      unitCost: payload.unitCost,
      sellPrice: payload.sellPrice,
      serialized: payload.serialized,
      hazmat: payload.hazmat,
      trackInventory: payload.trackInventory,
      status: "active",
      vendor: payload.vendor,
      photoUrl: payload.photoUrl,
      brandId: payload.brandId,
      visibility: payload.visibility,
      stock: payload.startingStock.map((s) => ({
        locationId: s.locationId,
        onHand: s.qty,
        min: s.min,
        max: s.max,
      })),
      updatedAt: new Date().toISOString(),
    };
    setAllItems((prev) => [newItem, ...prev]);
    // SRVW-91 - the dialog's Min/Max used to die here. They are a StockBalance column,
    // not a price-book field, so they need their own follow-up write against the SERVER
    // id (never the local itm_new_* mirror id, and never a non-uuid location id).
    const thresholds = startingThresholdsFor(payload.startingStock);
    if (thresholds) {
      try {
        await setThresholds.mutateAsync({
          itemId: created.id,
          locationId: thresholds.locationId,
          min: thresholds.min,
          max: thresholds.max,
        });
      } catch {
        showToast(
          `✓ ${payload.sku} added to the catalog - reserve levels could not be saved, set them from the item panel`,
        );
        return;
      }
    }
    // SRVW-93 - opening on-hand used to be silently discarded: toPriceBookBody carries
    // no stock field, so nothing about "Starting Qty" ever reached the server. Post it
    // through the existing count endpoint (ONE signed `adjust` movement) against the
    // real server item id, never the itm_new_* mirror.
    const opening = payload.startingStock[0];
    if (opening && opening.qty > 0) {
      if (!opening.locationId) {
        showToast(
          `⚠ ${payload.sku} was created, but there is no stock location to record the starting quantity against.`,
        );
        return;
      }
      try {
        await setQuantity.mutateAsync({
          itemId: created.id,
          locationId: opening.locationId,
          countedQty: opening.qty,
          reason: "Opening stock",
        });
      } catch {
        showToast(
          `⚠ ${payload.sku} was created, but the starting quantity could not be recorded - use Set quantity.`,
        );
        return;
      }
    }
    showToast(`✓ ${payload.sku} added to the catalog`);
  }

  // Hybrid delete (Task 1): the server hard-deletes an item with no history,
  // or archives one that's still referenced (is_active=false) so downstream
  // records - POs, estimates, invoices - stay valid. Toast reflects which.
  async function handleDelete() {
    if (!selectedItem) return;
    try {
      const result = await deleteItem.mutateAsync({ id: selectedItem.id });
      showToast(
        result.mode === "deleted"
          ? `✓ ${selectedItem.sku} deleted`
          : `✓ ${selectedItem.sku} archived · on ${result.referenceCount} record${result.referenceCount === 1 ? "" : "s"}, kept for history`,
      );
      setSelectedId(null);
      setActiveDialog(null);
    } catch {
      showToast(`✗ Could not delete ${selectedItem.sku} - try again`);
    }
  }

  async function handleRestore(item: Item) {
    try {
      await restoreItem.mutateAsync({ id: item.id });
      showToast(`✓ ${item.sku} restored`);
    } catch {
      showToast(`✗ Could not restore ${item.sku} - try again`);
    }
  }

  // Slice 3 - real POST /api/inventory/transfer. The invalidation baked into
  // useTransferStock re-seeds allItems (on-hand) and the Action Log already
  // reads the movement ledger via useMovements, so there is no local mirror
  // write here anymore. A 409 SHORTAGE surfaces inline instead of the dialog
  // silently reporting success (QA-204).
  async function handleTransfer(payload: {
    item: Item;
    fromId: string;
    toId: string;
    qty: number;
    reason: string;
  }) {
    setTransferError(null);
    try {
      await transferStock.mutateAsync({
        itemId: payload.item.id,
        fromId: payload.fromId,
        toId: payload.toId,
        qty: payload.qty,
        reason: payload.reason || undefined,
      });
      const fromName = allLocations.find((l) => l.id === payload.fromId)?.name;
      const toName = allLocations.find((l) => l.id === payload.toId)?.name;
      showToast(
        `✓ Transferred ${payload.qty} × ${payload.item.sku} from ${fromName} → ${toName}`,
      );
      setActiveDialog(null);
    } catch (err: unknown) {
      const data = (
        err as { response?: { data?: { error?: string; available?: number } } }
      )?.response?.data;
      if (data?.error === "SHORTAGE") {
        setTransferError(
          `Not enough stock at the source - ${data.available ?? 0} available.`,
        );
      } else {
        setTransferError("Transfer failed - try again.");
      }
    }
  }

  function handleExport() {
    const rows = filteredItems.map((i) => ({
      SKU: i.sku,
      Name: i.name,
      Category: i.category,
      Kind: i.kind,
      UoM: i.uom,
      "Unit Cost": (i.unitCost ?? 0).toFixed(2),
      "Sell Price": i.sellPrice.toFixed(2),
      "Total On Hand": totalOnHand(i),
      "Total Available": totalOnHand(i),
      Vendor: i.vendor,
      MPN: i.mpn ?? "",
      UPC: i.upc ?? "",
      Serialized: i.serialized ? "Y" : "",
      Hazmat: i.hazmat ? "Y" : "",
      Status: i.status,
      "Locations Breakdown": i.stock
        .filter((s) => s.onHand > 0)
        .map(
          (s) =>
            `${allLocations.find((l) => l.id === s.locationId)?.name ?? s.locationId}:${s.onHand}`,
        )
        .join(" | "),
      "Updated At": i.updatedAt,
    }));
    if (rows.length === 0) {
      showToast("No items to export with current filters");
      return;
    }
    const csv = toCSV(rows);
    const date = new Date().toISOString().slice(0, 10);
    const locSuffix =
      activeLoc === "all"
        ? "all-locations"
        : allLocations.find((l) => l.id === activeLoc)?.name.replace(/\s+/g, "-").toLowerCase() ??
          activeLoc;
    downloadCSV(csv, `inventory-${locSuffix}-${date}.csv`);
    showToast(`✓ Exported ${rows.length} items to CSV`);
  }

  // Slice 2 - posts the parsed rows to the real price-book import endpoint
  // (per-row upsert-by-sku); the ['inventory'] invalidation on success re-seeds
  // allItems from the server, so there is no local mirror to build here.
  async function handleImport(payloads: NewItem[]) {
    const rows = payloads.map((p) => ({
      name: p.name,
      sellPrice: p.sellPrice,
      sku: p.sku || null,
      category: p.category || null,
      kind: p.kind || null,
      uom: p.uom || null,
      unitCost: p.unitCost,
      vendor: p.vendor || null,
    }));
    try {
      const result = await importItemsCSV.mutateAsync({ items: rows });
      const errPart =
        result.errors.length > 0
          ? ` · ${result.errors.length} row${result.errors.length === 1 ? "" : "s"} skipped`
          : "";
      showToast(`✓ Imported ${result.created} new · ${result.updated} updated${errPart}`);
    } catch {
      showToast("Import failed - check the file and try again");
    }
  }

  // SRVW-92 - narrows allItems down to a single location's offending stock rows,
  // following LowStockView's toProposalItems precedent. Filtering WHICH items are
  // passed (without also filtering their stock rows) would over-order for an item
  // low at two locations, since buildLowStockProposal sums shortfall across ALL
  // offending rows of an item - narrowing the rows themselves is required.
  const poDialogItems = useMemo(() => {
    if (!generatePOLocId) return allItems;
    return allItems
      .map((i) => ({ ...i, stock: i.stock.filter((s) => s.locationId === generatePOLocId) }))
      .filter((i) => i.stock.length > 0);
  }, [allItems, generatePOLocId]);

  return (
    <div className="flex flex-1 flex-col overflow-hidden">
      {/* View tabs */}
      <div className="flex items-center gap-1 border-b border-border bg-surface-light px-6">
        <ViewTab
          active={view === "items"}
          onClick={() => navigate("/inventory")}
          label="Items"
          count={allItems.filter((i) => i.kind === "material").length}
          icon={Boxes}
        />
        <ViewTab
          active={view === "staging"}
          onClick={() => navigate("/inventory/staging")}
          label="Staging"
          count={jobStages.length}
          icon={PackagePlus}
          highlight={
            jobStages.filter((s) => s.status === "ready_for_pickup").length
          }
        />
        <ViewTab
          active={view === "assets"}
          onClick={() => navigate("/inventory/assets")}
          label="Assets"
          count={assetsQuery.data?.meta.total ?? 0}
          icon={Wrench}
        />
        <ViewTab
          active={view === "low_stock"}
          onClick={() => navigate("/inventory/low-stock")}
          label="Low stock"
          count={lowStockCountQuery.data?.meta?.total ?? 0}
          icon={AlertTriangle}
        />
        <ViewTab
          active={view === "activity"}
          onClick={() => navigate("/inventory/activity")}
          label="Activity"
          count={movementsCountQuery.data?.meta?.total ?? 0}
          icon={History}
        />
        <ViewTab
          active={view === "logistic_orders"}
          onClick={() => navigate("/inventory/logistic-orders")}
          label="Logistic Orders"
          count={loCountQuery.data?.total ?? 0}
          icon={ClipboardList}
          highlight={loPendingCountQuery.data?.total ?? 0}
          highlightLabel="pending"
        />
      </div>

      {view === "staging" ? (
        <StagingView
          locations={allLocations}
          onToast={showToast}
          pendingIntent={pendingStageIntent}
        />
      ) : view === "assets" ? (
        <AssetsView onToast={showToast} />
      ) : view === "low_stock" ? (
        <LowStockView />
      ) : view === "activity" ? (
        <ActionLogView />
      ) : view === "logistic_orders" ? (
        <div className="flex-1 overflow-auto p-6">
          <LOList />
        </div>
      ) : (
      <>
      {/* Page header */}
      <div className="border-b border-border bg-surface-light px-6 py-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <div className="flex items-center gap-2 text-xs text-text-secondary">
              <span>Operations</span>
              <ChevronRight className="h-3 w-3" />
              <span className="font-medium text-text-primary">Inventory</span>
            </div>
            {/* tracking-tight dropped: Heading has no letter-spacing axis (heading.tsx
                header comment, "NOT COVERED, DELIBERATELY"). mt-1 kept, it's layout. */}
            <Heading className="mt-1">Inventory</Heading>
            <p className="mt-0.5 text-sm text-text-secondary">
              Track stock across warehouse, counter, and{" "}
              {allLocations.filter((l) => l.type === "truck").length} vans · Org
              → Branch → Warehouse → Bin
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            {/* Raw, deferred: filled success tone (border-success/20 bg-success/10
                text-success) has no minted outline/success (or solid/success) cell
                on Button - only outline/neutral and outline/danger exist. */}
            <button
              onClick={() => setActiveDialog("restock")}
              className="inline-flex items-center gap-1.5 rounded-md border border-success/20 bg-success/10 px-3 py-1.5 text-sm font-medium text-success hover:bg-success/10"
            >
              <PackagePlus className="h-4 w-4" />
              Restock
            </button>
            {/* outline/neutral size="sm": idle border/bg/hover-bg match exactly.
                Raw's explicit idle `text-text-primary` is dropped (outline/neutral
                sets no idle text colour) - the ambient wrapper here supplies none
                either, so idle text falls back to the browser default (near-black),
                visually indistinguishable from the --text-primary token (#10202B)
                at this size, but disclosed as a real, not exact, match. Raw
                font-medium becomes Button's base font-semibold (real delta). */}
            <Button
              variant="outline"
              tone="neutral"
              size="sm"
              onClick={() => setActiveDialog("transfer")}
            >
              <ArrowRightLeft className="h-4 w-4 text-primary" />
              Transfer
            </Button>
            <Button
              variant="outline"
              tone="neutral"
              size="sm"
              onClick={() => setActiveDialog("import_csv")}
            >
              <Upload className="h-4 w-4 text-text-secondary" />
              Import CSV
            </Button>
            <Button
              variant="outline"
              tone="neutral"
              size="sm"
              onClick={handleExport}
              title={`Export ${filteredItems.length} items as CSV`}
            >
              <Download className="h-4 w-4 text-text-secondary" />
              Export
            </Button>
            {/* Inventory P2 (D16 entry #3): propose one draft PO per vendor for every
                item below its reorder threshold. Visible regardless of the Low-Stock
                tile filter state — the dialog operates on ALL flagged items. */}
            {/* Raw, deferred: brand-tinted outline (border-primary/30 bg-primary-subtle
                text-primary) has no minted outline/brand cell on Button. */}
            {canCreatePO && stats.lowStock > 0 && (
              <button
                onClick={() => {
                  setGeneratePOLocId(null);
                  setActiveDialog("generate_po");
                }}
                className="inline-flex items-center gap-1.5 rounded-md border border-primary/30 bg-primary-subtle px-3 py-1.5 text-sm font-medium text-primary hover:bg-primary/10"
              >
                <ShoppingCart className="h-4 w-4" />
                Generate PO ({stats.lowStock})
              </button>
            )}
            <Button size="sm"
              onClick={() => setActiveDialog("add")}
            >
              <PackagePlus className="h-4 w-4" />
              Add Item
            </Button>
          </div>
        </div>

        {/* Stat tiles — clickable as filters */}
        <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
          <KpiTile
            icon={Boxes}
            label="Active SKUs"
            value={stats.totalSkus.toLocaleString()}
            sub={
              filters.stockStates.length > 0
                ? "click to show all"
                : "materials tracked"
            }
            tone="strong" emphasize
            active={filters.stockStates.length === 0 && filters.kinds.length === 0}
            onClick={() =>
              setFilters((f) => ({ ...f, stockStates: [], kinds: [] }))
            }
          />
          <KpiTile
            icon={TrendingDown}
            label="Low Stock"
            value={stats.lowStock}
            sub={
              filters.stockStates.includes("low_stock")
                ? "filtered — click to clear"
                : "below min threshold"
            }
            tone="warning" emphasize
            active={filters.stockStates.includes("low_stock")}
            onClick={() =>
              setFilters((f) => ({
                ...f,
                stockStates: f.stockStates.includes("low_stock")
                  ? f.stockStates.filter((s) => s !== "low_stock")
                  : [...f.stockStates.filter((s) => s !== "in_stock" && s !== "out_of_stock" && s !== "backorder"), "low_stock"],
              }))
            }
          />
          <KpiTile
            icon={ShoppingCart}
            label="Backorder"
            value={stats.backorder}
            sub={
              filters.stockStates.includes("backorder")
                ? "filtered — click to clear"
                : "awaiting vendor delivery"
            }
            tone="danger" emphasize
            active={filters.stockStates.includes("backorder")}
            onClick={() =>
              setFilters((f) => ({
                ...f,
                stockStates: f.stockStates.includes("backorder")
                  ? f.stockStates.filter((s) => s !== "backorder")
                  : [...f.stockStates.filter((s) => s !== "in_stock" && s !== "out_of_stock" && s !== "low_stock"), "backorder"],
              }))
            }
          />
          <KpiTile
            icon={DollarSign}
            label="Inventory Value"
            value={formatCurrencyWhole(stats.value)}
            sub={
              filters.stockStates.includes("in_stock")
                ? "filtered — only in-stock items"
                : "at unit cost · all locations"
            }
            tone="success" emphasize
            active={filters.stockStates.includes("in_stock")}
            onClick={() =>
              setFilters((f) => ({
                ...f,
                stockStates: f.stockStates.includes("in_stock")
                  ? f.stockStates.filter((s) => s !== "in_stock")
                  : [...f.stockStates.filter((s) => s !== "low_stock" && s !== "out_of_stock" && s !== "backorder"), "in_stock"],
              }))
            }
          />
        </div>
      </div>

      {/* Location selector (dropdown) */}
      <div className="flex items-center gap-3 border-b border-border bg-surface-light px-6 py-3">
        <span className="text-xs font-semibold uppercase tracking-wide text-text-secondary">
          Showing
        </span>
        <LocationSelector
          locations={allLocations}
          items={allItems}
          activeId={activeLoc}
          onChange={setActiveLoc}
          onAddNew={() => setActiveDialog("add_location")}
          canManage={isLocationAdmin}
          onEditLocation={(loc) => setEditingLocation(loc)}
        />
        <CategorySelector
          categories={allCategories}
          items={allItems}
          activeName={filters.categories[0] ?? "all"}
          onChange={(name) =>
            setFilters((f) => ({
              ...f,
              categories: name === "all" ? [] : [name],
            }))
          }
          onAddNew={() => setActiveDialog("add_category")}
          canManage={isLocationAdmin}
          onEditCategory={(c) => setEditingCategory(c)}
          onDeleteCategory={async (c) => {
            const usedBy = allItems.filter((i) => i.category === c.name).length;
            if (usedBy > 0) {
              showToast(
                `⚠ "${c.name}" can't be deleted — ${usedBy} item${usedBy === 1 ? "" : "s"} still in this category. Re-categorize them first.`,
              );
              return;
            }
            if (
              !(await confirm({
                title: `Delete category "${c.name}"?`,
                description: "This can't be undone.",
                confirmLabel: "Delete",
                tone: "danger",
              }))
            )
              return;
            // SRVW-93 - the guard above counts by NAME over allItems, while the server
            // counts by category_id FK (and by subcategory) and 400s "Cannot delete
            // category with items"/"with subcategories" when the two disagree. Without
            // this try/catch that rejection was unhandled: the row still vanished from
            // local state and the delete toast fired regardless.
            try {
              await deleteCategory.mutateAsync({ id: c.id });
            } catch {
              showToast(`✗ Could not delete the category "${c.name}" - it may still have items or subcategories.`);
              return;
            }
            setAllCategories((prev) => prev.filter((x) => x.id !== c.id));
            // If the deleted category was the active filter, reset to All.
            setFilters((f) =>
              f.categories.includes(c.name)
                ? { ...f, categories: [] }
                : f,
            );
            showToast(`🗑 Category "${c.name}" deleted`);
          }}
        />
        {/* ghost/subtle size="3xs": idle/hover text colours match exactly
            (text-text-secondary -> text-text-primary), same recipe as the
            "Clear all" links in FiltersPopover.tsx. Adds a hover background
            (ghost/subtle's own hover:bg-background-light) the raw never had,
            and font-medium becomes Button's base font-semibold - both
            disclosed, neither exact. */}
        {(activeLoc !== "all" || filters.categories.length > 0) && (
          <Button
            variant="ghost"
            tone="subtle"
            size="3xs"
            onClick={() => {
              setActiveLoc("all");
              setFilters((f) => ({ ...f, categories: [] }));
            }}
          >
            Clear filter
          </Button>
        )}
      </div>

      {/* Location stock health grid — shown when Low Stock filter is active */}
      {filters.stockStates.includes("low_stock") && (
        <LocationStockHealth
          items={allItems}
          locations={allLocations}
          activeLocationId={activeLoc}
          onSelectLocation={(id) => setActiveLoc(id)}
          onRestockLocation={
            canCreatePO
              ? (id) => {
                  setGeneratePOLocId(id);
                  setActiveDialog("generate_po");
                }
              : undefined
          }
        />
      )}

      {/* Search + filters */}
      <div className="flex flex-col gap-2 border-b border-border bg-surface-light px-6 py-3">
        <Toolbar
          gap={3}
          searchValue={search}
          onSearchChange={setSearch}
          searchPlaceholder="Search inventory…"
          searchIcon={<Search className="h-3.5 w-3.5 text-text-secondary" />}
          searchInputProps={{ size: "xs", className: "pl-8" }}
          filters={
            <>
              <FiltersPopover
                filters={filters}
                onChange={setFilters}
                vendors={allVendors}
                resultCount={filteredItems.length}
                totalCount={allItems.length}
              />
              <label className="flex items-center gap-2 text-xs font-medium text-text-secondary">
                <Switch
                  checked={showArchived}
                  onCheckedChange={setShowArchived}
                  aria-label="Show archived items"
                />
                Show archived
              </label>
              <span className="text-xs text-text-secondary">
                {filteredItems.length}{" "}
                {(() => {
                  const isLow = filters.stockStates.includes("low_stock");
                  const isBackorder = filters.stockStates.includes("backorder");
                  const isOut = filters.stockStates.includes("out_of_stock");
                  const prefix = isLow
                    ? "low-stock "
                    : isBackorder
                      ? "backordered "
                      : isOut
                        ? "out-of-stock "
                        : "";
                  const word = `${prefix}item${filteredItems.length === 1 ? "" : "s"}`;
                  return activeLocation
                    ? `${word} at ${activeLocation.name}`
                    : `${word.trim()} · of ${allItems.length} total`;
                })()}
              </span>
            </>
          }
        />
        <ActiveFilterChips filters={filters} onChange={setFilters} />
      </div>

      {/* Main split */}
      <div className="flex flex-1 overflow-hidden">
        {/* Items table */}
        <div className="flex-1 overflow-auto bg-background-light">
          <table className="min-w-full border-separate border-spacing-0 text-sm">
            <thead className="sticky top-0 z-10 bg-background-light">
              <tr className="text-left text-xs font-semibold uppercase tracking-wide text-text-secondary">
                <Th className="w-10">
                  <input type="checkbox" className="rounded" />
                </Th>
                <Th>SKU</Th>
                <Th>Item</Th>
                <Th>Category</Th>
                <Th className="text-right">
                  On Hand
                  {activeLocation && (
                    <span className="ml-1 text-[9px] font-medium normal-case tracking-normal text-primary">
                      here
                    </span>
                  )}
                </Th>
                <Th className="text-right">Available</Th>
                <Th className="text-right">Unit Cost</Th>
                <Th>{activeLocation ? "Also at" : "Locations"}</Th>
                <Th className="w-10" />
              </tr>
            </thead>
            <tbody>
              {filteredItems.map((item) => {
                const isSelected = selectedId === item.id;
                const stockHere = activeLocation
                  ? item.stock.find((s) => s.locationId === activeLocation.id)
                  : null;
                const onHandCell = stockHere
                  ? stockHere.onHand
                  : totalOnHand(item);
                const availableCell = onHandCell;
                const low = stockHere
                  ? stockHere.min != null && stockHere.onHand < stockHere.min
                  : isLowStock(item);
                return (
                  <tr
                    key={item.id}
                    onClick={() => setSelectedId(item.id)}
                    className={[
                      "cursor-pointer border-b border-border transition",
                      isSelected
                        ? "bg-primary/10 hover:bg-primary/20"
                        : "bg-surface-light hover:bg-background-light",
                    ].join(" ")}
                  >
                    <Td>
                      <input
                        type="checkbox"
                        onClick={(e) => e.stopPropagation()}
                        className="rounded"
                      />
                    </Td>
                    <Td>
                      <code className="font-mono text-xs text-text-primary">
                        {item.sku}
                      </code>
                    </Td>
                    <Td>
                      <div className="flex items-center gap-2.5">
                        <ItemThumb item={item} size={36} />
                        <div className="min-w-0">
                          <p className="truncate font-medium text-text-primary">
                            {item.name}
                          </p>
                          <div className="mt-0.5 flex flex-wrap items-center gap-1">
                            {item.serialized && (
                              <span className="rounded-full bg-primary/10 px-1.5 py-0.5 text-[10px] font-medium text-primary ring-1 ring-primary/20">
                                serialized
                              </span>
                            )}
                            {item.hazmat && (
                              <span className="rounded-full bg-danger/10 px-1.5 py-0.5 text-[10px] font-medium text-danger ring-1 ring-danger/20">
                                hazmat
                              </span>
                            )}
                            {item.status === "on_backorder" && (
                              <span className="rounded-full bg-warning/10 px-1.5 py-0.5 text-[10px] font-medium text-warning ring-1 ring-warning/20">
                                backorder
                              </span>
                            )}
                            {item.isActive === false && (
                              <span className="rounded-full bg-text-secondary/10 px-1.5 py-0.5 text-[10px] font-medium text-text-secondary ring-1 ring-border">
                                archived
                              </span>
                            )}
                          </div>
                        </div>
                      </div>
                    </Td>
                    <Td>
                      <span className="text-text-primary">{item.category}</span>
                    </Td>
                    <Td className="text-right font-mono">
                      <div className="flex items-center justify-end gap-1">
                        {low && (
                          <AlertTriangle
                            className="h-3 w-3 text-warning"
                            aria-label="below min"
                          />
                        )}
                        <span className="font-semibold text-text-primary">
                          {onHandCell}
                        </span>
                      </div>
                    </Td>
                    <Td className="text-right">
                      <span className="font-mono font-semibold text-success">
                        {availableCell}
                      </span>
                    </Td>
                    <Td className="text-right font-mono text-text-primary">
                      {item.unitCost != null ? formatCurrency(item.unitCost) : "\u2014"}
                    </Td>
                    <Td>
                      <LocationBreakdown
                        item={item}
                        locations={allLocations}
                        excludeId={activeLocation?.id}
                      />
                    </Td>
                    <Td>
                      <div className="relative">
                        {/* ghost/subtle size="icon": idle text + hover bg match
                            exactly. Adds ghost/subtle's own hover:text-text-primary
                            (raw only changed the background on hover) - disclosed.
                            className="h-6 w-6" restores the raw's ~24px box
                            (p-1 + h-4 icon) over the "icon" rung's 40px default -
                            width/height is LAYOUT, not appearance, same precedent
                            as NotificationsDropdown.tsx's bell trigger. */}
                        <Button
                          variant="ghost"
                          tone="subtle"
                          size="icon"
                          className="h-6 w-6"
                          onClick={(e) => {
                            e.stopPropagation();
                            setOpenKebabId(
                              openKebabId === item.id ? null : item.id,
                            );
                          }}
                          aria-label="More actions"
                        >
                          <MoreHorizontal className="h-4 w-4" />
                        </Button>
                        {openKebabId === item.id && (
                          <div
                            className="absolute right-0 top-8 z-20 w-48 rounded-md border border-border bg-surface-light py-1 shadow-lg"
                            onClick={(e) => e.stopPropagation()}
                          >
                            <KebabAction
                              onClick={() => {
                                setEditingItem(item);
                                setOpenKebabId(null);
                              }}
                              icon={Pencil}
                            >
                              Edit item
                            </KebabAction>
                            <KebabAction
                              onClick={() => {
                                setSelectedId(item.id);
                                setActiveDialog("restock");
                                setOpenKebabId(null);
                              }}
                              icon={PackagePlus}
                            >
                              Restock
                            </KebabAction>
                            <KebabAction
                              onClick={() => {
                                setSelectedId(item.id);
                                setActiveDialog("transfer");
                                setOpenKebabId(null);
                              }}
                              icon={ArrowRightLeft}
                            >
                              Transfer stock
                            </KebabAction>
                            <KebabAction
                              onClick={() => setOpenKebabId(null)}
                              icon={ShoppingCart}
                            >
                              Create PO
                            </KebabAction>
                            <KebabAction
                              onClick={() => {
                                setSelectedId(item.id);
                                setActiveDialog("set_quantity");
                                setOpenKebabId(null);
                              }}
                              icon={Boxes}
                            >
                              Set quantity
                            </KebabAction>
                            <KebabAction
                              onClick={() => {
                                setSelectedId(item.id);
                                setActiveDialog("set_thresholds");
                                setOpenKebabId(null);
                              }}
                              icon={Gauge}
                            >
                              Reserve levels
                            </KebabAction>
                            <div className="my-1 border-t border-border" />
                            {item.isActive === false ? (
                              <KebabAction
                                icon={Undo2}
                                onClick={() => {
                                  setOpenKebabId(null);
                                  void handleRestore(item);
                                }}
                              >
                                Restore item
                              </KebabAction>
                            ) : (
                              <KebabAction
                                variant="danger"
                                icon={Trash2}
                                onClick={() => {
                                  setSelectedId(item.id);
                                  setActiveDialog("delete");
                                  setOpenKebabId(null);
                                }}
                              >
                                Delete item
                              </KebabAction>
                            )}
                          </div>
                        )}
                      </div>
                    </Td>
                  </tr>
                );
              })}
              {filteredItems.length === 0 && (
                <tr>
                  <td
                    colSpan={9}
                    className="px-6 py-16 text-center text-sm text-text-secondary"
                  >
                    <EmptyState title="No items match your filters." />
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>

        {/* Right panel — selected item detail */}
        {selectedItem && (
          <DetailPanel
            item={selectedItem}
            locations={allLocations}
            movements={itemMovementsQuery.data?.data ?? []}
            onClose={() => setSelectedId(null)}
            onTransfer={() => setActiveDialog("transfer")}
            onDelete={() => setActiveDialog("delete")}
            onEdit={() => setEditingItem(selectedItem)}
            onRestock={() => setActiveDialog("restock")}
            onSetThresholds={() => setActiveDialog("set_thresholds")}
          />
        )}
      </div>

      {/* Dialogs */}
      <AddItemDialog
        open={activeDialog === "add" || !!editingItem}
        onClose={() => {
          setActiveDialog(null);
          setEditingItem(null);
        }}
        editItem={editingItem}
        onSave={handleSave}
        vendors={allVendors}
        onAddVendor={async (v) => {
          const saved = await persistVendor(v);
          showToast(`✓ Vendor "${saved.name}" added - selected for this item`);
          return saved;
        }}
        categories={allCategories}
        onAddCategory={async (c) => {
          const saved = await persistCategory(c);
          showToast(`✓ Category "${saved.name}" added - selected for this item`);
          return saved;
        }}
        brands={allBrands}
      />
      <DeleteItemDialog
        open={activeDialog === "delete"}
        onClose={() => setActiveDialog(null)}
        item={selectedItem}
        onConfirm={handleDelete}
      />
      <AddCategoryDialog
        open={activeDialog === "add_category" || !!editingCategory}
        onClose={() => {
          setActiveDialog(null);
          setEditingCategory(null);
        }}
        editCategory={editingCategory}
        onCreate={async (c) => {
          // Let a rejection propagate - the dialog's own try/catch keeps it
          // open with an error instead of this page assuming success.
          const saved = await persistCategory(c);
          // Auto-select the newly created category so the user sees their
          // items list narrow immediately. Single-select model: replaces any
          // prior category selection.
          setFilters((f) => ({ ...f, categories: [saved.name] }));
          setActiveDialog(null);
          showToast(`✓ Category "${saved.name}" added - now filtering`);
          return saved;
        }}
        onUpdate={async (updated) => {
          const oldName = editingCategory?.name;
          // SRVW-93 - this rename used to be local-only: no mutation ever fired,
          // so it did not survive a reload.
          try {
            await upsertCategory.mutateAsync(updated);
          } catch {
            showToast(`✗ Could not rename the category "${updated.name}" - try again.`);
            return;
          }
          setAllCategories((prev) =>
            prev.map((x) => (x.id === updated.id ? updated : x)),
          );
          // Propagate the rename to every item carrying the old category
          // name so the items table doesn't suddenly show "Uncategorized".
          if (oldName && oldName !== updated.name) {
            setAllItems((prev) =>
              prev.map((it) =>
                it.category === oldName
                  ? { ...it, category: updated.name }
                  : it,
              ),
            );
            // Keep the active filter pointed at the renamed category.
            setFilters((f) =>
              f.categories.includes(oldName)
                ? {
                    ...f,
                    categories: f.categories.map((n) =>
                      n === oldName ? updated.name : n,
                    ),
                  }
                : f,
            );
          }
          setEditingCategory(null);
          showToast(
            oldName && oldName !== updated.name
              ? `✓ Category renamed: "${oldName}" → "${updated.name}"`
              : `✓ Category "${updated.name}" updated`,
          );
        }}
      />
      <TransferDialog
        open={activeDialog === "transfer"}
        onClose={() => setActiveDialog(null)}
        initialItemId={selectedId || undefined}
        locations={allLocations}
        onSubmit={handleTransfer}
        errorMessage={transferError ?? undefined}
        submitting={transferStock.isPending}
        // SRVW-93 - onBulkStageTransfer is deliberately NOT passed. It used to fabricate
        // a "Staged N lines" toast and deduct stock from local state with zero API call,
        // then navigate to a page that proves the write never happened. Staging a job/PO
        // through this dialog needs a real, double-count-safe write path that does not
        // exist yet (see the escalation on SRVW-93's Linear card) - it is optional
        // (TransferDialog.tsx), so omitting it puts the dialog on its own honest
        // `if (!onBulkStageTransfer)` guard instead of the fake handler.
      />
      <RestockDialog
        open={activeDialog === "restock"}
        onClose={() => setActiveDialog(null)}
        initialItemId={selectedId || undefined}
        locations={allLocations}
        items={allItems}
        onSubmitted={(msg) => showToast(msg)}
      />
      <SetQuantityDialog
        open={activeDialog === "set_quantity"}
        onClose={() => setActiveDialog(null)}
        item={selectedItem}
        locations={allLocations}
        onSubmitted={(msg) => showToast(msg)}
      />
      <SetThresholdsDialog
        open={activeDialog === "set_thresholds"}
        onClose={() => setActiveDialog(null)}
        item={selectedItem}
        locations={allLocations}
        onSubmitted={(msg) => showToast(msg)}
      />
      <AddLocationDialog
        open={activeDialog === "add_location" || !!editingLocation}
        onClose={() => {
          setActiveDialog(null);
          setEditingLocation(null);
        }}
        editLocation={editingLocation}
        branches={allBranches}
        onAddBranch={async (b) => {
          const saved = await persistBranch(b);
          showToast(`✓ Branch "${saved.name}" added - selected for this location`);
          return saved;
        }}
        onCreate={async (loc) => {
          // P3 §1b — persist for real (the dialog hands branch by NAME; techs by id).
          try {
            const created = await upsertLocation.mutateAsync({
              name: loc.name,
              type: loc.type,
              branchId: allBranches.find((b) => b.name === loc.branch)?.id ?? null,
              primaryTechId: loc.primaryTechId ?? null,
              vehicle: loc.vehicle ?? null,
              stagingAreas: loc.stagingAreas ?? null,
            });
            setActiveLoc(created.id);
            showToast(
              `✓ "${loc.name}" created · now showing inventory at this location`,
            );
          } catch {
            showToast(`⚠ Could not create "${loc.name}" — please try again`);
          }
        }}
        onUpdate={async (updated) => {
          try {
            await upsertLocation.mutateAsync({
              id: updated.id,
              name: updated.name,
              type: updated.type,
              branchId: allBranches.find((b) => b.name === updated.branch)?.id ?? null,
              primaryTechId: updated.primaryTechId ?? null,
              vehicle: updated.vehicle ?? null,
              stagingAreas: updated.stagingAreas ?? null,
            });
            showToast(
              `✓ "${updated.name}" updated · audit log entry written`,
            );
          } catch {
            showToast(`⚠ Could not update "${updated.name}" — please try again`);
          }
        }}
      />
      <ImportCSVDialog
        open={activeDialog === "import_csv"}
        onClose={() => setActiveDialog(null)}
        onImport={handleImport}
      />
      {/* Inventory P2 (D16 entry #3) — low-stock proposals, one draft PO per vendor. */}
      <GeneratePODialog
        open={activeDialog === "generate_po"}
        onClose={() => {
          setActiveDialog(null);
          setGeneratePOLocId(null);
        }}
        items={poDialogItems}
        locations={allLocations}
        scopeLabel={generatePOLocId ? allLocations.find((l) => l.id === generatePOLocId)?.name : undefined}
      />

      </>
      )}

      {/* Toast — visible across both views */}
      {toast && (
        <div className="fixed bottom-6 right-6 z-[60] rounded-card border border-success/20 bg-success/10 px-4 py-3 text-sm font-medium text-success shadow-lg ring-1 ring-success/20">
          {toast}
        </div>
      )}

      {/* PO Preview surfaced by the TopBar bell (po_partial alerts). Renders
          above any view tab so the operator can read the PO doc without
          losing their place on the current page. */}
      <POPreviewDialog
        open={!!alertPreviewPONumber}
        onClose={() => setAlertPreviewPONumber(null)}
        poNumber={alertPreviewPONumber}
        lockEscape
      />

      {/* Pop-out action dialog for low_stock / backorder bell alerts. */}
      <LowStockActionDialog
        open={!!lowStockAction}
        onClose={() => setLowStockAction(null)}
        item={
          lowStockAction
            ? allItems.find((i) => i.id === lowStockAction.itemId) ?? null
            : null
        }
        locations={allLocations}
        kind={lowStockAction?.kind ?? "low_stock"}
        onRestock={() => {
          // Close the action pop-out and open the existing RestockDialog
          // pre-filled with the same item (initialItemId reads from
          // selectedId, which we already set when the alert was handled).
          setLowStockAction(null);
          setActiveDialog("restock");
        }}
        onGeneratePO={
          canCreatePO
            ? () => {
                setLowStockAction(null);
                setGeneratePOLocId(null);
                setActiveDialog("generate_po");
              }
            : undefined
        }
      />
      {confirmDialog}
    </div>
  );
}

function Th({
  children,
  className,
}: {
  children?: React.ReactNode;
  className?: string;
}) {
  return (
    <th className={`border-b-2 border-r border-border border-r-border px-3 py-2 last:border-r-0 ${className ?? ""}`}>
      {children}
    </th>
  );
}
function Td({
  children,
  className,
}: {
  children?: React.ReactNode;
  className?: string;
}) {
  return <td className={`border-r border-r-border px-3 py-2.5 last:border-r-0 ${className ?? ""}`}>{children}</td>;
}

function ViewTab({
  active,
  onClick,
  label,
  count,
  icon: Icon,
  highlight,
  highlightLabel,
}: {
  active: boolean;
  onClick: () => void;
  label: string;
  count: number;
  icon: React.ComponentType<{ className?: string }>;
  highlight?: number;
  highlightLabel?: string;
}) {
  return (
    // Raw, deferred: a segmented view-switcher tab (underline active state),
    // not a Button - same shape as the program's other tab-toggle deferrals.
    <button
      onClick={onClick}
      className={[
        "relative inline-flex items-center gap-2 border-b-2 px-4 py-3 text-sm transition",
        active
          ? "border-primary font-semibold text-primary"
          : "border-transparent text-text-secondary hover:text-text-primary",
      ].join(" ")}
    >
      <Icon
        className={[
          "h-4 w-4",
          active ? "text-primary" : "text-text-secondary",
        ].join(" ")}
      />
      {label}
      <span
        className={[
          "rounded-full px-1.5 py-0.5 text-[10px] font-semibold",
          active ? "bg-primary/10 text-primary" : "bg-background-light text-text-primary",
        ].join(" ")}
      >
        {count}
      </span>
      {highlight && highlight > 0 ? (
        <span
          className={[
            "rounded-full px-1.5 py-0.5 text-[10px] font-bold text-on-fill",
            highlightLabel === "pending" ? "bg-warning" : "bg-success",
          ].join(" ")}
          title={`${highlight} ${highlightLabel ?? "ready"}`}
        >
          {highlight} {highlightLabel ?? "ready"}
        </span>
      ) : null}
    </button>
  );
}


function locTypeIcon(type?: string) {
  if (type === "warehouse")
    return <Warehouse className="h-3.5 w-3.5 text-text-secondary" />;
  if (type === "truck") return <Truck className="h-3.5 w-3.5 text-text-secondary" />;
  if (type === "counter")
    return <Boxes className="h-3.5 w-3.5 text-text-secondary" />;
  return null;
}

function LocationBreakdown({
  item,
  locations,
  excludeId,
}: {
  item: Item;
  locations: Location[];
  excludeId?: string;
}) {
  const rows = item.stock.filter(
    (s) => s.locationId !== excludeId && s.onHand > 0,
  );
  if (rows.length === 0) {
    return <span className="text-[10px] text-text-secondary">—</span>;
  }
  return (
    <div className="flex flex-wrap items-center gap-1">
      {rows.map((s) => {
        const loc = locations.find((l) => l.id === s.locationId);
        if (!loc) return null;
        const low = s.min != null && s.onHand < s.min;
        return (
          <span
            key={s.locationId}
            title={`${loc.name}: ${s.onHand} on hand${low ? ", below min" : ""}`}
            className={[
              "inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 font-mono text-[10px]",
              low
                ? "border-warning/20 bg-warning/10 text-warning"
                : s.onHand === 0
                  ? "border-border bg-background-light text-text-secondary"
                  : "border-border bg-surface-light text-text-primary",
            ].join(" ")}
          >
            {locTypeIcon(loc.type)}
            <span className="text-text-secondary">
              {loc.name.replace(/'s Van$/, "").slice(0, 14)}
            </span>
            <span className="font-semibold">{s.onHand}</span>
          </span>
        );
      })}
    </div>
  );
}

function KebabAction({
  icon: Icon,
  children,
  onClick,
  variant,
}: {
  icon: React.ComponentType<{ className?: string }>;
  children: React.ReactNode;
  onClick: () => void;
  variant?: "danger";
}) {
  return (
    // Raw, deferred: a dropdown-menu-item row inside the kebab popover, not a
    // Button - list-shaped, full-width, left-aligned.
    <button
      onClick={onClick}
      className={[
        "flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm",
        variant === "danger"
          ? "text-danger hover:bg-danger/10"
          : "text-text-primary hover:bg-background-light",
      ].join(" ")}
    >
      <Icon className="h-3.5 w-3.5" />
      {children}
    </button>
  );
}

function DetailPanel({
  item,
  locations,
  movements,
  onClose,
  onTransfer,
  onDelete,
  onEdit,
  onRestock,
  onSetThresholds,
}: {
  item: Item;
  locations: Location[];
  movements: Movement[];
  onClose: () => void;
  onTransfer: () => void;
  onDelete: () => void;
  onEdit: () => void;
  onRestock: () => void;
  onSetThresholds: () => void;
}) {
  // Movements arrive per-item server-filtered (P5 §2.2) — no client SKU filter.
  const itemMovements = movements;
  return (
    <aside className="animate-panel-in flex w-96 flex-shrink-0 flex-col overflow-y-auto border-l border-border bg-surface-light shadow-lg">
      <div className="flex items-start justify-between gap-2 border-b border-border px-4 py-3">
        <div className="flex min-w-0 items-start gap-3">
          <ItemThumb item={item} size={56} />
          <div className="min-w-0">
            <code className="font-mono text-[11px] text-text-secondary">
              {item.sku}
            </code>
            {/* leading-tight dropped: Heading has no line-height axis; scale/weight/tone
                otherwise match this h2's rendered look exactly (all default values). */}
            <Heading level={2} className="mt-0.5">
              {item.name}
            </Heading>
            <div className="mt-1 flex flex-wrap items-center gap-1">
              <span className="rounded-full bg-background-light px-1.5 py-0.5 text-[10px] text-text-secondary">
                {item.category}
              </span>
            </div>
          </div>
        </div>
        {/* Raw, deferred: a close-X affordance, not a Button. Had no
            accessible name (icon-only, no aria-label, no visible text) -
            added one. */}
        <button
          onClick={onClose}
          className="rounded-md p-1 text-text-secondary hover:bg-background-light"
          aria-label="Close item details"
        >
          <X className="h-4 w-4" />
        </button>
      </div>

      <div className="border-b border-border px-4 py-3">
        <div className="grid grid-cols-2 gap-2 text-xs">
          <Stat label="On Hand" value={totalOnHand(item)} />
          <Stat
            label="Avail"
            value={totalOnHand(item)}
            tone="text-success"
          />
        </div>
        <div className="mt-3 grid grid-cols-2 gap-2 text-xs">
          <Stat
            label="Unit Cost"
            value={item.unitCost != null ? formatCurrency(item.unitCost) : "\u2014"}
            tone="text-text-primary"
          />
          <Stat
            label="Sell Price"
            value={formatCurrency(item.sellPrice)}
            tone="text-text-primary"
          />
        </div>
      </div>

      <div className="border-b border-border px-4 py-3">
        <div className="flex items-center justify-between gap-2">
          {/* Raw by design: bracket size text-[10px] has no matching Heading scale key. */}
          <h3 className="text-[10px] font-semibold uppercase tracking-wide text-text-secondary">
            By Location
          </h3>
          <Button variant="ghost" tone="subtle" size="sm" onClick={onSetThresholds}>
            Reserve levels
          </Button>
        </div>
        <ul className="mt-2 space-y-1">
          {item.stock.map((s) => {
            const loc = locations.find((l) => l.id === s.locationId);
            if (!loc) return null;
            const low = s.min != null && s.onHand < s.min;
            return (
              <li
                key={s.locationId}
                className="flex items-center justify-between gap-2 rounded-md border border-border px-2 py-1.5 text-xs"
              >
                <div className="flex items-center gap-1.5">
                  {locTypeIcon(loc.type)}
                  <span className="font-medium text-text-primary">
                    {loc.name}
                  </span>
                  {low && (
                    <AlertTriangle className="h-3 w-3 text-warning" />
                  )}
                </div>
                <div className="flex items-center gap-3 font-mono">
                  <span className="font-semibold text-text-primary">
                    {s.onHand}
                  </span>
                  {s.min != null && (
                    <span className="text-[10px] text-text-secondary">
                      min {s.min}
                    </span>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      </div>

      {item.serialized && item.serials && item.serials.length > 0 && (
        <div className="border-b border-border px-4 py-3">
          {/* Raw by design: bracket size text-[10px] has no matching Heading scale key. */}
          <h3 className="text-[10px] font-semibold uppercase tracking-wide text-text-secondary">
            Serial Numbers
          </h3>
          <div className="mt-2 flex flex-wrap gap-1">
            {item.serials.map((s) => (
              <code
                key={s}
                className="rounded bg-background-light px-1.5 py-0.5 font-mono text-[10px] text-text-primary"
              >
                {s}
              </code>
            ))}
          </div>
        </div>
      )}

      <div className="border-b border-border px-4 py-3">
        {/* Raw by design: bracket size text-[10px] has no matching Heading scale key. */}
        <h3 className="text-[10px] font-semibold uppercase tracking-wide text-text-secondary">
          Recent Stock Movements
        </h3>
        <ul className="mt-2 space-y-2">
          {itemMovements.length === 0 ? (
            <li className="text-xs text-text-secondary">
              No movements recorded yet.
            </li>
          ) : (
            itemMovements.map((m) => (
              <li
                key={m.id}
                className="flex items-start gap-2 text-xs"
              >
                <span
                  className={[
                    "mt-0.5 inline-block h-2 w-2 flex-shrink-0 rounded-full",
                    m.type === "receive"
                      ? "bg-success"
                      : m.type === "consume"
                        ? "bg-danger"
                        : m.type === "transfer"
                          ? "bg-info"
                          : "bg-warning",
                  ].join(" ")}
                />
                <div className="min-w-0 flex-1">
                  <p className="font-medium capitalize text-text-primary">
                    {m.type} · <span className="font-mono">{m.qty > 0 ? `+${m.qty}` : m.qty}</span>{" "}
                    {item.uom}
                  </p>
                  <p className="text-[11px] text-text-secondary">{m.reference}</p>
                  <p className="text-[10px] text-text-secondary">
                    {m.actor} ·{" "}
                    {new Date(m.occurredAt).toLocaleString('en-US', {
                      month: "short",
                      day: "numeric",
                      hour: "2-digit",
                      minute: "2-digit",
                    })}
                  </p>
                </div>
              </li>
            ))
          )}
        </ul>
      </div>

      <div className="mt-auto flex flex-col gap-2 border-t border-border bg-background-light px-4 py-3">
        <div className="flex gap-2">
          {/* solid/business size="3xs": --success/--sage-700 share one RGB, so
              the idle fill is pixel-exact. Raw's hover was a no-op
              (hover:bg-success, same as idle); solid/business's own
              hover:bg-sage-700/90 is a real, disclosed darken-on-hover the raw
              never had. 3xs's px-2/h-6 rung shrinks the raw's px-3/natural
              py-1.5 box and [&_svg]:size-4 grows the h-3 w-3 icon to 16px -
              both disclosed. */}
          <Button
            variant="solid"
            tone="business"
            size="3xs"
            className="flex-1"
            onClick={onRestock}
          >
            <PackagePlus className="h-3 w-3" />
            Restock
          </Button>
          {/* solid/brand size="3xs": idle fill exact. hover:bg-primary/90
              becomes solid/brand's own hover:bg-primary-dark - a real, if
              small, hover-token delta, disclosed rather than claimed exact.
              Same 3xs padding/icon-size deltas as above. */}
          <Button
            variant="solid"
            tone="brand"
            size="3xs"
            className="flex-1"
            onClick={onTransfer}
          >
            <ArrowRightLeft className="h-3 w-3" />
            Transfer
          </Button>
        </div>
        <div className="flex gap-2">
          {/* outline/neutral size="3xs": idle border/bg/hover-bg match exactly.
              Raw's explicit idle text-text-primary is dropped (outline/neutral
              sets no idle text colour); no ambient wrapper supplies one either,
              so idle text falls back to the browser default, visually
              indistinguishable from the --text-primary token here but
              disclosed as not exact. Same 3xs padding/icon-size deltas. */}
          <Button
            variant="outline"
            tone="neutral"
            size="3xs"
            className="flex-1"
            onClick={onEdit}
          >
            <Pencil className="h-3 w-3" />
            Edit
          </Button>
          {/* outline/danger size="3xs": text colour and hover match exactly.
              Raw's border opacity (danger at 20%) becomes outline/danger's
              own border opacity (danger at 40%) - a real, disclosed delta
              owned by the primitive. Icon grows h-3.5 w-3.5 -> 16px via
              [&_svg]:size-4. */}
          <Button
            variant="outline"
            tone="danger"
            size="3xs"
            onClick={onDelete}
            aria-label="Delete item"
            title="Delete item"
          >
            <Trash2 className="h-3.5 w-3.5" />
          </Button>
        </div>
      </div>
    </aside>
  );
}

function ItemThumb({ item, size }: { item: Item; size: number }) {
  if (item.photoUrl) {
    return (
      <UploadedImage
        src={item.photoUrl}
        alt={item.name}
        radius="md"
        edge="ring"
        className="flex-shrink-0"
        style={{ width: size, height: size }}
      />
    );
  }
  return (
    <div
      className="flex flex-shrink-0 items-center justify-center rounded-md bg-background-light ring-1 ring-border"
      style={{ width: size, height: size }}
      title="No photo yet"
    >
      <ImageIcon className="text-text-secondary" style={{ width: size * 0.45, height: size * 0.45 }} />
    </div>
  );
}

function Stat({
  label,
  value,
  tone,
}: {
  label: string;
  value: string | number;
  tone?: string;
}) {
  return (
    <div className="rounded-md bg-background-light px-2 py-1.5">
      <p className="text-[10px] uppercase text-text-secondary">{label}</p>
      <p className={`font-mono font-semibold ${tone ?? "text-text-primary"}`}>
        {value}
      </p>
    </div>
  );
}
