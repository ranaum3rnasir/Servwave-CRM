import { describe, it, expect } from 'vitest';
import { Prisma } from '@prisma/client';
import { applyFreshDomainStatus, type OrganizationDomainRow } from '../lib/organization-domain';

// Security review finding (email slice 10): applyFreshDomainStatus previously
// computed `justVerified` from the ALREADY-READ `row.verified_at`, not from
// whether ITS OWN write actually performed the transition. Two independent
// observers of the same first-verification event (the Resend webhook, inside
// its own transaction, vs. the "Check now" controller, outside any
// transaction) can each read verified_at: null before either commits — both
// then reported justVerified: true and both fired the one-time success email.
// The fix folds `verified_at: null` into the UPDATE's own WHERE, so only the
// write that actually flips the row wins the race.
describe('applyFreshDomainStatus — concurrent first-verification race', () => {
  const BASE_ROW: OrganizationDomainRow = {
    id: 'orgdomain-1',
    organization_id: 'org-1',
    domain_name: 'acmeplumbing.com',
    resend_domain_id: 'dom_1',
    status: 'pending',
    records: [],
    detected_dns_provider: null,
    verified_at: null,
    created_at: new Date('2026-08-01T00:00:00Z'),
    updated_at: new Date('2026-08-01T00:00:00Z'),
  };

  /** A fake `db` double modeling a single Postgres row shared by two racing
   * callers: the second UPDATE attempting the `verified_at: null` guard finds
   * nothing left to match (Postgres serializes the two real UPDATEs; the
   * loser's WHERE simply matches zero rows), so it throws P2025 exactly as
   * the real Prisma client would. */
  function makeSharedRowDb() {
    let verifiedAt: Date | null = null;
    return {
      organizationDomain: {
        update: async ({ where, data }: { where: { id: string; verified_at?: null }; data: Record<string, unknown> }) => {
          if ('verified_at' in where) {
            if (verifiedAt !== null) {
              throw new Prisma.PrismaClientKnownRequestError('An operation failed because it depends on one or more records that were required but not found.', {
                code: 'P2025',
                clientVersion: 'test',
              });
            }
            verifiedAt = data.verified_at as Date;
          }
          return { ...BASE_ROW, ...data, verified_at: verifiedAt };
        },
        findUniqueOrThrow: async () => ({ ...BASE_ROW, status: 'verified', verified_at: verifiedAt }),
      },
    };
  }

  it('only the caller whose UPDATE actually flips verified_at reports justVerified — the loser does not', async () => {
    const db = makeSharedRowDb();

    const winner = await applyFreshDomainStatus(db as never, BASE_ROW, { status: 'verified', records: [] });
    const loser = await applyFreshDomainStatus(db as never, BASE_ROW, { status: 'verified', records: [] });

    expect(winner.justVerified).toBe(true);
    expect(loser.justVerified).toBe(false);
    // The loser still gets back the actually-committed row, not a stale one.
    expect(loser.row.verified_at).toEqual(winner.row.verified_at);
  });

  it('a solo (non-racing) transition still reports justVerified: true as before', async () => {
    const db = makeSharedRowDb();

    const { justVerified, row } = await applyFreshDomainStatus(db as never, BASE_ROW, { status: 'verified', records: [] });

    expect(justVerified).toBe(true);
    expect(row.verified_at).toBeInstanceOf(Date);
  });

  it('a non-transition update (still pending, or already verified) never touches the verified_at guard', async () => {
    const db = makeSharedRowDb();
    const alreadyVerifiedRow = { ...BASE_ROW, status: 'verified', verified_at: new Date('2026-08-01T00:00:00Z') };

    const { justVerified } = await applyFreshDomainStatus(db as never, alreadyVerifiedRow, { status: 'verified', records: [] });

    expect(justVerified).toBe(false);
  });
});
