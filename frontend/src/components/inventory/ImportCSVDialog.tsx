import { useRef, useState } from "react";
import {
  AlertTriangle,
  CheckCircle2,
  FileText,
  Sparkles,
  Upload,
  X,
} from "lucide-react";
import { Modal } from "@/components/ui/modal";
import { SelectField } from "@/components/form/SelectField";
import { autoMapColumns, parseCSV, type ParsedCSV } from "@/lib/inventory/csv";
import type { NewItem } from "@/components/inventory/AddItemDialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

type Props = {
  open: boolean;
  onClose: () => void;
  // Parent persists via useImportItemsCSV().mutate(items) (mock) / POST import (Track 2).
  onImport: (items: NewItem[]) => void;
};

type Mapping = {
  sku: string | null;
  name: string | null;
  category: string | null;
  kind: string | null;
  uom: string | null;
  unitCost: string | null;
  sellPrice: string | null;
  vendor: string | null;
  mpn: string | null;
  upc: string | null;
  serialized: string | null;
  hazmat: string | null;
};

const REQUIRED_FIELDS: (keyof Mapping)[] = ["name"];

const FIELD_LABELS: Record<keyof Mapping, string> = {
  sku: "SKU",
  name: "Item Name",
  category: "Category",
  kind: "Kind",
  uom: "UoM",
  unitCost: "Unit Cost",
  sellPrice: "Sell Price",
  vendor: "Vendor",
  mpn: "MPN",
  upc: "UPC",
  serialized: "Serialized",
  hazmat: "Hazmat",
};

