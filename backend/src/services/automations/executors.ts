/**
 * executors.ts — dispatch one automation action to its channel.
 *
 * The engine hands over a fully-loaded ExecutionBundle (entity refs, customer,
 * assignees, merge context); this module renders the copy and routes it:
 *   SEND_EMAIL  → lib/email sendAutomationEmail (Resend, branded, esc()-safe)
 *   SEND_SMS    → smsRecord (Communication-module thread; provider-pending)
 *   NOTIFY_TEAM → notifications emit('automation.message') pipeline
 *
 * Every outcome is an ExecutionResult with a plain-English detail — SKIPPED
 * reasons are product copy, not log lines (they render in the Activity tab).
 * Throwing is allowed; the engine maps a throw to a FAILED run.
 */

import { AutomationActionType } from '@prisma/client';
import { sendAutomationEmail, esc, type EmailDispatchResult } from '../../lib/email';
import { emit } from '../notifications/notificationService';
import { renderMergeFields } from './renderMergeFields';
import { recordOutboundSms } from './smsRecord';
import type { CtmSmsFailureReason } from '../../lib/ctm/sendSms';
import { resolveAudience, type AudienceContext, type RecipientKey, type ResolvedAudience } from './recipients';

export interface RecipientUser {
  id: string;
  email: string | null;
  first_name: string;
  last_name: string | null;
}

export interface ExecutionBundle {
  entityRef: { type: 'job' | 'estimate' | 'invoice' | 'lead'; id: string; label?: string | null };
  organizationId: string;
  org: { name: string; timezone: string; logo_url?: string | null; brand_color?: string };
  customer?: {
    id: string;
    first_name: string | null;
    last_name: string | null;
    email: string | null;
    phone: string | null;
    /**
     * Secondary addresses opted in to automated mail, pre-filtered by context.ts's
     * CUSTOMER_INCLUDE (`receives_emails: true`). The `customer` audience mails these
     * alongside the primary — see recipients.ts.
     */
    extra_emails?: { email: string }[];
  } | null;
  /** Job crew (empty for non-job entities); for leads, the walkthrough performers. */
  assignees: RecipientUser[];
  /** Job dispatcher (job only — jobs.dispatcher_id). */
  dispatcher?: RecipientUser | null;
  /** Prefers the entity's own salesperson (job.salesperson_id); falls back to the
   *  linked lead's commission owner (job → estimate → lead, or estimate → lead directly).
   *  Invoices don't resolve one (dropped per Ran — no direct lead path). */
  salesperson?: RecipientUser | null;
  /** Estimate creator (estimate.created_by; estimate only). */
  creator?: RecipientUser | null;
  /** The person the triggering event removed — from event_payload, not the live entity (context.ts). */
  eventRecipient?: RecipientUser | null;
  /** Fully-resolved merge-field values for this entity. */
  mergeCtx: Record<string, string>;
  /** Job reference for SMS/email inbox attribution, when the entity has one. */
  jobRef?: { id: string; label: string | null } | null;
  /** The run's dedupe key — mirrored into the notification dedup key. */
  dedupeKey: string;
}

export interface ExecutionResult {
  status: 'SENT' | 'SKIPPED' | 'FAILED';
  recipientSummary?: string;
  detail?: string;
}

/** A messaging action's config, normalized to the v2.1 multi-select shape. */
interface NormalizedConfig {
  recipients: RecipientKey[];
  subject?: string;
  body: string;
  custom_emails: string[];
  user_ids: string[];
}

interface RuleLike {
  id: string;
  name: string;
  action_type: AutomationActionType;
  action_config: unknown;
  organization_id: string;
}

/**
 * Read the stored config into the canonical multi-select shape. Back-compat is
 * mandatory: legacy singular configs (`recipient`/`custom_email`/`user_id`) are
 * folded to their array forms, and the legacy `assigned_techs` key is folded to
 * `assigned_team` (the resolver honors the alias too, but folding here keeps the
 * whole executor on canonical keys).
 */
