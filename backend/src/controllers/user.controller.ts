import { Request, Response } from 'express';
import { z } from 'zod';
import { Role } from '@prisma/client';
import { supabaseAdmin, supabaseAuth } from '../lib/supabase';
import { prisma } from '../lib/prisma';
import { logger } from '../lib/logger';
import { clearTokenCache } from '../middleware/authenticate';
import { tenantWhere } from '../lib/tenant';
import { ASSIGNABLE_ROLES, OWNER_ELIGIBLE_ROLES, DISPATCHER_ELIGIBLE_ROLES } from '../lib/permissions/assignableRoles';
import { env } from '../config/env';
import { signInviteToken } from '../lib/invite-token';
import { emailSchema } from '../lib/email-schema';
import { assertEmailAvailable, EmailAlreadyRegisteredError, EMAIL_ALREADY_REGISTERED_MSG } from '../lib/user-email-guard';
import { sendUserInviteEmail } from '../lib/email';
import { writeSettingsAudit, logAudit } from '../lib/audit';
import {
  USER_CAPABILITIES,
  isManagedCapability,
  isManagedCapabilityForRole,
  capabilityAllowsRole,
} from '../lib/permissions/userCapabilities';
import { clearUserOverrideCache } from '../lib/permissions/userOverrideCache';
import { emit } from '../services/notifications/notificationService';
import { signAvatarPaths, resolveAvatarUrl, removeAvatarObject } from '../lib/avatar';

const userSelect = {
  id: true,
  email: true,
  first_name: true,
  last_name: true,
  role: true,
  custom_role_id: true,
  custom_role: { select: { key: true, label: true } },
  is_active: true,
  has_login: true,
  phone: true,
  phone_ext: true,
  avatar_path: true,
  department_id: true,
  department: { select: { id: true, name: true } },
  enforce_clock_in_location: true,
  can_approve_clock_overrides: true,
  created_at: true,
  updated_at: true,
};

/** Swap the private `avatar_path` column for a signed, response-safe `avatar_url` — batch-signed
 *  in ONE call regardless of how many rows are passed (2026-08-04 plan, decision 7). */
async function withAvatarUrls<T extends { avatar_path: string | null }>(
  rows: T[],
): Promise<Array<Omit<T, 'avatar_path'> & { avatar_url: string | null }>> {
  const signed = await signAvatarPaths(rows.map((r) => r.avatar_path));
  return rows.map(({ avatar_path, ...rest }) => ({
    ...rest,
    avatar_url: resolveAvatarUrl(avatar_path, signed),
  }));
}

/** Singular convenience over withAvatarUrls, for the many handlers below that resolve exactly
 *  one row. Still one signing call per response — batching only matters at N>1. */
async function withAvatarUrl<T extends { avatar_path: string | null }>(
  row: T,
): Promise<Omit<T, 'avatar_path'> & { avatar_url: string | null }> {
  return (await withAvatarUrls([row]))[0]!;
}

export const createUserSchema = z.object({
  email: emailSchema,
  password: z.string().min(8),
  phone: z.string().max(50).nullable().optional(),
  phone_ext: z.string().max(50).nullable().optional(),
  first_name: z.string().min(1).max(100),
  last_name: z.string().min(1).max(100),
  role: z.nativeEnum(Role),
  // SRVW-138/139: an org custom role, layered on the required base `role` above. Validated
  // server-side (resolveCustomRoleAssignment) against the org and against base_role agreement -
  // never trusted from the client past shape.
  custom_role_id: z.string().uuid().nullable().optional(),
  department_id: z.string().uuid().nullable().optional(),
});

export const inviteUserSchema = z.object({
  first_name: z.string().min(1).max(100),
  last_name: z.string().min(1).max(100),
  email: emailSchema,
  role: z.nativeEnum(Role),
  custom_role_id: z.string().uuid().nullable().optional(),
  phone: z.string().max(50).nullable().optional(),
  phone_ext: z.string().max(50).nullable().optional(),
  department_id: z.string().uuid().nullable().optional(),
});

export const updateUserSchema = z.object({
  first_name: z.string().min(1).max(100).optional(),
  last_name: z.string().min(1).max(100).optional(),
  role: z.nativeEnum(Role).optional(),
  custom_role_id: z.string().uuid().nullable().optional(),
  is_active: z.boolean().optional(),
  phone: z.string().max(50).nullable().optional(),
  phone_ext: z.string().max(50).nullable().optional(),
  department_id: z.string().uuid().nullable().optional(),
});

