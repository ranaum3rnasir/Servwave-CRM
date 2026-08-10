import type { TDocumentDefinitions } from 'pdfmake/interfaces';
import { markdownToPdfMake } from '../markdown';
import { formatPhoneDisplay } from '../../phone-format';
import { asScopeArray, type ScopeOfWork } from '../../scopes';

interface EstimateForPdf {
  estimate_number: string;
  created_at: Date;
  status: string;
  // NOTE: `subtotal` is the PRE-estimate-discount figure. calculateTotals computes
  // total = (subtotal - discount_amount) + tax_amount, so a template that prints only
  // Subtotal/Tax/Total shows a document that does not add up whenever a document-level
  // discount exists. Both templates print an explicit Discount row for that reason.
  subtotal: number;
  discount_amount: number;
  discount_name: string | null;
  tax_rate: number;
  tax_amount: number;
  total_amount: number;
  signature_data: string | null;
  signature_at: Date | null;
  snapshot_terms: string | null;
  snapshot_notes: string | null;
  snapshot_payment_terms: string | null;
  // R6 (2026-07-22) — M5: direct anchor mirroring estimateDetailSelect's top-level
  // `customer`/`service_location` (denormalized from the lead at write time). Required keys
  // (nullable value) rather than optional so a caller that forgets to populate them gets a tsc
  // error, not a silent `undefined`. Preferred over `lead.customer`/`lead.service_address_*`
  // below (see resolveServiceLocation and each build function's `estimate.customer ?? …`) so the
  // template never throws when `lead` is null but the estimate's own customer_id (always
  // populated) is present.
  customer: {
    first_name: string | null;
    last_name: string | null;
    company_name: string | null;
    email: string | null;
    phone: string;
  } | null;
  service_location: {
    address_line1: string;
    address_line2: string | null;
    city: string; state: string; zip: string;
  } | null;
  lead: {
    service_address_line1: string | null;
    service_address_line2: string | null;
    service_city: string | null;
    service_state: string | null;
    service_zip: string | null;
    customer: {
      first_name: string | null;
      last_name: string | null;
      company_name: string | null;
      email: string | null;
      phone: string;
      service_locations: Array<{
        is_primary: boolean;
        address_line1: string;
        address_line2: string | null;
        city: string; state: string; zip: string;
      }>;
    };
  } | null;
  scope_notes?: string | null;
  // §2.5b — flat-priced, non-line-item scope-of-work blocks. calculateTotals() (estimate.
  // controller.ts) folds each priced scope's flat_price into subtotal/total_amount, so the
  // template must render one too or the printed line items sum to less than the printed
  // Sub total. `internal_cost` is deliberately excluded from this type — the PDF never renders
  // staff-only margin data (mirrors stripScopeCost's Omit shape).
  scopes?: Omit<ScopeOfWork, 'internal_cost'>[] | null;
  line_items: Array<{
    description: string;
    item_type: string;
    quantity: number;
    unit_price: number;
    // GROSS (quantity × unit_price). calculateTotals stores it pre-discount and adds
    // `line_total - discount_amount` to the subtotal, so a template must subtract
    // discount_amount itself before printing an amount that reconciles.
    line_total: number;
    discount_amount: number;
    price_book_item?: { image_url?: string | null } | null;
  }>;
}

/**
 * Net amount actually contributed to the subtotal by one line.
 *
 * Number()-coerced because the controllers hand the raw Prisma row to the template, so these
 * arrive as Decimal rather than number despite the declared types.
 */
export function lineNetTotal(li: { line_total: number; discount_amount: number }): number {
  return Math.round((Number(li.line_total) - Number(li.discount_amount)) * 100) / 100;
}

/** True when a document-level discount exists (Decimal-safe). */
export function hasDocDiscount(e: { discount_amount: number }): boolean {
  return Number(e.discount_amount) > 0;
}

interface OrgForPdf {
  name: string;
  address_line1: string;
  address_line2: string | null;
  city: string; state: string; postal_code: string;
  email: string;
  phone: string | null;
  website: string | null;
  logo_url: string | null;
  brand_color: string;
  estimate_terms: string;
  estimate_notes: string;
  estimate_payment_terms: string;
  // Optional (not required) so existing estimate-only callers/fixtures are unaffected —
  // only buildAlphaClassicInvoicePdf/buildCrmDefaultInvoicePdf read these.
  invoice_terms?: string;
  invoice_notes?: string;
  invoice_payment_terms?: string;
}

