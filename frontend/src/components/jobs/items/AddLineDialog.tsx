/**
 * AddLineDialog — add a line item via a single "find-or-create" search (like creating a
 * customer from a lead); also doubles as the EDIT dialog for an existing line (Stage 4).
 *
 *   1. Type in the search box → matching price-book items appear (with thumbnails).
 *   2. Pick one → confirm quantity → Add (snapshots the catalog item onto the invoice).
 *   3. If nothing matches → "Add new item: <text>" → a compact new-item form (Name / Description /
 *      Quantity / Selling price / Markup % / Unit cost / Type / Taxable). By default the new item
 *      is invoice-only (price_book_item_id stays null — the price book is untouched). Admin/
 *      Dispatcher may toggle "Save to price book" to persist a reusable catalog item.
 *
 * Markup %/Unit cost sync (both the new-item form AND the edit form below): Unit price and
 * Markup % are both freely editable. WHILE Markup % holds a valid value (> -100, avoiding a
 * divide-by-zero/negative-cost blowup), Unit cost is DERIVED — unit_cost = unit_price / (1 +
 * markup_percent / 100) — and its input is disabled with a "Synced from markup" hint. Once
 * Markup % is cleared (or holds an unusable value), Unit cost reverts to a normal, freely-
 * editable input. This mirrors — but is NOT the same computation as — LineItemRow's per-row
 * margin sub-line (margin % = (price − cost) / price × 100): both are legitimate readouts of
 * the same three numbers (price/cost/markup), read in different directions.
 *
 * The 4-up grid (Quantity · Selling price · Markup % · Unit cost) always renders all four
 * columns in BOTH forms (v12 SECTION 04 shows them unconditionally) — `canSeePricing` no longer
 * removes the Markup %/Unit cost columns outright (that was the anti-pattern the v12 plan named
 * for replacement: collapsing to a 2-column grid and hiding the whole row for non-pricing
 * users). Instead, only the sensitive VALUES are masked when `canSeePricing` is false: both
 * inputs render disabled with a blank, placeholder value, so the layout never shifts between
 * roles and a non-pricing user can neither read nor blind-set cost data (the backend already
 * strips `unit_cost`/`markup_percent` from such a user's own line data, so this is UI-layer
 * masking on top of a real server-side gate, not the only thing standing between them and the
 * numbers). Submitting also validates them when visible (mirrors Quantity/Selling price's
 * existing validate-then-setError pattern): Markup % must land in the backend's accepted
 * [0, 100] range, and Unit cost (when not derived) must be non-negative — a blank field is
 * always valid, and on the edit form specifically means "leave the previous value alone"
 * rather than silently nulling it out on save.
 *
 * EDIT mode (`editingLine` set): the dialog bypasses the search/selected/creatingNew flow
 * entirely and opens directly into an edit form pre-filled from the line (no "pick from price
 * book" step). Submitting calls `onUpdate(editingLine.id, patch)` with a DIFF patch — only the
 * fields whose value actually changed relative to `editingLine`. The add-flow (search / selected /
 * creatingNew) is untouched and unreachable while `editingLine` is set.
 *
 * Description (v12): both forms carry a Description textarea in addition to Name — the two are
 * joined the same way `LineItemRow`'s `splitDescription()` reads them back apart (`name\ndetail`)
 * so a filled-in Description actually shows up in the table instead of the row rendering blank.
 *
 * Save to price book (both forms): a toggle that creates a fresh, standalone `PriceBookItem` from
 * the form's current Name/Type/Price/Taxable — gated on `canSaveToPriceBook`, default OFF, no
 * caption. On the EDIT form this only ADDS a new catalog entry; it never rewrites the line's own
 * `price_book_item_id` (that link is set once at creation and is immutable here — editing a line's
 * fields never silently re-points it at a different catalog row).
 *
 * Delete (edit form only): a left-aligned ghost-danger footer button that calls the optional
 * `onDelete(lineId)` prop directly (no confirm step, matching the row's own trash-icon precedent
 * in `LineItemRow.tsx`). Rendered ONLY when a caller actually supplies `onDelete` — absent, not
 * disabled, until a wiring wave threads a real delete handler through (mirrors this file's existing
 * `canSeePricing`/`canSaveToPriceBook` absent-not-disabled gating philosophy).
 *
 * On submit (add flow), calls onAdd(payload) with the AddLineItemPayload for
 * POST /api/invoices/:id/line-items. The dialog stays open if the parent rejects — it closes on
 * success (driven by the parent clearing addOpen/editingLine, mirroring the existing convention).
 *
 * Estimate extensions (v12 Wave 3) — all optional, all default OFF, so Job/Invoice (which never
 * pass them) render byte-for-byte the same as before:
 *   - `initialQuery` — jumps straight into the creatingNew form pre-filled with this text (same
 *     state `startCreate()` would set) instead of opening on the blank search screen. This is
 *     what lets `PriceBookPicker`'s "Add new item: <query>" card hand its typed query straight
 *     through to this modal rather than reopening blank (the deferred gap noted in that file).
 *   - `extraCreateContent` — an opaque slot rendered inside the create form only (right under
 *     Description), so Estimate can drop in its existing, real `AiImagePanel` (image suggestions
 *     already backed by `getAiImageSuggestions`) without this file importing anything estimate-
 *     specific. Deliberately NOT offered on the edit form or paired with any "Polish" affordance —
 *     the old estimate dialog's text "Polish"/"Write" buttons were preview-only/unbacked by a real
 *     model, which this program's no-fake-button rule excludes from the new shared modal entirely.
 */