// Self-service profile edit — whitelisted fields ONLY (.strict rejects privileged keys like role/is_active).
export const meUpdateSchema = z
  .object({
    first_name: z.string().min(1).max(100).optional(),
    last_name: z.string().min(1).max(100).optional(),
    phone: z.string().max(50).nullable().optional(),
    phone_ext: z.string().max(50).nullable().optional(),
  })
  .strict();

export const changePasswordSchema = z.object({
  // SECURITY (review #4): require the current password so a stolen short-lived session can't be
  // turned into permanent account takeover by silently resetting the password.
  current_password: z.string().min(1),
  password: z.string().min(8),
});

export async function list(req: Request, res: Response) {
  try {
    const assignable = req.query.assignable === 'true';
    const roleFilter = req.query.role as Role | undefined;
    const departmentId = req.query.department_id as string | undefined;
    const eligibleFor = req.query.eligible_for as 'owner' | 'task' | 'dispatcher' | undefined;
    const referenced = req.query.include_referenced_in as 'jobs' | 'leads' | undefined;

    const where: Record<string, unknown> = { ...tenantWhere(req) };
    if (assignable || referenced) {
      // Tasks can be owned/watched by ANY active user incl. DISPATCHER (issue #434) —
      // task.controller does not role-validate owner/watchers, so eligible_for=task omits
      // the role filter. Since #366 the crew/lead-owner pools also cover all active users
      // via the widened ASSIGNABLE_ROLES (all four Role values). eligible_for=dispatcher
      // (#291) is the narrow ADMIN+DISPATCHER pool for the job-dispatcher picker.
      const assignableWhere: Record<string, unknown> = { is_active: true };
      if (eligibleFor !== 'task') {
        assignableWhere.role = {
          in: eligibleFor === 'owner'
            ? [...OWNER_ELIGIBLE_ROLES]
            : eligibleFor === 'dispatcher'
              ? [...DISPATCHER_ELIGIBLE_ROLES]
              : [...ASSIGNABLE_ROLES],
        };
      }
      if (departmentId) assignableWhere.department_id = departmentId;   // board-column dept scope; omit → org-wide borrow pool

      if (referenced) {
        // Union so a referenced user (inactive, or a role outside the assignable pool) is
        // never dropped from the roster just because they're no longer eligible for NEW
        // assignments — fixes filters missing genuinely-assigned non-technician users.
        const referencedClauses: Record<string, unknown>[] =
          referenced === 'jobs' ? [{ job_crew_memberships: { some: {} } }]
          : referenced === 'leads' ? [{ lead_crew_memberships: { some: {} } }, { commission_owned_leads: { some: {} } }]
          : [];
        where.OR = [assignableWhere, ...referencedClauses];
      } else {
        Object.assign(where, assignableWhere);
      }
    } else if (roleFilter) {
      where.role = roleFilter;
    }

    const users = await prisma.user.findMany({
      where,
      select: userSelect,
      orderBy: assignable
        ? [
            { department: { name: 'asc' } },
            { last_name: 'asc' },
            { first_name: 'asc' },
          ]
        : { created_at: 'desc' },
    });

    res.json({ users: await withAvatarUrls(users) });
  } catch (err) {
    logger.error('List users error:', err);
    res.status(500).json({ error: 'Failed to list users' });
  }
}

// SRVW-138/139: a custom_role_id must belong to the same org, not be archived, and its
// base_role must agree with the base `role` the user is (or remains) holding - `users.role`
// is the base role every existing controller branch reads directly (effectiveRole.ts), so
// letting it drift from the custom role's base_role would silently change what a ~24-site
// `req.user.role === X` check sees versus what the custom role's grants imply.
async function resolveCustomRoleAssignment(
  req: Request,
  customRoleId: string,
  baseRole: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const row = await prisma.customRole.findFirst({
    where: { id: customRoleId, ...tenantWhere(req), archived_at: null },
  });
  if (!row) return { ok: false, error: 'Custom role not found' };
  if (row.base_role !== baseRole) {
    return { ok: false, error: `Custom role's base role is ${row.base_role}, not ${baseRole}` };
  }
  return { ok: true };
}

