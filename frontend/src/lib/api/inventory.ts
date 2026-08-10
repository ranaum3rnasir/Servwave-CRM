import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import api from '@/lib/axios';
import * as mock from '@/lib/api/_mock/inventory';
import { useFeature } from '@/lib/entitlements';
import type {
  Vendor, Brand, Category, ItemGroup, Location, Branch, Movement, MovementType,
  EstimateReservation, JobStage, StageAttachment, StockApproval, InventoryJob, Tech,
} from '@/lib/api/_mock/inventory';

// Single flip-to-API flag for the whole Inventory module (Track 2 sets false).
const USE_MOCK = false;

// ─── Real server-contract types (P0) ────────────────────────────────────────
// The Item + PurchaseOrder families now mirror the live API rather than the
// prototype seeds: `reserved` is gone from stock rows (QA-904 — no v1 write
// path populates it), and `unitCost`/`listPrice` are optional because the
// server strips costs for users without pricing visibility (canSeePricing).
export type ItemKind = 'material' | 'service' | 'labor' | 'bundle' | 'fee';
export type Trade = 'locksmith' | 'door' | 'security' | 'hvac' | 'plumbing';
export type ItemStatus = 'active' | 'on_backorder' | 'discontinued';
export type ItemVisibility = 'catalog' | 'internal_only';

export type StockAtLocation = {
  locationId: string;
  onHand: number;
  min?: number;
  max?: number;
};

export type Item = {
  id: string;
  sku: string;
  /** Manufacturer part number - shown in the UI as "Part Number". */
  mpn?: string;
  modelNumber?: string;
  upc?: string;
  name: string;
  category: string;
  trade: Trade;
  kind: ItemKind;
  uom: string;
  /** Absent when the server cost-strips the response (no `read Invoice`). */
  unitCost?: number;
  sellPrice: number;
  serialized: boolean;
  hazmat: boolean;
  /** Inventory P1: deduct stock when this item is added to jobs/invoices (newly added lines only). */
  trackInventory?: boolean;
  status: ItemStatus;
  /** Hybrid delete (Task 1/3): false once an item is archived rather than
   *  hard-deleted (still referenced by history). Absent under USE_MOCK. */
  isActive?: boolean;
  vendor: string;
  stock: StockAtLocation[];
  serials?: string[];
  photoUrl?: string;
  updatedAt: string;
  brandId?: string;
  visibility?: ItemVisibility;
  customerName?: string;
  customerDescription?: string;
  keyFeatures?: string[];
  /** Absent when the server cost-strips the response. */
  listPrice?: number;
  /** SRVW-90: read-only projection of `kind`, derived server-side. What
   *  estimates/invoices/jobs key on. Optional so the `_mock` seeds still fit. */
  type?: 'SERVICE' | 'MATERIAL';
  /** SRVW-90: apply sales tax on estimates and invoices. Server default true. */
  taxable?: boolean;
};

export type POStatus = 'draft' | 'sent' | 'partial' | 'received' | 'closed';

export type POLine = {
  /** Present on server-read POs (PurchaseOrder.lines); absent on create payloads. */
  id?: string;
  itemSku: string;
  itemName: string;
  uom: string;
  qtyOrdered: number;
  qtyReceived: number;
  /** Absent when the server cost-strips the response (no `read Invoice`). */
  unitCost?: number;
  priceBookItemId?: string;
};

export type PurchaseOrder = {
  id: string;
  poNumber: string;
  vendor: string;
  /** FK to Vendor — present once the server serializes vendor_id (P2). */
  vendorId?: string;
  status: POStatus;
  jobNumber?: string;
  customer?: string;
  site?: string;
  trade?: 'locksmith' | 'door' | 'security' | 'hvac' | 'plumbing' | 'multi';
  orderedAt: string;
  expectedDate?: string;
  lines: POLine[];
  stagedAsJobStageId?: string;
};

/** What NewPODialog / CreatePOFromJobDialog / GeneratePODialog emit — the PO
 *  number and id are server-assigned (allocateNumber, P0 §A), never generated
 *  client-side. Explicit (not an Omit of PurchaseOrder) so the create payload
 *  can carry the job FK (`jobId`) that the read shape doesn't expose. */
export type NewPOInput = {
  vendor: string;
  /** FK when picked from the vendor list (P2 backend accepts it). */
  vendorId?: string;
  status: POStatus;
  /** uuid — links PurchaseOrder.job_id (server derives jobNumber). */
  jobId?: string;
  customerId?: string;
  /** Display fallback only (existing behavior). */
  jobNumber?: string;
  customer?: string;
  site?: string;
  trade?: PurchaseOrder['trade'];
  orderedAt: string;
  expectedDate?: string;
  lines: POLine[];
};

