/**
 * templates.ts — per-verb notification template registry
 *
 * Encodes the title/body/category/priority/action_type/object_type for every
 * v1 verb listed in the in-app-notifications implementation plan (lines 53–62).
 *
 * Deferred verbs (task.*, estimate.viewed, *.delivery_failed,
 * billing.payment_failed, service_plan.*) are intentionally NOT in this
 * registry. renderTemplate() throws for any unrecognised verb so the caller
 * can log and skip.
 *
 * Note on priority: the value here is the BASE (event-level) priority.
 * resolveRecipients() may assign a different priority per recipient row
 * (e.g. the same estimate.approved interrupts the Sales owner but feeds
 * the Dispatcher).  The UI uses the per-recipient row's priority, not this
 * base value.  However, we set base priority to INTERRUPT whenever ANY role
 * receives an INTERRUPT for that verb — keeps the logic conservative and
 * consistent with the §3 matrix.
 */

import { NotificationCategory, NotificationPriority } from '@prisma/client';

// ── helpers ──────────────────────────────────────────────────────────────────

/** Safely pull a string from the data bag; returns fallback if absent/null. */
function s(data: Record<string, any>, key: string, fallback = ''): string {
  const v = data[key];
  return typeof v === 'string' && v.length > 0 ? v : fallback;
}

/** Communication verbs: customer name → caller number → object label. */
function comWho(data: Record<string, any>): string {
  return s(data, 'customer_name')
    || s(data, 'caller_number')
    || s(data, 'object_label', 'Unknown number');
}

// ── public interface ──────────────────────────────────────────────────────────

export interface RenderedTemplate {
  category: NotificationCategory;
  /** Base/event-level priority. Per-recipient priority lives on the recipient row. */
  priority: NotificationPriority;
  needs_action: boolean;
  action_type: string | null;
  title: string;
  body?: string;
  object_type: string;
}

type TemplateFactory = (data: Record<string, any>) => RenderedTemplate;

// ── registry ─────────────────────────────────────────────────────────────────

