import { Request, Response } from 'express';
import { z } from 'zod';
import { prisma } from '../lib/prisma';
import { logger } from '../lib/logger';
import { tenantWhere } from '../lib/tenant';
import { logAudit } from '../lib/audit';
import {
  isCtmConfigured,
  searchNumbers as ctmSearchNumbers,
  buyNumber as ctmBuyNumber,
  createReceivingNumber,
  updateNumberRouting,
  enableSms,
  CtmApiError,
} from '../lib/ctm/client';
import { normalizeNAPhone } from '../lib/comms-identity';

/**
 * Numbers platform (master plan §4 comm-numbers row, slice 7).
 *
 * READ/PATCH are plain Communication grants; search/buy/register-byo are gated
 * canDo('update','Organization') — the repo's ADMIN idiom (addendum §A.2:
 * DISPATCHER holds create-Communication, so a Communication gate would let a
 * dispatcher spend money). Search responses are price-stripped server-side:
 * numbers are "included in the plan" — CTM's per-number cost is a platform
 * detail that must never reach the UI (plan §2).
 */

// ─── Shared helpers ──────────────────────────────────────────────────────────

/** Wire shape for a PhoneNumber row (snake_case; created_at ISO). */
function mapNumber(row: {
  id: string;
  e164: string;
  formatted: string | null;
  label: string | null;
  source: string;
  type: string | null;
  sms_enabled: boolean;
  ctm_number_id: string | null;
  call_flow_id: string | null;
  status: string;
  created_at: Date | string;
}) {
  return {
    id: row.id,
    e164: row.e164,
    formatted: row.formatted,
    label: row.label,
    source: row.source,
    type: row.type,
    sms_enabled: row.sms_enabled,
    ctm_number_id: row.ctm_number_id,
    call_flow_id: row.call_flow_id,
    status: row.status,
    created_at: row.created_at instanceof Date ? row.created_at.toISOString() : row.created_at,
  };
}

/** Resolve the org's CTM account or write the failure response (503/409) and
 *  return null — mirrors checkCtmA2p's gate order. */
async function requireCtmAccount(req: Request, res: Response): Promise<string | null> {
  if (!isCtmConfigured()) {
    res.status(503).json({ error: 'The phone system is not configured — contact support' });
    return null;
  }
  const org = await prisma.organization.findUnique({
    where: { id: req.user!.organization_id },
    select: { ctm_account_id: true },
  });
  if (!org?.ctm_account_id) {
    res.status(409).json({ error: 'Organization is not connected to a phone system' });
    return null;
  }
  return org.ctm_account_id;
}

// ─── GET /numbers ────────────────────────────────────────────────────────────