export type ImportItemsResult = {
  created: number;
  updated: number;
  errors: { index: number; message: string }[];
};

/** buildPaginationMeta envelope — mirrors backend/src/lib/pagination.ts. */
export type PaginationMeta = {
  page: number;
  limit: number;
  total: number;
  totalPages: number;
};

/** One server-computed low-stock row: a (item, location) pair where
 *  on_hand < min (P5 §1 — GET /api/inventory/low-stock, mapLowStockRow). */
export type LowStockRow = {
  itemId: string;
  sku: string;
  name: string;
  kind?: string;
  status?: string;
  /** Deactivated items stay visible on stock surfaces (QA-105) — badge them. */
  isActive: boolean;
  trackInventory: boolean;
  vendorId: string | null;
  /** Vendor NAME — what the P2 proposal builder groups on. */
  vendorName: string | null;
  locationId: string;
  locationName: string;
  locationType?: string;
  onHand: number;
  min: number;
  max: number | null;
};

/** camelCase filters for the P5 Action log — mapped to the movements
 *  endpoint's snake_case query params inside useMovements. */
export type MovementFilters = {
  type?: MovementType;
  itemId?: string;
  locationId?: string;
  jobId?: string;
  /** Drill-through: show only the movements a single Logistic Order posted. */
  logisticOrderId?: string;
  actorUserId?: string;
  /** ISO date (yyyy-mm-dd) bounds on occurred_at. */
  occurredFrom?: string;
  occurredTo?: string;
  page?: number;
  limit?: number;
};

/** camelCase item write payload — mapped to the price-book snake_case body. */
export type ItemWritePayload = {
  id?: string;
  name: string;
  sku?: string;
  mpn?: string;
  modelNumber?: string;
  upc?: string;
  brandId?: string;
  vendorId?: string;
  categoryId?: string;
  trade?: string;
  kind?: string;
  uom?: string;
  unitCost?: number;
  sellPrice?: number;
  listPrice?: number;
  serialized?: boolean;
  hazmat?: boolean;
  status?: string;
  visibility?: string;
  customerName?: string;
  customerDescription?: string;
  keyFeatures?: string[];
  photoUrl?: string;
  trackInventory?: boolean;
  /** SRVW-90. `type` is deliberately absent - the server derives it from `kind`,
   *  so there is no second copy of that rule to drift. */
  taxable?: boolean;
};

/** A dialog-synthesized placeholder FK (e.g. `brd_new_1753...`) reaching the
 *  server 400s on `z.string().uuid()` today - loudly. Silently stripping it
 *  would trade that loud failure for a quiet one: a success toast with the
 *  brand/vendor/category never actually saved. Throw instead. */
function assertServerFk(field: string, v?: string) {
  if (v && PLACEHOLDER_ID_RE.test(v)) {
    throw new Error(`${field} is still a local placeholder id (${v}) - the parent entity was not saved.`);
  }
  return v;
}

/** camelCase → price-book snake_case body. Undefined keys drop out of the
 *  JSON payload, so untouched fields are simply not sent. Exported for tests. */
export function toPriceBookBody(p: ItemWritePayload) {
  return {
    name: p.name,
    sku: p.sku,
    mpn: p.mpn,
    model_number: p.modelNumber,
    upc: p.upc,
    brand_id: assertServerFk('brand_id', p.brandId),
    vendor_id: assertServerFk('vendor_id', p.vendorId),
    category_id: assertServerFk('category_id', p.categoryId),
    trade: p.trade,
    kind: p.kind,
    uom: p.uom,
    unit_cost: p.unitCost,
    sell_price: p.sellPrice,
    list_price: p.listPrice,
    serialized: p.serialized,
    hazmat: p.hazmat,
    status: p.status,
    visibility: p.visibility,
    customer_name: p.customerName,
    customer_description: p.customerDescription,
    key_features: p.keyFeatures,
    photo_url: p.photoUrl,
    track_inventory: p.trackInventory,
    taxable: p.taxable,
  };
}

// Dialogs synthesize ids like `cat_new_<ts>` for freshly-created rows; only a
// UUID is a real server id, and only real ids route to the update path.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function isServerId(id: string | undefined): id is string {
  return !!id && UUID_RE.test(id);
}

// The same dialog-synthesized placeholder convention, matched narrowly (not
// "anything that is not a UUID") so legitimate non-UUID ids never trip it.
const PLACEHOLDER_ID_RE = /^[a-z]+_new_\d+$/;

