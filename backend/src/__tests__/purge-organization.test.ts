import { describe, it, expect, vi } from 'vitest';

vi.mock('../lib/prisma', () => ({ prisma: {} }));

import { purgeOrganization } from '../lib/purge';

const ORG = 'org1';

/**
 * The workflow + copilot models added for #869, plus calendarEntry (Slice 02, same defect
 * class). All of these carry `organization_id` but have NO relation to Organization, so
 * nothing at the DB level cleans them up - a successful purge used to leave every row behind,
 * orphaned and unreachable (RLS ENABLE+FORCE makes an orphan invisible to the app connection,
 * so not even the tenant-scoped delete route can reach it).
 *
 * calendarEntryParticipant is deliberately NOT in this list: its FK to calendar_entries is a
 * REQUIRED `onDelete: Cascade` relation, so it needs no deleteMany of its own - purge-tenant-
 * coverage.test.ts's cascade closure covers it once calendarEntry is deleted here.
 */
const ORPHAN_MODELS = [
  'workflowStepRun',
  'workflowEnrollment',
  'workflowVersion',
  'workflowStep',
  'workflow',
  'copilotMessage',
  'copilotConversation',
  'copilotAuditEvent',
  'calendarEntry',
] as const;

function fakeTx(orgName: string) {
  const calls: string[] = [];
  const args = new Map<string, any>();
  const del = (n: string) => vi.fn(async (a?: any) => { calls.push(n); args.set(n, a); return { count: 0 }; });
  const tx: any = {
    organization: {
      findUnique: vi.fn(async () => ({ id: ORG, name: orgName })),
      delete: del('organization.delete'),
    },
    customer: { findMany: vi.fn(async () => []), deleteMany: del('customer') },
    userTablePreference: { deleteMany: del('userTablePreference') },
    appSetting: { deleteMany: del('appSetting') },
    rolePermission: { deleteMany: del('rolePermission') },
    tagAssignment: { deleteMany: del('tagAssignment') },
    tag: { deleteMany: del('tag') },
    attachment: { deleteMany: del('attachment') },
    note: { deleteMany: del('note') },
    timelineEvent: { deleteMany: del('timelineEvent') },
    priceBookItem: { deleteMany: del('priceBookItem') },
    priceBookCategory: { deleteMany: del('priceBookCategory') },
    finish: { deleteMany: del('finish') },
    uomOption: { deleteMany: del('uomOption') },
    // Email slice 6 - its org FK is ON DELETE RESTRICT, so a leftover row does
    // not merely orphan: it makes the Organization delete itself fail.
    replyToken: { deleteMany: del('replyToken') },
    // Email slice 8b - HAS a real FK to organizations (unlike ORPHAN_MODELS
    // below), but nothing cascades INTO it, so it still needs its own delete.
    emailThread: { deleteMany: del('emailThread') },
    user: { deleteMany: del('user') },
    department: { deleteMany: del('department') },
    location: { deleteMany: del('location') },
  };
  for (const m of ORPHAN_MODELS) tx[m] = { deleteMany: del(m) };
  return { calls, args, tx };
}

describe('purgeOrganization', () => {
  it('refuses when the org name does not match the guard prefix', async () => {
    const { tx } = fakeTx('Lakeside Mechanical'); // the real demo org
    await expect(purgeOrganization(tx, ORG, 'e2e-qa-')).rejects.toThrow(/Refusing to purge/);
  });

  it('purges users + departments before the organization row', async () => {
    const { tx, calls } = fakeTx('e2e-qa-abc123');
    await purgeOrganization(tx, ORG, 'e2e-qa-');
    expect(calls).toContain('user');
    expect(calls).toContain('department');
    expect(calls.indexOf('user')).toBeLessThan(calls.indexOf('organization.delete'));
    expect(calls.indexOf('department')).toBeLessThan(calls.indexOf('organization.delete'));
  });

  it('deletes reply tokens before the organization row (email slice 6)', async () => {
    // reply_tokens_organization_id_fkey is ON DELETE RESTRICT, so this is not a
    // tidiness question: a surviving token makes the Organization delete throw
    // and rolls the entire purge back.
    const { tx, calls } = fakeTx('e2e-qa-abc123');
    await purgeOrganization(tx, ORG, 'e2e-qa-');
    expect(calls).toContain('replyToken');
    expect(calls.indexOf('replyToken')).toBeLessThan(calls.indexOf('organization.delete'));
  });

  // ─── #869: workflow + copilot teardown ─────────────────────────────────────
  describe('orphan-prone tables with no FK to organizations (#869)', () => {
    for (const model of ORPHAN_MODELS) {
      it(`deletes ${model} before the organization row`, async () => {
        const { tx, calls } = fakeTx('e2e-qa-abc123');
        await purgeOrganization(tx, ORG, 'e2e-qa-');
        expect(calls).toContain(model);
        expect(calls.indexOf(model)).toBeLessThan(calls.indexOf('organization.delete'));
      });
    }

    it('tears the workflow graph down child-first', async () => {
      const { tx, calls } = fakeTx('e2e-qa-abc123');
      await purgeOrganization(tx, ORG, 'e2e-qa-');
      const at = (n: string) => calls.indexOf(n);
      // Matches deleteWorkflow (workflow.controller.ts) and reseed-builtin-keys.ts.
      expect(at('workflowStepRun')).toBeLessThan(at('workflowEnrollment'));
      expect(at('workflowVersion')).toBeLessThan(at('workflowStep'));
      expect(at('workflowStep')).toBeLessThan(at('workflow'));
    });

    it('deletes enrollments BEFORE versions (workflow_enrollments_workflow_version_id_fkey is RESTRICT)', async () => {
      // This one edge is load-bearing, not cosmetic: that FK is ON DELETE RESTRICT, which
      // Postgres checks immediately and cannot defer. Versions-before-enrollments throws.
      const { tx, calls } = fakeTx('e2e-qa-abc123');
      await purgeOrganization(tx, ORG, 'e2e-qa-');
      expect(calls.indexOf('workflowEnrollment')).toBeLessThan(calls.indexOf('workflowVersion'));
    });

    it('deletes copilot messages before their conversations', async () => {
      const { tx, calls } = fakeTx('e2e-qa-abc123');
      await purgeOrganization(tx, ORG, 'e2e-qa-');
      expect(calls.indexOf('copilotMessage')).toBeLessThan(calls.indexOf('copilotConversation'));
    });

    it('scopes every new delete to the organization', async () => {
      // A purge that forgets tenant scope is far worse than one that forgets the table: an
      // unscoped deleteMany on these models would wipe every org's automations and copilot
      // history. Asserted on the actual argument, not just on call order.
      const { tx, args } = fakeTx('e2e-qa-abc123');
      await purgeOrganization(tx, ORG, 'e2e-qa-');
      for (const model of ORPHAN_MODELS) {
        expect(args.get(model), `${model} delete argument`).toEqual({ where: { organization_id: ORG } });
      }
    });

    it('does not touch them at all when the name guard rejects', async () => {
      const { tx, calls } = fakeTx('Lakeside Mechanical');
      await expect(purgeOrganization(tx, ORG, 'e2e-qa-')).rejects.toThrow(/Refusing to purge/);
      expect(calls).toEqual([]);
    });
  });
});
