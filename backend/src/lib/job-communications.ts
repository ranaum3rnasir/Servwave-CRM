/**
 * Communication ↔ Jobs aggregator (spec: md_files/specs/communication/2026-06-10-communication-jobs-spec.md §4).
 * Unions the four comm channels (CallSession / Message / Email / WhatsAppMessage) into the
 * shared CommItem contract: job-scoped (per-record job_id attribution), lead-scoped
 * (per-record lead_id attribution — full job-parity ruling, 2026-07-22), or
 * customer-scoped (the canonical thread linkage). Every query is org-scoped.
 *
 * The db client is injected (the narrow surface below) so unit tests can stub it.
 */

// The narrow Prisma surface the aggregator needs (lets unit tests inject a stub).
interface CommDb {
  callSession: { findMany(args: any): Promise<any[]> };
  message: { findMany(args: any): Promise<any[]> };
  email: { findMany(args: any): Promise<any[]> };
  whatsAppMessage: { findMany(args: any): Promise<any[]> };
}

/**
 * The caller's anchor-inherited row filter (lib/permissions/anchorVisibility.ts),
 * spread into every channel query below. {} for an org-wide requester.
 *
 * Why the timelines need it even though they already gate on the ENTITY: a row
 * can carry this lead's lead_id AND a job the requester cannot see. `job > lead`
 * precedence means the job decides, so the entity gate alone (canAccessRow on
 * the Lead) would surface it. The job timeline is the degenerate case - every
 * row on it carries that job_id, so the filter agrees with the gate - but it
 * rides all three so there is one rule, not three.
 */
export type CommVisibility = Record<string, unknown>;

export type CommChannel = 'call' | 'email' | 'sms' | 'whatsapp';

export interface CommItem {
  id: string;
  channel: CommChannel;
  direction: 'in' | 'out';
  who: string;            // counterparty display name (customer name; phone/email fallback)
  title: string;          // call: "Inbound call · 4m 07s" / sms: "Text message" / whatsapp: "WhatsApp message" / email: subject or "(no subject)"
  preview: string;        // body/snippet/summary, truncated ~160 chars
  at: string;             // ISO timestamp
  jobId?: string;
  jobLabel?: string;      // omitted when null
  leadId?: string;        // lead linkage: call/email/sms lead_id (per-record); whatsapp chat.lead
  leadLabel?: string;     // joined lead's lead_number; omitted when unlinked
  answeredBy?: string;    // calls only: answered_by csr name → agent user name → 'Forwarded phone' (external)
  transactional?: boolean; // email rows with account === 'system'
  state?: string;          // reserved for business-state chip; NOT populated in v1
  meta?: string;           // call disposition etc.
  // Email delivery lifecycle (slice 5) - email channel only, omitted on every
  // other channel and on any email row nothing has reported on yet (Resend
  // webhook never fired, or the row predates it). NEVER a value meaning
  // "opened" - Apple Mail Privacy Protection prefetches images for roughly
  // half of recipients, making open-tracking meaningless as a signal, so the
  // backing enum (EmailDeliveryStatus) has no such value to forward.
  deliveryStatus?: string;
  deliveryStatusReason?: string;
  bounceKind?: string;
}

const PREVIEW_MAX = 160;

const CUSTOMER_SELECT = { select: { id: true, first_name: true, last_name: true, company_name: true } };
// Lean joins for the additive chip fields (slice E3/E6).
const LEAD_SELECT = { select: { lead_number: true } };
const AGENT_SELECT = { select: { first_name: true, last_name: true } };

// Per-channel includes, shared by all three aggregators. The job join is
// calls-only (job_number fallback for pre-job_label rows — message/email/
// whatsapp rows are stamped at write time); the lead join (lead chip) and the
// call's agent join (answeredBy fallback) ride every query, kept lean above.
const CALL_INCLUDE = {
  customer: CUSTOMER_SELECT,
  job: { select: { job_number: true } },
  lead: LEAD_SELECT,
  agent: AGENT_SELECT,
};
const MESSAGE_INCLUDE = {
  thread: { select: { title: true, customer: CUSTOMER_SELECT } },
  lead: LEAD_SELECT,
};
const EMAIL_INCLUDE = { customer: CUSTOMER_SELECT, lead: LEAD_SELECT };
const WHATSAPP_INCLUDE = {
  chat: { select: { name: true, phone: true, lead_id: true, lead: LEAD_SELECT, customer: CUSTOMER_SELECT } },
};

// ─── Mapping helpers ────────────────────────────────────────────────────────

function truncate(text: string): string {
  if (text.length <= PREVIEW_MAX) return text;
  return `${text.slice(0, PREVIEW_MAX - 1)}…`;
}

function toIso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

// first_name/last_name/company_name convention (matches mapCallSession in comm-calls.controller).
function customerName(customer: any): string | null {
  if (customer == null) return null;
  const name = customer.company_name ?? [customer.first_name, customer.last_name].filter(Boolean).join(' ');
  return name || null;
}

