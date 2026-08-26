import type React from "react";
import { useMemo, useState } from "react";
import {
  ArrowRight,
  CheckCircle2,
  FileText,
  Mail,
  MailOpen,
  Package,
  Paperclip,
  Send,
  Truck,
  User,
} from "lucide-react";
import { Modal } from "@/components/ui/modal";
import { Heading } from "@/components/ui/heading";
import { Input } from "@/components/ui/input";
import { formatCurrency } from "@/lib/utils";
import type {
  EmailThreadEntry,
  EstimateReservation,
  PrePOLine,
} from "@/lib/api/inventory";
import { Button } from "@/components/ui/button";
import {
  STATUS_INTENT_CLASSES,
  STATUS_REGISTRY,
} from "@/design-system/status-registry";

/**
 * PrePODetailDialog — (PRD §7.X.3 follow-up; RFQ rows removed in P0 §C /
 * QA-903 with the RFQ feature-parking).
 *
 * Opens when an Estimate-Reservation Pre-PO row is clicked. Mirrors
 * PODetailDialog's shape so users get one consistent "click the row → see
 * everything" experience.
 *
 * Tabs:
 *   1. Items     — line list (SKU · description · qty · uom)
 *   2. Estimate  — customer-approved estimate breakdown
 *   3. Activity  — email thread (estimate → customer + customer reply)
 *
 * Draft POs use the existing PODetailDialog instead (they already have a PO #).
 */

type Tab = "items" | "quotes" | "activity";

type Props = {
  open: boolean;
  onClose: () => void;
  row: { kind: "reservation"; data: EstimateReservation } | null;
  /** Convert an approved Estimate Reservation into a draft PurchaseOrder
   *  (server-side POST /convert — P2). Only offered while status === 'open'. */
  onConvertToPO?: (reservation: EstimateReservation) => void;
  /** Manual dismiss with an optional one-line reason (P2 lifecycle). */
  onDismiss?: (reservation: EstimateReservation, reason?: string) => void;
  /** Converted rows: open the linked PO (parent wires the same lookup as the
   *  queue row's "View PO →"). */
  onViewConvertedPO?: () => void;
  /** Pending flags for the two mutating buttons. */
  converting?: boolean;
  dismissing?: boolean;
};

const fmtMoney = formatCurrency;

function fmtDateTime(iso?: string): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function fmtDate(iso?: string): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

/**
 * Reservation status appearance now resolves through the shared registry
 * (STATUS_REGISTRY.estimateReservation): open = info, converted = success,
 * dismissed = neutral, which is exactly what the deleted local map said.
 *
 * LABELS ARE HELD, deliberately. The registry calls `open` "Open"; this dialog
 * has always said "Estimate Approved", which carries information "Open" does
 * not. That copy conflict is escalation E4 and is unresolved, so only the
 * colour half migrates here. `converted`/`dismissed` happen to match the
 * registry wording character for character.
 */
const statusLabel: Record<EstimateReservation["status"], string> = {
  open: "Estimate Approved",
  converted: "Converted",
  dismissed: "Dismissed",
};

function reservationChip(status: EstimateReservation["status"]): {
  label: string;
  cls: string;
} {
  const entry = STATUS_REGISTRY.estimateReservation[status];
  return {
    label: statusLabel[status],
    // `cls` also carries a border colour token from STATUS_INTENT_CLASSES, but the chip
    // that renders it below sets no `border` width class, so that colour is INERT -
    // Tailwind preflight zeroes every border to no width. Deliberate: this chip never had a
    // hairline, and adding one would be a fresh, undecided appearance change. Do NOT
    // "fix" it by adding `border`. Same note as PODetailDialog's chip; see the
    // inert-border note in
    // md_files/plans/frontend/workflows/2026-07-27-wp-status-registry.md.
    cls: STATUS_INTENT_CLASSES[entry?.intent ?? "neutral"],
  };
}

