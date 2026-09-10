/**
 * spiderDispatch.service.ts — Dispatches Email, SMS, and In-App alerts for Spider AI Agent
 *
 * Resolves recipients based on Spider Agent assignment configuration (Admin Roles, Specific Users, Lead Owner)
 * and dispatches notifications across the enabled channels (Email, SMS, In-App).
 */

import { prisma } from '../../lib/prisma';
import { logger } from '../../lib/logger';
import { sendAutomationEmail, esc } from '../../lib/email';
import { sendCtmSms } from '../../lib/ctm/sendSms';
import { emit } from './notificationService';
import { loadRoleHolders } from './roleHolders';
import { resolveSpiderAlertRecipients, getSpiderLeadOwnerId } from './spiderAlerts';
import { logSpiderNotification } from './spiderLogger';

export interface SpiderDispatchAssignments {
  adminRoles?: string[];
  users?: string[];
  owner?: boolean;
}

export interface SpiderDispatchNotificationsConfig {
  email?: boolean;
  sms?: boolean;
  inApp?: boolean;
  redFrame?: boolean;
}

export interface DispatchSpiderAlertParams {
  organizationId: string;
  leadId: string;
  stageLabel?: string;
  elapsedValue?: number;
  elapsedUnit?: string;
  elapsedSeconds?: number;
  assignments: SpiderDispatchAssignments;
  notifications: SpiderDispatchNotificationsConfig;
  actorId?: string | null;
  appBaseUrl?: string;
  testEmail?: string;
}

export interface DispatchSpiderAlertResult {
  ok: boolean;
  recipientCount: number;
  emailsSent: number;
  emailsSkippedOrFailed: number;
  smsSent: number;
  smsSkippedOrFailed: number;
  inAppEmitted: boolean;
  error?: string;
}

/**
 * Format service address string from customer and lead data
 */
function resolveServiceAddress(lead: any, customer: any): string {
  if (lead?.service_location && typeof lead.service_location === 'string') {
    return lead.service_location;
  }
  const parts: string[] = [];
  if (customer?.service_street || customer?.billing_street) {
    parts.push(customer.service_street || customer.billing_street);
  }
  if (customer?.service_unit || customer?.billing_unit) {
    parts.push(customer.service_unit || customer.billing_unit);
  }
  if (customer?.service_city || customer?.billing_city) {
    parts.push(customer.service_city || customer.billing_city);
  }
  if (customer?.service_state || customer?.billing_state) {
    parts.push(customer.service_state || customer.billing_state);
  }
  if (customer?.service_postal_code || customer?.billing_postal_code) {
    parts.push(customer.service_postal_code || customer.billing_postal_code);
  }
  return parts.length > 0 ? parts.join(', ') : 'Service location not specified';
}

/**
 * Dispatches Email, SMS, and In-App notifications for a Spider Agent overdue lead alert.
 */