/** SRVW-93 - a nested create dialog resolves with `unknown`: a real page awaits
 *  the mutation and gets the persisted row back, but a caller that only wants
 *  today's behaviour (NewPODialog's void handler, a `vi.fn()` test stub
 *  resolving undefined) still compiles and still works. Adopts the server id
 *  only when `result` is genuinely a server-backed row; otherwise falls back
 *  to the locally-synthesized row untouched. */
export function adoptServerId<T extends { id: string }>(local: T, result: unknown): T {
  if (result && typeof result === 'object' && 'id' in result) {
    const id = (result as { id?: unknown }).id;
    if (typeof id === 'string' && isServerId(id)) return { ...local, id };
  }
  return local;
}

// Re-export the shared types the P0 API does not reshape so components import
// them from the seam, never `_mock`.
export type {
  Vendor, VendorContact, Brand, Category, ItemGroup, ItemGroupLine, Movement,
  MovementType, Location, Branch, RFQ, RFQQuote, PrePOLine, EstimateReservation,
  EmailThreadEntry, JobStage, StagedItem, StageAttachment, StageAuditEntry,
  StockApproval, ApprovalModification, ApprovalActionType, InventoryJob, Tech,
} from '@/lib/api/_mock/inventory';

// Re-export the pure value helpers/labels as plain values (NOT hooks).
export {
  tradeColor, defaultVisibilityForKind, approvalTypeLabel, approvalTypeTint,
  TECH_ROLE_LABEL,
} from '@/lib/api/_mock/inventory';

// Stock helpers, retyped against the live Item shape. `reserved`-based
// helpers (totalReserved/totalAvailable) are gone with the phantom column.
export function totalOnHand(item: Item) {
  return item.stock.reduce((sum, s) => sum + s.onHand, 0);
}
export function isLowStock(item: Item) {
  return item.stock.some((s) => s.min != null && s.onHand < s.min);
}
export function inventoryValue(item: Item) {
  return totalOnHand(item) * (item.unitCost ?? 0);
}

/** `includeArchived` surfaces items the hybrid delete archived instead of
 *  hard-deleting (Task 2's `include_archived` query flag) - the Items grid's
 *  "Show archived" toggle threads it through. */
export function useInventoryItems(includeArchived = false) {
  return useQuery<Item[]>({
    queryKey: ['inventory', 'items', { includeArchived }],
    queryFn: USE_MOCK
      ? () => Promise.resolve(mock.items)
      : // {data,meta} envelope (P0 §D5). parsePagination caps limit at 100 —
        // orgs beyond 100 catalog items truncate the Stock view until the
        // follow-up server-driven pagination lands.
        () =>
          api
            .get(`/api/inventory/items?limit=100${includeArchived ? '&include_archived=true' : ''}`)
            .then((r) => r.data.data),
  });
}
export function useVendors() {
  return useQuery<Vendor[]>({ queryKey: ['inventory', 'vendors'], queryFn: USE_MOCK ? () => Promise.resolve(mock.vendors) : () => api.get('/api/inventory/vendors').then((r) => r.data.vendors) });
}
export function useBrands() {
  return useQuery<Brand[]>({ queryKey: ['inventory', 'brands'], queryFn: USE_MOCK ? () => Promise.resolve(mock.brands) : () => api.get('/api/inventory/brands').then((r) => r.data.brands) });
}
export function useCategories() {
  return useQuery<Category[]>({ queryKey: ['inventory', 'categories'], queryFn: USE_MOCK ? () => Promise.resolve(mock.categories) : () => api.get('/api/inventory/categories').then((r) => r.data.categories) });
}
export function useItemGroups() {
  return useQuery<ItemGroup[]>({ queryKey: ['inventory', 'item-groups'], queryFn: USE_MOCK ? () => Promise.resolve(mock.itemGroups) : () => api.get('/api/inventory/item-groups').then((r) => r.data.itemGroups) });
}
export function useLocations() {
  return useQuery<Location[]>({ queryKey: ['inventory', 'locations'], queryFn: USE_MOCK ? () => Promise.resolve(mock.locations) : () => api.get('/api/inventory/locations').then((r) => r.data.locations) });
}
export function useBranches() {
  return useQuery<Branch[]>({ queryKey: ['inventory', 'branches'], queryFn: USE_MOCK ? () => Promise.resolve(mock.branches) : () => api.get('/api/inventory/branches').then((r) => r.data.branches) });
}
/** P5 Action log: `{data,meta}` envelope with server-side filters + joins.
 *  Filters are camelCase here and mapped to the endpoint's snake_case params;
 *  undefined values drop out of the querystring (axios skips them). */
