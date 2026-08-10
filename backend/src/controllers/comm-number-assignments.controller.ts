import { Request, Response } from 'express';
import { z } from 'zod';
import { prisma } from '../lib/prisma';
import { logger } from '../lib/logger';
import { tenantWhere } from '../lib/tenant';
import { logAudit } from '../lib/audit';
import { isCtmConfigured } from '../lib/ctm/client';
import {
  ensureVoicemailMenu,
  routeNumberToVoiceMenu,
  describeManualQueueScaffold,
  type ManualQueueScaffoldInstructions,
} from '../lib/ctm/routing';
import { formatPhoneDisplay } from '../lib/phone-format';

// Admin management of the many-to-many User<->PhoneNumber mapping (comm caller-ID
// overhaul slice 3). These endpoints populate what resolveOutboundNumber (slice 2)
// reads: which users may send from which numbers, each user's default, and the
// org default. Every handler is admin-gated (canDo('update','Organization')) and
// tenant-scoped — a number/user outside the caller's org is a 404.

function userName(u: { first_name: string | null; last_name: string | null }): string {
  return [u.first_name, u.last_name].filter(Boolean).join(' ') || 'User';
}

// ─── Task D2: CTM inbound-routing sync ───────────────────────────────────────
//
// A number gaining an assignment (or becoming the org default) is the moment
// ServWave knows CTM needs to be told where that number's calls should land.
// Only the CONFIRMED-automatable half is called here — voicemail voice-menu
// creation + the number's dial_routes PUT (`lib/ctm/routing.ts`'s
// `ensureVoicemailMenu` / `routeNumberToVoiceMenu`). The Queue/Agent ring-config
// half isn't confirmed API-drivable, so `describeManualQueueScaffold` turns
// that gap into exact admin instructions instead of a silent no-op — see that
// file's header for the full CTM-API verification writeup.

/** A phone-number's routing-relevant columns (kept out of `select: {id:true}`
 *  everywhere else in this file so callers not doing a sync stay cheap). */
type RoutablePhoneNumber = {
  id: string;
  e164: string;
  label: string | null;
  ctm_number_id: string | null;
  route_to: unknown;
};

export type RoutingSyncResult =
  | {
      synced: true;
      voice_menu_id: string;
      voice_menu_name: string;
      manual_scaffold: ManualQueueScaffoldInstructions;
    }
  | { synced: false; reason: string };

/**
 * Establishes the voicemail fallback for `number` and returns the manual
 * scaffold instructions for the rest. Best-effort, mirroring buyNumber's
 * routing-failure handling (comm-numbers.controller.ts): a CTM hiccup — or an
 * org/number that isn't CTM-connected (e.g. a BYO number, or CTM simply not
 * configured in this environment) — must never fail the assignment write that
 * already committed. It degrades to `{synced:false, reason}` for the caller
 * to surface as a warning instead.
 *
 * Idempotent from our side: `route_to.voice_menu_id`, once persisted, is
 * passed back in as `existingId` so re-running this (e.g. editing an
 * assignment set that already had a voice menu) never double-creates one —
 * `ensureVoicemailMenu` no-ops the POST and just re-confirms the dial route.
 */
async function syncInboundRouting(
  req: Request,
  number: RoutablePhoneNumber,
  ctmAgentName: string | undefined,
): Promise<RoutingSyncResult> {
  if (!isCtmConfigured()) {
    return { synced: false, reason: 'The phone system is not configured for this environment.' };
  }
  if (!number.ctm_number_id) {
    return {
      synced: false,
      reason: 'This is a bring-your-own number (not provisioned here) — nothing to sync.',
    };
  }

  const org = await prisma.organization.findUnique({
    where: { id: req.user!.organization_id },
    select: { ctm_account_id: true },
  });
  if (!org?.ctm_account_id) {
    return { synced: false, reason: 'Organization is not connected to a phone system.' };
  }

  const numberFormatted = formatPhoneDisplay(number.e164) || number.e164;
  const existing = (number.route_to ?? null) as { voice_menu_id?: string } | null;
  const voiceMenuName = ctmAgentName
    ? `${ctmAgentName} — Voicemail`
    : `${number.label || numberFormatted} — Voicemail`;

  try {
    const voiceMenuId = await ensureVoicemailMenu(org.ctm_account_id, {
      name: voiceMenuName,
      existingId: existing?.voice_menu_id,
    });
    await routeNumberToVoiceMenu(org.ctm_account_id, number.ctm_number_id, voiceMenuId);

    // Persist onto PhoneNumber.route_to — the same JSON column buyNumber
    // already uses to record "what this TPN's dial route currently targets"
    // (there `{forward_to}`, here `{voice_menu_id, voice_menu_name}`); no new
    // column needed.
    await prisma.phoneNumber.update({
      where: { id: number.id },
      data: { route_to: { voice_menu_id: voiceMenuId, voice_menu_name: voiceMenuName } },
    });

    const manualScaffold = describeManualQueueScaffold({
      ctmAgentName,
      voiceMenuId,
      voiceMenuName,
      numberFormatted,
    });

    return {
      synced: true,
      voice_menu_id: voiceMenuId,
      voice_menu_name: voiceMenuName,
      manual_scaffold: manualScaffold,
    };
  } catch (err) {
    logger.warn(
      `[ctm] inbound routing sync failed for number ${number.id}: ${err instanceof Error ? err.message : String(err)}`,
    );
    return {
      synced: false,
      reason: 'Syncing inbound routing failed — contact support to finish setting it up.',
    };
  }
}