export async function create(req: Request, res: Response) {
  const { email, password, first_name, last_name, role, custom_role_id, department_id, phone, phone_ext } = req.body;

  try {
    if (custom_role_id) {
      const check = await resolveCustomRoleAssignment(req, custom_role_id, role);
      if (!check.ok) {
        res.status(400).json({ error: check.error });
        return;
      }
    }

    if (department_id) {
      const dept = await prisma.department.findFirst({
        where: { id: department_id, ...tenantWhere(req) },
        select: { id: true },
      });
      if (!dept) {
        res.status(400).json({ error: 'Department not found' });
        return;
      }
    }

    await assertEmailAvailable(email);

    // Create in Supabase Auth first
    const { data: authData, error: authError } = await supabaseAdmin.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
    });

    if (authError || !authData.user) {
      const code = (authError as { code?: string } | null)?.code;
      const message = authError?.message ?? '';
      if (code === 'email_exists' || /already.*(registered|exists)/i.test(message)) {
        res.status(409).json({ error: EMAIL_ALREADY_REGISTERED_MSG });
        return;
      }
      res.status(400).json({ error: message || 'Failed to create auth user' });
      return;
    }

    // Create matching Prisma user with same ID (in requesting org)
    try {
      const user = await prisma.user.create({
        data: {
          id: authData.user.id,
          email,
          first_name,
          last_name,
          role,
          custom_role_id: custom_role_id ?? null,
          phone: phone ?? null,
          phone_ext: phone_ext ?? null,
          department_id: department_id ?? null,
          organization_id: req.user!.organization_id,
        },
        select: userSelect,
      });

      void logAudit({ req, action: 'user.created', resourceType: 'User', resourceId: user.id, metadata: { email: user.email, role: user.role } });
      res.status(201).json({ user: await withAvatarUrl(user) });
    } catch (prismaError) {
      // Rollback: delete the Supabase Auth user if Prisma creation fails
      await supabaseAdmin.auth.admin.deleteUser(authData.user.id);
      logger.error('Create user Prisma error (rolled back Supabase):', prismaError);
      res.status(500).json({ error: 'Failed to create user' });
    }
  } catch (err) {
    if (err instanceof EmailAlreadyRegisteredError) {
      res.status(409).json({ error: EMAIL_ALREADY_REGISTERED_MSG });
      return;
    }
    logger.error('Create user error:', err);
    res.status(500).json({ error: 'Failed to create user' });
  }
}

// Build the invite link + dispatch the branded email. Returns whether it sent.
async function dispatchInvite(user: { id: string; email: string; first_name: string; organization_id: string }): Promise<{ inviteUrl: string; emailSent: boolean }> {
  const token = signInviteToken(user.id, user.email);
  const inviteUrl = `${env.FRONTEND_URL}/accept-invite?token=${encodeURIComponent(token)}`;
  const emailSent = await sendUserInviteEmail({
    to: user.email,
    firstName: user.first_name,
    inviteUrl,
    organizationId: user.organization_id,
  });
  return { inviteUrl, emailSent };
}

export async function inviteUser(req: Request, res: Response) {
  const { email, first_name, last_name, role, custom_role_id, department_id, phone, phone_ext } = req.body;

  try {
    if (custom_role_id) {
      const check = await resolveCustomRoleAssignment(req, custom_role_id, role);
      if (!check.ok) {
        res.status(400).json({ error: check.error });
        return;
      }
    }

    if (department_id) {
      const dept = await prisma.department.findFirst({
        where: { id: department_id, ...tenantWhere(req) },
        select: { id: true },
      });
      if (!dept) {
        res.status(400).json({ error: 'Department not found' });
        return;
      }
    }

    await assertEmailAvailable(email);

    const user = await prisma.user.create({
      data: {
        email,
        first_name,
        last_name,
        role,
        custom_role_id: custom_role_id ?? null,
        phone: phone ?? null,
        phone_ext: phone_ext ?? null,
        has_login: true,
        password_hash: '',
        department_id: department_id ?? null,
        organization_id: req.user!.organization_id,
      },
      select: userSelect,
    });

    const { inviteUrl, emailSent } = await dispatchInvite({
      id: user.id, email: user.email, first_name: user.first_name, organization_id: req.user!.organization_id,
    });

    void logAudit({ req, action: 'user.invited', resourceType: 'User', resourceId: user.id, metadata: { email: user.email, role: user.role } });
    res.status(201).json({ user: await withAvatarUrl(user), email_sent: emailSent, invite_url: inviteUrl });
  } catch (err) {
    if (err instanceof EmailAlreadyRegisteredError) {
      res.status(409).json({ error: EMAIL_ALREADY_REGISTERED_MSG });
      return;
    }
    const prismaErr = err as { code?: string; meta?: { target?: string[] } };
    if (prismaErr.code === 'P2002' && prismaErr.meta?.target?.includes('email')) {
      res.status(409).json({ error: EMAIL_ALREADY_REGISTERED_MSG });
      return;
    }
    logger.error('Invite user error:', err);
    res.status(500).json({ error: 'Failed to invite user' });
  }
}