export function useMovements(filters: MovementFilters = {}) {
  return useQuery({
    queryKey: ['inventory', 'movements', filters],
    queryFn: () =>
      api
        .get('/api/inventory/movements', {
          params: {
            type: filters.type,
            item_id: filters.itemId,
            location_id: filters.locationId,
            job_id: filters.jobId,
            logistic_order_id: filters.logisticOrderId,
            actor_user_id: filters.actorUserId,
            occurred_from: filters.occurredFrom,
            occurred_to: filters.occurredTo,
            page: filters.page,
            limit: filters.limit,
          },
        })
        .then((r) => r.data as { data: Movement[]; meta: PaginationMeta }),
  });
}

/** P5 §1 — server-computed low stock, unbounded and authoritative (the
 *  client-side header/KPI detection stays capped at the 100-item window).
 *  Lives under the ['inventory'] key prefix so every stock mutation's
 *  invalidation refreshes it for free. */
export function useLowStock(params: { locationId?: string; page?: number; limit?: number } = {}) {
  return useQuery({
    queryKey: ['inventory', 'low-stock', params],
    queryFn: () =>
      api
        .get('/api/inventory/low-stock', {
          params: {
            location_id: params.locationId,
            page: params.page,
            limit: params.limit ?? 100,
          },
        })
        .then((r) => r.data as { data: LowStockRow[]; meta: PaginationMeta }),
  });
}
// `enabled` on this hook and useTechs below, but not on the rest of this module:
// these two are the only ones consumed from OUTSIDE the inventory module (the phone
// Dialer and CallMaskingView), where the host page belongs to a different plan tier
// and nothing else stops them firing. Every other hook here is reached only through
// /inventory/* routes, which <RequireFeature feature="inventory"> already guards.
// Orgs that DO have inventory are unaffected; orgs that do not skip a call that
// could only ever 402.
export function usePurchaseOrders() {
  const hasInventory = useFeature('inventory');
  return useQuery<PurchaseOrder[]>({ queryKey: ['inventory', 'purchase-orders'], queryFn: USE_MOCK ? () => Promise.resolve(mock.purchaseOrders) : () => api.get('/api/inventory/purchase-orders').then((r) => r.data.purchaseOrders), enabled: USE_MOCK || hasInventory });
}

/** One entry in a PO's real activity timeline (D7) — merged server-side from the
 *  audit log (created/updated/received + actor) and the outbound send history
 *  (subject + recipients). Replaces the fully-synthesized ActivityTabStub. */
export type POActivityEvent = {
  id: string;
  at: string; // ISO 8601
  kind: 'created' | 'updated' | 'received' | 'email_sent' | 'event';
  summary: string;
  actor: string | null;
  detail?: string;
};

/** Lazy — fetched only when the Activity tab mounts with a real PO id. */
export function usePOActivity(poId: string | null | undefined) {
  return useQuery<POActivityEvent[]>({
    queryKey: ['inventory', 'po-activity', poId],
    enabled: !!poId,
    queryFn: USE_MOCK
      ? () => Promise.resolve([] as POActivityEvent[])
      : () => api.get(`/api/inventory/purchase-orders/${poId}/activity`).then((r) => r.data.activity),
  });
}
// useRFQs was removed with the RFQ feature-parking (P0 §C) — the endpoint 404s.
export function useEstimateReservations() {
  return useQuery<EstimateReservation[]>({ queryKey: ['inventory', 'estimate-reservations'], queryFn: USE_MOCK ? () => Promise.resolve(mock.estimateReservations) : () => api.get('/api/inventory/estimate-reservations').then((r) => r.data.estimateReservations) });
}
export function useJobStages() {
  return useQuery<JobStage[]>({ queryKey: ['inventory', 'job-stages'], queryFn: USE_MOCK ? () => Promise.resolve(mock.jobStages) : () => api.get('/api/inventory/job-stages').then((r) => r.data.jobStages) });
}
// Dormant (stock-approvals endpoint is feature-parked, P0 §C): kept for the
// unrouted ApprovalsView/approval dialogs — must have ZERO mounted callers.
export function useStockApprovals() {
  return useQuery<StockApproval[]>({ queryKey: ['inventory', 'stock-approvals'], queryFn: USE_MOCK ? () => Promise.resolve(mock.stockApprovals) : () => api.get('/api/inventory/stock-approvals').then((r) => r.data.stockApprovals) });
}
export function useInventoryJobs() {
  return useQuery<InventoryJob[]>({ queryKey: ['inventory', 'jobs'], queryFn: USE_MOCK ? () => Promise.resolve(mock.jobs) : () => api.get('/api/inventory/jobs').then((r) => r.data.jobs) });
}
// See the note on usePurchaseOrders - same cross-module consumers, same reasoning.
export function useTechs() {
  const hasInventory = useFeature('inventory');
  return useQuery<Tech[]>({ queryKey: ['inventory', 'techs'], queryFn: USE_MOCK ? () => Promise.resolve(mock.techs) : () => api.get('/api/inventory/techs').then((r) => r.data.techs), enabled: USE_MOCK || hasInventory });
}

