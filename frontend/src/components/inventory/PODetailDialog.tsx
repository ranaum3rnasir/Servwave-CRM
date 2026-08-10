import type React from "react";
import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import {
  Activity,
  CheckCircle2,
  ChevronRight,
  Eye,
  FileText,
  Mail,
  PackageCheck,
  RotateCcw,
  Send,
  Truck,
} from "lucide-react";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Modal } from "@/components/ui/modal";
import { Input } from "@/components/ui/input";
import { EmptyState } from "@/components/ui/empty-state";
import { formatCurrency } from "@/lib/utils";
import { formatExactDay } from "@/lib/format-date";
import { POPreviewDialog } from "@/components/inventory/POPreviewDialog";
import { POEmailDialog } from "@/components/inventory/POEmailDialog";
import { useLocations, useUpdatePO, usePOActivity } from "@/lib/api/inventory";
import { useOrganization } from "@/lib/api/organization";
import type { PurchaseOrder, POLine, POActivityEvent } from "@/lib/api/inventory";
import { Button } from "@/components/ui/button";
import {
  STATUS_INTENT_CLASSES,
  STATUS_REGISTRY,
} from "@/design-system/status-registry";
import { useConfirm } from "@/hooks/useConfirm";

/**
 * PODetailDialog — v0.1 (PRD §7.X.3, rev 2026-05-28).
 *
 * Opens when a PO row is clicked anywhere on the Purchase Orders page. Shows
 * the full PO information in a 4-tab body (Lines · Activity · Documents ·
 * 3-Way Match) with a status-adaptive footer action set.
 *
 * v0.1 scope (this rev): header summary + Lines tab (read-only table) + other
 * three tabs stubbed with what's coming + footer actions wiring Preview and
 * Email to the existing dialogs. Inline qty editing on the Received column,
 * activity timeline, and three-way match exception flow ship in subsequent
 * revs as the design spec is finalized.
 *
 * ALPHA port note: the Receive-mode commit calls the `onReceive` callback; the
 * parent Purchase Orders page persists it via `useReceivePO().mutate(payload)`
 * (lib/api/inventory.ts) and passes back the updated PO via the `po` prop.
 */

type Tab = "lines" | "activity" | "documents" | "match";

export type ReceiveSubmit = {
  poId: string;
  /** D14 — the receive destination, always sent by the dialog. */
  destinationLocationId: string;
  /** Identity by PO line id, not SKU (D2 — SKU may be blank/duplicate). */
  lines: { lineId: string; qtyReceived: number }[];
};

type Props = {
  open: boolean;
  onClose: () => void;
  po: PurchaseOrder | null;
  /** Called when the user saves a receive event from the Lines tab.
   *  Parent persists via lib/api/inventory.useReceivePO().mutate() and
   *  passes back the updated PO via the `po` prop so the dialog re-renders.
   */
  onReceive?: (event: ReceiveSubmit) => void;
};

const fmtMoney = formatCurrency;

function fmtDate(iso?: string): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