interface InvoiceForPdf {
  invoice_number: string;
  created_at: Date;
  due_date: Date | null;
  status: string;
  // Same GROSS/pre-discount convention as EstimateForPdf.subtotal above.
  subtotal: number;
  discount_amount: number;
  discount_name: string | null;
  tax_rate: number;
  tax_amount: number;
  // Entity-redesign §6 — draw-down against a paid kind=DEPOSIT invoice; a post-tax
  // Payment-shaped subtraction, never a discount line (see invoice.controller.ts).
  deposit_credit: number;
  total_amount: number;
  // The server-computed source of truth for what's left to collect. Printed directly
  // as "Balance Due" rather than re-derived from payments, so it never disagrees with
  // what recordPayment/refund/void actually persisted.
  amount_due: number;
  // Invoice.customer_id is required (entity-redesign §6) — no lead fallback needed, unlike
  // EstimateForPdf.customer above.
  customer: {
    first_name: string | null;
    last_name: string | null;
    company_name: string | null;
    email: string | null;
    // Nullable (unlike EstimateForPdf.customer.phone above) — formatPhoneDisplay already
    // tolerates null/undefined, and Customer.phone is a nullable column.
    phone: string | null;
    service_locations: Array<{
      is_primary: boolean;
      address_line1: string;
      address_line2: string | null;
      city: string; state: string; zip: string;
    }>;
  };
  // From the job (job-anchored invoice); null for job-less deposit/standalone invoices.
  service_location: {
    address_line1: string;
    address_line2: string | null;
    city: string; state: string; zip: string;
  } | null;
  scopes?: Omit<ScopeOfWork, 'internal_cost'>[] | null;
  line_items: Array<{
    description: string;
    item_type: string;
    quantity: number;
    unit_price: number;
    line_total: number;
    discount_amount: number;
    price_book_item?: { image_url: string | null } | null;
  }>;
  payments: Array<{ amount: number; voided_at: Date | null }>;
}

export function fmtCurrency(n: number): string {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(n);
}

export function fmtDate(d: Date): string {
  return d.toLocaleDateString('en-US', { weekday: 'short', year: 'numeric', month: 'short', day: 'numeric' });
}

export function fmtTaxRate(r: number): string {
  return `(${(r * 100).toFixed(3).replace(/0+$/, '').replace(/\.$/, '')}%)`;
}

export function pickContent(snap: string | null, live: string, status: string): string {
  if (status === 'DRAFT') return live;
  return snap ?? live;
}

/**
 * Resolve the service location to print, preferring the direct `service_location` anchor over
 * the legacy `lead.service_address_*` fields — mirrors `resolveCustomer` below. Field names
 * differ between the two sources (`address_line1`/`city`/… vs `service_address_line1`/
 * `service_city`/…), so this is a real reshape, not just a fallback swap.
 */
function resolveServiceLocation(estimate: EstimateForPdf): {
  address_line1: string;
  address_line2: string | null;
  city: string | null;
  state: string | null;
  zip: string | null;
} | null {
  if (estimate.service_location) return estimate.service_location;
  const l = estimate.lead;
  if (l?.service_address_line1) {
    return {
      address_line1: l.service_address_line1,
      address_line2: l.service_address_line2,
      city: l.service_city,
      state: l.service_state,
      zip: l.service_zip,
    };
  }
  return null;
}

/** Shared by isSameAsBilling/isInvoiceSameAsBilling below — the four-field address equality
 * check both use once they've each resolved their own (differently-shaped) location + primary. */
function addressesMatch(
  a: { address_line1: string | null; city: string | null; state: string | null; zip: string | null },
  b: { address_line1: string | null; city: string | null; state: string | null; zip: string | null },
): boolean {
  return (
    a.address_line1 === b.address_line1 &&
    a.city === b.city &&
    a.state === b.state &&
    a.zip === b.zip
  );
}