// ─── My-van (Inventory P3 — the requester's own truck stock) ────────────────
// GET /api/inventory/my-van is own-scope by construction (primary_tech_id = requester)
// and cost-stripped by projection — `unit_price` is the customer-facing selling price.
// `restricted` is the server-computed D10/D13 lock signal (role TECHNICIAN + the
// `location_restricted` override) — the FE never re-derives it.

export interface MyVan {
  location: { id: string; name: string; type: string; vehicle?: string };
  restricted: boolean;
  balances: {
    item: {
      id: string;
      sku?: string;
      name: string;
      type: string;
      uom?: string;
      unit_price: number;
      track_inventory: boolean;
      is_active: boolean;
      image_url?: string;
    };
    on_hand: number;
    min?: number;
    max?: number;
  }[];
}

export function useMyVan(enabled = true) {
  return useQuery<MyVan | null>({
    queryKey: ['inventory', 'my-van'],
    queryFn: () =>
      api
        .get('/api/inventory/my-van')
        .then((r) => r.data as MyVan)
        // 404 NO_VAN_ASSIGNED ⇒ null (a normal state for van-less users), not an error state.
        .catch((e) => {
          if (e?.response?.status === 404) return null;
          throw e;
        }),
    enabled,
    retry: false,
    staleTime: 30_000,
  });
}

function useInventoryMutation<TArgs>(path: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (args: TArgs) =>
      USE_MOCK ? Promise.resolve(args) : api.post(path, args).then((r) => r.data),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['inventory'] }),
  });
}

// ─── Assets (P4 — company tools assigned to technicians) ────────────────────
// New feature ⇒ real-API only (no USE_MOCK branch). Server contract:
// GET list → {data, meta}; single/verbs → {asset}; events → {events}.

export type AssetStatus = 'ACTIVE' | 'RETIRED';
export type AssetEventType = 'ASSIGNED' | 'RETURNED' | 'TRANSFERRED' | 'RETIRED' | 'NOTE';
export type AssetUserRef = { id: string; first_name: string; last_name: string };
export type Asset = {
  id: string;
  name: string;
  serial: string | null;
  status: AssetStatus;
  notes: string | null;
  /** Short-lived signed URL minted per response (or null) — never a storage path. */
  photo_url: string | null;
  price_book_item: { id: string; name: string } | null;
  assigned_user: AssetUserRef | null;
  created_at: string;
  updated_at: string;
};
export type AssetEvent = {
  id: string;
  type: AssetEventType;
  note: string | null;
  at: string;
  /** Counterparty tech (new holder / releasing holder); null for NOTE. */
  user: AssetUserRef | null;
  /** Actor — null only after a user hard-delete (SetNull). */
  by_user: AssetUserRef | null;
};
export type AssetFilters = { status?: AssetStatus; assigned_user_id?: string; search?: string };
export type AssetWriteBody = {
  name: string;
  serial: string | null;
  price_book_item_id: string | null;
  notes: string | null;
};
export type AssetActionInput = {
  id: string;
  action: 'assign' | 'return' | 'transfer' | 'retire' | 'note';
  user_id?: string;
  note?: string;
};

export function useAssets(filters: AssetFilters, page = 1) {
  return useQuery<{ data: Asset[]; meta: { total: number } }>({
    queryKey: ['inventory', 'assets', filters, page],
    queryFn: () =>
      api
        .get('/api/inventory/assets', { params: { ...filters, page, limit: 100 } })
        .then((r) => r.data),
  });
}

export function useAssetEvents(assetId: string | null) {
  return useQuery<AssetEvent[]>({
    queryKey: ['inventory', 'assets', assetId, 'events'],
    queryFn: () => api.get(`/api/inventory/assets/${assetId}/events`).then((r) => r.data.events),
    enabled: !!assetId,
  });
}

export function useCreateAsset() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: AssetWriteBody) =>
      api.post('/api/inventory/assets', body).then((r) => r.data.asset as Asset),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['inventory', 'assets'] }),
  });
}

export function useUpdateAsset() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...body }: { id: string } & Partial<AssetWriteBody>) =>
      api.patch(`/api/inventory/assets/${id}`, body).then((r) => r.data.asset as Asset),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['inventory', 'assets'] }),
  });
}

export function useDeleteAsset() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id }: { id: string }) =>
      api.delete(`/api/inventory/assets/${id}`).then((r) => r.data),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['inventory', 'assets'] }),
  });
}

