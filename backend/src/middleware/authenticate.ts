import { Request, Response, NextFunction } from 'express';
import { supabaseAdmin } from '../lib/supabase';
import { resolveAppUser } from '../lib/auth-user';
import { runWithOrg, runUnscoped } from '../lib/tenant-context';
import { logger } from '../lib/logger';

interface CachedAuth {
  user: {
    id: string;
    email: string;
    first_name: string;
    last_name: string;
    role: string;
    // SRVW-138: MUST travel with the base role - grantRoleKey/isSuperUser read these off
    // req.user on every request, cached copy included. Dropping them here silently
    // resolves every custom-role user's grants as their (possibly wider) base role.
    custom_role_id?: string | null;
    custom_role?: { key: string } | null;
    has_login: boolean;
    organization_id: string;
    org_is_demo: boolean;
    org_plan: string;
    org_features: string[];
    department_id?: string | null;
    location_id?: string | null;
    phone?: string | null;
    phone_ext?: string | null;
  };
  expiresAt: number;
}

const TOKEN_TTL_MS = 60 * 1000; // 60 seconds
const EVICTION_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes

const tokenCache = new Map<string, CachedAuth>();

// Evict expired entries every 5 minutes
setInterval(() => {
  const now = Date.now();
  for (const [token, entry] of tokenCache) {
    if (entry.expiresAt <= now) {
      tokenCache.delete(token);
    }
  }
}, EVICTION_INTERVAL_MS).unref();

/**
 * Clear the token cache.
 * If userId is provided, only evict entries for that user.
 * If omitted, clear the entire cache (useful in tests).
 */
export function clearTokenCache(userId?: string): void {
  if (userId === undefined) {
    tokenCache.clear();
    return;
  }
  for (const [token, entry] of tokenCache) {
    if (entry.user.id === userId) {
      tokenCache.delete(token);
    }
  }
}

export async function authenticate(req: Request, res: Response, next: NextFunction) {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith('Bearer ')) {
    res.status(401).json({ error: 'Missing or invalid authorization header' });
    return;
  }

  const token = authHeader.substring(7);

  try {
    // Cache hit: skip both Supabase and Prisma calls
    const cached = tokenCache.get(token);
    if (cached && cached.expiresAt > Date.now()) {
      req.user = cached.user as typeof req.user;
      // Scope the rest of the request to this org for the DB RLS backstop.
      runWithOrg(cached.user.organization_id, () => next());
      return;
    }

    // Cache miss: verify token with Supabase then fetch user from DB
    const { data, error } = await supabaseAdmin.auth.getUser(token);
    if (error || !data.user) {
      res.status(401).json({ error: 'Invalid or expired token' });
      return;
    }

    // The bootstrap lookup runs before any org context exists, so it must be
    // unscoped or RLS on `users` would hide the very row we're authenticating.
    const user = await runUnscoped(() => resolveAppUser(data.user));

    if (!user) {
      res.status(401).json({ error: 'User not found' });
      return;
    }

    if (!user.is_active) {
      res.status(403).json({ error: 'Account is deactivated' });
      return;
    }

    const authUser = {
      id: user.id,
      email: user.email,
      first_name: user.first_name,
      last_name: user.last_name,
      role: user.role,
      custom_role_id: user.custom_role_id,
      custom_role: user.custom_role,
      has_login: user.has_login,
      organization_id: user.organization_id,
      org_is_demo: user.org_is_demo,
      org_plan: user.org_plan,
      org_features: user.org_features,
      department_id: user.department_id,
      location_id: user.location_id,
      phone: user.phone,
      phone_ext: user.phone_ext,
    };

    // Store in cache for subsequent requests
    tokenCache.set(token, {
      user: authUser,
      expiresAt: Date.now() + TOKEN_TTL_MS,
    });

    req.user = authUser as typeof req.user;
    // Scope the rest of the request to this org for the DB RLS backstop.
    runWithOrg(authUser.organization_id, () => next());
  } catch (err) {
    logger.error('Authentication error:', err);
    res.status(401).json({ error: 'Authentication failed' });
  }
}
