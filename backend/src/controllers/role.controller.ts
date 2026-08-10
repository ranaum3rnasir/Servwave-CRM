import { Request, Response } from 'express';
import { z } from 'zod';
import { Prisma, Role } from '@prisma/client';
import { prisma } from '../lib/prisma';
import { tenantWhere } from '../lib/tenant';
import { logger } from '../lib/logger';
import { DEFAULT_GRANTS } from '../lib/permissions/defaultGrants';
import { clearPermissionCache } from '../lib/permissions/permissionCache';
import {
  assembleRoleViewModel,
  viewModelToGrants,
  MODULES,
  SENSITIVE,
  TOGGLES,
  isRepresentableScopeCondition,
  type RoleViewModel,
  type ToggleKey,
} from '../lib/permissions/roleViewModel';
import { writeSettingsAudit, logAudit } from '../lib/audit';
import { isCatalogEntry } from '../lib/permissions/catalog';
import { SYSTEM_ROLE_NAMES, isReservedRoleKey, slugifyRoleKey } from '../lib/permissions/effectiveRole';
import type { Grant } from '../lib/permissions/defineAbility';

const SYSTEM_ROLES = SYSTEM_ROLE_NAMES;
const ROLE_META: Record<string, { label: string; fullAccess: boolean; editable: boolean }> = {
  ADMIN: { label: 'Administrator (Owner)', fullAccess: true, editable: false },
  SALES: { label: 'Sales', fullAccess: false, editable: true },
  DISPATCHER: { label: 'Dispatcher', fullAccess: false, editable: true },
  TECHNICIAN: { label: 'Technician', fullAccess: false, editable: true },
};

type CustomRoleRow = {
  id: string;
  organization_id: string;
  key: string;
  label: string;
  description: string;
  base_role: Role;
  archived_at: Date | null;
};

function allTogglesOn(): Record<ToggleKey, boolean> {
  const toggles = {} as Record<ToggleKey, boolean>;
  for (const key of Object.keys(TOGGLES) as ToggleKey[]) toggles[key] = true;
  return toggles;
}

function adminViewModel(): RoleViewModel {
  const matrix: RoleViewModel['matrix'] = {};
  for (const m of MODULES) matrix[m.subject] = { read: true, create: true, update: true, delete: true };
  return {
    role: 'ADMIN',
    matrix,
    sensitive: { seeFinancials: true, managePayments: true, viewReports: true },
    toggles: allTogglesOn(),
    scope: {},
    general: { description: 'Full access (non-reducible)' },
  };
}

const keyOf = (g: { action: string; subject: string }) => `${g.action}:${g.subject}`;

// Every (action:subject) pair a fully-enabled view-model can emit: MODULES CRUD x4 + both
// SENSITIVE bundles + all 5 TOGGLES, filtered to catalog entries. Two callers: MANAGED_KEYS below
// (what a Save may add/remove) and createRole/resetRole's seed for an ADMIN-derived custom role -
// such a role starts as "full access" so the admin SUBTRACTS from it ("full access minus
// payroll"), rather than starting from nothing and having to name every permission it should hold.
function buildFullGrantSet(): Grant[] {
  const fullMatrix: RoleViewModel['matrix'] = {};
  for (const m of MODULES) fullMatrix[m.subject] = { read: true, create: true, update: true, delete: true };
  const fullVm: RoleViewModel = {
    role: '',
    matrix: fullMatrix,
    sensitive: { seeFinancials: true, managePayments: true, viewReports: true },
    toggles: allTogglesOn(),
    scope: {},
    general: { description: '' },
  };
  return viewModelToGrants(fullVm).filter((g) => isCatalogEntry(g.action, g.subject));
}

// SRVW-140 legacy-body freeze. Derived from the same SENSITIVE bundles roleViewModel.ts's
// assembleRoleViewModel/viewModelToGrants read, so repointing seeFinancials/viewReports again
// can never leave this guarding a stale pair. See putRolePermissions for the full rationale.
const FROZEN_ON_LEGACY_SAVE = new Set([...SENSITIVE.seeFinancials, ...SENSITIVE.viewReports].map(keyOf));