function normalizeActionConfig(raw: unknown): NormalizedConfig {
  const c = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const recipientsRaw = Array.isArray(c.recipients)
    ? c.recipients
    : c.recipient != null
      ? [c.recipient]
      : [];
  const recipients = recipientsRaw
    .filter((r): r is string => typeof r === 'string')
    .map((r) => (r === 'assigned_techs' ? 'assigned_team' : r)) as RecipientKey[];

  const customEmailsRaw = Array.isArray(c.custom_emails)
    ? c.custom_emails
    : c.custom_email != null
      ? [c.custom_email]
      : [];
  const userIdsRaw = Array.isArray(c.user_ids) ? c.user_ids : c.user_id != null ? [c.user_id] : [];

  return {
    recipients,
    subject: typeof c.subject === 'string' ? c.subject : undefined,
    body: typeof c.body === 'string' ? c.body : '',
    custom_emails: customEmailsRaw.filter((e): e is string => typeof e === 'string' && e.trim().length > 0),
    user_ids: userIdsRaw.filter((u): u is string => typeof u === 'string' && u.trim().length > 0),
  };
}

export async function executeAction(rule: RuleLike, bundle: ExecutionBundle): Promise<ExecutionResult> {
  const config = normalizeActionConfig(rule.action_config);
  switch (rule.action_type) {
    case 'SEND_EMAIL':
      return sendEmailAction(config, bundle);
    case 'SEND_SMS':
      return sendSmsAction(config, bundle);
    case 'NOTIFY_TEAM':
      return notifyTeamAction(rule, config, bundle);
    default:
      return { status: 'SKIPPED', detail: `Unknown action type ${rule.action_type}` };
  }
}

// ── recipient resolution (Task 17 audience resolver) ───────────────────────────

/** Build the resolver context once from the execution bundle. */
function audienceContext(config: NormalizedConfig, bundle: ExecutionBundle): AudienceContext {
  return {
    organizationId: bundle.organizationId,
    entity: bundle.entityRef.type,
    customer: bundle.customer
      ? {
          id: bundle.customer.id,
          email: bundle.customer.email,
          // Carry the opted-in extras through; this rebuild is field-by-field, so
          // omitting them here would silently reduce the audience to the primary.
          extra_emails: bundle.customer.extra_emails ?? [],
        }
      : null,
    assignees: bundle.assignees,
    dispatcher: bundle.dispatcher ?? null,
    salesperson: bundle.salesperson ?? null,
    creator: bundle.creator ?? null,
    eventRecipient: bundle.eventRecipient ?? null,
    customEmails: config.custom_emails,
  };
}

/**
 * Resolve EVERY selected audience to its concrete users/emails. `specific_user`
 * expands to one resolver call per chosen id (so a multi-select of two people
 * resolves both); every other key resolves once. Never throws — an unresolvable
 * audience returns a plain-English `skipReason` (product copy) instead.
 */
async function resolveAll(config: NormalizedConfig, ctx: AudienceContext): Promise<ResolvedAudience[]> {
  const out: ResolvedAudience[] = [];
  for (const key of config.recipients) {
    if (key === 'specific_user') {
      if (config.user_ids.length === 0) {
        out.push(await resolveAudience('specific_user', ctx));
      } else {
        for (const userId of config.user_ids) {
          out.push(await resolveAudience('specific_user', { ...ctx, userId }));
        }
      }
    } else {
      out.push(await resolveAudience(key, ctx));
    }
  }
  return out;
}

/** Distinct, order-preserving skip reasons across the resolved audiences. */
function skipReasons(resolved: ResolvedAudience[]): string[] {
  return [...new Set(resolved.map((r) => r.skipReason).filter((s): s is string => Boolean(s)))];
}

function fullName(u: RecipientUser): string {
  return [u.first_name, u.last_name].filter(Boolean).join(' ');
}

/**
 * Plain body → branded-shell HTML fragment. The body is authored as plain text
 * (a <textarea>) and merge values are customer-controlled, so escape the WHOLE
 * rendered string — not just the substituted values — then re-introduce only
 * our own <br> line breaks. Mirrors lib/email.ts customMessageBlock.
 */
function toHtmlFragment(body: string, ctx: Record<string, string>): string {
  const rendered = renderMergeFields(body, ctx, { html: false });
  return `<p style="margin:0 0 16px;">${esc(rendered).replace(/\n/g, '<br>')}</p>`;
}

// ── SEND_EMAIL ────────────────────────────────────────────────────────────────

