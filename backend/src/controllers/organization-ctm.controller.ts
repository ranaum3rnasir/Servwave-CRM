import { Request, Response } from 'express';
import { z } from 'zod';
import { prisma } from '../lib/prisma';
import { env } from '../config/env';
import { logger } from '../lib/logger';
import { logAudit } from '../lib/audit';
import {
  isCtmConfigured,
  listAccounts,
  createAccount,
  listNumbers,
  listWebhooks,
  createWebhook,
  deleteWebhook,
  enableSms,
  getA2pStatus,
  CtmApiError,
} from '../lib/ctm/client';

/**
 * CTM connect / disconnect / A2P-check for the requesting user's own org.
 * Routes are gated canDo('update','Organization') — the repo's ADMIN-only
 * idiom (organization.routes.ts precedent; DISPATCHER/SALES lack the grant).
 */

// Positions provisioned at connect (see master plan §1 + v3.1 addendum §A.3 -
// `starts` covers both directions; the alias handling lives in the webhook
// controller).
//
// `outbound_text` is deliberately ABSENT. It was provisioned here from the
// start and, measured live 2026-08-01, was registered on both connected CTM
// accounts (596375 hook 274748, 597911 hook 274595 - `disabled: false`, no
// conditions) and had fired ZERO times in 21 days. Every outbound text arrived
// on `status_change` instead, as a full `direction: msg_outbound` activity.
// CTM stores a position string it does not recognize rather than rejecting it
// (same silent-acceptance behavior as the `type=tollfree` search param, PR
// #1140), so provisioning this only advertised coverage that never existed.
// The webhook controller still ACCEPTS the position, so nothing breaks if CTM
// ever starts firing it.
//
// A hook carries TWO independent names, and they are not always the same
// string: `ctmPosition` is validated against CTM's own trigger list, while
// `path` is the segment our route dispatches on (ctm-webhook.controller's
// isKnownPosition). Probed live against account 596375 on 2026-08-05, CTM
// REJECTS `starts` outright - HTTP 406, {"position":["is not included in the
// list"]} - and accepts `start`. So no org has ever had a call-start hook: the
// connect logged one warning and moved on. Sending `start` while keeping the
// `starts` path fixes the provision without touching the ingest side, which is
// already written and tested for `starts`.
const POSITIONS_TO_PROVISION: ReadonlyArray<{ ctmPosition: string; path: string }> = [
  { ctmPosition: 'start', path: 'starts' },
  { ctmPosition: 'end', path: 'end' },
  { ctmPosition: 'inbound_text', path: 'inbound_text' },
  { ctmPosition: 'status_change', path: 'status_change' },
];

export const connectCtmSchema = z
  .object({
    ctm_account_id: z.string().trim().min(1).max(40).optional(),
    createNew: z.boolean().optional(),
    name: z.string().trim().min(1).max(200).optional(),
  })
  .refine((b) => !!b.ctm_account_id !== !!b.createNew, {
    message: 'Provide exactly one of ctm_account_id or createNew',
  })
  .refine((b) => !b.createNew || !!b.name, {
    message: 'name is required when createNew is set',
  });

function webhookBaseUrl(): string | null {
  if (!env.BACKEND_PUBLIC_URL || !env.CTM_WEBHOOK_TOKEN) return null;
  return env.BACKEND_PUBLIC_URL.replace(/\/+$/, '');
}

function weburlFor(path: string): string | null {
  const base = webhookBaseUrl();
  if (!base) return null;
  return `${base}/api/webhooks/ctm/${path}?token=${env.CTM_WEBHOOK_TOKEN}`;
}

