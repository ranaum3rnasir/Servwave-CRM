import { describe, it, expect, beforeEach, vi } from 'vitest';
import { prisma } from '../../../lib/prisma';
import { loadExecutionBundle } from '../context';

const mockPrisma = prisma as any;

const ORG = '00000000-0000-0000-0000-000000000001';
const LEAD_ID = 'd0000000-0000-0000-0000-000000000001';
const WALKTHROUGH_AT = new Date('2026-08-01T15:00:00.000Z');

const ORG_ROW = {
  name: 'Blue Ridge Plumbing',
  phone: '(555) 204-7788',
  timezone: 'America/New_York',
  currency: 'USD',
  logo_url: null,
  brand_color: '#0C2D3A',
};

// Walkthrough-as-entity redesign, PR-B2: merge fields lead.walkthrough_date/_time/
// performer_names, plus the leadWalkthroughScheduledAt staleness-check state, now resolve
// against the lead's CURRENT visit (D15: next upcoming SCHEDULED; else most recent that
// happened) via the `walkthroughs` relation instead of the legacy flat columns.
function currentVisit(overrides: Record<string, unknown> = {}) {
  return {
    id: 'w0000000-0000-0000-0000-000000000001',
    status: 'SCHEDULED',
    scheduled_at: WALKTHROUGH_AT,
    completed_at: null,
    cancelled_at: null,
    created_at: new Date('2026-07-01'),
    performers: [
      {
        user: {
          id: 't0000000-0000-0000-0000-000000000001',
          email: 'mike@example.com',
          first_name: 'Mike',
          last_name: 'Torres',
        },
      },
    ],
    ...overrides,
  };
}

function leadRow(overrides: Record<string, unknown> = {}) {
  return {
    id: LEAD_ID,
    lead_number: 'L00042',
    status: 'CONTACTED',
    service_request: 'Leaking kitchen faucet',
    customer: {
      id: 'c0000000-0000-0000-0000-000000000001',
      first_name: 'Sarah',
      last_name: 'Mitchell',
      email: 'sarah@example.com',
      phone: '+15551234567',
    },
    walkthroughs: [currentVisit()],
    commission_owner: null,
    service_location: {
      address_line1: '88 Cedar Lane',
      city: 'Asheville',
      state: 'NC',
    },
    ...overrides,
  } as any;
}

beforeEach(() => {
  vi.clearAllMocks();
  mockPrisma.organization.findUnique.mockResolvedValue(ORG_ROW);
  mockPrisma.lead.findFirst.mockResolvedValue(leadRow());
});