async function sendEmailAction(config: NormalizedConfig, bundle: ExecutionBundle): Promise<ExecutionResult> {
  const ctx = audienceContext(config, bundle);
  const resolved = await resolveAll(config, ctx);
  const customerEmail = bundle.customer?.email?.toLowerCase();

  // Union of every resolved address: the explicit `emails` (customer/custom) plus
  // each resolved user's own email. Dedupe case-insensitively, first-seen casing.
  // A named user carries their own first name for {{recipient.first_name}}; the
  // customer's own address falls back to bundle.customer; a bare custom address
  // has no name to give and renders the token empty rather than leaking
  // "undefined" into a real email.
  const byAddress = new Map<string, { address: string; firstName: string }>();
  for (const r of resolved) {
    for (const email of r.emails) {
      const k = email.toLowerCase();
      if (byAddress.has(k)) continue;
      const firstName = k === customerEmail ? (bundle.customer?.first_name ?? '') : '';
      byAddress.set(k, { address: email, firstName });
    }
    for (const u of r.users) {
      if (!u.email) continue;
      const k = u.email.toLowerCase();
      if (!byAddress.has(k)) byAddress.set(k, { address: u.email, firstName: u.first_name });
    }
  }

  const recipients = [...byAddress.values()];
  const reasons = skipReasons(resolved);
  if (recipients.length === 0) {
    // Never email nobody: SKIPPED, with the plain-English reasons joined.
    return { status: 'SKIPPED', detail: reasons.join(' · ') || 'No one to email' };
  }

  const dispatched: { address: string; result: EmailDispatchResult }[] = [];
  for (const { address: to, firstName } of recipients) {
    const recipientCtx = { ...bundle.mergeCtx, 'recipient.first_name': firstName };
    const result = await sendAutomationEmail({
      organizationId: bundle.organizationId,
      to,
      subject: renderMergeFields(config.subject ?? '', recipientCtx, { html: false }),
      text: renderMergeFields(config.body, recipientCtx, { html: false }),
      html: toHtmlFragment(config.body, recipientCtx),
      org: {
        id: bundle.organizationId,
        name: bundle.org.name,
        logo_url: bundle.org.logo_url ?? null,
        brand_color: bundle.org.brand_color ?? '#0C2D3A',
      },
      record: {
        organizationId: bundle.organizationId,
        // Attribute the send to the customer only for the customer's own address.
        customerId: customerEmail && to.toLowerCase() === customerEmail ? bundle.customer?.id ?? null : null,
        jobId: bundle.jobRef?.id ?? null,
        jobLabel: bundle.jobRef?.label ?? null,
      },
    });
    dispatched.push({ address: to, result });
  }

  // dispatchEmail's org-level checks (org_disabled / no_api_key) read the same
  // org row on every call in this loop, so they are always all-or-nothing across
  // recipients; only a provider rejection can vary per address. See
  // md_files/plans/automations/2026-07-30-task-112-step-run-send-honesty.md.
  const dispatchProblem = ({ address, result }: (typeof dispatched)[number]): string | null => {
    switch (result.status) {
      case 'sent':
        return null;
      case 'skipped':
        return result.reason === 'org_disabled'
          ? 'Email sending is turned off for this organization'
          : 'Email sending is not available right now';
      case 'failed':
        return `delivery to ${address} failed: ${result.error}`;
    }
  };
  const dispatchReasons = [...new Set(dispatched.map(dispatchProblem).filter((p): p is string => p !== null))];
  const allReasons = [...reasons, ...dispatchReasons];

  const sent = dispatched.filter((d) => d.result.status === 'sent');
  if (sent.length > 0) {
    // The Activity-tab summary line isn't addressed to anyone - render without a
    // per-recipient name rather than picking one recipient's arbitrarily.
    const summarySubject = renderMergeFields(config.subject ?? '', { ...bundle.mergeCtx, 'recipient.first_name': '' }, { html: false });
    return {
      status: 'SENT',
      recipientSummary: recipients.map((r) => r.address).join(', '),
      detail: allReasons.length
        ? `Sent to ${sent.length} · skipped: ${allReasons.join('; ')}`
        : summarySubject,
    };
  }

  const allSkipped = dispatched.every((d) => d.result.status === 'skipped');
  return {
    status: allSkipped ? 'SKIPPED' : 'FAILED',
    detail: allReasons.join(' · '),
  };
}

