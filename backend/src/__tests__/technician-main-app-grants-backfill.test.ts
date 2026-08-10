/**
 * Spec A (retire the technician view) — main-app grants backfill migration.
 *
 * Pins the backfill migration to defaultGrants.ts, mirroring
 * permissions-technician-pricebook-backfill.test.ts: the canonical grant set is the code, the
 * SQL must mirror it row-for-row so existing orgs' technicians receive the same grants a
 * freshly-created org gets automatically.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { DEFAULT_GRANTS } from '../lib/permissions/defaultGrants';

describe('technician main-app grants backfill migration', () => {
  const MIGRATION = join(
    __dirname,
    '../../prisma/migrations/20260721000000_technician_main_app_grants/migration.sql',
  );
  const sql = readFileSync(MIGRATION, 'utf8');

  it('inserts across every org (FROM organizations + CROSS JOIN VALUES)', () => {
    expect(sql).toMatch(/FROM organizations/i);
    expect(sql).toMatch(/CROSS JOIN \(VALUES/i);
  });

  it('uses the idempotent ON CONFLICT DO NOTHING guard', () => {
    expect(sql).toContain('ON CONFLICT (organization_id, role, action, subject) DO NOTHING');
  });

  it('mirrors defaultGrants: update/start/arrive Job are own-scoped (OWN_JOB)', () => {
    const OWN_JOB_JSON = '{"assignees":{"some":{"user_id":"{{userId}}"}}}';
    for (const action of ['update', 'start', 'arrive', 'complete']) {
      const grant = DEFAULT_GRANTS.find((g) => g.role === 'TECHNICIAN' && g.action === action && g.subject === 'Job');
      expect(grant, `defaultGrants.ts is missing TECHNICIAN ${action} Job`).toBeDefined();
      expect((grant as { conditions?: unknown }).conditions).toEqual({
        assignees: { some: { user_id: '{{userId}}' } },
      });
      const row = `('TECHNICIAN','${action}','Job','${OWN_JOB_JSON}')`;
      expect(sql, `missing migration row: ${row}`).toContain(row);
    }
  });

  it('mirrors defaultGrants: read User is unconditional', () => {
    const grant = DEFAULT_GRANTS.find((g) => g.role === 'TECHNICIAN' && g.action === 'read' && g.subject === 'User');
    expect(grant, 'defaultGrants.ts is missing TECHNICIAN read User').toBeDefined();
    expect((grant as { conditions?: unknown }).conditions).toBeUndefined();
    expect(sql).toContain("('TECHNICIAN','read','User',NULL)");
  });

  it('does NOT re-insert the PriceBook row — that migration already shipped', () => {
    expect(sql).not.toContain("'PriceBook'");
  });
});
