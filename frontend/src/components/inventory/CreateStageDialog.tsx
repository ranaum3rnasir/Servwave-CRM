import type React from "react";
import { useEffect, useMemo, useRef, useState } from "react";
import { Eye, FileText, Mail, MapPin, Plus, Sparkles, Trash2, User as UserIcon } from "lucide-react";
import { Modal } from "@/components/ui/modal";
import { FormField } from "@/components/patterns/FormField";
import { SelectField } from "@/components/form/SelectField";
import { DateTimePicker } from "@/components/form/DateTimePicker";
import { DatePicker } from "@/components/form/DatePicker";
import {
  useInventoryItems,
  useVendors,
  usePurchaseOrders,
  useInventoryJobs,
  useTechs,
  useCreateStage,
  type Location,
  type JobStage,
  type StagedItem,
  type PurchaseOrder,
  type Tech,
} from "@/lib/api/inventory";
import { POPreviewDialog } from "@/components/inventory/POPreviewDialog";
import { POEmailDialog } from "@/components/inventory/POEmailDialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { useScheduleTimezone, pickerValueToIso, isoToPickerValue } from "@/lib/schedule-tz";

type Props = {
  open: boolean;
  onClose: () => void;
  locations: Location[];
  onCreate: (stage: JobStage) => void;
  prefilledFromPO?: PurchaseOrder | null;
};

type DraftLine = {
  uid: string;
  itemId: string;
  qtyOrdered: string;
  qtyReceived: string;
  vendor: string;
  poNumber: string;
  expectedDate: string;
};

// `tradeOptions` removed (rev 2026-05-26) — CreateStageDialog no longer
// exposes a Trade picker. `JobStage.trade` still exists in the data model
// and is auto-derived from the linked job (or defaults to "multi" for
// freshly-typed jobs that have no source). See changelog "Trade field
// removed from CreateStageDialog (New Job Pickup)".