// ── SEND_SMS ──────────────────────────────────────────────────────────────────
// `recipients` is always ['customer']; resolve the customer and record the
// outbound SMS. The step status honestly reflects whether the text actually
// left the building (SERV10X-70, same defect class as #1068 for email).

// Gate-failure reasons a delivery attempt can come back with, mapped to plain-
// English Activity-tab copy. CTM_ERROR is handled separately as FAILED.
const SMS_SKIP_COPY: Record<Exclude<CtmSmsFailureReason, 'CTM_ERROR'>, string> = {
  NOT_CONNECTED: 'Text messaging is not connected for this organization',
  SMS_NOT_READY: 'Text messaging is not active yet — A2P registration is pending approval',
  ORG_SMS_DISABLED: 'Text messaging is turned off for this organization',
  NOT_ENTITLED: 'Text messaging is not available on this plan',
  NO_SMS_NUMBER: 'No SMS-capable phone number is available for this conversation',
  NOT_IN_TEST_ALLOWLIST: 'This number is not reachable in the current environment',
  RECIPIENT_OPTED_OUT: 'This recipient has opted out of text messages',
  DUPLICATE_SEND: 'An identical text was just sent to this conversation',
};

async function sendSmsAction(config: NormalizedConfig, bundle: ExecutionBundle): Promise<ExecutionResult> {
  if (!bundle.customer) {
    return { status: 'SKIPPED', detail: 'This record has no customer to text' };
  }
  if (!bundle.customer.phone) {
    return { status: 'SKIPPED', detail: 'Customer has no phone number on file' };
  }

  const body = renderMergeFields(config.body, bundle.mergeCtx, { html: false });
  const { delivery } = await recordOutboundSms({
    organizationId: bundle.organizationId,
    customerId: bundle.customer.id,
    body,
    job: bundle.jobRef ?? null,
  });

  if (delivery.delivered) {
    const preview = body.length > 120 ? `${body.slice(0, 117)}…` : body;
    return { status: 'SENT', recipientSummary: bundle.customer.phone, detail: preview };
  }
  if (delivery.reason === 'CTM_ERROR') {
    return { status: 'FAILED', recipientSummary: bundle.customer.phone, detail: 'Text delivery failed' };
  }
  return { status: 'SKIPPED', detail: SMS_SKIP_COPY[delivery.reason] };
}

// ── NOTIFY_TEAM ───────────────────────────────────────────────────────────────

async function notifyTeamAction(
  rule: RuleLike,
  config: NormalizedConfig,
  bundle: ExecutionBundle,
): Promise<ExecutionResult> {
  const ctx = audienceContext(config, bundle);
  const resolved = await resolveAll(config, ctx);

  // Union of every resolved user, deduped by id (an overlapping user notified once).
  const byId = new Map<string, RecipientUser>();
  for (const r of resolved) {
    for (const u of r.users) {
      if (!byId.has(u.id)) byId.set(u.id, u);
    }
  }

  const users = [...byId.values()];
  const reasons = skipReasons(resolved);
  if (users.length === 0) {
    // Never notify nobody: SKIPPED, with the plain-English reasons joined.
    return { status: 'SKIPPED', detail: reasons.join(' · ') || 'No one to notify' };
  }

  const body = renderMergeFields(config.body, bundle.mergeCtx, { html: false });
  // One notification, fanned to the deduped recipient set (the pipeline creates a
  // per-recipient row from recipient_ids — at-most-once per unique user).
  await emit({
    verb: 'automation.message',
    organizationId: bundle.organizationId,
    actorId: null,
    object: {
      type: bundle.entityRef.type.toUpperCase(),
      id: bundle.entityRef.id,
      label: bundle.entityRef.label ?? undefined,
    },
    entity: { recipient_ids: users.map((u) => u.id) },
    data: {
      title: rule.name,
      body,
      object_type: bundle.entityRef.type.toUpperCase(),
      object_label: bundle.entityRef.label ?? undefined,
    },
    dedupKey: `automation.message:${rule.id}:${bundle.dedupeKey}`,
  });

  const preview = body.length > 120 ? `${body.slice(0, 117)}…` : body;
  return {
    status: 'SENT',
    recipientSummary: users.map(fullName).join(', '),
    detail: reasons.length ? `${preview} · skipped: ${reasons.join('; ')}` : preview,
  };
}
