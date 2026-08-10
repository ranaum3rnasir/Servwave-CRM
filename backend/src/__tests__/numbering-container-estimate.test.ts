import { describe, it, expect, vi, beforeAll } from 'vitest';

// The global setup.ts mocks '../lib/numbering'; bypass it so we exercise the REAL allocator
// (numbering-logistic-order.test.ts precedent).
type NumberingModule = typeof import('../lib/numbering');
let numbering: NumberingModule;
beforeAll(async () => {
  numbering = await vi.importActual<NumberingModule>('../lib/numbering');
});

const ORG = '00000000-0000-0000-0000-0000000000f1';
const LEAD = '00000000-0000-0000-0000-0000000000f2';
const CUSTOMER = '00000000-0000-0000-0000-0000000000f3';
const JOB = '00000000-0000-0000-0000-0000000000f4';

/**
 * Capture the SQL a `$queryRaw` tagged-template call renders + its bound params, then return a
 * canned RETURNING row. `Prisma.raw`/`Prisma.empty` fragments carry a `strings` array and are
 * spliced into the text; everything else is a bound param → `$1`, `$2`. This proves what the SQL
 * actually SAYS (e.g. that the organization_id tenant filter is present), not just the formatting.
 */
function captureTx(returning: Array<Record<string, unknown>>) {
  const calls: Array<{ sql: string; params: unknown[] }> = [];
  const tx = {
    $queryRaw: (strings: readonly string[], ...values: unknown[]) => {
      const params: unknown[] = [];
      let sql = strings[0];
      values.forEach((value, i) => {
        if (value && typeof value === 'object' && Array.isArray((value as { strings?: unknown }).strings)) {
          sql += (value as { strings: string[] }).strings.join('');
        } else {
          params.push(value);
          sql += `$${params.length}`;
        }
        sql += strings[i + 1];
      });
      calls.push({ sql: sql.replace(/\s+/g, ' ').trim(), params });
      return Promise.resolve(returning);
    },
  };
  return { tx, calls };
}

describe('allocateContainerEstimateNumber', () => {
  it('formats <container_number>-<seq> from the RETURNING row', async () => {
    const { tx } = captureTx([{ seq: 3, container_number: 'L00005' }]);
    expect(await numbering.allocateContainerEstimateNumber(tx as never, 'lead', LEAD, ORG)).toBe('L00005-3');
  });

  it('emits a TENANT-SCOPED atomic increment on the lead table', async () => {
    const { tx, calls } = captureTx([{ seq: 1, container_number: 'L00005' }]);
    await numbering.allocateContainerEstimateNumber(tx as never, 'lead', LEAD, ORG);
    expect(calls).toHaveLength(1);
    const { sql, params } = calls[0];
    expect(sql).toMatch(/UPDATE leads/);
    expect(sql).toMatch(/SET estimate_seq = estimate_seq \+ 1/);
    // The organization_id predicate is the tenant guard - deleting it MUST fail this test.
    expect(sql).toMatch(/WHERE id = \$1::uuid AND organization_id = \$2::uuid/);
    expect(sql).toMatch(/RETURNING estimate_seq AS seq, lead_number AS container_number/);
    expect(params).toEqual([LEAD, ORG]);
  });

  it('targets customers.customer_number for a customer container', async () => {
    const { tx, calls } = captureTx([{ seq: 10, container_number: 'C00010' }]);
    expect(await numbering.allocateContainerEstimateNumber(tx as never, 'customer', CUSTOMER, ORG)).toBe('C00010-10');
    expect(calls[0].sql).toMatch(/UPDATE customers/);
    expect(calls[0].sql).toMatch(/RETURNING estimate_seq AS seq, customer_number AS container_number/);
  });

  it('targets jobs.job_number for a job container', async () => {
    const { tx, calls } = captureTx([{ seq: 7, container_number: 'J00007' }]);
    expect(await numbering.allocateContainerEstimateNumber(tx as never, 'job', JOB, ORG)).toBe('J00007-7');
    expect(calls[0].sql).toMatch(/UPDATE jobs/);
  });

  it('throws when the container row is missing / not in the org (empty RETURNING)', async () => {
    const { tx } = captureTx([]);
    await expect(
      numbering.allocateContainerEstimateNumber(tx as never, 'lead', LEAD, ORG),
    ).rejects.toThrow(/not found in organization/);
  });
});
