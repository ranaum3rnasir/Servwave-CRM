/**
 * Real-DB concurrent allocator integration test.
 *
 * The 11 unit tests in `numbering.test.ts` mock `$queryRaw` — they verify the
 * controller logic but cannot prove that Postgres actually serializes
 * concurrent UPDATEs against the same org row. This file fills that gap.
 *
 * Skipped by default. To run:
 *   1. Point DATABASE_URL at a non-production Postgres with the migrations applied
 *   2. `RUN_INTEGRATION_TESTS=1 npx vitest run src/__tests__/numbering.integration.test.ts`
 *
 * The test seeds two throw-away orgs, runs 50 concurrent allocations against
 * each, and asserts every returned number is unique and contiguous (1..50).
 * Cleanup is in afterAll; if the run is killed mid-flight, the orgs are left
 * behind for inspection — re-running the test cleans them.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import dotenv from 'dotenv';

// Vitest doesn't auto-load .env (unlike Prisma's CLI). Load it here so the
// skipIf gate below can read DATABASE_URL.
dotenv.config();

// Skip unless explicitly opted-in. Setting RUN_INTEGRATION_TESTS=1 + a real
// DATABASE_URL (env, not the mocked test one) is required.
const enabled =
  process.env.RUN_INTEGRATION_TESTS === '1' &&
  typeof process.env.DATABASE_URL === 'string' &&
  !process.env.DATABASE_URL.includes('test:test@localhost');

// A silently skipped guard is worse than no guard. When a run explicitly asks for the
// integration tests (CI does), refuse to skip quietly - fail and name the reason.
describe.skipIf(process.env.RUN_INTEGRATION_TESTS !== '1')('integration opt-in', () => {
  it('has a real DATABASE_URL to run against', () => {
    expect(enabled).toBe(true);
  });
});

describe.skipIf(!enabled)('allocateNumber — real-DB concurrent atomicity', () => {
  // Dynamic imports so this file does NOT pull in PrismaClient when skipped
  // (avoids generated-client side effects in normal unit-test runs).
  let prisma: any;
  let allocateNumber: any;
  // Deterministic UUIDs so a killed run can still clean up leftover rows on re-run.
  const ORG_A = '00000000-0000-0000-0000-0000000000a1';
  const ORG_B = '00000000-0000-0000-0000-0000000000b1';

  beforeAll(async () => {
    const prismaPkg = await import('@prisma/client');
    // vi.importActual bypasses the global mock at setup.ts so we hit the real allocator,
    // not the no-op test stub. Without this, the integration test would silently pass
    // by executing the mocked function instead of the real Postgres allocator.
    const numberingMod = await vi.importActual<typeof import('../lib/numbering')>('../lib/numbering');
    prisma = new prismaPkg.PrismaClient();
    allocateNumber = numberingMod.allocateNumber;

    // Pre-clean in case a prior run aborted before afterAll. Customers first: a test that
    // dies mid-flight leaves its rows behind, and organization.deleteMany then trips the
    // customers_organization_id_fkey instead of cleaning up.
    await prisma.customer.deleteMany({ where: { organization_id: { in: [ORG_A, ORG_B] } } });
    await prisma.organization.deleteMany({ where: { id: { in: [ORG_A, ORG_B] } } });

    // Seed two throw-away orgs. Use minimal fields; rely on Prisma defaults.
    await prisma.organization.createMany({
      data: [
        {
          id: ORG_A,
          plan: 'SCALE',
          name: 'Integration Org A',
          address_line1: '1 Test St',
          city: 'Testville',
          state: 'NY',
          postal_code: '00001',
          email: 'a@test.invalid',
          estimate_terms: '',
          estimate_notes: '',
          estimate_payment_terms: '',
        },
        {
          id: ORG_B,
          plan: 'SCALE',
          name: 'Integration Org B',
          address_line1: '2 Test St',
          city: 'Testville',
          state: 'NY',
          postal_code: '00001',
          email: 'b@test.invalid',
          estimate_terms: '',
          estimate_notes: '',
          estimate_payment_terms: '',
        },
      ],
    });
  });

  afterAll(async () => {
    if (!prisma) return;
    await prisma.customer.deleteMany({ where: { organization_id: { in: [ORG_A, ORG_B] } } });
    await prisma.organization.deleteMany({ where: { id: { in: [ORG_A, ORG_B] } } });
    await prisma.$disconnect();
  });

  it('50 parallel allocations against the same org produce 50 unique sequential numbers', async () => {
    const promises = Array.from({ length: 50 }, () =>
      allocateNumber(prisma, 'lead', ORG_A),
    );
    const results = await Promise.all(promises);

    expect(new Set(results).size).toBe(50);

    // Parse trailing digits, sort, assert contiguous starting from the lowest.
    const numbers = results.map((s: string) => Number(s.replace(/^[A-Za-z-]+/, ''))).sort((a, b) => a - b);
    for (let i = 1; i < numbers.length; i++) {
      expect(numbers[i]).toBe(numbers[i - 1] + 1);
    }
  });

  it('25 + 25 parallel across two orgs produce independent sequential counters', async () => {
    const promises = [
      ...Array.from({ length: 25 }, () => allocateNumber(prisma, 'estimate', ORG_A)),
      ...Array.from({ length: 25 }, () => allocateNumber(prisma, 'estimate', ORG_B)),
    ];
    const results = await Promise.all(promises);

    // Each org's set is internally unique and contiguous.
    const orgA = results.slice(0, 25).map((s: string) => Number(s.replace(/^[A-Za-z-]+/, '')));
    const orgB = results.slice(25).map((s: string) => Number(s.replace(/^[A-Za-z-]+/, '')));

    expect(new Set(orgA).size).toBe(25);
    expect(new Set(orgB).size).toBe(25);

    orgA.sort((a: number, b: number) => a - b);
    orgB.sort((a: number, b: number) => a - b);
    for (let i = 1; i < 25; i++) {
      expect(orgA[i]).toBe(orgA[i - 1] + 1);
      expect(orgB[i]).toBe(orgB[i - 1] + 1);
    }
  });

  it('counter rolls back when the wrapping transaction throws', async () => {
    const before = await prisma.organization.findUnique({
      where: { id: ORG_A },
      select: { job_next_number: true },
    });

    await expect(
      prisma.$transaction(async (tx: any) => {
        await allocateNumber(tx, 'job', ORG_A);
        throw new Error('simulated entity-insert failure');
      }),
    ).rejects.toThrow(/simulated/);

    const after = await prisma.organization.findUnique({
      where: { id: ORG_A },
      select: { job_next_number: true },
    });

    // Counter must NOT have advanced.
    expect(after.job_next_number).toBe(before.job_next_number);
  });

  it('self-heals a counter that has drifted behind reality (no duplicate number)', async () => {
    // Simulate the shared-staging-DB drift that caused the schedule-visit 500: a row already
    // exists at suffix 5, but the org's customer counter has fallen behind it (rows inserted by
    // another branch without bumping it). The old allocator would re-issue 1..5 → unique-violation
    // 500 on insert. The self-heal must instead advance to max(existing)+1.
    await prisma.customer.create({
      data: {
        organization_id: ORG_A,
        customer_number: 'C00005',
        kind: 'PERSON',
        segment: 'RESIDENTIAL',
        email: 'drift@test.invalid',
        phone: '+15555550005',
      },
    });
    await prisma.organization.update({
      where: { id: ORG_A },
      data: { customer_next_number: 1 }, // stale — behind the existing C00005
    });

    const next = await allocateNumber(prisma, 'customer', ORG_A);
    expect(Number(next.replace(/^[A-Za-z-]+/, ''))).toBe(6); // max(5)+1, not the stale 1

    await prisma.customer.deleteMany({ where: { organization_id: ORG_A } });
  });

  // ---------------------------------------------------------------------------
  // Custom numbers (the editable-record-ids allocator work). Both cases below
  // execute the tier-1 skip statement, which a mocked $queryRaw never plans — the
  // `lpad(text, bigint, ...)` 42883 that broke every create in the org was
  // invisible to the unit suite and visible here on the first run.
  // ---------------------------------------------------------------------------

  it('steps over a hand-typed number sitting exactly where the counter lands', async () => {
    // C00007 is taken by hand; the counter is about to hand out 7. Colliding here is the
    // unique-violation 500 this path exists to prevent.
    await prisma.customer.create({
      data: {
        organization_id: ORG_A,
        customer_number: 'C00007',
        number_is_custom: true,
        kind: 'PERSON',
        segment: 'RESIDENTIAL',
        email: 'taken@test.invalid',
        phone: '+15555550007',
      },
    });
    await prisma.organization.update({
      where: { id: ORG_A },
      data: { customer_next_number: 7 },
    });

    const next = await allocateNumber(prisma, 'customer', ORG_A);
    expect(next).toBe('C00008');

    await prisma.customer.deleteMany({ where: { organization_id: ORG_A } });
  });

  it('does not drag the series up to a hand-typed number far above the counter', async () => {
    // The Workiz-import shape: one hand-typed id in the 500s must not catapult the whole
    // org's automatic series into that range.
    await prisma.customer.create({
      data: {
        organization_id: ORG_A,
        customer_number: 'C00500',
        number_is_custom: true,
        kind: 'PERSON',
        segment: 'RESIDENTIAL',
        email: 'workiz@test.invalid',
        phone: '+15555550500',
      },
    });
    await prisma.organization.update({
      where: { id: ORG_A },
      data: { customer_next_number: 3 },
    });

    const next = await allocateNumber(prisma, 'customer', ORG_A);
    expect(next).toBe('C00003');

    const org = await prisma.organization.findUnique({
      where: { id: ORG_A },
      select: { customer_next_number: true },
    });
    // The counter self-healed off non-custom rows only — it never saw the 500.
    expect(org.customer_next_number).toBe(4);

    await prisma.customer.deleteMany({ where: { organization_id: ORG_A } });
  });
});

describe.skipIf(!enabled)('maxNumberForTx — mixed-format orgs do not crash the collision guard', () => {
  // Regression for the Workiz-import "can't save numbering" 500: an org whose rows MIX
  // bare-numeric (imported) and prefixed (native, e.g. L00005) numbers used to crash the
  // settings collision guard's CAST(SUBSTRING(<col> FROM <prefixLen+1>) AS INTEGER) with
  // Postgres 22P02 ("invalid input syntax for type integer: L00005"), aborting the whole
  // save as an opaque 500. The trailing-digit regex must instead return the true max across
  // BOTH formats without throwing. (See organization.controller.ts maxNumberForTx.)
  let prisma: any;
  let maxNumberForTx: any;
  const ORG_MIX = '00000000-0000-0000-0000-0000000000c1';

  beforeAll(async () => {
    const prismaPkg = await import('@prisma/client');
    prisma = new prismaPkg.PrismaClient();
    // importActual bypasses any global controller mock so we exercise the real SQL helper.
    const orgMod = await vi.importActual<typeof import('../controllers/organization.controller')>(
      '../controllers/organization.controller',
    );
    maxNumberForTx = orgMod.maxNumberForTx;

    // Pre-clean (child rows before parents for FKs), then reseed.
    await prisma.lead.deleteMany({ where: { organization_id: ORG_MIX } });
    await prisma.customer.deleteMany({ where: { organization_id: ORG_MIX } });
    await prisma.organization.deleteMany({ where: { id: ORG_MIX } });

    await prisma.organization.create({
      data: {
        id: ORG_MIX,
        plan: 'SCALE',
        name: 'Mixed-format Import Org',
        address_line1: '3 Test St', city: 'Testville', state: 'NY', postal_code: '00001',
        email: 'mix@test.invalid',
        estimate_terms: '', estimate_notes: '', estimate_payment_terms: '',
        lead_prefix: '', // blanked after a Workiz import that continues bare-numeric IDs
      },
    });
    const cust = await prisma.customer.create({
      data: {
        organization_id: ORG_MIX, customer_number: 'C00001', kind: 'PERSON',
        segment: 'RESIDENTIAL', email: 'mixcust@test.invalid', phone: '+15555559001',
      },
    });
    // Native prefixed row + bare-numeric imported row in the SAME table.
    await prisma.lead.create({ data: { organization_id: ORG_MIX, customer_id: cust.id, service_request: 'x', lead_number: 'L00005' } });
    await prisma.lead.create({ data: { organization_id: ORG_MIX, customer_id: cust.id, service_request: 'x', lead_number: '900' } });
  });

  afterAll(async () => {
    if (!prisma) return;
    await prisma.lead.deleteMany({ where: { organization_id: ORG_MIX } });
    await prisma.customer.deleteMany({ where: { organization_id: ORG_MIX } });
    await prisma.organization.deleteMany({ where: { id: ORG_MIX } });
    await prisma.$disconnect();
  });

  it('returns the true max across bare-numeric and prefixed rows without throwing', async () => {
    const max = await maxNumberForTx(prisma, 'leads', 'lead_number', ORG_MIX);
    expect(max).toBe(900); // max(trailing digits: 'L00005'→5, '900'→900)
  });

  it('returns 0 for an entity with no rows', async () => {
    const max = await maxNumberForTx(prisma, 'jobs', 'job_number', ORG_MIX);
    expect(max).toBe(0);
  });
});
