/**
 * smsRecord.ts — outbound-SMS write path for automation actions.
 *
 * Mirrors the Communication module's send seam (comm-threads.controller
 * sendMessage): find-or-create the customer's SMS MessageThread, append an
 * outbound Message with the `automated` flag + job attribution, and surface
 * an SMS_SENT event on the customer timeline.
 *
 * This is the org's built SMS layer — delivery to the handset activates when
 * an SMS provider (CTM) is connected; until then the record is the product:
 * visible in the Communication UI and in automation run history. CTM is that
 * provider now (slice 6): after the record write, delivery goes through the
 * shared `sendCtmSms` path and the caller AWAITS the outcome — automations
 * never 409 (sendCtmSms never throws) but the executor needs the real result
 * to report an honest step status (SERV10X-70, mirrors the SEND_EMAIL fix).
 *
 * The row is written `queued` and settled by the delivery path (sent / skipped
 * with a reason / failed). It must never be written `sent` up front: that is
 * the #1068 false-success shape, and it is what left 24 automated rows on
 * staging permanently claiming a send that the gates had suppressed.
 *
 * There is no separate launch flag here — sendCtmSms's own gates (connected,
 * A2P-ready, org kill switch, `phone` entitlement) are the single source of
 * truth for whether an org can text. The builder's "Send text" step unlocks
 * per-org off the same gates via GET /api/workflows/catalog capabilities.
 */

import { prisma } from '../../lib/prisma';
import { logger } from '../../lib/logger';
import { normalizeNAPhone } from '../../lib/comms-identity';
import { isCtmConfigured } from '../../lib/ctm/client';
import { markMessageNotDelivered, sendCtmSms, type CtmSmsSendResult } from '../../lib/ctm/sendSms';

export interface RecordOutboundSmsParams {
  organizationId: string;
  customerId: string;
  body: string;
  job?: { id: string; label: string | null } | null;
}

export async function recordOutboundSms(
  params: RecordOutboundSmsParams,
): Promise<{ threadId: string; messageId: string; delivery: CtmSmsSendResult }> {
  let thread = await prisma.messageThread.findFirst({
    where: {
      customer_id: params.customerId,
      channel: 'sms',
      organization_id: params.organizationId,
    },
  });
  if (!thread) {
    thread = await prisma.messageThread.create({
      data: {
        channel: 'sms',
        campaign_type: 'customer_care',
        customer_id: params.customerId,
        organization_id: params.organizationId,
      },
    });
  }

  const message = await prisma.message.create({
    data: {
      thread_id: thread.id,
      direction: 'out',
      body: params.body,
      ts: new Date(),
      // `queued`, never `sent` - at this point nothing has attempted delivery.
      // sendCtmSms settles it below: sent / skipped(reason) / failed(reason).
      // Writing 'sent' here is what put 24 automated rows on staging into a
      // permanent false-success state (see #1068 / PR #1070 for the same bug in
      // the email executor).
      status: 'queued',
      automated: true,
      ...(params.job ? { job_id: params.job.id, job_label: params.job.label } : {}),
      organization_id: params.organizationId,
    },
  });

  await prisma.timelineEvent.create({
    data: {
      organization_id: params.organizationId,
      entity_type: 'CUSTOMER',
      entity_id: params.customerId,
      event_type: 'SMS_SENT',
      description: 'Automated SMS recorded',
      metadata: { thread_id: thread.id, message_id: message.id, automated: true },
      created_by: null,
    },
  });

  // CTM delivery — awaited (no precheck: automations never 409, and
  // deliverViaCtm never throws, so awaiting it cannot break the run).
  const delivery = await deliverViaCtm({
    organizationId: params.organizationId,
    customerId: params.customerId,
    threadId: thread.id,
    messageId: message.id,
    body: params.body,
  });

  return { threadId: thread.id, messageId: message.id, delivery };
}

async function deliverViaCtm(p: {
  organizationId: string;
  customerId: string;
  threadId: string;
  messageId: string;
  body: string;
}): Promise<CtmSmsSendResult> {
  // The two bail-outs below never reach sendCtmSms, so they must settle the
  // row themselves - otherwise it sits at `queued` forever, which reads as
  // "still going out" for a send that will never be attempted.
  try {
    if (!isCtmConfigured()) {
      await markMessageNotDelivered(prisma, p.messageId, 'skipped', 'NOT_CONNECTED');
      return { delivered: false, reason: 'NOT_CONNECTED' };
    }
    const customer = await prisma.customer.findFirst({
      where: { id: p.customerId, organization_id: p.organizationId },
      select: { phone: true },
    });
    const toE164 = customer?.phone ? (normalizeNAPhone(customer.phone) ?? customer.phone) : null;
    if (!toE164) {
      await markMessageNotDelivered(prisma, p.messageId, 'skipped', 'NO_SMS_NUMBER');
      return { delivered: false, reason: 'NO_SMS_NUMBER' };
    }
    return await sendCtmSms(prisma, {
      orgId: p.organizationId,
      toE164,
      body: p.body,
      threadId: p.threadId,
      messageId: p.messageId,
    });
  } catch (err) {
    logger.warn('[ctm] automation SMS delivery failed (record kept):', err);
    await markMessageNotDelivered(prisma, p.messageId, 'failed', 'CTM_ERROR');
    return { delivered: false, reason: 'CTM_ERROR' };
  }
}