export async function dispatchSpiderAlerts(
  params: DispatchSpiderAlertParams
): Promise<DispatchSpiderAlertResult> {
  const { organizationId, leadId, assignments, notifications, actorId } = params;

  // 1. Fetch Lead with Customer and Organization info
  const lead = await prisma.lead.findFirst({
    where: { id: leadId, customer: { organization_id: organizationId } },
    include: {
      customer: true,
      contact_setter: { select: { id: true, first_name: true, last_name: true, email: true } },
    },
  });

  if (!lead) {
    logger.warn('[spiderDispatch] Lead not found for alert dispatch', { leadId, organizationId });
    return {
      ok: false,
      recipientCount: 0,
      emailsSent: 0,
      emailsSkippedOrFailed: 0,
      smsSent: 0,
      smsSkippedOrFailed: 0,
      inAppEmitted: false,
      error: 'Lead not found',
    };
  }

  // Fetch Organization for branding
  const org = await prisma.organization.findUnique({
    where: { id: organizationId },
    select: { id: true, name: true, logo_url: true, brand_color: true },
  });

  // 2. Load Role Holders and Resolve Recipient IDs
  const roleHolders = await loadRoleHolders(organizationId, prisma);
  const recipientIds = resolveSpiderAlertRecipients({
    assignments: {
      adminRoles: assignments.adminRoles || [],
      users: assignments.users || [],
      owner: !!assignments.owner,
    },
    lead: {
      id: lead.id,
      commission_owner_id: lead.commission_owner_id,
      lead_number: lead.lead_number,
    },
    roleHolders,
  });

  // Load recipient user objects (email, phone, name)
  let recipientUsers = recipientIds.length > 0
    ? await prisma.user.findMany({
        where: {
          id: { in: recipientIds },
          organization_id: organizationId,
          is_active: true,
        },
        select: {
          id: true,
          email: true,
          phone: true,
          first_name: true,
          last_name: true,
        },
      })
    : [];

  // Fallback: If no explicit recipients matched, automatically use the System Admins of the organization
  if (recipientUsers.length === 0) {
    recipientUsers = await prisma.user.findMany({
      where: {
        organization_id: organizationId,
        role: 'ADMIN',
        is_active: true,
      },
      select: {
        id: true,
        email: true,
        phone: true,
        first_name: true,
        last_name: true,
      },
    });
  }

  // If a specific test email was provided (e.g. attaorakzai786@gmail.com), ensure it is added to recipients
  if (params.testEmail) {
    const existingIndex = recipientUsers.findIndex(
      (u) => u.email?.toLowerCase() === params.testEmail?.toLowerCase()
    );
    if (existingIndex >= 0) {
      recipientUsers[existingIndex]!.email = params.testEmail;
    } else {
      recipientUsers.push({
        id: 'test-user-override',
        email: params.testEmail,
        phone: null,
        first_name: 'Test',
        last_name: 'Recipient',
      });
    }
  }

  const customerName = `${lead.customer.first_name || ''} ${lead.customer.last_name || ''}`.trim() ||
    lead.customer.company_name ||
    'Customer';
  const stageName = params.stageLabel || 'Current Stage';
  const timeInStageStr = params.elapsedValue !== undefined && params.elapsedUnit
    ? `${params.elapsedValue} ${params.elapsedUnit}${params.elapsedValue > 1 ? 's' : ''}`
    : 'Overdue duration';
  const serviceLocation = resolveServiceAddress(lead, lead.customer);
  const leadNumberStr = lead.lead_number ? `LD-${lead.lead_number.replace(/^LD-/i, '')}` : `Lead #${lead.id.slice(0, 6)}`;
  const baseUrl = params.appBaseUrl || 'https://app.servwave.com';
  const leadUrl = `${baseUrl}/leads/${lead.id}`;

  let emailsSent = 0;
  let emailsSkippedOrFailed = 0;
  let smsSent = 0;
  let smsSkippedOrFailed = 0;

  // 3. Dispatch Email Alerts if enabled
  if (notifications.email) {
    const emailSubject = `[Spider AI Alert] ${leadNumberStr} (${customerName}) is overdue in ${stageName}`;

    for (const recipient of recipientUsers) {
      if (!recipient.email) {
        emailsSkippedOrFailed++;
        continue;
      }

      const recipientName = `${recipient.first_name || ''} ${recipient.last_name || ''}`.trim() || 'Team Member';

      const emailHtml = `
        <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px; color: #1e293b;">
          <div style="background-color: #0c2d3a; padding: 18px 24px; border-radius: 8px 8px 0 0; text-align: left;">
            <span style="font-size: 13px; font-weight: 700; color: #f87171; text-transform: uppercase; letter-spacing: 0.5px;">🕷️ Spider AI Lead Watcher Alert</span>
            <h2 style="color: #ffffff; margin: 6px 0 0 0; font-size: 20px; font-weight: 600;">Lead Stage Threshold Exceeded</h2>
          </div>
          <div style="background-color: #ffffff; padding: 24px; border: 1px solid #e2e8f0; border-top: none; border-radius: 0 0 8px 8px;">
            <p style="font-size: 15px; line-height: 1.5; margin-top: 0;">Hi ${esc(recipientName)},</p>
            <p style="font-size: 14px; line-height: 1.5; color: #475569;">
              The Spider AI Agent detected that <strong>${esc(customerName)}</strong> (${esc(leadNumberStr)}) has spent <strong>${esc(timeInStageStr)}</strong> in stage <strong>${esc(stageName)}</strong>, exceeding your configured threshold.
            </p>

            <table style="width: 100%; border-collapse: collapse; margin: 20px 0; font-size: 14px; background-color: #f8fafc; border-radius: 6px; overflow: hidden;">
              <tr>
                <td style="padding: 10px 14px; color: #64748b; font-weight: 600; width: 35%; border-bottom: 1px solid #e2e8f0;">Lead Number:</td>
                <td style="padding: 10px 14px; color: #0f172a; font-weight: 600; border-bottom: 1px solid #e2e8f0;">${esc(leadNumberStr)}</td>
              </tr>
              <tr>
                <td style="padding: 10px 14px; color: #64748b; font-weight: 600; border-bottom: 1px solid #e2e8f0;">Customer:</td>
                <td style="padding: 10px 14px; color: #0f172a; border-bottom: 1px solid #e2e8f0;">${esc(customerName)}</td>
              </tr>
              <tr>
                <td style="padding: 10px 14px; color: #64748b; font-weight: 600; border-bottom: 1px solid #e2e8f0;">Current Stage:</td>
                <td style="padding: 10px 14px; color: #dc2626; font-weight: 600; border-bottom: 1px solid #e2e8f0;">${esc(stageName)}</td>
              </tr>
              <tr>
                <td style="padding: 10px 14px; color: #64748b; font-weight: 600; border-bottom: 1px solid #e2e8f0;">Time in Stage:</td>
                <td style="padding: 10px 14px; color: #0f172a; border-bottom: 1px solid #e2e8f0;">${esc(timeInStageStr)}</td>
              </tr>
              <tr>
                <td style="padding: 10px 14px; color: #64748b; font-weight: 600;">Service Location:</td>
                <td style="padding: 10px 14px; color: #0f172a;">${esc(serviceLocation)}</td>
              </tr>
            </table>

            <div style="text-align: center; margin-top: 25px; margin-bottom: 15px;">
              <a href="${esc(leadUrl)}" style="background-color: #0284c7; color: #ffffff; padding: 12px 24px; text-decoration: none; border-radius: 6px; font-weight: 600; font-size: 14px; display: inline-block;">
                Open Lead Overview & Take Action →
              </a>
            </div>
          </div>
        </div>
      `;

      const textBody = `[Spider AI Alert] Lead ${leadNumberStr} (${customerName}) is overdue in stage "${stageName}" for ${timeInStageStr}.\nService Address: ${serviceLocation}\nView and follow up: ${leadUrl}`;

      try {
        const emailResult = await sendAutomationEmail({
          organizationId,
          to: recipient.email,
          subject: emailSubject,
          text: textBody,
          html: emailHtml,
          org: org ? {
            id: org.id,
            name: org.name,
            logo_url: org.logo_url,
            brand_color: org.brand_color || '#0C2D3A',
          } : undefined,
        });

        if (emailResult.status === 'sent') {
          emailsSent++;
          logSpiderNotification({
            channel: 'EMAIL',
            status: 'SUCCESS',
            recipient: recipient.email,
            leadNumber: leadNumberStr,
            customerName,
            stageName,
            details: emailSubject,
          });
        } else {
          emailsSkippedOrFailed++;
          logSpiderNotification({
            channel: 'EMAIL',
            status: 'FAILED',
            recipient: recipient.email,
            leadNumber: leadNumberStr,
            customerName,
            stageName,
            error: emailResult.status === 'failed' ? emailResult.error : `Skipped: ${emailResult.reason}`,
          });
        }
      } catch (err: any) {
        logger.warn('[spiderDispatch] Failed to dispatch Spider alert email', { error: err, to: recipient.email });
        emailsSkippedOrFailed++;
        logSpiderNotification({
          channel: 'EMAIL',
          status: 'FAILED',
          recipient: recipient.email,
          leadNumber: leadNumberStr,
          customerName,
          stageName,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  // 4. Dispatch SMS Alerts if enabled
  if (notifications.sms) {
    const smsBody = `[Spider Alert] Lead ${leadNumberStr} (${customerName}) is overdue in stage "${stageName}" (${timeInStageStr}). View lead: ${leadUrl}`;

    for (const recipient of recipientUsers) {
      const destinationPhone = recipient.phone || lead.customer.phone;
      if (!destinationPhone) {
        smsSkippedOrFailed++;
        logSpiderNotification({
          channel: 'SMS',
          status: 'SKIPPED',
          recipient: 'N/A',
          leadNumber: leadNumberStr,
          customerName,
          stageName,
          error: 'No valid phone number found for recipient or customer',
        });
        continue;
      }

      try {
        let thread = await prisma.messageThread.findFirst({
          where: {
            customer_id: lead.customer_id,
            channel: 'sms',
            organization_id: organizationId,
          },
        });

        if (!thread) {
          thread = await prisma.messageThread.create({
            data: {
              channel: 'sms',
              campaign_type: 'customer_care',
              customer_id: lead.customer_id,
              organization_id: organizationId,
            },
          });
        }

        const msg = await prisma.message.create({
          data: {
            thread_id: thread.id,
            organization_id: organizationId,
            direction: 'out',
            body: smsBody,
            ts: new Date(),
            status: 'queued',
          },
        });

        const delivery = await sendCtmSms(prisma, {
          orgId: organizationId,
          toE164: destinationPhone,
          threadId: thread.id,
          messageId: msg.id,
          body: smsBody,
        });

        if (delivery.delivered) {
          smsSent++;
          logSpiderNotification({
            channel: 'SMS',
            status: 'SUCCESS',
            recipient: destinationPhone,
            leadNumber: leadNumberStr,
            customerName,
            stageName,
            details: smsBody,
          });
        } else {
          smsSkippedOrFailed++;
          logSpiderNotification({
            channel: 'SMS',
            status: 'FAILED',
            recipient: destinationPhone,
            leadNumber: leadNumberStr,
            customerName,
            stageName,
            error: (delivery as any).reason || 'CTM delivery failed',
          });
        }
      } catch (err: any) {
        logger.warn('[spiderDispatch] Failed to dispatch Spider alert SMS', { error: err, phone: destinationPhone });
        smsSkippedOrFailed++;
        logSpiderNotification({
          channel: 'SMS',
          status: 'FAILED',
          recipient: destinationPhone,
          leadNumber: leadNumberStr,
          customerName,
          stageName,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  // 5. Emit In-App notification event
  let inAppEmitted = false;
  try {
    const emittedRecipients = await emit({
      verb: 'spider.alert',
      organizationId,
      actorId: actorId || null,
      object: { type: 'LEAD', id: lead.id, label: leadNumberStr },
      entity: {
        ...lead,
        admin_roles: assignments.adminRoles,
        user_ids: assignments.users,
        owner: assignments.owner,
        lead_owner_id: getSpiderLeadOwnerId(lead),
        roleHolders,
      },
      data: {
        customer_name: customerName,
        stage_name: stageName,
        time_in_stage: timeInStageStr,
        body: `Lead ${leadNumberStr} is overdue in stage ${stageName} (${timeInStageStr}).`,
      },
      dedupKey: `spider-${lead.id}-${stageName}-${Math.floor(Date.now() / 1800000)}`,
    });
    inAppEmitted = emittedRecipients.length > 0;
  } catch (err) {
    logger.warn('[spiderDispatch] In-app notification emit error', { error: err });
  }

  return {
    ok: true,
    recipientCount: recipientUsers.length,
    emailsSent,
    emailsSkippedOrFailed,
    smsSent,
    smsSkippedOrFailed,
    inAppEmitted,
  };
}
