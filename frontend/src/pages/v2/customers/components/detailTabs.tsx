import { useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Briefcase, ClipboardList, CreditCard, Receipt, Send, StickyNote } from 'lucide-react';

import api from '@/lib/axios';
import { formatCurrency } from '@/lib/utils';
import { EmptyState } from '@/ui-kit/components/data/emptyState';
import { Badge } from '@/ui-kit/components/ui/badge';
import { Button } from '@/ui-kit/components/ui/button';
import { Skeleton } from '@/ui-kit/components/ui/skeleton';
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '@/ui-kit/components/ui/table';
import { Textarea } from '@/ui-kit/components/ui/textarea';

import { StatusChip } from '../../_shared/statusChip';
import { preferV2Path } from '../../uiV2';

// --- Shapes the detail response feeds these tabs -----------------------------

export interface DetailLocation {
  id: string;
  address_line1: string;
  address_line2?: string | null;
  city: string;
  state: string;
  zip: string;
  is_primary: boolean;
}

/** Exactly what GET /api/leads nests per lead - `{ id, total_amount }` and nothing else. */
interface LeadEstimateSummary {
  id: string;
  total_amount: string | number;
}

/**
 * One row of GET /api/estimates. The Estimates tab reads that endpoint directly
 * rather than digging estimates out of the leads response, because /api/leads
 * is Pro-gated while Estimates is Starter core, and the leads nesting carries no
 * estimate number, status or created date.
 */
export interface CustomerEstimate {
  id: string;
  estimate_number: string;
  status: string;
  total_amount: string | number;
  created_at: string;
  /** Null for a customer-anchored estimate - R6 relaxed Estimate.lead_id to optional. */
  lead: { id: string; service_request: string } | null;
}

export interface LeadSummary {
  id: string;
  lead_number?: string;
  status: string;
  service_request: string;
  created_at: string;
  lead_assignees?: { user: { id: string; first_name: string; last_name: string } }[];
  estimates?: LeadEstimateSummary[];
  /**
   * Slice 10 (combined Schedule tab): the legacy-shaped "current visit" field every
   * `GET /api/leads` response already carries (projectLeadWalkthroughFields on the backend,
   * services/walkthrough.service.ts) - null/undefined means no live walkthrough is booked.
   * Optional because every OTHER reader of `LeadSummary` (the Leads tab) never touches it.
   */
  walkthrough_scheduled_at?: string | null;
}

export interface JobSummary {
  id: string;
  job_number: string;
  status: string;
  scope_notes: string | null;
  scheduled_start: string | null;
  completed_at: string | null;
  created_at: string;
  assignees?: { user: { id: string; first_name: string; last_name: string } }[];
  service_location?: { address_line1: string; city: string; state: string } | null;
  estimate?: { estimate_number: string; total_amount: string | number } | null;
  invoices?: Array<{
    id: string;
    invoice_number: string;
    status: string;
    total_amount: string | number;
    amount_due: string | number;
    due_date: string | null;
    created_at: string;
    payments?: Array<{
      id: string;
      amount: string | number;
      method: string;
      paid_at: string;
      notes: string | null;
      collector: { id: string; first_name: string; last_name: string } | null;
    }>;
  }>;
}

export interface NoteSummary {
  id: string;
  content: string;
  created_at: string;
  creator: { id: string; first_name: string; last_name: string };
}

export interface CustomerInvoice {
  id: string;
  invoice_number: string;
  status: string;
  kind: string;
  total_amount: number | string;
  amount_due: number | string;
  due_date: string | null;
  created_at: string;
  job_number: string | null;
  job_id: string | null;
  payments: Array<{
    id: string;
    amount: number | string;
    method: string;
    paid_at: string;
    notes: string | null;
    collector: { id: string; first_name: string | null; last_name: string | null } | null;
  }>;
}

export interface FinancialSummary {
  financials: {
    lifetime_revenue: number;
    total_invoiced: number;
    past_due_balance: number;
    due_balance: number;
    paid_invoice_count: number;
    unpaid_invoice_count: number;
  };
  estimates: { total: number; pending: number; approved: number; total_value: number };
  deposits: { collected: number; pending: number };
  leads?: { open: number; active: number };
  tasks?: { open: number };
}

// S4 (D17): EN_ROUTE/ON_SITE retired from JobStatus - such a job now reads SCHEDULED or
// IN_PROGRESS, so it is still counted as active here.
export const ACTIVE_JOB_STATUSES = new Set([
  'UNSCHEDULED', 'SCHEDULED', 'IN_PROGRESS',
]);