function formatDuration(sec: number): string {
  const minutes = Math.floor(sec / 60);
  const seconds = String(sec % 60).padStart(2, '0');
  return `${minutes}m ${seconds}s`;
}

// Who answered a call, as one display string. Mirrors the answered_by JSON
// written by lib/ctm/ingest.ts (kinds: csr / external / voicemail / none): a
// csr with a name wins; a name-less csr row falls back to the joined agent
// user; an external answer (forwarded phone — the payload never carries the
// E.164) is labelled as such; a voicemail disposition (Task C4) is labelled
// "Voicemail" so this aggregated timeline reads the same as the Calls tab;
// everything else stays absent.
function answeredByName(row: any): string | undefined {
  const ab = row.answered_by && typeof row.answered_by === 'object' ? row.answered_by : null;
  if (ab?.kind === 'csr' && typeof ab.name === 'string' && ab.name) return ab.name;
  const agentName = [row.agent?.first_name, row.agent?.last_name].filter(Boolean).join(' ');
  if (agentName) return agentName;
  if (ab?.kind === 'external') return 'Forwarded phone';
  if (ab?.kind === 'voicemail') return 'Voicemail';
  return undefined;
}

// Shared lead-chip spread: leadId from the row/relation FK, leadLabel from the
// joined lead's lead_number (omit-if-null, same idiom as jobId/jobLabel).
function leadFields(leadId: unknown, lead: any): Partial<CommItem> {
  return {
    ...(leadId != null && { leadId: leadId as string }),
    ...(lead?.lead_number != null && { leadLabel: lead.lead_number }),
  };
}

// ─── Per-channel row → CommItem mappers (omit-if-null, mapCallSession style) ─

function mapCall(row: any): CommItem {
  const direction = row.direction === 'out' ? 'out' : 'in';
  const fallback = direction === 'in' ? row.from_number : row.to_number;
  // CallSession rows created before job_label stamping have job_id but NULL
  // job_label — fall back to the joined job's job_number so the badge survives.
  const jobLabel = row.job_label ?? row.job?.job_number;
  const answeredBy = answeredByName(row);
  return {
    id: row.id,
    channel: 'call',
    direction,
    who: customerName(row.customer) ?? fallback ?? '',
    title: `${direction === 'in' ? 'Inbound' : 'Outbound'} call${row.duration_sec != null ? ` · ${formatDuration(row.duration_sec)}` : ''}`,
    preview: truncate(row.summary ?? ''),
    at: toIso(row.started_at),
    ...(row.job_id != null && { jobId: row.job_id }),
    ...(jobLabel != null && { jobLabel }),
    ...leadFields(row.lead_id, row.lead),
    ...(answeredBy != null && { answeredBy }),
    ...(row.disposition != null && { meta: row.disposition }),
  };
}

function mapMessage(row: any): CommItem {
  return {
    id: row.id,
    channel: 'sms',
    direction: row.direction === 'out' ? 'out' : 'in',
    who: customerName(row.thread?.customer) ?? row.thread?.title ?? '',
    title: 'Text message',
    preview: truncate(row.body ?? ''),
    at: toIso(row.ts),
    ...(row.job_id != null && { jobId: row.job_id }),
    ...(row.job_label != null && { jobLabel: row.job_label }),
    ...leadFields(row.lead_id, row.lead),
  };
}

function mapEmail(row: any): CommItem {
  const direction = row.folder === 'sent' ? 'out' : 'in';
  const fromJson = row.from && typeof row.from === 'object' ? row.from : null;
  const fallback = direction === 'out'
    ? (typeof row.to === 'string' ? row.to : '')
    : (fromJson?.name ?? fromJson?.email ?? '');
  return {
    id: row.id,
    channel: 'email',
    direction,
    who: customerName(row.customer) ?? fallback ?? '',
    title: row.subject || '(no subject)',
    preview: truncate(row.snippet ?? ''),
    // `at` derives from created_at (a DateTime that is always right). NEVER use
    // row.ts here: it is a BigInt epoch-ms column (JS bigint on read — Date()/
    // JSON.stringify throw) and legacy mock rows hold small ints (1970 dates
    // that sort to the timeline's start).
    at: toIso(row.created_at),
    ...(row.job_id != null && { jobId: row.job_id }),
    ...(row.job_label != null && { jobLabel: row.job_label }),
    ...leadFields(row.lead_id, row.lead),
    ...(row.account === 'system' && { transactional: true }),
    ...(row.delivery_status != null && { deliveryStatus: row.delivery_status }),
    ...(row.delivery_status_reason != null && { deliveryStatusReason: row.delivery_status_reason }),
    ...(row.bounce_kind != null && { bounceKind: row.bounce_kind }),
  };
}

