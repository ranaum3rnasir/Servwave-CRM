/**
 * LineItemRow — one <tr> inside the LineItemsEditor table.
 *
 * Column order: Item, Qty, [Cost], Selling price, [Discount],
 * Total, Taxable, (delete) — Taxable sits right before the trailing delete action, Total before
 * it. When `canEdit`, the qty / cost / selling price / discount / taxable cells are
 * inline-editable (numbers commit on blur or Enter; the taxable Switch and discount Select commit
 * immediately). The Cost cell and the margin sub-line under Selling price are gated on
 * `canSeePricing` — the frontend mirror of the backend's canSeePricing gate (see
 * job-lines.controller.ts / invoice-lines.controller.ts). Selling price itself is NOT gated — it
 * stays visible to everyone, exactly as "Unit price" always has. A pencil Edit button (opens the
 * shared AddLineDialog in edit mode via the parent's `onEdit`) sits next to the trash button,
 * gated on the SAME `canEdit` tier as the inline field edits — editing markup/cost through the
 * dialog is a row-field edit, not a manage/delete-tier action. The trash button and the leading
 * drag handle show only when `canManage`. Mutations are owned by the parent — this row only
 * fires the provided callbacks.
 *
 * `density` ('dense' default / 'card', threaded from LineItemsTable):
 *   - 'dense' is v12's flat receipt row: thin bottom-border only, ~11px vertical padding, 13.5px
 *     type, and a 64px ProductThumb tile at the head of the Item cell, with the name stacked over
 *     its description beside it (rows run ~87px tall when a photo is present).
 *   - 'card' is the pre-v12 floating rounded-2xl row with the 112px ProductThumb photo and a
 *     Material/Service badge pill under the name — kept behind this prop rather than deleted.
 *
 * The item photo is ALWAYS the price-book item's own image (`image_url ?? photo_url`) — a line
 * carries no image of its own and there is no per-line upload affordance anywhere on any surface.
 * When the catalog item has no image (or the line is custom), ProductThumb's dashed type-glyph
 * placeholder holds the same slot, so every row on every surface has the same left edge.
 */