export function isSameAsBilling(estimate: EstimateForPdf): boolean {
  const loc = resolveServiceLocation(estimate);
  // no distinct service location recorded — render as "same as billing"
  if (!loc) return true;
  // "primary" (the customer's own address) is only derivable via the legacy
  // lead→customer→service_locations nesting — the direct top-level `customer` select carries no
  // service_locations list to compare against, so a populated location with no lead to check
  // against renders as a distinct address rather than risk a false "Same as billing".
  const primary = estimate.lead?.customer?.service_locations?.find(s => s.is_primary);
  if (!primary) return false;
  return addressesMatch(loc, primary);
}

export function buildAlphaClassicPdf(
  estimate: EstimateForPdf,
  org: OrgForPdf,
): TDocumentDefinitions {
  // customer_id is required on every estimate going forward — the direct anchor is the common
  // case; `lead?.customer` is the fallback for rows still reached only through their lead.
  const c = estimate.customer ?? estimate.lead?.customer;
  if (!c) throw new Error('Estimate has no customer');
  // "primary" (the customer's own address, shown in Prepared For) is only derivable via the
  // legacy lead→customer→service_locations nesting — the direct top-level `customer` select
  // carries no service_locations list. Undefined when there's no lead; the Prepared For block
  // below tolerates that (renders name/phone/email without an address line).
  const primary = estimate.lead?.customer?.service_locations?.find(s => s.is_primary);
  const terms = pickContent(estimate.snapshot_terms, org.estimate_terms, estimate.status);
  const notes = pickContent(estimate.snapshot_notes, org.estimate_notes, estimate.status);
  const paymentTerms = pickContent(estimate.snapshot_payment_terms, org.estimate_payment_terms, estimate.status);

  const logoBlock = org.logo_url
    ? { image: org.logo_url, fit: [200, 80] as [number, number] }
    : { text: org.name, fontSize: 24, bold: true, color: org.brand_color };

  const sameAsBilling = isSameAsBilling(estimate);
  const loc = resolveServiceLocation(estimate);
  const customerName = c.company_name || [c.first_name, c.last_name].filter(Boolean).join(' ');
  const preparedFor = [
    { text: 'Prepared For:', bold: true, margin: [0, 0, 0, 4] as any },
    customerName,
    primary ? [primary.address_line1, primary.city + ', ' + primary.state + ' ' + primary.zip].join('\n') : '',
    // #352 — storage is digits-only canonical; format for the customer-facing PDF.
    formatPhoneDisplay(c.phone),
    c.email || '',
  ];
  const serviceLocation = [
    { text: 'Service Location:', bold: true, margin: [0, 0, 0, 4] as any },
    sameAsBilling
      ? 'Same as billing'
      : [
          customerName,
          `${loc?.address_line1}\n${loc?.city}, ${loc?.state} ${loc?.zip}`,
          formatPhoneDisplay(c.phone),
          c.email || '',
        ].join('\n'),
  ];

  const tableBody: any[] = [
    [
      { text: 'Description', bold: true, fillColor: '#f5f5f5' },
      { text: 'QTY',         bold: true, fillColor: '#f5f5f5', alignment: 'center' },
      { text: 'Price',       bold: true, fillColor: '#f5f5f5', alignment: 'right' },
      { text: 'Amount',      bold: true, fillColor: '#f5f5f5', alignment: 'right' },
    ],
  ];
  for (const li of estimate.line_items) {
    const parts = li.description.split('\n');
    const net = lineNetTotal(li);
    tableBody.push([
      {
        stack: [
          { text: parts[0], bold: true },
          ...(parts.slice(1).length > 0
            ? [{ text: parts.slice(1).join('\n'), fontSize: 9, color: '#666' }]
            : []),
        ],
      },
      { text: String(li.quantity), alignment: 'center' },
      { text: fmtCurrency(li.unit_price), alignment: 'right' },
      // Print the NET amount — the figure this line actually contributes to the Sub total.
      Number(li.discount_amount) > 0
        ? {
            stack: [
              { text: fmtCurrency(li.line_total), decoration: 'lineThrough', color: '#999999', fontSize: 9 },
              { text: fmtCurrency(net) },
            ],
            alignment: 'right' as const,
          }
        : { text: fmtCurrency(net), alignment: 'right' },
    ]);
  }
  // §2.5b — priced scope-of-work blocks render as their own line, right after the line items,
  // in the SAME table/Amount column line items use — so the Sub total below is the literal sum
  // of everything printed above it. Unpriced scopes (flat_price == null) carry no amount to
  // reconcile and are intentionally omitted here (they're narrative-only, matching scope_notes).
  const pricedScopes = asScopeArray(estimate.scopes).filter((s) => s.flat_price != null);
  for (const scope of pricedScopes) {
    tableBody.push([
      {
        stack: [
          { text: 'SCOPE OF WORK', bold: true, fontSize: 7, color: '#999999', margin: [0, 0, 0, 2] as any },
          { text: scope.title, bold: true },
          ...(scope.body ? [{ text: scope.body, fontSize: 9, color: '#666' }] : []),
        ],
      },
      { text: '—', alignment: 'center' },
      { text: '—', alignment: 'right' },
      { text: fmtCurrency(scope.flat_price ?? 0), alignment: 'right' },
    ]);
  }

  const totalsTable = {
    columns: [
      { width: '*', text: '' },
      {
        width: 'auto',
        table: {
          widths: [75, 75] as any,
          body: [
            [{ text: 'Sub total', alignment: 'right' }, { text: fmtCurrency(estimate.subtotal), alignment: 'right' }],
            // Document-level discount sits between Sub total and Tax, matching the order
            // calculateTotals applies it in. Omitted entirely when there isn't one.
            ...(hasDocDiscount(estimate)
              ? [[
                  { text: estimate.discount_name || 'Discount', alignment: 'right' },
                  { text: `−${fmtCurrency(Number(estimate.discount_amount))}`, alignment: 'right' },
                ]]
              : []),
            [{ text: `Tax ${fmtTaxRate(estimate.tax_rate)}`, alignment: 'right' }, { text: fmtCurrency(estimate.tax_amount), alignment: 'right' }],
            [{ text: 'Total', alignment: 'right', bold: true, fontSize: 12 }, { text: fmtCurrency(estimate.total_amount), alignment: 'right', bold: true, fontSize: 12 }],
          ],
        },
        layout: 'noBorders',
      },
    ],
    margin: [0, 10, 0, 20] as any,
  };

  const signatureBlock = estimate.signature_data
    ? [
        { text: 'Customer Signature:', bold: true, margin: [0, 20, 0, 8] as any },
        { image: estimate.signature_data, width: 150, height: 60 },
        { text: `Approved on ${estimate.signature_at ? fmtDate(estimate.signature_at) : ''}`, fontSize: 9, color: '#666' },
      ]
    : [];

  return {
    content: [
      {
        columns: [
          { width: 200, ...logoBlock },
          { text: 'ESTIMATE', fontSize: 32, bold: true, color: '#666', alignment: 'right' },
        ],
        margin: [0, 0, 0, 20] as any,
      },
      {
        columns: [
          {
            stack: [
              org.name,
              `${org.address_line1}, ${org.city}, ${org.state}, ${org.postal_code}`,
              org.email,
              org.website || '',
            ],
          },
          {
            columns: [
              { width: '*', text: '' },
              {
                width: 'auto',
                table: {
                  widths: ['auto', 100] as any,
                  body: [
                    [{ text: 'Estimate #', bold: true, alignment: 'right' }, { text: estimate.estimate_number, alignment: 'right' }],
                    [{ text: 'Date',       bold: true, alignment: 'right' }, { text: fmtDate(estimate.created_at), alignment: 'right' }],
                    [{ text: 'Total',      bold: true, alignment: 'right' }, { text: fmtCurrency(estimate.total_amount), alignment: 'right' }],
                  ],
                },
                layout: 'noBorders',
              },
            ],
          },
        ],
        margin: [0, 0, 0, 30] as any,
      },
      {
        columns: [
          { stack: preparedFor },
          { stack: serviceLocation },
        ],
        margin: [0, 0, 0, 20] as any,
      },
      {
        table: {
          headerRows: 1,
          widths: ['*', 40, 70, 70] as any,
          body: tableBody,
        },
        layout: {
          hLineWidth: () => 0.5,
          vLineWidth: () => 0,
          hLineColor: () => '#e5e5e5',
        },
      },
      totalsTable as any,
      { text: 'Terms:', bold: true, margin: [0, 10, 0, 4] as any },
      { text: terms, style: 'paragraph' },
      { text: 'Notes:', bold: true, margin: [0, 16, 0, 4] as any },
      ...markdownToPdfMake(notes),
      { text: 'PAYMENT TERMS:', bold: true, margin: [0, 16, 0, 4] as any },
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

/** True when the invoice carries no distinct job service location, or that location matches
 * the customer's own primary address — mirrors isSameAsBilling's estimate-side logic. */
export function isInvoiceSameAsBilling(invoice: InvoiceForPdf): boolean {
  const loc = invoice.service_location;
  if (!loc) return true;
  const primary = invoice.customer.service_locations.find((s) => s.is_primary);
  if (!primary) return false;
  return addressesMatch(loc, primary);
}

/** Sum of non-voided payments — the "Payments" row must not count money that was voided. */
export function activePaymentsTotal(payments: InvoiceForPdf['payments']): number {
  return Math.round(payments.filter((p) => !p.voided_at).reduce((s, p) => s + Number(p.amount), 0) * 100) / 100;
}

export function buildAlphaClassicInvoicePdf(
  invoice: InvoiceForPdf,
  org: OrgForPdf,
): TDocumentDefinitions {
  const c = invoice.customer;
  // Invoices have no snapshot_* columns (unlike estimates) — always the org's CURRENT copy.
  const terms = org.invoice_terms ?? '';
  const notes = org.invoice_notes ?? '';
  const paymentTerms = org.invoice_payment_terms ?? '';

  const logoBlock = org.logo_url
    ? { image: org.logo_url, fit: [200, 80] as [number, number] }
    : { text: org.name, fontSize: 24, bold: true, color: org.brand_color };

  const sameAsBilling = isInvoiceSameAsBilling(invoice);
  const loc = invoice.service_location;
  const primary = c.service_locations.find((s) => s.is_primary);
  const customerName = c.company_name || [c.first_name, c.last_name].filter(Boolean).join(' ');
  const billTo = [
    { text: 'Bill To:', bold: true, margin: [0, 0, 0, 4] as any },
    customerName,
    primary ? [primary.address_line1, `${primary.city}, ${primary.state} ${primary.zip}`].join('\n') : '',
    formatPhoneDisplay(c.phone),
    c.email || '',
  ];
  const serviceLocation = [
    { text: 'Service Location:', bold: true, margin: [0, 0, 0, 4] as any },
    sameAsBilling
      ? 'Same as billing'
      : [
          customerName,
          `${loc?.address_line1}\n${loc?.city}, ${loc?.state} ${loc?.zip}`,
          formatPhoneDisplay(c.phone),
          c.email || '',
        ].join('\n'),
  ];

  const tableBody: any[] = [
    [
      { text: 'Description', bold: true, fillColor: '#f5f5f5' },
      { text: 'QTY',         bold: true, fillColor: '#f5f5f5', alignment: 'center' },
      { text: 'Price',       bold: true, fillColor: '#f5f5f5', alignment: 'right' },
      { text: 'Amount',      bold: true, fillColor: '#f5f5f5', alignment: 'right' },
    ],
  ];
  for (const li of invoice.line_items) {
    const parts = li.description.split('\n');
    const net = lineNetTotal(li);
    tableBody.push([
      {
        stack: [
          { text: parts[0], bold: true },
          ...(parts.slice(1).length > 0
            ? [{ text: parts.slice(1).join('\n'), fontSize: 9, color: '#666' }]
            : []),
        ],
      },
      { text: String(li.quantity), alignment: 'center' },
      { text: fmtCurrency(li.unit_price), alignment: 'right' },
      Number(li.discount_amount) > 0
        ? {
            stack: [
              { text: fmtCurrency(li.line_total), decoration: 'lineThrough', color: '#999999', fontSize: 9 },
              { text: fmtCurrency(net) },
            ],
            alignment: 'right' as const,
          }
        : { text: fmtCurrency(net), alignment: 'right' },
    ]);
  }
  const pricedScopes = asScopeArray(invoice.scopes).filter((s) => s.flat_price != null);
  for (const scope of pricedScopes) {
    tableBody.push([
      {
        stack: [
          { text: 'SCOPE OF WORK', bold: true, fontSize: 7, color: '#999999', margin: [0, 0, 0, 2] as any },
          { text: scope.title, bold: true },
          ...(scope.body ? [{ text: scope.body, fontSize: 9, color: '#666' }] : []),
        ],
      },
      { text: '—', alignment: 'center' },
      { text: '—', alignment: 'right' },
      { text: fmtCurrency(scope.flat_price ?? 0), alignment: 'right' },
    ]);
  }

  const paid = activePaymentsTotal(invoice.payments);
  const totalsTable = {
    columns: [
      { width: '*', text: '' },
      {
        width: 'auto',
        table: {
          widths: [75, 75] as any,
          body: [
            [{ text: 'Sub total', alignment: 'right' }, { text: fmtCurrency(invoice.subtotal), alignment: 'right' }],
            ...(hasDocDiscount(invoice)
              ? [[
                  { text: invoice.discount_name || 'Discount', alignment: 'right' },
                  { text: `−${fmtCurrency(Number(invoice.discount_amount))}`, alignment: 'right' },
                ]]
              : []),
            [{ text: `Tax ${fmtTaxRate(invoice.tax_rate)}`, alignment: 'right' }, { text: fmtCurrency(invoice.tax_amount), alignment: 'right' }],
            [{ text: 'Total', alignment: 'right', bold: true, fontSize: 12 }, { text: fmtCurrency(invoice.total_amount), alignment: 'right', bold: true, fontSize: 12 }],
            ...(invoice.deposit_credit > 0
              ? [[
                  { text: 'Deposit credit', alignment: 'right' },
                  { text: `−${fmtCurrency(invoice.deposit_credit)}`, alignment: 'right' },
                ]]
              : []),
            ...(paid > 0
              ? [[
                  { text: 'Payments', alignment: 'right' },
                  { text: `−${fmtCurrency(paid)}`, alignment: 'right' },
                ]]
              : []),
            [{ text: 'Balance Due', alignment: 'right', bold: true, fontSize: 12 }, { text: fmtCurrency(invoice.amount_due), alignment: 'right', bold: true, fontSize: 12 }],
          ],
        },
        layout: 'noBorders',
      },
    ],
    margin: [0, 10, 0, 20] as any,
  };

  return {
    content: [
      {
        columns: [
          { width: 200, ...logoBlock },
          { text: 'INVOICE', fontSize: 32, bold: true, color: '#666', alignment: 'right' },
        ],
        margin: [0, 0, 0, 20] as any,
      },
      {
        columns: [
          {
            stack: [
              org.name,
              `${org.address_line1}, ${org.city}, ${org.state}, ${org.postal_code}`,
              org.email,
              org.website || '',
            ],
          },
          {
            columns: [
              { width: '*', text: '' },
              {
                width: 'auto',
                table: {
                  widths: ['auto', 100] as any,
                  body: [
                    [{ text: 'Invoice #', bold: true, alignment: 'right' }, { text: invoice.invoice_number, alignment: 'right' }],
                    [{ text: 'Date',      bold: true, alignment: 'right' }, { text: fmtDate(invoice.created_at), alignment: 'right' }],
                    [{ text: 'Balance',   bold: true, alignment: 'right' }, { text: fmtCurrency(invoice.amount_due), alignment: 'right' }],
                    [{ text: 'Due On',    bold: true, alignment: 'right' }, { text: invoice.due_date ? fmtDate(invoice.due_date) : '—', alignment: 'right' }],
                  ],
                },
                layout: 'noBorders',
              },
            ],
          },
        ],
        margin: [0, 0, 0, 30] as any,
      },
      {
        columns: [
          { stack: billTo },
          { stack: serviceLocation },
        ],
        margin: [0, 0, 0, 20] as any,
      },
      {
        table: {
          headerRows: 1,
          widths: ['*', 40, 70, 70] as any,
          body: tableBody,
        },
        layout: {
          hLineWidth: () => 0.5,
          vLineWidth: () => 0,
          hLineColor: () => '#e5e5e5',
        },
      },
      totalsTable as any,
      ...(terms ? [{ text: 'Terms:', bold: true, margin: [0, 10, 0, 4] as any }, { text: terms, style: 'paragraph' }] : []),
      ...(notes ? [{ text: 'Notes:', bold: true, margin: [0, 16, 0, 4] as any }, ...markdownToPdfMake(notes)] : []),
      ...(paymentTerms ? [{ text: 'PAYMENT TERMS:', bold: true, margin: [0, 16, 0, 4] as any }, ...markdownToPdfMake(paymentTerms)] : []),
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

export type { EstimateForPdf, OrgForPdf, InvoiceForPdf };