function mapWhatsApp(row: any): CommItem {
  return {
    id: row.id,
    channel: 'whatsapp',
    direction: row.from === 'us' ? 'out' : 'in',
    who: customerName(row.chat?.customer) ?? row.chat?.name ?? row.chat?.phone ?? '',
    title: 'WhatsApp message',
    preview: truncate(row.text ?? ''),
    at: toIso(row.created_at),
    ...(row.job_id != null && { jobId: row.job_id }),
    ...(row.job_label != null && { jobLabel: row.job_label }),
    ...leadFields(row.chat?.lead_id, row.chat?.lead),
  };
}

// ─── Union + sort ───────────────────────────────────────────────────────────

function unionAscending(calls: any[], messages: any[], emails: any[], whatsapps: any[]): CommItem[] {
  return [
    ...calls.map(mapCall),
    ...messages.map(mapMessage),
    ...emails.map(mapEmail),
    ...whatsapps.map(mapWhatsApp),
  ].sort((a, b) => new Date(a.at).getTime() - new Date(b.at).getTime());
}

// ─── Public API ─────────────────────────────────────────────────────────────

export async function getJobCommunications(
  db: CommDb,
  args: { jobId: string; organizationId: string; visibility?: CommVisibility }
): Promise<CommItem[]> {
  const { jobId, organizationId, visibility = {} } = args;
  const [calls, messages, emails, whatsapps] = await Promise.all([
    db.callSession.findMany({
      where: { job_id: jobId, organization_id: organizationId, ...visibility },
      include: CALL_INCLUDE,
    }),
    db.message.findMany({
      where: { job_id: jobId, organization_id: organizationId, ...visibility },
      include: MESSAGE_INCLUDE,
    }),
    db.email.findMany({
      where: { job_id: jobId, organization_id: organizationId, ...visibility },
      include: EMAIL_INCLUDE,
    }),
    db.whatsAppMessage.findMany({
      where: { job_id: jobId, organization_id: organizationId, ...visibility },
      include: WHATSAPP_INCLUDE,
    }),
  ]);

  return unionAscending(calls, messages, emails, whatsapps);
}

export async function getCustomerCommunications(
  db: CommDb,
  args: { customerId: string; organizationId: string; visibility?: CommVisibility }
): Promise<CommItem[]> {
  const { customerId, organizationId, visibility = {} } = args;
  const [calls, messages, emails, whatsapps] = await Promise.all([
    db.callSession.findMany({
      where: { customer_id: customerId, organization_id: organizationId, ...visibility },
      include: CALL_INCLUDE,
    }),
    db.message.findMany({
      where: { organization_id: organizationId, thread: { customer_id: customerId }, ...visibility },
      include: MESSAGE_INCLUDE,
    }),
    db.email.findMany({
      where: { customer_id: customerId, organization_id: organizationId, ...visibility },
      include: EMAIL_INCLUDE,
    }),
    db.whatsAppMessage.findMany({
      where: { organization_id: organizationId, chat: { customer_id: customerId }, ...visibility },
      include: WHATSAPP_INCLUDE,
    }),
  ]);

  return unionAscending(calls, messages, emails, whatsapps);
}

// Lead-scoped roll-up (full job-parity ruling, 2026-07-22 — "leads should
// behave exactly like jobs"): strictly the rows attributed to THIS lead by
// lead_id, mirroring getJobCommunications' job_id scoping exactly. No
// customer-history union — a row phone-matched to the lead's customer but
// never explicitly attributed to this lead (lead_id NULL) does not appear,
// same as an un-job-tagged row never appearing on a job's timeline. Every
// channel carries a lead link: CallSession.lead_id / Message.lead_id /
// Email.lead_id directly, WhatsAppMessage via WhatsAppChat.lead_id (chat
// stays lead-scoped, same shape as its job_id counterpart).
export async function getLeadCommunications(
  db: CommDb,
  args: { leadId: string; organizationId: string; visibility?: CommVisibility }
): Promise<CommItem[]> {
  const { leadId, organizationId, visibility = {} } = args;
  const [calls, messages, emails, whatsapps] = await Promise.all([
    db.callSession.findMany({
      where: { lead_id: leadId, organization_id: organizationId, ...visibility },
      include: CALL_INCLUDE,
    }),
    db.message.findMany({
      where: { lead_id: leadId, organization_id: organizationId, ...visibility },
      include: MESSAGE_INCLUDE,
    }),
    db.email.findMany({
      where: { lead_id: leadId, organization_id: organizationId, ...visibility },
      include: EMAIL_INCLUDE,
    }),
    // NOTE: still keyed on the CHAT's lead link, not WhatsAppMessage.lead_id.
    // Slice 8a added that column for scoping and backfilled it from here, so the
    // two agree; repointing this query is a separate, behaviour-changing call.
    db.whatsAppMessage.findMany({
      where: { organization_id: organizationId, chat: { lead_id: leadId }, ...visibility },
      include: WHATSAPP_INCLUDE,
    }),
  ]);

  return unionAscending(calls, messages, emails, whatsapps);
}