import { useEffect, useState } from 'react';
import { useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { Trash2, Pencil, GripVertical } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { cn, formatCurrency } from '@/lib/utils';
import { ProductThumb } from './ProductThumb';
import { ClampedDescription } from './ClampedDescription';
import { toNum } from './money';
import type { InvoiceLineItem } from '@/lib/api/jobs';
import type { UpdateLineItemPayload } from '@/lib/api/invoices';

export interface LineItemRowProps {
  line: InvoiceLineItem;
  canEdit: boolean;
  canManage: boolean;
  /** Show the Cost column + the per-row margin sub-line. Mirrors the backend's canSeePricing gate. */
  canSeePricing: boolean;
  onUpdate: (patch: UpdateLineItemPayload) => void;
  onDelete: () => void;
  /** Open the AddLineDialog in edit mode for this line. Gated on the SAME `canEdit` tier as the inline Qty/Price edits. */
  onEdit: () => void;
  busy?: boolean;
  /** Render the Discount cell. Default true — the Job grid passes false (see LineItemsTable). */
  showDiscount?: boolean;
  /** 'dense' (default, v12) small inline glyph; 'card' (legacy) 112px ProductThumb + badge pill. */
  density?: 'dense' | 'card';
}

/** First line of the description is the item name; the rest is detail. */
function splitDescription(description: string): { name: string; detail: string } {
  const parts = description.split('\n');
  return { name: parts[0] || '', detail: parts.slice(1).join('\n') };
}

export function LineItemRow({
  line,
  canEdit,
  canManage,
  canSeePricing,
  onUpdate,
  onDelete,
  onEdit,
  busy = false,
  showDiscount = true,
  density = 'dense',
}: LineItemRowProps) {
  const isDense = density !== 'card';

  // Always called (hooks can't be conditional) — the drag handle listeners are only ATTACHED to a
  // rendered element when canManage is true (leading cell below), so an unmanaged row can never
  // actually initiate a drag even though the row itself carries the sortable transform/ref.
  const { attributes, listeners, setNodeRef, setActivatorNodeRef, transform, transition, isDragging } =
    useSortable({ id: line.id });

  const { name, detail } = splitDescription(line.description);
  const photo = line.price_book_item?.image_url ?? line.price_book_item?.photo_url ?? null;
  const isCustom = !line.price_book_item_id;

  const [qty, setQty] = useState(String(toNum(line.quantity)));
  const [price, setPrice] = useState(String(toNum(line.unit_price)));
  const [cost, setCost] = useState(line.unit_cost != null ? String(toNum(line.unit_cost)) : '');
  const [discountType, setDiscountType] = useState<'PERCENTAGE' | 'FIXED_AMOUNT' | ''>(line.discount_type ?? '');
  const [discountValue, setDiscountValue] = useState(
    line.discount_value != null ? String(toNum(line.discount_value)) : '',
  );

  useEffect(() => setQty(String(toNum(line.quantity))), [line.quantity]);
  useEffect(() => setPrice(String(toNum(line.unit_price))), [line.unit_price]);
  useEffect(() => setCost(line.unit_cost != null ? String(toNum(line.unit_cost)) : ''), [line.unit_cost]);
  useEffect(() => setDiscountType(line.discount_type ?? ''), [line.discount_type]);
  useEffect(
    () => setDiscountValue(line.discount_value != null ? String(toNum(line.discount_value)) : ''),
    [line.discount_value],
  );

  const commitQty = () => {
    const n = parseFloat(qty);
    if (!isNaN(n) && n > 0 && n !== toNum(line.quantity)) onUpdate({ quantity: n });
  };
  const commitPrice = () => {
    const n = parseFloat(price);
    if (!isNaN(n) && n >= 0 && n !== toNum(line.unit_price)) onUpdate({ unit_price: n });
  };
  const commitCost = () => {
    const n = parseFloat(cost);
    if (!isNaN(n) && n >= 0 && n !== toNum(line.unit_cost)) onUpdate({ unit_cost: n });
  };
  const commitDiscount = (type: 'PERCENTAGE' | 'FIXED_AMOUNT' | '', value: string) => {
    if (!type) {
      if (line.discount_type != null) onUpdate({ discount_type: null, discount_value: null });
      return;
    }
    const n = parseFloat(value);
    if (isNaN(n) || n <= 0) return;
    onUpdate({ discount_type: type, discount_value: n });
  };

  const effectiveTotal = Math.max(0, toNum(line.line_total) - toNum(line.discount_amount));

  const unitPriceNum = toNum(line.unit_price);
  const unitCostNum = line.unit_cost != null ? toNum(line.unit_cost) : null;
  const margin =
    unitPriceNum > 0 && unitCostNum != null ? ((unitPriceNum - unitCostNum) / unitPriceNum) * 100 : null;

  const rowStyle: React.CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
  };

  // Base cell chrome. Dense (v12): thin bottom-border only, no left/right border, no rounded
  // corners, tighter padding, smaller type. Card (legacy): floating rounded-2xl row with a
  // top+bottom border, generous padding, left/right borders + rounded corners on the end cells.
  const TD = isDense
    ? 'border-b border-border bg-surface-light py-[11px] text-[13.5px] transition-colors group-hover:bg-background-light/50'
    : 'border-y border-border bg-surface-light py-4 transition-colors group-hover:bg-background-light/40';

  return (
    <tr
      ref={setNodeRef}
      style={rowStyle}
      data-testid="line-item-row"
      className={cn('group', isDragging && 'relative z-10')}
    >
      {/* Drag handle — leading cell, gated on canManage (empty spacer when false, to keep column
          alignment with the header's leading spacer <th>). Reordering is drag-only; the former
          Move up/down chevrons were removed (they only ever reordered within a Material/Service
          group, which the flat v12 table no longer has). */}
      {canManage ? (
        <td className={cn(TD, isDense ? 'w-9 pl-1 pr-0 align-middle' : 'w-10 rounded-l-2xl border-l pl-2 pr-0 align-top')}>
          <div className={cn('flex flex-col items-center', !isDense && 'pt-1')}>
            {/* Left raw: a dnd-kit drag handle - this program's own never-convert shape
                (mirrors StepNode.tsx's precedent). */}
            <button
              type="button"
              ref={setActivatorNodeRef}
              aria-label={`Drag to reorder ${name}`}
              // ≥44px hit area, keyboard-grabbable (mirrors StepNode.tsx's drag-handle precedent).
              className="flex h-11 w-11 cursor-grab touch-none items-center justify-center rounded text-text-secondary/50 hover:bg-background-light hover:text-text-secondary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary active:cursor-grabbing"
              {...attributes}
              {...listeners}
            >
              <GripVertical className="h-4 w-4" aria-hidden />
            </button>
          </div>
        </td>
      ) : (
        <td className={cn(TD, isDense ? 'w-9' : 'w-10 rounded-l-2xl border-l')} />
      )}

      {/* Item — a SINGLE document-shaped cell: photo tile on the left, then the item name as the
          heading with its description stacked directly beneath it. Item and Description used to be
          two side-by-side columns, which split the row's only fluid width in two and left long
          names wrapping one word per line while the description column sat half empty. Stacking
          them gives both the full width of the merged column.
          Dense: 64px ProductThumb. Card (legacy): 112px ProductThumb + a Material/Service badge
          pill between the name and the description. Both densities render the SAME ProductThumb,
          so a row's left edge reads identically on Estimate, Job → Items and Invoice.
          The description is text only: a line's imagery comes from its price-book item (the thumb),
          never from an upload attached to the line. */}
      <td className={cn(TD, 'pl-2 pr-3 align-top')}>
        <div className={cn('flex items-start', isDense ? 'gap-3' : 'gap-4')}>
          {/* 64px (h-16) — settled by eye against a real multi-line estimate: large enough to
              read the product without opening the lightbox, small enough that a long estimate
              doesn't become a scroll. Sized via className, hence `size={null}`. */}
          {isDense ? (
            <ProductThumb
              src={photo}
              alt={name}
              itemType={line.item_type}
              size={null}
              className="h-16 w-16 shrink-0 rounded-md"
            />
          ) : (
            <ProductThumb
              src={photo}
              alt={name}
              itemType={line.item_type}
              placeholderLabel={isCustom ? 'Custom' : undefined}
              size={112}
            />
          )}
          <div className={cn('min-w-0 flex-1', !isDense && 'pt-0.5')}>
            <p className="font-semibold leading-tight text-text-primary">{name}</p>
            {!isDense && (
              <div className="mt-2 flex flex-wrap items-center gap-1">
                <span
                  className={cn(
                    'inline-block rounded-full px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide',
                    line.item_type === 'MATERIAL' ? 'bg-background-light text-text-secondary' : 'bg-primary-subtle text-primary',
                  )}
                >
                  {line.item_type === 'MATERIAL' ? 'Material' : 'Service'}
                </span>
              </div>
            )}
            <ClampedDescription text={detail} lines={2} className="mt-1" />
          </div>
        </div>
      </td>

      {/* Qty */}
      <td className={cn(TD, 'px-3 text-right align-middle')}>
        {canEdit ? (
          <Input
            type="number"
            min={0.01}
            step={0.01}
            value={qty}
            disabled={busy}
            onChange={(e) => setQty(e.target.value)}
            onBlur={commitQty}
            onKeyDown={(e) => e.key === 'Enter' && commitQty()}
            size="xs"
            // The isDense h-8/h-9 ternary below always wins the height conflict over the
            // `xs` rung's own h-8 (call-site className is merged last) so it renders
            // unchanged for both branches - only `xs`'s text-sm is actually consumed here.
            // tabular-nums has no Input size/tone prop equivalent - kept raw.
            className={cn('ml-auto px-1.5 text-right tabular-nums', isDense ? 'h-8 w-16' : 'h-9 w-16')}
            aria-label={`Quantity for ${name}`}
          />
        ) : (
          <span className="tabular-nums">{toNum(line.quantity)}</span>
        )}
      </td>

      {/* Cost — cost/margin data, gated on canSeePricing (mirrors the backend's canSeePricing gate;
          absent entirely, not present-but-blank, when the ability lacks it). */}
      {canSeePricing && (
        <td className={cn(TD, 'px-3 text-right align-middle')}>
          {canEdit ? (
            <Input
              type="number"
              min={0}
              step={0.01}
              value={cost}
              disabled={busy}
              onChange={(e) => setCost(e.target.value)}
              onBlur={commitCost}
              onKeyDown={(e) => e.key === 'Enter' && commitCost()}
              size="xs"
              // Same isDense-ternary-wins-height / tabular-nums-has-no-prop reasoning as
              // the Qty cell above.
              className={cn('ml-auto px-1.5 text-right tabular-nums', isDense ? 'h-8 w-24' : 'h-9 w-24')}
              aria-label={`Cost for ${name}`}
            />
          ) : (
            <span className="tabular-nums">
              {line.unit_cost != null ? formatCurrency(toNum(line.unit_cost)) : '—'}
            </span>
          )}
        </td>
      )}

      {/* Selling price (formerly "Unit price") — NOT gated on canSeePricing, stays visible to
          everyone exactly as before; only the margin sub-line beneath it is gated. */}
      <td className={cn(TD, 'px-3 text-right align-middle')}>
        {canEdit ? (
          <Input
            type="number"
            min={0}
            step={0.01}
            value={price}
            disabled={busy}
            onChange={(e) => setPrice(e.target.value)}
            onBlur={commitPrice}
            onKeyDown={(e) => e.key === 'Enter' && commitPrice()}
            size="xs"
            // Same isDense-ternary-wins-height / tabular-nums-has-no-prop reasoning as
            // the Qty cell above.
            className={cn('ml-auto px-1.5 text-right tabular-nums', isDense ? 'h-8 w-24' : 'h-9 w-24')}
            aria-label={`Selling price for ${name}`}
          />
        ) : (
          <span className="tabular-nums">{formatCurrency(toNum(line.unit_price))}</span>
        )}
        {canSeePricing && margin != null && (
          <p className="mt-0.5 text-right text-[11px] font-medium text-text-secondary">
            {margin.toFixed(0)}% margin
          </p>
        )}
      </td>

      {/* Discount — hidden entirely for job rows (showDiscount=false): the job-line API doesn't
          persist discount fields yet, so the control would silently no-op and snap back. v12 has
          no per-line discount column at all; sits between Selling price and Total (a Total
          modifier) when a surface still needs it, ahead of Taxable per the v12 column order. */}
      {showDiscount && (
        <td className={cn(TD, 'px-3 text-right align-middle')}>
          {canEdit ? (
            <div className="flex items-center justify-end gap-1.5">
              <Select
                value={discountType || 'NONE'}
                disabled={busy}
                onValueChange={(v) => {
                  const next = (v === 'NONE' ? '' : v) as 'PERCENTAGE' | 'FIXED_AMOUNT' | '';
                  setDiscountType(next);
                  if (!next) {
                    setDiscountValue('');
                    commitDiscount('', '');
                  }
                }}
              >
                <SelectTrigger
                  size="xs"
                  // isDense ternary below wins the height conflict over `xs`'s own h-8
                  // (same reasoning as the Input cells above) - only `xs`'s text-xs is consumed.
                  className={cn('px-2', isDense ? 'h-8 w-[72px]' : 'h-9 w-[72px]')}
                  aria-label={`Discount type for ${name}`}
                >
                  <SelectValue placeholder="None" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="NONE">None</SelectItem>
                  <SelectItem value="PERCENTAGE">%</SelectItem>
                  <SelectItem value="FIXED_AMOUNT">$</SelectItem>
                </SelectContent>
              </Select>
              {discountType && (
                <Input
                  type="number"
                  min={0}
                  step={0.01}
                  value={discountValue}
                  disabled={busy}
                  onChange={(e) => setDiscountValue(e.target.value)}
                  onBlur={() => commitDiscount(discountType, discountValue)}
                  onKeyDown={(e) => e.key === 'Enter' && commitDiscount(discountType, discountValue)}
                  size="xs"
                  // Same isDense-ternary-wins-height / tabular-nums-has-no-prop reasoning as
                  // the Qty cell above.
                  className={cn('px-1.5 text-right tabular-nums', isDense ? 'h-8 w-[60px]' : 'h-9 w-[60px]')}
                  aria-label={`Discount value for ${name}`}
                />
              )}
            </div>
          ) : toNum(line.discount_amount) > 0 ? (
            <span className="text-xs tabular-nums text-text-secondary">-{formatCurrency(toNum(line.discount_amount))}</span>
          ) : (
            <span className="text-xs text-text-secondary">—</span>
          )}
        </td>
      )}

      {/* Line total */}
      <td className={cn(TD, 'px-3 text-right align-middle font-bold tabular-nums text-text-primary', isDense ? 'text-[14px]' : 'text-[15px]')}>
        {formatCurrency(effectiveTotal)}
      </td>

      {/* Taxable — moved to right before the trailing delete action, after Total, per v12's
          column order. */}
      <td className={cn(TD, 'px-3 text-center align-middle')}>
        {canEdit ? (
          <Switch
            checked={line.is_taxable}
            disabled={busy}
            onCheckedChange={(v) => onUpdate({ is_taxable: v })}
            aria-label={`Taxable for ${name}`}
          />
        ) : (
          <span className="text-xs text-text-secondary">{line.is_taxable ? 'Yes' : '—'}</span>
        )}
      </td>

      {/* Edit + Trash — Edit is a row-field edit (same tier as inline Qty/Price), gated on
          `canEdit`; Trash is manage-tier, gated on `canManage`. Either, both, or neither may
          render depending on the caller's ability mix. */}
      <td className={cn(TD, isDense ? 'pl-1 pr-3 text-center align-middle' : 'rounded-r-2xl border-r pl-1 pr-3 text-center align-middle')}>
        <div className="mx-auto flex w-fit items-center justify-center gap-1">
          {canEdit && (
            <Button
              type="button"
              variant="ghost"
              tone="subtle"
              size="icon"
              onClick={onEdit}
              disabled={busy}
              className="h-8 w-8"
              aria-label={`Edit ${name}`}
            >
              <Pencil className="h-4 w-4" />
            </Button>
          )}
          {canManage && (
            <Button
              type="button"
              variant="ghost"
              tone="danger"
              size="icon"
              onClick={onDelete}
              disabled={busy}
              className="h-8 w-8"
              aria-label={`Remove ${name}`}
            >
              <Trash2 className="h-4 w-4" />
            </Button>
          )}
        </div>
      </td>
    </tr>
  );
}