export function ImportCSVDialog({ open, onClose, onImport }: Props) {
  const [parsed, setParsed] = useState<ParsedCSV | null>(null);
  const [fileName, setFileName] = useState<string | null>(null);
  const [mapping, setMapping] = useState<Mapping | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [aiCategorize, setAiCategorize] = useState(true);
  const inputRef = useRef<HTMLInputElement>(null);

  function reset() {
    setParsed(null);
    setFileName(null);
    setMapping(null);
    setError(null);
    setDragOver(false);
    if (inputRef.current) inputRef.current.value = "";
  }

  function handleFile(file: File | null | undefined) {
    if (!file) return;
    if (!/\.csv$/i.test(file.name) && file.type !== "text/csv") {
      setError("Please drop a .csv file.");
      return;
    }
    if (file.size > 20 * 1024 * 1024) {
      setError("CSV is over 20 MB — bulk imports of that size go through the back-office importer.");
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      const text = reader.result as string;
      const p = parseCSV(text);
      if (p.headers.length === 0 || p.rows.length === 0) {
        setError("Could not find any data rows in this CSV.");
        return;
      }
      setParsed(p);
      setFileName(file.name);
      const auto = autoMapColumns(p.headers);
      setMapping(auto as Mapping);
      setError(null);
    };
    reader.onerror = () => setError("Failed to read the file.");
    reader.readAsText(file);
  }

  function updateMapping(field: keyof Mapping, value: string) {
    setMapping((m) =>
      m ? { ...m, [field]: value === "__none__" ? null : value } : m,
    );
  }

  function buildItems(): NewItem[] {
    if (!parsed || !mapping) return [];
    // Item Kind is material|service. The three retired tokens are still ACCEPTED
    // from a CSV - a spreadsheet written last month should not fail to import -
    // but they land on `service`, which is how all three already billed. Any
    // other value keeps the long-standing "material" fallback below.
    const RETIRED_KINDS: Record<string, string> = { labor: "service", bundle: "service", fee: "service" };
    const kindAllowed = new Set(["material", "service"]);
    return parsed.rows.map((r) => {
      const get = (k: keyof Mapping) =>
        mapping[k] ? r[mapping[k] as string] ?? "" : "";
      const kind = get("kind").toLowerCase();
      const serializedRaw = get("serialized").toLowerCase();
      const hazmatRaw = get("hazmat").toLowerCase();
      return {
        sku: get("sku").trim(),
        name: get("name").trim() || "Unnamed Item",
        category: get("category").trim() || "Uncategorized",
        trade: "general",
        kind: RETIRED_KINDS[kind] ?? (kindAllowed.has(kind) ? kind : "material"),
        uom: get("uom").trim() || "EA",
        unitCost: parseFloat(get("unitCost")) || 0,
        sellPrice: parseFloat(get("sellPrice")) || 0,
        serialized: ["y", "yes", "true", "1"].includes(serializedRaw),
        hazmat: ["y", "yes", "true", "1"].includes(hazmatRaw),
        // CSV import never opts an item into stock tracking (Inventory P1 D8 default).
        trackInventory: false,
        vendor: get("vendor").trim() || "—",
        startingStock: [],
      };
    });
  }

  const missingRequired = mapping
    ? REQUIRED_FIELDS.filter((f) => !mapping[f])
    : [];

  function submit() {
    const items = buildItems();
    if (items.length === 0) {
      setError("Nothing to import.");
      return;
    }
    onImport(items);
    reset();
    onClose();
  }

  return (
    <Modal
      open={open}
      onClose={() => {
        reset();
        onClose();
      }}
      title="Import Items from CSV"
      subtitle="Drop a CSV exported from a vendor catalog, Excel, or another FSM tool. AI categorization runs after import."
      size="xl"
      footer={
        parsed ? (
          <>
            <Button variant="outline" size="sm"
              onClick={() => {
                reset();
              }}
            >
              Choose Different File
            </Button>
            <Button size="sm"
              onClick={submit}
              disabled={missingRequired.length > 0}
            >
              Import {parsed.rows.length} item{parsed.rows.length === 1 ? "" : "s"}
            </Button>
          </>
        ) : (
          <Button variant="outline" size="sm"
            onClick={() => {
              reset();
              onClose();
            }}
          >
            Cancel
          </Button>
        )
      }
    >
      {error && (
        <div className="mb-3 flex items-start gap-2 rounded-md border border-danger/20 bg-danger/10 px-3 py-2 text-xs text-danger">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 flex-shrink-0" />
          <span>{error}</span>
        </div>
      )}

      {!parsed ? (
        <div className="flex flex-col gap-3">
          {/* File-drop zone - the whole area IS the control (no visible input
              box, drop target doubles as the click target), the shape
              FormField's own header comment names as not covered by this
              pattern. Left raw. */}
          <label
            onDragOver={(e) => {
              e.preventDefault();
              setDragOver(true);
            }}
            onDragLeave={() => setDragOver(false)}
            onDrop={(e) => {
              e.preventDefault();
              setDragOver(false);
              handleFile(e.dataTransfer.files?.[0]);
            }}
            className={[
              "flex h-56 cursor-pointer flex-col items-center justify-center gap-2 rounded-card border-2 border-dashed text-center transition",
              dragOver
                ? "border-primary bg-primary-subtle"
                : "border-border bg-background-light hover:border-primary hover:bg-primary-subtle/40",
            ].join(" ")}
          >
            <div className="flex h-10 w-10 items-center justify-center rounded-full bg-primary-subtle">
              <Upload className="h-5 w-5 text-primary" />
            </div>
            <p className="text-sm font-semibold text-text-primary">
              Drop CSV here, or click to choose
            </p>
            <p className="text-xs text-text-secondary">
              Up to 20 MB · UTF-8 encoded · header row required
            </p>
            <Input
              ref={inputRef}
              type="file"
              accept=".csv,text/csv"
              className="sr-only"
              onChange={(e) => handleFile(e.target.files?.[0])}
            />
          </label>

          <div className="rounded-md border border-border bg-background-light/40 p-3">
            <p className="text-[11px] font-semibold uppercase tracking-wide text-text-secondary">
              Expected columns (any reasonable header — we'll auto-map)
            </p>
            <div className="mt-1.5 flex flex-wrap gap-1">
              {Object.entries(FIELD_LABELS).map(([k, label]) => (
                <span
                  key={k}
                  className={[
                    "rounded-md px-2 py-0.5 text-[11px] ring-1",
                    REQUIRED_FIELDS.includes(k as keyof Mapping)
                      ? "bg-primary-subtle text-primary ring-primary/20"
                      : "bg-surface-light text-text-secondary ring-border",
                  ].join(" ")}
                >
                  {label}
                  {REQUIRED_FIELDS.includes(k as keyof Mapping) && (
                    <span className="ml-0.5 text-danger">*</span>
                  )}
                </span>
              ))}
            </div>
          </div>

          <details className="rounded-md border border-border px-3 py-2 text-xs">
            <summary className="cursor-pointer font-medium text-text-secondary">
              Need a sample CSV?
            </summary>
            <pre className="mt-2 overflow-x-auto rounded bg-background-dark p-2 text-[10px] text-on-fill/90">
{`SKU,Name,Category,UoM,Unit Cost,Sell Price,Vendor
LCK-NEW-001,Schlage B60 Deadbolt,Locksets,EA,42.00,108.00,ASA / Mul-T-Lock NA
HVC-CAP-30-5,Run Capacitor 30/5 MFD,Capacitors,EA,9.50,32.00,Ferguson HVAC`}
            </pre>
          </details>
        </div>
      ) : (
        <div className="flex flex-col gap-4">
          {/* File summary */}
          <div className="flex items-center justify-between rounded-md border border-success/20 bg-success/10 px-3 py-2">
            <div className="flex items-center gap-2 text-sm">
              <FileText className="h-4 w-4 text-success" />
              <span className="font-mono text-xs text-success">{fileName}</span>
              <span className="text-success">·</span>
              <span className="text-xs text-success">
                {parsed.rows.length} rows · {parsed.headers.length} columns
              </span>
            </div>
            {/* Raw by design: no `success` tone is minted on Button (see
                button.tsx header note - deferred, zero measured call sites);
                a small icon-dismiss affordance inside a status banner. */}
            <button
              onClick={reset}
              className="rounded p-1 text-success hover:bg-success/10"
              title="Choose a different file"
              aria-label="Reset"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </div>

          {/* Column mapping */}
          <div>
            {/* Raw by design: bracket size text-[11px] has no matching Heading scale key. */}
            <h3 className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-text-secondary">
              Column mapping
              <span className="ml-1 inline-flex items-center gap-1 rounded-full bg-primary-subtle px-1.5 py-0.5 text-[10px] font-medium normal-case text-primary ring-1 ring-primary/20">
                <Sparkles className="h-2.5 w-2.5" />
                Auto-detected — review + override
              </span>
            </h3>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-3 gap-y-2 rounded-md border border-border bg-background-light/40 p-3">
              {Object.entries(FIELD_LABELS).map(([k, label]) => {
                const field = k as keyof Mapping;
                const required = REQUIRED_FIELDS.includes(field);
                const value = mapping?.[field];
                const ok = !!value;
                return (
                  <div key={k} className="flex items-center gap-2">
                    <div className="flex-shrink-0 basis-28 text-xs">
                      <span className="font-medium text-text-secondary">{label}</span>
                      {required && <span className="ml-0.5 text-danger">*</span>}
                    </div>
                    <SelectField
                      aria-label={label}
                      value={value ?? "__none__"}
                      onValueChange={(v) => updateMapping(field, v)}
                      className={[
                        "flex-1 rounded-md border bg-surface-light px-2 py-1 text-xs focus:outline-none focus:ring-2 focus:ring-primary-subtle",
                        required && !ok
                          ? "border-danger/20"
                          : ok
                            ? "border-success/20"
                            : "border-border",
                      ].join(" ")}
                      options={[
                        { value: "__none__", label: "— not mapped —" },
                        ...parsed.headers.map((h) => ({ value: h, label: h })),
                      ]}
                    />
                    {ok && (
                      <CheckCircle2 className="h-3.5 w-3.5 flex-shrink-0 text-success" />
                    )}
                  </div>
                );
              })}
            </div>
            {missingRequired.length > 0 && (
              <p className="mt-1.5 text-[11px] text-danger">
                Map {missingRequired.map((f) => FIELD_LABELS[f]).join(", ")}{" "}
                before importing.
              </p>
            )}
          </div>

          {/* Preview */}
          <div>
            {/* Raw by design: bracket size text-[11px] has no matching Heading scale key. */}
            <h3 className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-text-secondary">
              Preview · first 5 rows
            </h3>
            <div className="overflow-x-auto rounded-md border border-border">
              <table className="min-w-full text-xs">
                <thead className="bg-background-light">
                  <tr>
                    {parsed.headers.map((h) => (
                      <th
                        key={h}
                        className="border-b border-border px-2 py-1.5 text-left font-medium text-text-secondary"
                      >
                        {h}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {parsed.rows.slice(0, 5).map((r, idx) => (
                    <tr key={idx} className="border-t border-border">
                      {parsed.headers.map((h) => (
                        <td
                          key={h}
                          className="max-w-[180px] truncate px-2 py-1 text-text-secondary"
                          title={r[h]}
                        >
                          {r[h]}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          {/* AI toggle - checkbox-leads-its-own-label: FormField always
              renders its label ABOVE the control, which would flip this to a
              stacked layout - a real visual change, not a wrapping move.
              Left raw. */}
          <label className="flex items-start gap-2 rounded-md border border-primary/20 bg-primary-subtle/60 px-3 py-2 text-xs">
            <input
              type="checkbox"
              checked={aiCategorize}
              onChange={(e) => setAiCategorize(e.target.checked)}
              className="mt-0.5 h-3.5 w-3.5 rounded border-border text-primary focus:ring-primary"
            />
            <span className="text-text-primary">
              <strong>AI auto-categorize</strong> on import — fills missing
              categories from item name + vendor.
              <span className="ml-1 text-primary">
                Review queue opens after import.
              </span>
            </span>
          </label>
        </div>
      )}
    </Modal>
  );
}