export async function invite(req: Request, res: Response) {
  try {
    const existing = await prisma.user.findFirst({
      where: { id: param(req, 'id'), ...tenantWhere(req) },
      select: { id: true, email: true, first_name: true, is_active: true, organization_id: true },
    });
    if (!existing) {
      res.status(404).json({ error: 'User not found' });
      return;
    }

    const { inviteUrl, emailSent } = await dispatchInvite(existing);

    const user = await prisma.user.update({
      where: { id: existing.id },
      data: { has_login: true },
      select: userSelect,
    });

    void logAudit({ req, action: 'user.invite_resent', resourceType: 'User', resourceId: existing.id });
    res.json({ user, email_sent: emailSent, invite_url: inviteUrl });
  } catch (err) {
    logger.error('Resend invite error:', err);
    res.status(500).json({ error: 'Failed to send invite' });
  }
}

function param(req: Request, name: string): string {
  return req.params[name] as string;
}

export async function getById(req: Request, res: Response) {
  try {
    const user = await prisma.user.findFirst({
      where: { id: param(req, 'id'), ...tenantWhere(req) },
      select: userSelect,
    });

    if (!user) {
      res.status(404).json({ error: 'User not found' });
      return;
    }

    res.json({ user: await withAvatarUrl(user) });
  } catch (err) {
    logger.error('Get user error:', err);
    res.status(500).json({ error: 'Failed to get user' });
  }
}

export async function update(req: Request, res: Response) {
  try {
    // Guard against self-demotion lockout: an admin must not change their own
    // role (mirrors the self-deactivate guard in deactivate()). Editing other
    // fields on your own account is fine; only a real role change is blocked.
    if (
      req.user?.id === param(req, 'id') &&
      req.body.role !== undefined &&
      req.body.role !== req.user?.role
    ) {
      res.status(400).json({ error: 'Cannot change your own role' });
      return;
    }

    const existing = await prisma.user.findFirst({ where: { id: param(req, 'id'), ...tenantWhere(req) } });
    if (!existing) {
      res.status(404).json({ error: 'User not found' });
      return;
    }

    if (req.body.department_id) {
      const dept = await prisma.department.findFirst({
        where: { id: req.body.department_id, ...tenantWhere(req) },
        select: { id: true },
      });
      if (!dept) {
        res.status(400).json({ error: 'Department not found' });
        return;
      }
    }

    if (await wouldRemoveLastAdmin(req, existing)) {
      const demoting = req.body.role !== undefined && req.body.role !== 'ADMIN';
      const deactivating = req.body.is_active === false;
      if (demoting || deactivating) {
        res.status(409).json({ error: 'Cannot remove the last active admin. Assign another admin first.' });
        return;
      }
    }

    // SRVW-138/139: re-validate base_role/custom_role_id agreement whenever EITHER is touched -
    // changing only `role` while a custom_role_id is already set (or vice versa) can just as
    // easily strand the pair as setting both at once, and existing.custom_role_id is not
    // re-checked unless something here actually moves.
    if (req.body.role !== undefined || req.body.custom_role_id !== undefined) {
      const effectiveRole = req.body.role !== undefined ? req.body.role : existing.role;
      const effectiveCustomRoleId = req.body.custom_role_id !== undefined ? req.body.custom_role_id : existing.custom_role_id;
      if (effectiveCustomRoleId) {
        const check = await resolveCustomRoleAssignment(req, effectiveCustomRoleId, effectiveRole);
        if (!check.ok) {
          res.status(400).json({ error: check.error });
          return;
        }
      }
    }

    // Explicit field allowlist (NOT `data: req.body`): the controller self-defends
    // regardless of schema drift (a future .passthrough(), a new privileged column,
    // or a removed validate) so an injected organization_id/email/has_login/id can
    // never be mass-assigned to escalate or move another user (authz-4). Mirrors
    // updateUserSchema; undefined keys are dropped so a partial PATCH never nulls.
    const body = req.body as Record<string, unknown>;
    const data: Record<string, unknown> = {};
    if (body.first_name !== undefined) data.first_name = body.first_name;
    if (body.last_name !== undefined) data.last_name = body.last_name;
    if (body.role !== undefined) data.role = body.role;
    if (body.custom_role_id !== undefined) data.custom_role_id = body.custom_role_id;
    if (body.is_active !== undefined) data.is_active = body.is_active;
    if (body.department_id !== undefined) data.department_id = body.department_id;
    // Personnel staff-mgmt (PR #218): admin Edit-details dialog PATCHes phone/ext.
    if (body.phone !== undefined) data.phone = body.phone;
    if (body.phone_ext !== undefined) data.phone_ext = body.phone_ext;

    const user = await prisma.user.update({
      where: { id: param(req, 'id') },
      data,
      select: userSelect,
    });

    clearTokenCache(param(req, 'id'));
    void logAudit({ req, action: 'user.updated', resourceType: 'User', resourceId: param(req, 'id'), metadata: { fields: Object.keys(data) } });
    if (data.role !== undefined) {
      void logAudit({ req, action: 'user.role_changed', resourceType: 'User', resourceId: param(req, 'id'), metadata: { role: data.role } });
    }
    res.json({ user: await withAvatarUrl(user) });
  } catch (err) {
    logger.error('Update user error:', err);
    res.status(500).json({ error: 'Failed to update user' });
  }
}

