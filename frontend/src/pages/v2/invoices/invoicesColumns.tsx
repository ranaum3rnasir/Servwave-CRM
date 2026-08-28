import type { ColumnDef, SortingState } from '@tanstack/react-table';
import { ArrowDown, ArrowUp, ChevronsUpDown } from 'lucide-react';

import { customerDisplayName } from '@/lib/customer-name';
import { formatCurrency } from '@/lib/utils';
import { TagChips, type TagChip } from '@/components/data/TagChips';
import { Button } from '@/ui-kit/components/ui/button';
import { Checkbox } from '@/ui-kit/components/ui/checkbox';

import { StatusChip } from '../_shared/statusChip';

export interface InvoiceListItem {
  id: string;
  invoice_number: string;
  status: string;
  kind: string;
  subtotal: number | string;
  discount_amount: number | string;
  tax_amount: number | string;
  deposit_credit: number | string;
  total_amount: number | string;
  amount_due: number | string;
  due_date: string | null;
  sent_at: string | null;
  paid_at: string | null;
  created_at: string;
  // customer is always present on the invoice; job is optional (deposit/orphan
  // invoices have no job).
  customer: {
    id: string;
    first_name: string;
    last_name: string;
    company_name: string | null;
  };
  job: {
    id: string;
    job_number: string;
  } | null;
  tags?: TagChip[];
}

/**
 * OVERDUE is a derived pseudo-status, never persisted. Ported verbatim from
 * `InvoicesPage.tsx`: false when there is no due date, false unless the status
 * is SENT or PARTIAL, otherwise `due_date < now`.
 */
export function isOverdue(invoice: InvoiceListItem): boolean {
  if (!invoice.due_date) return false;
  if (invoice.status !== 'SENT' && invoice.status !== 'PARTIAL') return false;
  return new Date(invoice.due_date) < new Date();
}

/**
 * The four money columns the legacy page hides on first render
 * (`DEFAULT_COLUMN_VISIBILITY`), handed to the table as
 * `defaultColumnVisibility`. Run-once by construction: it seeds the table's
 * own visibility state, so a user who turns one back on in the Columns menu -
 * or has one stored in a saved view - keeps it on.
 */
export const DEFAULT_COLUMN_VISIBILITY = {
  subtotal: false,
  discount_amount: false,
  tax_amount: false,
  deposit_credit: false,
};

/**
 * Sorting is SERVER-side: the column id is sent as `sortBy` and the list
 * refetches. The page hands its sorting state to the DataTable as
 * `sorting`/`onSortingChange` with `manualSorting`, so the table renders the
 * rows in the order the server returned them and never re-sorts them itself.
 *
 * The six ids below are the six the backend allow-lists
 * (`invoice.controller.ts` - created_at, invoice_number, status, amount_due,
 * due_date, total_amount) and the same six the legacy page leaves sortable.
 */
function SortHeader({
  columnId, title, align, sorting, onToggleSort,
}: {
  columnId: string;
  title: string;
  align?: 'right';
  sorting: SortingState;
  onToggleSort: (columnId: string) => void;
}) {
  const active = sorting[0]?.id === columnId ? sorting[0] : undefined;
  return (
    <Button
      variant="ghost"
      size="sm"
      // `text-[11.5px] font-semibold` matches TableHead's own type scale -
      // Button's `size="sm"` ships `text-[13px]`, which would otherwise make
      // sortable titles bigger and lighter than the plain headers beside them.
      className={align === 'right'
        ? '-me-2 h-7 w-full justify-end gap-1.5 px-2 text-[11.5px] font-semibold'
        : '-ms-2 h-7 gap-1.5 px-2 text-[11.5px] font-semibold'}
      onClick={() => onToggleSort(columnId)}
    >
      <span>{title}</span>
      {active
        ? (active.desc ? <ArrowDown /> : <ArrowUp />)
        : <ChevronsUpDown />}
    </Button>
  );
}

