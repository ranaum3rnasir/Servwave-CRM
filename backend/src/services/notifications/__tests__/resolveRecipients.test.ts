import { describe, it, expect } from 'vitest';
import { resolveRecipients } from '../resolveRecipients';

const roleHolders = { ADMIN: ['admin1'], DISPATCHER: ['disp1'], SALES: ['sales1', 'sales2'], TECHNICIAN: ['tech1', 'tech2'] };
const base = { organizationId: 'org1', actorId: null as string | null, roleHolders };

// ──────────────────────────────────────────────────────────────────────────────
// Brief representative tests (verbatim from task-1.1-brief.md)
// ──────────────────────────────────────────────────────────────────────────────

describe('resolveRecipients — brief representative tests', () => {
  it('estimate.approved → owner INTERRUPT+needs nothing, dispatcher FEED+needs_action(schedule), admin FEED', () => {
    const r = resolveRecipients({ ...base, verb: 'estimate.approved',
      entity: { id: 'e1', commission_owner_id: 'sales1' } });
    expect(r).toContainEqual({ userId: 'sales1', priority: 'INTERRUPT', needs_action: false });
    expect(r).toContainEqual({ userId: 'disp1', priority: 'FEED', needs_action: true });
    expect(r).toContainEqual({ userId: 'admin1', priority: 'FEED', needs_action: false });
  });

  it('dispatch.job_assigned → assignees INTERRUPT, assigner(dispatcher) FEED, never admin', () => {
    const r = resolveRecipients({ ...base, verb: 'dispatch.job_assigned', actorId: 'disp1',
      entity: { id: 'j1', assignee_ids: ['tech1', 'tech2'] } });
    expect(r).toContainEqual({ userId: 'tech1', priority: 'INTERRUPT', needs_action: false });
    expect(r).toContainEqual({ userId: 'tech2', priority: 'INTERRUPT', needs_action: false });
    expect(r.find(x => x.userId === 'admin1')).toBeUndefined();
  });

  it('inventory.staging_ready → admin + dispatcher FEED + assigned tech INTERRUPT', () => {
    const r = resolveRecipients({ ...base, verb: 'inventory.staging_ready',
      entity: { id: 'stg1', assignee_ids: ['tech1'] } });
    expect(r).toContainEqual({ userId: 'tech1', priority: 'INTERRUPT', needs_action: false });
    expect(r.map(x => x.userId)).toContain('admin1');
    expect(r.map(x => x.userId)).toContain('disp1');
  });

  it('inventory.staging_ready with no assignee → admin + dispatcher only (no INTERRUPT)', () => {
    const r = resolveRecipients({ ...base, verb: 'inventory.staging_ready', entity: { id: 'stg1' } });
    expect(r.map(x => x.userId).sort()).toEqual(['admin1', 'disp1']);
    expect(r.find(x => x.priority === 'INTERRUPT')).toBeUndefined();
  });

  it('drops the actor from recipients', () => {
    const r = resolveRecipients({ ...base, verb: 'job.completed', actorId: 'tech1',
      entity: { id: 'j1', assignee_ids: ['tech1'] } });
    expect(r.find(x => x.userId === 'tech1')).toBeUndefined();
  });

  it('billing.payment_received → admin + dispatcher + owning rep (their customer), all FEED', () => {
    const r = resolveRecipients({ ...base, verb: 'billing.payment_received',
      entity: { id: 'i1', customer_owner_id: 'sales2' } });
    expect(r.map(x => x.userId).sort()).toContain('sales2');
    expect(r.map(x => x.userId)).toContain('disp1');
    expect(r.map(x => x.userId)).toContain('admin1');
  });

  it('team.ot_override_requested → ADMIN only, INTERRUPT + needs_action', () => {
    const r = resolveRecipients({ ...base, verb: 'team.ot_override_requested',
      entity: { id: 't1', user_id: 'tech1' } });
    expect(r).toEqual([{ userId: 'admin1', priority: 'INTERRUPT', needs_action: true }]);
  });

  it('security.* → only the account owner', () => {
    const r = resolveRecipients({ ...base, verb: 'security.new_signin',
      entity: { user_id: 'sales1' } });
    expect(r).toEqual([{ userId: 'sales1', priority: 'FEED', needs_action: false }]);
  });

  it('lead.unassigned_created → admin + dispatcher FEED (no sales-manager role)', () => {
    const r = resolveRecipients({ ...base, verb: 'lead.unassigned_created', entity: { id: 'l1' } });
    expect(r.map(x => x.userId).sort()).toEqual(['admin1', 'disp1']);
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// Extended coverage: every remaining v1 verb
// ──────────────────────────────────────────────────────────────────────────────

describe('resolveRecipients — LEAD verbs', () => {
  it('lead.assigned → commission_owner_id gets INTERRUPT', () => {
    const r = resolveRecipients({ ...base, verb: 'lead.assigned',
      entity: { id: 'l1', commission_owner_id: 'sales1' } });
    expect(r).toContainEqual({ userId: 'sales1', priority: 'INTERRUPT', needs_action: false });
    // admin and dispatcher are NOT recipients
    expect(r.find(x => x.userId === 'admin1')).toBeUndefined();
    expect(r.find(x => x.userId === 'disp1')).toBeUndefined();
  });

  it('lead.reassigned_away → previous_owner_id gets FEED', () => {
    const r = resolveRecipients({ ...base, verb: 'lead.reassigned_away',
      entity: { id: 'l1', previous_owner_id: 'sales2' } });
    expect(r).toContainEqual({ userId: 'sales2', priority: 'FEED', needs_action: false });
    expect(r.find(x => x.userId === 'admin1')).toBeUndefined();
  });

  it('lead.walkthrough_scheduled → dispatcher FEED + owner FEED + performers INTERRUPT', () => {
    const r = resolveRecipients({ ...base, verb: 'lead.walkthrough_scheduled',
      entity: { id: 'l1', commission_owner_id: 'sales1', performer_ids: ['tech1', 'tech2'] } });
    expect(r).toContainEqual({ userId: 'disp1', priority: 'FEED', needs_action: false });
    expect(r).toContainEqual({ userId: 'sales1', priority: 'FEED', needs_action: false });
    expect(r).toContainEqual({ userId: 'tech1', priority: 'INTERRUPT', needs_action: false });
    expect(r).toContainEqual({ userId: 'tech2', priority: 'INTERRUPT', needs_action: false });
  });

  it('lead.walkthrough_scheduled — no performers → only dispatcher + owner', () => {
    const r = resolveRecipients({ ...base, verb: 'lead.walkthrough_scheduled',
      entity: { id: 'l1', commission_owner_id: 'sales1' } });
    expect(r.map(x => x.userId).sort()).toEqual(['disp1', 'sales1']);
  });
});

describe('resolveRecipients — ESTIMATE verbs', () => {
  it('estimate.declined → owner INTERRUPT + admin FEED', () => {
    const r = resolveRecipients({ ...base, verb: 'estimate.declined',
      entity: { id: 'e1', commission_owner_id: 'sales1' } });
    expect(r).toContainEqual({ userId: 'sales1', priority: 'INTERRUPT', needs_action: false });
    expect(r).toContainEqual({ userId: 'admin1', priority: 'FEED', needs_action: false });
    expect(r.find(x => x.userId === 'disp1')).toBeUndefined();
  });

  it('estimate.deposit_paid → owner INTERRUPT + dispatcher FEED+needs_action + admin FEED', () => {
    const r = resolveRecipients({ ...base, verb: 'estimate.deposit_paid',
      entity: { id: 'e1', commission_owner_id: 'sales1' } });
    expect(r).toContainEqual({ userId: 'sales1', priority: 'INTERRUPT', needs_action: false });
    expect(r).toContainEqual({ userId: 'disp1', priority: 'FEED', needs_action: true });
    expect(r).toContainEqual({ userId: 'admin1', priority: 'FEED', needs_action: false });
  });

  it('estimate.cancelled → owner FEED + admin FEED', () => {
    const r = resolveRecipients({ ...base, verb: 'estimate.cancelled',
      entity: { id: 'e1', commission_owner_id: 'sales2' } });
    expect(r).toContainEqual({ userId: 'sales2', priority: 'FEED', needs_action: false });
    expect(r).toContainEqual({ userId: 'admin1', priority: 'FEED', needs_action: false });
    expect(r.find(x => x.userId === 'disp1')).toBeUndefined();
  });

  it('estimate.deposit_waived → owner FEED + admin FEED', () => {
    const r = resolveRecipients({ ...base, verb: 'estimate.deposit_waived',
      entity: { id: 'e1', commission_owner_id: 'sales1' } });
    expect(r).toContainEqual({ userId: 'sales1', priority: 'FEED', needs_action: false });
    expect(r).toContainEqual({ userId: 'admin1', priority: 'FEED', needs_action: false });
  });
});

describe('resolveRecipients — DISPATCH verbs', () => {
  it('dispatch.job_unassigned → removed assignees INTERRUPT + dispatcher FEED', () => {
    const r = resolveRecipients({ ...base, verb: 'dispatch.job_unassigned',
      entity: { id: 'j1', assignee_ids: ['tech1'] } });
    expect(r).toContainEqual({ userId: 'tech1', priority: 'INTERRUPT', needs_action: false });
    expect(r).toContainEqual({ userId: 'disp1', priority: 'FEED', needs_action: false });
  });

  it('dispatch.job_rescheduled → assignees INTERRUPT + dispatcher FEED', () => {
    const r = resolveRecipients({ ...base, verb: 'dispatch.job_rescheduled',
      entity: { id: 'j1', assignee_ids: ['tech1', 'tech2'] } });
    expect(r).toContainEqual({ userId: 'tech1', priority: 'INTERRUPT', needs_action: false });
    expect(r).toContainEqual({ userId: 'tech2', priority: 'INTERRUPT', needs_action: false });
    expect(r).toContainEqual({ userId: 'disp1', priority: 'FEED', needs_action: false });
  });

  it('dispatch.job_created → admin FEED + dispatcher INTERRUPT + assignees INTERRUPT', () => {
    const r = resolveRecipients({ ...base, verb: 'dispatch.job_created',
      entity: { id: 'j1', assignee_ids: ['tech1'] } });
    expect(r).toContainEqual({ userId: 'admin1', priority: 'FEED', needs_action: false });
    expect(r).toContainEqual({ userId: 'disp1', priority: 'INTERRUPT', needs_action: false });
    expect(r).toContainEqual({ userId: 'tech1', priority: 'INTERRUPT', needs_action: false });
  });

  it('dispatch.job_created — no assignees yet → admin + dispatcher only', () => {
    const r = resolveRecipients({ ...base, verb: 'dispatch.job_created',
      entity: { id: 'j1' } });
    expect(r.map(x => x.userId).sort()).toEqual(['admin1', 'disp1']);
  });
});

describe('resolveRecipients — JOB verbs', () => {
  it('job.started → dispatcher FEED + sold_by sales FEED', () => {
    const r = resolveRecipients({ ...base, verb: 'job.started',
      entity: { id: 'j1', assignee_ids: ['tech1'], sold_by_id: 'sales1' } });
    expect(r).toContainEqual({ userId: 'disp1', priority: 'FEED', needs_action: false });
    expect(r).toContainEqual({ userId: 'sales1', priority: 'FEED', needs_action: false });
    // assignee who acts is dropped if actor, but they get FEED if not actor
    expect(r).toContainEqual({ userId: 'tech1', priority: 'FEED', needs_action: false });
  });

  it('job.started — actor (tech) dropped from result', () => {
    const r = resolveRecipients({ ...base, verb: 'job.started', actorId: 'tech1',
      entity: { id: 'j1', assignee_ids: ['tech1'], sold_by_id: 'sales1' } });
    expect(r.find(x => x.userId === 'tech1')).toBeUndefined();
  });

  it('job.completed → dispatcher + sold_by + assignees FEED', () => {
    const r = resolveRecipients({ ...base, verb: 'job.completed',
      entity: { id: 'j1', assignee_ids: ['tech1', 'tech2'], sold_by_id: 'sales2' } });
    expect(r).toContainEqual({ userId: 'disp1', priority: 'FEED', needs_action: false });
    expect(r).toContainEqual({ userId: 'sales2', priority: 'FEED', needs_action: false });
    expect(r).toContainEqual({ userId: 'tech1', priority: 'FEED', needs_action: false });
    expect(r).toContainEqual({ userId: 'tech2', priority: 'FEED', needs_action: false });
  });

  it('job.cancelled → dispatcher FEED + sold_by FEED + assignees INTERRUPT', () => {
    const r = resolveRecipients({ ...base, verb: 'job.cancelled',
      entity: { id: 'j1', assignee_ids: ['tech1'], sold_by_id: 'sales1' } });
    expect(r).toContainEqual({ userId: 'disp1', priority: 'FEED', needs_action: false });
    expect(r).toContainEqual({ userId: 'sales1', priority: 'FEED', needs_action: false });
    expect(r).toContainEqual({ userId: 'tech1', priority: 'INTERRUPT', needs_action: false });
  });

  it('job.reopened → dispatcher FEED + assignees FEED', () => {
    const r = resolveRecipients({ ...base, verb: 'job.reopened',
      entity: { id: 'j1', assignee_ids: ['tech1'] } });
    expect(r).toContainEqual({ userId: 'disp1', priority: 'FEED', needs_action: false });
    expect(r).toContainEqual({ userId: 'tech1', priority: 'FEED', needs_action: false });
  });
});

describe('resolveRecipients — BILLING verbs', () => {
  it('billing.partial_payment → admin + dispatcher + customer_owner_id FEED', () => {
    const r = resolveRecipients({ ...base, verb: 'billing.partial_payment',
      entity: { id: 'i1', customer_owner_id: 'sales1' } });
    expect(r).toContainEqual({ userId: 'admin1', priority: 'FEED', needs_action: false });
    expect(r).toContainEqual({ userId: 'disp1', priority: 'FEED', needs_action: false });
    expect(r).toContainEqual({ userId: 'sales1', priority: 'FEED', needs_action: false });
  });

  it('billing.invoice_overdue → admin FEED+needs_action + customer_owner FEED+needs_action', () => {
    const r = resolveRecipients({ ...base, verb: 'billing.invoice_overdue',
      entity: { id: 'i1', customer_owner_id: 'sales1' } });
    expect(r).toContainEqual({ userId: 'admin1', priority: 'FEED', needs_action: true });
    expect(r).toContainEqual({ userId: 'sales1', priority: 'FEED', needs_action: true });
    expect(r.find(x => x.userId === 'disp1')).toBeUndefined();
  });

  it('billing.invoice_due_soon → admin FEED+needs_action + customer_owner FEED+needs_action', () => {
    const r = resolveRecipients({ ...base, verb: 'billing.invoice_due_soon',
      entity: { id: 'i1', customer_owner_id: 'sales2' } });
    expect(r).toContainEqual({ userId: 'admin1', priority: 'FEED', needs_action: true });
    expect(r).toContainEqual({ userId: 'sales2', priority: 'FEED', needs_action: true });
  });

  it('billing.refunded → admin INTERRUPT', () => {
    const r = resolveRecipients({ ...base, verb: 'billing.refunded',
      entity: { id: 'i1' } });
    expect(r).toContainEqual({ userId: 'admin1', priority: 'INTERRUPT', needs_action: false });
    expect(r.find(x => x.userId === 'disp1')).toBeUndefined();
  });

  it('billing.disputed → admin INTERRUPT', () => {
    const r = resolveRecipients({ ...base, verb: 'billing.disputed',
      entity: { id: 'i1' } });
    expect(r).toContainEqual({ userId: 'admin1', priority: 'INTERRUPT', needs_action: false });
  });

  it('billing.chargeback → admin INTERRUPT', () => {
    const r = resolveRecipients({ ...base, verb: 'billing.chargeback',
      entity: { id: 'i1' } });
    expect(r).toContainEqual({ userId: 'admin1', priority: 'INTERRUPT', needs_action: false });
  });

  it('billing.voided → admin FEED', () => {
    const r = resolveRecipients({ ...base, verb: 'billing.voided',
      entity: { id: 'i1' } });
    expect(r).toContainEqual({ userId: 'admin1', priority: 'FEED', needs_action: false });
    expect(r.find(x => x.userId === 'disp1')).toBeUndefined();
    expect(r.find(x => x.userId === 'sales1')).toBeUndefined();
  });

  it('billing.credit_applied → admin FEED', () => {
    const r = resolveRecipients({ ...base, verb: 'billing.credit_applied',
      entity: { id: 'i1' } });
    expect(r).toContainEqual({ userId: 'admin1', priority: 'FEED', needs_action: false });
  });

  // ── payments-account lifecycle (Task 1.8) — recipients = org ADMIN only ──
  it('billing.payments_activated → admin FEED, no dispatcher/sales/technician', () => {
    const r = resolveRecipients({ ...base, verb: 'billing.payments_activated', entity: {} });
    expect(r).toEqual([{ userId: 'admin1', priority: 'FEED', needs_action: false }]);
  });

  it('billing.payouts_activated → admin FEED, no dispatcher/sales/technician', () => {
    const r = resolveRecipients({ ...base, verb: 'billing.payouts_activated', entity: {} });
    expect(r).toEqual([{ userId: 'admin1', priority: 'FEED', needs_action: false }]);
  });

  it('billing.payments_action_needed → admin INTERRUPT + needs_action, no dispatcher/sales/technician', () => {
    const r = resolveRecipients({ ...base, verb: 'billing.payments_action_needed', entity: {} });
    expect(r).toEqual([{ userId: 'admin1', priority: 'INTERRUPT', needs_action: true }]);
  });

  it('billing.payments_paused → admin INTERRUPT + needs_action, no dispatcher/sales/technician', () => {
    const r = resolveRecipients({ ...base, verb: 'billing.payments_paused', entity: {} });
    expect(r).toEqual([{ userId: 'admin1', priority: 'INTERRUPT', needs_action: true }]);
  });

  // ── deferred-bank first-payment nudge (Task 1.9) — recipients = org ADMIN only ──
  it('billing.payouts_pending_first_payment → admin FEED, no dispatcher/sales/technician', () => {
    const r = resolveRecipients({ ...base, verb: 'billing.payouts_pending_first_payment', entity: {} });
    expect(r).toEqual([{ userId: 'admin1', priority: 'FEED', needs_action: false }]);
  });

  // ── within-ceiling rate-change notice (Task 4.3) — recipients = org ADMIN only ──
  it('billing.platform_fee_rate_changed → admin FEED, no dispatcher/sales/technician', () => {
    const r = resolveRecipients({ ...base, verb: 'billing.platform_fee_rate_changed', entity: {} });
    expect(r).toEqual([{ userId: 'admin1', priority: 'FEED', needs_action: false }]);
  });
});

describe('resolveRecipients — TEAM verbs', () => {
  it('team.invite_accepted → admin FEED', () => {
    const r = resolveRecipients({ ...base, verb: 'team.invite_accepted',
      entity: { user_id: 'tech1' } });
    expect(r).toContainEqual({ userId: 'admin1', priority: 'FEED', needs_action: false });
    expect(r.find(x => x.userId === 'disp1')).toBeUndefined();
  });
});

describe('resolveRecipients — INVENTORY verbs', () => {
  it('inventory.stock_approval_requested → admin INTERRUPT + needs_action', () => {
    const r = resolveRecipients({ ...base, verb: 'inventory.stock_approval_requested',
      entity: { id: 'sr1' } });
    expect(r).toEqual([{ userId: 'admin1', priority: 'INTERRUPT', needs_action: true }]);
  });

  it('inventory.low_stock → admin + dispatcher FEED', () => {
    const r = resolveRecipients({ ...base, verb: 'inventory.low_stock',
      entity: { id: 'item1' } });
    expect(r.map(x => x.userId).sort()).toEqual(['admin1', 'disp1']);
    r.forEach(rec => expect(rec.priority).toBe('FEED'));
  });

  it('inventory.backorder → admin + dispatcher FEED', () => {
    const r = resolveRecipients({ ...base, verb: 'inventory.backorder',
      entity: { id: 'item1' } });
    expect(r.map(x => x.userId).sort()).toEqual(['admin1', 'disp1']);
  });

  it('inventory.staging_ready → admin + dispatcher FEED', () => {
    const r = resolveRecipients({ ...base, verb: 'inventory.staging_ready',
      entity: { id: 'item1' } });
    expect(r.map(x => x.userId).sort()).toEqual(['admin1', 'disp1']);
  });

  it('inventory.staging_no_area → admin + dispatcher FEED', () => {
    const r = resolveRecipients({ ...base, verb: 'inventory.staging_no_area',
      entity: { id: 'item1' } });
    expect(r.map(x => x.userId).sort()).toEqual(['admin1', 'disp1']);
  });

  it('inventory.po_partial → admin + dispatcher FEED', () => {
    const r = resolveRecipients({ ...base, verb: 'inventory.po_partial',
      entity: { id: 'item1' } });
    expect(r.map(x => x.userId).sort()).toEqual(['admin1', 'disp1']);
  });
});

describe('resolveRecipients — SECURITY verbs', () => {
  it('security.password_changed → only the affected user, FEED', () => {
    const r = resolveRecipients({ ...base, verb: 'security.password_changed',
      entity: { user_id: 'admin1' } });
    expect(r).toEqual([{ userId: 'admin1', priority: 'FEED', needs_action: false }]);
  });

  it('security.mfa_enabled → only the affected user, FEED', () => {
    const r = resolveRecipients({ ...base, verb: 'security.mfa_enabled',
      entity: { user_id: 'tech2' } });
    expect(r).toEqual([{ userId: 'tech2', priority: 'FEED', needs_action: false }]);
  });

  it('security.mfa_disabled → only the affected user, FEED', () => {
    const r = resolveRecipients({ ...base, verb: 'security.mfa_disabled',
      entity: { user_id: 'sales1' } });
    expect(r).toEqual([{ userId: 'sales1', priority: 'FEED', needs_action: false }]);
  });
});

describe('resolveRecipients — de-dup and priority merging', () => {
  it('INTERRUPT wins over FEED when the same user appears in two roles', () => {
    // tech1 is both an assignee (INTERRUPT in job.cancelled) and a SALES rep
    const rh = { ADMIN: ['admin1'], DISPATCHER: ['disp1'], SALES: ['tech1'], TECHNICIAN: ['tech1'] };
    const r = resolveRecipients({ ...base, roleHolders: rh, verb: 'job.cancelled',
      entity: { id: 'j1', assignee_ids: ['tech1'], sold_by_id: 'tech1' } });
    const entry = r.find(x => x.userId === 'tech1');
    expect(entry).toBeDefined();
    expect(entry!.priority).toBe('INTERRUPT');
  });

  it('needs_action ORs: if either slot has needs_action the merged result does too', () => {
    // Use admin who is both admin (FEED, no action on billing.invoice_overdue) — just verify directly
    const r = resolveRecipients({ ...base, verb: 'billing.invoice_overdue',
      entity: { id: 'i1', customer_owner_id: 'admin1' } }); // admin is also customer_owner
    const entry = r.find(x => x.userId === 'admin1');
    expect(entry).toBeDefined();
    expect(entry!.needs_action).toBe(true);
  });

  it('returns empty array for unknown verb', () => {
    const r = resolveRecipients({ ...base, verb: 'unknown.verb', entity: {} });
    expect(r).toEqual([]);
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// communication.email_inbound — a customer reply landing in the shared inbox.
//
// A thread is owned ("assigned to one, visible to all", slice 8b), so the reply
// goes to whoever holds it rather than interrupting the whole office. Only when
// nobody holds it does it fall back to the room, matching sms_inbound.
// ──────────────────────────────────────────────────────────────────────────────

describe('resolveRecipients — communication.email_inbound', () => {
  it('routes a reply to the thread assignee, and to nobody else', () => {
    const r = resolveRecipients({ ...base, verb: 'communication.email_inbound',
      entity: { id: 'em1', thread_assignee_id: 'tech1' } });
    expect(r).toEqual([{ userId: 'tech1', priority: 'INTERRUPT', needs_action: false }]);
  });

  it('falls back to dispatcher + admin when the thread is unassigned', () => {
    const r = resolveRecipients({ ...base, verb: 'communication.email_inbound',
      entity: { id: 'em1' } });
    expect(r.map(x => x.userId).sort()).toEqual(['admin1', 'disp1']);
    // The room gets a feed entry, not an interrupt - nobody owns this yet, so
    // there is no one it is urgent FOR.
    expect(r.find(x => x.priority === 'INTERRUPT')).toBeUndefined();
  });

  it('does not also notify the room when the thread IS assigned', () => {
    // The whole point of assignment. An assignee plus a broadcast would make
    // ownership decorative.
    const r = resolveRecipients({ ...base, verb: 'communication.email_inbound',
      entity: { id: 'em1', thread_assignee_id: 'tech1' } });
    expect(r.map(x => x.userId)).not.toContain('admin1');
    expect(r.map(x => x.userId)).not.toContain('disp1');
  });

  it('falls back to the room when the assignee is the actor', () => {
    // dedupe() drops the actor. Without a fallback the reply would notify
    // nobody at all - worse than notifying too many.
    const r = resolveRecipients({ ...base, verb: 'communication.email_inbound', actorId: 'tech1',
      entity: { id: 'em1', thread_assignee_id: 'tech1' } });
    expect(r.map(x => x.userId).sort()).toEqual(['admin1', 'disp1']);
  });
});