export async function deactivate(req: Request, res: Response) {
  try {
    if (req.user?.id === param(req, 'id')) {
      res.status(400).json({ error: 'Cannot deactivate your own account' });
      return;
    }

    const existing = await prisma.user.findFirst({ where: { id: param(req, 'id'), ...tenantWhere(req) } });
    if (!existing) {
      res.status(404).json({ error: 'User not found' });
      return;
    }

    if (await wouldRemoveLastAdmin(req, existing)) {
      res.status(409).json({ error: 'Cannot deactivate the last active admin. Assign another admin first.' });
      return;
    }

    // Deactivation force-revokes login so has_login never lies (and the seat can't sign in).
    if (existing.has_login && existing.email) {
      await deleteSupabaseAuthUserByEmail(existing.email);
    }

    await prisma.user.update({
      where: { id: param(req, 'id') },
      data: { is_active: false, has_login: false, password_hash: '' },
    });

    clearTokenCache(param(req, 'id'));
    void logAudit({ req, action: 'user.deactivated', resourceType: 'User', resourceId: param(req, 'id') });
    res.json({ message: 'User deactivated' });
  } catch (err) {
    logger.error('Deactivate user error:', err);
    res.status(500).json({ error: 'Failed to deactivate user' });
  }
}

// Relations that represent real audit/financial history. If a user has ANY of
// these we refuse the hard delete (DB-`Restrict` ones would throw anyway; the
// `SetNull` ones we choose to protect so attribution isn't silently lost).
// Cascade relations (crew memberships, table preferences) are intentionally
// omitted — they auto-clean and are transient.
export const DELETE_BLOCKING_RELATIONS = {
  created_estimates: true,
  created_notes: true,
  uploaded_attachments: true,
  time_entries: true,
  timeclock_ot_reviews: true,
  issued_refunds: true,
  created_credits: true,
  collected_payments: true,
  voided_payments: true,
  refunded_invoices: true,
  commission_owned_leads: true,
  dispatched_jobs: true,
  service_plans_sold: true,
  timeline_events: true,
  cancelled_walkthroughs: true,
} as const;

export const DELETE_RELATION_LABELS: Record<string, string> = {
  created_estimates: 'estimates',
  created_notes: 'notes',
  uploaded_attachments: 'attachments',
  time_entries: 'time entries',
  timeclock_ot_reviews: 'overtime reviews',
  issued_refunds: 'refunds',
  created_credits: 'credits',
  collected_payments: 'payments collected',
  voided_payments: 'payments voided',
  refunded_invoices: 'invoices refunded',
  commission_owned_leads: 'leads owned',
  dispatched_jobs: 'jobs dispatched',
  service_plans_sold: 'service plans sold',
  timeline_events: 'timeline events',
  cancelled_walkthroughs: 'walkthrough cancellations',
};

// Best-effort removal of the Supabase Auth account by email. Prisma id ≠ Supabase
// id after the invite redesign, so we can't delete by id — we page listUsers and
// match on email (the established pattern in lib/e2e-org.ts + the seed scripts).
// Swallows all errors: the Prisma row is already gone, auth cleanup is secondary.
async function deleteSupabaseAuthUserByEmail(email: string): Promise<void> {
  const target = email.toLowerCase();
  try {
    for (let page = 1; page <= 50; page++) {
      const { data, error } = await supabaseAdmin.auth.admin.listUsers({ page, perPage: 200 });
      if (error || !data?.users?.length) return;
      const match = data.users.find((u) => u.email?.toLowerCase() === target);
      if (match) {
        await supabaseAdmin.auth.admin.deleteUser(match.id);
        return;
      }
      // data.nextPage is null when we've reached the last page (Supabase Pagination type).
      if (data.nextPage === null) return;
    }
  } catch (err) {
    logger.error('Supabase auth cleanup on user delete failed (non-fatal):', err);
  }
}