/** A right-aligned money cell. `-` for a zero the legacy page suppresses. */
function Money({ value, dash, weight }: { value: number; dash?: boolean; weight?: 'medium' | 'bold' }) {
  return (
    <span
      className={
        weight === 'bold'
          ? 'block text-right font-bold tabular-nums'
          : weight === 'medium'
            ? 'block text-right font-medium tabular-nums'
            : 'block text-right tabular-nums'
      }
    >
      {dash && value === 0 ? '-' : formatCurrency(value)}
    </span>
  );
}

export function buildInvoiceColumns(
  sorting: SortingState,
  onToggleSort: (columnId: string) => void,
  onOpenJob: (jobId: string) => void,
): ColumnDef<InvoiceListItem, unknown>[] {
  const sortable = (columnId: string, title: string, align?: 'right') => () =>
    <SortHeader columnId={columnId} title={title} align={align} sorting={sorting} onToggleSort={onToggleSort} />;

  return [
    // Row selection exists here because the module HAS a bulk action - the
    // Send / Send reminder bar the legacy list grew with `enableRowSelection`.
    // `meta.fixed` keeps the 40px box out of the surplus-width share-out, and
    // no `accessorKey` keeps it out of the Columns menu.
    {
      id: '__select',
      size: 40,
      minSize: 40,
      enableHiding: false,
      enableResizing: false,
      // The legacy invoices list pins NOTHING - it is the one of the five with
      // no `meta.pinned` at all - so only the leading checkbox is pinned here.
      // Extending the run over invoice_number/customer would be inventing a
      // layout the legacy list never had.
      meta: { pinned: true, fixed: true },
      header: ({ table }) => (
        <Checkbox
          aria-label="Select all rows"
          checked={
            table.getIsAllRowsSelected()
              ? true
              : table.getIsSomeRowsSelected()
                ? 'indeterminate'
                : false
          }
          onCheckedChange={(value) => table.toggleAllRowsSelected(value === true)}
        />
      ),
      cell: ({ row }) => (
        <Checkbox
          aria-label="Select row"
          checked={row.getIsSelected()}
          onCheckedChange={(value) => row.toggleSelected(value === true)}
          // The row itself navigates on click - stop the box from doing both.
          onClick={(e) => e.stopPropagation()}
        />
      ),
    },
    {
      id: 'invoice_number',
      accessorKey: 'invoice_number',
      header: sortable('invoice_number', 'Invoice #'),
      size: 120,
      minSize: 100,
      meta: { label: 'Invoice #', fixed: true },
      cell: ({ row }) => (
        <span className="text-brand font-medium">{row.original.invoice_number}</span>
      ),
    },
    {
      id: 'customer',
      accessorKey: 'customer',
      header: 'Customer',
      size: 180,
      minSize: 140,
      meta: { label: 'Customer' },
      cell: ({ row }) => {
        const c = row.original.customer;
        return (
          <div className="min-w-0">
            <span className="block truncate font-medium">{customerDisplayName(c, '')}</span>
            {c.company_name && (c.first_name || c.last_name) && (
              <span className="text-muted-foreground block truncate text-xs">{c.company_name}</span>
            )}
          </div>
        );
      },
    },
    {
      id: 'job',
      accessorKey: 'job',
      header: 'Job',
      size: 100,
      minSize: 80,
      meta: { label: 'Job', fixed: true },
      // Ported behaviour, deliberately NOT react-router: the legacy cell stops
      // propagation (so the row click does not also fire) and then sets
      // `window.location.href`, a FULL page load into the legacy Jobs module.
      // Jobs is a different migration; a soft navigation from here would land
      // inside the v2 shell on a route that may not exist yet.
      cell: ({ row }) => {
        const job = row.original.job;
        if (!job) return <span className="text-muted-foreground">{'-'}</span>;
        return (
          <span
            role="link"
            tabIndex={0}
            className="text-brand cursor-pointer font-medium hover:underline"
            onClick={(e) => {
              e.stopPropagation();
              onOpenJob(job.id);
            }}
            onKeyDown={(e) => {
              if (e.key !== 'Enter' && e.key !== ' ') return;
              e.stopPropagation();
              e.preventDefault();
              onOpenJob(job.id);
            }}
          >
            {job.job_number}
          </span>
        );
      },
    },
    {
      id: 'status',
      accessorKey: 'status',
      header: sortable('status', 'Status'),
      size: 110,
      minSize: 90,
      meta: { label: 'Status', fixed: true },
      cell: ({ row }) => (
        <StatusChip domain="invoice" status={isOverdue(row.original) ? 'OVERDUE' : row.original.status} />
      ),
    },
    {
      id: 'subtotal',
      accessorKey: 'subtotal',
      header: () => <span className="block text-right">Subtotal</span>,
      size: 100,
      minSize: 80,
      meta: { label: 'Subtotal', fixed: true },
      cell: ({ row }) => <Money value={Number(row.original.subtotal)} />,
    },
    {
      id: 'discount_amount',
      accessorKey: 'discount_amount',
      header: () => <span className="block text-right">Discount</span>,
      size: 90,
      minSize: 70,
      meta: { label: 'Discount', fixed: true },
      cell: ({ row }) => <Money value={Number(row.original.discount_amount)} dash />,
    },
    {
      id: 'tax_amount',
      accessorKey: 'tax_amount',
      header: () => <span className="block text-right">Tax</span>,
      size: 80,
      minSize: 70,
      meta: { label: 'Tax', fixed: true },
      cell: ({ row }) => <Money value={Number(row.original.tax_amount)} />,
    },
    {
      id: 'deposit_credit',
      accessorKey: 'deposit_credit',
      header: () => <span className="block text-right">Deposit Credit</span>,
      size: 100,
      minSize: 80,
      meta: { label: 'Deposit Credit', fixed: true },
      cell: ({ row }) => <Money value={Number(row.original.deposit_credit)} dash />,
    },
    {
      id: 'total_amount',
      accessorKey: 'total_amount',
      header: sortable('total_amount', 'Total', 'right'),
      size: 110,
      minSize: 90,
      meta: { label: 'Total', fixed: true },
      cell: ({ row }) => <Money value={Number(row.original.total_amount)} weight="medium" />,
    },
    {
      id: 'amount_due',
      accessorKey: 'amount_due',
      header: sortable('amount_due', 'Amount Due', 'right'),
      size: 120,
      minSize: 100,
      meta: { label: 'Amount Due', fixed: true },
      cell: ({ row }) => {
        const val = Number(row.original.amount_due);
        return <Money value={val} weight={val > 0 ? 'bold' : undefined} />;
      },
    },
    {
      id: 'due_date',
      accessorKey: 'due_date',
      header: sortable('due_date', 'Due Date'),
      size: 120,
      minSize: 100,
      meta: { label: 'Due Date', fixed: true },
      cell: ({ row }) => {
        const { due_date } = row.original;
        if (!due_date) return <span className="text-muted-foreground">{'-'}</span>;
        return (
          <span className={isOverdue(row.original) ? 'text-status-red-emphasis' : undefined}>
            {new Date(due_date).toLocaleDateString()}
          </span>
        );
      },
    },
    {
      id: 'tags',
      accessorKey: 'tags',
      header: 'Tags',
      size: 140,
      minSize: 80,
      meta: { label: 'Tags' },
      cell: ({ row }) => <TagChips tags={row.original.tags} />,
    },
    {
      id: 'created_at',
      accessorKey: 'created_at',
      header: sortable('created_at', 'Created'),
      size: 110,
      minSize: 90,
      meta: { label: 'Created', fixed: true },
      cell: ({ row }) => (
        <span className="text-muted-foreground text-sm">
          {new Date(row.original.created_at).toLocaleDateString()}
        </span>
      ),
    },
  ];
}
