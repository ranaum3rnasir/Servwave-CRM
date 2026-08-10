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
  },
): Promise<void> {
  try {
    const now = new Date();
    await prisma.email.create({
      data: {
        account: 'system',
        // Mirrors formatSenderIdentity exactly: with no usable display name the
        // header is the bare address, so the row says the same rather than
        // inventing a label the recipient never saw.
        from: { name: args.fromName ?? args.fromAddress, email: args.fromAddress },
        provider_message_id: args.providerMessageId ?? null,
        // This row only ever exists because a dispatch came back 'sent', so SENT
        // is the honest starting state. The webhook slice advances it from here.
        delivery_status: 'SENT',
        delivery_status_at: now,
        to: args.to,
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
        organization_id: args.organizationId,
      },
    });
  } catch (err) {
    logger.error('Failed to persist transactional email:', err);
  }
}
