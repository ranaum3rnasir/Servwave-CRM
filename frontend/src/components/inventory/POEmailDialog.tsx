/**
 * POEmailDialog — REAL vendor send (Inventory P2 §3.8). The prototype's
 * synthetic mailbox machinery (fieldos.io aliases, vendor-domain derivation,
 * branch buyer emails) is gone: recipients come from the vendor record, and
 * Send posts POST /api/inventory/purchase-orders/:id/send — the server flips
 * draft→sent, records the InventoryEmail row, and enforces the org
 * email_sending_enabled toggle (409 when off, surfaced here like estimate send).
 */
import { useEffect, useMemo, useState } from "react";
import { Loader2, Send, X } from "lucide-react";
import { Modal } from "@/components/ui/modal";
import { FormField } from "@/components/patterns/FormField";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { useVendors, useSendPO } from "@/lib/api/inventory";
import { useOrganization } from "@/lib/api/organization";
import type { PurchaseOrder } from "@/lib/api/inventory";
import { toast } from "@/components/ui/use-toast";
import { extractApiError } from "@/lib/utils";
import { formatExactDay } from "@/lib/format-date";
import { Button } from "@/components/ui/button";

type Props = {
  open: boolean;
  onClose: () => void;
  po: PurchaseOrder | null;
  zIndex?: number;
  lockEscape?: boolean;
  onSent: (payload: { to: string[]; subject: string; body: string }) => void;
};

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function POEmailDialog({
  open,
  onClose,
  po,
  zIndex: _zIndex,
  lockEscape,
  onSent,
}: Props) {
  const { data: allVendors = [] } = useVendors();
  const { data: org } = useOrganization();
  const sendPO = useSendPO();

  // Name-join stays until PurchaseOrder.vendorId serializes; then prefer id.
  const vendor = useMemo(
    () =>
      po
        ? (po.vendorId ? allVendors.find((v) => v.id === po.vendorId) : undefined) ??
          allVendors.find((v) => v.name === po.vendor)
        : undefined,
    [po, allVendors],
  );

  // Suggestions = vendor primary contact + additionalContacts that HAVE an email.
  const recipientSuggestions = useMemo(() => {
    if (!vendor) return [];
    const list: { label: string; email: string }[] = [];
    if (vendor.contactEmail) {
      list.push({
        label: `${vendor.contactPersonName ?? vendor.name} (Primary)`,
        email: vendor.contactEmail,
      });
    }
    for (const c of vendor.additionalContacts ?? []) {
      if (c.email) list.push({ label: `${c.name ?? c.email} (${c.role ?? "Contact"})`, email: c.email });
    }
    const seen = new Set<string>();
    return list.filter((r) => {
      if (seen.has(r.email)) return false;
      seen.add(r.email);
      return true;
    });
  }, [vendor]);

  // Proactive disabled state — strictly `=== false`: users without read
  // Organization (query errors) and loading states must NOT disable; the
  // server 409 is the authority, matching estimate send.
  const emailOff = org?.email_sending_enabled === false;

  // === Form state ===
  const [recipients, setRecipients] = useState<string[]>([]);
  const [cc, setCc] = useState<string[]>([]);
  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");
  const [recipientInput, setRecipientInput] = useState("");
  const [ccInput, setCcInput] = useState("");
  const [error, setError] = useState<string | null>(null);

  // Hydrate defaults whenever the PO changes / dialog opens.
  useEffect(() => {
    if (!po || !open) return;
    setRecipients(vendor?.contactEmail ? [vendor.contactEmail] : []);
    setCc([]);
    setSubject(`Purchase Order ${po.poNumber}`);

    const lineSummary = po.lines
      .map(
        (l) =>
          `• ${l.itemSku} — ${l.qtyOrdered} ${l.uom ?? "EA"}${
            l.qtyReceived > 0 ? ` (received ${l.qtyReceived}/${l.qtyOrdered})` : ""
          }`,
      )
      .join("\n");

    // Courtesy note only — the server renders the PO line-item table into the
    // email body (§3.8); no ship-to block here (org address handling belongs to
    // the server).
    setBody(
      [
        `Hello ${po.vendor || "vendor"} team,`,
        ``,
        `Please review purchase order ${po.poNumber} — details are below.`,
        ``,
        `Order date: ${new Date(po.orderedAt).toLocaleDateString()}`,
        po.expectedDate
          ? `Expected by: ${formatExactDay(po.expectedDate)}`
          : ``,
        ``,
        `Lines:`,
        lineSummary,
        ``,
        `Acknowledge receipt of this PO and confirm expected ship date.`,
        ``,
        `Thanks,`,
        `${org?.name ?? "Purchasing"}`,
      ]
        .filter(Boolean)
        .join("\n"),
    );
    setError(null);
    setRecipientInput("");
    setCcInput("");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [po, open, vendor]);

  function addEmail(list: string[], setList: (v: string[]) => void, raw: string) {
    const candidates = raw
      .split(/[,;\s]+/)
      .map((s) => s.trim())
      .filter(Boolean);
    if (!candidates.length) return;
    const bad = candidates.filter((c) => !EMAIL_RE.test(c));
    if (bad.length) {
      setError(`Invalid email: ${bad.join(", ")}`);
      return;
    }
    const next = Array.from(new Set([...list, ...candidates]));
    setList(next);
    setError(null);
  }

  function handleSend() {
    if (!po) return;
    if (!recipients.length) {
      setError("At least one recipient is required.");
      return;
    }
    sendPO.mutate(
      {
        id: po.id,
        to: recipients,
        ...(cc.length > 0 ? { cc } : {}),
        subject,
        message: body,
      },
      {
        onSuccess: () => {
          // Status chip flips to `sent` via the ['inventory'] invalidation —
          // no local status write.
          onSent({ to: recipients, subject, body });
          onClose();
        },
        onError: (err) => {
          // The exact SendEstimateDialog pattern: destructive toast with the
          // server message (the org-disabled 409 arrives from mapEmailFailure
          // semantics), dialog STAYS OPEN.
          toast({
            title: "Purchase order not sent",
            description: extractApiError(err, "Failed to send purchase order"),
            variant: "destructive",
            duration: Infinity,
          });
        },
      },
    );
  }

  function ChipInput({
    label,
    list,
    setList,
    inputValue,
    setInputValue,
    required,
  }: {
    label: string;
    list: string[];
    setList: (v: string[]) => void;
    inputValue: string;
    setInputValue: (v: string) => void;
    required?: boolean;
  }) {
    return (
      <div>
        {/* Not converted to FormField: the chip list + trailing input is a
            compound control with no id of its own to receive fieldProps
            without changing ChipInput's own prop surface, unlike this file's
            plain Subject/Message inputs below. */}
        <label className="mb-1 block text-[10px] font-semibold uppercase tracking-wide text-text-secondary">
          {label} {required && <span className="text-danger">*</span>}
        </label>
        <div className="flex flex-wrap items-center gap-1 rounded-md border border-border bg-surface-light px-2 py-1.5 focus-within:border-primary focus-within:ring-2 focus-within:ring-primary/20">
          {list.map((e) => (
            <span
              key={e}
              className="inline-flex items-center gap-1 rounded bg-background-light px-1.5 py-0.5 text-xs font-medium text-text-secondary"
            >
              {e}
              {/* Deferred: small close-X affordance inside a chip. */}
              <button
                type="button"
                onClick={() => setList(list.filter((x) => x !== e))}
                className="text-text-secondary hover:text-danger"
                title="Remove"
              >
                <X className="h-3 w-3" />
              </button>
            </span>
          ))}
          <Input
            value={inputValue}
            onChange={(e) => setInputValue(e.target.value)}
            onKeyDown={(e) => {
              if (
                e.key === "Enter" ||
                e.key === "," ||
                e.key === ";" ||
                e.key === " "
              ) {
                e.preventDefault();
                addEmail(list, setList, inputValue);
                setInputValue("");
              } else if (
                e.key === "Backspace" &&
                !inputValue &&
                list.length > 0
              ) {
                setList(list.slice(0, -1));
              }
            }}
            onBlur={() => {
              if (inputValue.trim()) {
                addEmail(list, setList, inputValue);
                setInputValue("");
              }
            }}
            placeholder={list.length ? "" : "name@example.com"}
            className="min-w-[10rem] flex-1"
          />
        </div>
      </div>
    );
  }

  if (!po) return null;

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={`Email PO · ${po.poNumber}`}
      subtitle={`To ${po.vendor || "vendor"} — ${po.lines.length} line${po.lines.length === 1 ? "" : "s"}`}
      size="lg"
      lockEscape={lockEscape}
      footer={
        <>
          <Button variant="outline" size="sm"
            onClick={onClose}
            disabled={sendPO.isPending}
          >
            Cancel
          </Button>
          <Button size="sm"
            onClick={handleSend}
            disabled={!recipients.length || sendPO.isPending || emailOff}
          >
            {sendPO.isPending ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Send className="h-3.5 w-3.5" />
            )}
            Send Email ({recipients.length} recipient
            {recipients.length === 1 ? "" : "s"})
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        {emailOff && (
          <div className="rounded-md border border-warning/20 bg-warning/10 px-2.5 py-1.5 text-xs text-warning">
            Email sending is turned off for your organization (Settings → Company Profile).
          </div>
        )}

        {/* Suggested recipients — vendor contacts with an email only. */}
        {recipientSuggestions.length > 0 && (
          <div className="rounded-md border border-primary/20 bg-primary-subtle p-2">
            <p className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-primary">
              Vendor contacts
            </p>
            <div className="flex flex-wrap gap-1">
              {recipientSuggestions.map((r) => {
                const inList = recipients.includes(r.email);
                return (
                  // Deferred: multi-select toggle chip (segmented toggle
                  // shape) — not Button-shaped.
                  <button
                    type="button"
                    key={r.email}
                    onClick={() => {
                      if (inList) {
                        setRecipients(recipients.filter((x) => x !== r.email));
                      } else {
                        setRecipients([...recipients, r.email]);
                      }
                    }}
                    title={r.email}
                    className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium ring-1 ${
                      inList
                        ? "bg-success/10 text-success ring-success/20"
                        : "bg-surface-light text-text-secondary ring-border hover:bg-background-light"
                    }`}
                  >
                    {inList && "✓ "}
                    {r.label}
                  </button>
                );
              })}
            </div>
          </div>
        )}

        <ChipInput
          label="To"
          list={recipients}
          setList={setRecipients}
          inputValue={recipientInput}
          setInputValue={setRecipientInput}
          required
        />

        <ChipInput
          label="Cc"
          list={cc}
          setList={setCc}
          inputValue={ccInput}
          setInputValue={setCcInput}
        />

        {error && (
          <div className="rounded-md border border-danger/20 bg-danger/10 px-2 py-1 text-xs text-danger">
            {error}
          </div>
        )}

        <FormField label="Subject">
          <Input
            value={subject}
            onChange={(e) => setSubject(e.target.value)}
            className="w-full px-2 py-1.5"
          />
        </FormField>

        <FormField label="Message">
          <Textarea
            value={body}
            onChange={(e) => setBody(e.target.value)}
            rows={12}
            className="w-full resize-none px-2 py-1.5"
          />
        </FormField>
      </div>
    </Modal>
  );
}
