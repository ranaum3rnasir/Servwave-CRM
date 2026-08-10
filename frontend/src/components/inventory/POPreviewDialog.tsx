import { useEffect, useMemo, useState } from "react";
import { Building2, Download, FileText, Mail, Printer } from "lucide-react";
import { Modal } from "@/components/ui/modal";
import { formatCurrency } from "@/lib/utils";
import { formatExactDay } from "@/lib/format-date";
import {
  useBranches,
  useVendors,
  usePurchaseOrders,
  type PurchaseOrder,
} from "@/lib/api/inventory";
import { useOrganization } from "@/lib/api/organization";
import { useAuthStore } from "@/stores/auth.store";
import { SignatureField } from "@/components/inventory/SignatureField";
import type { SignatureValue } from "@/lib/inventory/signatures";
import { POEmailDialog } from "@/components/inventory/POEmailDialog";
import { formatPhone } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import {
  STATUS_INTENT_CLASSES,
  STATUS_REGISTRY,
} from "@/design-system/status-registry";

type Props = {
  open: boolean;
  onClose: () => void;
  // Either pass a PO object directly, OR pass a PO number / id to look up.
  po?: PurchaseOrder | null;
  poNumber?: string | null;
  poId?: string | null;
  // Optional pickup / ship-to branch — defaults to Brooklyn HQ
  shipToBranchId?: string;
  lockEscape?: boolean;
  /** Optional Modal z-index — accepted for prop-API parity when this dialog
   *  is opened from inside another dialog. The Modal adapter manages stacking
   *  itself, so it is intentionally not wired. */
  zIndex?: number;
  // Toast in the parent view when the PO is emailed.
  onEmailSent?: (payload: {
    poNumber: string;
    to: string[];
    subject: string;
  }) => void;
};

