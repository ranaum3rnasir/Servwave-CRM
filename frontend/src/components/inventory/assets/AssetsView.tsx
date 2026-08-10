/**
 * AssetsView — the Assets tab body on the Inventory page (P4, plan §4 / D12).
 * Company tools (drill/jigsaw + serial) assigned to technicians, with an
 * append-only per-tool history. Straight TanStack Query — no seed→local-state
 * mirror (plan §3.5); the server owns filtering (status/assignee/search).
 */
import { useEffect, useMemo, useState } from "react";
import { formatDistanceToNow } from "date-fns";
import { Input } from "@/components/ui/input";
import {
  ArchiveX,
  ArrowRightLeft,
  MoreHorizontal,
  Pencil,
  Search,
  StickyNote,
  Trash2,
  Undo2,
  UserPlus,
  Wrench,
} from "lucide-react";
import {
  useAssets,
  useDeleteAsset,
  type Asset,
  type AssetFilters,
} from "@/lib/api/inventory";
import { useUsers } from "@/lib/api/users";
import { AssetThumb } from "./AssetBits";
import { AssetDialog } from "./AssetDialog";
import { AssetActionDialog, type AssetActionMode } from "./AssetActionDialog";
import { AssetHistoryDrawer } from "./AssetHistoryDrawer";
import { Button } from "@/components/ui/button";
import { StatusBadge } from "@/components/data/status-badge";
import { EmptyState } from "@/components/ui/empty-state";
import { useConfirm } from "@/hooks/useConfirm";

type EditorState = null | { asset: Asset | null }; // null asset = create
type ActionState = null | { mode: AssetActionMode; asset: Asset };

