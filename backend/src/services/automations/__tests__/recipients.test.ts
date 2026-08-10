import { describe, it, expect, beforeEach, vi } from 'vitest';
import { prisma } from '../../../lib/prisma';
import {
  audiencesForEntity,
  audienceLabel,
  resolveAudience,
  type AudienceContext,
} from '../recipients';
import type { RecipientUser } from '../executors';

const mockPrisma = prisma as any;
const ORG = '00000000-0000-0000-0000-000000000001';

function user(overrides: Partial<RecipientUser> = {}): RecipientUser {
  return { id: 'u1', email: 'u1@org.com', first_name: 'Ann', last_name: 'Lee', ...overrides };
}

function ctx(overrides: Partial<AudienceContext> = {}): AudienceContext {
  return {
    organizationId: ORG,
    entity: 'job',
    customer: { id: 'c1', email: 'cust@example.com' },
    assignees: [],
    dispatcher: null,
    salesperson: null,
    creator: null,
    eventRecipient: null,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

// ── audiencesForEntity ──────────────────────────────────────────────────────

describe('audiencesForEntity', () => {
  it('job → customer, assigned_team, dispatcher, salesperson, all_admins, all_dispatchers, specific_user', () => {
    expect(audiencesForEntity('job')).toEqual([
      'customer',
      'assigned_team',
      'dispatcher',
      'salesperson',
      'all_admins',
      'all_dispatchers',
      'specific_user',
    ]);
  });

  it('lead → drops dispatcher, keeps salesperson + assigned_team', () => {
    expect(audiencesForEntity('lead')).toEqual([
      'customer',
      'assigned_team',
      'salesperson',
      'all_admins',
      'all_dispatchers',
      'specific_user',
    ]);
  });

  it('estimate → creator + salesperson, no dispatcher / assigned_team', () => {
    expect(audiencesForEntity('estimate')).toEqual([
      'customer',
      'creator',
      'salesperson',
      'all_admins',
      'all_dispatchers',
      'specific_user',
    ]);
  });

  it('invoice → customer + admins/dispatchers/specific only (salesperson dropped)', () => {
    expect(audiencesForEntity('invoice')).toEqual([
      'customer',
      'all_admins',
      'all_dispatchers',
      'specific_user',
    ]);
  });

  it('never includes custom (custom is added at SEND_EMAIL validation time, not here)', () => {
    for (const e of ['job', 'lead', 'estimate', 'invoice'] as const) {
      expect(audiencesForEntity(e)).not.toContain('custom');
    }
  });

  it('returns a fresh array (callers cannot mutate the shared source of truth)', () => {
    const a = audiencesForEntity('job');
    a.push('custom');
    expect(audiencesForEntity('job')).not.toContain('custom');
  });
});

// ── audienceLabel ───────────────────────────────────────────────────────────

describe('audienceLabel', () => {
  it('assigned_team differs per entity: walkthrough team for lead, assigned crew otherwise', () => {
    expect(audienceLabel('assigned_team', 'lead')).toBe('the walkthrough team');
    expect(audienceLabel('assigned_team', 'job')).toBe('the assigned crew');
    expect(audienceLabel('assigned_team', 'estimate')).toBe('the assigned crew');
    expect(audienceLabel('assigned_team', 'invoice')).toBe('the assigned crew');
  });

  it('renders plain-English labels for every other key', () => {
    expect(audienceLabel('customer', 'job')).toBe('the customer');
    expect(audienceLabel('dispatcher', 'job')).toBe('the dispatcher');
    expect(audienceLabel('salesperson', 'job')).toBe('the salesperson');
    expect(audienceLabel('creator', 'estimate')).toBe('the creator');
    expect(audienceLabel('all_admins', 'job')).toBe('all admins');
    expect(audienceLabel('all_dispatchers', 'job')).toBe('all dispatchers');
    expect(audienceLabel('specific_user', 'job')).toBe('a specific person');
    expect(audienceLabel('custom', 'job')).toBe('a custom email');
  });

  it('removed_user differs per entity: removed technician for job, removed performer for lead', () => {
    expect(audienceLabel('removed_user', 'job')).toBe('the removed technician');
    expect(audienceLabel('removed_user', 'lead')).toBe('the removed performer');
  });

  it('assigned_user differs per entity: the assigned technician for job, the assigned performer for lead', () => {
    expect(audienceLabel('assigned_user', 'job')).toBe('the assigned technician');
    expect(audienceLabel('assigned_user', 'lead')).toBe('the assigned performer');
  });
});

// ── resolveAudience — customer ──────────────────────────────────────────────

describe('resolveAudience — customer', () => {
  it('returns the customer email when present', async () => {
    const r = await resolveAudience('customer', ctx({ customer: { id: 'c1', email: 'a@b.com' } }));
    expect(r).toEqual({ users: [], emails: ['a@b.com'] });
  });

  it('skips with the plain-English reason when the customer has no email', async () => {
    const r = await resolveAudience('customer', ctx({ customer: { id: 'c1', email: null } }));
    expect(r.emails).toEqual([]);
    expect(r.skipReason).toBe('The customer has no email address on file');
  });

  it('skips when there is no customer at all (never throws)', async () => {
    const r = await resolveAudience('customer', ctx({ customer: null }));
    expect(r.skipReason).toBe('The customer has no email address on file');
  });

  // ── extra_emails[] — opted-in secondary addresses ─────────────────────────
  // context.ts pre-filters to receives_emails:true rows, so anything reaching
  // this resolver is already opted in; the resolver only merges and dedupes.

  it('appends opted-in extra emails after the primary', async () => {
    const r = await resolveAudience(
      'customer',
      ctx({ customer: { id: 'c1', email: 'a@b.com', extra_emails: [{ email: 'ops@b.com' }] } }),
    );
    expect(r).toEqual({ users: [], emails: ['a@b.com', 'ops@b.com'] });
  });

  it('preserves the order the extras arrive in', async () => {
    const r = await resolveAudience(
      'customer',
      ctx({
        customer: {
          id: 'c1',
          email: 'a@b.com',
          extra_emails: [{ email: 'ops@b.com' }, { email: 'billing@b.com' }],
        },
      }),
    );
    expect(r.emails).toEqual(['a@b.com', 'ops@b.com', 'billing@b.com']);
  });

  it('sends to the extras when the customer has no primary email', async () => {
    const r = await resolveAudience(
      'customer',
      ctx({ customer: { id: 'c1', email: null, extra_emails: [{ email: 'ops@b.com' }] } }),
    );
    expect(r.emails).toEqual(['ops@b.com']);
    expect(r.skipReason).toBeUndefined();
  });

  it('dedupes an extra that repeats the primary, case- and whitespace-insensitively', async () => {
    const r = await resolveAudience(
      'customer',
      ctx({
        customer: {
          id: 'c1',
          email: 'a@b.com',
          extra_emails: [{ email: ' A@B.com ' }, { email: 'ops@b.com' }, { email: 'OPS@b.com' }],
        },
      }),
    );
    expect(r.emails).toEqual(['a@b.com', 'ops@b.com']);
  });

  it('ignores blank extra rows rather than emailing an empty address', async () => {
    const r = await resolveAudience(
      'customer',
      ctx({ customer: { id: 'c1', email: 'a@b.com', extra_emails: [{ email: '   ' }] } }),
    );
    expect(r.emails).toEqual(['a@b.com']);
  });

  it('still skips when the primary is absent and every extra is opted out (empty array)', async () => {
    const r = await resolveAudience('customer', ctx({ customer: { id: 'c1', email: null, extra_emails: [] } }));
    expect(r.emails).toEqual([]);
    expect(r.skipReason).toBe('The customer has no email address on file');
  });
});

// ── resolveAudience — assigned_team (+ legacy alias) ────────────────────────

describe('resolveAudience — assigned_team', () => {
  it('returns the crew for a job ctx', async () => {
    const crew = [user({ id: 'u1' }), user({ id: 'u2' })];
    const r = await resolveAudience('assigned_team', ctx({ entity: 'job', assignees: crew }));
    expect(r).toEqual({ users: crew, emails: [] });
  });

  it('returns the walkthrough performers for a lead ctx', async () => {
    const performers = [user({ id: 'p1' })];
    const r = await resolveAudience('assigned_team', ctx({ entity: 'lead', assignees: performers }));
    expect(r).toEqual({ users: performers, emails: [] });
  });

  it('empty job → "No one is assigned to this job yet"', async () => {
    const r = await resolveAudience('assigned_team', ctx({ entity: 'job', assignees: [] }));
    expect(r.users).toEqual([]);
    expect(r.skipReason).toBe('No one is assigned to this job yet');
  });

  it('empty lead → "No walkthrough team is assigned yet"', async () => {
    const r = await resolveAudience('assigned_team', ctx({ entity: 'lead', assignees: [] }));
    expect(r.skipReason).toBe('No walkthrough team is assigned yet');
  });

  it('legacy "assigned_techs" resolves IDENTICALLY to "assigned_team" (job crew)', async () => {
    const crew = [user({ id: 'u1' })];
    const legacy = await resolveAudience('assigned_techs', ctx({ entity: 'job', assignees: crew }));
    const canonical = await resolveAudience('assigned_team', ctx({ entity: 'job', assignees: crew }));
    expect(legacy).toEqual(canonical);
    expect(legacy).toEqual({ users: crew, emails: [] });
  });

  it('legacy "assigned_techs" empty lead → same walkthrough skipReason', async () => {
    const r = await resolveAudience('assigned_techs', ctx({ entity: 'lead', assignees: [] }));
    expect(r.skipReason).toBe('No walkthrough team is assigned yet');
  });
});

// ── resolveAudience — dispatcher / salesperson / creator ────────────────────

describe('resolveAudience — dispatcher / salesperson / creator', () => {
  it('dispatcher present → that user', async () => {
    const d = user({ id: 'd1' });
    expect(await resolveAudience('dispatcher', ctx({ dispatcher: d }))).toEqual({ users: [d], emails: [] });
  });

  it('dispatcher null → "No dispatcher is assigned to this job"', async () => {
    const r = await resolveAudience('dispatcher', ctx({ dispatcher: null }));
    expect(r.skipReason).toBe('No dispatcher is assigned to this job');
  });

  it('salesperson present → that user; null → "No salesperson is assigned"', async () => {
    const s = user({ id: 's1' });
    expect(await resolveAudience('salesperson', ctx({ salesperson: s }))).toEqual({ users: [s], emails: [] });
    expect((await resolveAudience('salesperson', ctx({ salesperson: null }))).skipReason).toBe(
      'No salesperson is assigned',
    );
  });

  it('creator present → that user; null → "This record has no creator on file"', async () => {
    const c = user({ id: 'cr1' });
    expect(await resolveAudience('creator', ctx({ entity: 'estimate', creator: c }))).toEqual({
      users: [c],
      emails: [],
    });
    expect((await resolveAudience('creator', ctx({ entity: 'estimate', creator: null }))).skipReason).toBe(
      'This record has no creator on file',
    );
  });
});

// ── resolveAudience — removed_user ──────────────────────────────────────────
// Unlike every other audience, this one can't be re-derived from the live
// entity (the person is no longer on the crew/team by the time the automation
// runs) — it comes from ctx.eventRecipient, sourced from the enrollment's
// persisted event_payload (context.ts), not from a live DB lookup here.

describe('resolveAudience — removed_user', () => {
  it('resolves to the event-captured recipient when present', async () => {
    const removed = user({ id: 'r1', first_name: 'Priya' });
    const r = await resolveAudience('removed_user', ctx({ eventRecipient: removed }));
    expect(r).toEqual({ users: [removed], emails: [] });
  });

  it('skips with a plain-English reason when no removed recipient was captured', async () => {
    const r = await resolveAudience('removed_user', ctx({ eventRecipient: null }));
    expect(r.users).toEqual([]);
    expect(r.skipReason).toBeTruthy();
  });
});

// ── resolveAudience — assigned_user ─────────────────────────────────────────
// Same mechanism as removed_user (ctx.eventRecipient), for the opposite case:
// TECH_ASSIGNED / WALKTHROUGH_PERFORMER_ASSIGNED dispatch once per newly-added
// person, so the audience must be that ONE person, not the live full crew
// (which is what `assigned_team` would resolve to — see defaultAutomations.ts).

describe('resolveAudience — assigned_user', () => {
  it('resolves to the event-captured recipient when present', async () => {
    const added = user({ id: 'a1', first_name: 'Priya' });
    const r = await resolveAudience('assigned_user', ctx({ eventRecipient: added }));
    expect(r).toEqual({ users: [added], emails: [] });
  });

  it('skips with a plain-English reason when no assigned recipient was captured', async () => {
    const r = await resolveAudience('assigned_user', ctx({ eventRecipient: null }));
    expect(r.users).toEqual([]);
    expect(r.skipReason).toBeTruthy();
  });
});

// ── resolveAudience — all_admins / all_dispatchers ──────────────────────────

describe('resolveAudience — all_admins / all_dispatchers', () => {
  it('all_admins queries active ADMINs scoped to the org', async () => {
    const admins = [user({ id: 'a1' }), user({ id: 'a2' })];
    mockPrisma.user.findMany.mockResolvedValueOnce(admins);
    const r = await resolveAudience('all_admins', ctx());
    expect(r).toEqual({ users: admins, emails: [] });
    expect(mockPrisma.user.findMany.mock.calls[0][0]).toMatchObject({
      where: { organization_id: ORG, role: 'ADMIN', is_active: true },
      select: { id: true, email: true, first_name: true, last_name: true },
    });
  });

  it('all_dispatchers queries active DISPATCHERs', async () => {
    mockPrisma.user.findMany.mockResolvedValueOnce([user({ id: 'd1' })]);
    await resolveAudience('all_dispatchers', ctx());
    expect(mockPrisma.user.findMany.mock.calls[0][0]).toMatchObject({
      where: { organization_id: ORG, role: 'DISPATCHER', is_active: true },
    });
  });

  it('empty admins → skip', async () => {
    mockPrisma.user.findMany.mockResolvedValueOnce([]);
    const r = await resolveAudience('all_admins', ctx());
    expect(r.users).toEqual([]);
    expect(r.skipReason).toMatch(/no active admins/i);
  });

  it('empty dispatchers → skip', async () => {
    mockPrisma.user.findMany.mockResolvedValueOnce([]);
    const r = await resolveAudience('all_dispatchers', ctx());
    expect(r.skipReason).toMatch(/no active dispatchers/i);
  });
});

// ── resolveAudience — specific_user ─────────────────────────────────────────

describe('resolveAudience — specific_user', () => {
  it('resolves the chosen active user inside the org only', async () => {
    const u = user({ id: 'u9' });
    mockPrisma.user.findFirst.mockResolvedValueOnce(u);
    const r = await resolveAudience('specific_user', ctx({ userId: 'u9' }));
    expect(r).toEqual({ users: [u], emails: [] });
    expect(mockPrisma.user.findFirst.mock.calls[0][0].where).toMatchObject({
      id: 'u9',
      organization_id: ORG,
      is_active: true,
    });
  });

  it('no userId → "No team member was chosen" (and no db call)', async () => {
    const r = await resolveAudience('specific_user', ctx({ userId: undefined }));
    expect(r.skipReason).toBe('No team member was chosen');
    expect(mockPrisma.user.findFirst).not.toHaveBeenCalled();
  });

  it('userId set but user not found / inactive → skip with a reason', async () => {
    mockPrisma.user.findFirst.mockResolvedValueOnce(null);
    const r = await resolveAudience('specific_user', ctx({ userId: 'ghost' }));
    expect(r.users).toEqual([]);
    expect(r.skipReason).toBeTruthy();
  });
});

// ── resolveAudience — custom ────────────────────────────────────────────────

describe('resolveAudience — custom', () => {
  it('returns the configured emails', async () => {
    const r = await resolveAudience('custom', ctx({ customEmails: ['a@b.com', 'c@d.com'] }));
    expect(r).toEqual({ users: [], emails: ['a@b.com', 'c@d.com'] });
  });

  it('empty / missing → "No email address was configured"', async () => {
    expect((await resolveAudience('custom', ctx({ customEmails: [] }))).skipReason).toBe(
      'No email address was configured',
    );
    expect((await resolveAudience('custom', ctx({ customEmails: undefined }))).skipReason).toBe(
      'No email address was configured',
    );
  });
});