// Admin "Reset 2FA": clear the target user's email-OTP enrollment and purge any
// pending challenges so they can re-enroll cleanly. Admin-only + tenant-scoped,
// mirroring permanentDelete (findFirst + tenantWhere; findFirst — NOT findUnique —
// avoids colliding with the auth-middleware's findUnique mock in tests).
export async function resetMfa(req: Request, res: Response) {
  try {
    const id = param(req, 'id');

    const existing = await prisma.user.findFirst({
      where: { id, ...tenantWhere(req) },
      select: { id: true },
    });
    if (!existing) {
      res.status(404).json({ error: 'User not found' });
      return;
    }

    await prisma.user.updateMany({
      where: { id, ...tenantWhere(req) },
      data: { mfa_email_enrolled: false },
    });
    await prisma.mfaEmailChallenge.deleteMany({ where: { user_id: id } });

    void logAudit({ req, action: 'user.mfa_reset', resourceType: 'User', resourceId: id });
    res.json({ ok: true });
  } catch (err) {
    logger.error('Reset 2FA error:', err);
    res.status(500).json({ error: 'Failed to reset 2FA' });
  }
}

export async function permanentDelete(req: Request, res: Response) {
  try {
    const id = param(req, 'id');

    if (req.user?.id === id) {
      res.status(400).json({ error: 'Cannot delete your own account' });
      return;
    }

    const existing = await prisma.user.findFirst({
      where: { id, ...tenantWhere(req) },
      select: { id: true, email: true, is_active: true, avatar_path: true, _count: { select: DELETE_BLOCKING_RELATIONS } },
    });
    if (!existing) {
      res.status(404).json({ error: 'User not found' });
      return;
    }

    if (existing.is_active) {
      res.status(409).json({ error: 'Deactivate this user before deleting them.' });
      return;
    }

    const counts = existing._count as unknown as Record<string, number>;
    const history = Object.entries(counts).filter(([, n]) => n > 0);
    if (history.length > 0) {
      const detail = history.map(([k, n]) => `${n} ${DELETE_RELATION_LABELS[k] ?? k}`).join(', ');
      res.status(409).json({
        error: `This user has history (${detail}) and can't be permanently deleted. Keep them deactivated instead.`,
      });
      return;
    }

    try {
      await prisma.user.delete({ where: { id } });
    } catch (delErr) {
      if ((delErr as { code?: string }).code === 'P2003') {
        res.status(409).json({
          error: "This user is still referenced by other records and can't be deleted. Keep them deactivated instead.",
        });
        return;
      }
      throw delErr;
    }

    if (existing.avatar_path) await removeAvatarObject(existing.avatar_path);

    await deleteSupabaseAuthUserByEmail(existing.email);
    clearTokenCache(id);
    void logAudit({ req, action: 'user.permanently_deleted', resourceType: 'User', resourceId: id, metadata: { email: existing.email } });
    res.json({ message: 'User deleted' });
  } catch (err) {
    logger.error('Permanent delete user error:', err);
    res.status(500).json({ error: 'Failed to delete user' });
  }
}

// Returns true if `target` is the org's last active admin (so demoting / deactivating /
// revoking-login it would lock the org out of admin access).
async function wouldRemoveLastAdmin(req: Request, target: { role: string; is_active: boolean }): Promise<boolean> {
  if (target.role !== 'ADMIN' || !target.is_active) return false;
  const activeAdmins = await prisma.user.count({ where: { role: 'ADMIN', is_active: true, ...tenantWhere(req) } });
  return activeAdmins <= 1;
}

// Resolve a Supabase Auth user id by email. Prisma id ≠ Supabase id after the invite
// redesign, so we page listUsers and match on email (mirrors deleteSupabaseAuthUserByEmail).
async function findSupabaseAuthIdByEmail(email: string): Promise<string | null> {
  const target = email.toLowerCase();
  for (let page = 1; page <= 50; page++) {
    const { data, error } = await supabaseAdmin.auth.admin.listUsers({ page, perPage: 200 });
    if (error || !data?.users?.length) return null;
    const match = data.users.find((u) => u.email?.toLowerCase() === target);
    if (match) return match.id;
    if (data.nextPage === null) return null;
  }
  return null;
}