/** Idempotent: re-running connect never duplicates hooks (diff by weburl). */
async function provisionWebhooks(accountId: string, warnings: string[]): Promise<string[]> {
  const base = webhookBaseUrl();
  if (!base) {
    warnings.push(
      'Webhooks NOT provisioned: BACKEND_PUBLIC_URL and/or CTM_WEBHOOK_TOKEN are not set. Re-run connect after configuring them.',
    );
    return [];
  }
  const existing = await listWebhooks(accountId);
  const existingUrls = new Set(existing.map((h) => String(h.weburl ?? h.url ?? '')));
  const provisioned: string[] = [];
  for (const { ctmPosition, path } of POSITIONS_TO_PROVISION) {
    const weburl = weburlFor(path)!;
    if (existingUrls.has(weburl)) {
      provisioned.push(ctmPosition);
      continue;
    }
    try {
      await createWebhook(accountId, {
        name: `servwave-${ctmPosition}`,
        weburl,
        position: ctmPosition,
        username: 'servwave',
        password: env.CTM_WEBHOOK_TOKEN!,
      });
      provisioned.push(ctmPosition);
    } catch (err) {
      // A position CTM rejects is survivable — a partial provision still leaves
      // the other hooks live (and the backfill covers gaps), so surface it
      // instead of failing the whole connect.
      const reason = err instanceof CtmApiError ? err.reason : 'request failed';
      warnings.push(`Webhook '${ctmPosition}' not provisioned: ${reason}`);
      logger.warn(`[ctm-connect] provisioning '${ctmPosition}' failed: ${reason}`);
    }
  }
  return provisioned;
}

async function importNumbers(accountId: string, orgId: string, warnings: string[]): Promise<number> {
  const numbers = await listNumbers(accountId);
  let imported = 0;
  for (const n of numbers) {
    const e164 = String(n.number ?? n.phone_number ?? n.e164 ?? '');
    if (!e164) continue;
    const tpnId = n.id !== undefined && n.id !== null ? String(n.id) : null;
    let smsEnabled = false;
    if (tpnId) {
      try {
        const outcome = await enableSms(accountId, tpnId);
        smsEnabled = outcome === 'ok' || outcome === 'alreadyenabled';
        if (!smsEnabled) {
          warnings.push(`Number ${e164}: SMS not enabled (${outcome}).`);
        }
      } catch {
        warnings.push(`Number ${e164}: SMS enablement check failed.`);
      }
    }
    await prisma.phoneNumber.upsert({
      where: { organization_id_e164: { organization_id: orgId, e164 } },
      create: {
        e164,
        formatted: n.formatted ? String(n.formatted) : null,
        label: n.name ? String(n.name) : null,
        source: 'ctm',
        ctm_number_id: tpnId,
        sms_enabled: smsEnabled,
        status: 'active',
        organization_id: orgId,
      },
      update: {
        ctm_number_id: tpnId,
        sms_enabled: smsEnabled,
        status: 'active',
      },
    });
    imported++;
  }
  return imported;
}

function a2pApproved(status: Record<string, unknown>): boolean {
  const campaigns = Array.isArray(status.a2p_campaigns)
    ? status.a2p_campaigns
    : Array.isArray(status.campaigns)
      ? status.campaigns
      : Array.isArray(status)
        ? (status as unknown[])
        : [];
  return campaigns.some((c) =>
    String((c as Record<string, unknown>)?.status ?? '').toLowerCase().includes('approv'),
  );
}