// expectedDate is a calendar day, not an instant, so it is read in UTC.
function fmtDay(iso?: string): string {
  if (!iso) return "—";
  return formatExactDay(iso, {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

export function PODetailDialog({ open, onClose, po, onReceive }: Props) {
  const { confirm, confirmDialog } = useConfirm();
  const [tab, setTab] = useState<Tab>("lines");
  const [showPreview, setShowPreview] = useState(false);
  const [showEmail, setShowEmail] = useState(false);
  const [emailedToast, setEmailedToast] = useState<string | null>(null);

  // ─── Receive destination (D14) ───
  // Same pattern as SyncStockDialog (incl. the 403-fallback single-option
  // branch). Re-seeded on enterReceive() to the ORG default — deliberately NOT
  // stockLocationMemory (that helper remembers deduction sources; the
  // receiving-dock default is the org's: "DEC3 becomes the default, not the rule").
  const locationsQuery = useLocations();
  const { data: org } = useOrganization();
  const updatePO = useUpdatePO();
  const [receiveDestId, setReceiveDestId] = useState("");

  // ─── Receive mode (Lines tab) ───
  // When receiving: rows show editable Received inputs + Receive +1/All
  // per-row, footer swaps to Cancel · Save Receipt. Draft state is held
  // in `receiveDraft` keyed by SKU; commit on Save calls onReceive().
  const [receiving, setReceiving] = useState(false);
  const [receiveDraft, setReceiveDraft] = useState<Record<string, number>>({});

  // Re-seed the draft from the current PO whenever the dialog opens or the PO
  // prop swaps — keyed on OBJECT identity: the parent passes back the server's
  // updated PO after a successful receive (a new object), which both re-seeds
  // the draft and exits receive mode. A failed receive changes nothing, so the
  // dialog stays in receive mode with the draft intact (§5b).
  useEffect(() => {
    if (!po) return;
    setReceiving(false);
    setReceiveDraft(
      Object.fromEntries(po.lines.map((l) => [l.id!, l.qtyReceived])),
    );
  }, [po, open]);

  if (!po) return null;

  const totalOrd = po.lines.reduce((s, l) => s + l.qtyOrdered, 0);
  const totalRec = po.lines.reduce((s, l) => s + l.qtyReceived, 0);
  // Real per-line unit costs (P2) — the server strips them for viewers without
  // pricing visibility, in which case each line falls back to $0 here and the
  // row renders "—" (see LineRow).
  const subtotal = po.lines.reduce(
    (s, l) => s + l.qtyOrdered * (l.unitCost ?? 0),
    0,
  );
  const total = subtotal; // D6: PO is tax-exclusive (subtotal-only), consistent with reports + email
  const pctReceived = totalOrd === 0 ? 0 : Math.round((totalRec / totalOrd) * 100);

  // Status chip resolves through the shared status registry, so the PO lifecycle
  // spells its meaning (label + intent) in exactly one place. The `??` fallback is
  // unreachable today - POStatus is 5/5 covered by STATUS_REGISTRY.purchaseOrder -
  // and exists only because tsconfig sets noUncheckedIndexedAccess.
  const statusEntry = STATUS_REGISTRY.purchaseOrder[po.status] ?? {
    label: po.status,
    intent: "neutral" as const,
  };
  const def = {
    label: statusEntry.label,
    // STATUS_INTENT_CLASSES ships a border colour token next to the
    // surface and text roles. It is INERT on this chip, deliberately: the chip
    // rendered below in the header summary card carries no `border` width class,
    // and Tailwind preflight zeroes every border to no width, so the colour never paints.
    // This chip has never had a hairline. DO NOT "fix" the inertness by adding a
    // `border` class - that would grow all five PO status chips by ~2px on each
    // axis and is a fresh, undecided appearance change on a surface that never
    // had a hairline to begin with.
    cls: STATUS_INTENT_CLASSES[statusEntry.intent],
  };

  // §3.6 single-receive-path: a staged PO receives via the Staging view ONLY.
  const staged = po.stagedAsJobStageId != null;

  // 403-fallback: without read Inventory the locations query errors — offer the
  // org default as the single option (SyncStockDialog's exact branch).
  const locations = locationsQuery.data ?? [];
  const fallbackDefaultId = org?.default_inventory_location_id ?? null;
  const usingFallback = locationsQuery.isError && locations.length === 0;
  const destOptions = usingFallback
    ? fallbackDefaultId
      ? [{ id: fallbackDefaultId, label: "Org default location" }]
      : []
    : locations.map((loc) => ({
        id: loc.id,
        label: `${loc.name}${loc.branch ? ` · ${loc.branch}` : ""}`,
      }));

  // Belt-and-braces over-receive guard (stale props can outrun the input clamp);
  // the server's 400 OVER_RECEIVE stays the authority.
  const overReceived = po.lines.filter(
    (l) => (receiveDraft[l.id!] ?? l.qtyReceived) > l.qtyOrdered,
  );

  // Enter receive mode: jump to Lines tab + flip receiving on. Unreachable for
  // staged POs (their primary action is disabled — defense in depth here).
  function enterReceive() {
    if (po!.stagedAsJobStageId != null) return;
    setTab("lines");
    setReceiving(true);
    setReceiveDestId(org?.default_inventory_location_id ?? "");
    setReceiveDraft(
      Object.fromEntries(po!.lines.map((l) => [l.id!, l.qtyReceived])),
    );
  }

  // D3: close a received PO (nothing open) or force-close a partial (confirm first).
  async function handleClose() {
    const openCount = po!.lines.filter((l) => l.qtyReceived < l.qtyOrdered).length;
    if (
      openCount > 0 &&
      !(await confirm({
        title: `${openCount} item(s) still open - close this PO anyway?`,
        confirmLabel: "Close anyway",
        tone: "danger",
      }))
    )
      return;
    updatePO.mutate({ id: po!.id, status: "closed" }, { onSuccess: () => onClose() });
  }

  // Status-adaptive primary action (PRD §7.X.3 footer matrix)
  const primaryAction = ((): {
    label: string;
    icon: React.ComponentType<{ className?: string }>;
    onClick?: () => void;
    disabled?: boolean;
  } | null => {
    switch (po.status) {
      case "draft":
        // P2 §3.8 — real send: opens the (now real) POEmailDialog; the status
        // flip to `sent` happens server-side on send.
        return { label: "Send to vendor", icon: Send, onClick: () => setShowEmail(true) };
      case "sent":
        return staged
          ? { label: "Received via Staging", icon: PackageCheck, disabled: true }
          : { label: "Receive items", icon: PackageCheck, onClick: enterReceive };
      case "partial":
        return staged
          ? { label: "Received via Staging", icon: PackageCheck, disabled: true }
          : { label: "Receive remaining", icon: PackageCheck, onClick: enterReceive };
      case "received":
        return { label: "Close PO", icon: CheckCircle2, onClick: handleClose };
      case "closed":
        return null;
    }
  })();

  return (
    <>
      <Modal
        open={open}
        onClose={onClose}
        size="xl"
        title={`${po.poNumber} · ${po.vendor}`}
        subtitle={
          po.customer
            ? `${po.jobNumber ? po.jobNumber + " · " : ""}${po.customer}${po.site ? " · " + po.site : ""}`
            : "No job link"
        }
        footer={
          receiving ? (
            // ─── Receive mode footer ───
            <div className="flex w-full items-center justify-between gap-2">
              <div className="text-[11px] text-text-secondary">
                <span className="font-semibold text-success">Receive mode</span>{" "}
                · adjust qty per line · stock auto-updates on save
                {overReceived[0] != null && (
                  <span className="ml-2 font-semibold text-danger">
                    Received can&apos;t exceed ordered (line {overReceived[0].itemSku || overReceived[0].itemName}:{" "}
                    {receiveDraft[overReceived[0].id!]}/{overReceived[0].qtyOrdered})
                  </span>
                )}
              </div>
              <div className="flex items-center gap-2">
                <Button variant="outline" size="sm"
                  onClick={() => {
                    setReceiving(false);
                    setReceiveDraft(
                      Object.fromEntries(
                        po.lines.map((l) => [l.id!, l.qtyReceived]),
                      ),
                    );
                  }}
                >
                  Cancel
                </Button>
                {/* --success and --sage-700 share the same RGB (tokens.css) so
                    solid/business reproduces this CTA's background exactly. */}
                <Button variant="solid" tone="business" size="sm"
                  disabled={!receiveDestId || overReceived.length > 0}
                  onClick={() => {
                    const lines = po.lines.map((l) => ({
                      lineId: l.id!,
                      qtyReceived: receiveDraft[l.id!] ?? l.qtyReceived,
                    }));
                    // Receive mode exits only when the parent hands back the
                    // server's updated PO (the re-seed effect below) — a failed
                    // save (400 OVER_RECEIVE / 409) leaves the dialog in
                    // receive mode with the draft intact (§5b/§5d).
                    onReceive?.({ poId: po.id, destinationLocationId: receiveDestId, lines });
                  }}
                >
                  <PackageCheck className="h-3.5 w-3.5" />
                  Save Receipt
                </Button>
              </div>
            </div>
          ) : (
            // ─── Normal footer ───
            <div className="flex w-full items-center justify-between">
              <div className="text-[11px] text-text-secondary">
                {po.status === "partial" && (
                  <span>
                    Received {totalRec} of {totalOrd} units ·{" "}
                    <span className="font-semibold text-warning">{pctReceived}% complete</span>
                  </span>
                )}
              </div>
              <div className="flex items-center gap-2">
                <Button variant="outline" size="sm"
                  onClick={onClose}
                >
                  Close
                </Button>
                <Button variant="outline" size="sm"
                  onClick={() => setShowEmail(true)}
                  className="inline-flex items-center gap-1.5"
                >
                  <Mail className="h-3.5 w-3.5" />
                  Email
                </Button>
                <Button variant="outline" size="sm"
                  onClick={() => setShowPreview(true)}
                  className="inline-flex items-center gap-1.5"
                >
                  <Eye className="h-3.5 w-3.5" />
                  Preview / Print
                </Button>
                {po.status === "partial" && (
                  <Button variant="outline" size="sm"
                    onClick={handleClose}
                    disabled={updatePO.isPending}
                    className="inline-flex items-center gap-1.5 disabled:opacity-60"
                  >
                    <CheckCircle2 className="h-3.5 w-3.5" />
                    Close PO
                  </Button>
                )}
                {primaryAction &&
                  (primaryAction.disabled ? (
                    // Staged PO (§3.6 / QA-611): the single receive path is the
                    // Staging view — direct receive stays disabled with a pointer.
                    <span className="inline-flex items-center gap-2">
                      {/* solid/neutral is the only minted solid+neutral cell;
                          idle shade (bg-border-soft vs raw's bg-border, text
                          -primary vs raw's text-secondary) is the closest
                          available match, dimmed further by Button's own
                          disabled:opacity-50. */}
                      <Button variant="solid" tone="neutral" size="sm"
                        disabled
                        title="This PO is staged to a job — receive it from the Staging view"
                      >
                        <primaryAction.icon className="h-3.5 w-3.5" />
                        {primaryAction.label}
                      </Button>
                      <Link
                        to="/inventory/staging"
                        className="text-xs font-semibold text-primary hover:underline"
                      >
                        Open Staging →
                      </Link>
                    </span>
                  ) : (
                    <Button size="sm"
                      onClick={primaryAction.onClick}
                    >
                      <primaryAction.icon className="h-3.5 w-3.5" />
                      {primaryAction.label}
                    </Button>
                  ))}
              </div>
            </div>
          )
        }
      >
        {/* ─── Header summary card ─── */}
        <div className="-mx-5 -mt-4 border-b border-border bg-background-light px-5 py-3">
          <div className="flex flex-wrap items-center gap-3">
            <span
              className={`inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${def.cls}`}
            >
              {def.label}
            </span>
            <div className="flex items-center gap-1.5 text-xs text-text-secondary">
              <Truck className="h-3.5 w-3.5 text-text-secondary" />
              {po.vendor}
            </div>
            {po.trade && (
              <span className="rounded-full bg-surface-light px-2 py-0.5 text-[11px] font-medium text-text-secondary ring-1 ring-border">
                {po.trade}
              </span>
            )}
            <div className="ml-auto flex items-center gap-4 text-[11px] text-text-secondary">
              <div>
                <span className="text-text-secondary">Ordered</span>{" "}
                <span className="font-semibold text-text-primary">
                  {fmtDate(po.orderedAt)}
                </span>
              </div>
              <ChevronRight className="h-3 w-3 text-secondary" />
              <div>
                <span className="text-text-secondary">Expected</span>{" "}
                <span className="font-semibold text-text-primary">
                  {fmtDay(po.expectedDate)}
                </span>
              </div>
            </div>
          </div>
        </div>

        {/* ─── Inner tab strip ─── */}
        <div className="-mx-5 flex items-center gap-1 border-b border-border bg-surface-light px-5">
          <InnerTab
            active={tab === "lines"}
            onClick={() => setTab("lines")}
            label="Lines"
            count={po.lines.length}
            icon={FileText}
          />
          <InnerTab
            active={tab === "activity"}
            onClick={() => setTab("activity")}
            label="Activity"
            icon={Activity}
          />
          <InnerTab
            active={tab === "documents"}
            onClick={() => setTab("documents")}
            label="Documents"
            icon={FileText}
          />
          <InnerTab
            active={tab === "match"}
            onClick={() => setTab("match")}
            label="3-Way Match"
            icon={CheckCircle2}
          />
        </div>

        {/* ─── Tab body ─── */}
        <div className="pt-4">
          {tab === "lines" && (
            <LinesTab
              po={po}
              subtotal={subtotal}
              total={total}
              receiving={receiving}
              receiveDraft={receiveDraft}
              receiveDestId={receiveDestId}
              onReceiveDestChange={setReceiveDestId}
              destOptions={destOptions}
              onDraftChange={(lineId, val) =>
                setReceiveDraft((prev) => ({ ...prev, [lineId]: val }))
              }
              onReceiveAll={() => {
                setReceiveDraft(
                  Object.fromEntries(po.lines.map((l) => [l.id!, l.qtyOrdered])),
                );
              }}
              onResetDraft={() => {
                setReceiveDraft(
                  Object.fromEntries(po.lines.map((l) => [l.id!, l.qtyReceived])),
                );
              }}
            />
          )}
          {tab === "activity" && <ActivityTab poId={po.id} />}
          {tab === "documents" && <DocumentsTabStub />}
          {tab === "match" && <MatchTabStub po={po} />}
        </div>
      </Modal>

      <POPreviewDialog
        open={showPreview}
        onClose={() => setShowPreview(false)}
        po={po}
        lockEscape
      />

      <POEmailDialog
        open={showEmail}
        onClose={() => setShowEmail(false)}
        po={po}
        lockEscape
        onSent={(payload) => {
          setShowEmail(false);
          // Auto-dismiss confirmation after 3.5s — matches the toast pattern
          // used in StagingView when emailing a pickup ticket.
          setEmailedToast(
            `✉ PO emailed to ${payload.to.length} recipient${payload.to.length === 1 ? "" : "s"} · ${payload.to[0]}`,
          );
          window.setTimeout(() => setEmailedToast(null), 3500);
        }}
      />

      {/* Inline send confirmation — floats above the dialog footer */}
      {emailedToast && (
        <div className="pointer-events-none fixed bottom-6 left-1/2 z-[90] -translate-x-1/2 rounded-md bg-success px-3.5 py-2 text-sm font-medium text-on-fill shadow-lg">
          {emailedToast}
        </div>
      )}
      {confirmDialog}
    </>
  );
}

// ─── Lines tab ──────────────────────────────────────────────────────────────
function LinesTab({
  po,
  subtotal,
  total,
  receiving,
  receiveDraft,
  receiveDestId,
  onReceiveDestChange,
  destOptions,
  onDraftChange,
  onReceiveAll,
  onResetDraft,
}: {
  po: PurchaseOrder;
  subtotal: number;
  total: number;
  receiving: boolean;
  receiveDraft: Record<string, number>;
  receiveDestId: string;
  onReceiveDestChange: (id: string) => void;
  destOptions: { id: string; label: string }[];
  onDraftChange: (lineId: string, value: number) => void;
  onReceiveAll: () => void;
  onResetDraft: () => void;
}) {
  return (
    <div className="space-y-2">
      {/* Receive-mode quick-action strip — left side picks the destination (D14). */}
      {receiving && (
        <div className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-success/20 bg-success/10 px-3 py-2 text-xs text-success">
          <div className="flex items-center gap-2">
            <span className="font-semibold">Receive into</span>
            {destOptions.length === 0 ? (
              <span className="text-text-secondary">No inventory locations available</span>
            ) : (
              <Select value={receiveDestId || undefined} onValueChange={onReceiveDestChange}>
                <SelectTrigger
                  aria-label="Receive into"
                  size="xs"
                  className="h-7 min-w-[200px]"
                >
                  <SelectValue placeholder="Pick a location…" />
                </SelectTrigger>
                <SelectContent>
                  {destOptions.map((o) => (
                    <SelectItem key={o.id} value={o.id}>
                      {o.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
          </div>
          <div className="flex items-center gap-1.5">
            {/* Deferred: outline/neutral's idle text is unset (inherits) — this
                row's wrapper sets ambient text-success (line ~521), so
                inheriting would render the label green instead of the
                intended secondary-gray. Left raw. */}
            <button
              onClick={onResetDraft}
              className="inline-flex items-center gap-1 rounded border border-border bg-surface-light px-2 py-0.5 text-[11px] font-medium text-text-secondary hover:bg-background-light"
            >
              <RotateCcw className="h-3 w-3" />
              Reset
            </button>
            {/* Deferred: no outline+success cell is minted (only
                outline/neutral and outline/danger exist). Left raw. */}
            <button
              onClick={onReceiveAll}
              className="inline-flex items-center gap-1 rounded border border-success/20 bg-surface-light px-2 py-0.5 text-[11px] font-semibold text-success hover:bg-success/10"
            >
              <PackageCheck className="h-3 w-3" />
              Receive all
            </button>
          </div>
        </div>
      )}

      <div className="overflow-hidden rounded-card border border-border">
        <table className="min-w-full text-sm">
          <thead className="border-b border-border bg-background-light text-left text-[11px] font-semibold uppercase tracking-wide text-text-secondary">
            <tr>
              <th className="px-3 py-2 w-10">#</th>
              <th className="px-3 py-2">SKU</th>
              <th className="px-3 py-2">Description</th>
              <th className="px-3 py-2">UoM</th>
              <th className="px-3 py-2 text-right">Ordered</th>
              <th className="px-3 py-2 text-right">Received</th>
              <th className="px-3 py-2 text-right">Unit $</th>
              <th className="px-3 py-2 text-right">Ext.</th>
              {receiving && <th className="px-3 py-2"></th>}
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {po.lines.map((line, idx) => (
              <LineRow
                key={line.id ?? idx}
                idx={idx}
                line={line}
                receiving={receiving}
                draftValue={receiveDraft[line.id!] ?? line.qtyReceived}
                onDraftChange={(v) => onDraftChange(line.id!, v)}
              />
            ))}
          </tbody>
          <tfoot className="border-t border-border bg-background-light text-sm">
            <tr>
              <td
                colSpan={receiving ? 7 : 6}
                className="px-3 py-2 text-right text-xs text-text-secondary"
              >
                Subtotal
              </td>
              <td colSpan={2} className="px-3 py-2 text-right tabular-nums text-text-primary">
                {fmtMoney(subtotal)}
              </td>
            </tr>
            <tr className="border-t border-border">
              <td
                colSpan={receiving ? 7 : 6}
                className="px-3 py-2 text-right text-xs font-semibold uppercase tracking-wide text-text-primary"
              >
                Total
              </td>
              <td colSpan={2} className="px-3 py-2 text-right tabular-nums text-base font-bold text-text-primary">
                {fmtMoney(total)}
              </td>
            </tr>
          </tfoot>
        </table>
      </div>
    </div>
  );
}

function LineRow({
  idx,
  line,
  receiving,
  draftValue,
  onDraftChange,
}: {
  idx: number;
  line: POLine;
  receiving: boolean;
  draftValue: number;
  onDraftChange: (v: number) => void;
}) {
  // Real per-line unit cost (P2). Absent = cost-stripped (no read Invoice) or
  // never captured — render "—", never a fake number.
  const ext = line.unitCost != null ? line.qtyOrdered * line.unitCost : null;
  const recVal = receiving ? draftValue : line.qtyReceived;
  const recPct = line.qtyOrdered === 0 ? 0 : recVal / line.qtyOrdered;
  return (
    <tr className="hover:bg-background-light">
      <td className="px-3 py-2 text-xs text-text-secondary">{idx + 1}</td>
      <td className="px-3 py-2 font-mono text-xs text-text-primary">
        {line.itemSku}
      </td>
      <td className="px-3 py-2 text-sm text-text-secondary">{line.itemName}</td>
      <td className="px-3 py-2 text-xs text-text-secondary">{line.uom}</td>
      <td className="px-3 py-2 text-right tabular-nums text-text-primary">
        {line.qtyOrdered}
      </td>
      <td className="px-3 py-2 text-right tabular-nums">
        {receiving ? (
          <div className="inline-flex items-center gap-1">
            <Input
              type="number"
              min={0}
              max={line.qtyOrdered}
              step="0.01"
              value={draftValue}
              onChange={(e) => {
                // Quantities are Decimal since P0 — parseFloat, clamped to [0, ordered].
                const v = Math.max(
                  0,
                  Math.min(line.qtyOrdered, parseFloat(e.target.value) || 0),
                );
                onDraftChange(v);
              }}
              className="w-16 px-1.5 py-0.5 text-right"
            />
            <span className="font-mono text-xs text-text-secondary">
              / {line.qtyOrdered}
            </span>
          </div>
        ) : (
          <>
            <span
              className={
                recPct === 1
                  ? "font-semibold text-success"
                  : recPct > 0
                    ? "font-semibold text-warning"
                    : "text-text-secondary"
              }
            >
              {line.qtyReceived}
            </span>
            <span className="text-text-secondary"> / {line.qtyOrdered}</span>
          </>
        )}
      </td>
      <td className="px-3 py-2 text-right tabular-nums text-text-secondary">
        {line.unitCost != null ? fmtMoney(line.unitCost) : "—"}
      </td>
      <td className="px-3 py-2 text-right tabular-nums font-medium text-text-primary">
        {ext != null ? fmtMoney(ext) : "—"}
      </td>
      {receiving && (
        <td className="px-3 py-2 text-right">
          {draftValue < line.qtyOrdered ? (
            // Deferred: no outline+success cell is minted, and this is a
            // small inline table-row increment affordance. Left raw.
            <button
              onClick={() => onDraftChange(Math.min(line.qtyOrdered, draftValue + 1))}
              className="rounded-md border border-success/20 bg-success/10 px-2 py-0.5 text-[11px] font-semibold text-success hover:bg-success/10"
              title="Receive one more unit of this line"
            >
              + 1
            </button>
          ) : (
            <span
              className="inline-flex items-center gap-1 text-[11px] text-success"
              title="Line fully received"
            >
              <CheckCircle2 className="h-3 w-3" />
              Full
            </span>
          )}
        </td>
      )}
    </tr>
  );
}

// ─── Activity tab (D7) — REAL timeline from the server ───────────────────────
// Merged server-side from the audit log (created/updated/received + the actual
// actor) and the outbound send history (subject + recipients). Replaces the old
// synthesized stub that fabricated actor names and timestamps off PO status.
const ACTIVITY_TONE: Record<POActivityEvent["kind"], string> = {
  created: "bg-background-light text-text-secondary",
  updated: "bg-primary-subtle text-primary",
  email_sent: "bg-primary-subtle text-primary",
  received: "bg-success/10 text-success",
  event: "bg-background-light text-text-secondary",
};

const ACTIVITY_LABEL: Record<POActivityEvent["kind"], string> = {
  created: "created",
  updated: "updated",
  email_sent: "email",
  received: "received",
  event: "event",
};

function fmtDateTime(iso: string): string {
  return new Date(iso).toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function ActivityTab({ poId }: { poId: string }) {
  const { data: events = [], isLoading, isError } = usePOActivity(poId);

  if (isLoading) {
    return (
      <div className="py-8 text-center text-sm text-text-secondary">
        Loading activity…
      </div>
    );
  }
  if (isError) {
    return (
      <div className="rounded-md border border-danger/20 bg-danger/10 px-3 py-2 text-[11px] text-danger">
        Couldn&apos;t load the activity timeline. Please try again.
      </div>
    );
  }
  if (events.length === 0) {
    return <EmptyState variant="card" title="No activity recorded yet." />;
  }

  return (
    <ul className="space-y-2">
      {events.map((e) => (
        <li
          key={e.id}
          className="flex items-start gap-3 rounded-md border border-border bg-surface-light px-3 py-2"
        >
          <span
            className={`mt-0.5 inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-semibold capitalize ${ACTIVITY_TONE[e.kind]}`}
          >
            {ACTIVITY_LABEL[e.kind]}
          </span>
          <div className="flex-1">
            <div className="text-sm font-medium text-text-primary">{e.summary}</div>
            {e.detail && (
              <div className="text-[11px] text-text-secondary">{e.detail}</div>
            )}
            <div className="text-[11px] text-text-secondary">
              {e.actor ? `${e.actor} · ` : ""}
              {fmtDateTime(e.at)}
            </div>
          </div>
        </li>
      ))}
    </ul>
  );
}

// ─── Documents tab stub ─────────────────────────────────────────────────────
function DocumentsTabStub() {
  return (
    <EmptyState
      variant="card"
      icon={FileText}
      title="Documents ship in the next rev"
      description="Will list: PO PDF · vendor quote PDFs (if RFQ) · packing slip photos uploaded during receive · vendor bill (when 3-way match runs). Drag-drop upload zone at top."
    />
  );
}

// ─── 3-Way Match tab stub ───────────────────────────────────────────────────
function MatchTabStub({ po }: { po: PurchaseOrder }) {
  if (po.status !== "received" && po.status !== "closed") {
    return (
      <EmptyState
        variant="card"
        icon={CheckCircle2}
        title="3-Way Match runs after receiving"
        description="This view becomes active once the PO is received and the vendor bill arrives. Compares Ordered · Received · Billed per line; flags variances above tolerance."
      />
    );
  }
  return (
    <EmptyState
      variant="card"
      icon={CheckCircle2}
      title="3-Way Match wiring ships with PRD §7.4"
      description={'Side-by-side Ordered · Received · Billed per line. Variance row highlighted amber/red when delta > tolerance. "Resolve exception" opens the AP queue sub-flow.'}
    />
  );
}

// ─── Inner tab button ───────────────────────────────────────────────────────
function InnerTab({
  active,
  onClick,
  label,
  count,
  icon: Icon,
}: {
  active: boolean;
  onClick: () => void;
  label: string;
  count?: number;
  icon: React.ComponentType<{ className?: string }>;
}) {
  return (
    // Deferred: segmented tab-strip control — not Button-shaped.
    <button
      onClick={onClick}
      className={[
        "inline-flex items-center gap-1.5 border-b-2 px-3 py-2 text-sm transition",
        active
          ? "border-primary font-semibold text-primary"
          : "border-transparent text-text-secondary hover:text-text-primary",
      ].join(" ")}
    >
      <Icon className="h-3.5 w-3.5" />
      {label}
      {count != null && (
        <span
          className={[
            "rounded-full px-1.5 py-0.5 text-[10px] font-semibold",
            active ? "bg-primary text-on-fill" : "bg-secondary-light text-text-secondary",
          ].join(" ")}
        >
          {count}
        </span>
      )}
    </button>
  );
}