describe('loadExecutionBundle — lead', () => {
  it('populates walkthrough state + merge fields from the current visit', async () => {
    const result = await loadExecutionBundle({
      entityType: 'lead',
      entityId: LEAD_ID,
      organizationId: ORG,
      dedupeKey: `LEAD_WALKTHROUGH_SCHEDULED:${LEAD_ID}`,
    });

    expect(result).not.toBeNull();
    expect(result!.state.leadStatus).toBe('CONTACTED');
    expect(result!.state.leadWalkthroughScheduledAt).toEqual(WALKTHROUGH_AT);
    // org-tz formatted — assert non-empty rather than an exact string (timezone-fragile)
    expect(result!.bundle.mergeCtx['lead.walkthrough_date']).toEqual(expect.any(String));
    expect(result!.bundle.mergeCtx['lead.walkthrough_date']).not.toBe('');
    expect(result!.bundle.mergeCtx['lead.walkthrough_time']).toEqual(expect.any(String));
    expect(result!.bundle.mergeCtx['lead.walkthrough_time']).not.toBe('');
    expect(result!.bundle.mergeCtx['lead.performer_names']).toBe('Mike Torres');
  });

  // D1/D15: a lead with a REQUESTED-only visit (never scheduled, nothing has happened) has NO
  // current visit — the merge fields/state must resolve to empty/null, not throw.
  it('resolves to empty merge fields and null state when the lead has no current visit', async () => {
    mockPrisma.lead.findFirst.mockResolvedValue(leadRow({
      walkthroughs: [currentVisit({ status: 'REQUESTED', scheduled_at: null })],
    }));

    const result = await loadExecutionBundle({
      entityType: 'lead',
      entityId: LEAD_ID,
      organizationId: ORG,
      dedupeKey: 'k-none',
    });

    expect(result!.state.leadWalkthroughScheduledAt).toBeNull();
    expect(result!.bundle.mergeCtx['lead.walkthrough_date']).toBe('');
    expect(result!.bundle.mergeCtx['lead.walkthrough_time']).toBe('');
    expect(result!.bundle.mergeCtx['lead.performer_names']).toBe('');
    expect(result!.bundle.assignees).toEqual([]);
  });

  // D1: a lead with TWO visits — an earlier COMPLETED one and a later SCHEDULED one — must
  // resolve to the SCHEDULED one (the upcoming visit always wins over a past one).
  it('resolves to the upcoming SCHEDULED visit over an older COMPLETED one', async () => {
    const completed = currentVisit({
      id: 'w-old', status: 'COMPLETED', scheduled_at: new Date('2026-06-01T10:00:00Z'),
      completed_at: new Date('2026-06-01T11:00:00Z'),
      performers: [{ user: { id: 'u-old', email: 'old@example.com', first_name: 'Old', last_name: 'Tech' } }],
    });
    const scheduled = currentVisit();
    mockPrisma.lead.findFirst.mockResolvedValue(leadRow({ walkthroughs: [completed, scheduled] }));

    const result = await loadExecutionBundle({
      entityType: 'lead',
      entityId: LEAD_ID,
      organizationId: ORG,
      dedupeKey: 'k-two-visits',
    });

    expect(result!.state.leadWalkthroughScheduledAt).toEqual(WALKTHROUGH_AT);
    expect(result!.bundle.mergeCtx['lead.performer_names']).toBe('Mike Torres');
  });

  // Walkthrough automations replace built-in emails that told the customer WHERE
  // to be. Without these two the automation can only name the lead, which is the
  // one thing the customer already knows.
  it('exposes the lead’s service address and lead number as merge fields', async () => {
    const result = await loadExecutionBundle({
      entityType: 'lead',
      entityId: LEAD_ID,
      organizationId: ORG,
      dedupeKey: `LEAD_WALKTHROUGH_SCHEDULED:${LEAD_ID}`,
    });

    expect(result!.bundle.mergeCtx['lead.address']).toBe('88 Cedar Lane, Asheville, NC');
    expect(result!.bundle.mergeCtx['lead.number']).toBe('L00042');
  });

  it('leaves lead.address empty rather than undefined when the lead has no service location', async () => {
    mockPrisma.lead.findFirst.mockResolvedValue(leadRow({ service_location: null }));

    const result = await loadExecutionBundle({
      entityType: 'lead',
      entityId: LEAD_ID,
      organizationId: ORG,
      dedupeKey: `LEAD_WALKTHROUGH_SCHEDULED:${LEAD_ID}`,
    });

    expect(result!.bundle.mergeCtx['lead.address']).toBe('');
  });

  it('joins multiple current-visit performer names with a comma and empties gracefully with none assigned', async () => {
    mockPrisma.lead.findFirst.mockResolvedValueOnce(
      leadRow({
        walkthroughs: [currentVisit({
          performers: [
            { user: { first_name: 'Mike', last_name: 'Torres' } },
            { user: { first_name: 'Ana', last_name: 'Lee' } },
          ],
        })],
      }),
    );
    const withTwo = await loadExecutionBundle({
      entityType: 'lead',
      entityId: LEAD_ID,
      organizationId: ORG,
      dedupeKey: 'k1',
    });
    expect(withTwo!.bundle.mergeCtx['lead.performer_names']).toBe('Mike Torres, Ana Lee');

    mockPrisma.lead.findFirst.mockResolvedValueOnce(leadRow({ walkthroughs: [currentVisit({ performers: [] })] }));
    const withNone = await loadExecutionBundle({
      entityType: 'lead',
      entityId: LEAD_ID,
      organizationId: ORG,
      dedupeKey: 'k2',
    });
    expect(withNone!.bundle.mergeCtx['lead.performer_names']).toBe('');
  });

  it('maps the current visit’s performers into assignees (RecipientUser[])', async () => {
    const result = await loadExecutionBundle({
      entityType: 'lead',
      entityId: LEAD_ID,
      organizationId: ORG,
      dedupeKey: 'k3',
    });

    expect(result!.bundle.assignees).toEqual([
      {
        id: 't0000000-0000-0000-0000-000000000001',
        email: 'mike@example.com',
        first_name: 'Mike',
        last_name: 'Torres',
      },
    ]);
  });

  it('sets salesperson from the commission owner, and null when the lead has none', async () => {
    mockPrisma.lead.findFirst.mockResolvedValueOnce(
      leadRow({
        commission_owner: {
          id: 'o0000000-0000-0000-0000-000000000001',
          email: 'owen@example.com',
          first_name: 'Owen',
          last_name: 'Ortiz',
        },
      }),
    );
    const withOwner = await loadExecutionBundle({
      entityType: 'lead',
      entityId: LEAD_ID,
      organizationId: ORG,
      dedupeKey: 'k4',
    });
    expect(withOwner!.bundle.salesperson).toEqual({
      id: 'o0000000-0000-0000-0000-000000000001',
      email: 'owen@example.com',
      first_name: 'Owen',
      last_name: 'Ortiz',
    });

    const withoutOwner = await loadExecutionBundle({
      entityType: 'lead',
      entityId: LEAD_ID,
      organizationId: ORG,
      dedupeKey: 'k5',
    });
    expect(withoutOwner!.bundle.salesperson).toBeNull();
  });
});

// ── customer extra_emails[] — opted-in secondary recipients ──────────────────
//
// The opt-out is enforced in the QUERY, not downstream: an address with
// receives_emails:false must never be loaded into the bundle at all. These assert
// the where-filter, because that filter is the whole guarantee.

describe('loadExecutionBundle — lead customer extra emails', () => {
  it('loads only the opted-in extra emails onto the bundle customer', async () => {
    mockPrisma.lead.findFirst.mockResolvedValue(
      leadRow({
        customer: {
          id: 'c0000000-0000-0000-0000-000000000001',
          first_name: 'Sarah',
          last_name: 'Mitchell',
          email: 'sarah@example.com',
          phone: '+15551234567',
          extra_emails: [{ email: 'ops@example.com' }],
        },
      }),
    );

    const result = await loadExecutionBundle({
      entityType: 'lead',
      entityId: LEAD_ID,
      organizationId: ORG,
      dedupeKey: 'k-extra-emails',
    });

    expect(result!.bundle.customer!.extra_emails).toEqual([{ email: 'ops@example.com' }]);
  });

  it('narrows the customer include to receives_emails:true', async () => {
    await loadExecutionBundle({
      entityType: 'lead',
      entityId: LEAD_ID,
      organizationId: ORG,
      dedupeKey: 'k-extra-emails-filter',
    });

    const arg = mockPrisma.lead.findFirst.mock.calls[0][0];
    expect(arg.include.customer.include.extra_emails).toEqual({
      where: { receives_emails: true },
      select: { email: true },
    });
  });
});