/** assign / return / transfer / retire / note — the only writes that move
 *  status + assigned_user_id (PATCH never does). List + per-asset events keys
 *  share the ['inventory','assets'] prefix, so one invalidation covers both. */
export function useAssetAction() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, action, ...body }: AssetActionInput) =>
      api.post(`/api/inventory/assets/${id}/${action}`, body).then((r) => r.data.asset as Asset),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['inventory', 'assets'] }),
  });
}

export function useUploadAssetPhoto() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, file }: { id: string; file: File }) => {
      const fd = new FormData();
      fd.append('file', file);
      return api
        .post(`/api/inventory/assets/${id}/photo`, fd, {
          headers: { 'Content-Type': 'multipart/form-data' },
        })
        .then((r) => r.data.asset as Asset);
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ['inventory', 'assets'] }),
  });
}

// ─── Catalog writes → /api/price-book/* (single write path, P0 §D) ──────────

export function useUpsertItem() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (p: ItemWritePayload) =>
      p.id
        ? api.patch(`/api/price-book/items/${p.id}`, toPriceBookBody(p)).then((r) => r.data.data)
        : api.post('/api/price-book/items', toPriceBookBody(p)).then((r) => r.data.data),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['inventory'] }),
  });
}

export type DeleteItemResult = { mode: 'deleted' | 'archived'; message: string; referenceCount?: number };

/** Hybrid delete - DELETE /api/price-book/items/:id hard-deletes an item with
 *  no references, or archives (is_active=false) one that's still referenced
 *  by history so downstream records stay intact. */
export function useDeleteItem() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id }: { id: string }) =>
      api.delete(`/api/price-book/items/${id}`).then((r) => r.data as DeleteItemResult),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['inventory'] }),
  });
}

/** Restore an item the hybrid delete archived (is_active back to true) - reuses
 *  the existing price-book update path, since is_active is already an allowed field. */
export function useRestoreItem() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id }: { id: string }) =>
      api.patch(`/api/price-book/items/${id}`, { is_active: true }).then((r) => r.data.data),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['inventory'] }),
  });
}

export function useUpsertCategory() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (p: Partial<Category>) => {
      const body = {
        name: p.name,
        trade: p.trade,
        description: p.description,
        photo_url: p.photoUrl,
      };
      return isServerId(p.id)
        ? api.patch(`/api/price-book/categories/${p.id}`, body).then((r) => r.data.data)
        : api.post('/api/price-book/categories', body).then((r) => r.data.data);
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ['inventory'] }),
  });
}

export function useUpsertBrand() {
  const qc = useQueryClient();
  return useMutation({
    // A dialog-synthesized `brd_new_*` id is stripped so the handler takes its
    // create branch. Unwraps the server's `{brand}` envelope (SRVW-93) so a
    // caller adopting the returned id (adoptServerId) actually sees it.
    mutationFn: (p: Partial<Brand>) =>
      api.post('/api/price-book/brands', { ...p, id: isServerId(p.id) ? p.id : undefined }).then((r) => r.data.brand as Brand),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['inventory'] }),
  });
}

export function useUpsertItemGroup() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (p: Partial<ItemGroup>) =>
      api.post('/api/price-book/item-groups', { ...p, id: isServerId(p.id) ? p.id : undefined }).then((r) => r.data),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['inventory'] }),
  });
}

function useDeleteById(pathPrefix: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id }: { id: string }) => api.delete(`${pathPrefix}/${id}`).then((r) => r.data),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['inventory'] }),
  });
}
export const useDeleteBrand     = () => useDeleteById('/api/price-book/brands');
export const useDeleteItemGroup = () => useDeleteById('/api/price-book/item-groups');
export const useDeleteCategory  = () => useDeleteById('/api/price-book/categories');

export function useImportItemsCSV() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (payload: { items: unknown[] }) =>
      api.post('/api/price-book/items/import', payload).then((r) => r.data as ImportItemsResult),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['inventory'] }),
  });
}

// ─── Stock / PO / staging writes (stay on /api/inventory/*) ─────────────────

/** camelCase location write payload — mapped to the inv-locations snake_case body (P3 §1b). */
export type LocationWritePayload = {
  /** Present ⇒ PATCH /locations/:id; absent ⇒ POST /locations. */
  id?: string;
  name: string;
  type: string;
  branchId?: string | null;
  /** The assigned tech's USER id; null unassigns the van. */
  primaryTechId?: string | null;
  vehicle?: string | null;
  stagingAreas?: string[] | null;
};

/**
 * Create/update an inventory location for real (P3 §1b — replaces the old POST-only,
 * call-site-less stub). Branch/tech arrive as IDs; callers map display names to ids
 * (AddLocationDialog stores the branch by NAME — InventoryPage resolves it via useBranches).
 * Resolves with the server's `{ location }` row (real id for create).
 */
