import { useEffect, useRef, useState } from "react";
import type React from "react";
import { Camera, Eye, EyeOff, ImagePlus, Plus, Sparkles, Upload, X } from "lucide-react";
import { Modal } from "@/components/ui/modal";
import { UploadedImage } from "@/components/ui/uploaded-image";
import { ImageUploadError, dataUrlBytes, prepareImageUpload } from "@/lib/image-upload";
import { FormField } from "@/components/patterns/FormField";
import { SelectField } from "@/components/form/SelectField";
import {
  adoptServerId,
  defaultVisibilityForKind,
  useLocations,
  type Brand,
  type Category,
  type Item,
  type ItemKind,
  type ItemVisibility,
  type Vendor,
} from "@/lib/api/inventory";
import { useOrganization } from "@/lib/api/organization";
import { extractApiError } from "@/lib/utils";
import { AddVendorDialog } from "@/components/inventory/AddVendorDialog";
import { AddCategoryDialog } from "@/components/inventory/AddCategoryDialog";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

type Props = {
  open: boolean;
  onClose: () => void;
  /** May return a promise - awaited so a rejected save keeps the dialog open
   *  with the typed values instead of discarding them. */
  onSave: (item: NewItem, editId?: string) => unknown;
  vendors: Vendor[];
  /** May return a promise resolving the persisted vendor (its server id is
   *  adopted via adoptServerId); a void-returning caller still compiles. */
  onAddVendor: (vendor: Vendor) => unknown;
  categories: Category[];
  /** Same contract as onAddVendor, for categories. */
  onAddCategory: (category: Category) => unknown;
  /** Price Book Phase A — brand entities for dropdown. */
  brands?: Brand[];
  editItem?: Item | null;
  prefilledCode?: string;       // SKU / UPC / MPN captured from a scan
  /** Optional Modal z-index — bumped when AddItemDialog is opened from inside
   *  another dialog (e.g. NewPODialog) so the layering stacks cleanly. */
  zIndex?: number;
  /** SRVW-91: hide the starting-stock + reserve-levels panel at a mount whose
   *  onSave never persists the item (NewPODialog), so the panel is not theatre. */
  showStartingStock?: boolean;
};

export type NewItem = {
  sku: string;
  /** Manufacturer part number - the UI calls it "Part Number". */
  mpn?: string;
  modelNumber?: string;
  name: string;
  category: string;
  /** FK id of the picked category (when it matches a known category) — lets
   *  persistence callers send category_id while `category` stays display-only. */
  categoryId?: string;
  trade: string;
  kind: string;
  uom: string;
  unitCost: number;
  sellPrice: number;
  serialized: boolean;
  hazmat: boolean;
  /** Inventory P1: deduct stock when added to jobs/invoices (newly added lines only). */
  trackInventory: boolean;
  /** SRVW-90: apply sales tax on estimates and invoices. Optional because
   *  producers that do not carry it (ImportCSVDialog) omit it, and the server
   *  keeps its own `?? true` default for those. */
  taxable?: boolean;
  vendor: string;
  /** FK id of the picked vendor (display name stays in `vendor`). */
  vendorId?: string;
  photoUrl?: string;
  // Price Book Phase A
  brandId?: string;
  visibility?: ItemVisibility;
  startingStock: {
    locationId: string;
    qty: number;
    min?: number;   // reserve / par level — flag low-stock when on-hand falls below
    max?: number;   // reorder cap
  }[];
};

const kindOpts = ["material", "service", "labor", "bundle", "fee"];
const uomOpts = ["EA", "FT", "HR", "ROLL", "KIT", "CYL", "BX"];