import { useEffect, useState, type ReactNode } from 'react';
import { Search, Loader2, Plus, Package, Trash2 } from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { LINE_DESCRIPTION_MAX, combineDescription } from '@/lib/lineItems';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { cn, extractApiError, formatCurrency } from '@/lib/utils';
import { ProductThumb } from './ProductThumb';
import { toNum } from './money';
import {
  searchPriceBookItems,
  listPriceBookItems,
  createPriceBookItem,
  type AddLineItemPayload,
  type UpdateLineItemPayload,
  type PriceBookItem,
} from '@/lib/api/invoices';
import type { InvoiceLineItem } from '@/lib/api/jobs';

export interface AddLineDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onAdd: (payload: AddLineItemPayload) => Promise<void> | void;
  loading?: boolean;
  /** When true, the "Also save to price book" option is offered (Admin/Dispatcher). */
  canSaveToPriceBook?: boolean;
  /**
   * Reveal the Markup %/Unit cost VALUES (both the new-item form and the edit form). Mirrors the
   * backend's canSeePricing gate. The two fields' columns always render (v12 SECTION 04 — the
   * 4-up grid never collapses); when this is false, the fields themselves render disabled with
   * their value masked blank rather than being removed from the layout. Defaults to false
   * (fail-closed) so a caller that forgets to thread this through never over-shows pricing.
   */
  canSeePricing?: boolean;
  /**
   * When set, the dialog opens DIRECTLY into an edit form pre-filled from this existing line —
   * the search/selected/creatingNew flow is bypassed entirely (no "pick from price book" step).
   */
  editingLine?: InvoiceLineItem | null;
  /** Called instead of onAdd when editingLine is set — receives a diff patch (changed fields only). */
  onUpdate?: (lineId: string, patch: UpdateLineItemPayload) => Promise<void> | void;
  /**
   * Deletes the line currently being edited. Only meaningful with `editingLine` set. The
   * edit-mode footer's Delete button renders ONLY when this is provided (absent, not disabled,
   * until a wiring wave threads a real delete handler through — v12 SECTION 04).
   */
  onDelete?: (lineId: string) => Promise<void> | void;
  /**
   * When set (and `editingLine` is not), the dialog skips the blank search screen and opens
   * DIRECTLY into the creatingNew form pre-filled with this text as the new item's Name (search
   * box is pre-filled too, so "Back to search" still shows matching results for it). This is how
   * `PriceBookPicker`'s "Add new item: <query>" card hands its typed query through to this same
   * modal instead of it reopening blank. Ignored while `editingLine` is set. Defaults to
   * undefined (off) — omitting it keeps today's Job/Invoice "open on blank search" behavior.
   */
  initialQuery?: string;
  /**
   * Opaque content rendered inside the create form only, directly under Description — a slot for
   * Estimate to inject its own existing `AiImagePanel` (real image suggestions) without this file
   * importing estimate code. Not offered on the edit form. No AI "Polish" affordance belongs here
   * — that stayed unbacked-by-a-real-model in the legacy estimate dialog and is excluded here.
   */
  extraCreateContent?: ReactNode;
}

/**
 * `UpdateLineItemPayload`/`AddLineItemPayload` (frontend/src/lib/api/invoices.ts) don't declare
 * `description` yet — Job's PATCH endpoint already accepts it (job-lines.controller.ts's
 * updateLineSchema), Invoice's doesn't yet (invoice-lines.controller.ts's updateLineSchema is
 * missing the field). Widening both payload types locally (rather than editing those shared
 * files, out of this component's scope) keeps the outgoing request correctly typed and lets
 * `description` flow through once the shared type/backend catch up.
 */
type LineUpdatePatch = UpdateLineItemPayload & { description?: string };
type LineAddPayload = AddLineItemPayload;

/** unit_cost = unit_price / (1 + markup_percent / 100). Caller guards markupPercent > -100. */
function deriveCostFromMarkup(unitPrice: number, markupPercent: number): number {
  return unitPrice / (1 + markupPercent / 100);
}

/** Local mirror of LineItemRow.tsx's splitDescription — first line is the item name, rest is detail. */
function splitDescription(description: string): { name: string; detail: string } {
  const parts = description.split('\n');
  return { name: parts[0] || '', detail: parts.slice(1).join('\n') };
}

