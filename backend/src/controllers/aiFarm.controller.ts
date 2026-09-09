import { Request, Response } from 'express';
import { z } from 'zod';
import { prisma } from '../lib/prisma';
import { sendAiFarmBookingEmails } from '../lib/email';
import { logger } from '../lib/logger';
import { dispatchSpiderAlerts } from '../services/notifications/spiderDispatch.service';

export const bookCallSchema = z
  .object({
    agentName: z.string().min(1).max(120),
    agentRole: z.string().min(1).max(160),
    day: z.string().min(1).max(60),
    slot: z.string().min(1).max(40),
  })
  .strict();

export async function bookCall(req: Request, res: Response) {
  const { agentName, agentRole, day, slot } = req.body;
  const user = req.user!;

  try {
    const org = await prisma.organization.findUnique({
      where: { id: user.organization_id },
      select: { name: true },
    });

    await sendAiFarmBookingEmails({
      requesterName: `${user.first_name} ${user.last_name}`.trim(),
      requesterEmail: user.email,
      orgName: org?.name ?? 'their business',
      agentName,
      agentRole,
      day,
      slot,
    });

    res.json({ ok: true });
  } catch (err) {
    logger.error('AI Agentic Farm booking failed:', err);
    res.status(502).json({ error: 'Could not send the booking request. Please try again.' });
  }
}

// ─── Spider Agent Alert Dispatch ─────────────────────────────────────────────

export const dispatchSpiderAlertSchema = z
  .object({
    leadId: z.string().uuid(),
    stageLabel: z.string().optional(),
    elapsedValue: z.number().optional(),
    elapsedUnit: z.string().optional(),
    elapsedSeconds: z.number().optional(),
    assignments: z
      .object({
        adminRoles: z.array(z.string()).optional(),
        users: z.array(z.string()).optional(),
        owner: z.boolean().optional(),
      })
      .default({}),
    notifications: z
      .object({
        email: z.boolean().optional(),
        sms: z.boolean().optional(),
        inApp: z.boolean().optional(),
        redFrame: z.boolean().optional(),
      })
      .default({}),
    testEmail: z.string().email().optional(),
  })
  .strict();

export async function dispatchSpiderAlert(req: Request, res: Response) {
  const user = req.user!;
  const body = req.body;

  try {
    const result = await dispatchSpiderAlerts({
      organizationId: user.organization_id,
      leadId: body.leadId,
      stageLabel: body.stageLabel,
      elapsedValue: body.elapsedValue,
      elapsedUnit: body.elapsedUnit,
      elapsedSeconds: body.elapsedSeconds,
      assignments: body.assignments,
      notifications: body.notifications,
      actorId: user.id,
      appBaseUrl: req.protocol + '://' + req.get('host'),
      testEmail: body.testEmail,
    });

    if (!result.ok && result.error === 'Lead not found') {
      return res.status(404).json({ error: 'Lead not found' });
    }

    res.json(result);
  } catch (err) {
    logger.error('Spider alert dispatch failed:', err);
    res.status(500).json({ error: 'Failed to dispatch Spider alert' });
  }
}