export function AddItemDialog({
  open,
  onClose,
  onSave,
  vendors,
  onAddVendor,
  categories,
  onAddCategory,
  brands = [],
  editItem,
  prefilledCode,
  zIndex,
  showStartingStock = true,
}: Props) {
  // zIndex is accepted for prop-API parity with the prototype; the shadcn
  // Dialog adapter manages stacking itself, so it is intentionally not wired.
  void zIndex;
  const { data: locations = [] } = useLocations();
  const { data: org } = useOrganization();
  // SRVW-91: the starting location used to default to the fabricated "loc_wh_main",
  // which matches no real location and would 400 the thresholds endpoint's uuid check.
  const defaultLocId = org?.default_inventory_location_id ?? locations[0]?.id ?? "";
  const isEdit = !!editItem;
  const [form, setForm] = useState({
    sku: "",
    mpn: "",
    modelNumber: "",
    name: "",
    category: "",
    trade: "general",
    kind: "material",
    uom: "EA",
    unitCost: "",
    sellPrice: "",
    serialized: false,
    hazmat: false,
    trackInventory: false,
    taxable: true,
    vendorId: "",
    // Price Book Phase A
    brandId: "",
    visibility: "catalog" as ItemVisibility,
    startingLocId: "",
    startingQty: "",
    startingMin: "",   // reserve / par level
    startingMax: "",   // reorder cap
  });
  const [showAddVendor, setShowAddVendor] = useState(false);
  const [showAddCategory, setShowAddCategory] = useState(false);
  const [photoUrl, setPhotoUrl] = useState<string | null>(null);
  const [photoMeta, setPhotoMeta] = useState<{ name: string; sizeKb: number } | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const uploadRef = useRef<HTMLInputElement>(null);
  const cameraRef = useRef<HTMLInputElement>(null);

  // Pre-fill the form when opening in edit mode, or with a scanned code.
  useEffect(() => {
    if (!open) return;
    if (editItem) {
      const matchedVendor = vendors.find((v) => v.name === editItem.vendor);
      setForm({
        sku: editItem.sku,
        mpn: editItem.mpn ?? "",
        modelNumber: editItem.modelNumber ?? "",
        name: editItem.name,
        category: editItem.category,
        trade: editItem.trade,
        kind: editItem.kind,
        uom: editItem.uom,
        unitCost: editItem.unitCost != null ? String(editItem.unitCost) : "",
        sellPrice: String(editItem.sellPrice),
        serialized: editItem.serialized,
        hazmat: editItem.hazmat,
        trackInventory: editItem.trackInventory ?? false,
        taxable: editItem.taxable ?? true,
        vendorId: matchedVendor?.id ?? "",
        brandId: editItem.brandId ?? "",
        visibility: editItem.visibility ?? defaultVisibilityForKind(editItem.kind),
        startingLocId: "",
        startingQty: "",
        startingMin: "",
        startingMax: "",
      });
      setPhotoUrl(editItem.photoUrl ?? null);
      setPhotoMeta(null);
    } else if (prefilledCode) {
      // Coming from a scan that didn't find a match — pre-fill SKU
      setForm((f) => ({ ...f, sku: prefilledCode.toUpperCase() }));
    }
    setError(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, editItem?.id, prefilledCode]);

  // Locations arrive async, so the starting location falls back to the org default until the
  // user picks one - never overwriting a choice they have made. DERIVED at read time rather
  // than seeded by an effect: an effect repaints once with the select still empty before
  // filling it, and react-hooks/set-state-in-effect rejects the pattern outright.
  const startingLocId = form.startingLocId || defaultLocId;

  async function handleFiles(fileList: FileList | null) {
    const file = fileList?.[0];
    if (!file) return;
    if (!file.type.startsWith("image/")) {
      setError("Photo must be an image (jpg, png, webp, heic).");
      return;
    }
    try {
      // Downscales before storing - the photo rides inline as a data URI, so a
      // raw 10 MB camera shot would be ~13 MB of base64 in the record.
      const dataUrl = await prepareImageUpload(file);
      setPhotoUrl(dataUrl);
      setPhotoMeta({ name: file.name, sizeKb: Math.round(dataUrlBytes(dataUrl) / 1024) });
      setError(null);
    } catch (err) {
      setError(
        err instanceof ImageUploadError
          ? err.message
          : "Couldn't read the file. Try a different image.",
      );
    }
  }

  function clearPhoto() {
    setPhotoUrl(null);
    setPhotoMeta(null);
    if (uploadRef.current) uploadRef.current.value = "";
    if (cameraRef.current) cameraRef.current.value = "";
  }

  function set<K extends keyof typeof form>(k: K, v: (typeof form)[K]) {
    setForm((f) => ({ ...f, [k]: v }));
  }

  function buildSuggestedSku(): string {
    const slug = form.name
      .toUpperCase()
      .replace(/[^A-Z0-9 ]/g, "")
      .split(" ")
      .slice(0, 3)
      .map((w) => w.slice(0, 4))
      .join("-");
    const rand = Math.floor(Math.random() * 900 + 100);
    return `ITM-${slug || "NEW"}-${rand}`;
  }

  function suggestSku() {
    set("sku", buildSuggestedSku());
  }

  function reset() {
    setForm({
      sku: "",
      mpn: "",
      modelNumber: "",
      name: "",
      category: "",
      trade: "general",
      kind: "material",
      uom: "EA",
      unitCost: "",
      sellPrice: "",
      serialized: false,
      hazmat: false,
      trackInventory: false,
      taxable: true,
      vendorId: "",
      brandId: "",
      visibility: "catalog",
      startingLocId: "",
      startingQty: "",
      startingMin: "",
      startingMax: "",
    });
    clearPhoto();
    setError(null);
  }

  // When item kind changes (e.g. material → labor), re-default visibility.
  // Won't override a manual choice the user already made in edit mode if the
  // visibility was set by them, but for new-item flow this gives a smart default.
  function handleKindChange(nextKind: string) {
    setForm((f) => ({
      ...f,
      kind: nextKind,
      visibility: defaultVisibilityForKind(nextKind as ItemKind),
    }));
  }

  // Auto-fill vendor when a brand with a default vendor is picked
  function handleBrandChange(nextBrandId: string) {
    setForm((f) => {
      const brand = brands.find((b) => b.id === nextBrandId);
      const nextVendorId =
        brand?.defaultVendorId && !f.vendorId ? brand.defaultVendorId : f.vendorId;
      return {
        ...f,
        brandId: nextBrandId,
        vendorId: nextVendorId,
      };
    });
  }

  function handleVendorChange(value: string) {
    if (value === "__add_new__") {
      setShowAddVendor(true);
      return;
    }
    set("vendorId", value);
  }

  async function handleVendorCreated(v: Vendor) {
    const saved = adoptServerId(v, await onAddVendor(v));
    set("vendorId", saved.id);
    return saved;
  }

  function handleCategoryChange(value: string) {
    if (value === "__add_new__") {
      setShowAddCategory(true);
      return;
    }
    set("category", value);
  }

  async function handleCategoryCreated(c: Category) {
    const saved = adoptServerId(c, await onAddCategory(c));
    set("category", saved.name);
    return saved;
  }

  async function submit() {
    if (!form.name.trim()) return setError("Name is required.");
    // SRVW-91: reserve levels are stored per (item, location), so a min or max with no
    // location cannot be written at all - say so instead of dropping it silently.
    if ((form.startingMin || form.startingMax) && !startingLocId)
      return setError("Pick a location for the reserve levels.");
    const vendorName =
      vendors.find((v) => v.id === form.vendorId)?.name || "—";
    const finalSku = form.sku.trim() || buildSuggestedSku();
    const categoryName = form.category.trim() || "Uncategorized";
    setSaving(true);
    try {
      await onSave(
        {
          sku: finalSku,
          mpn: form.mpn.trim() || undefined,
          modelNumber: form.modelNumber.trim() || undefined,
          name: form.name.trim(),
          category: categoryName,
          categoryId: categories.find((c) => c.name === categoryName)?.id,
          trade: form.trade,
          kind: form.kind,
          uom: form.uom,
          unitCost: parseFloat(form.unitCost || "0"),
          sellPrice: parseFloat(form.sellPrice || "0"),
          serialized: form.serialized,
          hazmat: form.hazmat,
          trackInventory: form.trackInventory,
          taxable: form.taxable,
          vendor: vendorName,
          vendorId: form.vendorId || undefined,
          photoUrl: photoUrl ?? undefined,
          brandId: form.brandId || undefined,
          visibility: form.visibility,
          startingStock:
            form.startingQty || form.startingMin || form.startingMax
              ? [
                  {
                    locationId: startingLocId,
                    qty: parseInt(form.startingQty || "0", 10),
                    min: form.startingMin ? parseInt(form.startingMin, 10) : undefined,
                    max: form.startingMax ? parseInt(form.startingMax, 10) : undefined,
                  },
                ]
              : [],
        },
        editItem?.id,
      );
      reset();
      onClose();
    } catch (err) {
      setError(extractApiError(err, "Could not save the item - check the fields and try again."));
    } finally {
      setSaving(false);
    }
  }

  const margin =
    form.unitCost && form.sellPrice
      ? Math.round(
          ((parseFloat(form.sellPrice) - parseFloat(form.unitCost)) /
            parseFloat(form.sellPrice)) *
            100,
        )
      : null;

  return (
    <Modal
      open={open}
      onClose={() => {
        reset();
        onClose();
      }}
      lockEscape={showAddVendor || showAddCategory}
      title={isEdit ? `Edit Item · ${editItem!.sku}` : "Add Item to Stock"}
      subtitle={
        isEdit
          ? "Changes are versioned. Stock movements are immutable and are not affected."
          : undefined
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
          <Button size="sm" onClick={submit} disabled={saving}>
            {isEdit ? "Save Changes" : "Save Item"}
          </Button>
        </>
      }
    >
      {error && (
        <div className="mb-3 rounded-md border border-danger/20 bg-danger/10 px-3 py-2 text-xs text-danger">
          {error}
        </div>
      )}

      <div className="grid grid-cols-12 gap-3">
        {/* Photo upload — compact, side-by-side with first fields */}
        <div className="col-span-3 flex flex-col gap-1">
          {/* Caption is a bare span, not a label, and the label below it is a
              drag/drop drop-zone (the whole zone IS the control, no visible
              input box) - a file-drop zone, the shape FormField's own header
              comment names as not covered by this pattern. Left raw. */}
          <span className="text-[11px] font-medium uppercase tracking-wide text-text-secondary">
            Photo
          </span>
          <label
            onDragOver={(e) => {
              e.preventDefault();
              setDragOver(true);
            }}
            onDragLeave={() => setDragOver(false)}
            onDrop={(e) => {
              e.preventDefault();
              setDragOver(false);
              void handleFiles(e.dataTransfer.files);
            }}
            className={[
              "relative flex aspect-square w-full cursor-pointer items-center justify-center overflow-hidden rounded-lg border-2 border-dashed text-center transition",
              dragOver
                ? "border-primary bg-primary-subtle"
                : photoUrl
                  ? "border-success/20 bg-surface-light"
                  : "border-border bg-background-light hover:border-primary hover:bg-primary-subtle/50",
            ].join(" ")}
          >
            {photoUrl ? (
              <>
                <UploadedImage
                  src={photoUrl}
                  alt="Item preview"
                  backdrop
                  className="h-full w-full"
                />
                {/* Raw by design: a close-X affordance overlaid on a photo
                    thumbnail, not Button-shaped. */}
                <button
                  type="button"
                  onClick={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    clearPhoto();
                  }}
                  className="absolute right-1 top-1 rounded-full bg-text-primary/70 p-1 text-on-fill hover:bg-text-primary"
                  aria-label="Remove photo"
                >
                  <X className="h-3 w-3" />
                </button>
              </>
            ) : (
              <div className="flex flex-col items-center gap-1 px-2 text-text-secondary">
                <ImagePlus className="h-5 w-5 text-text-secondary" />
                <p className="text-[10px] leading-tight">
                  Drop image
                  <br />
                  or click
                </p>
              </div>
            )}
            <Input
              ref={uploadRef}
              type="file"
              accept="image/*"
              className="sr-only"
              onChange={(e) => void handleFiles(e.target.files)}
            />
          </label>
          <div className="flex gap-1">
            {/* Raw by design (both buttons below): outline/neutral sets no
                idle text colour and nothing in this row's ambient wrapper
                supplies one, so converting would silently render this muted
                text-secondary label near-black. */}
            <button
              type="button"
              onClick={() => uploadRef.current?.click()}
              className="inline-flex flex-1 items-center justify-center gap-1 rounded-md border border-border bg-surface-light px-1.5 py-1 text-[11px] font-medium text-text-secondary hover:bg-background-light"
              title="Upload photo"
            >
              <Upload className="h-3 w-3 text-text-secondary" />
              Upload
            </button>
            <button
              type="button"
              onClick={() => cameraRef.current?.click()}
              className="inline-flex flex-1 items-center justify-center gap-1 rounded-md border border-border bg-surface-light px-1.5 py-1 text-[11px] font-medium text-text-secondary hover:bg-background-light"
              title="Take photo (camera on mobile)"
            >
              <Camera className="h-3 w-3 text-primary" />
              Camera
            </button>
            <Input
              ref={cameraRef}
              type="file"
              accept="image/*"
              capture="environment"
              className="sr-only"
              onChange={(e) => void handleFiles(e.target.files)}
            />
          </div>
          {photoMeta && (
            <p className="truncate text-[10px] text-text-secondary">
              ✓ {photoMeta.name}
              <span className="ml-1 text-text-secondary">· {photoMeta.sizeKb} KB</span>
            </p>
          )}
        </div>

        {/* Right column — compact 4-column grid for the rest */}
        <div className="col-span-9 grid grid-cols-2 sm:grid-cols-4 gap-3">
          {/* SKU + Vendor */}
          <div className="col-span-2">
            <FormField label="SKU">
              {/* Render-prop: Input + "Suggest" button, a compound pair
                  cloneElement can't target - fieldProps lands on the Input. */}
              {(fieldProps) => (
                <div className="flex gap-1">
                  <Input
                    {...fieldProps}
                    value={form.sku}
                    onChange={(e) => set("sku", e.target.value.toUpperCase())}
                    placeholder="Auto-generated if blank"
                    className="flex-1 px-2.5 py-1.5"
                  />
                  {/* Raw by design: bg-background-light with a no-op hover (idle
                      and hover states are identical) - no minted outline cell
                      matches (outline/neutral carries bg-surface-light), and the
                      visible "Suggest" label's idle text-secondary would also go
                      unset under outline/neutral. */}
                  <button
                    type="button"
                    onClick={suggestSku}
                    title="Suggest SKU from name"
                    className="flex items-center gap-1 rounded-md border border-border bg-background-light px-2 text-xs text-text-secondary hover:bg-background-light"
                  >
                    <Sparkles className="h-3 w-3 text-primary" />
                    Suggest
                  </button>
                </div>
              )}
            </FormField>
          </div>
          {/* SelectField's Radix Select ROOT forwards no id to its trigger -
              a known gap (FormField.tsx's header comment). Kept as
              SelectField, not a raw Select/SelectTrigger: the layering guard
              resolves literal/local-const classNames, and this control's
              hard/soft classes would redden the ratchet if handed straight
              to SelectTrigger (a components/ui export) instead of through
              SelectField, which the guard does not govern. render-prop is
              still needed here (not cloneElement) for the "add vendor"
              button + conditional preview block sitting alongside the
              Select - fieldProps go unused since SelectField has nowhere to
              receive them. */}
          <div className="col-span-2">
            <FormField label="Vendor / Source">
              {() => (
                <>
                  <div className="flex min-w-0 gap-1">
                    <SelectField
                      aria-label="Vendor / Source"
                      value={form.vendorId || "NONE"}
                      onValueChange={(v) => handleVendorChange(v === "NONE" ? "" : v)}
                      className="min-w-0 flex-1 truncate rounded-md border border-border bg-surface-light px-2.5 py-1.5 text-sm focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/10"
                      options={[
                        { value: "NONE", label: "Select vendor…" },
                        ...vendors.map((v) => ({
                          value: v.id,
                          label: `${v.name}${v.category ? ` · ${v.category}` : ""}`,
                        })),
                        { value: "__separator__", label: "──────────", disabled: true },
                        { value: "__add_new__", label: "+ Add new vendor…" },
                      ]}
                    />
                    {/* Raw by design: bg-background-light with a no-op hover (idle
                        and hover states are identical) - no minted outline cell
                        matches (outline/neutral carries bg-surface-light). */}
                    <button
                      type="button"
                      onClick={() => setShowAddVendor(true)}
                      title="Add a new vendor"
                      aria-label="Add new vendor"
                      className="flex flex-shrink-0 items-center justify-center rounded-md border border-border bg-background-light px-2 text-text-secondary hover:bg-background-light"
                    >
                      <Plus className="h-3.5 w-3.5 text-primary" />
                    </button>
                  </div>
                  {form.vendorId && form.vendorId !== "__add_new__" && (
                    <VendorPreview
                      vendor={vendors.find((v) => v.id === form.vendorId)}
                    />
                  )}
                </>
              )}
            </FormField>
          </div>

        <div className="col-span-4">
          <FormField label="Item Name" required>
            <Input
              value={form.name}
              onChange={(e) => set("name", e.target.value)}
              placeholder="e.g. Dual Run Capacitor 45/5 MFD 440V"
              className="px-2.5 py-1.5"
            />
          </FormField>
        </div>

        {/* Manufacturer identifiers - what a tech reads off the box. `mpn` is
            the existing column (CSV import, Items search and the barcode
            scanner already match on it); it just had no form field until now.
            Model number is its own column: a part number and a model number
            differ routinely and both get quoted back to vendors on a PO. */}
        <div className="col-span-2">
          <FormField label="Model Number">
            <Input
              value={form.modelNumber}
              onChange={(e) => set("modelNumber", e.target.value)}
              placeholder="e.g. MT5+"
              className="px-2.5 py-1.5"
            />
          </FormField>
        </div>
        <div className="col-span-2">
          <FormField label="Part Number" hint="Manufacturer part number (MPN).">
            <Input
              value={form.mpn}
              onChange={(e) => set("mpn", e.target.value)}
              placeholder="e.g. 114"
              className="px-2.5 py-1.5"
            />
          </FormField>
        </div>

        {/* SelectField's Radix Select ROOT forwards no id to its trigger - a
            known gap (FormField.tsx's header comment). Kept as SelectField
            rather than a raw Select/SelectTrigger: the layering guard
            resolves literal/local-const classNames, and this control's
            hard/soft classes would redden the ratchet if handed straight to
            SelectTrigger (a components/ui export) instead of through
            SelectField, which the guard does not govern. The wrapping div
            (Select + "add category" button) is a single element, so it still
            goes through cloneElement - the generated id lands on the div,
            unused, same as the SelectField case above it. */}
        <div className="col-span-2">
          <FormField label="Category">
            <div className="flex min-w-0 gap-1">
              <SelectField
                aria-label="Category"
                value={form.category || "NONE"}
                onValueChange={(v) => handleCategoryChange(v === "NONE" ? "" : v)}
                className="min-w-0 flex-1 truncate rounded-md border border-border bg-surface-light px-2.5 py-1.5 text-sm focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/10"
                options={[
                  { value: "NONE", label: "Select category…" },
                  ...categories.map((c) => ({ value: c.name, label: c.name })),
                  { value: "__separator__", label: "──────────", disabled: true },
                  { value: "__add_new__", label: "+ Add new category…" },
                ]}
              />
              {/* Raw by design: bg-background-light with a no-op hover (idle
                  and hover states are identical) - no minted outline cell
                  matches (outline/neutral carries bg-surface-light). */}
              <button
                type="button"
                onClick={() => setShowAddCategory(true)}
                title="Add a new category"
                aria-label="Add new category"
                className="flex flex-shrink-0 items-center justify-center rounded-md border border-border bg-background-light px-2 text-text-secondary hover:bg-background-light"
              >
                <Plus className="h-3.5 w-3.5 text-primary" />
              </button>
            </div>
          </FormField>
        </div>

        {/* SelectField's Radix Select ROOT forwards no id to its trigger - a
            known gap (FormField.tsx's header comment). Kept as SelectField,
            not a raw Select/SelectTrigger: the layering guard resolves
            literal classNames, and this control's hard/soft classes would
            redden the ratchet if handed straight to SelectTrigger (a
            components/ui export) instead of through SelectField, which the
            guard does not govern. */}
        {/* SRVW-90: `type` (SERVICE|MATERIAL) is a server-side projection of
            this control, surfaced read-only so there is no second control the
            two columns can contradict each other through. */}
        <FormField
          label="Item Kind"
          hint={`Bills as ${form.kind === "material" ? "Material" : "Service"} on estimates, jobs and invoices.`}
        >
          <SelectField
            aria-label="Item kind"
            value={form.kind}
            onValueChange={handleKindChange}
            className="w-full rounded-md border border-border bg-surface-light px-2.5 py-1.5 text-sm focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/10"
            options={kindOpts.map((k) => ({ value: k, label: k }))}
          />
        </FormField>
        <FormField label="Unit of Measure">
          <SelectField
            aria-label="Unit of measure"
            value={form.uom}
            onValueChange={(v) => set("uom", v)}
            className="w-full rounded-md border border-border bg-surface-light px-2.5 py-1.5 text-sm focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/10"
            options={uomOpts.map((u) => ({ value: u, label: u }))}
          />
        </FormField>

        {/* Price Book Phase A — Brand · Visibility (PRD §6.A.7 rev 2026-05-28).
            Group was removed in the 2026-05-28 Item Groups redesign — Groups
            now mean preset bundles, not product families, so items don't
            reference them anymore. */}
        <div className="col-span-4 rounded-card border border-primary/20 bg-primary-subtle/30 p-3">
          <div className="mb-2 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-primary">
            <ImagePlus className="h-3 w-3" />
            Price Book — Brand · Visibility
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            {/* SelectField's Radix Select ROOT forwards no id to its
                trigger - a known gap (FormField.tsx's header comment). Kept
                as SelectField, not a raw Select/SelectTrigger: the layering
                guard resolves literal classNames, and this control's
                hard/soft classes would redden the ratchet if handed straight
                to SelectTrigger (a components/ui export) instead of through
                SelectField, which the guard does not govern. */}
            <FormField label="Brand">
              <SelectField
                aria-label="Brand"
                value={form.brandId || "NONE"}
                onValueChange={(v) => handleBrandChange(v === "NONE" ? "" : v)}
                className="w-full rounded-md border border-border bg-surface-light px-2.5 py-1.5 text-sm focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/10"
                options={[
                  { value: "NONE", label: "— none —" },
                  ...brands
                    .filter((b) => b.isActive !== false)
                    .map((b) => ({ value: b.id, label: b.name })),
                ]}
              />
            </FormField>
            {/* Segmented button toggle, not an input/select control -
                FormField's own header comment names this shape (a RadioRow-
                like group) as outside this pass's coverage. Left raw. */}
            <Field label="Visibility">
              <div className="flex gap-1 rounded-md border border-border bg-surface-light p-0.5">
                {/* Raw by design (both buttons below): a segmented toggle
                    control, not Button-shaped. */}
                <button
                  type="button"
                  onClick={() => set("visibility", "catalog")}
                  className={[
                    "flex flex-1 items-center justify-center gap-1 rounded px-2 py-1 text-xs font-medium transition",
                    form.visibility === "catalog"
                      ? "bg-primary text-on-fill shadow-sm"
                      : "text-text-secondary hover:bg-background-light",
                  ].join(" ")}
                  title="Show in customer-facing catalog"
                >
                  <Eye className="h-3 w-3" />
                  Catalog
                </button>
                <button
                  type="button"
                  onClick={() => set("visibility", "internal_only")}
                  className={[
                    "flex flex-1 items-center justify-center gap-1 rounded px-2 py-1 text-xs font-medium transition",
                    form.visibility === "internal_only"
                      ? "bg-text-primary text-on-fill shadow-sm"
                      : "text-text-secondary hover:bg-background-light",
                  ].join(" ")}
                  title="Hide from customer-facing surfaces (labor, fees, internal SKUs)"
                >
                  <EyeOff className="h-3 w-3" />
                  Internal
                </button>
              </div>
            </Field>
          </div>
          <div className="mt-2 text-[10px] leading-snug text-text-secondary">
            <span className="font-medium">Photo upload + customer-facing copy</span> (marketing name, description, key features) ship in Phase B.
          </div>
        </div>

        <div className="col-span-2">
          <FormField label="Unit Cost ($)">
            <Input
              value={form.unitCost}
              onChange={(e) => set("unitCost", e.target.value)}
              type="number"
              step="0.01"
              placeholder="0.00"
              className="px-2.5 py-1.5"
            />
          </FormField>
        </div>
        <div className="col-span-2">
          <FormField label="Sell Price ($)">
            {/* Render-prop: Input + a conditional margin badge, a compound
                pair cloneElement can't target - fieldProps lands on the Input. */}
            {(fieldProps) => (
              <div className="flex items-center gap-2">
                <Input
                  {...fieldProps}
                  value={form.sellPrice}
                  onChange={(e) => set("sellPrice", e.target.value)}
                  type="number"
                  step="0.01"
                  placeholder="0.00"
                  className="flex-1 px-2.5 py-1.5"
                />
                {margin !== null && (
                  <span
                    className={[
                      "rounded-md px-2 py-1 font-mono text-xs font-semibold",
                      margin > 30
                        ? "bg-success/10 text-success"
                        : margin > 0
                          ? "bg-warning/10 text-warning"
                          : "bg-danger/10 text-danger",
                    ].join(" ")}
                    title="Gross margin"
                  >
                    {margin}% GM
                  </span>
                )}
              </div>
            )}
          </FormField>
        </div>

          {/* Checkbox-leads-its-own-label rows: FormField always renders its
              label ABOVE the control, which would flip these to a stacked
              layout - a real visual change, not a wrapping move. Left raw. */}
          <div className="col-span-4 flex flex-wrap items-center gap-4 rounded-md bg-background-light px-3 py-2">
            <label className="flex items-center gap-2 text-xs font-medium text-text-secondary">
              <input
                type="checkbox"
                checked={form.serialized}
                onChange={(e) => set("serialized", e.target.checked)}
                className="h-4 w-4 rounded border-border text-primary focus:ring-primary"
              />
              Serialized (force serial capture at install)
            </label>
            <label className="flex items-center gap-2 text-xs font-medium text-text-secondary">
              <input
                type="checkbox"
                checked={form.hazmat}
                onChange={(e) => set("hazmat", e.target.checked)}
                className="h-4 w-4 rounded border-border text-primary focus:ring-primary"
              />
              Hazmat (link SDS, restrict transport)
            </label>
            <label className="flex items-center gap-2 text-xs font-medium text-text-secondary">
              <input
                type="checkbox"
                checked={form.trackInventory}
                onChange={(e) => set("trackInventory", e.target.checked)}
                className="h-4 w-4 rounded border-border text-primary focus:ring-primary"
              />
              Track inventory
            </label>
            {/* SRVW-90. Rendered through the Checkbox + Label primitives rather
                than the raw label/input pair its three siblings use: the
                component-api guard's raw-tag ratchet for `label` and `input` is
                at floor, so a fourth raw pair would redden CI. The label is
                styled through Label's own prop vocabulary (a literal className
                on a components/ui export would redden the layering guard, which
                is also at floor) - `weight` mints no `medium`, so this row is
                font-semibold where the siblings are font-medium. */}
            <div className="flex items-center gap-2 text-xs font-medium text-text-secondary">
              <Checkbox
                id="item-taxable"
                checked={form.taxable}
                onCheckedChange={(v) => set("taxable", v === true)}
              />
              <Label htmlFor="item-taxable" size="xs" tone="subtle" weight="semibold">
                Taxable (apply sales tax on estimates and invoices)
              </Label>
            </div>
            <p className="w-full text-[10px] leading-snug text-text-secondary">
              Track inventory: deducts stock when added to jobs/invoices.
            </p>
          </div>
        </div>
        {/* /col-span-9 right column */}

        {/* Nested AddVendor + AddCategory dialogs */}
        <AddVendorDialog
          open={showAddVendor}
          onClose={() => setShowAddVendor(false)}
          onCreate={handleVendorCreated}
        />
        <AddCategoryDialog
          open={showAddCategory}
          onClose={() => setShowAddCategory(false)}
          onCreate={handleCategoryCreated}
        />

        {/* Starting stock + reserve levels - hidden in edit mode (stock changes go through
            movements/transfers), and at any mount whose onSave never persists the item
            (showStartingStock={false}, SRVW-91). */}
        {isEdit || !showStartingStock ? null : (
        <div className="col-span-12 rounded-md border border-border bg-background-light/50 p-3">
          <div className="mb-2 flex items-baseline justify-between gap-2">
            <span className="text-xs font-semibold uppercase tracking-wide text-text-secondary">
              Optional · Starting Stock + Reserve Levels
            </span>
            <span className="text-[10px] text-text-secondary">
              Reserve = the amount you want to keep on hand at all times
            </span>
          </div>
          <div className="grid grid-cols-12 gap-2">
            {/* SelectField's Radix Select ROOT forwards no id to its
                trigger - a known gap (FormField.tsx's header comment). Kept
                as SelectField, not a raw Select/SelectTrigger: the layering
                guard resolves literal classNames, and this control's
                hard/soft classes would redden the ratchet if handed straight
                to SelectTrigger (a components/ui export) instead of through
                SelectField, which the guard does not govern. */}
            <div className="col-span-4">
              <FormField label="Location">
                <SelectField
                  aria-label="Starting stock location"
                  value={startingLocId}
                  onValueChange={(v) => set("startingLocId", v)}
                  className="w-full rounded-md border border-border bg-surface-light px-2.5 py-1.5 text-sm focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/10"
                  options={locations.map((l) => ({ value: l.id, label: l.name }))}
                />
              </FormField>
            </div>
            <div className="col-span-2">
              <FormField label="Starting Qty">
                <Input
                  value={form.startingQty}
                  onChange={(e) => set("startingQty", e.target.value)}
                  type="number"
                  step="1"
                  min="0"
                  placeholder="0"
                  className="px-2.5 py-1.5"
                />
              </FormField>
            </div>
            <div className="col-span-2">
              <FormField label="Min · Reserve">
                <Input
                  value={form.startingMin}
                  onChange={(e) => set("startingMin", e.target.value)}
                  type="number"
                  step="1"
                  min="0"
                  placeholder="0"
                  title="Alert when on-hand falls below this number"
                  className="px-2.5 py-1.5"
                />
              </FormField>
            </div>
            <div className="col-span-2">
              <FormField label="Max · Reorder Cap">
                <Input
                  value={form.startingMax}
                  onChange={(e) => set("startingMax", e.target.value)}
                  type="number"
                  step="1"
                  min="0"
                  placeholder="—"
                  title="Stop replenishing when this number is reached"
                  className="px-2.5 py-1.5"
                />
              </FormField>
            </div>
            <div className="col-span-2 flex items-end">
              <p className="text-[10px] leading-tight text-text-secondary">
                <code>min</code> drives the low-stock badge.
                <br />
                <code>max</code> caps auto-replenish suggestions.
              </p>
            </div>
          </div>
        </div>
        )}
      </div>
    </Modal>
  );
}