export function PrePODetailDialog({
  open,
  onClose,
  row,
  onConvertToPO,
  onDismiss,
  onViewConvertedPO,
  converting,
  dismissing,
}: Props) {
  const [tab, setTab] = useState<Tab>("items");
  // Two-step inline dismiss confirm (no browser confirm()): first click swaps
  // the button to "Confirm dismiss?" + an optional one-line reason input.
  const [confirmingDismiss, setConfirmingDismiss] = useState(false);
  const [dismissReason, setDismissReason] = useState("");

  // Derived data — safe-guarded by null `row`
  const meta = useMemo(() => {
    if (!row) return null;
    const e = row.data;
    return {
      ref: e.estimateNumber,
      chip: reservationChip(e.status ?? "open"),
      title: `${e.estimateNumber} · ${e.customer}`,
      subtitle: [e.jobNumber, e.site].filter(Boolean).join(" · "),
      trade: e.trade,
      primaryVendor: e.preferredVendor,
      primaryTotal: e.reservedTotal,
      whenLabel: "Customer approved",
      when: e.approvedAt,
      dueLabel: "Ready to convert",
      due: undefined as string | undefined,
      lines: e.lines,
      emails: e.emails,
      status: e.status ?? "open",
      contextLine:
        e.estimateStatus || e.leadStatus
          ? `Est ${e.estimateStatus ?? "—"} · Lead ${e.leadStatus ?? "—"}`
          : null,
    };
  }, [row]);

  if (!row || !meta) return null;

  const totalUnits = meta.lines.reduce((s, l) => s + l.qty, 0);

  const footerActions = (() => {
    if (meta.status === "converted") {
      return (
        <Button size="sm"
          onClick={onViewConvertedPO}
        >
          <ArrowRight className="h-3.5 w-3.5" />
          View PO →
        </Button>
      );
    }
    if (meta.status === "dismissed") return null;
    // open — Dismiss (two-step inline confirm) to the left of Convert.
    return (
      <>
        {confirmingDismiss ? (
          <span className="inline-flex items-center gap-1.5">
            <Input
              value={dismissReason}
              onChange={(e) => setDismissReason(e.target.value)}
              placeholder="Reason (optional)"
              aria-label="Dismiss reason"
              className="w-44 px-2 py-1.5"
            />
            {/* Deferred: idle-tinted danger fill (bg-danger/10 already at
                rest, not just on hover) — no minted cell has an idle-tinted
                danger structure; outline/danger is transparent until hover,
                which would drop the two-step confirm's escalation cue. */}
            <button
              disabled={dismissing}
              onClick={() => {
                onDismiss?.(row.data, dismissReason.trim() || undefined);
                setConfirmingDismiss(false);
                setDismissReason("");
              }}
              className="rounded-md border border-danger/20 bg-danger/10 px-3 py-1.5 text-sm font-semibold text-danger hover:bg-danger/10 disabled:opacity-50"
            >
              Confirm dismiss?
            </button>
            <Button variant="outline" size="sm"
              onClick={() => {
                setConfirmingDismiss(false);
                setDismissReason("");
              }}
            >
              Cancel
            </Button>
          </span>
        ) : (
          <Button variant="outline" size="sm"
            disabled={dismissing}
            onClick={() => setConfirmingDismiss(true)}
          >
            Dismiss
          </Button>
        )}
        <Button size="sm"
          disabled={converting || confirmingDismiss}
          onClick={() => onConvertToPO?.(row.data)}
        >
          <ArrowRight className="h-3.5 w-3.5" />
          Convert to Purchase Order
        </Button>
      </>
    );
  })();

  return (
    <>
      <Modal
        open={open}
        onClose={onClose}
        size="xl"
        title={meta.title}
        subtitle={meta.subtitle || "—"}
        footer={
          <div className="flex w-full items-center justify-between">
            <div className="text-[11px] text-text-secondary">
              {meta.status === "open" && (
                <span className="inline-flex items-center gap-1 text-info">
                  <CheckCircle2 className="h-3 w-3" />
                  Reserved {fmtMoney(meta.primaryTotal ?? 0)} · awaiting PO conversion
                </span>
              )}
            </div>
            <div className="flex items-center gap-2">
              <Button variant="outline" size="sm"
                onClick={onClose}
              >
                Close
              </Button>
              {footerActions}
            </div>
          </div>
        }
      >
        {/* ─── Header summary card ─── */}
        <div className="-mx-5 -mt-4 border-b border-border bg-background-light px-5 py-3">
          <div className="flex flex-wrap items-center gap-3">
            <span
              className={`inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${meta.chip.cls}`}
            >
              {meta.chip.label}
            </span>
            {meta.contextLine && (
              <span className="text-[11px] text-text-secondary">{meta.contextLine}</span>
            )}
            {meta.primaryVendor && (
              <div className="flex items-center gap-1.5 text-xs text-text-secondary">
                <Truck className="h-3.5 w-3.5 text-text-secondary" />
                {meta.primaryVendor}
              </div>
            )}
            {meta.trade && (
              <span className="rounded-full bg-surface-light px-2 py-0.5 text-[11px] font-medium text-text-secondary ring-1 ring-border">
                {meta.trade}
              </span>
            )}
            <div className="ml-auto flex items-center gap-4 text-[11px] text-text-secondary">
              <div>
                <span className="text-text-secondary">{meta.whenLabel}</span>{" "}
                <span className="font-semibold text-text-primary">
                  {fmtDate(meta.when)}
                </span>
              </div>
              {meta.due && (
                <>
                  <span className="text-border">→</span>
                  <div>
                    <span className="text-text-secondary">{meta.dueLabel}</span>{" "}
                    <span className="font-semibold text-text-primary">
                      {fmtDate(meta.due)}
                    </span>
                  </div>
                </>
              )}
              <span className="text-border">·</span>
              <div className="inline-flex items-center gap-1 font-mono text-sm font-bold text-text-primary">
                {fmtMoney(meta.primaryTotal ?? 0)}
              </div>
            </div>
          </div>
        </div>

        {/* ─── Inner tab strip ─── */}
        <div className="-mx-5 flex items-center gap-1 border-b border-border bg-surface-light px-5">
          <InnerTab
            active={tab === "items"}
            onClick={() => setTab("items")}
            label="Items"
            count={meta.lines.length}
            icon={Package}
          />
          <InnerTab
            active={tab === "quotes"}
            onClick={() => setTab("quotes")}
            label="Estimate"
            icon={FileText}
          />
          <InnerTab
            active={tab === "activity"}
            onClick={() => setTab("activity")}
            label="Email Activity"
            count={meta.emails.length}
            icon={Mail}
          />
        </div>

        {/* ─── Tab body ─── */}
        <div className="pt-4">
          {tab === "items" && (
            <ItemsTab lines={meta.lines} totalUnits={totalUnits} />
          )}
          {tab === "quotes" && <EstimateBreakdownTab reservation={row.data} />}
          {tab === "activity" && <EmailActivityTab emails={meta.emails} />}
        </div>
      </Modal>
    </>
  );
}

