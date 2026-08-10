import type { Prisma, PrismaClient } from '@prisma/client';
import { matchByPhone, normalizeNAPhone, type IdentityMatch } from '../comms-identity';

/**
 * The ONE SMS thread-identity rule (slice H7): given a counterpart phone
 * number, resolve the conversation it belongs to — shared by the CTM webhook
 * ingest (ingestSms) and the compose-to-number send path (sendMessage), so a
 * user-composed text and an inbound webhook text always land in the SAME
 * conversation.
 *
 * Keying mirrors createThread's FULL linking (customer + lead + vendor) and
 * the FIND mirrors the CREATE for every match kind: customer matches (lead
 * matches carry customerId too) key by customer_id; vendor/vendor-contact
 * matches (customerId null) key by vendor_id; unmatched numbers key by
 * title = the E.164-normalized number (fallback raw) so bare vs +1 spellings
 * can never split a thread.
 *
 * Read-mostly: creates ONLY the thread row (never a Customer/Lead — DEC6's
 * "unmatched → offer create" stays a caller-side affordance).
 */

type Db = Prisma.TransactionClient | PrismaClient;

export interface SmsThreadResolution {
  thread: { id: string; customer_id: string | null; vendor_id: string | null; lead_id: string | null; title: string | null; kind?: string | null };
  /** The identity resolution used for the keying (null = unmatched). */
  match: IdentityMatch | null;
  /** True when this call created the thread (vs. found an existing one) — a
   *  caller that then hits a post-creation failure knows it's safe to roll
   *  the new thread back (s1d). */
  created: boolean;
}

export async function findOrCreateSmsThreadByNumber(
  db: Db,
  orgId: string,
  rawNumber: string,
): Promise<SmsThreadResolution> {
  const match = rawNumber ? await matchByPhone(db, orgId, rawNumber) : null;

  const titleKey = normalizeNAPhone(rawNumber) ?? (rawNumber || 'unknown');
  let thread = await db.messageThread.findFirst({
    where: match?.customerId
      ? { organization_id: orgId, channel: 'sms', customer_id: match.customerId }
      : match?.vendorId
        ? { organization_id: orgId, channel: 'sms', vendor_id: match.vendorId }
        : { organization_id: orgId, channel: 'sms', customer_id: null, vendor_id: null, title: titleKey },
  });
  let created = false;
  if (!thread) {
    thread = await db.messageThread.create({
      data: {
        channel: 'sms',
        campaign_type: 'customer_care',
        customer_id: match?.customerId ?? null,
        lead_id: match?.leadId ?? null,
        vendor_id: match?.vendorId ?? null,
        title: match ? null : titleKey,
        organization_id: orgId,
      },
    });
    created = true;
  }
  return { thread, match, created };
}