export function useUpsertLocation() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (p: LocationWritePayload) => {
      const body = {
        name: p.name,
        type: p.type,
        branch_id: p.branchId ?? null,
        primary_tech_id: p.primaryTechId ?? null,
        vehicle: p.vehicle ?? null,
        stagingAreas: p.stagingAreas ?? null,
      };
      return p.id
        ? api.patch(`/api/inventory/locations/${p.id}`, body).then((r) => r.data.location as Location)
        : api.post('/api/inventory/locations', body).then((r) => r.data.location as Location);
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ['inventory'] }),
  });
}
/** SRVW-93 - the server returns a `{branch}` envelope (inv-locations.controller.ts),
 *  not the raw body useInventoryMutation would resolve with, so this is an explicit
 *  useMutation rather than the generic helper. */
export function useUpsertBranch() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (p: Partial<Branch>) =>
      api.post('/api/inventory/branches', { ...p, id: isServerId(p.id) ? p.id : undefined }).then((r) => r.data.branch as Branch),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['inventory'] }),
  });
}
// SRVW-92 - unitCost is deliberately optional-and-absent (not `number | null`) so a
// cost-stripped caller (no `read Invoice`) can omit it entirely rather than send a false 0.
export type RestockPayload = {
  itemId: string;
  locationId: string;
  qty: number;
  unitCost?: number;
  source?: string;
  reference?: string;
  notes?: string;
};
export const useRestock           = () => useInventoryMutation<RestockPayload>('/api/inventory/restock');
export const useTransferStock     = () => useInventoryMutation<unknown>('/api/inventory/transfer');
/** Inventory P1 §6 — physical count: records ONE `adjust` movement of counted − on-hand.
 *  Deliberately NOT useInventoryMutation: that helper posts its camelCase args verbatim, and
 *  setQuantitySchema is snake_case (item_id/location_id/counted_qty/reason), so posting through
 *  the generic helper 400s on every submit. */
export function useSetQuantity() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (p: { itemId: string; locationId: string; countedQty: number; reason: string }) =>
      api
        .post('/api/inventory/stock/set-quantity', {
          item_id: p.itemId,
          location_id: p.locationId,
          counted_qty: p.countedQty,
          reason: p.reason,
        })
        .then((r) => r.data),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['inventory'] }),
  });
}

/** SRVW-91 - per-(item, location) reserve levels. Deliberately NOT useInventoryMutation:
 *  that helper posts its camelCase args verbatim, and the server schema is snake_case, so
 *  the mapping is written out here (the shape useUpsertLocation already uses). */
export function useSetThresholds() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (p: { itemId: string; locationId: string; min: number | null; max: number | null }) =>
      api
        .put('/api/inventory/stock/thresholds', {
          item_id: p.itemId,
          location_id: p.locationId,
          min: p.min,
          max: p.max,
        })
        .then((r) => r.data),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['inventory'] }),
  });
}

/** AddItemDialog's starting-stock entry (structurally the same as NewItem['startingStock'][0];
 *  restated here so the seam does not import a component type). */
export type StartingStockEntry = { locationId: string; qty: number; min?: number; max?: number };

/** SRVW-91 - the shared create-time rule for both AddItemDialog mounts that persist the item.
 *  Returns null when there is nothing to write: no entry, no location, or neither threshold
 *  filled. ImportCSVDialog always emits `startingStock: []`, so the CSV path is a no-op. */
export function startingThresholdsFor(
  startingStock: StartingStockEntry[] | undefined,
): { locationId: string; min: number | null; max: number | null } | null {
  const entry = startingStock?.[0];
  if (!entry || !entry.locationId) return null;
  if (entry.min === undefined && entry.max === undefined) return null;
  return { locationId: entry.locationId, min: entry.min ?? null, max: entry.max ?? null };
}

export function useCreatePO() {
  const qc = useQueryClient();
  return useMutation({
    // po_number is server-assigned; callers consume the returned purchaseOrder.
    mutationFn: (input: NewPOInput) =>
      api
        .post('/api/inventory/purchase-orders', input)
        .then((r) => r.data as { purchaseOrder: PurchaseOrder }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['inventory'] }),
  });
}

export type UpdatePOPayload = { id: string } & Partial<Pick<NewPOInput, 'vendor' | 'vendorId' | 'expectedDate'>> & { status?: POStatus };
export function useUpdatePO() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...body }: UpdatePOPayload) =>
      api
        .patch(`/api/inventory/purchase-orders/${id}`, body)
        .then((r) => r.data as { purchaseOrder: PurchaseOrder }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['inventory'] }),
  });
}

