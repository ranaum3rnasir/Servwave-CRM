/**
 * Job-scoped communication aggregation (Communication ↔ Jobs, Slice 1).
 *
 * CommItem is the FROZEN shared contract between the backend aggregation
 * endpoint (GET /api/jobs/:id/communications) and every frontend consumer —
 * field names must not change. Items arrive sorted ASCENDING by `at`
 * (oldest first).
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import api from '@/lib/axios';
import type { CommChannel } from '@/components/communication/shared/atoms';

export interface CommItem {
  id: string;
  channel: CommChannel;
  direction: 'in' | 'out';
  /** Counterparty display name (customer name; phone/email fallback). */
  who: string;
  /** call: "Inbound call · 4m 07s" / sms: "Text message" / whatsapp: "WhatsApp message" / email: subject or "(no subject)". */
  title: string;
  /** Body/snippet/summary, truncated ~160 chars. */
  preview: string;
  /** ISO timestamp. */
  at: string;
  /** Omitted (not null) when the item has no job attribution. */
  jobId?: string;
  jobLabel?: string;
  /** Lead linkage (call/email/sms lead_id, per-record; whatsapp chat.lead). Omitted when unlinked. */
  leadId?: string;
  /** Joined lead's lead_number (L00001-style). */
  leadLabel?: string;
  /** Calls only: answered_by csr name → agent user name → 'Forwarded phone' (external). */
  answeredBy?: string;
  /** Email rows sent by the system account (estimate/invoice/etc.). */
  transactional?: boolean;
  /** Reserved for the business-state chip (sage); NOT populated in v1. */
  state?: string;
  /** Call disposition etc. */
  meta?: string;
  /** Email delivery lifecycle (slice 5) - email channel only, and only once the
   *  Resend webhook has reported on this row. Exact camelCase mirror of
   *  Email.deliveryStatus (lib/api/communication-shared/email.ts) - see that
   *  type's doc comment for the full contract, including why "opened" can
   *  never appear here. Deliberately NOT rendered through StateChip: that
   *  component is hardcoded sage for "genuine business state (Approved /
   *  Paid)" (atoms.tsx's own color contract comment) and a bounce/failure
   *  must never read as that positive a color - it goes through StatusBadge's
   *  `messageDelivery` domain instead, which is tone-aware per status. */
  deliveryStatus?: string;
  deliveryStatusReason?: string;
  bounceKind?: string;
}

/** GET /api/jobs/:id/communications — the job's unified timeline across channels. */
export function useJobCommunications(jobId?: string) {
  return useQuery({
    queryKey: ['job-communications', jobId],
    enabled: !!jobId,
    queryFn: () =>
      api.get(`/api/jobs/${jobId}/communications`).then((r) => r.data.items as CommItem[]),
    // Live refresh: a call/text placed from this job lands as a webhook row a few
    // seconds after hangup — poll + refetch on focus so it appears without a
    // manual reload (house pattern, notifications.ts).
    refetchInterval: 15_000,
    refetchOnWindowFocus: true,
  });
}

/**
 * GET /api/leads/:id/communications — the lead's timeline: STRICTLY rows
 * attributed to this lead by lead_id, mirroring useJobCommunications' job_id
 * scoping exactly (full job-parity ruling, 2026-07-22 — no customer-history
 * union). A row with lead_id null won't surface here even if it belongs to
 * the same customer, same as an un-job-tagged row on a job's timeline.
 */
export function useLeadCommunications(leadId?: string) {
  return useQuery({
    queryKey: ['lead-communications', leadId],
    enabled: !!leadId,
    queryFn: () =>
      api.get(`/api/leads/${leadId}/communications`).then((r) => r.data.items as CommItem[]),
    // Live refresh — see useJobCommunications.
    refetchInterval: 15_000,
    refetchOnWindowFocus: true,
  });
}

/**
 * POST /api/communication/sms — send a text stamped with this LEAD at origin.
 * Mirrors useSendJobSms; the backend accepts an explicit `leadId` (slice E4 lead
 * attribution), org-validates it, and stamps both the thread and the resulting
 * message row with lead_id so it surfaces on the lead's strictly lead_id-scoped
 * timeline. customerId still routes the thread.
 */