function Field({
  label,
  required,
  className,
  children,
}: {
  label: string;
  required?: boolean;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <label className={`flex flex-col gap-1 ${className ?? ""}`}>
      <span className="text-[11px] font-medium uppercase tracking-wide text-text-secondary">
        {label}
        {required && <span className="ml-0.5 text-danger">*</span>}
      </span>
      {children}
    </label>
  );
}

function VendorPreview({ vendor }: { vendor?: Vendor }) {
  if (!vendor) return null;
  return (
    <div className="mt-1 grid grid-cols-3 gap-2 rounded-md bg-background-light px-2.5 py-1.5 text-[10px]">
      <div>
        <span className="block uppercase tracking-wide text-text-secondary">
          Terms
        </span>
        <span className="font-medium text-text-secondary">
          {vendor.paymentTerms}
        </span>
      </div>
      <div>
        <span className="block uppercase tracking-wide text-text-secondary">
          Lead
        </span>
        <span className="font-medium text-text-secondary">
          {vendor.leadTimeDays} d
        </span>
      </div>
      <div>
        <span className="block uppercase tracking-wide text-text-secondary">
          PO via
        </span>
        <span className="font-medium uppercase text-text-secondary">
          {vendor.transmitMethod}
        </span>
      </div>
    </div>
  );
}
