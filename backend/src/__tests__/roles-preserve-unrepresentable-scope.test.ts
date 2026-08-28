/**
 * The Roles editor must not be able to WIDEN a grant it cannot express.
 *
 * Found while landing PR 3 of the technician-ownership spec, and it is the sharpest edge in that
 * change. The Roles UI models row scope as a single four-way chip per subject - All / Owned / Team /
 * Location - and `viewModelToGrants` stamps the chosen chip's condition onto read, update AND delete
 * for that subject on every Save. That is lossless only while every persisted condition is one of
 * the four. PR 3 persists two that are not:
 *
 *   read Job    { OR: [ own-job, created-by-me ] }   - assigned OR created
 *   delete Job  { created_by_id }                    - creator only
 *
 * Left alone, `assembleRoleViewModel` matches neither against its chip table, reports the Jobs scope
 * as "All", and the next Save an admin performs for ANY unrelated reason - ticking a Vendors box -
 * posts that back and rewrites both rows to `conditions: null`. Every technician in the org would
 * then read, edit and DELETE every job in it. One click, no warning, nothing on screen that said so.
 *
 * Two independent fixes, both asserted here, because either alone leaves a hole:
 *   1. the chip must read "Owned" for the widened Job read, so the UI stops lying about the scope;
 *   2. a Save must PRESERVE any existing condition the editor cannot represent, so even a stale tab
 *      or a hand-rolled PUT cannot clobber it.
 *
 * Fix 2 is the load-bearing one: it is a property of the writer, so it holds for conditions that do
 * not exist yet as well as these two.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import app from '../app';
import { Prisma } from '@prisma/client';
import { prisma } from '../lib/prisma';
import { mockAuthAs, authHeader } from './helpers';
import { assembleRoleViewModel, viewModelToGrants } from '../lib/permissions/roleViewModel';
import { DEFAULT_GRANTS } from '../lib/permissions/defaultGrants';

const OWN_JOB = { visits: { some: { assignees: { some: { user_id: '{{userId}}' } } } } };
const CREATED_BY_ME = { created_by_id: '{{userId}}' };
const OWN_OR_CREATED = { OR: [OWN_JOB, CREATED_BY_ME] };

/** The technician grants exactly as PR 3 ships them. */
const TECHNICIAN_GRANTS = DEFAULT_GRANTS.filter((g) => g.role === 'TECHNICIAN').map(
  ({ action, subject, conditions }) => ({ action, subject, conditions: conditions ?? null }),
);

describe('the Jobs scope chip tells the truth about a creator-widened read', () => {
  it('reads "Owned" for assigned-OR-created, not "All"', () => {
    const vm = assembleRoleViewModel('TECHNICIAN', TECHNICIAN_GRANTS);
    expect(vm.scope.Job).toBe('Owned');
  });

  it('still reads "Owned" for the plain own-job shape (every other role, and pre-backfill orgs)', () => {
    const vm = assembleRoleViewModel('DISPATCHER', [
      { action: 'read', subject: 'Job', conditions: OWN_JOB },
    ]);
    expect(vm.scope.Job).toBe('Owned');
  });

  it('still reads "All" for a genuinely unconditioned read', () => {
    const vm = assembleRoleViewModel('DISPATCHER', [
      { action: 'read', subject: 'Job', conditions: null },
    ]);
    expect(vm.scope.Job).toBe('All');
  });
});