export function formatDate(date: string) {
  return new Date(date).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

/** The legacy tables truncate a service request at 50 characters. */
function truncate(value: string): string {
  return value.length > 50 ? `${value.slice(0, 50)}...` : value;
}

/**
 * Cell-content treatments.
 *
 * Deliberately wrappers INSIDE the cell rather than a `className` on
 * `<TableCell>`: `design-system/__tests__/component-api-guard.test.ts` ratchets
 * appearance classes handed to a shared primitive from a call site, and the kit
 * TableCell exposes only a `padding` prop. Naming the three treatments once
 * here also means "secondary column text" is one decision, not thirty.
 */
function Muted({ children }: { children: ReactNode }) {
  return <span className="text-muted-foreground">{children}</span>;
}
function Mono({ children }: { children: ReactNode }) {
  return <span className="font-mono text-xs font-medium">{children}</span>;
}
function MutedMono({ children }: { children: ReactNode }) {
  return <span className="text-muted-foreground font-mono text-xs">{children}</span>;
}
function Money({ children }: { children: ReactNode }) {
  return <span className="font-medium tabular-nums">{children}</span>;
}
function MutedMoney({ children }: { children: ReactNode }) {
  return <span className="text-muted-foreground tabular-nums">{children}</span>;
}

const UNASSIGNED = <span className="text-muted-foreground italic">Unassigned</span>;
const DASH = <span className="text-muted-foreground">-</span>;

/** The footer note both 20-row tabs carry. */
function ShowingUpTo({ noun }: { noun: string }) {
  return (
    <p className="text-muted-foreground px-4 py-3 text-right text-xs">
      Showing up to 20 most recent {noun}
    </p>
  );
}

// --- Leads -------------------------------------------------------------------

export function LeadsTab({ leads, onNavigate }: { leads: LeadSummary[]; onNavigate: (id: string) => void }) {
  if (leads.length === 0) return <EmptyState title="No leads yet." />;

  return (
    <div>
      <Table>
        <TableHeader>
          <TableRow className="hover:bg-transparent">
            <TableHead>Status</TableHead>
            <TableHead>Service Request</TableHead>
            <TableHead>Estimates</TableHead>
            <TableHead>Est. Value</TableHead>
            <TableHead>Assigned To</TableHead>
            <TableHead>Date</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {leads.map((lead) => {
            const estCount = lead.estimates?.length ?? 0;
            const estValue = (lead.estimates ?? []).reduce((sum, e) => sum + parseFloat(String(e.total_amount)), 0);
            return (
              <TableRow key={lead.id} className="cursor-pointer" onClick={() => onNavigate(lead.id)}>
                <TableCell><StatusChip domain="lead" status={lead.status} /></TableCell>
                <TableCell><span className="block truncate">{truncate(lead.service_request)}</span></TableCell>
                <TableCell>
                  {estCount > 0 ? <Badge variant="softBlue" size="pill">{estCount}</Badge> : DASH}
                </TableCell>
                <TableCell>
                  <Muted>{estValue > 0 ? formatCurrency(estValue) : '-'}</Muted>
                </TableCell>
                <TableCell>
                  <Muted>
                    {lead.lead_assignees && lead.lead_assignees.length > 0
                      ? lead.lead_assignees.map((a) => `${a.user.first_name} ${a.user.last_name}`).join(', ')
                      : UNASSIGNED}
                  </Muted>
                </TableCell>
                <TableCell><Muted>{formatDate(lead.created_at)}</Muted></TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
      <ShowingUpTo noun="leads" />
    </div>
  );
}

// --- Estimates ---------------------------------------------------------------

export function EstimatesTab({
  estimates, isLoading, onNavigate,
}: {
  estimates: CustomerEstimate[];
  isLoading: boolean;
  onNavigate: (id: string) => void;
}) {
  if (isLoading) {
    return (
      <div className="flex flex-col gap-2 p-4">
        {[0, 1, 2].map((i) => <Skeleton key={i} className="h-10 w-full" />)}
      </div>
    );
  }
  if (estimates.length === 0) return <EmptyState icon={<ClipboardList />} title="No estimates yet." />;

  return (
    <Table>
      <TableHeader>
        <TableRow className="hover:bg-transparent">
          <TableHead>Estimate #</TableHead>
          <TableHead>Service Request</TableHead>
          <TableHead>Status</TableHead>
          <TableHead>Total</TableHead>
          <TableHead>Created</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {/* Rendered in API order, which is newest-first (the estimate list's
            parseSortParams defaults to created_at desc) - no client re-sort. */}
        {estimates.map((est) => (
          <TableRow key={est.id} className="cursor-pointer" onClick={() => onNavigate(est.id)}>
            <TableCell><Mono>{est.estimate_number}</Mono></TableCell>
            <TableCell>
              {/* Lead-less (customer-anchored) estimates have no originating request. */}
              <Muted>
                {est.lead ? <span className="block truncate">{truncate(est.lead.service_request)}</span> : '-'}
              </Muted>
            </TableCell>
            <TableCell>{est.status ? <StatusChip domain="estimate" status={est.status} /> : '-'}</TableCell>
            <TableCell><Money>{formatCurrency(est.total_amount)}</Money></TableCell>
            <TableCell><Muted>{formatDate(est.created_at)}</Muted></TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

// --- Jobs --------------------------------------------------------------------

export function JobsTab({ jobs, onNavigate }: { jobs: JobSummary[]; onNavigate: (id: string) => void }) {
  if (jobs.length === 0) return <EmptyState icon={<Briefcase />} title="No jobs yet." />;

  return (
    <div>
      <Table>
        <TableHeader>
          <TableRow className="hover:bg-transparent">
            <TableHead>Job #</TableHead>
            <TableHead>Status</TableHead>
            <TableHead>Location</TableHead>
            <TableHead>Technician</TableHead>
            <TableHead>Scheduled</TableHead>
            <TableHead>Invoice</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {jobs.map((job) => {
            const active = (job.invoices ?? []).filter((i) => i.status !== 'VOIDED');
            const latest = active[active.length - 1];
            return (
              <TableRow key={job.id} className="cursor-pointer" onClick={() => onNavigate(job.id)}>
                <TableCell><Mono>{job.job_number}</Mono></TableCell>
                <TableCell><StatusChip domain="job" status={job.status} /></TableCell>
                <TableCell>
                  <Muted>
                    {job.service_location
                      ? <span className="block max-w-[150px] truncate">
                          {`${job.service_location.address_line1}, ${job.service_location.city}`}
                        </span>
                      : '-'}
                  </Muted>
                </TableCell>
                <TableCell>
                  <Muted>
                    {job.assignees && job.assignees.length > 0
                      ? job.assignees.map((a) => `${a.user.first_name} ${a.user.last_name}`).join(', ')
                      : UNASSIGNED}
                  </Muted>
                </TableCell>
                <TableCell>
                  <Muted>{job.scheduled_start ? formatDate(job.scheduled_start) : '-'}</Muted>
                </TableCell>
                <TableCell>
                  {!latest ? DASH : (
                    <span className="flex items-center gap-1.5">
                      {/* domain="job" is carried over verbatim from the legacy
                          cell even though the value is an INVOICE status - see
                          the ledger's "observed but not fixed" row. Both the
                          legacy badge and this chip fall back to the raw value
                          with a neutral intent, so the text is unchanged. */}
                      <StatusChip domain="job" status={latest.status} />
                      {active.length > 1 && (
                        <span className="text-muted-foreground text-xs">+{active.length - 1}</span>
                      )}
                    </span>
                  )}
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
      <ShowingUpTo noun="jobs" />
    </div>
  );
}

// --- Invoices ----------------------------------------------------------------

export function InvoicesTab({ invoices }: { invoices: CustomerInvoice[] }) {
  if (invoices.length === 0) return <EmptyState icon={<Receipt />} title="No invoices yet." />;

  return (
    <Table>
      <TableHeader>
        <TableRow className="hover:bg-transparent">
          <TableHead>Invoice #</TableHead>
          <TableHead>Job #</TableHead>
          <TableHead>Status</TableHead>
          <TableHead>Total</TableHead>
          <TableHead>Amount Due</TableHead>
          <TableHead>Due Date</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {invoices.map((inv) => {
          const isOverdue =
            inv.due_date &&
            (inv.status === 'SENT' || inv.status === 'PARTIAL') &&
            new Date(inv.due_date) < new Date();
          const due = parseFloat(String(inv.amount_due));
          return (
            // Rows are NOT clickable here - the invoice number is the link, as
            // it is on the legacy tab.
            <TableRow key={inv.id}>
              <TableCell>
                <Button asChild variant="link" size="sm" className="h-auto px-0">
                  <Link to={preferV2Path(`/invoices/${inv.id}`)}>
                    <Mono>{inv.invoice_number}</Mono>
                  </Link>
                </Button>
              </TableCell>
              <TableCell><MutedMono>{inv.job_number ?? '-'}</MutedMono></TableCell>
              <TableCell><StatusChip domain="invoice" status={inv.status} /></TableCell>
              <TableCell><MutedMoney>{formatCurrency(inv.total_amount)}</MutedMoney></TableCell>
              <TableCell>
                {/* "Paid" vs an outstanding balance is a STATE, so it is a badge
                    rather than a coloured string on the call site. */}
                {due > 0
                  ? <Badge variant="softRed" size="pill">{formatCurrency(inv.amount_due)}</Badge>
                  : <Badge variant="softGreen" size="pill">Paid</Badge>}
              </TableCell>
              <TableCell>
                {!inv.due_date ? DASH : isOverdue
                  ? <Badge variant="softRed" size="pill">{formatDate(inv.due_date)}</Badge>
                  : <Muted>{formatDate(inv.due_date)}</Muted>}
              </TableCell>
            </TableRow>
          );
        })}
      </TableBody>
    </Table>
  );
}

// --- Payments ----------------------------------------------------------------

export function PaymentsTab({ invoices }: { invoices: CustomerInvoice[] }) {
  const payments = invoices
    .flatMap((inv) => (inv.payments ?? []).map((p) => ({ ...p, invoice_number: inv.invoice_number })))
    .sort((a, b) => new Date(b.paid_at).getTime() - new Date(a.paid_at).getTime());

  if (payments.length === 0) return <EmptyState icon={<CreditCard />} title="No payments yet." />;

  return (
    <Table>
      <TableHeader>
        <TableRow className="hover:bg-transparent">
          <TableHead>Invoice #</TableHead>
          <TableHead>Date</TableHead>
          <TableHead>Amount</TableHead>
          <TableHead>Method</TableHead>
          <TableHead>Collected By</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {payments.map((p) => (
          <TableRow key={p.id}>
            <TableCell><Mono>{p.invoice_number}</Mono></TableCell>
            <TableCell><Muted>{formatDate(p.paid_at)}</Muted></TableCell>
            <TableCell><Money>{formatCurrency(p.amount)}</Money></TableCell>
            <TableCell>
              <Badge variant="outline" size="sm">
                <span className="capitalize">{p.method.toLowerCase()}</span>
              </Badge>
            </TableCell>
            <TableCell>
              {/* `collector` is nullable - a regression test asserts the dash. */}
              <Muted>{p.collector ? `${p.collector.first_name} ${p.collector.last_name}` : '-'}</Muted>
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

// --- Notes -------------------------------------------------------------------

export function NotesTab({ notes, customerId }: { notes: NoteSummary[]; customerId: string }) {
  const [content, setContent] = useState('');
  const queryClient = useQueryClient();

  const addNoteMutation = useMutation({
    mutationFn: (body: { content: string }) => api.post(`/api/customers/${customerId}/notes`, body),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['customer', customerId] });
      setContent('');
    },
  });

  return (
    <div className="flex flex-col gap-4 p-5">
      <div className="flex flex-col gap-2">
        <Textarea
          className="resize-none"
          rows={3}
          placeholder="Add a note about this customer..."
          value={content}
          onChange={(e) => setContent(e.target.value)}
        />
        <div className="flex justify-end">
          <Button
            size="sm"
            disabled={!content.trim() || addNoteMutation.isPending}
            onClick={() => addNoteMutation.mutate({ content: content.trim() })}
          >
            <Send />
            {addNoteMutation.isPending ? 'Adding...' : 'Add Note'}
          </Button>
        </div>
      </div>

      {addNoteMutation.error && (
        <p className="text-destructive text-sm">Failed to add note. Please try again.</p>
      )}

      {notes.length === 0 ? (
        <EmptyState icon={<StickyNote />} title="No notes yet." />
      ) : (
        <div className="flex flex-col gap-3">
          {notes.map((note) => (
            <div key={note.id} className="rounded-lg border p-4">
              <p className="whitespace-pre-wrap text-sm">{note.content}</p>
              <p className="text-muted-foreground mt-2 text-xs">
                {note.creator.first_name} {note.creator.last_name} · {formatDate(note.created_at)}
              </p>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
