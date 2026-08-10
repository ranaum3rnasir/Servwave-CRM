export type StageKey = 'created' | 'scheduled' | 'on_site' | 'completed' | 'invoice_sent' | 'payment_received';

export interface Stage {
  key: StageKey;
  label: string;
  at: string | null;
  reached: boolean;
  current: boolean;
}

type JobInput = {
  created_at?: string | null;
  scheduled_start?: string | null;
  on_site_at?: string | null;
  completed_at?: string | null;
  status: string;
  cancelled_at?: string | null;
};

export type FinancialsInput = {
  final_invoice?: {
    sent_at?: string | null;
    paid_at?: string | null;
    status?: string;
    amount_due?: string | number;
  } | null;
  /** Multi-draw aggregates (Spec B2). Absent for a price-blind requester — treat as unknown. */
  first_sent_at?: string | null;
  total_invoiced?: number;
  total_paid?: number;
} | null | undefined;

/**
 * Whether the job is fully paid off — the exact signal `computeLifecycle` uses to decide the
 * Payment Received stage. Exported standalone (final-review fix) so a caller that needs only
 * this ONE boolean — e.g. JobDetailPage gating whether the Payment Received node stays
 * clickable — reuses this directly instead of re-deriving the hasTotals/fallback logic itself.
 */
export function isPaidOff(financials: FinancialsInput): boolean {
  const inv = financials?.final_invoice ?? null;
  const hasTotals = financials?.total_invoiced != null && financials?.total_paid != null;
  return hasTotals
    // `> 0` is load-bearing: without it an uninvoiced job satisfies 0 >= 0 and reads as PAID.
    ? Number(financials!.total_invoiced) > 0 &&
      Number(financials!.total_paid) >= Number(financials!.total_invoiced)
    // Stripped payload: amount_due is gone too, so status is the only surviving signal.
    : inv != null && (inv.status === 'PAID' || Number(inv.amount_due) === 0);
}

export function computeLifecycle(job: JobInput, financials: FinancialsInput): Stage[] {
  const inv = financials?.final_invoice ?? null;

  // Spec B2 — the bar summarises the JOB, not its newest invoice. A job billed in progress draws
  // has several, and reading only the highest-numbered one made the bar flip to "not invoiced"
  // the moment a new draft was created. Prefer the job-wide aggregates; fall back to
  // final_invoice when they are absent, which is what a price-blind requester gets.
  const sentAt: string | null = financials?.first_sent_at ?? inv?.sent_at ?? null;

  const paidOff = isPaidOff(financials);

  const paymentAt: string | null = paidOff ? (inv?.paid_at ?? sentAt) : null;

  // Build stages in order with their raw `at` values
  const stages: Stage[] = [
    { key: 'created',           label: 'Job Created',        at: job.created_at ?? null,       reached: false, current: false },
    { key: 'scheduled',         label: 'Scheduled',          at: job.scheduled_start ?? null,  reached: false, current: false },
    { key: 'on_site',           label: 'On Site',            at: job.on_site_at ?? null,       reached: false, current: false },
    { key: 'completed',         label: 'Completed',          at: job.completed_at ?? null,     reached: false, current: false },
    { key: 'invoice_sent',      label: 'Invoice Sent',       at: sentAt,                       reached: false, current: false },
    { key: 'payment_received',  label: 'Payment Received',   at: paymentAt,                    reached: false, current: false },
  ];

  // Forward-fill reached: a stage is reached if its own `at` is non-null
  // OR any LATER stage's `at` is non-null (monotonic).
  let anyLaterNonNull = false;
  for (let i = stages.length - 1; i >= 0; i--) {
    const s = stages[i]!;
    if (s.at != null) anyLaterNonNull = true;
    s.reached = anyLaterNonNull;
  }

  // current = last reached stage, unless cancelled (frozen bar)
  const isCancelled = !!job.cancelled_at;
  if (!isCancelled) {
    for (let i = stages.length - 1; i >= 0; i--) {
      const s = stages[i]!;
      if (s.reached) { s.current = true; break; }
    }
  }

  return stages;
}
