import { Request, Response } from 'express';
import { z } from 'zod';
import { LeadStatus } from '@prisma/client';
import { prisma } from '../lib/prisma';
import { logger } from '../lib/logger';
import { tenantWhere } from '../lib/tenant';

/**
 * SRVW-111 (label-override shape, per Ran's 2026-08-05 scope call) - per-org display overrides
 * for the FIXED LeadStatus enum: rename, reorder, hide, and pick which status a new lead
 * defaults to. Does NOT widen LeadStatus and does NOT let an org add a new value - Servy's
 * advertised lead vocabulary (statusVocabulary('lead') in copilot/tools/toolRegistry.ts) stays
 * the enum, unchanged.
 *
 * Structurally unlike job_sub_statuses (SRVW-112): that is a user-created catalog of unbounded
 * rows under a fixed parent. This is at most 6 CONFIG rows, one per fixed enum member, upserted
 * lazily - an org with zero rows simply uses the enum's own declaration order and labels, with
 * NEW as the implicit default. A lazily-created row's sort_order defaults to that status's OWN
 * declaration index (not 0), so a GET before and after a single PATCH sorts identically until a
 * real reorder touches it.
 */

const LEAD_STATUSES = Object.values(LeadStatus);
const DECLARATION_INDEX: Record<LeadStatus, number> = Object.fromEntries(
  LEAD_STATUSES.map((s, i) => [s, i]),
) as Record<LeadStatus, number>;

export const updateLeadStatusOverrideSchema = z
  .object({
    // Explicit null clears a prior rename back to the enum's own label; omitted = don't touch.
    label: z.string().min(1).max(60).transform((s) => s.trim()).nullable().optional(),
    hidden: z.boolean().optional(),
  })
  .strict();

export const reorderLeadStatusOverridesSchema = z.object({
  ordered_statuses: z
    .array(z.nativeEnum(LeadStatus))
    .length(LEAD_STATUSES.length)
    .refine((arr) => new Set(arr).size === arr.length, { message: 'Duplicate status in reorder list' })
    .refine((arr) => LEAD_STATUSES.every((s) => arr.includes(s)), { message: 'Every LeadStatus must be present' }),
});

function param(req: Request, name: string): string {
  return req.params[name] as string;
}

interface OverrideRow {
  status: LeadStatus;
  label: string | null;
  sort_order: number;
  is_default: boolean;
  hidden: boolean;
}

/** Every LeadStatus value merged with this org's stored rows, sorted by sort_order. NEW is the
 *  implicit default only when NO row anywhere claims is_default - matches a fresh org exactly. */
async function mergedOverrides(req: Request): Promise<OverrideRow[]> {
  const rows = await prisma.leadStatusOverride.findMany({ where: tenantWhere(req) });
  const byStatus = new Map(rows.map((r) => [r.status, r]));
  const anyDefaultClaimed = rows.some((r) => r.is_default);

  const merged: OverrideRow[] = LEAD_STATUSES.map((status) => {
    const row = byStatus.get(status);
    return {
      status,
      label: row?.label ?? null,
      sort_order: row?.sort_order ?? DECLARATION_INDEX[status],
      is_default: row ? row.is_default : !anyDefaultClaimed && status === 'NEW',
      hidden: row?.hidden ?? false,
    };
  });
  merged.sort((a, b) => a.sort_order - b.sort_order);
  return merged;
}

/** GET /api/lead-status-overrides - all 6 statuses, merged, sorted, org-scoped. */
export async function list(req: Request, res: Response) {
  try {
    const lead_status_overrides = await mergedOverrides(req);
    res.json({ lead_status_overrides });
  } catch (err) {
    logger.error('List lead status overrides error:', err);
    res.status(500).json({ error: 'Failed to list lead status overrides' });
  }
}

/** PATCH /api/lead-status-overrides/:status - rename and/or hide. The enum member itself is
 *  immutable; only its display is configurable. */
export async function update(req: Request, res: Response) {
  try {
    const statusParam = param(req, 'status');
    if (!LEAD_STATUSES.includes(statusParam as LeadStatus)) {
      res.status(400).json({ error: 'Unknown lead status' });
      return;
    }
    const status = statusParam as LeadStatus;
    const { label, hidden } = req.body as z.infer<typeof updateLeadStatusOverrideSchema>;

    if (hidden === true) {
      const current = await mergedOverrides(req);
      const isDefault = current.find((s) => s.status === status)?.is_default ?? false;
      if (isDefault) {
        res.status(400).json({ error: 'Cannot hide the status new leads default to - pick a different default first' });
        return;
      }
    }

    const data: { label?: string | null; hidden?: boolean } = {};
    if (label !== undefined) data.label = label;
    if (hidden !== undefined) data.hidden = hidden;

    const lead_status_override = await prisma.leadStatusOverride.upsert({
      where: { organization_id_status: { organization_id: req.user!.organization_id, status } },
      create: {
        organization_id: req.user!.organization_id,
        status,
        label: label ?? null,
        sort_order: DECLARATION_INDEX[status],
        hidden: hidden ?? false,
      },
      update: data,
    });
    res.json({ lead_status_override });
  } catch (err) {
    logger.error('Update lead status override error:', err);
    res.status(500).json({ error: 'Failed to update lead status override' });
  }
}

/** POST /api/lead-status-overrides/:status/default - exclusive: clears every other org row's
 *  is_default before setting this one, in one transaction. */
export async function setDefault(req: Request, res: Response) {
  try {
    const statusParam = param(req, 'status');
    if (!LEAD_STATUSES.includes(statusParam as LeadStatus)) {
      res.status(400).json({ error: 'Unknown lead status' });
      return;
    }
    const status = statusParam as LeadStatus;
    const orgId = req.user!.organization_id;

    const current = await mergedOverrides(req);
    if (current.find((s) => s.status === status)?.hidden) {
      res.status(400).json({ error: 'Cannot default new leads to a hidden status' });
      return;
    }

    const lead_status_override = await prisma.$transaction(async (tx) => {
      await tx.leadStatusOverride.updateMany({
        where: { organization_id: orgId, NOT: { status } },
        data: { is_default: false },
      });
      return tx.leadStatusOverride.upsert({
        where: { organization_id_status: { organization_id: orgId, status } },
        create: { organization_id: orgId, status, sort_order: DECLARATION_INDEX[status], is_default: true },
        update: { is_default: true },
      });
    });
    res.json({ lead_status_override });
  } catch (err) {
    logger.error('Set default lead status error:', err);
    res.status(500).json({ error: 'Failed to set default lead status' });
  }
}

/** POST /api/lead-status-overrides/reorder - rewrite sort_order for all 6, upserting any row
 *  that has never been customized before. */
export async function reorder(req: Request, res: Response) {
  try {
    const { ordered_statuses } = req.body as z.infer<typeof reorderLeadStatusOverridesSchema>;
    const orgId = req.user!.organization_id;

    await prisma.$transaction(
      ordered_statuses.map((status, i) =>
        prisma.leadStatusOverride.upsert({
          where: { organization_id_status: { organization_id: orgId, status } },
          create: { organization_id: orgId, status, sort_order: i },
          update: { sort_order: i },
        }),
      ),
    );
    res.status(204).send();
  } catch (err) {
    logger.error('Reorder lead status overrides error:', err);
    res.status(500).json({ error: 'Failed to reorder lead status overrides' });
  }
}
