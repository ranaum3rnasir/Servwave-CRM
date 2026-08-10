import type { Request } from 'express';
import { prisma } from '../prisma';
import { tenantWhere } from '../tenant';
import { scopeWhereForReq } from '../permissions/enforce';
import type { ScopeResource } from '../permissions/scopeWhereFor';

export interface TaskListFilters { linked_entity_type?: string; linked_entity_id?: string; }

export function taskVisibilityWhere(req: Request, filters: TaskListFilters): Record<string, unknown> {
  const where: Record<string, unknown> = { ...tenantWhere(req) };
  if (filters.linked_entity_type && filters.linked_entity_id) {
    where.linked_entity_type = filters.linked_entity_type;
    where.linked_entity_id = filters.linked_entity_id;
    return where;
  }
  if (req.user!.role !== 'ADMIN') {
    const me = req.user!.id;
    where.OR = [{ owner_id: me }, { created_by: me }, { watcher_ids: { has: me } }];
  }
  return where;
}

/**
 * Minimal delegate slice for the row probe — `any` for the same contravariance reason as
 * enforce.ts's RowDelegate: concrete Prisma delegates type `where` as their model-specific
 * WhereInput, which is not assignable to a narrower `{ where: unknown }` parameter.
 */
type RowDelegate = {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  findFirst(args: any): Promise<{ id: string } | null>;
};

/**
 * SQL row check for a task's polymorphic link (#245): can the caller access the linked
 * entity? For JOB/LEAD/ESTIMATE this is one tenant + existence + grant-derived-scope
 * findFirst (the canAccessRow pattern — nested-safe in SQL where @casl/prisma's in-memory
 * matcher throws). CUSTOMER is not a ScopeResource and its grants are subject-level
 * (unconditional for SALES/DISPATCHER, absent for TECHNICIAN), so it checks the CASL
 * subject grant plus a tenant-scoped existence probe. Unknown types fail closed.
 */
export async function canAccessLinkedEntity(
  req: Request,
  type: string,
  id: string,
): Promise<boolean> {
  const scoped: Record<string, { resource: ScopeResource; delegate: RowDelegate }> = {
    JOB:      { resource: 'Job',      delegate: prisma.job },
    LEAD:     { resource: 'Lead',     delegate: prisma.lead },
    ESTIMATE: { resource: 'Estimate', delegate: prisma.estimate },
  };
  const entry = scoped[type];
  if (entry) {
    const scope = await scopeWhereForReq(req, entry.resource);
    const where = { id, ...tenantWhere(req), ...scope };
    return !!(await entry.delegate.findFirst({ where, select: { id: true } }));
  }
  if (type === 'CUSTOMER') {
    if (!req.ability?.can('read', 'Customer')) return false;
    return !!(await prisma.customer.findFirst({
      where: { id, ...tenantWhere(req) },
      select: { id: true },
    }));
  }
  return false; // unknown linked type — fail closed
}

/**
 * Per-row (own-or-linked) access policy for a loaded task (#245):
 *   ADMIN → always; principal (owner / creator / watcher) → always;
 *   otherwise linked → the caller must be able to access the linked entity;
 *   unlinked non-principal → denied.
 * Reads only fields the handlers' existing tenant findFirst already loaded.
 */
export async function canAccessTask(
  req: Request,
  task: {
    owner_id: string | null;
    created_by: string;
    watcher_ids: unknown;
    linked_entity_type: string | null;
    linked_entity_id: string | null;
  },
): Promise<boolean> {
  if (req.user!.role === 'ADMIN') return true;
  const me = req.user!.id;
  if (task.owner_id === me || task.created_by === me) return true;
  if (Array.isArray(task.watcher_ids) && (task.watcher_ids as string[]).includes(me)) return true;
  if (task.linked_entity_type && task.linked_entity_id) {
    return canAccessLinkedEntity(req, task.linked_entity_type, task.linked_entity_id);
  }
  return false;
}
