/**
 * AssetHistoryDrawer — right-side panel for a selected asset (P4). Photo +
 * summary header, state-appropriate action buttons, then the append-only
 * AssetEvent timeline (useAssetEvents). Visual skeleton mirrors the Stock
 * page's DetailPanel.
 */
import {
  ArchiveX,
  ArrowRightLeft,
  Pencil,
  StickyNote,
  Undo2,
  UserPlus,
  X,
} from "lucide-react";
import {
  useAssetEvents,
  type Asset,
  type AssetEventType,
} from "@/lib/api/inventory";
import { EmptyState } from "@/components/ui/empty-state";
import { Button } from "@/components/ui/button";
import { Heading } from "@/components/ui/heading";
import { AssetThumb } from "./AssetBits";
import type { AssetActionMode } from "./AssetActionDialog";
import { StatusBadge } from "@/components/data/status-badge";

const EVENT_LABEL: Record<AssetEventType, string> = {
  ASSIGNED: "Assigned",
  RETURNED: "Returned",
  TRANSFERRED: "Transferred",
  RETIRED: "Retired",
  NOTE: "Note",
};

// Dot color per event type — token classes only. Sage (success) is reserved
// for the positive signal (a tool going out to a tech); NOTE stays gray.
const EVENT_DOT: Record<AssetEventType, string> = {
  ASSIGNED: "bg-success",
  RETURNED: "bg-info",
  TRANSFERRED: "bg-primary",
  RETIRED: "bg-danger",
  NOTE: "bg-text-secondary",
};

type Props = {
  asset: Asset;
  onClose: () => void;
  onEdit: () => void;
  onAction: (mode: AssetActionMode) => void;
};

export function AssetHistoryDrawer({ asset, onClose, onEdit, onAction }: Props) {
  const eventsQuery = useAssetEvents(asset.id);
  const events = eventsQuery.data ?? [];
  const retired = asset.status === "RETIRED";

  return (
    <aside className="animate-panel-in flex w-96 flex-shrink-0 flex-col overflow-y-auto border-l border-border bg-surface-light shadow-lg">
      <div className="flex items-start justify-between gap-2 border-b border-border px-4 py-3">
        <div className="flex min-w-0 items-start gap-3">
          <AssetThumb asset={asset} size={56} />
          <div className="min-w-0">
            {/* leading-tight dropped: Heading has no line-height axis; scale/weight/tone
                otherwise match this h2's rendered look exactly (all default values). */}
            <Heading level={2}>{asset.name}</Heading>
            {asset.serial && (
              <code className="font-mono text-[11px] text-text-secondary">
                {asset.serial}
              </code>
            )}
            <div className="mt-1 flex flex-wrap items-center gap-1.5">
              <StatusBadge domain="asset" status={asset.status} />
              <span className="text-[11px] text-text-secondary">
                {asset.assigned_user
                  ? `Held by ${asset.assigned_user.first_name} ${asset.assigned_user.last_name}`
                  : "Unassigned"}
              </span>
            </div>
          </div>
        </div>
        <Button
          onClick={onClose}
          aria-label="Close asset panel"
          variant="ghost"
          tone="subtle"
          size="icon"
        >
          <X className="h-4 w-4" />
        </Button>
      </div>

      {(asset.price_book_item || asset.notes) && (
        <div className="border-b border-border px-4 py-3 text-xs">
          {asset.price_book_item && (
            <p className="text-text-secondary">
              Catalog item:{" "}
              <span className="font-medium text-text-primary">
                {asset.price_book_item.name}
              </span>
            </p>
          )}
          {asset.notes && (
            <p className="mt-1 whitespace-pre-wrap text-text-secondary">
              {asset.notes}
            </p>
          )}
        </div>
      )}

      {/* Action buttons — per current state */}
      <div className="flex flex-col gap-2 border-b border-border px-4 py-3">
        {!retired && (
          <div className="flex gap-2">
            {asset.assigned_user ? (
              <>
                <Button
                  onClick={() => onAction("transfer")}
                  size="sm"
                  className="flex-1"
                >
                  <ArrowRightLeft className="h-3 w-3" />
                  Transfer
                </Button>
                <Button
                  onClick={() => onAction("return")}
                  variant="outline"
                  tone="neutral"
                  size="sm"
                  className="flex-1"
                >
                  <Undo2 className="h-3 w-3" />
                  Return
                </Button>
              </>
            ) : (
              <Button
                onClick={() => onAction("assign")}
                size="sm"
                className="flex-1"
              >
                <UserPlus className="h-3 w-3" />
                Assign
              </Button>
            )}
          </div>
        )}
        <div className="flex gap-2">
          <Button
            onClick={() => onAction("note")}
            variant="outline"
            tone="neutral"
            size="sm"
            className="flex-1"
          >
            <StickyNote className="h-3 w-3" />
            Add note
          </Button>
          <Button
            onClick={onEdit}
            variant="outline"
            tone="neutral"
            size="sm"
            className="flex-1"
          >
            <Pencil className="h-3 w-3" />
            Edit
          </Button>
          {!retired && (
            <Button
              onClick={() => onAction("retire")}
              aria-label="Retire asset"
              title="Retire asset"
              variant="outline"
              tone="danger"
              size="sm"
            >
              <ArchiveX className="h-3.5 w-3.5" />
            </Button>
          )}
        </div>
      </div>

      {/* Event timeline */}
      <div className="px-4 py-3">
        {/* Raw by design: bracket size text-[10px] has no matching Heading scale key. */}
        <h3 className="text-[10px] font-semibold uppercase tracking-wide text-text-secondary">
          History
        </h3>
        <ul className="mt-2 space-y-2">
          {eventsQuery.isLoading ? (
            <li className="text-xs text-text-secondary">Loading history…</li>
          ) : events.length === 0 ? (
            <li>
              <EmptyState density="flush" title="No history yet — it starts with the first assign." />
            </li>
          ) : (
            events.map((ev) => (
              <li key={ev.id} className="flex items-start gap-2 text-xs">
                <span
                  className={`mt-0.5 inline-block h-2 w-2 flex-shrink-0 rounded-full ${EVENT_DOT[ev.type]}`}
                />
                <div className="min-w-0 flex-1">
                  <p className="font-medium text-text-primary">
                    {EVENT_LABEL[ev.type]}
                    {ev.user && (
                      <>
                        {" "}
                        · {ev.user.first_name} {ev.user.last_name}
                      </>
                    )}
                  </p>
                  {ev.note && (
                    <p className="whitespace-pre-wrap text-[11px] text-text-secondary">
                      {ev.note}
                    </p>
                  )}
                  <p className="text-[10px] text-text-secondary">
                    by{" "}
                    {ev.by_user
                      ? `${ev.by_user.first_name} ${ev.by_user.last_name}`
                      : "Unknown user"}{" "}
                    ·{" "}
                    {new Date(ev.at).toLocaleString('en-US', {
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
    </aside>
  );
}
