import { Card } from '@/components/ui/card';
import { UploadedImage } from '@/components/ui/uploaded-image';
import { Heading } from '@/components/ui/heading';
import { FileText, Package, Wrench } from 'lucide-react';
import { cn, formatCurrency, formatTaxRatePercent } from '@/lib/utils';

// ─── Types ──────────────────────────────────────────

interface DocumentLineItem {
  id?: string;
  description: string;
  quantity: number;
  unit_price: number;
  is_taxable: boolean;
  line_total: number;
  item_type?: string;
  discount_type?: string | null;
  discount_value?: number | null;
  discount_amount?: number | null;
  price_book_item?: { image_url?: string | null };
}

interface EstimateDocumentViewProps {
  estimateNumber?: string;
  documentLabel?: string;
  customerName: string;
  companyName?: string | null;
  scopeNotes?: string;
  lineItems: DocumentLineItem[];
  subtotal: number;
  taxRate: number;
  taxAmount: number;
  totalAmount: number;
  discountType?: string | null;
  discountValue?: number | null;
  discountName?: string | null;
  discountAmount?: number | null;
}

// ─── Helpers ────────────────────────────────────────

function splitDescription(description: string): { name: string; detail: string } {
  const parts = description.split('\n');
  return { name: parts[0] || '', detail: parts.slice(1).join('\n') };
}

// ─── Component ──────────────────────────────────────

export function EstimateDocumentView({
  estimateNumber,
  documentLabel = 'Estimate',
  customerName,
  companyName,
  scopeNotes,
  lineItems,
  subtotal,
  taxRate,
  taxAmount,
  totalAmount,
  discountName,
  discountAmount,
}: EstimateDocumentViewProps) {
  const hasEstimateDiscount = Number(discountAmount) > 0;
  const hasLineDiscounts = lineItems.some(li => Number(li.discount_amount) > 0);

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="text-center">
        <FileText className="h-10 w-10 text-primary mx-auto mb-3" />
        <Heading level={1} scale="2xl" weight="bold">
          {estimateNumber ? `${documentLabel} ${estimateNumber}` : `New ${documentLabel}`}
        </Heading>
        <p className="text-sm text-text-secondary mt-1">
          Prepared for {customerName}
          {companyName && ` — ${companyName}`}
        </p>
      </div>

      {/* Scope notes */}
      {scopeNotes && (
        <Card padding="sm">
          {/* eyebrow style, no matching Heading variant */}
          <h3 className="text-sm font-semibold uppercase tracking-wide text-text-secondary mb-2">Scope of Work</h3>
          <p className="text-sm text-text-primary whitespace-pre-wrap">{scopeNotes}</p>
        </Card>
      )}

      {/* Line items — card-based layout */}
      <Card padding="sm">
        <div className="space-y-3">
          {lineItems.map((li, index) => {
            const { name, detail } = splitDescription(li.description);
            const itemType = li.item_type || 'SERVICE';
            const imageUrl = li.price_book_item?.image_url;
            const lineDiscountAmt = Number(li.discount_amount) || 0;
            const gross = Math.round(Number(li.quantity) * Number(li.unit_price) * 100) / 100;
            const effective = Math.round((gross - lineDiscountAmt) * 100) / 100;

            return (
              <div key={li.id || index} className="flex items-start gap-3 p-3 rounded-lg bg-background-light border border-border">
                {/* Image */}
                <div className="shrink-0">
                  {imageUrl ? (
                    <UploadedImage src={imageUrl} radius="lg" className="h-14 w-14" />
                  ) : (
                    <div className="h-14 w-14 rounded-lg bg-background-light flex items-center justify-center">
                      {itemType === 'MATERIAL'
                        ? <Package className="h-5 w-5 text-text-soft" />
                        : <Wrench className="h-5 w-5 text-text-soft" />
                      }
                    </div>
                  )}
                  <div className={cn(
                    'mt-1 text-center text-[10px] font-medium py-0.5 rounded',
                    itemType === 'MATERIAL' ? 'bg-warning-surface text-warning-text' : 'bg-info-surface text-info-text'
                  )}>
                    {itemType === 'MATERIAL' ? 'Material' : 'Service'}
                  </div>
                </div>

                {/* Content */}
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium text-text-primary">{name}</p>
                  {detail && (
                    <p className="text-xs text-text-secondary mt-0.5 whitespace-pre-wrap">{detail}</p>
                  )}
                  <div className="flex items-center gap-4 mt-1 text-xs text-text-secondary">
                    <span>Qty: <span className="tabular-nums">{Number(li.quantity)}</span></span>
                    <span>@ <span className="tabular-nums">{formatCurrency(Number(li.unit_price))}</span></span>
                  </div>
                  {lineDiscountAmt > 0 && li.discount_type && (
                    <p className="text-xs text-warning-text mt-0.5">
                      Discount: {li.discount_type === 'PERCENTAGE' ? `${Number(li.discount_value)}%` : formatCurrency(Number(li.discount_value))}
                      {' '}(-{formatCurrency(lineDiscountAmt)})
                    </p>
                  )}
                </div>

                {/* Total */}
                <div className="shrink-0 text-right">
                  {lineDiscountAmt > 0 ? (
                    <>
                      <span className="text-xs text-text-soft line-through tabular-nums block">{formatCurrency(gross)}</span>
                      <span className="text-sm font-semibold tabular-nums text-text-primary">{formatCurrency(effective)}</span>
                    </>
                  ) : (
                    <span className="text-sm font-semibold tabular-nums text-text-primary">{formatCurrency(Number(li.line_total))}</span>
                  )}
                </div>
              </div>
            );
          })}
        </div>

        {/* Totals */}
        <div className="mt-4 border-t pt-4 flex flex-col items-end space-y-1">
          <div className="flex gap-8 text-sm">
            <span className="text-text-secondary">Subtotal</span>
            <span className="tabular-nums">{formatCurrency(subtotal)}</span>
          </div>
          {hasLineDiscounts && (
            <div className="flex gap-8 text-sm">
              <span className="text-text-secondary">Line Discounts</span>
              <span className="tabular-nums text-warning-text">
                -{formatCurrency(lineItems.reduce((sum, li) => sum + (Number(li.discount_amount) || 0), 0))}
              </span>
            </div>
          )}
          {hasEstimateDiscount && (
            <div className="flex gap-8 text-sm">
              <span className="text-text-secondary">{discountName || 'Discount'}</span>
              <span className="tabular-nums text-warning-text">-{formatCurrency(Number(discountAmount))}</span>
            </div>
          )}
          <div className="flex gap-8 text-sm">
            <span className="text-text-secondary">Tax ({formatTaxRatePercent(taxRate)}%)</span>
            <span className="tabular-nums">{formatCurrency(taxAmount)}</span>
          </div>
          <div className="flex gap-8 text-lg font-bold border-t pt-2 mt-1">
            <span>Total</span>
            <span className="tabular-nums">{formatCurrency(totalAmount)}</span>
          </div>
        </div>
      </Card>
    </div>
  );
}
