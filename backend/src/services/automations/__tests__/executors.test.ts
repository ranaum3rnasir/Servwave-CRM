import { describe, it, expect, beforeEach, vi } from 'vitest';
import { prisma } from '../../../lib/prisma';
import { executeAction, type ExecutionBundle } from '../executors';
import { sendAutomationEmail } from '../../../lib/email';
import { DEFAULT_AUTOMATIONS } from '../defaultAutomations';
import * as ctmClient from '../../../lib/ctm/client';
import { _resetCtmSmsDoubleFireGuard } from '../../../lib/ctm/sendSms';

vi.mock('../../notifications/notificationService', () => ({
  emit: vi.fn().mockResolvedValue(undefined),
}));
import { emit } from '../../notifications/notificationService';

const mockPrisma = prisma as any;
const mockEmit = emit as ReturnType<typeof vi.fn>;
const mockSendEmail = sendAutomationEmail as ReturnType<typeof vi.fn>;
const mockCtmClient = ctmClient as any;

const ORG = '00000000-0000-0000-0000-000000000001';

function bundle(overrides: Partial<ExecutionBundle> = {}): ExecutionBundle {
  return {
    entityRef: { type: 'job', id: 'b0000000-0000-0000-0000-000000000001', label: 'J00042' },
    organizationId: ORG,
    org: { name: 'Blue Ridge Plumbing', timezone: 'America/New_York' },
    customer: {
      id: 'c0000000-0000-0000-0000-000000000001',
      first_name: 'Sarah',
      last_name: 'Mitchell',
      email: 'sarah@example.com',
      phone: '+15551234567',
    },
    assignees: [
      { id: 'u0000000-0000-0000-0000-00000000000a', email: 'mike@org.com', first_name: 'Mike', last_name: 'Torres' },
    ],
    mergeCtx: { 'customer.first_name': 'Sarah', 'org.name': 'Blue Ridge Plumbing' },
    jobRef: { id: 'b0000000-0000-0000-0000-000000000001', label: 'J00042' },
    dedupeKey: 'TECH_ASSIGNED:b0000000-0000-0000-0000-000000000001:u-a',
    ...overrides,
  };
}

