import { Request, Response, NextFunction } from 'express';
import { prisma } from '../lib/prisma';
import { defineAbilityFor } from '../lib/permissions/defineAbility';
import { getCachedGrants, setCachedGrants } from '../lib/permissions/permissionCache';
import { loadUserOverrides } from '../lib/permissions/loadUserOverrides';
import { grantRoleKey, isSuperUser } from '../lib/permissions/effectiveRole';
import { logger } from '../lib/logger';

export async function attachAbility(req: Request, res: Response, next: NextFunction) {
  if (!req.user) {
    res.status(401).json({ error: 'Not authenticated' });
    return;
  }

  // SRVW-138: an ADMIN-DERIVED custom role is not a superuser - it must load and apply its
  // grants like any other role, so only an unrestricted ADMIN skips the DB read here.
  if (isSuperUser(req.user)) {
    req.ability = defineAbilityFor(req.user, []);
    next();
    return;
  }

  const { organization_id } = req.user;

  try {
    // Grants live under the CUSTOM role's key when the user holds one, else the base role
    // name. grantRoleKey throws if custom_role_id is set but the relation was not loaded -
    // the catch below turns that into a 500, which denies access rather than silently
    // falling back to the (possibly wider) base role.
    const role = grantRoleKey(req.user);
    let grants = getCachedGrants(organization_id, role);
    if (!grants) {
      const rows = await prisma.rolePermission.findMany({
        where: { organization_id, role },
        select: { action: true, subject: true, conditions: true },
      });
      grants = rows.map(r => ({
        action: r.action,
        subject: r.subject,
        conditions: r.conditions as Record<string, unknown> | null,
      }));
      setCachedGrants(organization_id, role, grants);
    }

    // Per-user overrides (RBAC Phase 2) layer on top of the role grant. Fetched outside the
    // per-org-per-role grant cache (it's keyed by user_id, separate cache).
    const overrides = await loadUserOverrides(req.user.id);
    req.ability = defineAbilityFor(req.user, grants, overrides);
    next();
  } catch (err) {
    logger.error('attachAbility error:', err);
    res.status(500).json({ error: 'Failed to load permissions' });
  }
}