// ─── Items tab ──────────────────────────────────────────────────────────────
function ItemsTab({ lines, totalUnits }: { lines: PrePOLine[]; totalUnits: number }) {
  return (
    <div className="overflow-hidden rounded-card border border-border">
      <table className="min-w-full text-sm">
        <thead className="border-b border-border bg-background-light text-left text-[11px] font-semibold uppercase tracking-wide text-text-secondary">
          <tr>
            <th className="px-3 py-2 w-10">#</th>
            <th className="px-3 py-2">SKU</th>
            <th className="px-3 py-2">Description</th>
            <th className="px-3 py-2">UoM</th>
            <th className="px-3 py-2 text-right">Qty</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-border">
          {lines.map((l, idx) => (
            <tr key={l.itemSku + idx} className="hover:bg-background-light">
              <td className="px-3 py-2 text-xs text-text-secondary">{idx + 1}</td>
              <td className="px-3 py-2 font-mono text-xs text-text-primary">
                {l.itemSku}
              </td>
              <td className="px-3 py-2 text-sm text-text-secondary">{l.itemName}</td>
              <td className="px-3 py-2 text-xs text-text-secondary">{l.uom}</td>
              <td className="px-3 py-2 text-right tabular-nums text-text-primary">
                {l.qty}
              </td>
            </tr>
          ))}
        </tbody>
        <tfoot className="border-t border-border bg-background-light text-sm">
          <tr>
            <td colSpan={3} className="px-3 py-2 text-right text-xs text-text-secondary">
              {lines.length} item{lines.length === 1 ? "" : "s"}
            </td>
            <td className="px-3 py-2 text-right text-xs text-text-secondary">Total units</td>
            <td className="px-3 py-2 text-right tabular-nums font-semibold text-text-primary">
              {totalUnits}
            </td>
          </tr>
        </tfoot>
      </table>
    </div>
  );
}