export function useSendLeadSms(leadId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ customerId, body }: { customerId: string; body: string }) =>
      api.post('/api/communication/sms', { customerId, body, leadId }).then((r) => r.data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['lead-communications', leadId] });
      // Prefix match — refresh the per-customer roll-up too (the row is
      // customer-linked as well as lead-linked).
      qc.invalidateQueries({ queryKey: ['customer-communications'] });
      qc.invalidateQueries({ queryKey: ['communication'] });
    },
  });
}

/**
 * POST /api/communication/sms — send a text stamped with this job at origin
 * (attach-by-origin: composed from a job page → tagged at send).
 */
export function useSendJobSms(jobId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ customerId, body }: { customerId: string; body: string }) =>
      api.post('/api/communication/sms', { customerId, body, jobId }).then((r) => r.data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['job-communications', jobId] });
      // Prefix matches — refresh every per-customer roll-up
      // (['customer-communications', customerId]) and per-lead union
      // (['lead-communications', leadId]; customer-linked rows show there too).
      qc.invalidateQueries({ queryKey: ['customer-communications'] });
      qc.invalidateQueries({ queryKey: ['lead-communications'] });
      qc.invalidateQueries({ queryKey: ['communication'] });
    },
  });
}

/**
 * POST /api/communication/emails — send an email stamped with this job at
 * origin (attach-by-origin). The backend takes `body` as an array of lines
 * and snake_case `job_id`; it resolves + stamps job_label itself.
 */
export function useSendJobEmail(jobId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ to, subject, body }: { to: string; subject: string; body: string }) =>
      api
        .post('/api/communication/emails', { to, subject, body: [body], job_id: jobId })
        .then((r) => r.data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['job-communications', jobId] });
      qc.invalidateQueries({ queryKey: ['customer-communications'] });
      qc.invalidateQueries({ queryKey: ['lead-communications'] });
      qc.invalidateQueries({ queryKey: ['communication'] });
    },
  });
}

/**
 * Email slice 5 — correlating an Estimate/Invoice's OWN transactional send
 * against a comm timeline this module already exposes.
 *
 * WHY THIS EXISTS: Email carries customer_id/lead_id/job_id, but no
 * estimate_id or invoice_id column (verified against schema.prisma - adding
 * one is a real migration, out of scope for this slice). What Estimate/
 * Invoice detail pages CAN read today is the same job/lead/customer comm
 * timeline the Job/Customer/Lead Communication tabs already render (their own
 * transactional send stamps job_id and/or lead_id/customer_id at origin — see
 * backend lib/email.ts's sendEstimateEmail/sendEstimateWithDepositEmail/
 * sendInvoiceEmail call sites). The subject line is fully deterministic
 * (`Estimate ${estimateNumber} ...` / `Invoice ${invoiceNumber} ...`) and the
 * number is unique per org, so a prefix match against that same list is a
 * precise, zero-migration correlation — not a fuzzy heuristic.
 *
 * `items` is read in the ASCENDING (oldest-first) order these endpoints
 * return (see this file's top doc comment); this returns the LAST match,
 * i.e. the most recent send/resend, so a stale bounce from send #1 never
 * shadows a clean send #2.
 *
 * BOUNDARY, not a bare startsWith: estimate revisions on the same lead are
 * numbered with a `-N` suffix (e.g. E00042 alongside E00042-2), and a bare
 * `title.startsWith(subjectPrefix)` would let "Estimate E00042-2 from
 * ServWave" false-match a lookup for "Estimate E00042" - the shorter number
 * IS a string-prefix of the longer one. The character immediately after the
 * prefix must therefore be a space or end-of-string (every real subject
 * format puts a space before "from"/"—"/"Deposit ..." right after the
 * number, or - for a bare `Invoice ${invoiceNumber}` with no org name - ends
 * there outright), never a digit or hyphen.
 */
export function findTransactionalEmail(
  items: CommItem[] | undefined,
  subjectPrefix: string,
): CommItem | undefined {
  if (!items) return undefined;
  let match: CommItem | undefined;
  for (const item of items) {
    if (item.channel !== 'email' || item.direction !== 'out') continue;
    if (!item.title.startsWith(subjectPrefix)) continue;
    const boundary = item.title[subjectPrefix.length];
    if (boundary !== undefined && boundary !== ' ') continue;
    match = item;
  }
  return match;
}