// The (action:subject) pairs the Roles editor actually manages = every pair a fully-enabled
// view-model can emit (the full CRUD matrix + both sensitive bundles + all 5 SRVW-139 toggles).
// A role Save only adds/removes within THIS surface; grants OUTSIDE it (lifecycle verbs like
// revise/archive/delete-Lead/send/assign/complete) are PRESERVED, never stripped — the editor
// can't represent them, so it must not delete them.
const MANAGED_KEYS: Set<string> = new Set(buildFullGrantSet().map(keyOf));

// Resolve `:role`/`:key` to an org's custom_roles row, or null if it names a system role,
// an unknown key, or an archived one. Archived roles 404 like they never existed - phase one
// has no unarchive endpoint, so there is nothing a caller could legitimately do with one.
async function resolveCustomRole(req: Request, key: string): Promise<CustomRoleRow | null> {
  const row = await prisma.customRole.findFirst({ where: { ...tenantWhere(req), key, archived_at: null } });
  return row as CustomRoleRow | null;
}

export const listRoles = async (req: Request, res: Response) => {
  try {
    const counts = await prisma.user.groupBy({
      by: ['role'],
      where: { ...tenantWhere(req) },
      _count: { _all: true },
    });
    const countByRole = new Map<string, number>(counts.map((c: any) => [c.role, c._count._all]));
    const systemEntries = SYSTEM_ROLES.map((role) => ({
      role,
      ...ROLE_META[role],
      userCount: countByRole.get(role) ?? 0,
      type: 'system' as const,
    }));

    // Custom-role user counts key off custom_role_id (the FK), NOT users.role - users.role holds
    // the BASE role for every custom-role user (see effectiveRole.ts), so counting by `role` would
    // fold every custom role's members into their base role's number instead of their own.
    const customRows = await prisma.customRole.findMany({
      where: { ...tenantWhere(req), archived_at: null },
      select: { id: true, key: true, label: true, description: true, base_role: true, _count: { select: { users: true } } },
      orderBy: { created_at: 'asc' },
    });
    const customEntries = customRows.map((r: any) => ({
      // The row's real UUID - users.custom_role_id is a FK to custom_roles.id, not the key, so a
      // user-role picker built off this list needs it to actually assign the role.
      id: r.id,
      role: r.key,
      label: r.label,
      description: r.description,
      base_role: r.base_role,
      fullAccess: false,
      editable: true,
      userCount: r._count.users,
      type: 'custom' as const,
    }));

    res.json([...systemEntries, ...customEntries]);
  } catch (err) {
    logger.error('listRoles error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
};

export const getRolePermissions = async (req: Request, res: Response) => {
  try {
    const role = req.params.role as string;
    if (role === 'ADMIN') {
      res.json({ ...adminViewModel(), editable: false });
      return;
    }
    if (!SYSTEM_ROLES.includes(role as never) && !(await resolveCustomRole(req, role))) {
      res.status(404).json({ error: 'Unknown role' });
      return;
    }
    const rows = await prisma.rolePermission.findMany({
      where: { ...tenantWhere(req), role },
      select: { action: true, subject: true, conditions: true },
    });
    const vm = assembleRoleViewModel(
      role,
      rows.map((r) => ({
        action: r.action,
        subject: r.subject,
        conditions: r.conditions as Record<string, unknown> | null,
      })),
    );
    res.json({ ...vm, editable: true });
  } catch (err) {
    logger.error('getRolePermissions error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
};

// F-47: bound the role-permission PUT body so a malformed payload is a 400, not a 500 inside
// viewModelToGrants. RoleViewModel is a surface map (module → action → grant); keep it
// permissive but reject non-objects / arrays.
export const putRolePermissionsSchema = z
  .record(z.string(), z.unknown())
  .refine((v) => v !== null && typeof v === 'object' && !Array.isArray(v), {
    message: 'Permissions body must be an object',
  });

export const putRolePermissions = async (req: Request, res: Response) => {
  try {
    const role = req.params.role as string;
    if (role === 'ADMIN') {
      res.status(400).json({ error: 'The Administrator role is full-access and cannot be edited' });
      return;
    }
    if (!SYSTEM_ROLES.includes(role as never) && !(await resolveCustomRole(req, role))) {
      res.status(404).json({ error: 'Unknown role' });
      return;
    }

    const orgId = req.user!.organization_id;
    const vm = { ...(req.body as RoleViewModel), role };
    // Defence in depth: a role grant must be a PERMISSION_CATALOG entry. viewModelToGrants can
    // only emit MODULES × {read,create,update,delete} + the two SENSITIVE bundles — all catalog
    // entries — so this drops nothing today. It exists so that "an action deliberately kept OUT
    // of the catalog can never become a role grant" is ENFORCED here rather than merely emergent
    // from the shape of ACTION_BY_CELL: adding an `approve` cell to that map must not silently
    // promote a per-user-only capability (approve LogisticOrder, location_restricted Inventory)
    // into role_permissions. NOTE the filter is catalog membership, NOT isManagedCapability —
    // many managed per-user capabilities (create Lead, update Job, create Invoice, …) are ALSO
    // legitimate role grants, and filtering on those would strip real permissions on every Save.
    // SRVW-140 legacy-body freeze. A Save posted from a tab that loaded the Roles page against the
    // PRE-SRVW-140 API carries no `viewReports` key AND a `seeFinancials` computed under the OLD
    // meaning (read:Report). Every way of guessing what it meant loses data in some direction:
    //   - inferring viewReports from seeFinancials GRANTS the whole Reports and Billing surface
    //     (and the 13 report routes) to a role nobody clicked that for;
    //   - treating viewReports as false DELETES a dispatcher's Reports and Billing nav;
    //   - honouring the stale seeFinancials:false DELETES the read:Pricing the backfill migration
    //     just wrote for Sales, silently making them cost-blind from an unrelated edit.
    // So such a body leaves BOTH keys exactly as they are - neither written nor deleted - which is
    // lossless in every direction. Everything else on the form still saves normally.
    // Read through this explicit cast, NOT through `vm`: RoleViewModel types `viewReports` as
    // boolean, so `vm.sensitive.viewReports === undefined` is a TS non-overlap error.
    const sensitiveIn = (req.body as { sensitive?: Record<string, unknown> }).sensitive;
    const legacySensitiveSave = sensitiveIn?.viewReports === undefined;
    const isFrozen = (g: { action: string; subject: string }) =>
      legacySensitiveSave && FROZEN_ON_LEGACY_SAVE.has(keyOf(g));

    const existing = await prisma.rolePermission.findMany({ where: { organization_id: orgId, role } });
    const existingByKey = new Map(existing.map((e) => [keyOf(e), e]));

    const desired = viewModelToGrants(vm)
      .filter((g) => isCatalogEntry(g.action, g.subject) && !isFrozen(g))
      // PRESERVE A CONDITION THE EDITOR CANNOT EXPRESS.
      //
      // viewModelToGrants stamps the subject's chip condition (All/Owned/Team/Location) onto read,
      // update AND delete. That is lossless only while every persisted condition is one of the four.
      // The technician-ownership spec (Part C) persists two that are not - `read Job` widened to
      // assigned-OR-created, and `delete Job` scoped to the creator - and for both, the chip
      // condition is WIDER than what is stored. So an ordinary Save (an admin ticking a Vendors box
      // and hitting save) would hand every technician in the org the right to read, edit and delete
      // every job in it, with nothing on screen to say so.
      //
      // Keying off "is it representable" rather than naming those two grants means the property also
      // holds for conditions that do not exist yet. This can only ever REFUSE A WIDENING: it never
      // grants anything, and unticking the box still deletes the row (the toDelete pass below is
      // untouched), so an admin's ability to REVOKE is unaffected.
      .map((g) => {
        const current = existingByKey.get(keyOf(g));
        if (!current || isRepresentableScopeCondition(g.subject, current.conditions)) return g;
        return { ...g, conditions: current.conditions as Record<string, unknown> | null };
      });
    const desiredByKey = new Map(desired.map((g) => [keyOf(g), g]));

    await prisma.$transaction(async (tx) => {
      // Only remove grants the editor manages; preserve out-of-surface verb grants.
      const toDelete = existing.filter(
        (e) => MANAGED_KEYS.has(keyOf(e)) && !desiredByKey.has(keyOf(e)) && !isFrozen(e),
      );
      if (toDelete.length) {
        await tx.rolePermission.deleteMany({
          where: {
            organization_id: orgId,
            role,
            OR: toDelete.map((d) => ({ action: d.action, subject: d.subject })),
          },
        });
      }
      for (const g of desired) {
        await tx.rolePermission.upsert({
          where: {
            organization_id_role_action_subject: {
              organization_id: orgId,
              role,
              action: g.action,
              subject: g.subject,
            },
          },
          create: {
            organization_id: orgId,
            role,
            action: g.action,
            subject: g.subject,
            conditions: g.conditions == null ? Prisma.JsonNull : (g.conditions as Prisma.InputJsonValue),
          },
          update: {
            conditions: g.conditions == null ? Prisma.JsonNull : (g.conditions as Prisma.InputJsonValue),
          },
        });
      }
    });

    clearPermissionCache(orgId);
    await writeSettingsAudit(req, 'role.permissions_updated', { role, grantCount: desired.length });
    void logAudit({ req, action: 'role.permissions_updated', resourceType: 'Role', resourceId: role });
    res.json({ ok: true });
  } catch (err) {
    logger.error('putRolePermissions error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
};

export const resetRole = async (req: Request, res: Response) => {
  try {
    const role = req.params.role as string;
    if (role === 'ADMIN') {
      res.status(400).json({ error: 'Role cannot be reset' });
      return;
    }

    let baseGrants: Grant[];
    if (SYSTEM_ROLES.includes(role as never)) {
      baseGrants = DEFAULT_GRANTS.filter((g) => g.role === role);
    } else {
      const custom = await resolveCustomRole(req, role);
      if (!custom) {
        res.status(404).json({ error: 'Unknown role' });
        return;
      }
      // An ADMIN-derived custom role has no DEFAULT_GRANTS row to reset to (ADMIN itself is a
      // code-level bypass, never persisted) - it resets to the same full grant set it was
      // created with, mirroring createRole's seed.
      baseGrants = custom.base_role === 'ADMIN' ? buildFullGrantSet() : DEFAULT_GRANTS.filter((g) => g.role === custom.base_role);
    }

    const orgId = req.user!.organization_id;
    const defaults: Prisma.RolePermissionCreateManyInput[] = baseGrants.map((g) => {
      const conditions = (g as { conditions?: Record<string, unknown> }).conditions;
      return {
        organization_id: orgId,
        role,
        action: g.action,
        subject: g.subject,
        conditions: conditions == null ? Prisma.JsonNull : (conditions as Prisma.InputJsonValue),
      };
    });
    await prisma.$transaction(async (tx) => {
      await tx.rolePermission.deleteMany({ where: { organization_id: orgId, role } });
      if (defaults.length) await tx.rolePermission.createMany({ data: defaults });
    });
    clearPermissionCache(orgId);
    await writeSettingsAudit(req, 'role.reset', { role });
    void logAudit({ req, action: 'role.reset', resourceType: 'Role', resourceId: role });
    res.json({ ok: true });
  } catch (err) {
    logger.error('resetRole error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
};

// Where to seed a new (or reset) role's grants from: the literal 'ADMIN' name has no persisted
// rows (it's a code-level bypass), so cloning "from ADMIN" means the synthesized full grant set;
// any other system role name or a live custom key means copying its actual rolePermission rows
// (which may legitimately be empty - a role reset to nothing is a valid configuration).
async function resolveCloneSource(req: Request, key: string): Promise<'full' | 'rows' | null> {
  if (key === 'ADMIN') return 'full';
  if ((SYSTEM_ROLE_NAMES as readonly string[]).includes(key)) return 'rows';
  return (await resolveCustomRole(req, key)) ? 'rows' : null;
}

export const createRoleSchema = z.object({
  label: z.string().trim().min(1).max(100),
  base_role: z.nativeEnum(Role),
  description: z.string().max(500).optional(),
  // A system role name or another org role's key to copy the initial grant set from.
  clone_grants_from: z.string().min(1).optional(),
});

export const createRole = async (req: Request, res: Response) => {
  try {
    const { label, base_role, description, clone_grants_from } = req.body as z.infer<typeof createRoleSchema>;

    let key: string;
    try {
      key = slugifyRoleKey(label);
    } catch {
      res.status(400).json({ error: 'Label must contain at least one letter or number' });
      return;
    }
    if (isReservedRoleKey(key)) {
      res.status(400).json({ error: `"${label}" collides with a system role name` });
      return;
    }

    let seedGrants: Grant[];
    if (clone_grants_from) {
      const source = await resolveCloneSource(req, clone_grants_from);
      if (!source) {
        res.status(400).json({ error: 'Unknown role to clone permissions from' });
        return;
      }
      seedGrants =
        source === 'full'
          ? buildFullGrantSet()
          : ((await prisma.rolePermission.findMany({
              where: { organization_id: req.user!.organization_id, role: clone_grants_from },
              select: { action: true, subject: true, conditions: true },
            })) as Grant[]);
    } else if (base_role === 'ADMIN') {
      // No clone target given and the chosen base is ADMIN, which has no DEFAULT_GRANTS row
      // (see resolveCloneSource) - seed full access so the admin subtracts from it.
      seedGrants = buildFullGrantSet();
    } else {
      seedGrants = DEFAULT_GRANTS.filter((g) => g.role === base_role);
    }

    const orgId = req.user!.organization_id;
    const created = await prisma.$transaction(async (tx) => {
      const role = await tx.customRole.create({
        data: { organization_id: orgId, key, label, description: description ?? '', base_role },
      });
      if (seedGrants.length) {
        await tx.rolePermission.createMany({
          data: seedGrants.map((g) => ({
            organization_id: orgId,
            role: key,
            action: g.action,
            subject: g.subject,
            conditions: g.conditions == null ? Prisma.JsonNull : (g.conditions as Prisma.InputJsonValue),
          })),
        });
      }
      return role;
    });

    void logAudit({ req, action: 'role.created', resourceType: 'Role', resourceId: created.id, metadata: { key, base_role } });
    res.status(201).json({
      id: created.id,
      role: created.key,
      label: created.label,
      description: created.description,
      base_role: created.base_role,
      fullAccess: false,
      editable: true,
      userCount: 0,
      type: 'custom',
    });
  } catch (err) {
    const prismaErr = err as { code?: string };
    if (prismaErr.code === 'P2002') {
      res.status(409).json({ error: 'A role with this name already exists' });
      return;
    }
    logger.error('createRole error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
};

export const patchRoleSchema = z
  .object({
    label: z.string().trim().min(1).max(100).optional(),
    description: z.string().max(500).optional(),
  })
  .refine((v) => v.label !== undefined || v.description !== undefined, { message: 'Nothing to update' });

// Rename/re-describe only. The key (what role_permissions rows are keyed on) and base_role
// (what code-level behaviour the role inherits) are both immutable in phase one.
export const patchRole = async (req: Request, res: Response) => {
  try {
    const key = req.params.role as string;
    const custom = await resolveCustomRole(req, key);
    if (!custom) {
      res.status(404).json({ error: 'Unknown role' });
      return;
    }

    const { label, description } = req.body as z.infer<typeof patchRoleSchema>;
    const data: Prisma.CustomRoleUpdateInput = {};
    if (label !== undefined) data.label = label;
    if (description !== undefined) data.description = description;

    const updated = await prisma.customRole.update({ where: { id: custom.id }, data });
    void logAudit({ req, action: 'role.updated', resourceType: 'Role', resourceId: custom.id, metadata: { fields: Object.keys(data) } });
    res.json({
      id: updated.id,
      role: updated.key,
      label: updated.label,
      description: updated.description,
      base_role: updated.base_role,
    });
  } catch (err) {
    logger.error('patchRole error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
};

export const archiveRole = async (req: Request, res: Response) => {
  try {
    const key = req.params.role as string;
    const custom = await resolveCustomRole(req, key);
    if (!custom) {
      res.status(404).json({ error: 'Unknown role' });
      return;
    }

    const userCount = await prisma.user.count({ where: { ...tenantWhere(req), custom_role_id: custom.id } });
    if (userCount > 0) {
      res.status(409).json({
        error: `Cannot archive: ${userCount} user${userCount === 1 ? '' : 's'} still assigned to this role. Reassign them first.`,
      });
      return;
    }

    await prisma.customRole.update({ where: { id: custom.id }, data: { archived_at: new Date() } });
    void logAudit({ req, action: 'role.archived', resourceType: 'Role', resourceId: custom.id });
    res.json({ ok: true });
  } catch (err) {
    logger.error('archiveRole error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
};
