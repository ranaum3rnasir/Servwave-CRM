import { describe, it, expect } from 'vitest';
import {
  waitConfigSchema,
  sendTextConfigSchema,
  sendEmailConfigSchema,
  notifyTeamConfigSchema,
  stopIfConfigSchema,
  mergeFieldsIn,
  MERGE_FIELD_RE,
} from './stepSchemas';

/** First plain-English message zod produced for a given field path. */
function messageFor(result: { success: boolean; error?: { issues: { path: (string | number)[]; message: string }[] } }, field: string): string | undefined {
  if (result.success) return undefined;
  return result.error!.issues.find((i) => i.path.join('.') === field)?.message;
}

describe('waitConfigSchema — bounds mirror the backend (5..129600 whole minutes)', () => {
  it('rejects 4 minutes (below the floor)', () => {
    const r = waitConfigSchema.safeParse({ duration_minutes: 4 });
    expect(r.success).toBe(false);
  });
  it('accepts 5 minutes (the floor)', () => {
    expect(waitConfigSchema.safeParse({ duration_minutes: 5 }).success).toBe(true);
  });
  it('accepts 129600 minutes (90 days, the ceiling)', () => {
    expect(waitConfigSchema.safeParse({ duration_minutes: 129600 }).success).toBe(true);
  });
  it('rejects 129601 minutes (above the ceiling)', () => {
    expect(waitConfigSchema.safeParse({ duration_minutes: 129601 }).success).toBe(false);
  });
  it('rejects a non-integer duration', () => {
    expect(waitConfigSchema.safeParse({ duration_minutes: 5.5 }).success).toBe(false);
  });
  it('rejects a non-numeric duration', () => {
    expect(waitConfigSchema.safeParse({ duration_minutes: Number.NaN }).success).toBe(false);
  });
});

describe('waitConfigSchema — anchored mode + legacy relative pass-through', () => {
  it('parses a legacy relative config with no mode key, defaulting mode to relative', () => {
    const r = waitConfigSchema.safeParse({ duration_minutes: 1440 });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data).toEqual({ mode: 'relative', duration_minutes: 1440 });
  });

  it('parses an explicit relative config', () => {
    expect(waitConfigSchema.safeParse({ mode: 'relative', duration_minutes: 60 }).success).toBe(true);
  });

  it('parses an anchored config', () => {
    const r = waitConfigSchema.safeParse({
      mode: 'anchored',
      anchor: 'lead.walkthrough_scheduled_at',
      direction: 'before',
      offset_minutes: 1440,
    });
    expect(r.success).toBe(true);
  });

  it('accepts an anchored offset of 0 (exactly at the anchor)', () => {
    const r = waitConfigSchema.safeParse({
      mode: 'anchored',
      anchor: 'job.scheduled_start',
      direction: 'after',
      offset_minutes: 0,
    });
    expect(r.success).toBe(true);
  });

  it('rejects an anchored config with an unrecognized anchor key', () => {
    const r = waitConfigSchema.safeParse({
      mode: 'anchored',
      anchor: 'invoice.due_date',
      direction: 'before',
      offset_minutes: 1440,
    });
    expect(r.success).toBe(false);
  });

  it('rejects an anchored config with an invalid direction', () => {
    const r = waitConfigSchema.safeParse({
      mode: 'anchored',
      anchor: 'job.scheduled_start',
      direction: 'sideways',
      offset_minutes: 60,
    });
    expect(r.success).toBe(false);
  });

  it('rejects an anchored offset above the 90-day ceiling', () => {
    const r = waitConfigSchema.safeParse({
      mode: 'anchored',
      anchor: 'job.scheduled_start',
      direction: 'before',
      offset_minutes: 129601,
    });
    expect(r.success).toBe(false);
  });

  it('rejects a relative config below the 5-minute floor even with an explicit mode', () => {
    expect(waitConfigSchema.safeParse({ mode: 'relative', duration_minutes: 4 }).success).toBe(false);
  });
});

describe('sendTextConfigSchema — customer-only, 1..320', () => {
  it('accepts a 250-char body (no error)', () => {
    const r = sendTextConfigSchema.safeParse({ recipient: 'customer', body: 'a'.repeat(250) });
    expect(r.success).toBe(true);
  });
  it('rejects a 321-char body with the exact plain-English message', () => {
    const r = sendTextConfigSchema.safeParse({ recipient: 'customer', body: 'a'.repeat(321) });
    expect(r.success).toBe(false);
    expect(messageFor(r, 'body')).toBe('Texts are capped at 320 characters');
  });
  it('rejects an empty body', () => {
    expect(sendTextConfigSchema.safeParse({ recipient: 'customer', body: '' }).success).toBe(false);
  });
  it('rejects a non-customer recipient', () => {
    expect(sendTextConfigSchema.safeParse({ recipient: 'all_admins', body: 'hi' }).success).toBe(false);
  });
});

