import type React from "react";
import { useEffect, useRef, useState } from "react";
import {
  AlertTriangle,
  ArrowRight,
  Calendar,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Clock,
  Eye,
  FileText,
  MapPin,
  Package,
  PackageCheck,
  Plus,
  Send,
  Truck,
  User,
} from "lucide-react";
import { CreateStageDialog } from "@/components/inventory/CreateStageDialog";
import { StageDetailDialog } from "@/components/inventory/StageDetailDialog";
import { POPreviewDialog } from "@/components/inventory/POPreviewDialog";
import { StagingAreaPicker } from "@/components/inventory/StagingAreaPicker";
// Data via the seam (mock-backed today, /api/inventory/* in Track 2).
import {
  tradeColor,
  useJobStages,
  usePurchaseOrders,
  useVendors,
  useReceiveStageLine,
  useNotifyTechReady,
} from "@/lib/api/inventory";
import type {
  JobStage,
  StageAuditEntry,
  Location,
  PurchaseOrder,
} from "@/lib/api/inventory";
// `StagingStatus` and `stageProgress` are not re-exported by the seam
// (`lib/api/inventory.ts`) yet - see `concerns`. The type is imported
// type-only from `_mock` (allowed by the port rules when the seam lacks a
// needed type); the pure helper is reproduced locally below so we never
// import a runtime value from `_mock`. Status badge rendering goes through
// the shared StatusBadge/status-registry instead.
import type { StagingStatus } from "@/lib/api/_mock/inventory";
import { useAuthStore } from "@/stores/auth.store";
import { extractApiError } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Heading } from "@/components/ui/heading";
import { StatusBadge } from "@/components/data/status-badge";
import { KpiTile } from "@/components/data/KpiStrip";
import { formatExactDay } from "@/lib/format-date";

// Local copy of the seam helper until it is re-exported (see `concerns`).
// `stageProgress` is verbatim-pure. (Status badge rendering now goes through
// the shared StatusBadge/status-registry instead of a local helper.)
function stageProgress(s: JobStage): {
  received: number;
  ordered: number;
  pct: number;
} {
  const received = s.items.reduce((sum, i) => sum + i.qtyReceived, 0);
  const ordered = s.items.reduce((sum, i) => sum + i.qtyOrdered, 0);
  return {
    received,
    ordered,
    pct: ordered === 0 ? 0 : Math.round((received / ordered) * 100),
  };
}

/**
 * Receive failures carry a machine code in `error` and the operator-facing
 * sentence in `message` (NO_STOCK_LOCATION, OVER_RECEIVE). `extractApiError`
 * prefers `error`, which would put the raw code in the toast, so read `message`
 * first and fall back to the shared helper for everything else.
 */
function receiveErrorMessage(err: unknown): string {
  const message = (err as { response?: { data?: { message?: string } } })?.response?.data?.message;
  return message ?? extractApiError(err, "Could not record that receipt - try again.");
}

type Props = {
  locations: Location[];
  onToast: (msg: string) => void;
  // Forwarded from InventoryPage when the TopBar bell fires a staging_*
  // intent. The `nonce` changes on every click so the effect re-runs even
  // when the same id is re-clicked.
  pendingIntent?: { id: string; nonce: number } | null;
};

const filterTabs: { value: StagingStatus | "all"; label: string }[] = [
  { value: "all", label: "All Stages" },
  { value: "awaiting", label: "Awaiting" },
  { value: "partial", label: "Partial" },
  { value: "complete", label: "Ready" },
  { value: "ready_for_pickup", label: "Ready for pickup" },
];

