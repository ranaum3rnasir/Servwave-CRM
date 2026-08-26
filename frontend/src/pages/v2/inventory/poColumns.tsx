import type { ColumnDef } from '@tanstack/react-table';
import { Eye, Mail, PackageCheck, Truck } from 'lucide-react';

import type { EstimateReservation, PurchaseOrder } from '@/lib/api/inventory';
import { formatCurrency } from '@/lib/utils';
import { cn } from '@/ui-kit/lib/utils';
import { Badge } from '@/ui-kit/components/ui/badge';
import { Button } from '@/ui-kit/components/ui/button';
import { Progress } from '@/ui-kit/components/ui/progress';

import { StatusChip } from '../_shared/statusChip';

import { buildSelectColumn } from '../_shared/selectColumn';
import { ClientSortHeader } from '../_shared/sortHeader';

import { EM_DASH } from './glyphs';

/**
 * SORTING IS THE TABLE'S on all three of these grids. PurchaseOrdersPage hands
 * each DataTable a complete array with no `page` and no `manualSorting`, so a
 * header click drives TanStack's own sorted row model.
 *
 * Most columns here named an accessorKey that is not a field: `ref`, `vendor`
 * and `job` on a PrePORow are computed from a discriminated union, and `total`,
 * `age`, `lines`, `received` and `lead` are all derived. Every one of them read
 * `undefined` and sorted nothing. They are real accessors below, each computing
 * exactly what its own cell prints.
 *
 * A SELECTION COLUMN is opt-in on all three via `selectable`, and the page opts
 * in on all three: each grid now carries Export selected, which needs no
 * backend. Every WRITE the page offers is still per-row (preview, email,
 * receive, convert) because `PurchaseOrder` has no `bulk-*` route of any kind -
 * a bulk send, bulk receive or bulk close would be a button with nothing
 * behind it.
 */

/** Discriminated union so the Pre-PO table can render mixed row types. */
export type PrePORow =
  | { kind: 'draft'; data: PurchaseOrder }
  | { kind: 'reservation'; data: EstimateReservation };

const MS_PER_DAY = 24 * 60 * 60 * 1000;

export function daysBetween(aISO: string, b: Date): number {
  return Math.round((b.getTime() - new Date(aISO).getTime()) / MS_PER_DAY);
}

export function poTotal(po: PurchaseOrder): number {
  // Real per-line unit costs. Cost-stripped/absent values count as $0 - the
  // row-level display shows "-" for those, this is only the aggregate column.
  return po.lines.reduce((sum, l) => sum + l.qtyOrdered * (l.unitCost ?? 0), 0);
}