describe('sendEmailConfigSchema — subject 1..200, body 1..5000, custom⇒email', () => {
  it('accepts a customer email with a subject + body', () => {
    const r = sendEmailConfigSchema.safeParse({ recipient: 'customer', subject: 'Hi', body: 'Body' });
    expect(r.success).toBe(true);
  });
  it('rejects an empty subject', () => {
    const r = sendEmailConfigSchema.safeParse({ recipient: 'customer', subject: '', body: 'Body' });
    expect(messageFor(r, 'subject')).toBe('Add a subject line');
  });
  it('rejects a 201-char subject', () => {
    const r = sendEmailConfigSchema.safeParse({ recipient: 'customer', subject: 'a'.repeat(201), body: 'Body' });
    expect(r.success).toBe(false);
  });
  it('rejects a 5001-char body', () => {
    const r = sendEmailConfigSchema.safeParse({ recipient: 'customer', subject: 'Hi', body: 'a'.repeat(5001) });
    expect(r.success).toBe(false);
  });
  it('requires custom_email when the recipient is custom (exact message)', () => {
    const r = sendEmailConfigSchema.safeParse({ recipient: 'custom', subject: 'Hi', body: 'Body' });
    expect(r.success).toBe(false);
    expect(messageFor(r, 'custom_email')).toBe('Enter the email address to send to');
  });
  it('flags a malformed custom_email', () => {
    const r = sendEmailConfigSchema.safeParse({ recipient: 'custom', subject: 'Hi', body: 'Body', custom_email: 'nope' });
    expect(messageFor(r, 'custom_email')).toBe('Enter a valid email address');
  });
  it('accepts a valid custom_email', () => {
    const r = sendEmailConfigSchema.safeParse({
      recipient: 'custom',
      subject: 'Hi',
      body: 'Body',
      custom_email: 'office@acme.com',
    });
    expect(r.success).toBe(true);
  });
  it('ignores an empty custom_email when the recipient is not custom', () => {
    const r = sendEmailConfigSchema.safeParse({ recipient: 'customer', subject: 'Hi', body: 'Body', custom_email: '' });
    expect(r.success).toBe(true);
  });
});

describe('notifyTeamConfigSchema — team recipients, specific_user⇒user_id', () => {
  it('accepts an all_admins notification', () => {
    expect(notifyTeamConfigSchema.safeParse({ recipient: 'all_admins', body: 'x' }).success).toBe(true);
  });
  it('rejects the customer recipient (not a team target)', () => {
    expect(notifyTeamConfigSchema.safeParse({ recipient: 'customer', body: 'x' }).success).toBe(false);
  });
  it('requires user_id when the recipient is specific_user (exact message)', () => {
    const r = notifyTeamConfigSchema.safeParse({ recipient: 'specific_user', body: 'x' });
    expect(r.success).toBe(false);
    expect(messageFor(r, 'user_id')).toBe('Pick the team member to notify');
  });
  it('accepts specific_user with a user_id', () => {
    const r = notifyTeamConfigSchema.safeParse({
      recipient: 'specific_user',
      body: 'x',
      user_id: '00000000-0000-0000-0000-000000000001',
    });
    expect(r.success).toBe(true);
  });
});

describe('stopIfConfigSchema — a non-empty condition slug', () => {
  it('accepts a condition', () => {
    expect(stopIfConfigSchema.safeParse({ condition: 'invoice_paid' }).success).toBe(true);
  });
  it('rejects an empty condition', () => {
    expect(stopIfConfigSchema.safeParse({ condition: '' }).success).toBe(false);
  });
});

describe('Task 19 — recipients[] array shape + legacy singular normalization', () => {
  it('SEND_EMAIL: a recipients[] array shape validates', () => {
    const r = sendEmailConfigSchema.safeParse({ recipients: ['customer', 'all_admins'], subject: 'Hi', body: 'Body' });
    expect(r.success).toBe(true);
  });

  it('SEND_EMAIL: legacy singular { recipient } still parses and normalizes to recipients[]', () => {
    const r = sendEmailConfigSchema.safeParse({ recipient: 'customer', subject: 'Hi', body: 'Body' });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.recipients).toEqual(['customer']);
  });

  it('SEND_EMAIL: legacy { custom_email } folds into custom_emails[]', () => {
    const r = sendEmailConfigSchema.safeParse({
      recipient: 'custom',
      subject: 'Hi',
      body: 'Body',
      custom_email: 'office@acme.com',
    });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.custom_emails).toEqual(['office@acme.com']);
  });

  it('SEND_EMAIL: an empty recipients[] is rejected (min 1)', () => {
    expect(sendEmailConfigSchema.safeParse({ recipients: [], subject: 'Hi', body: 'Body' }).success).toBe(false);
  });

  it('NOTIFY_TEAM: a recipients[] array shape validates', () => {
    const r = notifyTeamConfigSchema.safeParse({ recipients: ['all_admins', 'all_dispatchers'], body: 'x' });
    expect(r.success).toBe(true);
  });

  it('NOTIFY_TEAM: legacy singular { recipient } + { user_id } normalize to arrays', () => {
    const r = notifyTeamConfigSchema.safeParse({
      recipient: 'specific_user',
      body: 'x',
      user_id: '00000000-0000-0000-0000-000000000001',
    });
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.recipients).toEqual(['specific_user']);
      expect(r.data.user_ids).toEqual(['00000000-0000-0000-0000-000000000001']);
    }
  });

  it('SEND_TEXT: recipients: ["customer"] validates; legacy singular parses', () => {
    expect(sendTextConfigSchema.safeParse({ recipients: ['customer'], body: 'Hi' }).success).toBe(true);
    expect(sendTextConfigSchema.safeParse({ recipient: 'customer', body: 'Hi' }).success).toBe(true);
  });
});

describe('mergeFieldsIn — same regex as the backend validator', () => {
  it('extracts every {{field}} in order', () => {
    expect(mergeFieldsIn('Hi {{customer.first_name}}, job {{job.number}}')).toEqual([
      'customer.first_name',
      'job.number',
    ]);
  });
  it('returns [] for copy with no fields', () => {
    expect(mergeFieldsIn('No merge fields here')).toEqual([]);
  });
  it('ignores tokens with characters outside [a-z_.]', () => {
    expect(mergeFieldsIn('{{Customer.Name}} {{ job.number }}')).toEqual([]);
  });
  it('exposes a global regex', () => {
    expect(MERGE_FIELD_RE.flags).toContain('g');
  });
});
