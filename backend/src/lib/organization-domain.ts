import { Prisma, PrismaClient } from '@prisma/client';
import { prisma } from './prisma';
import { logger } from './logger';
import { sendDomainVerifiedEmail } from './email';

/**
 * Email slice 10 (guided domain verification) — shared logic between the
 * organization-email-domain endpoints (a live resend.domains.get()/.verify()
 * re-fetch) and the Resend webhook (a domain.updated event): whichever path
 * observes a fresh (status, records) pair from Resend FIRST funnels it
 * through here, so the one-time "verified" side effects (stamp verified_at,
 * fire the success email) can only ever happen once no matter which path saw
 * the transition — "Both should work: an explicit Check now button AND the
 * webhook keeping status fresh passively" (the plan's own requirement).
 *
 * That "only ever happen once" guarantee is enforced at the UPDATE itself,
 * not by trusting `row.verified_at` from an earlier read: the webhook (inside
 * its own transaction) and the "Check now" controller (outside any
 * transaction) can both read the same verified_at: null row before either
 * commits, so the transition attempt below folds `verified_at: null` into
 * the update's own WHERE (Prisma's extended-unique-filter support). Postgres
 * serializes the two UPDATEs; whichever runs second finds no row still
 * matching and gets P2025, which this function turns into `justVerified:
 * false` rather than a thrown error — so only the actual winner notifies.
 */

// Accept either the Prisma client or a transaction client — callable inside
// the webhook's existing $transaction as well as standalone from a controller
// (customer-duplicate.ts precedent for this exact union).
type Db = PrismaClient | Prisma.TransactionClient;

export interface OrganizationDomainRow {
  id: string;
  organization_id: string;
  domain_name: string;
  resend_domain_id: string;
  status: string;
  records: Prisma.JsonValue;
  detected_dns_provider: string | null;
  verified_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

export interface FreshDomainStatus {
  status: string;
  records: unknown;
}

/**
 * Persists a fresh (status, records) pair Resend just reported for `row`.
 * Returns the updated row plus whether THIS call is the first-ever transition
 * into verified. Does NOT send the notification itself — the DB write and the
 * email are deliberately separate so a caller running inside a transaction
 * (the webhook) can commit first and notify after, rather than sending mail
 * from inside a transaction that might still roll back.
 */
export async function applyFreshDomainStatus(
  db: Db,
  row: OrganizationDomainRow,
  fresh: FreshDomainStatus,
): Promise<{ row: OrganizationDomainRow; justVerified: boolean }> {
  const attemptingVerifiedTransition = fresh.status === 'verified' && !row.verified_at;

  if (!attemptingVerifiedTransition) {
    const updated = await db.organizationDomain.update({
      where: { id: row.id },
      data: {
        status: fresh.status,
        records: fresh.records as Prisma.InputJsonValue,
      },
    });
    return { row: updated, justVerified: false };
  }

  try {
    // Compare-and-swap: `verified_at: null` in the WHERE means this UPDATE
    // only matches — and only the caller whose UPDATE actually matches
    // notifies — if verified_at is STILL null at write time, not merely when
    // `row` was originally read.
    const updated = await db.organizationDomain.update({
      where: { id: row.id, verified_at: null },
      data: {
        status: fresh.status,
        records: fresh.records as Prisma.InputJsonValue,
        verified_at: new Date(),
      },
    });
    return { row: updated, justVerified: true };
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2025') {
      // Lost the race — some other caller (the webhook, another delivery, or
      // the "Check now" button) already committed the same transition first.
      // Re-read the now-current row and report justVerified: false so this
      // caller does NOT also fire the one-time success email.
      const current = await db.organizationDomain.findUniqueOrThrow({ where: { id: row.id } });
      return { row: current, justVerified: false };
    }
    throw err;
  }
}

/**
 * Fire the one-time "your domain is verified" notice to every active org
 * ADMIN (mirrors lib/platform-fee-rate-notice.ts's admin-recipient
 * convention). Never throws — fire-and-forget safe. Always uses the plain
 * `prisma` client (not a transaction client) — call this AFTER the DB write
 * from applyFreshDomainStatus has committed, never from inside the same
 * transaction (a `tx` is no longer valid once its transaction resolves).
 */
export async function notifyDomainVerified(row: OrganizationDomainRow): Promise<void> {
  const admins = await prisma.user.findMany({
    where: { organization_id: row.organization_id, role: 'ADMIN', is_active: true },
    select: { email: true },
  });
  for (const admin of admins) {
    await sendDomainVerifiedEmail({
      organizationId: row.organization_id,
      to: admin.email,
      domainName: row.domain_name,
    }).catch((err) =>
      logger.error(`Failed to send domain-verified email to ${admin.email} for organization ${row.organization_id}:`, err));
  }
}
