import type { LeadStatus, PrismaClient } from '@prisma/client';

/**
 * SRVW-111 (label-override shape) - the one status write this feature touches beyond display:
 * which LeadStatus a new lead starts at. `Lead.status` keeps its DB-level `@default(NEW)` as the
 * safety net (never removed), but lead.controller.ts's create() calls this to set the field
 * explicitly whenever the org has configured a different default via
 * POST /api/lead-status-overrides/:status/default.
 */
export async function resolveDefaultLeadStatus(
  client: Pick<PrismaClient, 'leadStatusOverride'>,
  organizationId: string,
): Promise<LeadStatus> {
  const row = await client.leadStatusOverride.findFirst({
    where: { organization_id: organizationId, is_default: true },
    select: { status: true },
  });
  return row?.status ?? 'NEW';
}
