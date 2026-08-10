import type { TDocumentDefinitions } from 'pdfmake/interfaces';
import { markdownToPdfMake } from '../markdown';
import {
  fmtCurrency,
  fmtDate,
  fmtTaxRate,
  hasDocDiscount,
  lineNetTotal,
  pickContent,
  isInvoiceSameAsBilling,
  activePaymentsTotal,
  type EstimateForPdf,
  type OrgForPdf,
  type InvoiceForPdf,
} from './alpha-classic';
import { asScopeArray } from '../../scopes';

const TAG_COLORS: Record<string, string> = {
  MATERIAL: '#F97316',
  SERVICE: '#3B82F6',
};

const TAG_LABELS: Record<string, string> = {
  MATERIAL: 'Material',
  SERVICE: 'Service',
};

// §2.5b — a priced scope-of-work block isn't a MATERIAL/SERVICE line item (no item_type), so it
// gets its own tag rather than a lookup miss against TAG_COLORS/TAG_LABELS.
const SCOPE_TAG_COLOR = '#6B7280';
const SCOPE_TAG_LABEL = 'Scope';

export function buildCrmDefaultPdf(
  estimate: EstimateForPdf,
  org: OrgForPdf,
): TDocumentDefinitions {
  // customer_id is required on every estimate going forward — the direct anchor is the common
  // case; `lead?.customer` is the fallback for rows still reached only through their lead.
  const c = estimate.customer ?? estimate.lead?.customer;
  if (!c) throw new Error('Estimate has no customer');
  const terms = pickContent(estimate.snapshot_terms, org.estimate_terms, estimate.status);
  const notes = pickContent(estimate.snapshot_notes, org.estimate_notes, estimate.status);
  const paymentTerms = pickContent(estimate.snapshot_payment_terms, org.estimate_payment_terms, estimate.status);

  // Centered header: logo or org name
  const headerBlock = org.logo_url
    ? { image: org.logo_url, fit: [200, 80] as [number, number], alignment: 'center' as const }
    : { text: org.name, fontSize: 22, bold: true, color: org.brand_color, alignment: 'center' as const };

  // Centered title + prepared for
  const titleBlock = {
    stack: [
      { text: `Estimate ${estimate.estimate_number}`, fontSize: 22, bold: true, alignment: 'center' as const },
      { text: `Prepared for ${c.company_name || [c.first_name, c.last_name].filter(Boolean).join(' ')}`, fontSize: 10, color: '#666666', alignment: 'center' as const, margin: [0, 4, 0, 0] as any },
    ],
    margin: [0, 16, 0, 20] as any,
  };

  // Scope of Work card (conditional)
  const scopeBlock: any[] = estimate.scope_notes
    ? [
        {
          stack: [
            { text: 'Scope of Work', bold: true, fontSize: 11, margin: [0, 0, 0, 4] as any },
            { text: estimate.scope_notes, fontSize: 10 },
          ],
          margin: [0, 0, 0, 20] as any,
        },
      ]
    : [];

  // Line items table body
  const tableBody: any[] = [];

  for (const li of estimate.line_items) {
    const parts = li.description.split('\n');
    const tagLabel = TAG_LABELS[li.item_type] ?? li.item_type;
    const tagColor = TAG_COLORS[li.item_type] ?? '#888888';

    const hasDiscount = Number(li.discount_amount) > 0;
    // li.line_total is GROSS (quantity × unit_price). The struck-through figure is that gross
    // price and the bold figure is the net one the Subtotal actually contains. This previously
    // printed line_total for BOTH, on the assumption it was already net — so a discounted line
    // rendered the same number twice, one of them crossed out.
    const net = lineNetTotal(li);

    const priceCell: any = hasDiscount
      ? {
          stack: [
            { text: fmtCurrency(li.line_total), decoration: 'lineThrough', color: '#999999', fontSize: 9 },
            { text: fmtCurrency(net), bold: true },
          ],
          alignment: 'right' as const,
        }
      : { text: fmtCurrency(net), alignment: 'right' as const };

    tableBody.push([
      // Image / type-tag column
      {
        stack: [
          li.price_book_item?.image_url
            ? { image: li.price_book_item.image_url, fit: [48, 48] as [number, number] }
            : { text: '—', color: '#cccccc', fontSize: 18, alignment: 'center' as const },
          {
            text: tagLabel,
            fontSize: 8,
            bold: true,
            color: '#ffffff',
            background: tagColor,
            alignment: 'center' as const,
            margin: [0, 4, 0, 0] as any,
          },
        ],
      },
      // Description column
      {
        stack: [
          { text: parts[0], bold: true },
          ...(parts.slice(1).length > 0
            ? [{ text: parts.slice(1).join('\n'), fontSize: 9, color: '#666666' }]
            : []),
          { text: `Qty ${li.quantity} @ ${fmtCurrency(li.unit_price)}`, fontSize: 9, color: '#888888', margin: [0, 2, 0, 0] as any },
        ],
      },
      // Price column
      priceCell,
    ]);
  }

  // §2.5b — priced scope-of-work blocks render as their own line, right after the line items, in
  // the SAME table/price column line items use — so the Subtotal below is the literal sum of
  // everything printed above it. Unpriced scopes (flat_price == null) carry no amount to
  // reconcile and are intentionally omitted here (they're narrative-only, matching scope_notes).
  const pricedScopes = asScopeArray(estimate.scopes).filter((s) => s.flat_price != null);
  for (const scope of pricedScopes) {
    tableBody.push([
      {
        stack: [
          { text: '—', color: '#cccccc', fontSize: 18, alignment: 'center' as const },
          {
            text: SCOPE_TAG_LABEL,
            fontSize: 8,
            bold: true,
            color: '#ffffff',
            background: SCOPE_TAG_COLOR,
            alignment: 'center' as const,
            margin: [0, 4, 0, 0] as any,
          },
        ],
      },
      {
        stack: [
          { text: scope.title, bold: true },
          ...(scope.body ? [{ text: scope.body, fontSize: 9, color: '#666666' }] : []),
        ],
      },
      { text: fmtCurrency(scope.flat_price ?? 0), alignment: 'right' as const },
    ]);
  }

  const lineItemsTable = {
    table: {
      widths: [64, '*', 80] as any,
      body: tableBody,
    },
    layout: {
      hLineWidth: () => 0.5,
      vLineWidth: () => 0,
      hLineColor: () => '#e5e5e5',
    },
    margin: [0, 0, 0, 16] as any,
  };

  // Totals — simple right-aligned column stack (no table wrapper)
  const totalsBlock = {
    columns: [
      { width: '*', text: '' },
      {
        width: 'auto',
        stack: [
          {
            columns: [
              { width: 80, text: 'Subtotal', alignment: 'right' as const },
              { width: 80, text: fmtCurrency(estimate.subtotal), alignment: 'right' as const },
            ],
            margin: [0, 2, 0, 2] as any,
          },
          // Document-level discount, between Subtotal and Tax — the order calculateTotals
          // applies it in. Without this row Subtotal + Tax visibly disagrees with Total.
          ...(hasDocDiscount(estimate)
            ? [{
                columns: [
                  { width: 80, text: estimate.discount_name || 'Discount', alignment: 'right' as const },
                  { width: 80, text: `−${fmtCurrency(Number(estimate.discount_amount))}`, alignment: 'right' as const },
                ],
                margin: [0, 2, 0, 2] as any,
              }]
            : []),
          {
            columns: [
              { width: 80, text: `Tax ${fmtTaxRate(estimate.tax_rate)}`, alignment: 'right' as const },
              { width: 80, text: fmtCurrency(estimate.tax_amount), alignment: 'right' as const },
            ],
            margin: [0, 2, 0, 2] as any,
          },
          {
            columns: [
              { width: 80, text: 'Total', bold: true, fontSize: 12, alignment: 'right' as const },
              { width: 80, text: fmtCurrency(estimate.total_amount), bold: true, fontSize: 12, alignment: 'right' as const },
            ],
            margin: [0, 4, 0, 0] as any,
          },
        ],
      },
    ],
    margin: [0, 0, 0, 24] as any,
  };

  // Signature block (conditional)
  const signatureBlock: any[] = estimate.signature_data
    ? [
        { text: 'Customer Signature:', bold: true, margin: [0, 20, 0, 8] as any, pageBreak: 'before' as any },
        { image: estimate.signature_data, width: 150, height: 60 },
        { text: `Approved on ${estimate.signature_at ? fmtDate(estimate.signature_at) : ''}`, fontSize: 9, color: '#666666' },
      ]
    : [];

  return {
    content: [
      headerBlock,
      titleBlock,
      ...scopeBlock,
      lineItemsTable,
      totalsBlock,
      { text: 'Terms:', bold: true, margin: [0, 0, 0, 4] as any },
      ...markdownToPdfMake(terms),
      { text: 'Notes:', bold: true, margin: [0, 16, 0, 4] as any },
      ...markdownToPdfMake(notes),
      { text: 'Payment Terms:', bold: true, margin: [0, 16, 0, 4] as any },
      ...markdownToPdfMake(paymentTerms),
      ...signatureBlock,
      { text: 'Thank You For Your Business', fontSize: 18, bold: true, alignment: 'center', margin: [0, 30, 0, 0] as any },
    ],
    defaultStyle: { font: 'Inter', fontSize: 10 },
    styles: {
      paragraph: { fontSize: 10, lineHeight: 1.3 },
    },
    pageMargins: [40, 40, 40, 40],
    pageSize: 'LETTER',
  };
}

