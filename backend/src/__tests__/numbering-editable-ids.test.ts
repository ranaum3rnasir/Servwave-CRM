import { describe, it, expect, beforeEach, beforeAll, vi } from 'vitest';
import type { Mock } from 'vitest';
import { prisma } from '../lib/prisma';
import { logger } from '../lib/logger';
import { ALPHA_ORG_ID } from './helpers';
import { maxNumberForTx } from '../controllers/organization.controller';

// Bypass the global numbering mock from setup.ts so these tests use the REAL allocator,
// same style as numbering.test.ts.
let allocateNumber: (typeof import('../lib/numbering'))['allocateNumber'];
beforeAll(async () => {
  const real = await vi.importActual<typeof import('../lib/numbering')>('../lib/numbering');
  allocateNumber = real.allocateNumber;
});

beforeEach(() => {
  vi.clearAllMocks();
});

describe('allocateNumber — editable/custom-number skip path (in-scope entities)', () => {
  it('fast path: counter-derived candidate is already free — one extra query, unchanged number', async () => {
    (prisma.$queryRaw as Mock)
      // Self-heal UPDATE ... RETURNING: next_value=43 means allocated candidate is 42.
      .mockResolvedValueOnce([{ next_value: 43, prefix: 'J', padding: 5 }])
      // Fast-path generate_series query: candidate 42 is free, so free_n === candidate.
      .mockResolvedValueOnce([{ free_n: 42 }]);

    const result = await allocateNumber(prisma, 'job', ALPHA_ORG_ID);

    expect(result).toBe('J00042');
    expect(prisma.$queryRaw).toHaveBeenCalledTimes(2);
  });

  it('fast path: candidate collides with a custom row — skips to the next free number', async () => {
    (prisma.$queryRaw as Mock)
      // Self-heal: candidate is 42.
      .mockResolvedValueOnce([{ next_value: 43, prefix: 'J', padding: 5 }])
      // Fast-path: 42 is taken (a custom row), 43 is free.
      .mockResolvedValueOnce([{ free_n: 43 }]);

    const result = await allocateNumber(prisma, 'job', ALPHA_ORG_ID);

    expect(result).toBe('J00043');
    expect(prisma.$queryRaw).toHaveBeenCalledTimes(2);
  });

  it('fallback engages when the whole fast-path window is exhausted (free_n null)', async () => {
    (prisma.$queryRaw as Mock)
      // Self-heal: candidate is 42.
      .mockResolvedValueOnce([{ next_value: 43, prefix: 'J', padding: 5 }])
      // Fast-path: entire SKIP_WINDOW is taken.
      .mockResolvedValueOnce([{ free_n: null }])
      // Fallback: full-table scan finds the true next-free value.
      .mockResolvedValueOnce([{ next_free: 1050 }]);

    const result = await allocateNumber(prisma, 'job', ALPHA_ORG_ID);

    expect(result).toBe('J01050');
    expect(prisma.$queryRaw).toHaveBeenCalledTimes(3);
    expect(logger.warn).toHaveBeenCalledTimes(1);
  });
});

describe('allocateNumber — out-of-scope entities are byte-identical to today (regression guard)', () => {
  // logistic_order and service_plan have NO number_is_custom column — referencing it in SQL
  // would be a Postgres error. Proving exactly ONE $queryRaw call (the self-heal UPDATE, same
  // as before this change) is the critical guard that these entities' create path is
  // untouched: any accidental widening of the skip path to them would show up here as a
  // second call.
  it('logistic_order: exactly one $queryRaw call (self-heal only), unchanged', async () => {
    (prisma.$queryRaw as Mock).mockResolvedValueOnce([{ next_value: 4, prefix: 'LO', padding: 5 }]);

    const result = await allocateNumber(prisma, 'logistic_order', ALPHA_ORG_ID);

    expect(result).toBe('LO00003');
    expect(prisma.$queryRaw).toHaveBeenCalledTimes(1);
  });

  it('service_plan: exactly one $queryRaw call (self-heal only), unchanged', async () => {
    (prisma.$queryRaw as Mock).mockResolvedValueOnce([{ next_value: 8, prefix: 'SP', padding: 5 }]);

    const result = await allocateNumber(prisma, 'service_plan', ALPHA_ORG_ID);

    expect(result).toBe('SP00007');
    expect(prisma.$queryRaw).toHaveBeenCalledTimes(1);
  });
});

describe('maxNumberForTx — excludeCustom parameter', () => {
  // $queryRaw's resolved value is mocked either way, so a black-box unit test cannot observe
  // the SQL text change from passing excludeCustom — that predicate's correctness is verified
  // by manual review, plus the pattern numbering.integration.test.ts already established
  // against a real DB for the rest of this file's SQL. TODO: extend
  // numbering.integration.test.ts to cover excludeCustom once the number_is_custom migration
  // PR is live against the real staging DB — it cannot be done in THIS PR (see file header).
  // These tests instead just prove the added parameter doesn't throw and both branches return
  // the mocked max, for both a default/omitted call and an explicit excludeCustom=true call.
  it('excludeCustom omitted (defaults false) does not throw and returns the mocked max', async () => {
    const tx = { $queryRaw: vi.fn().mockResolvedValue([{ max_num: 41 }]) } as never;
    const result = await maxNumberForTx(tx, 'jobs', 'job_number', ALPHA_ORG_ID);
    expect(result).toBe(41);
  });

  it('excludeCustom=true does not throw and returns the mocked max', async () => {
    const tx = { $queryRaw: vi.fn().mockResolvedValue([{ max_num: 41 }]) } as never;
    const result = await maxNumberForTx(tx, 'jobs', 'job_number', ALPHA_ORG_ID, true);
    expect(result).toBe(41);
  });
});

describe('allocateNumber — 9-digit numeric-length regression anchor', () => {
  // $queryRaw is mocked, so we cannot literally exercise Postgres' ::int cast (max
  // 2147483647) here. This is a regression ANCHOR proving a 9-digit value flows through
  // allocateNumber's own arithmetic/formatting cleanly (no exception, correct 9-digit
  // output) when self-heal/fast-path results simulate one — not a proof that Postgres
  // itself never overflows. The actual Postgres-side overflow guarantee is twofold: (1)
  // excluding custom rows from the self-heal/fallback casts, per the doc comment on
  // allocateNumber above, and (2) a 9-digit Zod cap on custom numeric ids at the API
  // validation layer, which ships in a LATER PR and is out of scope for this file.
  it('a 9-digit trailing value flows through self-heal + fast-path without throwing', async () => {
    (prisma.$queryRaw as Mock)
      // Self-heal: counter-derived candidate is 999999999 (9 digits).
      .mockResolvedValueOnce([{ next_value: 1000000000, prefix: 'J', padding: 5 }])
      // Fast-path: that exact candidate is free.
      .mockResolvedValueOnce([{ free_n: 999999999 }]);

    const result = await allocateNumber(prisma, 'job', ALPHA_ORG_ID);

    expect(result).toBe('J999999999');
    expect(prisma.$queryRaw).toHaveBeenCalledTimes(2);
  });
});
