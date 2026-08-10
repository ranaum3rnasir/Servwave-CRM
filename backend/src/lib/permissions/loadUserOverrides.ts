import { prisma } from '../prisma';
import type { PermissionOverride } from './defineAbility';
import { getCachedUserOverrides, setCachedUserOverrides } from './userOverrideCache';

// Fetch a user's permission overrides (cache-or-DB), keyed by user_id with a short TTL.
// ADMIN is `manage all` and is unaffected by overrides, so callers skip this for admins
// (avoids a per-request query for the superuser path).
export async function loadUserOverrides(userId: string): Promise<PermissionOverride[]> {
  const cached = getCachedUserOverrides(userId);
  if (cached) return cached;

  const rows = await prisma.userPermissionOverride.findMany({
    where: { user_id: userId },
    select: { action: true, subject: true, effect: true },
  });
  const overrides: PermissionOverride[] = rows.map((r) => ({
    action: r.action,
    subject: r.subject,
    effect: r.effect === 'deny' ? 'deny' : 'allow',
  }));

  setCachedUserOverrides(userId, overrides);
  return overrides;
}
