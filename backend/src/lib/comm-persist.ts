import { prisma } from './prisma';
import { logger } from './logger';

// Communication ↔ Jobs (attach-by-origin): transactional (Resend) sends persist
// an Email row so they appear on the customer center and the job Communication
// tab. `account: 'system'` is the transactional marker the aggregator reads.

export interface TransactionalEmailRecord {
  organizationId: string;
  customerId?: string | null;
  leadId?: string | null;
  jobId?: string | null;
  /** The outside party on a purchase order - the vendor, not a customer. */
  vendorId?: string | null;
  jobLabel?: string | null;
  /**
   * The CRM thing this email is ABOUT ('estimate', 'invoice', 'job', ...), and
   * its id. Together they are the reply token's anchor for a send that has no
   * thread of its own, which is every transactional send - see
   * lib/reply-token.ts's prepareReplyToken.
   *
   * The anchor is what makes one entity one conversation: the estimate, its
   * reminder and the customer's reply all resolve to a single address instead
   * of scattering across as many threads as there were messages. Absent means
   * the send is deliberately unreplyable (MFA codes, invites, internal alerts).
   */
  entityType?: string | null;
  entityId?: string | null;
}

/**
 * Mirror a successfully-sent transactional email as a system Email row.
 * Deep module: NEVER throws — the email already went out; a persistence
 * failure must never break a send path.
 *
 * `fromAddress` is REQUIRED and comes off the dispatch result, never from an
 * env read here. This row used to hardcode env.EMAIL_FROM - the root domain
 * reserved for auth-critical mail (MFA codes, invites) that bypasses
 * dispatchEmail entirely - while every send it mirrors actually leaves from
 * env.EMAIL_FROM_BUSINESS. Taking the address the dispatcher reports makes the
 * two structurally incapable of drifting apart again.
 */
export async function persistTransactionalEmail(
  args: TransactionalEmailRecord & {
    to: string;
    subject: string;
    text: string;
    /**
     * The display name dispatchEmail actually put in the header, null for a
     * platform-voice send. Comes off the dispatch result for the same reason
     * fromAddress does: a caller guessing the name is the same drift as
     * guessing the address, and the old `?? 'ServWave'` fallback was never
     * right at any persisting call site - they all send in the org's voice.
     */
    fromName: string | null;
    /** The address dispatchEmail transmitted from (EmailDispatchResult.fromAddress). */
    fromAddress: string;
    /** Resend's message id; null when the provider returned no envelope. */
    providerMessageId?: string | null;
    /**
     * The conversation this send belongs to. Null only for a sender that mints
     * no reply token, since a customer with nowhere to reply has no thread to
     * reply INTO either.
     */
    threadId?: string | null;
    /**
     * Everyone else the dispatch copied. Same reasoning as fromAddress: the row
     * reports what was transmitted, not what a caller assumed. Verified in prod
     * before this existed - two sends carried cc art.nakamura@servwave.com and both
     * rows recorded null, so the Communication tab named one recipient for a
     * two-recipient email.
     */
    cc?: string[];
  },
): Promise<void> {
  try {
    const now = new Date();
    await prisma.email.create({
      data: {
        account: 'system',
        // An outbound message, stated as such. This column used to be left NULL
        // on every transactional send while the 2026-08-05 backfill stamped
        // 'out' on all 39 historical rows - so the table read complete while no
        // new write set it, and the inbox could not tell a sent estimate from a
        // row of unknown provenance.
        direction: 'out',
        // Mirrors formatSenderIdentity exactly: with no usable display name the
        // header is the bare address, so the row says the same rather than
        // inventing a label the recipient never saw.
        from: { name: args.fromName ?? args.fromAddress, email: args.fromAddress },
        provider_message_id: args.providerMessageId ?? null,
        // Spec #1751 D5 - PROVENANCE, stated rather than inferred. Every row this function
        // writes is a notice the platform sent on the company's behalf (estimate/invoice/PO
        // notices and the like), so none of them is a salesperson reaching out and none may set
        // the lead contact clock. The alternative on offer was structural - these rows tend to
        // carry no `thread_id` while the compose path always populates one - and it is rejected
        // rather than merely unused: this function ALREADY accepts a `threadId`, so the first
        // caller to pass one would silently mark every lead in the system contacted.
        automated: true,
        // This row only ever exists because a dispatch came back 'sent', so SENT
        // is the honest starting state. The webhook slice advances it from here.
        delivery_status: 'SENT',
        delivery_status_at: now,
        to: args.to,
        // Comma-joined, matching the shape inbound mail already stores in this
        // column. Absent rather than '' when there was no cc, so "nobody was
        // copied" stays distinguishable from "copied to nothing".
        ...(args.cc && args.cc.length > 0 ? { cc: args.cc.join(', ') } : {}),
        subject: args.subject,
        snippet: args.text.slice(0, 200),
        body: [args.text],
        at: now.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' }),
        ts: now.getTime(),
        unread: false,
        starred: false,
        folder: 'sent',
        customer_id: args.customerId ?? null,
        lead_id: args.leadId ?? null,
        job_id: args.jobId ?? null,
        vendor_id: args.vendorId ?? null,
        job_label: args.jobLabel ?? null,
        thread_id: args.threadId ?? null,
        organization_id: args.organizationId,
      },
    });
  } catch (err) {
    logger.error('Failed to persist transactional email:', err);
  }
}