// Colour resolves through STATUS_REGISTRY.purchaseOrder; the labels below do NOT.
// The registry is terser for three of the five values ("Sent to vendor" -> "Sent",
// "Partially received" -> "Partial", "Received in full" -> "Received") and the chip
// renders under CSS `uppercase`, so adopting them would turn SENT TO VENDOR into SENT.
// That is a user-facing copy change, held pending the E4 copy decision - keep this map
// until it is adjudicated, then delete it and read the labels off the registry.
const statusLabel: Record<PurchaseOrder["status"], string> = {
  draft: "Draft",
  sent: "Sent to vendor",
  partial: "Partially received",
  received: "Received in full",
  closed: "Closed",
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

export function POPreviewDialog({
  open,
  onClose,
  po: poProp,
  poNumber,
  poId,
  shipToBranchId,
  lockEscape,
  zIndex,
  onEmailSent,
}: Props) {
  // zIndex is accepted for prop-API parity with the prototype; the Modal
  // adapter manages stacking itself, so it is intentionally not wired.
  void zIndex;
  const [showEmailDialog, setShowEmailDialog] = useState(false);

  // ─── Seam data ───
  const { data: purchaseOrders = [] } = usePurchaseOrders();
  const { data: allVendors = [] } = useVendors();
  const { data: branches = [] } = useBranches();
  const { data: org } = useOrganization();
  const brand = org?.name ?? "ServWave";

  // ─── Current user (ALPHA auth store) ───
  // Replaces Emanuel's `currentUser` mock; identity for the buyer signature
  // block + the "Authorized By" signer fallback comes from the logged-in user.
  const authUser = useAuthStore((s) => s.user);
  const currentUser = useMemo(
    () => ({
      id: authUser?.id ?? "",
      name: authUser ? `${authUser.first_name} ${authUser.last_name}`.trim() : "",
    }),
    [authUser],
  );

  // Resolve PO from any of the three input shapes
  const po: PurchaseOrder | null = useMemo(() => {
    if (poProp) return poProp;
    if (poId) return purchaseOrders.find((p) => p.id === poId) ?? null;
    if (poNumber)
      return (
        purchaseOrders.find(
          (p) => p.poNumber.toLowerCase() === poNumber.toLowerCase(),
        ) ?? null
      );
    return null;
  }, [poProp, poId, poNumber, purchaseOrders]);

  const vendor = useMemo(
    () => (po ? allVendors.find((v) => v.name === po.vendor) : undefined),
    [po, allVendors],
  );
  const branch = useMemo(
    () => branches.find((b) => b.id === shipToBranchId) ?? branches[0],
    [shipToBranchId, branches],
  );

  // Compute totals from inventory unit costs
  const enrichedLines = useMemo(() => {
    if (!po) return [];
    // D6: unit cost comes from the PO line itself, not a catalog recompute.
    return po.lines.map((l) => ({ ...l, ext: (l.unitCost ?? 0) * l.qtyOrdered }));
  }, [po]);

  const subtotal = enrichedLines.reduce((s, l) => s + l.ext, 0);
  const total = subtotal; // D6: PO is tax-exclusive

  // Buyer signature on the PO. Vendor signature is left as a placeholder
  // line because the vendor would sign via their own (emailed) link in
  // production, not inside this app's modal.
  const [buyerSig, setBuyerSig] = useState<SignatureValue | null>(null);
  useEffect(() => {
    setBuyerSig(null);
  }, [po?.id]);

  // Inject scoped print CSS only while this dialog is open
  useEffect(() => {
    if (!open) return;
    const style = document.createElement("style");
    style.id = "po-print-style";
    style.textContent = `
      @media print {
        body * { visibility: hidden !important; }
        .po-print-root, .po-print-root * { visibility: visible !important; }
        .po-print-root {
          position: fixed !important;
          inset: 0 !important;
          margin: 0 !important;
          padding: 14mm 16mm !important;
          background: white !important;
          box-shadow: none !important;
          ring-width: 0 !important;
          overflow: visible !important;
          color: rgb(var(--text-primary)) !important;
        }
        .po-print-hide { display: none !important; }
        @page { size: Letter; margin: 0; }
      }
    `;
    document.head.appendChild(style);
    return () => {
      const el = document.getElementById("po-print-style");
      if (el) el.remove();
    };
  }, [open]);

  if (!po) {
    if (!open) return null;
    return (
      <Modal
        open={open}
        onClose={onClose}
        title={`Purchase Order · ${poNumber ?? poId ?? "—"}`}
        subtitle="PO not found in the local price book"
        size="md"
        lockEscape={lockEscape}
        footer={
          <Button variant="outline" size="sm"
            onClick={onClose}
          >
            Close
          </Button>
        }
      >
        <div className="rounded-md border border-warning/20 bg-warning/10 px-3 py-2 text-xs text-warning">
          The requested PO could not be loaded for preview. It may have been
          archived or live in an external system. Try opening it from
          <span className="font-mono"> Inventory → Purchase Orders</span>.
        </div>
      </Modal>
    );
  }

  function handlePrint() {
    // Browser print dialog includes "Save as PDF" — same path
    window.print();
  }

  return (
    <>
    <Modal
      open={open}
      onClose={onClose}
      title={`Purchase Order · ${po.poNumber}`}
      subtitle={`${po.vendor} · ${po.lines.length} line${po.lines.length === 1 ? "" : "s"} · ordered ${fmtDate(po.orderedAt)}`}
      size="xl"
      lockEscape={lockEscape || showEmailDialog}
      footer={
        <div className="po-print-hide flex w-full items-center justify-between">
          <p className="text-[11px] text-text-secondary">
            Browser print dialog includes <span className="font-medium text-text-primary">"Save as PDF"</span> as a destination.
          </p>
          <div className="flex items-center gap-2">
            <Button variant="outline" size="sm"
              onClick={onClose}
            >
              Close
            </Button>
            {/* Deferred: no outline+brand tone is minted (only outline/neutral
                and outline/danger exist) — a primary-bordered outline button
                has no matching cell. Left raw. */}
            <button
              onClick={() => setShowEmailDialog(true)}
              className="inline-flex items-center gap-1.5 rounded-md border border-primary/30 bg-surface-light px-3 py-1.5 text-sm font-semibold text-primary hover:bg-primary-subtle"
              title="Email this PO to the vendor + buyer + AP"
            >
              <Mail className="h-4 w-4" />
              Email PO
            </button>
            <Button variant="outline" tone="neutral" size="sm"
              onClick={handlePrint}
              title="Save as PDF via browser print dialog"
            >
              <Download className="h-4 w-4" />
              Save as PDF
            </Button>
            <Button size="sm"
              onClick={handlePrint}
            >
              <Printer className="h-4 w-4" />
              Print
            </Button>
          </div>
        </div>
      }
    >
      <div className="po-print-root rounded-md border border-border bg-surface-light p-6 text-[13px] leading-snug text-text-primary">
        {/* Document header */}
        <div className="flex items-start justify-between gap-6 border-b border-border pb-4">
          <div className="flex items-start gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-primary text-on-fill">
              <Building2 className="h-5 w-5" />
            </div>
            <div>
              <div className="text-[11px] font-semibold uppercase tracking-wider text-text-secondary">
                {brand} · {branch?.name ?? "—"}
              </div>
              <div className="text-sm font-semibold text-text-primary">
                {branch?.address ?? "—"}
              </div>
              <div className="text-[11px] text-text-secondary">
                {branch?.phone ? formatPhone(branch.phone) : ""}
                {branch?.managerName ? ` · Manager: ${branch.managerName}` : ""}
              </div>
            </div>
          </div>
          <div className="text-right">
            <div className="text-[10px] font-semibold uppercase tracking-widest text-text-secondary">
              Purchase Order
            </div>
            <div className="font-mono text-2xl font-bold text-text-primary">
              {po.poNumber}
            </div>
            <span
              className={[
                // `border` (width) is required here: STATUS_INTENT_CLASSES supplies
                // only the border COLOUR, and Tailwind preflight zeroes the width.
                // The previous `ring-1` is gone with the tone map that coloured it,
                // so without an explicit `border` the hairline these chips have
                // always had would vanish.
                // COST, disclosed rather than buried: `ring-1` painted OUTSIDE the
                // border box and cost zero layout; `border` sits INSIDE the box
                // model, so this `inline-flex ... text-[10px] px-2 py-0.5
                // rounded-full` chip grows about 2px on each axis in this header
                // row, on all five purchaseOrder statuses. Dropping the hairline
                // entirely was considered and rejected: deleting a rule these chips
                // have always had is the larger change of the two.
                // Only non-colour delta beyond the geometry: the `sent` row's
                // hairline alpha moves from the old `ring-primary/30` to the
                // registry's `border-primary/20`.
                // Same swap, same reasoning as StagePreviewDialog.tsx.
                "mt-1 inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide",
                STATUS_INTENT_CLASSES[
                  STATUS_REGISTRY.purchaseOrder[po.status]?.intent ?? "neutral"
                ],
              ].join(" ")}
            >
              {statusLabel[po.status]}
            </span>
          </div>
        </div>

        {/* Vendor + Ship-to */}
        <div className="mt-4 grid grid-cols-1 sm:grid-cols-2 gap-6">
          <div>
            <div className="text-[10px] font-semibold uppercase tracking-wider text-text-secondary">
              Vendor
            </div>
            <div className="mt-1 font-semibold text-text-primary">{po.vendor}</div>
            {vendor?.category && (
              <div className="text-[11px] text-text-secondary">{vendor.category}</div>
            )}
            {vendor?.pickupAddress && (
              <div className="mt-1 text-[12px] text-text-secondary">
                {vendor.pickupAddress}
              </div>
            )}
            <div className="mt-1 grid grid-cols-2 gap-x-3 text-[11px] text-text-secondary">
              {vendor?.contactEmail && (
                <span>Email: <span className="text-text-primary">{vendor.contactEmail}</span></span>
              )}
              {vendor?.accountNumber && (
                <span>Acct #: <span className="font-mono text-text-primary">{vendor.accountNumber}</span></span>
              )}
              {vendor?.paymentTerms && (
                <span>Terms: <span className="text-text-primary">{vendor.paymentTerms}</span></span>
              )}
              {vendor?.leadTimeDays != null && (
                <span>Lead time: <span className="text-text-primary">{vendor.leadTimeDays} days</span></span>
              )}
            </div>
          </div>
          <div>
            <div className="text-[10px] font-semibold uppercase tracking-wider text-text-secondary">
              Ship To
            </div>
            <div className="mt-1 font-semibold text-text-primary">
              {brand} · {branch?.name ?? "—"}
            </div>
            {branch?.address && (
              <div className="text-[12px] text-text-secondary">{branch.address}</div>
            )}
            {po.jobNumber && (
              <div className="mt-2 rounded-md border border-primary/30 bg-primary-subtle/60 px-2.5 py-1.5 text-[11px] text-primary">
                <div className="font-semibold">For Job · {po.jobNumber}</div>
                {po.customer && <div>{po.customer}</div>}
                {po.site && <div className="text-primary/80">{po.site}</div>}
              </div>
            )}
          </div>
        </div>

        {/* Meta strip */}
        <div className="mt-4 grid grid-cols-4 gap-3 rounded-md bg-background-light px-3 py-2 text-[11px]">
          <div>
            <div className="text-[9px] font-semibold uppercase tracking-wider text-text-secondary">
              Order Date
            </div>
            <div className="text-text-primary">{fmtDate(po.orderedAt)}</div>
          </div>
          <div>
            <div className="text-[9px] font-semibold uppercase tracking-wider text-text-secondary">
              Expected
            </div>
            <div className="text-text-primary">{fmtDay(po.expectedDate)}</div>
          </div>
          <div>
            <div className="text-[9px] font-semibold uppercase tracking-wider text-text-secondary">
              Trade
            </div>
            <div className="text-text-primary capitalize">{po.trade ?? "—"}</div>
          </div>
          <div>
            <div className="text-[9px] font-semibold uppercase tracking-wider text-text-secondary">
              PO #
            </div>
            <div className="font-mono text-text-primary">{po.poNumber}</div>
          </div>
        </div>

        {/* Line items */}
        <div className="mt-4 overflow-hidden rounded-md border border-border">
          <table className="w-full border-collapse text-[12px]">
            <thead className="bg-background-light text-[10px] uppercase tracking-wider text-text-secondary">
              <tr>
                <th className="px-2.5 py-1.5 text-left font-semibold">#</th>
                <th className="px-2.5 py-1.5 text-left font-semibold">SKU</th>
                <th className="px-2.5 py-1.5 text-left font-semibold">Description</th>
                <th className="px-2.5 py-1.5 text-right font-semibold">Qty</th>
                <th className="px-2.5 py-1.5 text-center font-semibold">UoM</th>
                <th className="px-2.5 py-1.5 text-right font-semibold">Unit Cost</th>
                <th className="px-2.5 py-1.5 text-right font-semibold">Ext.</th>
                <th className="px-2.5 py-1.5 text-right font-semibold">Recv'd</th>
              </tr>
            </thead>
            <tbody>
              {enrichedLines.map((l, idx) => (
                <tr key={idx} className="border-t border-border align-top">
                  <td className="px-2.5 py-1.5 text-text-secondary">{idx + 1}</td>
                  <td className="px-2.5 py-1.5 font-mono text-[11px] text-text-primary">
                    {l.itemSku}
                  </td>
                  <td className="px-2.5 py-1.5 text-text-primary">{l.itemName}</td>
                  <td className="px-2.5 py-1.5 text-right font-mono text-text-primary">
                    {l.qtyOrdered}
                  </td>
                  <td className="px-2.5 py-1.5 text-center font-mono text-[11px] text-text-secondary">
                    {l.uom}
                  </td>
                  <td className="px-2.5 py-1.5 text-right font-mono text-text-primary">
                    {l.unitCost != null ? fmtMoney(l.unitCost) : "—"}
                  </td>
                  <td className="px-2.5 py-1.5 text-right font-mono font-semibold text-text-primary">
                    {fmtMoney(l.ext)}
                  </td>
                  <td className="px-2.5 py-1.5 text-right font-mono text-[11px] text-text-secondary">
                    {l.qtyReceived} / {l.qtyOrdered}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {/* Totals */}
        <div className="mt-3 flex justify-end">
          <div className="w-72 space-y-1 text-[12px]">
            <div className="flex justify-between text-text-secondary">
              <span>Subtotal</span>
              <span className="font-mono">{fmtMoney(subtotal)}</span>
            </div>
            <div className="flex justify-between border-t border-border pt-1 text-sm font-semibold text-text-primary">
              <span>Total</span>
              <span className="font-mono">{fmtMoney(total)}</span>
            </div>
          </div>
        </div>

        {/* Signature + notes — buyer signs in-app; vendor signs via emailed link. */}
        <div className="mt-6 grid grid-cols-1 sm:grid-cols-2 gap-6">
          <SignatureField
            role="Authorized By"
            signerId={
              branch?.managerName === currentUser.name
                ? currentUser.id
                : `mgr_${branch?.id ?? "unknown"}`
            }
            defaultName={branch?.managerName ?? currentUser.name}
            signerLabel={branch?.managerName ?? "Authorized Buyer"}
            currentUser={{ id: currentUser.id, name: currentUser.name }}
            value={buyerSig}
            onSign={setBuyerSig}
            onClear={() => setBuyerSig(null)}
          />
          <div>
            <div className="text-[10px] font-semibold uppercase tracking-wider text-text-secondary">
              Vendor Acknowledgement
            </div>
            <div className="mt-6 border-b border-secondary-dark" />
            <div className="mt-1 text-[10px] italic text-text-secondary">
              Vendor signs via emailed link · {vendor?.name ?? "Vendor"}
            </div>
          </div>
        </div>

        {/* Footer */}
        <div className="mt-6 flex items-center justify-between border-t border-border pt-3 text-[10px] text-text-secondary">
          <span className="inline-flex items-center gap-1">
            <FileText className="h-3 w-3" />
            {brand} · {po.poNumber} · Generated {fmtDate(new Date().toISOString())}
          </span>
          <span>Page 1 of 1</span>
        </div>
      </div>
    </Modal>

    <POEmailDialog
      open={showEmailDialog}
      onClose={() => setShowEmailDialog(false)}
      po={po}
      lockEscape
      onSent={(payload) => {
        onEmailSent?.({
          poNumber: po.poNumber,
          to: payload.to,
          subject: payload.subject,
        });
        setShowEmailDialog(false);
      }}
    />
    </>
  );
}