// ─── Estimate breakdown tab (Reservation) ──────────────────────────────────
function EstimateBreakdownTab({
  reservation,
}: {
  reservation: EstimateReservation;
}) {
  // Synthesize line ext = reservedTotal × (qty / totalUnits) so the totals
  // add up. Real ext lands when the estimate model carries per-line prices.
  const totalUnits = reservation.lines.reduce((s, l) => s + l.qty, 0);
  const linesWithExt = reservation.lines.map((l) => ({
    ...l,
    ext: totalUnits === 0
      ? 0
      : +(reservation.reservedTotal * (l.qty / totalUnits)).toFixed(2),
  }));
  return (
    <div className="flex flex-col gap-3">
      <div className="rounded-card border-2 border-info/20 bg-gradient-to-r from-info/10 via-info/10 to-surface-light p-3">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="flex items-start gap-2">
            <div className="rounded-full bg-info p-1.5 text-on-fill shadow-sm">
              <CheckCircle2 className="h-4 w-4" />
            </div>
            <div>
              <div className="text-[10px] font-semibold uppercase tracking-wide text-info">
                Customer-approved estimate
              </div>
              <div className="text-base font-bold text-text-primary">
                {reservation.estimateNumber}
              </div>
              <div className="mt-0.5 text-[11px] text-text-secondary">
                Approved {fmtDate(reservation.approvedAt)} by{" "}
                <span className="font-mono text-[11px]">
                  {reservation.customerEmail ?? "customer"}
                </span>
              </div>
            </div>
          </div>
          <div className="text-right">
            <div className="font-mono text-lg font-bold text-info">
              {fmtMoney(reservation.reservedTotal)}
            </div>
            <div className="text-[11px] text-text-secondary">
              Preferred vendor:{" "}
              <span className="font-semibold text-text-primary">
                {reservation.preferredVendor ?? "—"}
              </span>
            </div>
          </div>
        </div>
      </div>

      <div className="overflow-hidden rounded-card border border-border">
        <table className="min-w-full text-sm">
          <thead className="border-b border-border bg-background-light text-left text-[11px] font-semibold uppercase tracking-wide text-text-secondary">
            <tr>
              <th className="px-3 py-2 w-10">#</th>
              <th className="px-3 py-2">SKU</th>
              <th className="px-3 py-2">Description</th>
              <th className="px-3 py-2 text-right">Qty</th>
              <th className="px-3 py-2">UoM</th>
              <th className="px-3 py-2 text-right">Ext. Reserved</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {linesWithExt.map((l, idx) => (
              <tr key={l.itemSku + idx} className="hover:bg-background-light">
                <td className="px-3 py-2 text-xs text-text-secondary">{idx + 1}</td>
                <td className="px-3 py-2 font-mono text-xs text-text-primary">
                  {l.itemSku}
                </td>
                <td className="px-3 py-2 text-sm text-text-secondary">{l.itemName}</td>
                <td className="px-3 py-2 text-right tabular-nums text-text-primary">
                  {l.qty}
                </td>
                <td className="px-3 py-2 text-xs text-text-secondary">{l.uom}</td>
                <td className="px-3 py-2 text-right tabular-nums text-text-secondary">
                  {fmtMoney(l.ext)}
                </td>
              </tr>
            ))}
          </tbody>
          <tfoot className="border-t border-border bg-background-light text-sm">
            <tr>
              <td colSpan={5} className="px-3 py-2 text-right text-xs font-semibold uppercase tracking-wide text-text-secondary">
                Reserved Total
              </td>
              <td className="px-3 py-2 text-right tabular-nums text-base font-bold text-text-primary">
                {fmtMoney(reservation.reservedTotal)}
              </td>
            </tr>
          </tfoot>
        </table>
      </div>

      <div className="rounded-md border border-border bg-background-light/60 px-3 py-2 text-[11px] text-text-secondary">
        Per-line prices are apportioned from the estimate's reserved total, so they are an
        estimate until the vendor quote sets explicit unit prices.
      </div>
    </div>
  );
}