export function StagingView({ locations, onToast, pendingIntent }: Props) {
  // Live data from the seam. Local `stages` mirrors the query result so the
  // prototype's in-memory receive / mark-ready / staging-area edits stay
  // responsive (mock mutations resolve without persisting — a refetch returns
  // the original seed, faithful to "see it combined").
  const { data: seedStages = [] } = useJobStages();
  const { data: purchaseOrders = [] } = usePurchaseOrders();
  const { data: allVendors = [] } = useVendors();
  const receiveStageLine = useReceiveStageLine();
  const notifyTechReady = useNotifyTechReady();

  // Actor identity for audit entries comes from the ALPHA auth store
  // (replaces Emanuel's `currentUser` from the deleted `data/current-user`).
  const authUser = useAuthStore((s) => s.user);
  const actorName = authUser
    ? `${authUser.first_name} ${authUser.last_name}`.trim()
    : "Unknown user";

  const [stages, setStages] = useState<JobStage[]>(seedStages);
  // Re-seed local state when the query data arrives / changes.
  useEffect(() => {
    setStages(seedStages);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [seedStages]);

  const [filter, setFilter] = useState<StagingStatus | "all">("all");
  const [expandedId, setExpandedId] = useState<string | null>(stages[0]?.id ?? null);
  const [detailId, setDetailId] = useState<string | null>(null);
  const detailStage = stages.find((s) => s.id === detailId) ?? null;

  // Bell-driven open: when InventoryPage forwards a staging_* intent, open
  // StageDetailDialog by id. The `nonce` ensures the effect re-fires for
  // repeat clicks. Per PRD §5.4.A.ix v2.
  useEffect(() => {
    if (!pendingIntent) return;
    setDetailId(pendingIntent.id);
  }, [pendingIntent?.id, pendingIntent?.nonce]);
  const [showCreate, setShowCreate] = useState(false);
  const [prefilledPO, setPrefilledPO] = useState<PurchaseOrder | null>(null);
  const [showPOPicker, setShowPOPicker] = useState(false);
  const [previewPONumber, setPreviewPONumber] = useState<string | null>(null);
  const poPickerRef = useRef<HTMLDivElement>(null);

  // Close PO picker on outside click / Esc
  useEffect(() => {
    if (!showPOPicker) return;
    function onDoc(e: MouseEvent) {
      if (poPickerRef.current && !poPickerRef.current.contains(e.target as Node)) {
        setShowPOPicker(false);
      }
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setShowPOPicker(false);
    }
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, [showPOPicker]);

  // POs already staged (or fully received) are excluded from the picker
  const stagedPONumbers = new Set(
    stages.flatMap((s) => s.items.map((i) => i.poNumber)),
  );
  const availablePOs = purchaseOrders.filter(
    (po) =>
      !po.stagedAsJobStageId &&
      !stagedPONumbers.has(po.poNumber) &&
      po.status !== "received" &&
      po.status !== "closed",
  );

  const filtered =
    filter === "all" ? stages : stages.filter((s) => s.status === filter);

  function counts(s: StagingStatus | "all") {
    if (s === "all") return stages.length;
    return stages.filter((x) => x.status === s).length;
  }

  function markReady(id: string) {
    const stage = stages.find((s) => s.id === id);
    setStages((prev) =>
      prev.map((s) =>
        s.id === id
          ? {
              ...s,
              status:
                s.status === "ready_for_pickup" ? "delivered" : "ready_for_pickup",
            }
          : s,
      ),
    );
    // Mock mutation: notifies the tech that a stage is ready for pickup.
    notifyTechReady.mutate({ stageId: id });
    onToast(
      stage?.status === "ready_for_pickup"
        ? `✓ ${stage?.jobNumber} marked delivered`
        : `✓ ${stage?.jobNumber} marked ready for pickup · tech notified`,
    );
  }

  /**
   * Update the staging area (zone within the warehouse) for a stage. Used by
   * the inline StagingAreaPicker on the stage card so warehouse staff can
   * tell techs exactly where in the building the parts are sitting once the
   * stage is complete. Every pick / change / clear is recorded in the
   * stage's audit log (rev 2026-05-26) so the activity feed shows who put
   * the parts where, and when.
   */
  function setStagedArea(id: string, next: string | undefined) {
    let toastJob: string | undefined;
    let toastArea: string | undefined;
    setStages((prev) =>
      prev.map((s) => {
        if (s.id !== id) return s;
        toastJob = s.jobNumber;
        toastArea = next;
        // Skip the audit entry if nothing actually changed (defensive — UI
        // shouldn't fire the callback when picking the same value, but
        // belt-and-suspenders).
        if ((s.stagedArea ?? undefined) === (next ?? undefined)) {
          return { ...s, stagedArea: next };
        }
        const entry: StageAuditEntry = {
          id: `aud_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
          at: new Date().toISOString(),
          actorName,
          field: "stagedArea",
          oldValue: s.stagedArea,
          newValue: next ?? "(cleared)",
          comment: next
            ? s.stagedArea
              ? `Moved from "${s.stagedArea}" to "${next}"`
              : `Placed in "${next}"`
            : `Cleared (was "${s.stagedArea ?? "—"}")`,
        };
        return {
          ...s,
          stagedArea: next,
          updatedAt: new Date().toISOString(),
          auditLog: [...(s.auditLog ?? []), entry],
        };
      }),
    );
    if (toastJob) {
      if (toastArea) {
        onToast(`📍 ${toastJob} staged in ${toastArea}`);
      } else {
        onToast(`📍 ${toastJob} staging area cleared`);
      }
    }
  }

  function receiveOne(stageId: string, itemId: string) {
    // Snapshot for the rollback below - the optimistic write lands first so the
    // counter feels instant, but a rejected receive must not leave the UI
    // claiming parts arrived.
    const before = stages;
    setStages((prev) =>
      prev.map((s) => {
        if (s.id !== stageId) return s;
        const items = s.items.map((it) =>
          it.id === itemId
            ? { ...it, qtyReceived: Math.min(it.qtyOrdered, it.qtyReceived + 1) }
            : it,
        );
        const allIn = items.every((i) => i.qtyReceived >= i.qtyOrdered);
        const anyIn = items.some((i) => i.qtyReceived > 0);
        const newStatus: StagingStatus = allIn
          ? "complete"
          : anyIn
            ? "partial"
            : "awaiting";
        return { ...s, items, status: newStatus };
      }),
    );
    // Records a single-unit receipt against the stage line. On rejection (e.g.
    // NO_STOCK_LOCATION when the org has no inventory location configured) roll
    // the optimistic write back and surface the server's own message.
    receiveStageLine.mutate(
      { stageId, itemId },
      {
        onError: (err) => {
          setStages(before);
          onToast(`⚠ ${receiveErrorMessage(err)}`);
        },
      },
    );
  }

  const totals = {
    stages: stages.length,
    awaiting: counts("awaiting"),
    partial: counts("partial"),
    complete: counts("complete"),
    ready: counts("ready_for_pickup"),
  };

  return (
    <div className="flex flex-1 flex-col overflow-hidden">
      {/* Header strip */}
      <div className="border-b border-border bg-surface-light px-6 py-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <div className="flex items-center gap-2 text-xs text-text-secondary">
              <span>Operations</span>
              <ChevronRight className="h-3 w-3" />
              <span>Inventory</span>
              <ChevronRight className="h-3 w-3" />
              <span className="font-medium text-text-primary">Staging</span>
            </div>
            {/* tracking-tight dropped: Heading has no letter-spacing axis (heading.tsx
                header comment, "NOT COVERED, DELIBERATELY"). mt-1 kept, it's layout. */}
            <Heading className="mt-1">Job Staging</Heading>
            <p className="mt-0.5 text-sm text-text-secondary">
              Track parts received for specific jobs · partial shipments + backorders + ready-for-pickup.
            </p>
          </div>
          <div className="flex items-center gap-2">
            <div className="relative" ref={poPickerRef}>
              {/* Not converted to Button: two-state (open/closed) trigger with
                  its own active-state bg/border, no matching cell. */}
              <button
                onClick={() => setShowPOPicker((o) => !o)}
                className={[
                  "inline-flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-sm font-medium transition",
                  showPOPicker
                    ? "border-primary/40 bg-primary-subtle text-primary"
                    : "border-border bg-surface-light text-text-secondary hover:bg-background-light",
                ].join(" ")}
              >
                <FileText className="h-4 w-4 text-primary" />
                From PO
                <span className="rounded-full bg-primary px-1.5 py-0.5 text-[10px] font-bold text-on-fill">
                  {availablePOs.length}
                </span>
                <ChevronDown
                  className={[
                    "h-3.5 w-3.5 text-text-secondary transition",
                    showPOPicker ? "rotate-180" : "",
                  ].join(" ")}
                />
              </button>
              {showPOPicker && (
                <div className="absolute right-0 top-full z-30 mt-1.5 w-[460px] max-w-[calc(100vw-1.5rem)] overflow-hidden rounded-card border border-border bg-surface-light shadow-xl">
                  <div className="border-b border-border px-3 py-2">
                    <p className="text-sm font-semibold text-text-primary">
                      Open logistics orders
                    </p>
                    <p className="text-[11px] text-text-secondary">
                      Pick a PO to pre-fill a new staging pickup
                    </p>
                  </div>
                  <div className="max-h-[420px] overflow-y-auto py-1">
                    {availablePOs.length === 0 ? (
                      <div className="px-4 py-6 text-center text-xs text-text-secondary">
                        All open POs are already staged 🎉
                      </div>
                    ) : (
                      availablePOs.map((po) => {
                        const qty = po.lines.reduce(
                          (s, l) => s + l.qtyOrdered,
                          0,
                        );
                        return (
                          <div
                            key={po.id}
                            className="flex w-full flex-col gap-1 border-t border-border/60 px-3 py-2.5 text-left hover:bg-primary-subtle/40"
                          >
                            <div className="flex items-center justify-between gap-2">
                              <div
                                className="flex flex-1 items-center gap-2 cursor-pointer"
                                onClick={() => {
                                  setPrefilledPO(po);
                                  setShowCreate(true);
                                  setShowPOPicker(false);
                                }}
                              >
                                <code className="rounded bg-primary-subtle px-1.5 py-0.5 font-mono text-[11px] font-semibold text-primary">
                                  {po.poNumber}
                                </code>
                                <span className="text-sm font-semibold text-text-primary">
                                  {po.vendor}
                                </span>
                              </div>
                              {/* Not converted to Button: outline/neutral sets
                                  no idle text colour (button.tsx's own header
                                  note), and this row's ambient wrapper sets
                                  none either - the raw's text-secondary would
                                  silently fall through to near-black. */}
                              <button
                                type="button"
                                onClick={(e) => {
                                  e.stopPropagation();
                                  setShowPOPicker(false);
                                  setPreviewPONumber(po.poNumber);
                                }}
                                className="inline-flex items-center gap-1 rounded-md border border-border bg-surface-light px-1.5 py-0.5 text-[10px] font-semibold text-text-secondary hover:bg-background-light"
                                title="Preview PO as PDF · print"
                              >
                                <Eye className="h-2.5 w-2.5 text-primary" />
                                Preview
                              </button>
                              <span className="rounded-full bg-background-light px-1.5 py-0.5 text-[10px] font-mono font-semibold text-text-secondary">
                                {po.lines.length} lines · {qty} units
                              </span>
                            </div>
                            {po.customer && (
                              <div className="flex items-center gap-1 text-xs text-text-secondary">
                                <Package className="h-3 w-3 text-text-secondary" />
                                <span className="font-medium">
                                  {po.jobNumber}
                                </span>
                                <span className="text-text-secondary">·</span>
                                <span>{po.customer}</span>
                              </div>
                            )}
                            {po.expectedDate && (
                              <div className="flex items-center gap-1 text-[11px] text-warning">
                                <Clock className="h-3 w-3" />
                                ETA{" "}
                                {formatExactDay(po.expectedDate, {
                                  weekday: "short",
                                  month: "short",
                                  day: "numeric",
                                })}
                              </div>
                            )}
                            {!po.customer && (
                              <div className="text-[11px] italic text-text-secondary">
                                No job linked · pick a job during staging
                              </div>
                            )}
                          </div>
                        );
                      })
                    )}
                  </div>
                </div>
              )}
            </div>
            <Button size="sm"
              onClick={() => {
                setPrefilledPO(null);
                setShowCreate(true);
              }}
            >
              <Plus className="h-4 w-4" />
              New Pickup
            </Button>
          </div>
        </div>

        {/* Quick stats */}
        <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-5">
          <KpiTile
            icon={Package}
            label="Active Stages"
            value={totals.stages}
            tone="strong"
            active={filter === "all"}
            onClick={() => setFilter("all")}
          />
          <KpiTile
            icon={Clock}
            label="Awaiting"
            value={totals.awaiting}
            tone="neutral"
            active={filter === "awaiting"}
            onClick={() => setFilter("awaiting")}
          />
          <KpiTile
            icon={Truck}
            label="Partial"
            value={totals.partial}
            tone="warning"
            active={filter === "partial"}
            onClick={() => setFilter("partial")}
          />
          <KpiTile
            icon={CheckCircle2}
            label="Ready"
            value={totals.complete}
            tone="success"
            active={filter === "complete"}
            onClick={() => setFilter("complete")}
          />
          <KpiTile
            icon={Send}
            label="Ready for pickup"
            value={totals.ready}
            tone="primary"
            active={filter === "ready_for_pickup"}
            onClick={() => setFilter("ready_for_pickup")}
          />
        </div>
      </div>

      {/* Filter chips */}
      <div className="flex items-center gap-2 overflow-x-auto border-b border-border bg-surface-light px-6 py-2.5">
        <span className="text-xs font-semibold uppercase tracking-wide text-text-secondary">
          Filter
        </span>
        {filterTabs.map((t) => {
          const active = filter === t.value;
          const c = counts(t.value);
          return (
            // Not converted to Button: segmented filter-tab control, not a
            // Button shape.
            <button
              key={t.value}
              onClick={() => setFilter(t.value)}
              className={[
                "inline-flex items-center gap-1.5 whitespace-nowrap rounded-full px-3 py-1 text-xs font-medium transition",
                active
                  ? "bg-primary text-on-fill"
                  : "bg-background-light text-text-secondary hover:bg-border/60",
              ].join(" ")}
            >
              {t.label}
              <span
                className={[
                  "rounded-full px-1.5 text-[10px] font-semibold",
                  active ? "bg-on-fill/30 text-on-fill" : "bg-surface-light text-text-secondary",
                ].join(" ")}
              >
                {c}
              </span>
            </button>
          );
        })}
      </div>

      {/* Stage cards */}
      <div className="flex-1 overflow-y-auto bg-background-light px-6 py-4">
        <div className="space-y-3">
          {filtered.length === 0 && (
            <div className="rounded-card border border-dashed border-border bg-surface-light px-6 py-12 text-center">
              <p className="text-sm text-text-secondary">
                No staged jobs match this filter.
              </p>
              <Button
                onClick={() => setShowCreate(true)}
                size="sm"
                className="mt-3"
              >
                <Plus className="h-3.5 w-3.5" />
                Create New Pickup
              </Button>
            </div>
          )}
          {filtered.map((stage) => (
            <StageCard
              key={stage.id}
              stage={stage}
              locations={locations}
              vendors={allVendors}
              expanded={expandedId === stage.id}
              onToggle={() =>
                setExpandedId(expandedId === stage.id ? null : stage.id)
              }
              onMarkReady={() => markReady(stage.id)}
              onReceiveOne={(itemId) => receiveOne(stage.id, itemId)}
              onOpenDetail={() => setDetailId(stage.id)}
              onPreviewPO={(poNumber) => setPreviewPONumber(poNumber)}
              onChangeStagedArea={(next) => setStagedArea(stage.id, next)}
            />
          ))}
        </div>
      </div>

      <StageDetailDialog
        open={!!detailStage}
        onClose={() => setDetailId(null)}
        stage={detailStage}
        locations={locations}
        onReceiveOne={(stageId, itemId) => receiveOne(stageId, itemId)}
        onSave={(updated, audit) => {
          setStages((prev) =>
            prev.map((s) => (s.id === updated.id ? updated : s)),
          );
          onToast(
            `✓ ${updated.jobNumber} updated · ${audit.length} change${audit.length === 1 ? "" : "s"} logged to audit trail`,
          );
        }}
        onEmailSent={(s, to) => {
          onToast(
            `✉ Pickup ticket for ${s.jobNumber} sent to ${to.length} recipient${to.length === 1 ? "" : "s"} · ${to[0]}${to.length > 1 ? ` +${to.length - 1}` : ""}`,
          );
        }}
      />

      <CreateStageDialog
        open={showCreate}
        onClose={() => {
          setShowCreate(false);
          setPrefilledPO(null);
        }}
        locations={locations}
        prefilledFromPO={prefilledPO}
        onCreate={(stage) => {
          // Local view only - CreateStageDialog owns the POST. Firing the
          // mutation here too wrote every stage to the database TWICE (both
          // calls resolved as no-ops under the old USE_MOCK seam, so the
          // duplicate only became visible once Track 2 flipped to the real API).
          setStages((prev) => [stage, ...prev]);
          setExpandedId(stage.id);
          setFilter("all");
          const fromPO = prefilledPO?.poNumber;
          onToast(
            fromPO
              ? `✓ Staging created for ${stage.jobNumber} from ${fromPO} · ${stage.items.length} line${stage.items.length === 1 ? "" : "s"}`
              : `✓ Pickup created for ${stage.jobNumber} · ${stage.items.length} line item${stage.items.length === 1 ? "" : "s"} ordered`,
          );
        }}
      />

      <POPreviewDialog
        open={!!previewPONumber}
        onClose={() => setPreviewPONumber(null)}
        poNumber={previewPONumber}
        onEmailSent={({ poNumber, to }) => {
          onToast(
            `✉ PO ${poNumber} emailed to ${to.length} recipient${to.length === 1 ? "" : "s"} · ${to[0]}${to.length > 1 ? ` +${to.length - 1}` : ""}`,
          );
        }}
      />
    </div>
  );
}

function StageCard({
  stage,
  locations,
  vendors,
  expanded,
  onToggle,
  onMarkReady,
  onReceiveOne,
  onOpenDetail,
  onPreviewPO,
  onChangeStagedArea,
}: {
  stage: JobStage;
  locations: Location[];
  vendors: { id: string; name: string }[];
  expanded: boolean;
  onToggle: () => void;
  onMarkReady: () => void;
  onReceiveOne: (itemId: string) => void;
  onOpenDetail: () => void;
  onPreviewPO: (poNumber: string) => void;
  onChangeStagedArea?: (next: string | undefined) => void;
}) {
  const { received, ordered, pct } = stageProgress(stage);
  const stagedLoc = locations.find((l) => l.id === stage.stagedLocationId);
  const isReady = stage.status === "complete" || stage.status === "ready_for_pickup";
  const tradeTint =
    stage.trade === "multi"
      ? "bg-info/10 text-info ring-info/20"
      : tradeColor[stage.trade];

  // Clicking the job# or customer name jumps straight to Full Transaction
  // (Stage Detail Dialog) — avoids the extra step of expanding the accordion
  // and hunting for "Open Full Transaction" in the footer.
  const openDetailFromHeader = (e: React.MouseEvent) => {
    e.stopPropagation();
    onOpenDetail();
  };

  return (
    <div className="overflow-hidden rounded-card border border-border bg-surface-light shadow-sm">
      {/* Card head */}
      <div
        role="button"
        tabIndex={0}
        onClick={onToggle}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            onToggle();
          }
        }}
        className="flex w-full items-start gap-3 px-4 py-3 text-left transition hover:bg-background-light cursor-pointer"
      >
        <ChevronDown
          className={[
            "mt-0.5 h-4 w-4 flex-shrink-0 text-text-secondary transition",
            expanded ? "" : "-rotate-90",
          ].join(" ")}
        />
        <div className="flex flex-1 flex-col gap-1.5">
          <div className="flex flex-wrap items-center gap-2">
            {/* Not converted to Button: bg-primary-subtle font-mono
                chip/badge acting as a link, no matching cell. */}
            <button
              type="button"
              onClick={openDetailFromHeader}
              className="rounded bg-primary-subtle px-1.5 py-0.5 font-mono text-[11px] font-semibold text-primary hover:bg-primary/20 hover:underline focus:outline-none focus:ring-2 focus:ring-primary/30"
              title="Open Full Transaction"
            >
              {stage.jobNumber}
            </button>
            {/* Not converted to Button: idle-neutral/hover-brand text link,
                no matching cell (link/brand is always brand at idle). */}
            <button
              type="button"
              onClick={openDetailFromHeader}
              className="rounded text-left text-sm font-semibold text-text-primary hover:text-primary hover:underline focus:outline-none focus:ring-2 focus:ring-primary/30"
              title="Open Full Transaction"
            >
              {stage.customer}
            </button>
            <span
              className={`rounded-full px-2 py-0.5 text-[10px] font-medium capitalize ring-1 ${tradeTint}`}
            >
              {stage.trade === "multi" ? "Multi-trade" : stage.trade}
            </span>
            <StatusBadge domain="stage" status={stage.status} />
          </div>
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-text-secondary">
            <span className="flex items-center gap-1">
              <MapPin className="h-3 w-3" />
              {stage.site}
            </span>
            {stage.assignedTech && (
              <span className="flex items-center gap-1">
                <User className="h-3 w-3" />
                {stage.assignedTech}
              </span>
            )}
            {stage.scheduledFor && (
              <span className="flex items-center gap-1">
                <Calendar className="h-3 w-3" />
                {new Date(stage.scheduledFor).toLocaleString(undefined, {
                  weekday: "short",
                  month: "short",
                  day: "numeric",
                  hour: "2-digit",
                  minute: "2-digit",
                })}
              </span>
            )}
            {stage.pickupVendorId ? (
              <span className="flex items-center gap-1 text-primary">
                <Package className="h-3 w-3" />
                Pickup at{" "}
                {vendors.find((v) => v.id === stage.pickupVendorId)?.name ??
                  "Vendor"}
                {stage.pickupAddress ? ` · ${stage.pickupAddress.slice(0, 48)}` : ""}
              </span>
            ) : stagedLoc ? (
              <span className="flex items-center gap-1">
                <Package className="h-3 w-3" />
                Staged at {stagedLoc.name}
                {stage.stagedArea && (
                  <span className="font-medium text-primary">
                    {" · "}
                    {stage.stagedArea}
                  </span>
                )}
              </span>
            ) : null}
          </div>
        </div>
        <div className="ml-2 flex w-44 flex-shrink-0 flex-col items-end gap-1">
          <div className="flex items-baseline gap-1.5">
            <span className="font-mono text-sm font-semibold text-text-primary">
              {received}
            </span>
            <span className="text-xs text-text-secondary">/ {ordered}</span>
            <span className="text-[10px] text-text-secondary">received</span>
          </div>
          <div className="h-1.5 w-full overflow-hidden rounded-full bg-background-light">
            <div
              className={[
                "h-full transition-all",
                pct === 100
                  ? "bg-success"
                  : pct >= 50
                    ? "bg-warning"
                    : pct > 0
                      ? "bg-warning/60"
                      : "bg-border",
              ].join(" ")}
              style={{ width: `${pct}%` }}
            />
          </div>
          <span className="text-[10px] font-medium text-text-secondary">{pct}% complete</span>
        </div>
      </div>

      {/* Expanded body */}
      {expanded && (
        <div className="border-t border-border bg-background-light/30">
          {/* Items list */}
          <div className="px-4 py-3">
            {/* Raw by design: bracket size text-[10px] has no matching Heading scale key. */}
            <h3 className="mb-2 text-[10px] font-semibold uppercase tracking-wider text-text-secondary">
              Line items
            </h3>
            <div className="overflow-hidden rounded-md border border-border bg-surface-light">
              {stage.items.map((it, idx) => {
                const remaining = it.qtyOrdered - it.qtyReceived;
                const itemDone = remaining === 0;
                return (
                  <div
                    key={it.id}
                    className={[
                      "grid grid-cols-[1fr_auto_auto] items-center gap-3 px-3 py-2.5",
                      idx > 0 ? "border-t border-border/60" : "",
                    ].join(" ")}
                  >
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <code className="font-mono text-[10px] text-text-secondary">
                          {it.itemSku}
                        </code>
                        {it.serialized && (
                          <span className="rounded-full bg-primary-subtle px-1.5 py-0 text-[9px] font-medium text-primary ring-1 ring-primary/20">
                            serialized
                          </span>
                        )}
                      </div>
                      <p className="truncate text-sm font-medium text-text-primary">
                        {it.itemName}
                      </p>
                      <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px] text-text-secondary">
                        <span>{it.vendor}</span>
                        <span>·</span>
                        <Button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            onPreviewPO(it.poNumber);
                          }}
                          variant="link"
                          size={null}
                          title="Preview PO as PDF · print"
                        >
                          <Eye className="h-2.5 w-2.5" />
                          {it.poNumber}
                        </Button>
                        {!itemDone && it.expectedDate && (
                          <>
                            <span>·</span>
                            <span className="inline-flex items-center gap-0.5 text-warning">
                              <Clock className="h-3 w-3" />
                              ETA {formatExactDay(it.expectedDate, {
                                month: "short",
                                day: "numeric",
                              })}
                            </span>
                          </>
                        )}
                      </div>
                    </div>

                    {/* Qty progress */}
                    <div className="flex flex-col items-end gap-0.5 font-mono text-xs">
                      <div className="flex items-baseline gap-1">
                        <span
                          className={[
                            "font-semibold",
                            itemDone ? "text-success" : "text-warning",
                          ].join(" ")}
                        >
                          {it.qtyReceived}
                        </span>
                        <span className="text-text-secondary">/ {it.qtyOrdered}</span>
                        <span className="text-[10px] text-text-secondary">{it.uom}</span>
                      </div>
                      {remaining > 0 && (
                        <span className="flex items-center gap-0.5 text-[10px] font-medium text-warning">
                          <AlertTriangle className="h-2.5 w-2.5" />
                          {remaining} backordered
                        </span>
                      )}
                      {itemDone && (
                        <span className="inline-flex items-center gap-0.5 text-[10px] font-medium text-success">
                          <CheckCircle2 className="h-2.5 w-2.5" />
                          Complete
                        </span>
                      )}
                    </div>

                    {/* Receive +1 action */}
                    {!itemDone ? (
                      // Not converted to Button: success-tinted action, no
                      // `success` tone is minted.
                      <button
                        onClick={() => onReceiveOne(it.id)}
                        className="rounded-md border border-success/20 bg-success/10 px-2 py-1 text-xs font-semibold text-success hover:bg-success/10"
                        title="Receive 1 more unit (simulate partial delivery)"
                      >
                        Receive +1
                      </button>
                    ) : (
                      <span className="rounded-md px-2 py-1 text-xs text-text-secondary">—</span>
                    )}
                  </div>
                );
              })}
            </div>
          </div>

          {/* Staging area picker — surfaces once the stage has anything to
              place on the shelf (complete / ready / delivered). Lets the
              warehouse manager pin the exact zone within the warehouse so
              the tech knows where to go on pickup. Vendor-pickup stages
              don't need this (no in-house parts to place). */}
          {!stage.pickupVendorId && stagedLoc && (
            <div className="flex flex-wrap items-center justify-between gap-2 border-t border-border bg-primary-subtle/30 px-4 py-2">
              <div className="flex items-center gap-2 text-xs text-text-secondary">
                <MapPin className="h-3.5 w-3.5 text-primary" />
                <span className="font-semibold uppercase tracking-wide text-[10px] text-text-secondary">
                  Staging area in {stagedLoc.name}
                </span>
                {!stage.stagedArea && isReady && (
                  <span className="rounded-full bg-warning/10 px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wide text-warning ring-1 ring-warning/20">
                    Tell the tech where
                  </span>
                )}
              </div>
              {onChangeStagedArea ? (
                <StagingAreaPicker
                  parentLocation={stagedLoc}
                  value={stage.stagedArea}
                  onChange={onChangeStagedArea}
                />
              ) : (
                <span className="text-xs text-text-secondary">
                  {stage.stagedArea ?? "—"}
                </span>
              )}
            </div>
          )}

          {/* Notes + actions */}
          <div className="flex flex-wrap items-center justify-between gap-2 border-t border-border bg-surface-light px-4 py-3">
            <div className="flex-1 text-xs text-text-secondary">
              {stage.notes && <p>📝 {stage.notes}</p>}
              {!stage.notes && (
                <p className="text-text-secondary">No notes</p>
              )}
            </div>
            <div className="flex flex-wrap items-center gap-2">
              {stage.status === "complete" && (
                <Button onClick={onMarkReady} size="sm">
                  <Send className="h-3 w-3" />
                  Notify Tech · Ready for Pickup
                </Button>
              )}
              {stage.status === "ready_for_pickup" && (
                // Not converted to Button: bg-success solid action, no
                // `success` tone is minted.
                <button
                  onClick={onMarkReady}
                  className="inline-flex items-center gap-1.5 rounded-md bg-success px-3 py-1.5 text-xs font-semibold text-on-fill hover:bg-success"
                >
                  <Truck className="h-3 w-3" />
                  Mark Delivered to Tech
                </button>
              )}
              {(stage.status === "awaiting" || stage.status === "partial") && (
                <span className="inline-flex items-center gap-1 text-xs text-text-secondary">
                  <Clock className="h-3 w-3" />
                  Awaiting remaining vendor deliveries
                </span>
              )}
              {isReady && (
                <span className="inline-flex items-center gap-1 text-xs font-medium text-success">
                  <PackageCheck className="h-3 w-3" />
                  Held together as a single dispatch
                </span>
              )}
              <ArrowRight className="h-3 w-3 text-border" />
              {/* Not converted to Button: an outline action colored
                  border-primary and text-primary, no outline/brand cell is
                  minted. */}
              <button
                onClick={onOpenDetail}
                className="inline-flex items-center gap-1 rounded-md border border-primary/30 bg-surface-light px-2 py-1 text-xs font-semibold text-primary hover:bg-primary-subtle"
              >
                Open Full Transaction
              </button>
              <Button type="button" variant="link" size={null}>
                Open Job →
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