export type ReceivePOPayload = {
  poId: string;
  destinationLocationId: string;                       // D14 — always sent by the dialog
  lines: { lineId: string; qtyReceived: number }[];    // identity by PO line id (D2); absolute totals
};
export function useReceivePO() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (payload: ReceivePOPayload) =>
      api
        .post('/api/inventory/purchase-orders/receive', payload)
        .then((r) => r.data as { purchaseOrder: PurchaseOrder }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['inventory'] }),
  });
}

export type SendPOPayload = {
  id: string;
  to: string[];
  cc?: string[];
  subject: string;
  message: string;
};
export function useSendPO() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...body }: SendPOPayload) =>
      api
        .post(`/api/inventory/purchase-orders/${id}/send`, body)
        .then((r) => r.data as { purchaseOrder: PurchaseOrder; email?: unknown }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['inventory'] }),
  });
}

export function useConvertReservation() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      api
        .post(`/api/inventory/estimate-reservations/${id}/convert`)
        .then((r) => r.data as { purchaseOrder: PurchaseOrder; estimateReservation: EstimateReservation }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['inventory'] }),
  });
}

export function useDismissReservation() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, reason }: { id: string; reason?: string }) =>
      api
        .post(`/api/inventory/estimate-reservations/${id}/dismiss`, reason ? { reason } : {})
        .then((r) => r.data as { estimateReservation: EstimateReservation }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['inventory'] }),
  });
}

/** D15 actuals — received PO material spend for a job. Lives under the
 *  ['inventory'] key prefix ON PURPOSE: every PO receive / sync / return
 *  mutation already invalidates ['inventory'], so the row refreshes for free. */
export function useJobMaterialCost(jobId: string | undefined, enabled: boolean) {
  return useQuery<{ jobId: string; materialCost: number; lineCount: number }>({
    queryKey: ['inventory', 'job-material-cost', jobId],
    queryFn: () => api.get(`/api/inventory/jobs/${jobId}/material-cost`).then((r) => r.data),
    enabled: !!jobId && enabled,
    retry: false, // 403 for non-PurchaseOrder readers must not retry-loop
  });
}
// useCreateRFQ was removed with the RFQ feature-parking (P0 §C).
export const useCreateStage       = () => useInventoryMutation<unknown>('/api/inventory/job-stages');
export const useReceiveStageLine  = () => useInventoryMutation<unknown>('/api/inventory/job-stages/receive');
export const useNotifyTechReady   = () => useInventoryMutation<unknown>('/api/inventory/job-stages/notify');
export const useEmailStagePickup  = () => useInventoryMutation<{ stageId: string; to: string[]; cc?: string[]; subject: string; message?: string }>('/api/inventory/job-stages/email');

// P5 §5 — staging attachments persist to Supabase Storage. The caller builds
// the multipart FormData (file + lenient metadata text parts); the response
// carries a freshly-signed URL in `attachment.dataUrl`.
export function useUploadStageAttachment() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ stageId, form }: { stageId: string; form: FormData }) =>
      api
        .post(`/api/inventory/job-stages/${stageId}/attachments`, form)
        .then((r) => r.data as { attachment: StageAttachment }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['inventory', 'job-stages'] }),
  });
}
export function useDeleteStageAttachment() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ stageId, attachmentId }: { stageId: string; attachmentId: string }) =>
      api
        .delete(`/api/inventory/job-stages/${stageId}/attachments/${attachmentId}`)
        .then((r) => r.data as { success: boolean }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['inventory', 'job-stages'] }),
  });
}
// Dormant (feature-parked endpoints): exports stay for the unrouted approval
// components; no mounted callers.
export const useCreateApproval    = () => useInventoryMutation<unknown>('/api/inventory/stock-approvals');
export const useDecideApproval    = () => useInventoryMutation<unknown>('/api/inventory/stock-approvals/decide');
// A dialog-synthesized `vnd_new_<ts>` id must not reach the update branch —
// it 500ed there (looked up against the UUID `vendors.id` column). Strip it
// the same way useUpsertBrand/useUpsertItemGroup already do.
export function useUpsertVendor() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (p: Partial<Vendor>) =>
      api.post('/api/inventory/vendors', { ...p, id: isServerId(p.id) ? p.id : undefined }).then((r) => r.data.vendor as Vendor),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['inventory'] }),
  });
}
// P2 (QA-610/A-17): canonical DELETE /vendors/:id — the old POST /vendors/delete
// answers 410 GONE server-side. 409 VENDOR_HAS_POS → archive fallback (VendorsPage).
export const useDeleteVendor      = () => useDeleteById('/api/inventory/vendors');