export function CreateStageDialog({
  open,
  onClose,
  locations,
  onCreate,
  prefilledFromPO,
}: Props) {
  // A stage's scheduled time is the COMPANY's clock. Both ends were wrong here: the picker
  // was seeded by slicing the raw ISO (so it showed UTC) and saved via `new Date(...)` (so it
  // stored the browser's), which is the same pairing that mis-stored the walkthrough times.
  const timezone = useScheduleTimezone();

  // Seam data (Track 1: mock-backed TanStack hooks; Track 2 flips to /api/*).
  // Emanuel imported these as module-scope arrays from ../data/*; here they
  // come from the query layer so the dialog re-reads after any mutation.
  const { data: allItems = [] } = useInventoryItems();
  const { data: allVendors = [] } = useVendors();
  const { data: purchaseOrders = [] } = usePurchaseOrders();
  const { data: allJobs = [] } = useInventoryJobs();
  const { data: allTechs = [] } = useTechs();
  // This dialog is the SOLE writer of a new stage: it POSTs here, and `onCreate`
  // only tells the parent to show it. Do not add a second mutation on the
  // parent's side - that is what wrote every stage to the database twice.
  const createStage = useCreateStage();

  // `newLine` closes over the seam `allItems` (Emanuel had it module-scope
  // referencing the static array). Guarded for noUncheckedIndexedAccess.
  function newLine(): DraftLine {
    return {
      uid: `line_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
      itemId: allItems[0]?.id ?? "",
      qtyOrdered: "",
      qtyReceived: "0",
      vendor: "",
      poNumber: "",
      expectedDate: "",
    };
  }

  const [form, setForm] = useState({
    jobId: "",          // when picked, populates customer/site/trade/scheduledFor
    jobNumber: "",      // free-text fallback if no job picked
    customer: "",
    site: "",
    scheduledFor: "",
    techId: "",
    // Default to "multi" — the dialog no longer exposes a Trade picker
    // (rev 2026-05-26); when a job is picked the value is auto-set from
    // job.trade, otherwise the stage is created as multi-trade.
    trade: "multi" as JobStage["trade"],
    pickupVendorId: "",
    pickupAddress: "",
    notes: "",
  });
  const [lines, setLines] = useState<DraftLine[]>(() => [newLine()]);
  const [linkedPOId, setLinkedPOId] = useState<string>("");
  const [error, setError] = useState<string | null>(null);
  const [previewPOId, setPreviewPOId] = useState<string | null>(null);
  const [shipEmailOpen, setShipEmailOpen] = useState(false);
  const [pendingShipStage, setPendingShipStage] = useState<JobStage | null>(null);
  // Queue of per-vendor synthetic POs to email when lines span multiple
  // vendors (multi-vendor PO split). Each entry is a separate composer the
  // operator reviews + sends in sequence; `vendorEmailIndex` tracks position.
  const [vendorEmailQueue, setVendorEmailQueue] = useState<PurchaseOrder[]>([]);
  const [vendorEmailIndex, setVendorEmailIndex] = useState(0);
  // POEmailDialog calls onSent + onClose back-to-back from its Send button.
  // Without this guard, the trailing onClose would clear the queue right after
  // we advanced the index. Synchronous ref so the order-of-calls within one
  // event is reliable.
  const justSentVendorEmail = useRef(false);

  // The PO that the "Email PO to Vendor" action will email. Prefer the
  // explicitly linked PO (auto-linked by job or chosen from the dropdown);
  // fall back to the prefilled-from-PO entry point. If neither is set, the
  // email button is disabled — there's nothing to attach.
  const currentPO: PurchaseOrder | null =
    prefilledFromPO ??
    purchaseOrders.find((p) => p.id === linkedPOId) ??
    null;

  // Group the current line items by vendor. When more than one distinct
  // vendor appears, we are in "multi-vendor mode" — the email-vendor action
  // splits the PO into one synthetic sub-PO per vendor (PO-####-A / -B / -C)
  // and emails each vendor only their portion.
  const vendorGroups = useMemo(() => {
    const order: string[] = [];
    const map = new Map<string, DraftLine[]>();
    for (const l of lines) {
      const v = (l.vendor || "").trim();
      if (!v) continue;
      if (!map.has(v)) {
        map.set(v, []);
        order.push(v);
      }
      map.get(v)!.push(l);
    }
    return order.map((vendor) => ({ vendor, lines: map.get(vendor)! }));
  }, [lines]);

  const isMultiVendor = vendorGroups.length > 1;

  const openPOs = useMemo(
    () =>
      purchaseOrders.filter(
        (p) => p.status !== "received" && p.status !== "closed",
      ),
    [purchaseOrders],
  );
  const jobPOs = useMemo(
    () =>
      form.jobNumber
        ? openPOs
            .filter((p) => p.jobNumber === form.jobNumber)
            .sort((a, b) => (b.orderedAt ?? "").localeCompare(a.orderedAt ?? ""))
        : [],
    [openPOs, form.jobNumber],
  );

  // Pre-fill from a PO when one is passed in (and the dialog is open)
  useEffect(() => {
    if (!open) return;
    if (prefilledFromPO) {
      // Find a matching job by number, vendor record, etc.
      const matchedJob = prefilledFromPO.jobNumber
        ? allJobs.find((j) => j.jobNumber === prefilledFromPO.jobNumber)
        : undefined;
      const matchedVendor = allVendors.find(
        (v) => v.name === prefilledFromPO.vendor,
      );
      setForm((f) => ({
        ...f,
        jobId: matchedJob?.id ?? "",
        jobNumber: prefilledFromPO.jobNumber ?? f.jobNumber,
        customer: prefilledFromPO.customer ?? matchedJob?.customer ?? f.customer,
        site: prefilledFromPO.site ?? matchedJob?.site ?? f.site,
        trade: prefilledFromPO.trade ?? matchedJob?.trade ?? f.trade,
        scheduledFor: matchedJob?.scheduledFor
          ? isoToPickerValue(matchedJob.scheduledFor, timezone)
          : f.scheduledFor,
        techId: matchedJob?.assignedTechId ?? f.techId,
        pickupVendorId: matchedVendor?.id ?? f.pickupVendorId,
        pickupAddress: matchedVendor?.pickupAddress ?? f.pickupAddress,
      }));
      setLinkedPOId(prefilledFromPO.id);
      applyPOLines(prefilledFromPO);
      setError(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, prefilledFromPO?.id]);

  function applyPOLines(po: PurchaseOrder) {
    setLines(
      po.lines.map((pol, idx) => {
        const matchedItem = allItems.find((i) => i.sku === pol.itemSku);
        return {
          uid: `line_po_${po.id}_${idx}`,
          itemId: matchedItem?.id ?? allItems[0]?.id ?? "",
          qtyOrdered: String(pol.qtyOrdered),
          qtyReceived: String(pol.qtyReceived),
          vendor: po.vendor,
          poNumber: po.poNumber,
          expectedDate: po.expectedDate ? po.expectedDate.slice(0, 10) : "",
        };
      }),
    );
  }

  function pickJob(jobId: string) {
    if (jobId === "__new__") {
      // user picked "+ New Job" — clear job context, let them type free text
      setForm((f) => ({ ...f, jobId: "", jobNumber: "" }));
      // also clear any auto-linked PO from a prior job
      setLinkedPOId("");
      return;
    }
    const job = allJobs.find((j) => j.id === jobId);
    if (!job) {
      setForm((f) => ({ ...f, jobId: "" }));
      return;
    }

    // Find the most recent open PO already on this job (if any)
    const matchingPO = purchaseOrders
      .filter(
        (p) =>
          p.jobNumber === job.jobNumber &&
          p.status !== "received" &&
          p.status !== "closed",
      )
      .sort((a, b) => (b.orderedAt ?? "").localeCompare(a.orderedAt ?? ""))[0];

    const matchedVendor = matchingPO
      ? allVendors.find((v) => v.name === matchingPO.vendor)
      : undefined;

    setForm((f) => ({
      ...f,
      jobId: job.id,
      jobNumber: job.jobNumber,
      customer: job.customer,
      site: job.site,
      trade: job.trade,
      scheduledFor: job.scheduledFor ? isoToPickerValue(job.scheduledFor, timezone) : "",
      techId: job.assignedTechId ?? f.techId,
      pickupVendorId: matchedVendor?.id ?? f.pickupVendorId,
      pickupAddress: matchedVendor?.pickupAddress ?? f.pickupAddress,
    }));

    if (matchingPO) {
      setLinkedPOId(matchingPO.id);
      applyPOLines(matchingPO);
    } else {
      // No PO on this job — clear any auto-linked PO from a prior selection
      // and reset to a single empty line so user can add items / custom PO.
      setLinkedPOId("");
      setLines([newLine()]);
    }
  }

  function pickPO(poId: string) {
    if (!poId) {
      setLinkedPOId("");
      return;
    }
    const po = purchaseOrders.find((p) => p.id === poId);
    if (!po) return;
    setLinkedPOId(po.id);
    applyPOLines(po);
    const matchedVendor = allVendors.find((v) => v.name === po.vendor);
    if (matchedVendor && !form.pickupVendorId) {
      setForm((f) => ({
        ...f,
        pickupVendorId: matchedVendor.id,
        pickupAddress: matchedVendor.pickupAddress ?? f.pickupAddress,
      }));
    }
  }

  function pickVendor(vendorId: string) {
    const vendor = allVendors.find((v) => v.id === vendorId);
    setForm((f) => ({
      ...f,
      pickupVendorId: vendorId,
      pickupAddress: vendor?.pickupAddress ?? "",
    }));
  }

  function set<K extends keyof typeof form>(k: K, v: (typeof form)[K]) {
    setForm((f) => ({ ...f, [k]: v }));
  }

  function updateLine(uid: string, patch: Partial<DraftLine>) {
    setLines((ls) => ls.map((l) => (l.uid === uid ? { ...l, ...patch } : l)));
  }

  function addLine() {
    setLines((ls) => [...ls, newLine()]);
  }

  function removeLine(uid: string) {
    setLines((ls) => (ls.length === 1 ? ls : ls.filter((l) => l.uid !== uid)));
  }

  function reset() {
    setForm({
      jobId: "",
      jobNumber: "",
      customer: "",
      site: "",
      scheduledFor: "",
      techId: "",
      trade: "multi", // rev 2026-05-26: trade field removed from UI; default multi
      pickupVendorId: "",
      pickupAddress: "",
      notes: "",
    });
    setLines([newLine()]);
    setLinkedPOId("");
    setError(null);
  }

  /**
   * Build the final JobStage object from the current form, validating
   * required fields. Returns null + sets an error message if anything is
   * missing. The `shipMode` flag is set when the operator is emailing the PO
   * to the vendor to *ship* the parts: the resulting stage is `awaiting` at
   * the destination warehouse and carries no `pickupVendorId` (because the
   * parts will arrive here, not be picked up at the vendor's counter).
   */
  function buildStage(shipMode: boolean): JobStage | null {
    if (!form.jobNumber.trim()) {
      setError("Job number is required.");
      return null;
    }
    if (!form.customer.trim()) {
      setError("Customer is required.");
      return null;
    }
    if (lines.some((l) => !l.qtyOrdered || parseInt(l.qtyOrdered, 10) <= 0)) {
      setError("Every line needs an ordered quantity > 0.");
      return null;
    }
    if (lines.some((l) => !l.poNumber.trim())) {
      setError("Every line needs a PO number (or N/A for emergency).");
      return null;
    }

    const stagedItems: StagedItem[] = lines.map((l, idx) => {
      const itm = allItems.find((i) => i.id === l.itemId);
      return {
        id: `stg_new_${Date.now()}_${idx}`,
        itemSku: itm?.sku ?? "",
        itemName: itm?.name ?? "",
        uom: itm?.uom ?? "EA",
        qtyOrdered: parseInt(l.qtyOrdered, 10),
        qtyReceived: shipMode ? 0 : parseInt(l.qtyReceived || "0", 10),
        vendor: l.vendor.trim() || itm?.vendor || "",
        poNumber: l.poNumber.trim(),
        expectedDate: l.expectedDate ? new Date(l.expectedDate).toISOString() : undefined,
        serialized: itm?.serialized ?? false,
      };
    });

    const totalOrdered = stagedItems.reduce((s, i) => s + i.qtyOrdered, 0);
    const totalReceived = stagedItems.reduce((s, i) => s + i.qtyReceived, 0);
    // Ship-mode stages always land in `awaiting` at the destination warehouse
    // (parts will arrive over the next day or two). Vendor-pickup stages skip
    // the receive flow entirely (parts already sitting at the vendor counter,
    // tech drives over). Everything else follows the qty-driven status.
    const status: JobStage["status"] = shipMode
      ? "awaiting"
      : form.pickupVendorId
        ? "ready_for_pickup"
        : totalReceived === 0
          ? "awaiting"
          : totalReceived >= totalOrdered
            ? "complete"
            : "partial";

    // For ship-mode pick the first warehouse-type location as the destination;
    // fall back to the first available location if none are tagged warehouse.
    const destinationLocationId = shipMode
      ? (locations.find((l) => l.type === "warehouse")?.id ?? locations[0]?.id)
      : form.pickupVendorId
        ? undefined
        : locations[0]?.id;

    const techRecord = allTechs.find((t) => t.id === form.techId);
    return {
      id: `stg_new_${Date.now()}`,
      jobNumber: form.jobNumber.trim(),
      customer: form.customer.trim(),
      site: form.site.trim() || "—",
      scheduledFor: pickerValueToIso(form.scheduledFor, timezone),
      assignedTechId: form.techId || undefined,
      assignedTech: techRecord?.name,
      trade: form.trade,
      status,
      // Ship-mode clears pickupVendorId — the vendor is shipping, not hosting.
      pickupVendorId: shipMode
        ? undefined
        : form.pickupVendorId || undefined,
      pickupAddress:
        shipMode ? undefined : form.pickupAddress.trim() || undefined,
      stagedLocationId: destinationLocationId,
      items: stagedItems,
      notes: form.notes.trim() || undefined,
      createdAt: new Date().toISOString(),
    };
  }

  /**
   * The POST body: the local `JobStage` view shape plus the two links the
   * server can persist but `JobStage` has no room for.
   *
   * - `jobId` - without it the stage saves with job_id null, so it never
   *   appears on the job's own Staging section, "Open Job" has nothing to
   *   open, and receipts miss the per-job material-cost roll-up.
   * - `linkedPurchaseOrderId` - records which PO these lines came from WITHOUT
   *   handing line authorship to the server. (`stagedFromPurchaseOrderId` is
   *   the other server path; it re-copies the PO's lines verbatim, which would
   *   throw away the quantities the operator just edited in this dialog.)
   */
  function stagePayload(stage: JobStage) {
    return {
      ...stage,
      jobId: form.jobId || undefined,
      linkedPurchaseOrderId: currentPO?.id,
    };
  }

  function submit() {
    const stage = buildStage(false);
    if (!stage) return;
    createStage.mutate(stagePayload(stage));
    onCreate(stage);
    reset();
    onClose();
  }

  /**
   * Build a synthetic PurchaseOrder representing one vendor's slice of the
   * current line items. Used when the operator has split the lines across
   * multiple vendors — each vendor gets a sub-PO numbered with a letter
   * suffix (PO-2311-A, PO-2311-B, …) derived from the parent PO so the audit
   * trail is intact.
   */
  function syntheticPOForVendor(
    vendor: string,
    vLines: DraftLine[],
    suffix: string | null,
  ): PurchaseOrder {
    const base = currentPO;
    const poNumber =
      suffix && base
        ? `${base.poNumber}-${suffix}`
        : base?.poNumber ?? `PO-NEW`;
    return {
      id: `${base?.id ?? "po_new"}_${suffix ?? "single"}`,
      poNumber,
      vendor,
      status: base?.status ?? "draft",
      jobNumber: form.jobNumber.trim() || base?.jobNumber,
      customer: form.customer.trim() || base?.customer,
      site: form.site.trim() || base?.site,
      trade: base?.trade ?? form.trade,
      orderedAt: base?.orderedAt ?? new Date().toISOString(),
      expectedDate: base?.expectedDate,
      lines: vLines.map((l) => {
        const itm = allItems.find((i) => i.id === l.itemId);
        return {
          itemSku: itm?.sku ?? "",
          itemName: itm?.name ?? "",
          uom: itm?.uom ?? "EA",
          qtyOrdered: parseInt(l.qtyOrdered, 10) || 0,
          qtyReceived: parseInt(l.qtyReceived || "0", 10),
        };
      }),
    };
  }

  function openVendorEmail() {
    const stage = buildStage(true);
    if (!stage) return;
    setPendingShipStage(stage);
    // Build the email queue: one synthetic PO per distinct vendor when the
    // lines are split across multiple vendors, or just the linked PO as-is
    // when every line shares the same vendor.
    let queue: PurchaseOrder[];
    if (isMultiVendor) {
      queue = vendorGroups.map((g, i) =>
        syntheticPOForVendor(g.vendor, g.lines, String.fromCharCode(65 + i)),
      );
    } else if (currentPO) {
      queue = [currentPO];
    } else if (vendorGroups.length === 1) {
      // No linked PO but exactly one vendor across the lines — build a single
      // synthetic PO without a suffix.
      const g0 = vendorGroups[0]!;
      queue = [syntheticPOForVendor(g0.vendor, g0.lines, null)];
    } else {
      // Nothing to email.
      return;
    }
    setVendorEmailQueue(queue);
    setVendorEmailIndex(0);
    setShipEmailOpen(true);
  }

  return (
    <>
    <Modal
      open={open}
      onClose={() => {
        reset();
        onClose();
      }}
      title={
        prefilledFromPO
          ? `New Job · from ${prefilledFromPO.poNumber}`
          : "New Job Pickup"
      }
      subtitle={
        prefilledFromPO
          ? `Pre-filled from ${prefilledFromPO.vendor} · ${prefilledFromPO.lines.length} line item${prefilledFromPO.lines.length === 1 ? "" : "s"}. Confirm job context + save.`
          : "Create a staging entry for items ordered against a specific job. Auto-creates PO references; receives can be logged as parts arrive."
      }
      size="xl"
      footer={
        <>
          <Button variant="outline" size="sm"
            onClick={() => {
              reset();
              onClose();
            }}
          >
            Cancel
          </Button>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => {
              // Prefer the explicitly linked PO; fall back to the prefill PO
              const id = linkedPOId || prefilledFromPO?.id || "";
              if (id) setPreviewPOId(id);
            }}
            disabled={!linkedPOId && !prefilledFromPO}
            title={
              linkedPOId || prefilledFromPO
                ? "Preview the linked PO as PDF · print"
                : "Link a PO above to enable preview"
            }
          >
            <Eye className="h-4 w-4 text-primary" />
            Preview PO
          </Button>
          {/* Raw by design: a brand-tinted outline button (border-primary/30,
              text-primary, hover:bg-primary/10) — no minted outline/brand
              cell exists (outline only has neutral + danger tones). */}
          <button
            type="button"
            onClick={openVendorEmail}
            disabled={!currentPO && vendorGroups.length === 0}
            className="inline-flex items-center gap-1.5 rounded-md border border-primary/30 bg-surface-light px-3 py-1.5 text-sm font-semibold text-primary hover:bg-primary/10 disabled:cursor-not-allowed disabled:opacity-40"
            title={
              currentPO || vendorGroups.length > 0
                ? isMultiVendor
                  ? `Split across ${vendorGroups.length} vendors — sends one email per vendor (PO-####-A, -B, …), each containing only that vendor's lines. Creates an Awaiting stage at the warehouse after the final send.`
                  : `Email ${currentPO?.poNumber ?? "this PO"} to ${vendorGroups[0]?.vendor ?? currentPO?.vendor ?? "the vendor"} to order + ship the parts here — creates an Awaiting stage at the warehouse on send`
                : "Link a PO above to email the vendor"
            }
          >
            <Mail className="h-4 w-4 text-primary" />
            {isMultiVendor
              ? `Email ${vendorGroups.length} Vendor POs`
              : "Email PO to Vendor"}
          </button>
          <Button size="sm"
            onClick={submit}
          >
            Create Pickup ({lines.length} item{lines.length === 1 ? "" : "s"})
          </Button>
        </>
      }
    >
      {error && (
        <div className="mb-3 rounded-md border border-danger/20 bg-danger/10 px-3 py-2 text-xs text-danger">
          {error}
        </div>
      )}

      <div className="flex flex-col gap-4">
        {/* Job picker — auto-fills customer, site, schedule, tech.
            Trade field intentionally removed (rev 2026-05-26) — this CRM is
            trade-agnostic, the trade chip on a stage card comes from the
            linked job context, not from a per-stage classifier. */}
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          {/* SelectField's Radix Select ROOT forwards no id to its trigger -
              a known gap (FormField.tsx's header comment). Kept as
              SelectField, not a raw Select/SelectTrigger: the layering guard
              resolves same-file local `const` string classNames, and
              selectCls's hard/soft classes would redden the ratchet if
              handed straight to SelectTrigger (a components/ui export)
              instead of through SelectField, which the guard does not
              govern. render-prop is still needed here (not cloneElement) for
              the conditional new-job Input / auto-fill note sitting after
              the Select - fieldProps go unused since SelectField has nowhere
              to receive them. */}
          <FormField label="Job" required>
            {() => (
              <>
                <SelectField
                  aria-label="Job"
                  value={form.jobId || "__new__"}
                  onValueChange={pickJob}
                  className={`${selectCls} font-mono`}
                  options={[
                    { value: "__new__", label: "+ New job (type below)…" },
                    ...allJobs.map((j) => ({
                      value: j.id,
                      label: `${j.jobNumber} — ${j.customer.slice(0, 32)}`,
                    })),
                  ]}
                />
                {!form.jobId && (
                  <Input
                    value={form.jobNumber}
                    onChange={(e) => set("jobNumber", e.target.value.toUpperCase())}
                    placeholder="Type new job # · e.g. J-1870"
                    className={`${inputCls} mt-1`}
                  />
                )}
                {form.jobId && (
                  <p className="mt-0.5 inline-flex items-center gap-1 text-[11px] text-success">
                    <Sparkles className="h-3 w-3" />
                    Auto-filled customer · site · schedule
                  </p>
                )}
              </>
            )}
          </FormField>
          <FormField label="Customer" required>
            <Input
              value={form.customer}
              onChange={(e) => set("customer", e.target.value)}
              placeholder="Rolex 5th Ave"
              className={inputCls}
              readOnly={!!form.jobId}
            />
          </FormField>
        </div>

        <FormField label="Site / Address">
          <Input
            value={form.site}
            onChange={(e) => set("site", e.target.value)}
            placeholder="665 Fifth Ave, NY · Vault corridor"
            className={inputCls}
            readOnly={!!form.jobId}
          />
        </FormField>

        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
          {/* Not converted to FormField's cloneElement path: DateTimePicker has no id
              prop of its own to receive fieldProps. */}
          <div>
            <Label>Scheduled For</Label>
            <DateTimePicker
              value={form.scheduledFor}
              onChange={(v) => set("scheduledFor", v)}
              className="mt-1"
            />
          </div>
          {/* SelectField's Radix Select ROOT forwards no id to its trigger -
              a known gap (FormField.tsx's header comment). Kept as
              SelectField, not a raw Select/SelectTrigger: the layering guard
              resolves same-file local `const` string classNames, and
              selectCls's hard/soft classes would redden the ratchet if
              handed straight to SelectTrigger (a components/ui export)
              instead of through SelectField, which the guard does not
              govern. render-prop is still needed here (not cloneElement) for
              the conditional helper paragraph sitting after the Select -
              fieldProps go unused since SelectField has nowhere to receive
              them. */}
          <FormField label="Assigned Tech">
            {() => (
              <>
                <SelectField
                  aria-label="Assigned tech"
                  value={form.techId || "NONE"}
                  onValueChange={(v) => set("techId", v === "NONE" ? "" : v)}
                  className={selectCls}
                  options={[
                    { value: "NONE", label: "Unassigned" },
                    ...allTechs.map((t) => ({
                      value: t.id,
                      label: `${t.name} — ${techRoleLabel(t.role)}${t.primaryTrade ? ` · ${t.primaryTrade}` : ""}`,
                    })),
                  ]}
                />
                {form.techId && (() => {
                  const t = allTechs.find((x) => x.id === form.techId);
                  if (!t) return null;
                  return (
                    <p className="mt-0.5 inline-flex items-center gap-1 text-[11px] text-text-secondary">
                      <UserIcon className="h-3 w-3" />
                      {t.branch}
                      {t.vehicle ? ` · ${t.vehicle}` : ""}
                    </p>
                  );
                })()}
              </>
            )}
          </FormField>
          {/* SelectField's Radix Select ROOT forwards no id to its trigger -
              a known gap (FormField.tsx's header comment). Kept as
              SelectField, not a raw Select/SelectTrigger: the layering guard
              resolves same-file local `const` string classNames, and
              selectCls's hard/soft classes would redden the ratchet if
              handed straight to SelectTrigger (a components/ui export)
              instead of through SelectField, which the guard does not
              govern. */}
          <FormField label="Pickup From Vendor">
            <SelectField
              aria-label="Pickup from vendor"
              value={form.pickupVendorId || "NONE"}
              onValueChange={(v) => pickVendor(v === "NONE" ? "" : v)}
              className={selectCls}
              options={[
                { value: "NONE", label: "Select vendor pickup…" },
                ...allVendors
                  .filter((v) => v.id !== "vnd_internal")
                  .map((v) => ({ value: v.id, label: v.name })),
              ]}
            />
          </FormField>
        </div>

        {/* Vendor pickup address */}
        {form.pickupVendorId && (
          <div className="rounded-md border border-primary/20 bg-primary/5 p-2.5">
            <div className="flex items-start gap-2">
              <MapPin className="mt-0.5 h-4 w-4 flex-shrink-0 text-primary" />
              <div className="flex-1">
                <p className="text-[10px] font-medium uppercase tracking-wide text-primary">
                  Vendor Pickup Location
                </p>
                <Input
                  value={form.pickupAddress}
                  onChange={(e) => set("pickupAddress", e.target.value)}
                  placeholder="Vendor pickup address"
                  className="p-0"
                />
              </div>
            </div>
          </div>
        )}

        {/* Line items section */}
        <div className="rounded-md border border-border bg-background-light/40 p-3">
          <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
            {/* Raw by design: eyebrow style, no matching Heading variant. */}
            <h3 className="text-xs font-semibold uppercase tracking-wide text-text-secondary">
              Items Ordered ({lines.length})
              {linkedPOId && (
                <>
                  <span className="ml-2 inline-flex items-center gap-1 rounded-full bg-primary/10 px-1.5 py-0.5 text-[10px] font-semibold normal-case text-primary ring-1 ring-primary/20">
                    <FileText className="h-2.5 w-2.5" />
                    Linked to{" "}
                    {purchaseOrders.find((p) => p.id === linkedPOId)?.poNumber}
                  </span>
                  {/* Raw by design: nested inside the `uppercase` <h3> above,
                      so it needs its own `normal-case` to read as "Preview PO"
                      rather than inherit ALL-CAPS. `normal-case` is a SOFT
                      typography class and the layering guard's soft ratchet
                      has zero slack (196/196 measured pre-batch) — dropping it
                      would be a real visual regression, keeping it would red
                      the guard. Also no minted size rung matches this
                      ~18px-tall / text-[10px] compact pill. */}
                  <button
                    type="button"
                    onClick={() => setPreviewPOId(linkedPOId)}
                    className="ml-1 inline-flex items-center gap-1 rounded-md border border-border bg-surface-light px-1.5 py-0.5 text-[10px] font-semibold normal-case text-text-secondary hover:bg-background-light"
                    title="Preview PO as PDF · print"
                  >
                    <Eye className="h-2.5 w-2.5 text-primary" />
                    Preview PO
                  </button>
                </>
              )}
              {isMultiVendor && (
                <span
                  className="ml-2 inline-flex items-center gap-1 rounded-full bg-warning/10 px-1.5 py-0.5 text-[10px] font-semibold normal-case text-warning ring-1 ring-warning/20"
                  title={`Lines are split across ${vendorGroups.length} vendors: ${vendorGroups.map((g) => g.vendor).join(" · ")}. Emailing will send one PO per vendor.`}
                >
                  <Mail className="h-2.5 w-2.5" />
                  {vendorGroups.length} vendors — split PO on email
                </span>
              )}
            </h3>
            <div className="flex items-center gap-2">
              {/* Label sits INLINE beside the control, not above it -
                  FormField always renders its label above, which would flip
                  this to a stacked layout. Left raw. */}
              <label className="flex items-center gap-1.5 text-[11px] text-text-secondary">
                <FileText className="h-3 w-3 text-primary" />
                Auto-fill from PO:
                <SelectField
                  aria-label="Auto-fill from PO"
                  value={linkedPOId || "NONE"}
                  onValueChange={(v) => pickPO(v === "NONE" ? "" : v)}
                  className="rounded-md border border-border bg-surface-light px-1.5 py-0.5 text-[11px] focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary/20"
                  options={[
                    {
                      value: "NONE",
                      label:
                        form.jobId && jobPOs.length === 0
                          ? "— no PO on this job —"
                          : "— pick a PO —",
                    },
                    ...(form.jobId ? jobPOs : openPOs).map((p) => ({
                      value: p.id,
                      label: `${p.poNumber} · ${p.vendor} (${p.lines.length} ln)`,
                    })),
                  ]}
                />
              </label>
              {form.jobId && jobPOs.length > 0 && (
                <span className="inline-flex items-center gap-1 rounded-full bg-success/10 px-1.5 py-0.5 text-[10px] font-semibold text-success ring-1 ring-success/20">
                  <Sparkles className="h-2.5 w-2.5" />
                  {jobPOs.length} PO{jobPOs.length === 1 ? "" : "s"} on this job
                </span>
              )}
              <Button type="button" variant="outline" size="3xs" onClick={addLine}>
                <Plus className="h-3 w-3 text-primary" />
                Add item
              </Button>
            </div>
          </div>

          <div className="space-y-2">
            {lines.map((line) => {
              const itm = allItems.find((i) => i.id === line.itemId);
              return (
                <div
                  key={line.uid}
                  className="grid grid-cols-12 items-end gap-2 rounded-md border border-border bg-surface-light px-2.5 py-2"
                >
                  <div className="col-span-4">
                    <MiniLabel>Item</MiniLabel>
                    <SelectField
                      aria-label="Item"
                      value={line.itemId}
                      onValueChange={(v) => {
                        const newItem = allItems.find((i) => i.id === v);
                        updateLine(line.uid, {
                          itemId: v,
                          vendor: line.vendor || newItem?.vendor || "",
                        });
                      }}
                      className={miniSelectCls}
                      options={allItems
                        .filter((i) => i.kind === "material")
                        .map((i) => ({
                          value: i.id,
                          label: `${i.sku} — ${i.name.slice(0, 36)}`,
                        }))}
                    />
                  </div>
                  <div className="col-span-1">
                    <MiniLabel>Qty</MiniLabel>
                    <Input
                      type="number"
                      min="1"
                      step="1"
                      placeholder="0"
                      value={line.qtyOrdered}
                      onChange={(e) =>
                        updateLine(line.uid, { qtyOrdered: e.target.value })
                      }
                      className={miniInputCls}
                    />
                  </div>
                  <div className="col-span-1">
                    <MiniLabel>UoM</MiniLabel>
                    <div className="rounded-md bg-background-light px-2 py-1.5 text-center text-xs font-mono text-text-secondary">
                      {itm?.uom ?? "EA"}
                    </div>
                  </div>
                  <div
                    className="col-span-3"
                    title="Pick which vendor this item is sourced from — split across vendors to send separate POs to each"
                  >
                    <MiniLabel>Vendor</MiniLabel>
                    <SelectField
                      aria-label="Vendor"
                      value={line.vendor || "NONE"}
                      onValueChange={(v) =>
                        updateLine(line.uid, { vendor: v === "NONE" ? "" : v })
                      }
                      className={miniSelectCls}
                      options={[
                        // If the current value isn't in our vendor table (custom
                        // entry, or a vendor that's been retired), surface it
                        // at the top so the operator can still see + keep it.
                        ...(line.vendor && !allVendors.some((v) => v.name === line.vendor)
                          ? [{ value: line.vendor, label: line.vendor }]
                          : []),
                        { value: "NONE", label: "Pick a vendor…" },
                        ...allVendors
                          .filter((v) => v.id !== "vnd_internal")
                          .map((v) => ({ value: v.name, label: v.name })),
                      ]}
                    />
                  </div>
                  <div className="col-span-1">
                    <MiniLabel>PO #</MiniLabel>
                    <Input
                      value={line.poNumber}
                      onChange={(e) =>
                        updateLine(line.uid, { poNumber: e.target.value })
                      }
                      placeholder="PO-…"
                      className={miniInputCls}
                    />
                  </div>
                  <div className="col-span-2">
                    <MiniLabel>ETA</MiniLabel>
                    <DatePicker
                      value={line.expectedDate}
                      onChange={(v) =>
                        updateLine(line.uid, { expectedDate: v })
                      }
                      inputClassName="h-7 px-1.5 py-1 text-xs"
                    />
                  </div>
                  <Button
                    type="button"
                    variant="ghost"
                    tone="danger"
                    revealOnHover
                    size="3xs"
                    onClick={() => removeLine(line.uid)}
                    disabled={lines.length === 1}
                    title={lines.length === 1 ? "Need at least one item" : "Remove line"}
                    aria-label="Remove line"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </Button>
                </div>
              );
            })}
          </div>
        </div>

        <FormField label="Notes" optional>
          <Textarea
            value={form.notes}
            onChange={(e) => set("notes", e.target.value)}
            rows={2}
            placeholder="Hold for single dispatch · special handling · tech instructions"
            className={`${inputCls} resize-none`}
          />
        </FormField>
      </div>
    </Modal>

    <POPreviewDialog
      open={!!previewPOId}
      onClose={() => setPreviewPOId(null)}
      poId={previewPOId}
      zIndex={80}
      lockEscape
    />

    <POEmailDialog
      open={shipEmailOpen && vendorEmailQueue.length > 0}
      onClose={() => {
        // POEmailDialog.handleSend fires onSent THEN onClose in the same
        // event — if we just sent, swallow this close so the queue doesn't
        // collapse before the next vendor's composer opens.
        if (justSentVendorEmail.current) {
          justSentVendorEmail.current = false;
          return;
        }
        // Real cancel (X / Esc / Cancel button) mid-queue: abort the whole
        // send + do NOT commit the pending stage. The operator backed out
        // before all vendor emails went out, so dropping the stage too keeps
        // the data model consistent.
        setShipEmailOpen(false);
        setVendorEmailQueue([]);
        setVendorEmailIndex(0);
        setPendingShipStage(null);
      }}
      po={vendorEmailQueue[vendorEmailIndex] ?? null}
      zIndex={80}
      lockEscape
      onSent={() => {
        justSentVendorEmail.current = true;
        const nextIdx = vendorEmailIndex + 1;
        if (nextIdx < vendorEmailQueue.length) {
          // More vendors in the queue — advance to the next composer.
          setVendorEmailIndex(nextIdx);
          return;
        }
        // Final send → commit the awaiting-at-warehouse stage and close.
        if (pendingShipStage) {
          createStage.mutate(stagePayload(pendingShipStage));
          onCreate(pendingShipStage);
          setPendingShipStage(null);
        }
        setVendorEmailQueue([]);
        setVendorEmailIndex(0);
        setShipEmailOpen(false);
        reset();
        onClose();
      }}
    />

    </>
  );
}

const inputCls = "w-full px-2.5 py-1.5";

// SelectField isn't a design-system primitive under the layering guard, so it
// keeps its prior appearance verbatim, independent of the now-stripped inputCls.
const selectCls =
  "w-full rounded-md border border-border bg-surface-light px-2.5 py-1.5 text-sm focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/20";

const miniInputCls = "w-full px-1.5 py-1";

// Same decoupling for the compact line-item SelectField cells.
const miniSelectCls =
  "w-full rounded-md border border-border bg-surface-light px-1.5 py-1 text-xs truncate focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary/20";

function MiniLabel({ children }: { children: React.ReactNode }) {
  return (
    <span className="mb-0.5 block text-[9px] font-medium uppercase tracking-wide text-text-secondary">
      {children}
    </span>
  );
}

function techRoleLabel(role: Tech["role"]): string {
  switch (role) {
    case "field_tech":
      return "Field Tech";
    case "warehouse_lead":
      return "Warehouse Lead";
    case "counter":
      return "Counter";
    case "subcontractor":
      return "Subcontractor (1099)";
  }
}