export function AssetsView({ onToast }: { onToast: (msg: string) => void }) {
  const { confirm, confirmDialog } = useConfirm();
  const [search, setSearch] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [assigneeId, setAssigneeId] = useState<string>("all");
  const [showRetired, setShowRetired] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [openKebabId, setOpenKebabId] = useState<string | null>(null);
  const [editor, setEditor] = useState<EditorState>(null);
  const [action, setAction] = useState<ActionState>(null);

  useEffect(() => {
    const t = setTimeout(() => setDebouncedSearch(search), 300);
    return () => clearTimeout(t);
  }, [search]);

  // Retired filter: unchecked (default) sends status ACTIVE; checked sends no
  // status (all rows) — retired rows render dimmed with a gray RETIRED pill.
  const filters = useMemo<AssetFilters>(
    () => ({
      ...(showRetired ? {} : { status: "ACTIVE" as const }),
      ...(debouncedSearch.trim() ? { search: debouncedSearch.trim() } : {}),
      ...(assigneeId !== "all" ? { assigned_user_id: assigneeId } : {}),
    }),
    [showRetired, debouncedSearch, assigneeId],
  );

  const assetsQuery = useAssets(filters, 1);
  const assets = useMemo(() => assetsQuery.data?.data ?? [], [assetsQuery.data]);
  const usersQuery = useUsers();
  const users = usersQuery.data ?? [];
  const deleteAsset = useDeleteAsset();

  const selectedAsset = useMemo(
    () => assets.find((a) => a.id === selectedId) ?? null,
    [assets, selectedId],
  );

  const hasFilters =
    showRetired || debouncedSearch.trim() !== "" || assigneeId !== "all";

  async function handleDelete(asset: Asset) {
    if (
      !(await confirm({
        title: `Delete "${asset.name}"?`,
        description: "Its history is deleted with it. This can't be undone.",
        confirmLabel: "Delete",
        tone: "danger",
      }))
    )
      return;
    try {
      await deleteAsset.mutateAsync({ id: asset.id });
    } catch {
      onToast(`✗ Could not delete "${asset.name}" — try again.`);
      return;
    }
    if (selectedId === asset.id) setSelectedId(null);
    onToast(`✓ "${asset.name}" deleted`);
  }

  return (
    <div className="flex flex-1 flex-col overflow-hidden">
      {/* Header row — search / assignee / retired toggle / create */}
      <div className="flex flex-wrap items-center gap-3 border-b border-border bg-surface-light px-6 py-3">
        <div className="relative flex-1 max-w-md">
          <Search className="absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-text-secondary" />
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search assets…"
            className="w-full py-1.5 pl-9 pr-3"
          />
        </div>
        <select
          value={assigneeId}
          onChange={(e) => setAssigneeId(e.target.value)}
          aria-label="Filter by assignee"
          className="rounded-md border border-border bg-surface-light px-2.5 py-1.5 text-sm text-text-primary focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/20"
        >
          <option value="all">Anyone</option>
          {users
            .filter((u) => u.is_active)
            .map((u) => (
              <option key={u.id} value={u.id}>
                {u.first_name} {u.last_name}
              </option>
            ))}
        </select>
        {/* Not converted to FormField: this label WRAPS a checkbox with the
            text trailing inline on the same row - a checkbox shape FormField
            's own header comment excludes, not the vertical label-above-a-
            single-control column FormField renders. */}
        <label className="inline-flex cursor-pointer items-center gap-1.5 text-sm text-text-secondary">
          <input
            type="checkbox"
            checked={showRetired}
            onChange={(e) => setShowRetired(e.target.checked)}
            className="rounded"
          />
          Show retired
        </label>
        <span className="text-xs text-text-secondary">
          {assetsQuery.data?.meta.total ?? 0} asset
          {(assetsQuery.data?.meta.total ?? 0) === 1 ? "" : "s"}
        </span>
        <Button size="sm"
          onClick={() => setEditor({ asset: null })}
          className="ml-auto"
        >
          <Wrench className="h-4 w-4" />
          New Asset
        </Button>
      </div>

      {/* Main split — table + history drawer */}
      <div className="flex flex-1 overflow-hidden">
        <div className="flex-1 overflow-auto bg-background-light">
          <table className="min-w-full border-separate border-spacing-0 text-sm">
            <thead className="sticky top-0 z-10 bg-background-light">
              <tr className="text-left text-xs font-semibold uppercase tracking-wide text-text-secondary">
                <Th>Name</Th>
                <Th>Serial</Th>
                <Th>Status</Th>
                <Th>Assignee</Th>
                <Th>Updated</Th>
                <Th className="w-10" />
              </tr>
            </thead>
            <tbody>
              {assetsQuery.isLoading &&
                [0, 1, 2].map((i) => (
                  <tr key={`skeleton-${i}`} className="border-b border-border bg-surface-light">
                    <Td colSpan={6}>
                      <div className="h-9 animate-pulse rounded-md bg-background-light" />
                    </Td>
                  </tr>
                ))}
              {!assetsQuery.isLoading &&
                assets.map((asset) => {
                  const isSelected = selectedId === asset.id;
                  const retired = asset.status === "RETIRED";
                  return (
                    <tr
                      key={asset.id}
                      onClick={() => setSelectedId(asset.id)}
                      className={[
                        "cursor-pointer border-b border-border transition",
                        isSelected
                          ? "bg-primary/10 hover:bg-primary/20"
                          : "bg-surface-light hover:bg-background-light",
                        retired ? "opacity-60" : "",
                      ].join(" ")}
                    >
                      <Td>
                        <div className="flex items-center gap-2.5">
                          <AssetThumb asset={asset} size={40} />
                          <div className="min-w-0">
                            <p className="truncate font-medium text-text-primary">
                              {asset.name}
                            </p>
                            {asset.price_book_item && (
                              <p className="mt-0.5 truncate text-[11px] text-text-secondary">
                                {asset.price_book_item.name}
                              </p>
                            )}
                          </div>
                        </div>
                      </Td>
                      <Td>
                        {asset.serial ? (
                          <code className="font-mono text-xs text-text-primary">
                            {asset.serial}
                          </code>
                        ) : (
                          <span className="text-text-secondary">—</span>
                        )}
                      </Td>
                      <Td>
                        <StatusBadge domain="asset" status={asset.status} />
                      </Td>
                      <Td>
                        {asset.assigned_user ? (
                          <span className="text-text-primary">
                            {asset.assigned_user.first_name}{" "}
                            {asset.assigned_user.last_name}
                          </span>
                        ) : (
                          <span className="text-text-secondary">Unassigned</span>
                        )}
                      </Td>
                      <Td>
                        <span
                          className="text-xs text-text-secondary"
                          title={new Date(asset.updated_at).toLocaleString('en-US')}
                        >
                          {formatDistanceToNow(new Date(asset.updated_at), {
                            addSuffix: true,
                          })}
                        </span>
                      </Td>
                      <Td>
                        <div className="relative">
                          <Button
                            onClick={(e) => {
                              e.stopPropagation();
                              setOpenKebabId(
                                openKebabId === asset.id ? null : asset.id,
                              );
                            }}
                            aria-label={`More actions for ${asset.name}`}
                            variant="ghost"
                            tone="subtle"
                            size="icon"
                          >
                            <MoreHorizontal className="h-4 w-4" />
                          </Button>
                          {openKebabId === asset.id && (
                            <div
                              className="absolute right-0 top-8 z-20 w-48 rounded-md border border-border bg-surface-light py-1 shadow-lg"
                              onClick={(e) => e.stopPropagation()}
                            >
                              {!retired && !asset.assigned_user && (
                                <KebabAction
                                  icon={UserPlus}
                                  onClick={() => {
                                    setAction({ mode: "assign", asset });
                                    setOpenKebabId(null);
                                  }}
                                >
                                  Assign
                                </KebabAction>
                              )}
                              {!retired && asset.assigned_user && (
                                <>
                                  <KebabAction
                                    icon={ArrowRightLeft}
                                    onClick={() => {
                                      setAction({ mode: "transfer", asset });
                                      setOpenKebabId(null);
                                    }}
                                  >
                                    Transfer
                                  </KebabAction>
                                  <KebabAction
                                    icon={Undo2}
                                    onClick={() => {
                                      setAction({ mode: "return", asset });
                                      setOpenKebabId(null);
                                    }}
                                  >
                                    Return
                                  </KebabAction>
                                </>
                              )}
                              <KebabAction
                                icon={StickyNote}
                                onClick={() => {
                                  setAction({ mode: "note", asset });
                                  setOpenKebabId(null);
                                }}
                              >
                                Add note
                              </KebabAction>
                              <KebabAction
                                icon={Pencil}
                                onClick={() => {
                                  setEditor({ asset });
                                  setOpenKebabId(null);
                                }}
                              >
                                Edit
                              </KebabAction>
                              {!retired && (
                                <KebabAction
                                  icon={ArchiveX}
                                  onClick={() => {
                                    setAction({ mode: "retire", asset });
                                    setOpenKebabId(null);
                                  }}
                                >
                                  Retire
                                </KebabAction>
                              )}
                              <div className="my-1 border-t border-border" />
                              <KebabAction
                                variant="danger"
                                icon={Trash2}
                                onClick={() => {
                                  setOpenKebabId(null);
                                  void handleDelete(asset);
                                }}
                              >
                                Delete
                              </KebabAction>
                            </div>
                          )}
                        </div>
                      </Td>
                    </tr>
                  );
                })}
              {!assetsQuery.isLoading && assets.length === 0 && (
                <tr>
                  <td
                    colSpan={6}
                    className="px-6 py-16 text-center text-sm text-text-secondary"
                  >
                    {hasFilters ? (
                      <EmptyState title="No assets match your filters." />
                    ) : (
                      <EmptyState
                        icon={Wrench}
                        title="No assets yet — track company tools and who holds them."
                        action={
                          <Button
                            onClick={() => setEditor({ asset: null })}
                            size="sm"
                          >
                            New Asset
                          </Button>
                        }
                      />
                    )}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>

        {selectedAsset && (
          <AssetHistoryDrawer
            asset={selectedAsset}
            onClose={() => setSelectedId(null)}
            onEdit={() => setEditor({ asset: selectedAsset })}
            onAction={(mode) => setAction({ mode, asset: selectedAsset })}
          />
        )}
      </div>

      {/* Mounted only while open: AssetDialog's dup-serial check queries the
          full asset list, and that fetch should not fire on every view render. */}
      {editor && (
        <AssetDialog
          open
          onClose={() => setEditor(null)}
          editAsset={editor.asset}
          onSaved={onToast}
        />
      )}
      {action && (
        <AssetActionDialog
          open
          mode={action.mode}
          asset={action.asset}
          onClose={() => setAction(null)}
          onDone={onToast}
        />
      )}
      {confirmDialog}
    </div>
  );
}

// Local copies of the tiny table primitives (InventoryPage keeps its own —
// importing them from the page would create a page↔component import cycle).
function Th({
  children,
  className,
}: {
  children?: React.ReactNode;
  className?: string;
}) {
  return (
    <th
      className={`border-b-2 border-r border-border border-r-border px-3 py-2 last:border-r-0 ${className ?? ""}`}
    >
      {children}
    </th>
  );
}
function Td({
  children,
  className,
  colSpan,
}: {
  children?: React.ReactNode;
  className?: string;
  colSpan?: number;
}) {
  return (
    <td
      colSpan={colSpan}
      className={`border-r border-r-border px-3 py-2.5 last:border-r-0 ${className ?? ""}`}
    >
      {children}
    </td>
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
    // Not converted to Button: dropdown menu item row.
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