export function buildCrmDefaultInvoicePdf(
  invoice: InvoiceForPdf,
  org: OrgForPdf,
): TDocumentDefinitions {
  const c = invoice.customer;
  // Invoices have no snapshot_* columns — always the org's CURRENT copy.
  const terms = org.invoice_terms ?? '';
  const notes = org.invoice_notes ?? '';
  const paymentTerms = org.invoice_payment_terms ?? '';

  const headerBlock = org.logo_url
    ? { image: org.logo_url, fit: [200, 80] as [number, number], alignment: 'center' as const }
    : { text: org.name, fontSize: 22, bold: true, color: org.brand_color, alignment: 'center' as const };

  const customerName = c.company_name || [c.first_name, c.last_name].filter(Boolean).join(' ');
  const titleBlock = {
    stack: [
      { text: `Invoice ${invoice.invoice_number}`, fontSize: 22, bold: true, alignment: 'center' as const },
      { text: `Billed to ${customerName}`, fontSize: 10, color: '#666666', alignment: 'center' as const, margin: [0, 4, 0, 0] as any },
    ],
    margin: [0, 16, 0, 20] as any,
  };

  const tableBody: any[] = [];
  for (const li of invoice.line_items) {
    const parts = li.description.split('\n');
    const tagLabel = TAG_LABELS[li.item_type] ?? li.item_type;
    const tagColor = TAG_COLORS[li.item_type] ?? '#888888';
    const hasDiscount = Number(li.discount_amount) > 0;
    const net = lineNetTotal(li);

    const priceCell: any = hasDiscount
      ? {
          stack: [
            { text: fmtCurrency(li.line_total), decoration: 'lineThrough', color: '#999999', fontSize: 9 },
            { text: fmtCurrency(net), bold: true },
          ],
          alignment: 'right' as const,
        }
      : { text: fmtCurrency(net), alignment: 'right' as const };

    tableBody.push([
      {
        stack: [
          li.price_book_item?.image_url
            ? { image: li.price_book_item.image_url, fit: [48, 48] as [number, number] }
            : { text: '—', color: '#cccccc', fontSize: 18, alignment: 'center' as const },
          {
            text: tagLabel,
            fontSize: 8,
            bold: true,
            color: '#ffffff',
            background: tagColor,
            alignment: 'center' as const,
            margin: [0, 4, 0, 0] as any,
          },
        ],
      },
      {
        stack: [
          { text: parts[0], bold: true },
          ...(parts.slice(1).length > 0
            ? [{ text: parts.slice(1).join('\n'), fontSize: 9, color: '#666666' }]
            : []),
          { text: `Qty ${li.quantity} @ ${fmtCurrency(li.unit_price)}`, fontSize: 9, color: '#888888', margin: [0, 2, 0, 0] as any },
        ],
      },
      priceCell,
    ]);
  }
  const pricedScopes = asScopeArray(invoice.scopes).filter((s) => s.flat_price != null);
  for (const scope of pricedScopes) {
    tableBody.push([
      {
        stack: [
          { text: '—', color: '#cccccc', fontSize: 18, alignment: 'center' as const },
          {
            text: SCOPE_TAG_LABEL,
            fontSize: 8,
            bold: true,
            color: '#ffffff',
            background: SCOPE_TAG_COLOR,
            alignment: 'center' as const,
            margin: [0, 4, 0, 0] as any,
          },
        ],
      },
      {
        stack: [
          { text: scope.title, bold: true },
          ...(scope.body ? [{ text: scope.body, fontSize: 9, color: '#666666' }] : []),
        ],
      },
      { text: fmtCurrency(scope.flat_price ?? 0), alignment: 'right' as const },
    ]);
  }

  const lineItemsTable = {
    table: {
      widths: [64, '*', 80] as any,
      body: tableBody,
    },
    layout: {
      hLineWidth: () => 0.5,
      vLineWidth: () => 0,
      hLineColor: () => '#e5e5e5',
    },
    margin: [0, 0, 0, 16] as any,
  };

  const paid = activePaymentsTotal(invoice.payments);
  const totalsBlock = {
    columns: [
      { width: '*', text: '' },
      {
        width: 'auto',
        stack: [
          {
            columns: [
              { width: 80, text: 'Subtotal', alignment: 'right' as const },
              { width: 80, text: fmtCurrency(invoice.subtotal), alignment: 'right' as const },
            ],
            margin: [0, 2, 0, 2] as any,
          },
          ...(hasDocDiscount(invoice)
            ? [{
                columns: [
                  { width: 80, text: invoice.discount_name || 'Discount', alignment: 'right' as const },
                  { width: 80, text: `−${fmtCurrency(Number(invoice.discount_amount))}`, alignment: 'right' as const },
                ],
                margin: [0, 2, 0, 2] as any,
              }]
            : []),
          {
            columns: [
              { width: 80, text: `Tax ${fmtTaxRate(invoice.tax_rate)}`, alignment: 'right' as const },
              { width: 80, text: fmtCurrency(invoice.tax_amount), alignment: 'right' as const },
            ],
            margin: [0, 2, 0, 2] as any,
          },
          {
            columns: [
              { width: 80, text: 'Total', bold: true, fontSize: 12, alignment: 'right' as const },
              { width: 80, text: fmtCurrency(invoice.total_amount), bold: true, fontSize: 12, alignment: 'right' as const },
            ],
            margin: [0, 4, 0, 0] as any,
          },
          ...(invoice.deposit_credit > 0
            ? [{
                columns: [
                  { width: 80, text: 'Deposit credit', alignment: 'right' as const },
                  { width: 80, text: `−${fmtCurrency(invoice.deposit_credit)}`, alignment: 'right' as const },
                ],
                margin: [0, 2, 0, 2] as any,
              }]
            : []),
          ...(paid > 0
            ? [{
                columns: [
                  { width: 80, text: 'Payments', alignment: 'right' as const },
                  { width: 80, text: `−${fmtCurrency(paid)}`, alignment: 'right' as const },
                ],
                margin: [0, 2, 0, 2] as any,
              }]
            : []),
          {
            columns: [
              { width: 80, text: 'Balance Due', bold: true, fontSize: 12, alignment: 'right' as const },
              { width: 80, text: fmtCurrency(invoice.amount_due), bold: true, fontSize: 12, alignment: 'right' as const },
            ],
            margin: [0, 4, 0, 0] as any,
          },
        ],
      },
    ],
    margin: [0, 0, 0, 24] as any,
  };

  const sameAsBilling = isInvoiceSameAsBilling(invoice);
  const loc = invoice.service_location;
  const serviceLocationBlock = [
    {
      stack: [
        { text: 'Service Location:', bold: true, fontSize: 10, margin: [0, 0, 0, 4] as any },
        {
          text: sameAsBilling
            ? 'Same as billing'
            : `${loc?.address_line1}, ${loc?.city}, ${loc?.state} ${loc?.zip}`,
          fontSize: 10,
          color: '#666666',
        },
      ],
      margin: [0, 0, 0, 16] as any,
    },
  ];

  return {
    content: [
      headerBlock,
      titleBlock,
      ...serviceLocationBlock,
      lineItemsTable,
      totalsBlock,
      ...(terms ? [{ text: 'Terms:', bold: true, margin: [0, 0, 0, 4] as any }, ...markdownToPdfMake(terms)] : []),
      ...(notes ? [{ text: 'Notes:', bold: true, margin: [0, 16, 0, 4] as any }, ...markdownToPdfMake(notes)] : []),
      ...(paymentTerms ? [{ text: 'Payment Terms:', bold: true, margin: [0, 16, 0, 4] as any }, ...markdownToPdfMake(paymentTerms)] : []),
      { text: 'Thank You For Your Business', fontSize: 18, bold: true, alignment: 'center', margin: [0, 30, 0, 0] as any },
    ],
    defaultStyle: { font: 'Inter', fontSize: 10 },
    styles: {
      paragraph: { fontSize: 10, lineHeight: 1.3 },
    },
    pageMargins: [40, 40, 40, 40],
    pageSize: 'LETTER',
  };
}