const registry: Record<string, TemplateFactory> = {

  // ── LEAD ───────────────────────────────────────────────────────────────────

  'lead.assigned': (data) => ({
    category: 'LEAD',
    object_type: 'LEAD',
    priority: 'INTERRUPT',
    action_type: null,
    needs_action: false,
    title: s(data, 'object_label', 'Lead') + ' assigned to you'
      + (s(data, 'customer_name') ? ' — ' + s(data, 'customer_name') : ''),
  }),

  'lead.unassigned_created': (data) => ({
    category: 'LEAD',
    object_type: 'LEAD',
    priority: 'FEED',
    action_type: null,
    needs_action: false,
    title: 'New unassigned lead'
      + (s(data, 'customer_name') ? ': ' + s(data, 'customer_name') : '')
      + (s(data, 'object_label') ? ' (' + s(data, 'object_label') + ')' : ''),
  }),

  'lead.reassigned_away': (data) => ({
    category: 'LEAD',
    object_type: 'LEAD',
    priority: 'FEED',
    action_type: null,
    needs_action: false,
    title: s(data, 'object_label', 'Lead') + ' reassigned away from you'
      + (s(data, 'customer_name') ? ' — ' + s(data, 'customer_name') : ''),
  }),

  'lead.walkthrough_scheduled': (data) => ({
    category: 'LEAD',
    object_type: 'LEAD',
    priority: 'INTERRUPT',
    action_type: null,
    needs_action: false,
    title: 'Walkthrough scheduled for '
      + s(data, 'object_label', 'lead')
      + (s(data, 'customer_name') ? ' — ' + s(data, 'customer_name') : ''),
  }),

  // ── ESTIMATE ───────────────────────────────────────────────────────────────

  'estimate.approved': (data) => ({
    category: 'ESTIMATE',
    object_type: 'ESTIMATE',
    priority: 'INTERRUPT',
    action_type: 'SCHEDULE_JOB',
    needs_action: true,
    title: s(data, 'object_label', 'Estimate') + ' won'
      + (s(data, 'customer_name') ? ' by ' + s(data, 'customer_name') : ''),
    body: s(data, 'amount') ? 'Amount: $' + s(data, 'amount') : undefined,
  }),

  'estimate.declined': (data) => ({
    category: 'ESTIMATE',
    object_type: 'ESTIMATE',
    priority: 'INTERRUPT',
    action_type: null,
    needs_action: false,
    title: s(data, 'object_label', 'Estimate') + ' declined'
      + (s(data, 'customer_name') ? ' by ' + s(data, 'customer_name') : ''),
  }),

  'estimate.deposit_paid': (data) => ({
    category: 'ESTIMATE',
    object_type: 'ESTIMATE',
    priority: 'INTERRUPT',
    action_type: 'SCHEDULE_JOB',
    needs_action: true,
    title: 'Deposit paid for ' + s(data, 'object_label', 'estimate')
      + (s(data, 'customer_name') ? ' — ' + s(data, 'customer_name') : ''),
    body: s(data, 'amount') ? 'Amount: $' + s(data, 'amount') : undefined,
  }),

  'estimate.cancelled': (data) => ({
    category: 'ESTIMATE',
    object_type: 'ESTIMATE',
    priority: 'FEED',
    action_type: null,
    needs_action: false,
    title: s(data, 'object_label', 'Estimate') + ' archived'
      + (s(data, 'customer_name') ? ' — ' + s(data, 'customer_name') : ''),
  }),

  'estimate.deposit_waived': (data) => ({
    category: 'ESTIMATE',
    object_type: 'ESTIMATE',
    priority: 'FEED',
    action_type: null,
    needs_action: false,
    title: 'Deposit waived for ' + s(data, 'object_label', 'estimate')
      + (s(data, 'customer_name') ? ' — ' + s(data, 'customer_name') : ''),
  }),

  // R4 (2026-07-21) — D13 guarded unwind (port-plan §3.2).
  'estimate.approval_voided': (data) => ({
    category: 'ESTIMATE',
    object_type: 'ESTIMATE',
    priority: 'FEED',
    action_type: null,
    needs_action: false,
    title: 'Approval voided for ' + s(data, 'object_label', 'estimate')
      + (s(data, 'customer_name') ? ' — ' + s(data, 'customer_name') : ''),
  }),

  // R4b (2026-07-21) — backtodraft/backtosent (port-plan §3.2/§14.2). No `estimate.marked_sent`
  // entry here: mark-sent deliberately stays silent, matching send()'s own first-send path, which
  // has never emitted a notification either — sending/marking-sent is the actor's own action, not
  // something that happens TO them.
  'estimate.status_corrected': (data) => ({
    category: 'ESTIMATE',
    object_type: 'ESTIMATE',
    priority: 'FEED',
    action_type: null,
    needs_action: false,
    title: s(data, 'object_label', 'Estimate') + ' ' + s(data, 'transition_label', 'status corrected')
      + (s(data, 'customer_name') ? ' — ' + s(data, 'customer_name') : ''),
  }),

  // ── DISPATCH ───────────────────────────────────────────────────────────────

  'dispatch.job_assigned': (data) => ({
    category: 'DISPATCH',
    object_type: 'JOB',
    priority: 'INTERRUPT',
    action_type: null,
    needs_action: false,
    title: s(data, 'object_label', 'Job') + ' assigned to you'
      + (s(data, 'customer_name') ? ' — ' + s(data, 'customer_name') : ''),
  }),

  'dispatch.job_unassigned': (data) => ({
    category: 'DISPATCH',
    object_type: 'JOB',
    priority: 'INTERRUPT',
    action_type: null,
    needs_action: false,
    title: s(data, 'object_label', 'Job') + ' unassigned from you',
  }),

  'dispatch.job_rescheduled': (data) => ({
    category: 'DISPATCH',
    object_type: 'JOB',
    priority: 'INTERRUPT',
    action_type: null,
    needs_action: false,
    title: s(data, 'object_label', 'Job') + ' rescheduled'
      + (s(data, 'customer_name') ? ' — ' + s(data, 'customer_name') : ''),
  }),

  'dispatch.job_created': (data) => ({
    category: 'DISPATCH',
    object_type: 'JOB',
    priority: 'INTERRUPT',
    action_type: null,
    needs_action: false,
    title: 'Job created'
      + (s(data, 'object_label') ? ': ' + s(data, 'object_label') : '')
      + (s(data, 'customer_name') ? ' — ' + s(data, 'customer_name') : ''),
  }),

  // ── JOB ────────────────────────────────────────────────────────────────────

  'job.started': (data) => ({
    category: 'JOB',
    object_type: 'JOB',
    priority: 'FEED',
    action_type: null,
    needs_action: false,
    title: s(data, 'object_label', 'Job') + ' started'
      + (s(data, 'customer_name') ? ' — ' + s(data, 'customer_name') : ''),
  }),

  'job.completed': (data) => ({
    category: 'JOB',
    object_type: 'JOB',
    priority: 'FEED',
    action_type: null,
    needs_action: false,
    title: s(data, 'object_label', 'Job') + ' completed'
      + (s(data, 'customer_name') ? ' — ' + s(data, 'customer_name') : ''),
  }),

  'job.cancelled': (data) => ({
    category: 'JOB',
    object_type: 'JOB',
    priority: 'INTERRUPT',
    action_type: null,
    needs_action: false,
    title: s(data, 'object_label', 'Job') + ' cancelled'
      + (s(data, 'customer_name') ? ' — ' + s(data, 'customer_name') : ''),
  }),

  'job.reopened': (data) => ({
    category: 'JOB',
    object_type: 'JOB',
    priority: 'FEED',
    action_type: null,
    needs_action: false,
    title: s(data, 'object_label', 'Job') + ' reopened'
      + (s(data, 'customer_name') ? ' — ' + s(data, 'customer_name') : ''),
  }),

  // ── BILLING ────────────────────────────────────────────────────────────────

  'billing.payment_received': (data) => ({
    category: 'BILLING',
    object_type: 'INVOICE',
    priority: 'FEED',
    action_type: null,
    needs_action: false,
    title: 'Payment received for ' + s(data, 'object_label', 'invoice')
      + (s(data, 'customer_name') ? ' — ' + s(data, 'customer_name') : ''),
    body: s(data, 'amount') ? 'Amount: $' + s(data, 'amount') : undefined,
  }),

  'billing.partial_payment': (data) => ({
    category: 'BILLING',
    object_type: 'INVOICE',
    priority: 'FEED',
    action_type: null,
    needs_action: false,
    title: 'Partial payment received for ' + s(data, 'object_label', 'invoice')
      + (s(data, 'customer_name') ? ' — ' + s(data, 'customer_name') : ''),
    body: s(data, 'amount') ? 'Amount: $' + s(data, 'amount') : undefined,
  }),

  'billing.invoice_overdue': (data) => ({
    category: 'BILLING',
    object_type: 'INVOICE',
    priority: 'FEED',
    action_type: 'SEND_REMINDER',
    needs_action: true,
    title: s(data, 'object_label', 'Invoice') + ' is overdue'
      + (s(data, 'customer_name') ? ' — ' + s(data, 'customer_name') : ''),
    body: s(data, 'amount') ? 'Balance due: $' + s(data, 'amount') : undefined,
  }),

  'billing.invoice_due_soon': (data) => ({
    category: 'BILLING',
    object_type: 'INVOICE',
    priority: 'FEED',
    action_type: 'SEND_REMINDER',
    needs_action: true,
    title: s(data, 'object_label', 'Invoice') + ' is due soon'
      + (s(data, 'customer_name') ? ' — ' + s(data, 'customer_name') : ''),
    body: s(data, 'amount') ? 'Balance due: $' + s(data, 'amount') : undefined,
  }),

  'billing.refunded': (data) => ({
    category: 'BILLING',
    object_type: 'INVOICE',
    priority: 'INTERRUPT',
    action_type: 'VIEW',
    needs_action: true,
    title: 'Refund issued for ' + s(data, 'object_label', 'invoice')
      + (s(data, 'customer_name') ? ' — ' + s(data, 'customer_name') : ''),
    body: s(data, 'amount') ? 'Amount: $' + s(data, 'amount') : undefined,
  }),

  'billing.disputed': (data) => ({
    category: 'BILLING',
    object_type: 'INVOICE',
    priority: 'INTERRUPT',
    action_type: 'VIEW',
    needs_action: true,
    title: 'Payment disputed for ' + s(data, 'object_label', 'invoice')
      + (s(data, 'customer_name') ? ' — ' + s(data, 'customer_name') : ''),
    body: s(data, 'amount') ? 'Amount: $' + s(data, 'amount') : undefined,
  }),

  'billing.chargeback': (data) => ({
    category: 'BILLING',
    object_type: 'INVOICE',
    priority: 'INTERRUPT',
    action_type: 'VIEW',
    needs_action: true,
    title: 'Chargeback received for ' + s(data, 'object_label', 'invoice')
      + (s(data, 'customer_name') ? ' — ' + s(data, 'customer_name') : ''),
    body: s(data, 'amount') ? 'Amount: $' + s(data, 'amount') : undefined,
  }),

  'billing.voided': (data) => ({
    category: 'BILLING',
    object_type: 'INVOICE',
    priority: 'FEED',
    action_type: null,
    needs_action: false,
    title: s(data, 'object_label', 'Invoice') + ' voided'
      + (s(data, 'customer_name') ? ' — ' + s(data, 'customer_name') : ''),
  }),

  'billing.credit_applied': (data) => ({
    category: 'BILLING',
    object_type: 'INVOICE',
    priority: 'FEED',
    action_type: null,
    needs_action: false,
    title: 'Credit applied to ' + s(data, 'object_label', 'invoice')
      + (s(data, 'customer_name') ? ' — ' + s(data, 'customer_name') : ''),
    body: s(data, 'amount') ? 'Amount: $' + s(data, 'amount') : undefined,
  }),

  // ── BILLING: payments-account lifecycle (Stripe Connect, Task 1.8) ─────────
  // Fired by webhook.controller.ts's handleAccountLifecycle on account.updated
  // flag transitions. object_type ORGANIZATION is non-scoped (absent from
  // filterByAccess's SCOPE_TYPE_MAP) so recipients pass through unfiltered.

  'billing.payments_activated': (data) => ({
    category: 'BILLING', object_type: 'ORGANIZATION', priority: 'FEED', action_type: null, needs_action: false,
    title: 'ServWave Payments is active — you can take card payments now.',
  }),

  'billing.payouts_activated': (data) => ({
    category: 'BILLING', object_type: 'ORGANIZATION', priority: 'FEED', action_type: null, needs_action: false,
    title: 'Payouts enabled — your bank is connected.',
  }),

  'billing.payments_action_needed': (data) => ({
    category: 'BILLING', object_type: 'ORGANIZATION', priority: 'INTERRUPT', action_type: 'VIEW', needs_action: true,
    title: 'Stripe needs one more thing to keep your payments running.',
    body: s(data, 'requirements') || undefined,
  }),

  'billing.payments_paused': (data) => ({
    category: 'BILLING', object_type: 'ORGANIZATION', priority: 'INTERRUPT', action_type: 'VIEW', needs_action: true,
    title: 'Card payments are paused — Stripe needs more information.',
    body: s(data, 'reason') || undefined,
  }),

  // ── BILLING: deferred-bank first-payment nudge (Task 1.9, §6.6/§6.8) ──────
  // One-shot FEED item fired from webhook.controller.ts's checkout.session.completed
  // CARD branch the first time a direct-charge org collects a card payment while
  // stripe_payouts_enabled is still false. data.amount arrives pre-formatted
  // (e.g. "$500.00") — interpolated straight into the §6.8 copy, not re-prefixed.
  'billing.payouts_pending_first_payment': (data) => ({
    category: 'BILLING', object_type: 'ORGANIZATION', priority: 'FEED', action_type: null, needs_action: false,
    title: `You've collected ${s(data, 'amount', 'a payment')}. Connect your bank to get paid out.`,
    body: s(data, 'amount') || undefined,
  }),

  // ── BILLING: within-ceiling platform-fee rate-change notice (Task 4.3, §3.6) ──
  // Fired by lib/platform-fee-rate-notice.ts's notifyPlatformFeeRateChange when
  // Organization.platform_fee_bps changes within the 2% ceiling (no re-acceptance
  // needed). data.new_rate/effective_date arrive pre-formatted (e.g. "0.75%" /
  // "August 20, 2026") — interpolated straight into copy, not re-derived here.
  'billing.platform_fee_rate_changed': (data) => ({
    category: 'BILLING', object_type: 'ORGANIZATION', priority: 'FEED', action_type: null, needs_action: false,
    title: `Your ServWave Payments rate is changing to ${s(data, 'new_rate', 'a new rate')}.`,
    body: s(data, 'effective_date') ? `Effective ${s(data, 'effective_date')}. No action is needed.` : undefined,
  }),

  // ── TEAM ───────────────────────────────────────────────────────────────────

  'team.ot_override_requested': (data) => ({
    category: 'TEAM',
    object_type: 'TIME_ENTRY',
    priority: 'INTERRUPT',
    action_type: 'APPROVE_OT',
    needs_action: true,
    title: 'OT override requested'
      + (s(data, 'actor_name') ? ' by ' + s(data, 'actor_name') : ''),
    body: s(data, 'object_label') ? 'Entry: ' + s(data, 'object_label') : undefined,
  }),

  'team.invite_accepted': (data) => ({
    category: 'TEAM',
    object_type: 'USER',
    priority: 'FEED',
    action_type: null,
    needs_action: false,
    title: (s(data, 'actor_name') || 'A new user') + ' accepted their invite',
  }),

  // ── INVENTORY ──────────────────────────────────────────────────────────────

  'inventory.stock_approval_requested': (data) => ({
    category: 'INVENTORY',
    object_type: 'STOCK_APPROVAL',
    priority: 'INTERRUPT',
    action_type: 'APPROVE_STOCK',
    needs_action: true,
    title: 'Stock approval requested'
      + (s(data, 'item_name') ? ': ' + s(data, 'item_name') : ''),
    body: s(data, 'object_label') ? 'Request: ' + s(data, 'object_label') : undefined,
  }),

  'inventory.low_stock': (data) => ({
    category: 'INVENTORY',
    object_type: 'INVENTORY_ITEM',
    priority: 'FEED',
    action_type: null,
    needs_action: false,
    title: 'Low stock' + (s(data, 'item_name') ? ': ' + s(data, 'item_name') : ''),
    // P5: the emit payload carries on_hand/min (numbers) — render them, never
    // fabricate. (No location NAME here: the emitter only has location_id, and
    // enriching it would mean a query inside applyStockMovement's tx.)
    body: data.on_hand != null && data.min != null
      ? `${data.on_hand} on hand (min ${data.min})`
      : undefined,
  }),

  'inventory.backorder': (data) => ({
    category: 'INVENTORY',
    object_type: 'INVENTORY_ITEM',
    priority: 'FEED',
    action_type: null,
    needs_action: false,
    title: 'Item on backorder' + (s(data, 'item_name') ? ': ' + s(data, 'item_name') : ''),
  }),

  'inventory.staging_ready': (data) => ({
    category: 'INVENTORY',
    object_type: 'JOB_STAGE',
    priority: 'FEED',
    action_type: null,
    needs_action: false,
    title: 'Parts staged and ready'
      + (s(data, 'object_label') ? ' for ' + s(data, 'object_label') : ''),
    body: s(data, 'item_name') ? s(data, 'item_name') : undefined,
  }),

  'inventory.staging_no_area': (data) => ({
    category: 'INVENTORY',
    object_type: 'JOB_STAGE',
    priority: 'FEED',
    action_type: null,
    needs_action: false,
    title: 'No staging area for parts'
      + (s(data, 'object_label') ? ' — ' + s(data, 'object_label') : ''),
    body: s(data, 'item_name') ? s(data, 'item_name') : undefined,
  }),

  'inventory.po_partial': (data) => ({
    category: 'INVENTORY',
    object_type: 'PURCHASE_ORDER',
    priority: 'FEED',
    action_type: null,
    needs_action: false,
    title: 'Partial PO received'
      + (s(data, 'object_label') ? ': ' + s(data, 'object_label') : ''),
    body: s(data, 'item_name') ? 'Item: ' + s(data, 'item_name') : undefined,
  }),

  // ── LOGISTIC ORDERS (LO-2) ───────────────────────────────────────────────────
  // object_type 'LOGISTIC_ORDER' is a plain String — no enum migration (verb /
  // object_type / action_type are all String on Notification; the INVENTORY
  // category already exists). It is deliberately ABSENT from filterByAccess.ts
  // SCOPE_TYPE_MAP, so LO recipients (approvers + creator — all org-wide LO
  // readers) pass the row-scope filter unfiltered; revisit that if a row-scoped
  // reader (e.g. a technician) ever becomes an LO recipient.

  'lo.submitted': (data) => ({
    category: 'INVENTORY',
    object_type: 'LOGISTIC_ORDER',
    priority: 'INTERRUPT',
    // VIEW reuses the already-registered inline handler (billing.refunded /
    // communication.call_missed precedent) so the pinned needs-action row can
    // be cleared by navigating to the LO — no new frontend wiring required.
    action_type: 'VIEW',
    needs_action: true,
    title: 'Logistic order submitted for approval'
      + (s(data, 'object_label') ? ': ' + s(data, 'object_label') : ''),
    body: s(data, 'actor_name') ? 'Submitted by ' + s(data, 'actor_name') : undefined,
  }),

  'lo.approved': (data) => ({
    category: 'INVENTORY',
    object_type: 'LOGISTIC_ORDER',
    priority: 'INTERRUPT',
    action_type: null,
    needs_action: false,
    title: s(data, 'object_label', 'Logistic order') + ' approved'
      + (s(data, 'actor_name') ? ' by ' + s(data, 'actor_name') : ''),
  }),

  // ── SECURITY ───────────────────────────────────────────────────────────────

  'security.new_signin': (data) => ({
    category: 'SECURITY',
    object_type: 'USER',
    priority: 'FEED',
    action_type: null,
    needs_action: false,
    title: 'New sign-in to your account'
      + (s(data, 'actor_name') ? ' (' + s(data, 'actor_name') + ')' : ''),
  }),

  'security.password_changed': (_data) => ({
    category: 'SECURITY',
    object_type: 'USER',
    priority: 'FEED',
    action_type: null,
    needs_action: false,
    title: 'Your password was changed',
  }),

  'security.mfa_enabled': (_data) => ({
    category: 'SECURITY',
    object_type: 'USER',
    priority: 'FEED',
    action_type: null,
    needs_action: false,
    title: 'Two-factor authentication enabled',
  }),

  'security.mfa_disabled': (_data) => ({
    category: 'SECURITY',
    object_type: 'USER',
    priority: 'FEED',
    action_type: null,
    needs_action: false,
    title: 'Two-factor authentication disabled',
  }),

  // ── COMMUNICATION (CTM phone + SMS) ─────────────────────────────────────────
  // Emitted by lib/ctm/ingest.ts on webhook activities. actorId is always null
  // (webhook-driven). "who" = matched customer/lead label, falling back to the
  // raw caller number (calls) or the object label (sms threads keyed by number).
  // No call_incoming template: inbound rings the cell, not the app (#870).

  'communication.call_missed': (data) => ({
    category: 'COMMUNICATION',
    object_type: 'CALL',
    priority: 'INTERRUPT',
    // VIEW gives the bell a working inline button (billing.refunded precedent)
    // so the pinned needs-action row can be cleared by navigating to the call.
    action_type: 'VIEW',
    needs_action: true,
    title: (s(data, 'call_status') === 'voicemail' ? 'Voicemail — ' : 'Missed call — ') + comWho(data),
  }),

  'communication.sms_inbound': (data) => ({
    category: 'COMMUNICATION',
    object_type: 'MESSAGE_THREAD',
    priority: 'FEED',
    action_type: null,
    needs_action: false,
    title: 'New text — ' + comWho(data),
    body: s(data, 'preview') || undefined,
  }),

  // A customer reply landing in the shared inbox. FEED at the EVENT level on
  // purpose: resolveRecipients raises it to INTERRUPT for the one person who
  // owns the thread, and an unowned reply should not interrupt the whole room.
  // `comWho` falls back customer name → object_label (the sender address),
  // which is all an inbound reply with no Customer row behind it leaves us.
  'communication.email_inbound': (data) => ({
    category: 'COMMUNICATION',
    object_type: 'EMAIL_THREAD',
    priority: 'FEED',
    action_type: null,
    needs_action: false,
    title: 'New email — ' + comWho(data),
    body: s(data, 'subject') || undefined,
  }),

  // ── AUTOMATION CENTER ───────────────────────────────────────────────────────
  // Generic verb for NOTIFY_TEAM automation actions. Title/body arrive fully
  // rendered from the automation engine; object_type mirrors the trigger's
  // entity so filterRecipientsByAccess row-scopes on the right resource.
  'automation.message': (data) => ({
    category: 'TEAM',
    object_type: s(data, 'object_type', 'JOB'),
    priority: 'INTERRUPT',
    action_type: null,
    needs_action: false,
    title: s(data, 'title', 'Automation'),
    body: s(data, 'body') || undefined,
  }),
};

// ── public API ────────────────────────────────────────────────────────────────

/**
 * Render a notification template for the given verb + data bag.
 * Throws if the verb is unknown or deferred — the caller should log and skip.
 */
export function renderTemplate(verb: string, data: Record<string, any>): RenderedTemplate {
  const factory = registry[verb];
  if (!factory) {
    throw new Error(`Unknown or deferred notification verb: "${verb}"`);
  }
  return factory(data);
}

/** Returns true if verb is registered (v1 verbs only). */
export function isKnownVerb(verb: string): boolean {
  return verb in registry;
}