export async function listNumbers(req: Request, res: Response) {
  try {
    const rows = await prisma.phoneNumber.findMany({
      where: tenantWhere(req),
      orderBy: { created_at: 'asc' },
    });
    res.json({ numbers: rows.map(mapNumber) });
  } catch (err) {
    logger.error('Failed to list phone numbers:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
}

// ─── POST /numbers/search ────────────────────────────────────────────────────

export const searchNumbersSchema = z.object({
  areacode: z.string().regex(/^\d{3}$/, 'areacode must be a 3-digit area code').optional(),
  type: z.enum(['local', 'tollfree']).optional(),
});

// The NANPA toll-free prefixes. CTM treats one of these in `areacode` as a
// toll-free search in its own right, so it is safe to keep alongside
// searchby=tollfree (833 has inventory; 800 is exhausted).
const TOLL_FREE_AREA_CODES = new Set(['800', '833', '844', '855', '866', '877', '888']);

/** Map our API's `type` onto CTM's actual search vocabulary.
 *
 *  CTM has no `type` parameter - it ignores the key and leaves the search on
 *  its searchby=area default, which returns LOCAL numbers. Toll-free must be
 *  asked for as searchby=tollfree, and a LOCAL areacode sent alongside it
 *  flips CTM back to an area search, so it is dropped. */
export function toCtmSearchParams(body: { areacode?: string; type?: 'local' | 'tollfree' }): {
  searchby?: string;
  areacode?: string;
} {
  if (body.type !== 'tollfree') {
    return body.areacode ? { areacode: body.areacode } : {};
  }
  return {
    searchby: 'tollfree',
    ...(body.areacode && TOLL_FREE_AREA_CODES.has(body.areacode) ? { areacode: body.areacode } : {}),
  };
}

// No pricing key survives, under any spelling (price, cost, monthly_price,
// setup_cost, …) — plan §2's "no price in response".
const PRICING_KEY = /price|cost/i;
function stripPricing(item: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(item).filter(([key]) => !PRICING_KEY.test(key)));
}

export async function searchNumbers(req: Request, res: Response) {
  try {
    const accountId = await requireCtmAccount(req, res);
    if (!accountId) return;

    const items = await ctmSearchNumbers(accountId, toCtmSearchParams(req.body));
    res.json({ numbers: items.map(stripPricing) });
  } catch (err) {
    logger.error('Failed to search CTM numbers:', err);
    if (err instanceof CtmApiError) {
      res.status(502).json({ error: 'The phone system request failed' });
      return;
    }
    res.status(500).json({ error: 'Internal server error' });
  }
}

// ─── POST /numbers/buy ───────────────────────────────────────────────────────

export const buyNumberSchema = z.object({
  phone_number: z.string().trim().min(1).max(40),
  // Routing is mandatory at purchase — an unrouted tracking number would
  // silently eat calls (plan §4 "buy → mandatory routing"). The forward
  // destination is what actually routes: CTM registers it as a receiving
  // number and the TPN dial-routes to it.
  forward_to_e164: z
    .string()
    .trim()
    .min(1)
    .max(40)
    .refine((v) => normalizeNAPhone(v) !== null, {
      message: 'forward_to_e164 must be a North-American phone number (e.g. +12015551234)',
    }),
  // Optional org metadata only — the CRM's CallFlow is a label, not CTM config.
  call_flow_id: z.string().uuid('call_flow_id must be a valid id').optional(),
});

// CTM signals "someone else grabbed it" with reason text, not a stable code.
const NUMBER_GONE = /unavailab|duplicate|already|taken/i;

export async function buyNumber(req: Request, res: Response) {
  try {
    const accountId = await requireCtmAccount(req, res);
    if (!accountId) return;
    const orgId = req.user!.organization_id;
    const warnings: string[] = [];

    // Validated by the schema — normalize to strict E.164 for CTM.
    const forwardTo = normalizeNAPhone(String(req.body.forward_to_e164))!;

    // Optional metadata: when a flow IS named it must be one of OUR org's call
    // flows (foreign/missing → 404, before any money-adjacent CTM call).
    let flow: { id: string } | null = null;
    if (req.body.call_flow_id) {
      flow = await prisma.callFlow.findFirst({
        where: { id: req.body.call_flow_id, ...tenantWhere(req) },
        select: { id: true },
      });
      if (!flow) {
        res.status(404).json({ error: 'Call flow not found' });
        return;
      }
    }

    // test:true unless real purchasing is EXPLICITLY armed. NODE_ENV is not a
    // safe discriminator: Render sets NODE_ENV=production on every service,
    // staging included, which would place a real billed order from a QA click
    // (live QA finding, 2026-07-21). Only CTM_PURCHASE_LIVE=true — set on the
    // production service at go-live — disarms the CTM test flag.
    const purchased = await ctmBuyNumber(accountId, {
      phone_number: req.body.phone_number,
      test: process.env.CTM_PURCHASE_LIVE !== 'true',
    });
    const tpnId = purchased.id !== undefined && purchased.id !== null ? String(purchased.id) : null;

    // Defence in depth, independent of the provider's response shape: only a
    // genuine E.164 string may become a row. A non-string (the provider once
    // returned the whole number object here) would otherwise stringify to
    // "[object Object]" and be persisted as the org's number, because `??`
    // only catches null. Fall back to the number the caller asked to buy,
    // which the schema already validated.
    const returnedNumber = purchased.number;
    const e164 =
      typeof returnedNumber === 'string' && /^\+[1-9]\d{6,14}$/.test(returnedNumber)
        ? returnedNumber
        : String(req.body.phone_number);

    // SMS enablement is best-effort: 404/406 map to typed outcomes that become
    // warnings — a texting hiccup must never fail a completed purchase.
    let smsEnabled = false;
    if (tpnId) {
      try {
        const outcome = await enableSms(accountId, tpnId);
        smsEnabled = outcome === 'ok' || outcome === 'alreadyenabled';
        if (!smsEnabled) warnings.push(`Number ${e164}: SMS not enabled (${outcome}).`);
      } catch {
        warnings.push(`Number ${e164}: SMS enablement check failed.`);
      }
    } else {
      warnings.push(
        `Number ${e164}: the phone system did not return a tracking-number id — SMS not enabled.`,
      );
    }

    // Mandatory routing (plan §4 "buy → mandatory routing"): register the
    // forward destination as a receiving number (tolerate "already exists" —
    // re-registering the same phone is CTM's duplicate signal, not a failure)
    // then dial-route the new TPN to it. A routing failure must NEVER lose the
    // purchased row — surface it as a warning and leave route_to NULL so the
    // owner can finish routing in CTM.
    let routeTo: { forward_to: string } | null = null;
    if (tpnId) {
      try {
        try {
          await createReceivingNumber(accountId, forwardTo);
        } catch (err) {
          const alreadyExists =
            err instanceof CtmApiError && /already|exist|duplicate|taken/i.test(err.reason);
          if (!alreadyExists) throw err;
        }
        await updateNumberRouting(accountId, tpnId, { dial_route: 'forward', numbers: [forwardTo] });
        routeTo = { forward_to: forwardTo };
      } catch (err) {
        const reason = err instanceof CtmApiError ? err.reason : 'request failed';
        logger.warn(`[ctm] routing new number ${e164} failed: ${reason}`);
        warnings.push(`Number purchased but routing failed — contact support to finish setup.`);
      }
    } else {
      warnings.push(`Number purchased but routing failed — contact support to finish setup.`);
    }

    // Upsert on (org, e164) — the composite unique doubles as double-buy
    // protection (route_to stays SQL NULL until routing lands).
    const row = await prisma.phoneNumber.upsert({
      where: { organization_id_e164: { organization_id: orgId, e164 } },
      create: {
        e164,
        formatted: typeof purchased.formatted === 'string' ? purchased.formatted : null,
        source: 'ctm',
        ctm_number_id: tpnId,
        call_flow_id: flow?.id ?? null,
        route_to: routeTo ?? undefined,
        sms_enabled: smsEnabled,
        status: 'active',
        organization_id: orgId,
      },
      update: {
        ctm_number_id: tpnId,
        ...(flow ? { call_flow_id: flow.id } : {}),
        ...(routeTo ? { route_to: routeTo } : {}),
        sms_enabled: smsEnabled,
        status: 'active',
      },
    });

    void logAudit({
      req,
      action: 'number.purchased',
      resourceType: 'PhoneNumber',
      resourceId: row.id,
      metadata: {
        e164,
        ctm_number_id: tpnId,
        forward_to: routeTo?.forward_to ?? null,
        call_flow_id: flow?.id ?? null,
      },
    });

    res.status(201).json({ number: mapNumber(row), warnings });
  } catch (err) {
    if (err instanceof CtmApiError) {
      if (err.httpStatus === 409 || NUMBER_GONE.test(err.reason)) {
        // Someone else bought it between search and buy — typed so the UI can
        // say "pick another" instead of a generic failure.
        res.status(409).json({
          error: 'That number is no longer available',
          code: 'NUMBER_UNAVAILABLE',
        });
        return;
      }
      logger.error('CTM number purchase failed:', err);
      res.status(502).json({ error: 'The phone system request failed' });
      return;
    }
    logger.error('Failed to buy number:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
}

// ─── PATCH /numbers/:id ──────────────────────────────────────────────────────

export const updateNumberSchema = z.object({
  call_flow_id: z.string().uuid('call_flow_id must be a valid id').nullable(),
});

export async function updateNumber(req: Request, res: Response) {
  try {
    const row = await prisma.phoneNumber.findFirst({
      where: { id: req.params.id as string, ...tenantWhere(req) },
      select: { id: true },
    });
    if (!row) {
      res.status(404).json({ error: 'Number not found' });
      return;
    }

    if (req.body.call_flow_id != null) {
      const flow = await prisma.callFlow.findFirst({
        where: { id: req.body.call_flow_id, ...tenantWhere(req) },
        select: { id: true },
      });
      if (!flow) {
        res.status(404).json({ error: 'Call flow not found' });
        return;
      }
    }

    // call_flow_id is the ONLY writable field on this route.
    const updated = await prisma.phoneNumber.update({
      where: { id: row.id },
      data: { call_flow_id: req.body.call_flow_id },
    });
    res.json({ number: mapNumber(updated) });
  } catch (err) {
    logger.error('Failed to update phone number:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
}

// ─── POST /numbers/register-byo ──────────────────────────────────────────────

export const registerByoSchema = z.object({
  e164: z.string().trim().regex(/^\+[1-9]\d{6,14}$/, 'e164 must be E.164 (e.g. +12015551234)'),
  label: z.string().trim().min(1).max(200).optional(),
});

/** Register a bring-your-own number (v1.1 UI; backend-only for now). Pure DB
 *  row — no CTM calls; SMS stays off until the number is CTM-tracked. */
export async function registerByoNumber(req: Request, res: Response) {
  try {
    const row = await prisma.phoneNumber.create({
      data: {
        e164: req.body.e164,
        label: req.body.label ?? null,
        source: 'byo',
        sms_enabled: false,
        status: 'active',
        organization_id: req.user!.organization_id,
      },
    });
    res.status(201).json({ number: mapNumber(row) });
  } catch (err) {
    if ((err as { code?: string }).code === 'P2002') {
      res.status(409).json({ error: 'This number is already registered' });
      return;
    }
    logger.error('Failed to register BYO number:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
}