describe('PUT /api/roles/:role/permissions preserves a condition the editor cannot express', () => {
  let upsert: ReturnType<typeof vi.fn>;

  /** Save the role's own round-tripped view model - the no-op an admin performs constantly. */
  async function saveRoundTrip(existing: { action: string; subject: string; conditions: unknown }[]) {
    (prisma.rolePermission.findMany as never as ReturnType<typeof vi.fn>).mockResolvedValue(existing);
    const vm = assembleRoleViewModel('TECHNICIAN', existing as never);
    return request(app).put('/api/roles/TECHNICIAN/permissions').set(authHeader('admin')).send(vm);
  }

  /** The conditions the transaction was asked to write for one (action, subject). */
  function written(action: string, subject: string) {
    const call = upsert.mock.calls.find(
      ([args]) =>
        args.where.organization_id_role_action_subject.action === action &&
        args.where.organization_id_role_action_subject.subject === subject,
    );
    expect(call, `no upsert for ${action} ${subject}`).toBeDefined();
    return call![0].update.conditions;
  }

  beforeEach(() => {
    vi.clearAllMocks();
    mockAuthAs('admin');
    upsert = vi.fn().mockResolvedValue({});
    (prisma.$transaction as never as ReturnType<typeof vi.fn>).mockImplementation((fn: never) =>
      (fn as unknown as (tx: unknown) => unknown)({
        rolePermission: { deleteMany: vi.fn().mockResolvedValue({ count: 0 }), upsert },
      }),
    );
  });

  it('leaves the creator-widened read Job condition exactly as it found it', async () => {
    const res = await saveRoundTrip(TECHNICIAN_GRANTS);
    expect(res.status).toBe(200);
    expect(written('read', 'Job')).toEqual(OWN_OR_CREATED);
  });

  it('leaves the creator-only delete Job condition exactly as it found it', async () => {
    const res = await saveRoundTrip(TECHNICIAN_GRANTS);
    expect(res.status).toBe(200);
    // The chip says "Owned", so an unprotected Save would stamp OWN_JOB here and hand every
    // ASSIGNED technician the ability to delete the job.
    expect(written('delete', 'Job')).toEqual(CREATED_BY_ME);
  });

  // PRESERVATION MUST NOT BECOME UNREVOKABLE. Both role.controller.ts and roleViewModel.ts assert in
  // comments that unticking the box still deletes the row - the preservation only touches the UPSERT
  // path, never the toDelete pass. Nothing tested it, and if it ever leaked across, an admin would
  // silently lose the only way to take a creator-scoped grant away.
  it('still DELETES an unrepresentable-condition grant when the admin unticks the box', async () => {
    const deleteMany = vi.fn().mockResolvedValue({ count: 1 });
    (prisma.$transaction as never as ReturnType<typeof vi.fn>).mockImplementation((fn: never) =>
      (fn as unknown as (tx: unknown) => unknown)({ rolePermission: { deleteMany, upsert } }),
    );
    (prisma.rolePermission.findMany as never as ReturnType<typeof vi.fn>).mockResolvedValue(TECHNICIAN_GRANTS);

    const vm = assembleRoleViewModel('TECHNICIAN', TECHNICIAN_GRANTS as never);
    vm.matrix.Job = { ...vm.matrix.Job!, delete: false };  // the admin unticks Jobs > Delete
    const res = await request(app).put('/api/roles/TECHNICIAN/permissions').set(authHeader('admin')).send(vm);

    expect(res.status).toBe(200);
    const removed = deleteMany.mock.calls.flatMap(([args]) => args.where.OR ?? []);
    expect(removed).toContainEqual({ action: 'delete', subject: 'Job' });
    // ...and it is genuinely gone, not re-upserted by the preservation pass on the way out.
    const reWritten = upsert.mock.calls.some(
      ([args]) =>
        args.where.organization_id_role_action_subject.action === 'delete' &&
        args.where.organization_id_role_action_subject.subject === 'Job',
    );
    expect(reWritten).toBe(false);
  });

  it('still WRITES the chip condition onto a row whose existing condition IS representable', async () => {
    // The preservation must not become "never change anything" - narrowing a role's data scope in
    // the UI has to keep working. Same role, but with the stock own-job read a pre-backfill org has.
    const existing = TECHNICIAN_GRANTS.map((g) =>
      g.action === 'read' && g.subject === 'Job' ? { ...g, conditions: OWN_JOB } : g,
    );
    (prisma.rolePermission.findMany as never as ReturnType<typeof vi.fn>).mockResolvedValue(existing);
    const vm = assembleRoleViewModel('TECHNICIAN', existing as never);
    vm.scope.Job = 'All';
    const res = await request(app).put('/api/roles/TECHNICIAN/permissions').set(authHeader('admin')).send(vm);
    expect(res.status).toBe(200);
    // Prisma.JsonNull is how a null condition is written through the client.
    expect(written('read', 'Job')).toBe(Prisma.JsonNull);
  });
});

describe('viewModelToGrants is unchanged - the preservation lives in the writer', () => {
  // Stated as a test so nobody "fixes" this by teaching the emitter a fifth chip value. The emitter
  // can only ever speak the four the UI has; the writer is what knows about the rest.
  it('still emits the chip condition for Job, not the creator-widened one', () => {
    const grants = viewModelToGrants({
      role: 'TECHNICIAN',
      matrix: { Job: { read: true, create: false, update: true, delete: true } },
      sensitive: { seeFinancials: false, managePayments: false, viewReports: false },
      scope: { Job: 'Owned' },
      general: { description: '' },
    } as never);
    const read = grants.find((g) => g.action === 'read' && g.subject === 'Job');
    expect(read?.conditions).toEqual(OWN_JOB);
  });
});