// POST /api/users/:id/revoke-login — turn login OFF (idempotent). Deletes the Supabase auth
// account + blanks the credential; refuses to lock out the last active admin.
export async function revokeLogin(req: Request, res: Response) {
  try {
    const existing = await prisma.user.findUnique({
      where: { id: param(req, 'id'), ...tenantWhere(req) },
      select: userSelect,
    });
    if (!existing) {
      res.status(404).json({ error: 'User not found' });
      return;
    }
    if (!existing.has_login) {
      res.json({ user: await withAvatarUrl(existing) }); // idempotent — already no login
      return;
    }
    if (await wouldRemoveLastAdmin(req, existing)) {
      res.status(409).json({ error: 'Cannot remove login from the last active admin. Assign another admin first.' });
      return;
    }

    await deleteSupabaseAuthUserByEmail(existing.email);
    const user = await prisma.user.update({
      where: { id: existing.id },
      data: { has_login: false, password_hash: '' },
      select: userSelect,
    });

    clearTokenCache(existing.id);
    void logAudit({ req, action: 'user.login_revoked', resourceType: 'User', resourceId: existing.id });
    res.json({ user: await withAvatarUrl(user) });
  } catch (err) {
    logger.error('Revoke login error:', err);
    res.status(500).json({ error: 'Failed to revoke login' });
  }
}

// PATCH /api/users/me — self-service profile edit (whitelisted fields only).
export async function updateMe(req: Request, res: Response) {
  try {
    const user = await prisma.user.update({
      where: { id: req.user!.id },
      data: req.body,
      select: userSelect,
    });
    clearTokenCache(req.user!.id);
    void logAudit({ req, action: 'user.profile_updated', resourceType: 'User', resourceId: req.user!.id, metadata: { fields: Object.keys(req.body) } });
    res.json({ user: await withAvatarUrl(user) });
  } catch (err) {
    logger.error('Update me error:', err);
    res.status(500).json({ error: 'Failed to update profile' });
  }
}

// POST /api/users/me/password — self-service password change for login-enabled users.
export async function changeMyPassword(req: Request, res: Response) {
  try {
    const me = await prisma.user.findUnique({
      where: { id: req.user!.id },
      select: { has_login: true, email: true },
    });
    if (!me || !me.has_login) {
      res.status(400).json({ error: 'Login is not enabled for your account' });
      return;
    }
    const authId = await findSupabaseAuthIdByEmail(me.email);
    if (!authId) {
      res.status(400).json({ error: 'No login account found for your email' });
      return;
    }
    // SECURITY (review #4): re-authenticate with the CURRENT password before changing it. Without
    // this, a momentarily-stolen session (shoulder-surf, borrowed device, a single XSS request) can
    // be converted into permanent account takeover. Runs on supabaseAuth (NOT supabaseAdmin): a
    // signInWithPassword taints its client's in-memory session, which would poison Storage RLS if it
    // ran on the shared service-role Storage client — see lib/supabase.ts.
    const { error: reauthError } = await supabaseAuth.auth.signInWithPassword({
      email: me.email,
      password: req.body.current_password,
    });
    if (reauthError) {
      res.status(400).json({ error: 'Current password is incorrect' });
      return;
    }
    const { error } = await supabaseAdmin.auth.admin.updateUserById(authId, { password: req.body.password });
    if (error) {
      res.status(400).json({ error: error.message });
      return;
    }

    void logAudit({ req, action: 'user.password_changed', resourceType: 'User', resourceId: req.user!.id });
    res.json({ message: 'Password updated' });
    emit({
      verb: 'security.password_changed',
      organizationId: req.user!.organization_id,
      actorId: null,
      object: { type: 'USER', id: req.user!.id },
      entity: { user_id: req.user!.id },
      data: { object_label: req.user!.first_name || req.user!.email },
    }).catch((err) => logger.warn('notification emit failed', err));
  } catch (err) {
    logger.error('Change my password error:', err);
    res.status(500).json({ error: 'Failed to update password' });
  }
}

// ─── Per-user permission overrides (RBAC Phase 2 → expanded in Phase B) ───
// The managed capability set is the single source of truth in `USER_CAPABILITIES`
// (userCapabilities.ts) — these endpoints are driven entirely by it, with NO hardcoded
// capability list. An override layers on the role grant: 'allow' grants a capability
// beyond the role; 'deny' revokes one the role grants. ADMIN is `manage all` and is
// never overridable.

export const putPermissionsSchema = z.object({
  overrides: z.array(
    z.object({
      action: z.string().min(1),
      subject: z.string().min(1),
      effect: z.enum(['allow', 'deny']),
    }),
  ),
});