export async function connectCtm(req: Request, res: Response) {
  try {
    if (!isCtmConfigured()) {
      res.status(503).json({ error: 'The phone system is not configured — contact support' });
      return;
    }
    const orgId = req.user!.organization_id;
    const warnings: string[] = [];

    let accountId: string;
    if (req.body.createNew) {
      const created = await createAccount(String(req.body.name));
      const newId = (created.id ?? (created.account as Record<string, unknown> | undefined)?.id) as
        | string
        | number
        | undefined;
      if (newId === undefined || newId === null) {
        res
          .status(502)
          .json({ error: 'The phone system did not return an account id for the new account' });
        return;
      }
      accountId = String(newId);
    } else {
      accountId = String(req.body.ctm_account_id);
      // Reachability = claim validation: the id must be one of OUR agency's
      // sub-accounts (a random/foreign id must not be connectable).
      const accounts = await listAccounts();
      const reachable = accounts.some((a) => String(a.id ?? a.account_id ?? '') === accountId);
      if (!reachable) {
        res.status(422).json({ error: 'That account id was not found under ServWave' });
        return;
      }
    }

    try {
      await prisma.organization.update({
        where: { id: orgId },
        data: { ctm_account_id: accountId },
      });
    } catch (err) {
      if ((err as { code?: string }).code === 'P2002') {
        // Unique(ctm_account_id) — another org already claimed this account.
        res
          .status(409)
          .json({ error: 'That account is already connected to another organization' });
        return;
      }
      throw err;
    }

    const numbersImported = await importNumbers(accountId, orgId, warnings);
    const webhooksProvisioned = await provisionWebhooks(accountId, warnings);

    let smsReady = false;
    try {
      smsReady = a2pApproved(await getA2pStatus(accountId));
    } catch {
      warnings.push('A2P status check failed — SMS stays disabled until "Check A2P status" succeeds.');
    }
    await prisma.organization.update({ where: { id: orgId }, data: { ctm_sms_ready: smsReady } });

    void logAudit({
      req,
      action: 'ctm.connected',
      resourceType: 'Organization',
      resourceId: orgId,
      metadata: { ctm_account_id: accountId, numbersImported, webhooksProvisioned },
    });

    res.json({
      connected: true,
      ctm_account_id: accountId,
      numbers_imported: numbersImported,
      webhooks_provisioned: webhooksProvisioned,
      sms_ready: smsReady,
      // Manual per-org onboarding steps (owner-executed — Ran's 2026-07-09
      // decision): consent greeting + retention are set with the upstream
      // provider, not here. Surfaced to org admins, so never name the provider.
      manual_steps: [
        'Set the recording-consent greeting and retention policy with your phone system provider.',
        'Verify recording toggles (inbound/outbound) match the org’s policy.',
      ],
      warnings,
    });
  } catch (err) {
    logger.error('Failed to connect CTM:', err);
    if (err instanceof CtmApiError) {
      res.status(502).json({ error: 'The phone system request failed' });
      return;
    }
    res.status(500).json({ error: 'Internal server error' });
  }
}

export async function checkCtmA2p(req: Request, res: Response) {
  try {
    if (!isCtmConfigured()) {
      res.status(503).json({ error: 'The phone system is not configured — contact support' });
      return;
    }
    const orgId = req.user!.organization_id;
    const org = await prisma.organization.findUnique({
      where: { id: orgId },
      select: { ctm_account_id: true },
    });
    if (!org?.ctm_account_id) {
      res.status(409).json({ error: 'Organization is not connected to a phone system' });
      return;
    }
    const smsReady = a2pApproved(await getA2pStatus(org.ctm_account_id));
    await prisma.organization.update({ where: { id: orgId }, data: { ctm_sms_ready: smsReady } });
    res.json({ sms_ready: smsReady });
  } catch (err) {
    logger.error('Failed to check CTM A2P status:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
}

export async function disconnectCtm(req: Request, res: Response) {
  try {
    const orgId = req.user!.organization_id;
    const org = await prisma.organization.findUnique({
      where: { id: orgId },
      select: { ctm_account_id: true },
    });
    if (!org?.ctm_account_id) {
      res.status(409).json({ error: 'Organization is not connected to a phone system' });
      return;
    }

    // Delete only OUR hooks (weburl on our backend origin); Alpha Doors' own
    // CTM config is never touched. Invisible-rollback guarantee (plan §7).
    const base = webhookBaseUrl();
    if (isCtmConfigured() && base) {
      try {
        const hooks = await listWebhooks(org.ctm_account_id);
        for (const hook of hooks) {
          const url = String(hook.weburl ?? hook.url ?? '');
          const hookId = hook.id;
          if (url.startsWith(base) && hookId !== undefined && hookId !== null) {
            await deleteWebhook(org.ctm_account_id, String(hookId));
          }
        }
      } catch (err) {
        logger.warn('CTM webhook cleanup during disconnect failed (continuing):', err);
      }
    }

    await prisma.organization.update({
      where: { id: orgId },
      data: { ctm_account_id: null, ctm_sms_ready: false },
    });

    // CTM-sourced numbers are unusable once the account is detached — leaving
    // them 'active' would let sendSms/click-to-call pick a dead TPN (both
    // resolve the from-number with status:'active'). A future re-connect's
    // importNumbers upsert reactivates them (update sets status:'active').
    await prisma.phoneNumber.updateMany({
      where: { organization_id: orgId, source: 'ctm' },
      data: { status: 'inactive' },
    });

    void logAudit({
      req,
      action: 'ctm.disconnected',
      resourceType: 'Organization',
      resourceId: orgId,
      metadata: { ctm_account_id: org.ctm_account_id },
    });

    res.json({ connected: false });
  } catch (err) {
    logger.error('Failed to disconnect CTM:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
}