// ─── GET /number-assignments ─────────────────────────────────────────────────
export async function listNumberAssignments(req: Request, res: Response) {
  try {
    const [numbers, users] = await Promise.all([
      prisma.phoneNumber.findMany({
        where: tenantWhere(req),
        orderBy: { created_at: 'asc' },
        select: {
          id: true,
          e164: true,
          label: true,
          is_org_default: true,
          user_links: {
            select: {
              user_id: true,
              is_default: true,
              user: { select: { id: true, first_name: true, last_name: true } },
            },
          },
        },
      }),
      prisma.user.findMany({
        where: { ...tenantWhere(req), is_active: true },
        orderBy: [{ first_name: 'asc' }, { last_name: 'asc' }],
        select: { id: true, first_name: true, last_name: true },
      }),
    ]);

    res.json({
      numbers: numbers.map((n) => ({
        id: n.id,
        e164: n.e164,
        label: n.label,
        is_org_default: n.is_org_default,
        assignments: n.user_links.map((l) => ({
          user_id: l.user_id,
          user_name: userName(l.user),
          is_default: l.is_default,
        })),
      })),
      users: users.map((u) => ({ id: u.id, name: userName(u) })),
    });
  } catch (err) {
    logger.error('Failed to list number assignments:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
}

// ─── PUT /numbers/:id/assignments ────────────────────────────────────────────
export const setAssignmentsSchema = z.object({
  user_ids: z.array(z.string().uuid()).max(200),
});

export async function setNumberAssignments(req: Request, res: Response) {
  try {
    const numberId = req.params.id as string;
    const number = await prisma.phoneNumber.findFirst({
      where: { id: numberId, ...tenantWhere(req) },
      select: { id: true, e164: true, label: true, ctm_number_id: true, route_to: true },
    });
    if (!number) {
      res.status(404).json({ error: 'Phone number not found' });
      return;
    }

    // Dedupe first: user_ids is a SET (the assignment set). Comparing a raw
    // count of distinct in-org rows against a list length would falsely 400 on a
    // repeated id, so collapse repeats before the membership check.
    const userIds: string[] = [...new Set<string>(req.body.user_ids)];
    if (userIds.length > 0) {
      // Tenant safety: every user assigned to an org number must be in the org.
      const inOrg = await prisma.user.count({ where: { id: { in: userIds }, ...tenantWhere(req) } });
      if (inOrg !== userIds.length) {
        res.status(400).json({ error: 'One or more users are not in your organization' });
        return;
      }
    }

    await prisma.$transaction(async (tx) => {
      // Drop links that are no longer wanted (a removed link that held is_default
      // just disappears → that user falls back to the org default). Retained links
      // are preserved via createMany skipDuplicates, keeping their is_default flag.
      await tx.userPhoneNumber.deleteMany({
        where: { phone_number_id: numberId, ...(userIds.length ? { user_id: { notIn: userIds } } : {}) },
      });
      if (userIds.length) {
        await tx.userPhoneNumber.createMany({
          data: userIds.map((uid) => ({ user_id: uid, phone_number_id: numberId })),
          skipDuplicates: true,
        });
      }
    });

    // Inbound-routing sync (Task D2): only when the number now HAS at least
    // one assigned user. Unassigning down to zero users deliberately makes NO
    // CTM call — there is no confirmed API to safely tear down the Queue-side
    // config (see lib/ctm/routing.ts's header), so the safest thing to do is
    // leave the existing voicemail dial-route in place: worst case, the
    // number still reaches voicemail instead of ringing nobody. A future
    // reassignment re-syncs it (idempotently) regardless.
    let routing: RoutingSyncResult | null = null;
    if (userIds.length > 0) {
      // Only attach a concrete agent name to the manual-scaffold instructions
      // when the resulting set is exactly one user (a dedicated per-user
      // number) — a shared/team number falls back to the generic wording
      // `describeManualQueueScaffold` already handles.
      let ctmAgentName: string | undefined;
      if (userIds.length === 1) {
        const soleUser = await prisma.user.findFirst({
          where: { id: userIds[0], ...tenantWhere(req) },
          select: { first_name: true, last_name: true },
        });
        if (soleUser) ctmAgentName = userName(soleUser);
      }
      routing = await syncInboundRouting(req, number, ctmAgentName);
    }

    void logAudit({
      req,
      action: 'phone_number.assignments_updated',
      resourceType: 'PhoneNumber',
      resourceId: numberId,
      metadata: { user_ids: userIds, routing_synced: routing?.synced ?? null },
    });
    res.json({ ok: true, routing });
  } catch (err) {
    logger.error('Failed to set number assignments:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
}

// ─── PUT /users/:userId/default-number ───────────────────────────────────────
// No CTM routing sync here (Task D2): picking which of a user's ALREADY
// assigned numbers is their outbound default doesn't change which numbers are
// wired for inbound — that happened when the number was assigned via
// setNumberAssignments (or made the org default). This endpoint only affects
// resolveOutboundNumber's caller-ID choice.
export const setUserDefaultSchema = z.object({
  phone_number_id: z.string().uuid().nullable(),
});

export async function setUserDefaultNumber(req: Request, res: Response) {
  try {
    const userId = req.params.userId as string;
    const user = await prisma.user.findFirst({
      where: { id: userId, ...tenantWhere(req) },
      select: { id: true },
    });
    if (!user) {
      res.status(404).json({ error: 'User not found' });
      return;
    }

    const phoneNumberId: string | null = req.body.phone_number_id;
    if (phoneNumberId) {
      // The default must be a number the user is actually assigned to.
      const link = await prisma.userPhoneNumber.findUnique({
        where: { user_id_phone_number_id: { user_id: userId, phone_number_id: phoneNumberId } },
        select: { user_id: true },
      });
      if (!link) {
        res.status(400).json({ error: 'That number is not assigned to this user' });
        return;
      }
    }

    await prisma.$transaction(async (tx) => {
      // At most one default per user: clear the prior default, then set the new one.
      await tx.userPhoneNumber.updateMany({
        where: { user_id: userId, is_default: true },
        data: { is_default: false },
      });
      if (phoneNumberId) {
        await tx.userPhoneNumber.update({
          where: { user_id_phone_number_id: { user_id: userId, phone_number_id: phoneNumberId } },
          data: { is_default: true },
        });
      }
    });

    void logAudit({
      req,
      action: 'phone_number.user_default_set',
      resourceType: 'User',
      resourceId: userId,
      metadata: { phone_number_id: phoneNumberId },
    });
    res.json({ ok: true });
  } catch (err) {
    logger.error('Failed to set user default number:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
}

// ─── PUT /numbers/:id/org-default ────────────────────────────────────────────
export const setOrgDefaultSchema = z.object({
  is_org_default: z.boolean().optional(),
});

export async function setOrgDefaultNumber(req: Request, res: Response) {
  try {
    const numberId = req.params.id as string;
    const number = await prisma.phoneNumber.findFirst({
      where: { id: numberId, ...tenantWhere(req) },
      select: { id: true, e164: true, label: true, ctm_number_id: true, route_to: true },
    });
    if (!number) {
      res.status(404).json({ error: 'Phone number not found' });
      return;
    }

    const setDefault = req.body.is_org_default !== false; // default = set as org default

    await prisma.$transaction(async (tx) => {
      if (setDefault) {
        // At most one org default: clear the prior, then set this one.
        await tx.phoneNumber.updateMany({
          where: { ...tenantWhere(req), is_org_default: true },
          data: { is_org_default: false },
        });
        await tx.phoneNumber.update({ where: { id: numberId }, data: { is_org_default: true } });
      } else {
        await tx.phoneNumber.update({ where: { id: numberId }, data: { is_org_default: false } });
      }
    });

    // Inbound-routing sync (Task D2): only on SETTING the org default — it's
    // now the shared inbound fallback target, so it needs the voicemail
    // wiring. No `ctmAgentName` (the org default isn't one person's number),
    // so the manual-scaffold instructions use the generic wording.
    // UNSETTING makes no CTM call, same reasoning as setNumberAssignments'
    // unassign path: no confirmed API to safely revert Queue-side config, and
    // the voicemail route already in place is safe to leave — a number that
    // newly becomes org-default gets its own sync when THAT happens.
    const routing = setDefault ? await syncInboundRouting(req, number, undefined) : null;

    void logAudit({
      req,
      action: 'phone_number.org_default_set',
      resourceType: 'PhoneNumber',
      resourceId: numberId,
      metadata: { is_org_default: setDefault, routing_synced: routing?.synced ?? null },
    });
    res.json({ ok: true, routing });
  } catch (err) {
    logger.error('Failed to set org default number:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
}