// GET /api/users/:id/permissions — full managed-capability catalog (from USER_CAPABILITIES)
// + each capability's computed effective state (allow / deny / inherit) for one user.
export async function getPermissions(req: Request, res: Response) {
  try {
    const target = await prisma.user.findFirst({
      where: { id: param(req, 'id'), ...tenantWhere(req) },
      select: { id: true, role: true, first_name: true, last_name: true },
    });
    if (!target) {
      res.status(404).json({ error: 'User not found' });
      return;
    }

    const isAdmin = target.role === 'ADMIN';

    // Live role grants for the target's role (org-scoped). ADMIN = manage all.
    const roleKeys = new Set<string>();
    if (!isAdmin) {
      const rows = await prisma.rolePermission.findMany({
        where: { ...tenantWhere(req), role: target.role },
        select: { action: true, subject: true },
      });
      for (const r of rows) roleKeys.add(`${r.action}:${r.subject}`);
    }

    const overrideRows = isAdmin
      ? []
      : await prisma.userPermissionOverride.findMany({
          where: { user_id: target.id, ...tenantWhere(req) },
          select: { action: true, subject: true, effect: true },
        });
    const overrideByKey = new Map<string, 'allow' | 'deny'>(
      overrideRows.map((o) => [`${o.action}:${o.subject}`, o.effect === 'deny' ? 'deny' : 'allow']),
    );

    // Role-gated capabilities (userCapabilities' `roles` allow-list) are not offered to a role
    // that may not hold them — putPermissions rejects them for the same role, so rendering a
    // toggle that always 400s would be a lie. ADMIN is filtered by the same rule; it needs no
    // toggles anyway (editable:false, manage-all).
    const capabilities = USER_CAPABILITIES.filter((c) => capabilityAllowsRole(c, target.role)).map((c) => {
      const key = `${c.action}:${c.subject}`;
      const roleAllowed = isAdmin || roleKeys.has(key);
      const override: 'inherit' | 'allow' | 'deny' = isAdmin ? 'inherit' : overrideByKey.get(key) ?? 'inherit';
      const effective = override === 'deny' ? false : override === 'allow' ? true : roleAllowed;
      return {
        action: c.action,
        subject: c.subject,
        label: c.label,
        description: c.description,
        roleDefault: roleAllowed ? 'allowed' : 'not-in-role',
        override,
        effective,
      };
    });

    res.json({ user_id: target.id, editable: !isAdmin, capabilities });
  } catch (err) {
    logger.error('getPermissions error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
}

// PUT /api/users/:id/permissions — replace the user's curated-capability overrides.
// Body: { overrides: [{ action, subject, effect:'allow'|'deny' }] }. A capability absent
// from the list = inherit (no row).
export async function putPermissions(req: Request, res: Response) {
  try {
    const target = await prisma.user.findFirst({
      where: { id: param(req, 'id'), ...tenantWhere(req) },
      select: { id: true, role: true },
    });
    if (!target) {
      res.status(404).json({ error: 'User not found' });
      return;
    }
    if (target.role === 'ADMIN') {
      res.status(400).json({ error: 'Administrators have full access and cannot be overridden' });
      return;
    }

    const { overrides } = req.body as {
      overrides: { action: string; subject: string; effect: 'allow' | 'deny' }[];
    };

    const bad = overrides.find((o) => !isManagedCapability(o.action, o.subject));
    if (bad) {
      res.status(400).json({ error: `Unsupported capability: ${bad.action} ${bad.subject}` });
      return;
    }
    // A managed capability may still be off-limits to THIS user's role (userCapabilities' `roles`
    // allow-list). Rejecting here is what keeps an org-wide capability — whose implied read is
    // condition-less and so widens scopeWhereFor to every row in the org — off a role whose
    // surface was never designed for it (e.g. `approve LogisticOrder` on a TECHNICIAN).
    const wrongRole = overrides.find((o) => !isManagedCapabilityForRole(o.action, o.subject, target.role));
    if (wrongRole) {
      res.status(400).json({
        error: `Capability not available to role ${target.role}: ${wrongRole.action} ${wrongRole.subject}`,
      });
      return;
    }
    // Dedupe by capability (last wins) so a doubled entry can't create two rows.
    const byKey = new Map(overrides.map((o) => [`${o.action}:${o.subject}`, o]));

    const orgId = req.user!.organization_id;
    await prisma.$transaction(async (tx) => {
      await tx.userPermissionOverride.deleteMany({
        where: {
          user_id: target.id,
          organization_id: orgId,
          OR: USER_CAPABILITIES.map((c) => ({ action: c.action, subject: c.subject })),
        },
      });
      for (const o of byKey.values()) {
        await tx.userPermissionOverride.create({
          data: {
            organization_id: orgId,
            user_id: target.id,
            action: o.action,
            subject: o.subject,
            effect: o.effect,
          },
        });
      }
    });

    clearUserOverrideCache(target.id);
    await writeSettingsAudit(req, 'user.permissions_updated', {
      userId: target.id,
      overrides: [...byKey.values()],
    });
    void logAudit({ req, action: 'user.permissions_updated', resourceType: 'User', resourceId: param(req, 'id') });
    res.json({ ok: true });
  } catch (err) {
    logger.error('putPermissions error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
}