export function fmtDate(iso: string | undefined): string {
  if (!iso) return '-';
  return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

export function prePOAge(r: PrePORow, today: Date): number {
  return daysBetween(r.kind === 'draft' ? r.data.orderedAt : r.data.approvedAt, today);
}
export function prePORef(r: PrePORow): string {
  return r.kind === 'draft' ? r.data.poNumber : r.data.estimateNumber;
}
export function prePOVendor(r: PrePORow): string | undefined {
  return r.kind === 'draft' ? r.data.vendor : r.data.preferredVendor;
}
export function prePOTrade(r: PrePORow): string | undefined {
  return r.data.trade;
}
export function prePOJobLabel(r: PrePORow): string {
  const job = r.data.jobNumber;
  const cust = r.data.customer;
  if (job && cust) return `${job} · ${cust}`;
  return job || cust || '-';
}
export function prePOTotal(r: PrePORow): number {
  return r.kind === 'draft' ? poTotal(r.data) : r.data.reservedTotal;
}

/** The brand-tinted "next action" pill, as a kit Button. */
function NextAction({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <Button
      variant="secondary"
      size="sm"
      onClick={(e) => { e.stopPropagation(); onClick(); }}
    >
      {label}
    </Button>
  );
}

export function buildPrePOColumns({
  today, onRowClick, onViewConvertedPO, selectable = false,
}: {
  today: Date;
  onRowClick: (r: PrePORow) => void;
  onViewConvertedPO: (reservation: EstimateReservation) => void;
  selectable?: boolean;
}): ColumnDef<PrePORow, unknown>[] {
  const columns: ColumnDef<PrePORow, unknown>[] = [
    {
      id: 'type',
      accessorKey: 'kind',
      header: ({ column }) => <ClientSortHeader column={column} title="Type" />,
      size: 150,
      meta: { label: 'Type', fixed: true },
      cell: ({ row }) => (
        <span className="inline-flex flex-col items-start gap-1">
          <Badge variant={row.original.kind === 'draft' ? 'softNeutral' : 'softBlue'} size="pill">
            {row.original.kind === 'draft' ? 'Draft' : 'Est. Reservation'}
          </Badge>
          {row.original.kind === 'reservation' && (
            <StatusChip domain="estimateReservation" status={row.original.data.status ?? 'open'} />
          )}
        </span>
      ),
    },
    {
      id: 'ref',
      accessorFn: (row) => prePORef(row),
      header: ({ column }) => <ClientSortHeader column={column} title="Ref #" />,
      size: 110,
      meta: { label: 'Ref #', fixed: true },
      cell: ({ row }) => <span className="font-mono text-xs">{prePORef(row.original)}</span>,
    },
    {
      id: 'vendor',
      accessorFn: (row) => prePOVendor(row) ?? '',
      header: ({ column }) => <ClientSortHeader column={column} title="Vendor(s)" />,
      size: 200,
      meta: { label: 'Vendor(s)' },
      cell: ({ row }) => (
        <span className="text-muted-foreground">{prePOVendor(row.original) ?? '-'}</span>
      ),
    },
    {
      id: 'job',
      accessorFn: (row) => prePOJobLabel(row),
      header: ({ column }) => <ClientSortHeader column={column} title="Job / Customer" />,
      size: 200,
      meta: { label: 'Job / Customer' },
      cell: ({ row }) => (
        <span className="text-muted-foreground flex flex-col">
          <span>{prePOJobLabel(row.original)}</span>
          {/* An approved estimate's reservation stays open even when the lead is
              lost - show why. */}
          {row.original.kind === 'reservation' &&
            (row.original.data.estimateStatus || row.original.data.leadStatus) && (
              <span className="text-subtle-foreground text-[11px]">
                Est {row.original.data.estimateStatus ?? '-'} · Lead {row.original.data.leadStatus ?? '-'}
              </span>
            )}
        </span>
      ),
    },
    {
      id: 'lines',
      // By unit count - the second and larger of the two numbers in the cell.
      accessorFn: (row) => (row.kind === 'draft'
        ? row.data.lines.reduce((sum, line) => sum + line.qtyOrdered, 0)
        : row.data.linesSummary.units),
      header: ({ column }) => <ClientSortHeader column={column} title="Lines / Units" />,
      size: 160,
      meta: { label: 'Lines / Units' },
      cell: ({ row }) => (
        <span className="text-muted-foreground">
          {row.original.kind === 'draft'
            ? `${row.original.data.lines.length} items · ${row.original.data.lines.reduce((s, l) => s + l.qtyOrdered, 0)} units`
            : `${row.original.data.linesSummary.items} items · ${row.original.data.linesSummary.units} units`}
        </span>
      ),
    },
    {
      id: 'total',
      accessorFn: (row) => prePOTotal(row),
      header: ({ column }) => <ClientSortHeader column={column} align="right" title="Est. Total" />,
      size: 120,
      meta: { label: 'Est. Total', fixed: true },
      cell: ({ row }) => (
        <span className="block text-right tabular-nums">{formatCurrency(prePOTotal(row.original))}</span>
      ),
    },
    {
      id: 'age',
      accessorFn: (row) => prePOAge(row, today),
      header: ({ column }) => <ClientSortHeader column={column} title="Age" />,
      size: 100,
      meta: { label: 'Age', fixed: true },
      cell: ({ row }) => {
        const age = prePOAge(row.original, today);
        return (
          <span
            className={cn(
              'text-xs font-medium',
              age > 7
                ? 'text-status-red-emphasis'
                : age > 3
                  ? 'text-status-amber-emphasis'
                  : 'text-muted-foreground',
            )}
          >
            {age}d ago
          </span>
        );
      },
    },
    {
      id: 'next',
      header: 'Next action',
      size: 160,
      enableHiding: false,
      // A button column has nothing to order by.
      enableSorting: false,
      meta: { label: 'Next action', fixed: true },
      cell: ({ row }) => {
        const r = row.original;
        // Status-aware for reservations: open -> convert (detail dialog);
        // converted -> jump to the linked PO; dismissed -> no action.
        if (r.kind === 'reservation') {
          const status = r.data.status ?? 'open';
          if (status === 'converted') {
            return <NextAction label="View PO →" onClick={() => onViewConvertedPO(r.data)} />;
          }
          if (status === 'dismissed') {
            return <span className="text-muted-foreground text-xs">{'-'}</span>;
          }
        }
        return (
          <NextAction
            label={r.kind === 'draft' ? 'Send to vendor →' : 'Convert to PO →'}
            onClick={() => onRowClick(r)}
          />
        );
      },
    },
  ];

  // A Pre-PO row is a union, so its label uses the same `prePORef` the Ref #
  // cell prints - a draft's PO number or a reservation's estimate number.
  return selectable
    ? [buildSelectColumn<PrePORow>({
        allLabel: 'Select all pre-PO rows on this page',
        rowLabel: (r) => `Select ${prePORef(r)}`,
      }), ...columns]
    : columns;
}

function VendorCell({ vendor }: { vendor: string }) {
  return (
    <span className="text-muted-foreground flex items-center gap-1.5">
      <Truck className="size-3.5" />
      {vendor}
    </span>
  );
}

function JobCell({ po }: { po: PurchaseOrder }) {
  if (!po.jobNumber) {
    return (
      <span className="text-muted-foreground text-xs">
        {EM_DASH} no job link {EM_DASH}
      </span>
    );
  }
  return (
    <span className="flex flex-col">
      <span className="text-brand font-mono text-[11px]">{po.jobNumber}</span>
      <span className="text-muted-foreground text-[12px]">{po.customer ?? '-'}</span>
    </span>
  );
}

export function buildOpenPOColumns({
  isLate, isArrivingThisWeek, onPreview, onEmail, onReceive, selectable = false,
}: {
  isLate: (po: PurchaseOrder) => boolean;
  isArrivingThisWeek: (po: PurchaseOrder) => boolean;
  onPreview: (po: PurchaseOrder) => void;
  onEmail: (po: PurchaseOrder) => void;
  onReceive: (po: PurchaseOrder) => void;
  selectable?: boolean;
}): ColumnDef<PurchaseOrder, unknown>[] {
  const columns: ColumnDef<PurchaseOrder, unknown>[] = [
    {
      id: 'status',
      accessorKey: 'status',
      header: ({ column }) => <ClientSortHeader column={column} title="Status" />,
      size: 110,
      meta: { label: 'Status', fixed: true },
      cell: ({ row }) => <StatusChip domain="purchaseOrder" status={row.original.status} />,
    },
    {
      id: 'po',
      accessorKey: 'poNumber',
      header: ({ column }) => <ClientSortHeader column={column} title="PO #" />,
      size: 110,
      meta: { label: 'PO #', fixed: true },
      cell: ({ row }) => <span className="font-mono text-xs">{row.original.poNumber}</span>,
    },
    {
      id: 'vendor',
      accessorKey: 'vendor',
      header: ({ column }) => <ClientSortHeader column={column} title="Vendor" />,
      size: 180,
      meta: { label: 'Vendor' },
      cell: ({ row }) => <VendorCell vendor={row.original.vendor} />,
    },
    {
      id: 'job',
      // The cell leads with the job number and falls back to an em-dash note,
      // so an unlinked PO sorts to one end rather than interleaving on a null.
      accessorFn: (po) => po.jobNumber ?? '',
      header: ({ column }) => <ClientSortHeader column={column} title="Job / Customer" />,
      size: 180,
      meta: { label: 'Job / Customer' },
      cell: ({ row }) => <JobCell po={row.original} />,
    },
    {
      id: 'ordered',
      accessorFn: (po) => new Date(po.orderedAt).getTime(),
      header: ({ column }) => <ClientSortHeader column={column} title="Ordered" />,
      size: 100,
      meta: { label: 'Ordered', fixed: true },
      cell: ({ row }) => (
        <span className="text-muted-foreground text-xs">{fmtDate(row.original.orderedAt)}</span>
      ),
    },
    {
      id: 'expected',
      // By instant, not by the "Jul 10" string the cell formats - "Apr" sorts
      // before "Jul" alphabetically, and that is not a date order.
      accessorFn: (po) => (po.expectedDate ? new Date(po.expectedDate).getTime() : null),
      header: ({ column }) => <ClientSortHeader column={column} title="Expected" />,
      size: 110,
      meta: { label: 'Expected', fixed: true },
      cell: ({ row }) => {
        const po = row.original;
        if (isLate(po)) {
          return (
            <span className="text-status-red-emphasis inline-flex items-center gap-1 text-xs font-semibold">
              <span className="bg-status-red inline-block size-1.5 rounded-full" />
              {fmtDate(po.expectedDate)}
            </span>
          );
        }
        if (isArrivingThisWeek(po)) {
          return (
            <span className="text-status-amber-emphasis text-xs font-medium">{fmtDate(po.expectedDate)}</span>
          );
        }
        return <span className="text-muted-foreground text-xs">{fmtDate(po.expectedDate)}</span>;
      },
    },
    {
      id: 'lines',
      accessorFn: (po) => po.lines.length,
      header: ({ column }) => <ClientSortHeader column={column} title="Lines" />,
      size: 80,
      meta: { label: 'Lines', fixed: true },
      cell: ({ row }) => <span className="text-muted-foreground">{row.original.lines.length}</span>,
    },
    {
      id: 'total',
      // There is no `total` field; it is the summed line cost the cell prints.
      accessorFn: (po) => poTotal(po),
      header: ({ column }) => <ClientSortHeader column={column} align="right" title="Total" />,
      size: 120,
      meta: { label: 'Total', fixed: true },
      cell: ({ row }) => (
        <span className="block text-right tabular-nums">{formatCurrency(poTotal(row.original))}</span>
      ),
    },
    {
      id: 'received',
      // By the fraction the progress bar draws, so a half-received PO sorts
      // between an untouched one and a complete one whatever their sizes.
      accessorFn: (po) => {
        const ordered = po.lines.reduce((sum, line) => sum + line.qtyOrdered, 0);
        return ordered === 0 ? 0 : po.lines.reduce((sum, line) => sum + line.qtyReceived, 0) / ordered;
      },
      header: ({ column }) => <ClientSortHeader column={column} title="Received" />,
      size: 150,
      meta: { label: 'Received' },
      cell: ({ row }) => {
        const totalOrd = row.original.lines.reduce((s, l) => s + l.qtyOrdered, 0);
        const totalRec = row.original.lines.reduce((s, l) => s + l.qtyReceived, 0);
        const pct = totalOrd === 0 ? 0 : Math.round((totalRec / totalOrd) * 100);
        return (
          <div className="flex items-center gap-2">
            <Progress className="w-16" value={pct} />
            <span className="text-muted-foreground text-[11px] tabular-nums">
              {totalRec}/{totalOrd}
            </span>
          </div>
        );
      },
    },
    {
      id: 'actions',
      header: 'Actions',
      size: 140,
      enableHiding: false,
      enableSorting: false,
      meta: { label: 'Actions', fixed: true },
      cell: ({ row }) => {
        const po = row.original;
        return (
          <div className="inline-flex items-center gap-1" onClick={(e) => e.stopPropagation()} role="presentation">
            <Button variant="ghost" size="icon-sm" title="Preview PO" aria-label="Preview PO" onClick={() => onPreview(po)}>
              <Eye />
            </Button>
            <Button variant="ghost" size="icon-sm" title="Email PO" aria-label="Email PO" onClick={() => onEmail(po)}>
              <Mail />
            </Button>
            {/* Single-receive-path: a staged PO receives via the Staging view only. */}
            {po.stagedAsJobStageId != null ? (
              <Button
                variant="ghost"
                size="icon-sm"
                disabled
                aria-label="Receive items"
                title="Receive via Staging - this PO is staged to a job"
              >
                <PackageCheck />
              </Button>
            ) : (
              <Button
                variant="ghost"
                size="icon-sm"
                title="Receive items"
                aria-label="Receive items"
                onClick={() => onReceive(po)}
              >
                <PackageCheck />
              </Button>
            )}
          </div>
        );
      },
    },
  ];

  return selectable ? [poSelectColumn(), ...columns] : columns;
}

/** The PO-number-labelled checkbox the Open and History grids share. */
function poSelectColumn() {
  return buildSelectColumn<PurchaseOrder>({
    allLabel: 'Select all purchase orders on this page',
    rowLabel: (po) => `Select ${po.poNumber}`,
  });
}

export function buildHistoryPOColumns({
  onPreview, selectable = false,
}: {
  onPreview: (po: PurchaseOrder) => void;
  selectable?: boolean;
}): ColumnDef<PurchaseOrder, unknown>[] {
  const columns: ColumnDef<PurchaseOrder, unknown>[] = [
    {
      id: 'status',
      accessorKey: 'status',
      header: ({ column }) => <ClientSortHeader column={column} title="Status" />,
      size: 110,
      meta: { label: 'Status', fixed: true },
      cell: ({ row }) => <StatusChip domain="purchaseOrder" status={row.original.status} />,
    },
    {
      id: 'po',
      accessorKey: 'poNumber',
      header: ({ column }) => <ClientSortHeader column={column} title="PO #" />,
      size: 110,
      meta: { label: 'PO #', fixed: true },
      cell: ({ row }) => (
        <Button
          variant="link"
          size="sm"
          className="h-auto p-0 font-mono text-xs"
          title="Preview PO document"
          onClick={(e) => { e.stopPropagation(); onPreview(row.original); }}
        >
          {row.original.poNumber}
        </Button>
      ),
    },
    {
      id: 'vendor',
      accessorKey: 'vendor',
      header: ({ column }) => <ClientSortHeader column={column} title="Vendor" />,
      size: 180,
      meta: { label: 'Vendor' },
      cell: ({ row }) => <VendorCell vendor={row.original.vendor} />,
    },
    {
      id: 'job',
      // The cell leads with the job number and falls back to an em-dash note,
      // so an unlinked PO sorts to one end rather than interleaving on a null.
      accessorFn: (po) => po.jobNumber ?? '',
      header: ({ column }) => <ClientSortHeader column={column} title="Job / Customer" />,
      size: 180,
      meta: { label: 'Job / Customer' },
      cell: ({ row }) => <JobCell po={row.original} />,
    },
    {
      id: 'ordered',
      accessorFn: (po) => new Date(po.orderedAt).getTime(),
      header: ({ column }) => <ClientSortHeader column={column} title="Ordered" />,
      size: 100,
      meta: { label: 'Ordered', fixed: true },
      cell: ({ row }) => (
        <span className="text-muted-foreground text-xs">{fmtDate(row.original.orderedAt)}</span>
      ),
    },
    {
      id: 'received-on',
      accessorFn: (po) => new Date(po.expectedDate ?? po.orderedAt).getTime(),
      header: ({ column }) => <ClientSortHeader column={column} title="Received on" />,
      size: 120,
      meta: { label: 'Received on', fixed: true },
      // Stands in receivedAt = expectedDate for the scaffold; the real field
      // lands when the model gains `receivedAt`.
      cell: ({ row }) => (
        <span className="text-muted-foreground text-xs">
          {fmtDate(row.original.expectedDate ?? row.original.orderedAt)}
        </span>
      ),
    },
    {
      id: 'lead',
      accessorFn: (po) => daysBetween(po.orderedAt, new Date(po.expectedDate ?? po.orderedAt)),
      header: ({ column }) => <ClientSortHeader column={column} title="Lead time" />,
      size: 100,
      meta: { label: 'Lead time', fixed: true },
      cell: ({ row }) => {
        const receivedAt = row.original.expectedDate ?? row.original.orderedAt;
        return (
          <span className="text-muted-foreground text-xs">
            {daysBetween(row.original.orderedAt, new Date(receivedAt))}d
          </span>
        );
      },
    },
    {
      id: 'total',
      // There is no `total` field; it is the summed line cost the cell prints.
      accessorFn: (po) => poTotal(po),
      header: ({ column }) => <ClientSortHeader column={column} align="right" title="Total" />,
      size: 120,
      meta: { label: 'Total', fixed: true },
      cell: ({ row }) => (
        <span className="block text-right tabular-nums">{formatCurrency(poTotal(row.original))}</span>
      ),
    },
    {
      id: 'variance',
      header: 'Variance',
      size: 110,
      // Prints a literal "-" until three-way match ships; nothing to order by.
      enableSorting: false,
      meta: { label: 'Variance', fixed: true },
      // Stubbed in the legacy table too - three-way match is not built yet.
      cell: () => (
        <span className="text-muted-foreground block text-right text-xs" title="Three-way match ships in 7.4">
          {'-'}
        </span>
      ),
    },
  ];

  return selectable ? [poSelectColumn(), ...columns] : columns;
}