/**
 * Name and Description share ONE stored field (`name\ndetail`), so the budget has to be measured
 * on the combined string the API will actually receive - a counter on the textarea alone would
 * disagree with the server by the length of the name (#1604). Returns a friendly message, or
 * null when the description fits.
 */
function validateDescriptionLength(name: string, detail: string): string | null {
  const length = combineDescription(name, detail).length;
  if (length <= LINE_DESCRIPTION_MAX) return null;
  return `Description is too long: ${length.toLocaleString()} of ${LINE_DESCRIPTION_MAX.toLocaleString()} characters. The item name counts toward this limit.`;
}

/**
 * Validates Markup %/Unit cost before submit — shared by BOTH the new-item form and the edit
 * form (same fields, same rules). Mirrors Quantity/Selling price's existing validate-then-
 * setError pattern: returns a friendly error string, or null when the fields are acceptable.
 * A blank field is always valid here (never an error) — an empty Markup %/Unit cost simply
 * means "not set" (new-item form) or "no change" (edit form; see handleSubmit's nextMarkup/
 * nextCost, which treat a blank field as leaving the previous value alone rather than silently
 * nulling it out).
 */
function validatePricingFields(
  newMarkup: string,
  markupNum: number | null,
  costIsDerived: boolean,
  newCost: string,
): string | null {
  // Markup % — matches the backend's addLineSchema/updateLineSchema z.number().min(0).max(100).
  if (newMarkup.trim() !== '' && (markupNum == null || Number.isNaN(markupNum) || markupNum < 0 || markupNum > 100)) {
    return 'Markup % must be between 0 and 100.';
  }
  // Unit cost — only user-editable (and thus only validated) while NOT derived from markup; a
  // derived cost is always >= 0 by construction (unit_price >= 0, markup already validated above).
  if (!costIsDerived && newCost.trim() !== '') {
    const costNum = parseFloat(newCost);
    if (Number.isNaN(costNum) || costNum < 0) {
      return 'Unit cost must be a non-negative number.';
    }
  }
  return null;
}

/**
 * Live totalbar (v12 SECTION 04) — identical markup shared by both the new-item and edit forms.
 * Line total is always shown (qty × price — no pricing gate, it's the same number Unit price
 * already exposes). Markup %/Margin % and the "stored, not re-derived" note are canSeePricing-
 * gated, matching this file's absent-not-disabled treatment of pricing data everywhere else.
 */
function LineTotalBar({
  lineTotal,
  markupPercent,
  marginPercent,
  canSeePricing,
}: {
  lineTotal: number;
  markupPercent: number | null;
  marginPercent: number | null;
  canSeePricing: boolean;
}) {
  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between rounded-lg border border-border bg-background-light/40 px-3 py-2">
        <span className="text-sm text-text-secondary">
          Line total
          {canSeePricing && markupPercent != null && !Number.isNaN(markupPercent) && (
            <>
              {' '}
              · <span className="font-semibold text-text-primary">Markup {Math.round(markupPercent)}%</span>
            </>
          )}
          {canSeePricing && marginPercent != null && (
            <>
              {' '}
              · <span className="font-semibold text-success">Margin {Math.round(marginPercent)}%</span>
            </>
          )}
        </span>
        <span className="text-sm font-bold text-text-primary">{formatCurrency(lineTotal)}</span>
      </div>
      {canSeePricing && (
        <p className="text-[11px] text-text-secondary">
          <span className="font-medium text-text-primary">Markup is stored on the line</span>, not re-derived.
        </p>
      )}
    </div>
  );
}