function rule(action_type: string, action_config: Record<string, unknown>) {
  return {
    id: 'a0000000-0000-0000-0000-0000000000aa',
    name: 'My automation',
    action_type,
    action_config,
    organization_id: ORG,
  } as any;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('executeAction — SEND_EMAIL', () => {
  it('renders merge fields and emails the customer', async () => {
    const res = await executeAction(
      rule('SEND_EMAIL', { recipient: 'customer', subject: 'Hi {{customer.first_name}}', body: 'From {{org.name}}' }),
      bundle(),
    );
    expect(res.status).toBe('SENT');
    expect(res.recipientSummary).toBe('sarah@example.com');
    expect(mockSendEmail).toHaveBeenCalledTimes(1);
    const args = mockSendEmail.mock.calls[0][0];
    expect(args.to).toBe('sarah@example.com');
    expect(args.subject).toBe('Hi Sarah');
    expect(args.text).toContain('From Blue Ridge Plumbing');
  });

  it('escapes the ENTIRE body in the HTML part — staff literals AND merge values', async () => {
    const res = await executeAction(
      rule('SEND_EMAIL', {
        recipient: 'customer',
        subject: 's',
        body: 'Book before <May 1> for {{customer.first_name}}',
      }),
      bundle({
        customer: { id: 'c1', first_name: '<b>Sarah</b>', last_name: null, email: 'sarah@example.com', phone: null },
        mergeCtx: { 'customer.first_name': '<b>Sarah</b>' },
      }),
    );
    expect(res.status).toBe('SENT');
    const html = mockSendEmail.mock.calls[0][0].html as string;
    // staff-authored angle brackets must not become tags…
    expect(html).toContain('Book before &lt;May 1&gt;');
    // …and the customer-controlled merge value must be escaped too
    expect(html).toContain('&lt;b&gt;Sarah&lt;/b&gt;');
    expect(html).not.toContain('<b>Sarah</b>');
    // the plain-text part stays raw
    expect(mockSendEmail.mock.calls[0][0].text).toContain('Book before <May 1>');
  });

  // The bundle -> AudienceContext hop rebuilds the customer object field by field, so
  // it is the seam where opted-in extra addresses are easiest to silently drop.
  it('emails the customer AND their opted-in extra addresses', async () => {
    const res = await executeAction(
      rule('SEND_EMAIL', { recipient: 'customer', subject: 's', body: 'b' }),
      bundle({
        customer: {
          id: 'c1',
          first_name: 'Sarah',
          last_name: null,
          email: 'sarah@example.com',
          phone: null,
          extra_emails: [{ email: 'ops@example.com' }],
        },
      }),
    );
    expect(res.status).toBe('SENT');
    expect(mockSendEmail).toHaveBeenCalledTimes(2);
    expect(mockSendEmail.mock.calls.map((c: any[]) => c[0].to)).toEqual([
      'sarah@example.com',
      'ops@example.com',
    ]);
  });

  it('skips with a plain-English reason when the customer has no email', async () => {
    const res = await executeAction(
      rule('SEND_EMAIL', { recipient: 'customer', subject: 's', body: 'b' }),
      bundle({ customer: { id: 'c1', first_name: 'S', last_name: null, email: null, phone: null } }),
    );
    expect(res.status).toBe('SKIPPED');
    expect(res.detail).toMatch(/no email/i);
    expect(mockSendEmail).not.toHaveBeenCalled();
  });

  it('sends to a custom address', async () => {
    const res = await executeAction(
      rule('SEND_EMAIL', { recipient: 'custom', custom_email: 'office@org.com', subject: 's', body: 'b' }),
      bundle(),
    );
    expect(res.status).toBe('SENT');
    expect(mockSendEmail.mock.calls[0][0].to).toBe('office@org.com');
  });

  it('emails every active dispatcher for all_dispatchers', async () => {
    mockPrisma.user.findMany.mockResolvedValueOnce([
      { id: 'u1', email: 'd1@org.com', first_name: 'D', last_name: 'One' },
      { id: 'u2', email: 'd2@org.com', first_name: 'D', last_name: 'Two' },
    ]);
    const res = await executeAction(
      rule('SEND_EMAIL', { recipient: 'all_dispatchers', subject: 's', body: 'b' }),
      bundle(),
    );
    expect(res.status).toBe('SENT');
    expect(mockPrisma.user.findMany.mock.calls[0][0]).toMatchObject({
      where: { organization_id: ORG, role: 'DISPATCHER', is_active: true },
    });
    expect(mockSendEmail).toHaveBeenCalledTimes(2);
    expect(res.recipientSummary).toBe('d1@org.com, d2@org.com');
  });

  it('emails assigned technicians', async () => {
    const res = await executeAction(
      rule('SEND_EMAIL', { recipient: 'assigned_techs', subject: 's', body: 'b' }),
      bundle(),
    );
    expect(res.status).toBe('SENT');
    expect(mockSendEmail.mock.calls[0][0].to).toBe('mike@org.com');
  });

  // Every staff email in the wild greets its READER by name ("Hi Mike"). Before
  // this, the body was rendered ONCE and mailed to every resolved address, so a
  // three-person crew would all get the same (wrong) name in the greeting.
  it('renders {{recipient.first_name}} per-address — each teammate sees their own name', async () => {
    mockPrisma.user.findMany.mockResolvedValueOnce([
      { id: 'u1', email: 'd1@org.com', first_name: 'Dana', last_name: 'One' },
      { id: 'u2', email: 'd2@org.com', first_name: 'Priya', last_name: 'Two' },
    ]);
    const res = await executeAction(
      rule('SEND_EMAIL', { recipient: 'all_dispatchers', subject: 's', body: 'Hi {{recipient.first_name}}' }),
      bundle(),
    );
    expect(res.status).toBe('SENT');
    expect(mockSendEmail).toHaveBeenCalledTimes(2);
    const byTo = Object.fromEntries(mockSendEmail.mock.calls.map((c) => [c[0].to, c[0].text]));
    expect(byTo['d1@org.com']).toBe('Hi Dana');
    expect(byTo['d2@org.com']).toBe('Hi Priya');
  });

  it('falls back {{recipient.first_name}} to the customer’s own name when the recipient IS the customer', async () => {
    const res = await executeAction(
      rule('SEND_EMAIL', { recipient: 'customer', subject: 's', body: 'Hi {{recipient.first_name}}' }),
      bundle(),
    );
    expect(res.status).toBe('SENT');
    expect(mockSendEmail.mock.calls[0][0].text).toBe('Hi Sarah');
  });

  it('renders {{recipient.first_name}} empty (never "undefined") for a nameless custom address', async () => {
    const res = await executeAction(
      rule('SEND_EMAIL', {
        recipient: 'custom',
        custom_email: 'office@org.com',
        subject: 's',
        body: 'Hi {{recipient.first_name}} team',
      }),
      bundle(),
    );
    expect(res.status).toBe('SENT');
    expect(mockSendEmail.mock.calls[0][0].text).toBe('Hi  team');
  });

  // Phase 3 cutover: {{event.reason}} is request-time text (req.body.cancelled_reason)
  // carried on event_payload.mergeFields rather than a live DB column — the single most
  // likely place this migration silently degrades. Proves it end to end through the REAL
  // registry body (not a synthetic one) with a reason actually present in mergeCtx.
  it('default-walkthrough-cancelled renders the real cancellation reason from event.reason', async () => {
    const def = DEFAULT_AUTOMATIONS.find((a) => a.builtin_key === 'default-walkthrough-cancelled')!;
    const res = await executeAction(
      rule('SEND_EMAIL', { recipients: def.recipients, subject: def.subject, body: def.body }),
      bundle({
        mergeCtx: {
          'customer.first_name': 'Sarah',
          'customer.full_name': 'Sarah Mitchell',
          'lead.number': 'L00042',
          'event.reason': 'Customer had a scheduling conflict',
        },
      }),
    );
    expect(res.status).toBe('SENT');
    expect(mockSendEmail.mock.calls[0][0].text).toContain('Customer had a scheduling conflict');
    expect(mockSendEmail.mock.calls[0][0].text).not.toContain('{{event.reason}}');
  });
});

// A suppressed or failed send must not be indistinguishable from a real one - the
// Activity tab is the only place an admin can see what an unattended automation
// actually did. Verified live on staging: with email_sending_enabled=false the
// step run still read SENT (see md_files/plans/automations/2026-07-30-task-112-step-run-send-honesty.md).
describe('executeAction - SEND_EMAIL dispatch outcomes (send-run honesty)', () => {
  it('org kill switch (org_disabled) on the only recipient → SKIPPED, not SENT', async () => {
    mockSendEmail.mockResolvedValueOnce({ status: 'skipped', reason: 'org_disabled' });
    const res = await executeAction(
      rule('SEND_EMAIL', { recipient: 'customer', subject: 's', body: 'b' }),
      bundle(),
    );
    expect(res.status).toBe('SKIPPED');
    expect(res.detail).toBe('Email sending is turned off for this organization');
  });

  it('missing provider key (no_api_key) on the only recipient → SKIPPED with a distinct, non-admin-actionable reason', async () => {
    mockSendEmail.mockResolvedValueOnce({ status: 'skipped', reason: 'no_api_key' });
    const res = await executeAction(
      rule('SEND_EMAIL', { recipient: 'customer', subject: 's', body: 'b' }),
      bundle(),
    );
    expect(res.status).toBe('SKIPPED');
    // Distinct copy from the kill switch, and must not imply the org admin can fix it.
    expect(res.detail).not.toBe('Email sending is turned off for this organization');
    expect(res.detail).not.toMatch(/turn(ed)? on|admin|toggle|setting/i);
  });

  it('provider rejection on the only recipient → FAILED, detail carries the provider error', async () => {
    mockSendEmail.mockResolvedValueOnce({ status: 'failed', error: 'Invalid `to` field' });
    const res = await executeAction(
      rule('SEND_EMAIL', { recipient: 'customer', subject: 's', body: 'b' }),
      bundle(),
    );
    expect(res.status).toBe('FAILED');
    expect(res.detail).toContain('Invalid `to` field');
  });

  it('two recipients, one sent + one provider-rejected → SENT overall, detail names the failed address', async () => {
    mockSendEmail
      .mockResolvedValueOnce({ status: 'sent' })
      .mockResolvedValueOnce({ status: 'failed', error: 'blocked' });
    const res = await executeAction(
      rule('SEND_EMAIL', { recipients: ['customer', 'salesperson'], subject: 's', body: 'b' }),
      bundle({ salesperson: { id: 'u2', email: 'sales@org.com', first_name: 'Sam', last_name: 'Lee' } }),
    );
    expect(res.status).toBe('SENT');
    expect(res.detail).toContain('sales@org.com');
    expect(res.detail).toContain('blocked');
  });

  it('every recipient suppressed by the kill switch → SKIPPED, never SENT', async () => {
    mockSendEmail
      .mockResolvedValueOnce({ status: 'skipped', reason: 'org_disabled' })
      .mockResolvedValueOnce({ status: 'skipped', reason: 'org_disabled' });
    const res = await executeAction(
      rule('SEND_EMAIL', { recipients: ['customer', 'salesperson'], subject: 's', body: 'b' }),
      bundle({ salesperson: { id: 'u2', email: 'sales@org.com', first_name: 'Sam', last_name: 'Lee' } }),
    );
    expect(res.status).toBe('SKIPPED');
    expect(mockSendEmail).toHaveBeenCalledTimes(2);
  });
});

describe('executeAction — SEND_SMS', () => {
  it('records the text in the customer SMS thread with the automated flag + job stamp, even while delivery is gated off', async () => {
    mockPrisma.messageThread.findFirst.mockResolvedValueOnce(null);
    mockPrisma.messageThread.create.mockResolvedValueOnce({ id: 'thread-1', customer_id: 'c0000000-0000-0000-0000-000000000001' });
    mockPrisma.message.create.mockResolvedValueOnce({ id: 'msg-1' });

    const res = await executeAction(
      rule('SEND_SMS', { recipient: 'customer', body: 'Hi {{customer.first_name}}' }),
      bundle(),
    );

    // The record is still written (Communication tab shows it), but nothing
    // left the building — the setup.ts global default is CTM-unconnected, so
    // this must not read SENT (the honesty defect this slice fixes).
    expect(res.status).toBe('SKIPPED');
    const msg = mockPrisma.message.create.mock.calls[0][0].data;
    expect(msg).toMatchObject({
      thread_id: 'thread-1',
      direction: 'out',
      body: 'Hi Sarah',
      automated: true,
      job_id: 'b0000000-0000-0000-0000-000000000001',
      job_label: 'J00042',
      organization_id: ORG,
    });
    expect(mockPrisma.timelineEvent.create).toHaveBeenCalled();
  });

  it('reuses an existing sms thread', async () => {
    mockPrisma.messageThread.findFirst.mockResolvedValueOnce({ id: 'thread-9', customer_id: 'c1' });
    mockPrisma.message.create.mockResolvedValueOnce({ id: 'msg-1' });
    await executeAction(rule('SEND_SMS', { recipient: 'customer', body: 'x y z' }), bundle());
    expect(mockPrisma.messageThread.create).not.toHaveBeenCalled();
  });

  it('skips when the customer has no phone number', async () => {
    const res = await executeAction(
      rule('SEND_SMS', { recipient: 'customer', body: 'b' }),
      bundle({ customer: { id: 'c1', first_name: 'S', last_name: null, email: 'e@x.com', phone: null } }),
    );
    expect(res.status).toBe('SKIPPED');
    expect(res.detail).toMatch(/no.*phone/i);
    expect(mockPrisma.message.create).not.toHaveBeenCalled();
  });
});

// A suppressed, gated, or failed SMS delivery must not be indistinguishable
// from a real one — same defect class as #1068 (send-run honesty), now for
// SEND_SMS. mockConnectedSmsOrg() wires a fully connected+ready+entitled org
// so `deliverViaCtm` reaches the real sendCtmSms gates.
describe('executeAction — SEND_SMS dispatch outcomes (send-run honesty)', () => {
  beforeEach(() => {
    // mockReturnValue survives vi.clearAllMocks() (that only clears call
    // history) — reset explicitly so a prior test's "connected" override
    // never leaks into a test relying on the disconnected default.
    mockCtmClient.isCtmConfigured.mockReturnValue(false);
    // Every test in this block reuses the same org/thread/body — reset the
    // module-level double-fire guard or a later test reads DUPLICATE_SEND.
    _resetCtmSmsDoubleFireGuard();
  });

  function mockConnectedSmsOrg() {
    mockCtmClient.isCtmConfigured.mockReturnValue(true);
    mockPrisma.organization.findUnique.mockResolvedValue({
      ctm_account_id: '500001',
      ctm_sms_ready: true,
      sms_sending_enabled: true,
      plan: 'PRO',
      trial_ends_at: null,
      feature_overrides: { phone: true },
    });
    mockPrisma.phoneNumber.findFirst.mockResolvedValue({ ctm_number_id: 'TPN-A' });
    mockPrisma.customer.findFirst.mockResolvedValue({ phone: '+15551234567' });
    mockCtmClient.isOptedOut.mockResolvedValue(false);
    mockPrisma.auditLog.create.mockResolvedValue({});
  }

  function mockSmsRecordWrites() {
    mockPrisma.messageThread.findFirst.mockResolvedValueOnce({ id: 'thread-1', customer_id: 'c0000000-0000-0000-0000-000000000001' });
    mockPrisma.message.create.mockResolvedValueOnce({ id: 'msg-1' });
  }

  it('delivered: true → SENT', async () => {
    mockSmsRecordWrites();
    mockConnectedSmsOrg();
    mockCtmClient.sendSms.mockResolvedValue({ id: 'MSG123' });

    const res = await executeAction(rule('SEND_SMS', { recipient: 'customer', body: 'b' }), bundle());

    expect(res.status).toBe('SENT');
    expect(res.recipientSummary).toBe('+15551234567');
  });

  it('org kill switch (ORG_SMS_DISABLED) → SKIPPED, not SENT', async () => {
    mockSmsRecordWrites();
    mockConnectedSmsOrg();
    mockPrisma.organization.findUnique.mockResolvedValue({
      ctm_account_id: '500001',
      ctm_sms_ready: true,
      sms_sending_enabled: false,
      plan: 'PRO',
      trial_ends_at: null,
      feature_overrides: { phone: true },
    });

    const res = await executeAction(rule('SEND_SMS', { recipient: 'customer', body: 'b' }), bundle());

    expect(res.status).toBe('SKIPPED');
    expect(res.detail).toBe('Text messaging is turned off for this organization');
  });

  it('not entitled to phone (NOT_ENTITLED) → SKIPPED with a distinct, non-admin-actionable reason', async () => {
    mockSmsRecordWrites();
    mockConnectedSmsOrg();
    mockPrisma.organization.findUnique.mockResolvedValue({
      ctm_account_id: '500001',
      ctm_sms_ready: true,
      sms_sending_enabled: true,
      plan: 'STARTER',
      trial_ends_at: null,
      feature_overrides: {},
    });

    const res = await executeAction(rule('SEND_SMS', { recipient: 'customer', body: 'b' }), bundle());

    expect(res.status).toBe('SKIPPED');
    expect(res.detail).not.toBe('Text messaging is turned off for this organization');
  });

  it('recipient opted out (RECIPIENT_OPTED_OUT) → SKIPPED, a compliance outcome, not a defect', async () => {
    mockSmsRecordWrites();
    mockConnectedSmsOrg();
    mockCtmClient.isOptedOut.mockResolvedValue(true);

    const res = await executeAction(rule('SEND_SMS', { recipient: 'customer', body: 'b' }), bundle());

    expect(res.status).toBe('SKIPPED');
    expect(res.detail).toMatch(/opted out/i);
  });

  it('A2P pending (SMS_NOT_READY) → SKIPPED', async () => {
    mockSmsRecordWrites();
    mockConnectedSmsOrg();
    mockPrisma.organization.findUnique.mockResolvedValue({
      ctm_account_id: '500001',
      ctm_sms_ready: false,
      sms_sending_enabled: true,
      plan: 'PRO',
      trial_ends_at: null,
      feature_overrides: { phone: true },
    });

    const res = await executeAction(rule('SEND_SMS', { recipient: 'customer', body: 'b' }), bundle());

    expect(res.status).toBe('SKIPPED');
  });

  it('provider rejection (CTM_ERROR) → FAILED, not SENT and not silently SKIPPED', async () => {
    mockSmsRecordWrites();
    mockConnectedSmsOrg();
    mockCtmClient.sendSms.mockRejectedValue(new mockCtmClient.CtmApiError('CTM API error 500: boom'));
    mockPrisma.message.update.mockResolvedValue({ id: 'msg-1' });

    const res = await executeAction(rule('SEND_SMS', { recipient: 'customer', body: 'b' }), bundle());

    expect(res.status).toBe('FAILED');
  });

  it('not connected at all (NOT_CONNECTED — the common default, CTM never wired for this org) → SKIPPED, not SENT', async () => {
    mockSmsRecordWrites();
    // No mockConnectedSmsOrg(): global setup.ts default is CTM-unconfigured.

    const res = await executeAction(rule('SEND_SMS', { recipient: 'customer', body: 'b' }), bundle());

    expect(res.status).toBe('SKIPPED');
    expect(mockCtmClient.sendSms).not.toHaveBeenCalled();
  });
});

describe('executeAction — NOTIFY_TEAM', () => {
  it('notifies assigned technicians through the notification pipeline', async () => {
    const res = await executeAction(
      rule('NOTIFY_TEAM', { recipient: 'assigned_techs', body: 'Job for {{customer.first_name}}' }),
      bundle(),
    );
    expect(res.status).toBe('SENT');
    expect(res.recipientSummary).toMatch(/Mike Torres/);
    expect(mockEmit).toHaveBeenCalledTimes(1);
    const args = mockEmit.mock.calls[0][0];
    expect(args.verb).toBe('automation.message');
    expect(args.organizationId).toBe(ORG);
    expect(args.entity.recipient_ids).toEqual(['u0000000-0000-0000-0000-00000000000a']);
    expect(args.object).toMatchObject({ type: 'JOB', id: 'b0000000-0000-0000-0000-000000000001' });
    expect(args.data.title).toBe('My automation');
    expect(args.data.body).toBe('Job for Sarah');
    expect(args.dedupKey).toContain('a0000000-0000-0000-0000-0000000000aa');
  });

  it('resolves a specific user inside the org only', async () => {
    mockPrisma.user.findFirst.mockResolvedValueOnce({ id: 'u9', email: 'x@org.com', first_name: 'Ana', last_name: 'Lee' });
    const res = await executeAction(
      rule('NOTIFY_TEAM', { recipient: 'specific_user', user_id: 'u9', body: 'hello there' }),
      bundle(),
    );
    expect(res.status).toBe('SENT');
    expect(mockPrisma.user.findFirst.mock.calls[0][0].where).toMatchObject({ id: 'u9', organization_id: ORG });
  });

  it('skips when no recipients resolve (e.g. no one assigned yet)', async () => {
    const res = await executeAction(
      rule('NOTIFY_TEAM', { recipient: 'assigned_techs', body: 'b' }),
      bundle({ assignees: [] }),
    );
    expect(res.status).toBe('SKIPPED');
    expect(res.detail).toMatch(/no one is assigned/i);
    expect(mockEmit).not.toHaveBeenCalled();
  });
});

// ── Task 19: multi-recipient union / dedupe / partial-skip ──────────────────────
// recipients[] resolves EVERY audience (Task 17 resolver), unions the people
// (dedupe), sends once per unique recipient, and records SKIPPED (never nobody)
// with the joined skip reasons. Customer-messaging invariants: at-most-once,
// never-to-nobody.

const uA = { id: 'ua', email: 'ann@org.com', first_name: 'Ann', last_name: 'Lee' };
const uB = { id: 'ub', email: 'bob@org.com', first_name: 'Bob', last_name: 'Fox' };

describe('executeAction — NOTIFY_TEAM union + dedupe', () => {
  it('two overlapping audiences notify the shared user exactly ONCE (dedupe by id, single emit)', async () => {
    const res = await executeAction(
      rule('NOTIFY_TEAM', { recipients: ['assigned_team', 'dispatcher'], body: 'Heads up' }),
      bundle({ assignees: [uA, uB], dispatcher: uA }),
    );
    expect(res.status).toBe('SENT');
    // ONE notification, fanned to the deduped recipient set — uA appears once.
    expect(mockEmit).toHaveBeenCalledTimes(1);
    const ids: string[] = mockEmit.mock.calls[0][0].entity.recipient_ids;
    expect(ids).toEqual(['ua', 'ub']);
    expect(ids.filter((id) => id === 'ua')).toHaveLength(1);
  });

  it('empty union → SKIPPED with the JOINED skip reasons, and ZERO sends', async () => {
    const res = await executeAction(
      rule('NOTIFY_TEAM', { recipients: ['assigned_team', 'dispatcher'], body: 'b' }),
      bundle({ assignees: [], dispatcher: null }),
    );
    expect(res.status).toBe('SKIPPED');
    expect(res.detail).toMatch(/no one is assigned/i);
    expect(res.detail).toMatch(/no dispatcher/i);
    expect(mockEmit).not.toHaveBeenCalled();
  });

  it('resolves EACH id for a multi specific_user — both team members notified', async () => {
    const u9 = { id: 'u9', email: 'x@org.com', first_name: 'Ana', last_name: 'Lee' };
    const u8 = { id: 'u8', email: 'y@org.com', first_name: 'Ivo', last_name: 'Roe' };
    mockPrisma.user.findFirst.mockResolvedValueOnce(u9).mockResolvedValueOnce(u8);
    const res = await executeAction(
      rule('NOTIFY_TEAM', { recipients: ['specific_user'], user_ids: ['u9', 'u8'], body: 'b' }),
      bundle(),
    );
    expect(res.status).toBe('SENT');
    expect(mockPrisma.user.findFirst).toHaveBeenCalledTimes(2);
    expect(mockEmit).toHaveBeenCalledTimes(1);
    expect(mockEmit.mock.calls[0][0].entity.recipient_ids).toEqual(['u9', 'u8']);
  });
});

describe('executeAction — SEND_EMAIL union + dedupe + partial skip', () => {
  it('unions customer email + team emails and dedupes case-insensitively → one send per address', async () => {
    const res = await executeAction(
      rule('SEND_EMAIL', { recipients: ['customer', 'custom'], custom_emails: ['SARAH@example.com'], subject: 's', body: 'b' }),
      bundle(), // customer email = sarah@example.com
    );
    expect(res.status).toBe('SENT');
    // sarah@example.com and SARAH@example.com are the same address — send ONCE.
    expect(mockSendEmail).toHaveBeenCalledTimes(1);
  });

  it('partial skip: [customer, salesperson] with no salesperson → SENT to the customer, detail notes the skip', async () => {
    const res = await executeAction(
      rule('SEND_EMAIL', { recipients: ['customer', 'salesperson'], subject: 's', body: 'b' }),
      bundle({ salesperson: null }),
    );
    expect(res.status).toBe('SENT');
    expect(mockSendEmail).toHaveBeenCalledTimes(1);
    expect(mockSendEmail.mock.calls[0][0].to).toBe('sarah@example.com');
    expect(res.detail).toMatch(/salesperson/i);
  });

  it('empty union → SKIPPED with joined reasons and ZERO sends (never emails nobody)', async () => {
    const res = await executeAction(
      rule('SEND_EMAIL', { recipients: ['customer', 'salesperson'], subject: 's', body: 'b' }),
      bundle({
        customer: { id: 'c1', first_name: 'S', last_name: null, email: null, phone: null },
        salesperson: null,
      }),
    );
    expect(res.status).toBe('SKIPPED');
    expect(res.detail).toMatch(/no email/i);
    expect(res.detail).toMatch(/salesperson/i);
    expect(mockSendEmail).not.toHaveBeenCalled();
  });

  it('legacy singular { recipient } still parses and sends (back-compat)', async () => {
    const res = await executeAction(
      rule('SEND_EMAIL', { recipient: 'customer', subject: 'Hi {{customer.first_name}}', body: 'b' }),
      bundle(),
    );
    expect(res.status).toBe('SENT');
    expect(mockSendEmail).toHaveBeenCalledTimes(1);
    expect(mockSendEmail.mock.calls[0][0].to).toBe('sarah@example.com');
  });

  // The person a TECH_UNASSIGNED/WALKTHROUGH_PERFORMER_REMOVED automation is
  // MOST likely to message is the one who was just removed — not derivable
  // from the live entity (they're off it), so this comes from bundle.eventRecipient
  // (set from the enrollment's event_payload — context.ts) rather than a resolver DB call.
  it('removed_user resolves from bundle.eventRecipient — {{recipient.first_name}} greets them by name', async () => {
    const removed = { id: 'r1', email: 'removed@org.com', first_name: 'Priya', last_name: 'Nair' };
    const res = await executeAction(
      rule('SEND_EMAIL', { recipient: 'removed_user', subject: 's', body: 'Hi {{recipient.first_name}}' }),
      bundle({ eventRecipient: removed }),
    );
    expect(res.status).toBe('SENT');
    expect(mockSendEmail.mock.calls[0][0].to).toBe('removed@org.com');
    expect(mockSendEmail.mock.calls[0][0].text).toBe('Hi Priya');
  });

  it('removed_user with no captured recipient → SKIPPED, not silently unsent', async () => {
    const res = await executeAction(
      rule('SEND_EMAIL', { recipient: 'removed_user', subject: 's', body: 'b' }),
      bundle({ eventRecipient: null }),
    );
    expect(res.status).toBe('SKIPPED');
    expect(mockSendEmail).not.toHaveBeenCalled();
  });
});

// The hard-coded walkthrough senders this replaced (retired Phase 3, 2026-07-27)
// persisted a Communication-tab row ONLY for the customer recipient — team/performer
// fan-out sends never persisted. The generic engine scopes it differently: every
// recipient gets a `record` passed to sendAutomationEmail (which is what actually
// persists), but `customerId` is populated ONLY for the customer's own address —
// pinned here so the scoping doesn't silently drift.
describe('executeAction — SEND_EMAIL Communication-tab persistence scoping', () => {
  it('passes customerId only on the record for the customer address; team recipients get customerId: null', async () => {
    const res = await executeAction(
      rule('SEND_EMAIL', { recipients: ['customer', 'assigned_team'], subject: 's', body: 'b' }),
      bundle(),
    );
    expect(res.status).toBe('SENT');
    expect(mockSendEmail).toHaveBeenCalledTimes(2);
    const byTo = Object.fromEntries(mockSendEmail.mock.calls.map((c) => [c[0].to, c[0].record]));
    expect(byTo['sarah@example.com']).toMatchObject({ customerId: 'c0000000-0000-0000-0000-000000000001' });
    expect(byTo['mike@org.com']).toMatchObject({ customerId: null });
  });
});