// ─── Email Activity tab ────────────────────────────────────────────────────
function EmailActivityTab({ emails }: { emails: EmailThreadEntry[] }) {
  if (emails.length === 0) {
    return (
      <div className="rounded-card border border-dashed border-border bg-background-light p-6 text-center">
        <Mail className="mx-auto h-7 w-7 text-text-secondary" />
        <Heading level={3} className="mt-2">
          No emails yet
        </Heading>
        <p className="mt-1 text-xs text-text-secondary">
          Once the RFQ or estimate goes out, every outbound + inbound message
          shows up here.
        </p>
      </div>
    );
  }
  // Sort ASC so the thread reads top-to-bottom in chronological order.
  const sorted = [...emails].sort(
    (a, b) => new Date(a.sentAt).getTime() - new Date(b.sentAt).getTime(),
  );
  return (
    <ol className="space-y-3">
      {sorted.map((e) => (
        <EmailRow key={e.id} email={e} />
      ))}
    </ol>
  );
}

function EmailRow({ email }: { email: EmailThreadEntry }) {
  const isOutbound = email.direction === "outbound";
  const kindDef = {
    rfq_sent: { label: "RFQ sent", cls: "bg-primary-subtle text-primary", icon: Send },
    vendor_quote: { label: "Vendor quote", cls: "bg-success/10 text-success", icon: MailOpen },
    estimate_sent: { label: "Estimate sent", cls: "bg-info/10 text-info", icon: Send },
    customer_reply: { label: "Customer reply", cls: "bg-success/10 text-success", icon: MailOpen },
    follow_up: { label: "Follow-up", cls: "bg-background-light text-text-secondary", icon: Mail },
  }[email.kind];
  const Icon = kindDef.icon;
  return (
    <li
      className={[
        "rounded-card border bg-surface-light shadow-sm",
        isOutbound ? "border-border" : "border-success/20",
      ].join(" ")}
    >
      <div className="flex flex-wrap items-center gap-2 border-b border-border bg-background-light/60 px-3 py-2">
        <span
          className={`inline-flex items-center gap-1 rounded-full px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${kindDef.cls}`}
        >
          <Icon className="h-3 w-3" />
          {kindDef.label}
        </span>
        <span className="text-[11px] text-text-secondary">
          {isOutbound ? "→ Sent to" : "← Received from"}
        </span>
        <span className="inline-flex items-center gap-1 text-[11px] font-medium text-text-secondary">
          <User className="h-3 w-3 text-text-secondary" />
          {isOutbound ? email.to.join(", ") : email.from}
        </span>
        <span className="ml-auto text-[11px] text-text-secondary">
          {fmtDateTime(email.sentAt)}
        </span>
      </div>
      <div className="px-3 py-2">
        <div className="text-sm font-semibold text-text-primary">
          {email.subject}
        </div>
        <pre className="mt-1.5 whitespace-pre-wrap font-sans text-[12px] leading-relaxed text-text-secondary">
          {email.body}
        </pre>
        {email.attachments && email.attachments.length > 0 && (
          <div className="mt-2 flex flex-wrap gap-1.5">
            {email.attachments.map((a) => (
              <span
                key={a.label}
                className="inline-flex items-center gap-1 rounded border border-border bg-background-light px-1.5 py-0.5 text-[10px] font-medium text-text-secondary"
              >
                <Paperclip className="h-3 w-3 text-text-secondary" />
                {a.label}
              </span>
            ))}
          </div>
        )}
      </div>
    </li>
  );
}

// ─── Inner tab button (mirrors PODetailDialog) ─────────────────────────────
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
            active ? "bg-primary text-on-fill" : "bg-background-light text-text-secondary",
          ].join(" ")}
        >
          {count}
        </span>
      )}
    </button>
  );
}