export function AddLineDialog({
  open,
  onOpenChange,
  onAdd,
  loading = false,
  canSaveToPriceBook = false,
  canSeePricing = false,
  editingLine = null,
  onUpdate,
  onDelete,
  initialQuery,
  extraCreateContent,
}: AddLineDialogProps) {
  // Search
  const [searchQ, setSearchQ] = useState('');
  const [results, setResults] = useState<PriceBookItem[]>([]);
  const [searching, setSearching] = useState(false);

  // Selection / creation
  const [selected, setSelected] = useState<PriceBookItem | null>(null);
  const [creatingNew, setCreatingNew] = useState(false);
  const [browsing, setBrowsing] = useState(false);

  // Shared + new-item fields
  const [quantity, setQuantity] = useState('1');
  const [newName, setNewName] = useState('');
  const [newDescription, setNewDescription] = useState('');
  const [newType, setNewType] = useState<'SERVICE' | 'MATERIAL'>('MATERIAL');
  const [newPrice, setNewPrice] = useState('');
  const [newMarkup, setNewMarkup] = useState('');
  const [newCost, setNewCost] = useState('');
  const [newTaxable, setNewTaxable] = useState(true);
  const [saveToPriceBook, setSaveToPriceBook] = useState(false);

  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const reset = () => {
    setSearchQ('');
    setResults([]);
    setSelected(null);
    setCreatingNew(false);
    setBrowsing(false);
    setQuantity('1');
    setNewName('');
    setNewDescription('');
    setNewType('MATERIAL');
    setNewPrice('');
    setNewMarkup('');
    setNewCost('');
    setNewTaxable(true);
    setSaveToPriceBook(false);
    setError(null);
  };

  // Markup %/Unit cost sync — shared by BOTH the new-item form and the edit form (they never
  // render simultaneously, so reusing one set of state/derivations for both is safe): while
  // Markup % holds a usable value (> -100 — see deriveCostFromMarkup's guard), Unit cost is
  // derived live and its input disables; otherwise Unit cost is a normal, freely-editable field.
  const markupNum = newMarkup.trim() === '' ? null : parseFloat(newMarkup);
  const costIsDerived = markupNum != null && !Number.isNaN(markupNum) && markupNum > -100;
  const derivedCost = costIsDerived ? deriveCostFromMarkup(parseFloat(newPrice) || 0, markupNum as number) : null;

  // Name and Description share one stored field, so the live count is taken on the combined
  // string the API will receive. Kept quiet until the description is genuinely long - a counter
  // on a two-line note is noise, and 50,000 characters is only ever reached by a pasted document.
  const descriptionLength = combineDescription(newName.trim(), newDescription).length;
  const showDescriptionCount = descriptionLength > LINE_DESCRIPTION_MAX * 0.8;

  // Live totalbar (v12 SECTION 04) — shared by both forms. Line total only needs qty/price (no
  // pricing gate). Margin needs an "effective" unit cost — the live-derived one while Markup %
  // holds a usable value, otherwise whatever's directly typed into Unit cost — mirroring
  // LineItemRow's own per-row margin sub-line formula, read from the same three numbers.
  const qtyNum = parseFloat(quantity) || 0;
  const priceNum = parseFloat(newPrice) || 0;
  const lineTotal = qtyNum * priceNum;
  const effectiveCost = costIsDerived
    ? derivedCost
    : newCost.trim() !== '' && !Number.isNaN(parseFloat(newCost))
      ? parseFloat(newCost)
      : null;
  const marginPercent = effectiveCost != null && priceNum > 0 ? ((priceNum - effectiveCost) / priceNum) * 100 : null;

  // Pre-fill the shared form fields from the line being edited whenever a different one opens.
  useEffect(() => {
    if (!editingLine) return;
    const { name, detail } = splitDescription(editingLine.description);
    setNewName(name);
    setNewDescription(detail);
    setQuantity(String(toNum(editingLine.quantity)));
    setNewPrice(String(toNum(editingLine.unit_price)));
    setNewMarkup(editingLine.markup_percent != null ? String(toNum(editingLine.markup_percent)) : '');
    setNewCost(editingLine.unit_cost != null ? String(toNum(editingLine.unit_cost)) : '');
    setNewTaxable(editingLine.is_taxable);
    setSaveToPriceBook(false);
    setError(null);
  }, [editingLine]);

  // `initialQuery` (v12 Wave 3 — Estimate only): when the dialog opens fresh with a query and no
  // `editingLine`, skip the blank search screen and jump straight into the creatingNew form
  // pre-filled with it — mirrors `startCreate()`'s own resets. Guarded on `initialQuery !==
  // undefined` (not just truthy) so an intentionally-blank query (picker's "Add new item" card
  // clicked with nothing typed) still opens the create form directly rather than the search
  // screen. `open`/`editingLine` in the deps (re-)run this each time the dialog opens fresh;
  // `creatingNew` flips true here before the search-debounce effect below ever fires a fetch.
  useEffect(() => {
    if (!open || editingLine || initialQuery === undefined) return;
    setSearchQ(initialQuery);
    setSelected(null);
    setCreatingNew(true);
    setNewName(initialQuery);
    setNewDescription('');
    setNewType('MATERIAL');
    setNewPrice('');
    setNewMarkup('');
    setNewCost('');
    setNewTaxable(true);
    setSaveToPriceBook(false);
    setQuantity('1');
    setError(null);
  }, [open, editingLine, initialQuery]);

  // Debounced search — only while searching/browsing (not after a pick / when creating / when editing).
  useEffect(() => {
    if (selected || creatingNew || editingLine) return;
    const query = searchQ.trim();
    if (!browsing && !query) {
      setResults([]);
      return;
    }
    let active = true;
    setSearching(true);
    const t = setTimeout(async () => {
      try {
        const r = browsing
          ? await listPriceBookItems(query || undefined)
          : await searchPriceBookItems(query);
        if (active) setResults(r);
      } catch {
        if (active) setResults([]);
      } finally {
        if (active) setSearching(false);
      }
    }, 300);
    return () => {
      active = false;
      clearTimeout(t);
    };
  }, [searchQ, selected, creatingNew, editingLine, browsing]);

  const pickItem = (item: PriceBookItem) => {
    setSelected(item);
    setQuantity('1');
    setError(null);
  };

  const startCreate = () => {
    setCreatingNew(true);
    setNewName(searchQ.trim());
    setNewDescription('');
    setNewType('MATERIAL');
    setNewPrice('');
    setNewMarkup('');
    setNewCost('');
    setNewTaxable(true);
    setSaveToPriceBook(false);
    setQuantity('1');
    setError(null);
  };

  const backToSearch = () => {
    setSelected(null);
    setCreatingNew(false);
    setError(null);
  };

  const handleSubmit = async () => {
    const qty = parseFloat(quantity);
    if (isNaN(qty) || qty <= 0) {
      setError('Quantity must be a positive number.');
      return;
    }

    // ── Edit an existing line — a diff patch, never the price-book/search flow below. ──────
    if (editingLine) {
      const name = newName.trim();
      if (!name) {
        setError('Name is required.');
        return;
      }

      const price = parseFloat(newPrice);
      if (isNaN(price) || price < 0) {
        setError('Selling price must be a non-negative number.');
        return;
      }

      const pricingError = validatePricingFields(newMarkup, markupNum, costIsDerived, newCost);
      if (pricingError) {
        setError(pricingError);
        return;
      }
      const descriptionError = validateDescriptionLength(name, newDescription);
      if (descriptionError) {
        setError(descriptionError);
        return;
      }

      const prevMarkup = editingLine.markup_percent != null ? toNum(editingLine.markup_percent) : null;
      const prevCost = editingLine.unit_cost != null ? toNum(editingLine.unit_cost) : null;
      // An emptied Markup %/Unit cost field is treated as "no change", never a silent,
      // unconfirmed null-out of a previously-set value (a blank number input is a completely
      // normal state a user can land in without intending to clear anything).
      const nextMarkup = newMarkup.trim() === '' ? prevMarkup : (markupNum as number);
      const nextCost = costIsDerived
        ? derivedCost
        : newCost.trim() === ''
          ? prevCost
          : parseFloat(newCost);
      // Name + Description recombine into the single stored `description` string the same way
      // splitDescription() reads them back apart (name\ndetail).
      const nextDescription = combineDescription(name, newDescription);

      const patch: LineUpdatePatch = {};
      if (qty !== toNum(editingLine.quantity)) patch.quantity = qty;
      if (price !== toNum(editingLine.unit_price)) patch.unit_price = price;
      if (newTaxable !== editingLine.is_taxable) patch.is_taxable = newTaxable;
      if (nextMarkup !== prevMarkup) patch.markup_percent = nextMarkup;
      if (nextCost !== prevCost) patch.unit_cost = nextCost;
      if (nextDescription !== editingLine.description) patch.description = nextDescription;

      // Optional: also persist a fresh, standalone catalog entry from the line's current values
      // (mirrors the new-item flow below) — never rewrites THIS line's own price_book_item_id.
      if (saveToPriceBook && canSaveToPriceBook) {
        try {
          await createPriceBookItem({
            name,
            type: editingLine.item_type,
            unit_price: price,
            taxable: newTaxable,
            // The catalog entry carries the same cost the line does - derived from Markup % when
            // that field is usable, otherwise the directly-typed Unit cost. A null cost (both
            // fields blank and none previously set) is omitted, never sent as 0.
            ...(nextCost != null ? { unit_cost: nextCost } : {}),
          });
        } catch (err: unknown) {
          setError(extractApiError(err, 'Could not save to the price book.'));
          return;
        }
      }

      setSubmitting(true);
      setError(null);
      try {
        await onUpdate?.(editingLine.id, patch);
        reset();
      } catch (err: unknown) {
        setError(extractApiError(err, 'Failed to update line item.'));
      } finally {
        setSubmitting(false);
      }
      return;
    }

    let payload: LineAddPayload;

    if (selected) {
      payload = {
        description: selected.description ? `${selected.name}\n${selected.description}` : selected.name,
        item_type: selected.type,
        quantity: qty,
        unit_price: Number(selected.unit_price),
        is_taxable: selected.taxable,
        price_book_item_id: selected.id,
      };
    } else if (creatingNew) {
      const name = newName.trim();
      const price = parseFloat(newPrice);
      if (!name) {
        setError('Name is required.');
        return;
      }
      if (isNaN(price) || price < 0) {
        setError('Selling price must be a non-negative number.');
        return;
      }
      const pricingError = validatePricingFields(newMarkup, markupNum, costIsDerived, newCost);
      if (pricingError) {
        setError(pricingError);
        return;
      }
      const descriptionError = validateDescriptionLength(name, newDescription);
      if (descriptionError) {
        setError(descriptionError);
        return;
      }
      payload = {
        description: combineDescription(name, newDescription),
        item_type: newType,
        quantity: qty,
        unit_price: price,
        is_taxable: newTaxable,
        // Markup % (when usable) always ships with its live-derived Unit cost; otherwise a
        // directly-typed Unit cost ships alone (guard mirrors costIsDerived above).
        ...(costIsDerived
          ? { markup_percent: markupNum as number, unit_cost: derivedCost as number }
          : newCost.trim() !== ''
            ? { unit_cost: parseFloat(newCost) }
            : {}),
      };
      // Optional: persist a reusable catalog item, then reference it on the line.
      if (saveToPriceBook && canSaveToPriceBook) {
        try {
          const created = await createPriceBookItem({
            name,
            type: newType,
            unit_price: price,
            taxable: newTaxable,
            // Same cost the line ships with (see effectiveCost) - omitted when blank, never 0.
            ...(effectiveCost != null ? { unit_cost: effectiveCost } : {}),
          });
          if (created?.id) payload.price_book_item_id = created.id;
        } catch (err: unknown) {
          setError(extractApiError(err, 'Could not save to the price book.'));
          return;
        }
      }
    } else {
      setError('Search for an item, or add a new one.');
      return;
    }

    setSubmitting(true);
    setError(null);
    try {
      await onAdd(payload);
      reset();
    } catch (err: unknown) {
      setError(extractApiError(err, 'Failed to add line item.'));
    } finally {
      setSubmitting(false);
    }
  };

  /** Edit-mode footer's Delete button — immediate, no confirm step, matching LineItemRow's own
   *  trash-icon precedent. Only reachable when `onDelete` is provided (button renders conditionally). */
  const handleDelete = async () => {
    if (!editingLine || !onDelete) return;
    setSubmitting(true);
    setError(null);
    try {
      await onDelete(editingLine.id);
      reset();
    } catch (err: unknown) {
      setError(extractApiError(err, 'Failed to delete line item.'));
    } finally {
      setSubmitting(false);
    }
  };

  const isLoading = loading || submitting;
  const canSubmit = editingLine != null || selected != null || creatingNew;

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (isLoading) return;
        onOpenChange(next);
        if (!next) reset();
      }}
    >
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>{editingLine ? 'Edit line item' : 'Add line item'}</DialogTitle>
        </DialogHeader>

        {editingLine ? (
          <div className="space-y-3 rounded-xl border border-border bg-background-light/40 p-4">
            <div className="space-y-1">
              <Label htmlFor="edit-name">Name</Label>
              <Input id="edit-name" value={newName} onChange={(e) => setNewName(e.target.value)} placeholder="Item name" />
            </div>
            <div className="space-y-1">
              <Label htmlFor="edit-description">Description</Label>
              <Textarea
                id="edit-description"
                value={newDescription}
                onChange={(e) => setNewDescription(e.target.value)}
                placeholder="Optional detail shown under the item name"
                rows={2}
                size="sm"
                className="resize-none"
                maxLength={LINE_DESCRIPTION_MAX}
              />
              {showDescriptionCount && (
                <p className={cn('text-xs', descriptionLength > LINE_DESCRIPTION_MAX ? 'text-danger' : 'text-text-secondary')}>
                  {descriptionLength.toLocaleString()} / {LINE_DESCRIPTION_MAX.toLocaleString()} characters
                </p>
              )}
            </div>
            <div className="grid grid-cols-4 gap-3">
              <div className="space-y-1">
                <Label htmlFor="edit-qty">Quantity</Label>
                <Input id="edit-qty" type="number" min={0.01} step={0.01} value={quantity} onChange={(e) => setQuantity(e.target.value)} />
              </div>
              <div className="space-y-1">
                <Label htmlFor="edit-price">Price ($)</Label>
                <Input id="edit-price" type="number" min={0} step={0.01} value={newPrice} onChange={(e) => setNewPrice(e.target.value)} placeholder="0.00" />
              </div>
              <div className="space-y-1">
                <Label htmlFor="edit-markup">Markup %</Label>
                <Input
                  id="edit-markup"
                  type="number"
                  step={0.01}
                  value={canSeePricing ? newMarkup : ''}
                  onChange={(e) => setNewMarkup(e.target.value)}
                  disabled={!canSeePricing}
                  placeholder={canSeePricing ? '0' : '—'}
                />
              </div>
              <div className="space-y-1">
                <Label htmlFor="edit-cost">Unit cost ($)</Label>
                <Input
                  id="edit-cost"
                  type="number"
                  min={0}
                  step={0.01}
                  value={
                    !canSeePricing ? '' : costIsDerived ? (derivedCost != null ? derivedCost.toFixed(2) : '') : newCost
                  }
                  onChange={(e) => setNewCost(e.target.value)}
                  disabled={!canSeePricing || costIsDerived}
                  placeholder={canSeePricing ? '0.00' : '—'}
                />
                {canSeePricing && costIsDerived && <p className="mt-1 text-[11px] text-text-secondary">Synced from markup</p>}
              </div>
            </div>
            <div className="flex items-center gap-2">
              <Switch id="edit-taxable" checked={newTaxable} onCheckedChange={setNewTaxable} />
              <Label htmlFor="edit-taxable" className="cursor-pointer">Taxable</Label>
            </div>
            {canSaveToPriceBook && (
              <div className="flex items-center gap-2">
                <Switch id="edit-save-pricebook" checked={saveToPriceBook} onCheckedChange={setSaveToPriceBook} />
                <Label htmlFor="edit-save-pricebook" className="cursor-pointer">Save to price book</Label>
              </div>
            )}
            <LineTotalBar
              lineTotal={lineTotal}
              markupPercent={markupNum}
              marginPercent={marginPercent}
              canSeePricing={canSeePricing}
            />
          </div>
        ) : (
          <>
        {/* Search box (always visible) */}
        <div className="relative">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-text-secondary" />
          <Input
            placeholder="Search the price book, or type a new item…"
            value={searchQ}
            onChange={(e) => {
              setSearchQ(e.target.value);
              setSelected(null);
              setCreatingNew(false);
            }}
            className="h-11 pl-9"
            aria-label="Search the price book"
            autoFocus
          />
        </div>

        {/* ── Selected catalog item → confirm quantity ─────────────── */}
        {selected && (
          <div className="space-y-3">
            <div className="flex items-center gap-3 rounded-xl border border-border bg-background-light/40 p-3">
              <ProductThumb
                src={selected.image_url}
                alt={selected.name}
                itemType={selected.type}
                size={48}
              />
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium text-text-primary">{selected.name}</p>
                <p className="text-xs text-text-secondary">
                  {selected.type === 'SERVICE' ? 'Service' : 'Material'} · ${Number(selected.unit_price).toFixed(2)}
                  {selected.taxable ? ' · taxable' : ''}
                </p>
              </div>
              <Button type="button" variant="link" size={null} onClick={backToSearch}>
                Change
              </Button>
            </div>
            <div className="w-32 space-y-1">
              <Label htmlFor="add-qty">Quantity</Label>
              <Input
                id="add-qty"
                type="number"
                min={0.01}
                step={0.01}
                value={quantity}
                onChange={(e) => setQuantity(e.target.value)}
              />
            </div>
          </div>
        )}

        {/* ── Search results / create-new affordance ───────────────── */}
        {!selected && !creatingNew && (
          <div className="space-y-2">
            <Button
              type="button"
              variant={browsing ? 'solid' : 'outline'}
              tone={browsing ? 'neutral' : undefined}
              size="sm"
              className="w-full justify-center gap-2"
              onClick={() => {
                setBrowsing((b) => !b);
                setSelected(null);
                setCreatingNew(false);
              }}
            >
              <Package className="h-4 w-4" />
              {browsing ? 'Browsing price book' : 'Browse price book'}
            </Button>
            {searching && (
              <div className="flex justify-center py-4">
                <Loader2 className="h-5 w-5 animate-spin text-text-secondary" />
              </div>
            )}
            {!searching && results.length > 0 && (
              <ul className="max-h-56 divide-y divide-border overflow-y-auto rounded-xl border border-border">
                {results.map((item) => (
                  <li key={item.id}>
                    {/* Left raw: a search-result list-row with heterogeneous content
                        (thumbnail + name/description + price), not Button-shaped. */}
                    <button
                      type="button"
                      onClick={() => pickItem(item)}
                      className="flex w-full items-center gap-3 px-3 py-2 text-left transition-colors hover:bg-background-light/60"
                    >
                      <ProductThumb src={item.image_url} alt={item.name} itemType={item.type} size={40} />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-sm font-medium text-text-primary">{item.name}</span>
                        {item.description && (
                          <span className="block truncate text-xs text-text-secondary">{item.description}</span>
                        )}
                      </span>
                      <span className="whitespace-nowrap text-xs text-text-secondary">
                        {item.type === 'SERVICE' ? 'Service' : 'Material'} · ${Number(item.unit_price).toFixed(2)}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
            {searchQ.trim() && !searching && (
              // Left raw: dashed/tinted "add new" CTA card - a distinct family with no
              // matching Button cell (same shape as PriceBookPicker.tsx's AdhocCard).
              <button
                type="button"
                onClick={startCreate}
                className="flex w-full items-center gap-2 rounded-xl border border-sage-200 bg-sage-50 px-3 py-2.5 text-left text-sm font-medium text-sage-700 transition-colors hover:bg-sage-200/60"
              >
                <span className="flex h-7 w-7 items-center justify-center rounded-md border border-dashed border-sage-200">
                  <Plus className="h-4 w-4" />
                </span>
                Add new item: <span className="font-bold">{searchQ.trim()}</span>
              </button>
            )}
            {browsing && !searching && results.length === 0 && (
              <p className="py-2 text-center text-sm text-text-secondary">
                Your price book is empty — type above to add a new item.
              </p>
            )}
            {!browsing && !searchQ.trim() && (
              <p className="py-2 text-center text-sm text-text-secondary">
                Start typing to search the price book, or browse it above.
              </p>
            )}
          </div>
        )}

        {/* ── New item form ────────────────────────────────────────── */}
        {creatingNew && (
          <div className="space-y-3 rounded-xl border border-dashed border-sage-200 bg-surface-light p-4">
            <div className="flex items-center justify-between">
              <p className="text-xs font-bold uppercase tracking-wider text-sage-700">New item</p>
              <Button type="button" variant="link" size={null} onClick={backToSearch}>
                Back to search
              </Button>
            </div>
            <div className="space-y-1">
              <Label htmlFor="new-name">Name</Label>
              <Input id="new-name" value={newName} onChange={(e) => setNewName(e.target.value)} placeholder="Item name" />
            </div>
            <div className="space-y-1">
              <Label htmlFor="new-description">Description</Label>
              <Textarea
                id="new-description"
                value={newDescription}
                onChange={(e) => setNewDescription(e.target.value)}
                placeholder="Optional detail shown under the item name"
                rows={2}
                size="sm"
                className="resize-none"
                maxLength={LINE_DESCRIPTION_MAX}
              />
              {showDescriptionCount && (
                <p className={cn('text-xs', descriptionLength > LINE_DESCRIPTION_MAX ? 'text-danger' : 'text-text-secondary')}>
                  {descriptionLength.toLocaleString()} / {LINE_DESCRIPTION_MAX.toLocaleString()} characters
                </p>
              )}
            </div>
            {extraCreateContent}
            <div className="grid grid-cols-4 gap-3">
              <div className="space-y-1">
                <Label htmlFor="new-qty">Quantity</Label>
                <Input id="new-qty" type="number" min={0.01} step={0.01} value={quantity} onChange={(e) => setQuantity(e.target.value)} />
              </div>
              <div className="space-y-1">
                <Label htmlFor="new-price">Price ($)</Label>
                <Input id="new-price" type="number" min={0} step={0.01} value={newPrice} onChange={(e) => setNewPrice(e.target.value)} placeholder="0.00" />
              </div>
              <div className="space-y-1">
                <Label htmlFor="new-markup">Markup %</Label>
                <Input
                  id="new-markup"
                  type="number"
                  step={0.01}
                  value={canSeePricing ? newMarkup : ''}
                  onChange={(e) => setNewMarkup(e.target.value)}
                  disabled={!canSeePricing}
                  placeholder={canSeePricing ? '0' : '—'}
                />
              </div>
              <div className="space-y-1">
                <Label htmlFor="new-cost">Unit cost ($)</Label>
                <Input
                  id="new-cost"
                  type="number"
                  min={0}
                  step={0.01}
                  value={
                    !canSeePricing ? '' : costIsDerived ? (derivedCost != null ? derivedCost.toFixed(2) : '') : newCost
                  }
                  onChange={(e) => setNewCost(e.target.value)}
                  disabled={!canSeePricing || costIsDerived}
                  placeholder={canSeePricing ? '0.00' : '—'}
                />
                {canSeePricing && costIsDerived && <p className="mt-1 text-[11px] text-text-secondary">Synced from markup</p>}
              </div>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1">
                <Label htmlFor="new-type">Type</Label>
                <Select value={newType} onValueChange={(v) => setNewType(v as 'SERVICE' | 'MATERIAL')}>
                  <SelectTrigger id="new-type" aria-label="Item type">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="MATERIAL">Material</SelectItem>
                    <SelectItem value="SERVICE">Service</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="flex items-end gap-2 pb-2">
                <Switch id="new-taxable" checked={newTaxable} onCheckedChange={setNewTaxable} />
                <Label htmlFor="new-taxable" className="cursor-pointer">Taxable</Label>
              </div>
            </div>
            {canSaveToPriceBook && (
              <div className="flex items-center gap-2">
                <Switch id="new-save-pricebook" checked={saveToPriceBook} onCheckedChange={setSaveToPriceBook} />
                <Label htmlFor="new-save-pricebook" className="cursor-pointer">Save to price book</Label>
              </div>
            )}
            <LineTotalBar
              lineTotal={lineTotal}
              markupPercent={markupNum}
              marginPercent={marginPercent}
              canSeePricing={canSeePricing}
            />
          </div>
        )}
          </>
        )}

        {error && <p className="text-sm text-danger">{error}</p>}

        <DialogFooter>
          {editingLine && onDelete && (
            <Button
              type="button"
              variant="ghost" tone="danger"
              className="mr-auto justify-start"
              onClick={handleDelete}
              disabled={isLoading}
            >
              <Trash2 className="h-4 w-4" />
              Delete
            </Button>
          )}
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={isLoading}>
            Cancel
          </Button>
          <Button type="button" variant="solid" tone="business" onClick={handleSubmit} disabled={isLoading || !canSubmit}>
            {isLoading && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            {editingLine ? 'Save changes' : 'Add item'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
