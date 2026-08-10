import { useQuery, useMutation, useQueryClient, keepPreviousData } from '@tanstack/react-query';
import api from '@/lib/axios';
import { toast } from '@/components/ui/use-toast';
import { extractApiError } from '@/lib/utils';

export type UserRole = 'ADMIN' | 'SALES' | 'DISPATCHER' | 'TECHNICIAN';

export interface UserRow {
  id: string;
  email: string;
  first_name: string;
  last_name: string;
  role: UserRole;
  // SRVW-138/139 - `role` above stays the BASE role; a custom role layers grants on top of it.
  // `custom_role_id` is the custom_roles.id FK; `custom_role` is the row's key/label for display.
  custom_role_id?: string | null;
  custom_role?: { key: string; label: string } | null;
  is_active: boolean;
  has_login: boolean;
  phone: string | null;
  phone_ext: string | null;
  /** Signed URL to the uploaded profile photo, or null for the initials tile. Never a stock/
   *  generated avatar (2026-08-04 plan) — the frontend renders it only alongside a fallback. */
  avatar_url: string | null;
  department_id: string | null;
  department: { id: string; name: string } | null;
  enforce_clock_in_location: boolean;
  can_approve_clock_overrides: boolean;
  created_at: string;
  updated_at: string;
}

export interface AssignableUser {
  id: string;
  first_name: string;
  last_name: string;
  role: UserRole;
  is_active: boolean;
  has_login: boolean;
  /** Returned by GET /api/users?assignable=true (userSelect) — optional so fixtures keep compiling (#370). */
  phone?: string | null;
  /** Same optional-fixture rationale as `phone` above. */
  avatar_url?: string | null;
  department: { id: string; name: string } | null;
}

export interface InviteUserPayload {
  first_name: string;
  last_name: string;
  email: string;
  role: UserRole;
  custom_role_id?: string | null;
  phone?: string | null;
  phone_ext?: string | null;
  department_id: string | null;
}

export interface InviteResult {
  user: UserRow;
  email_sent: boolean;
  invite_url: string;
}

export interface UpdateUserPayload {
  first_name?: string;
  last_name?: string;
  role?: UserRole;
  custom_role_id?: string | null;
  is_active?: boolean;
  phone?: string | null;
  phone_ext?: string | null;
  department_id?: string | null;
}

export interface UpdateMePayload {
  first_name?: string;
  last_name?: string;
  phone?: string | null;
  phone_ext?: string | null;
}

export function useUsers() {
  return useQuery<UserRow[]>({
    queryKey: ['users', 'all'],
    queryFn: () => api.get('/api/users').then((r) => r.data.users),
  });
}

export interface AssignableUsersOpts {
  enabled?: boolean;
  departmentId?: string;
  eligibleFor?: 'owner' | 'task' | 'dispatcher';
  /** Union in users referenced by existing job/lead assignments even if no longer
   * eligible for NEW assignments — keeps completeness filters from dropping people
   * who are genuinely assigned (e.g. a non-technician on a job). */
  includeReferencedIn?: 'jobs' | 'leads';
}

export function useAssignableUsers(opts: AssignableUsersOpts = {}) {
  const { enabled = true, departmentId, eligibleFor, includeReferencedIn } = opts;
  return useQuery<AssignableUser[]>({
    queryKey: ['users', 'assignable', departmentId ?? null, eligibleFor ?? null, includeReferencedIn ?? null],
    queryFn: () =>
      api
        .get('/api/users', {
          params: {
            assignable: true,
            ...(departmentId ? { department_id: departmentId } : {}),
            ...(eligibleFor ? { eligible_for: eligibleFor } : {}),
            ...(includeReferencedIn ? { include_referenced_in: includeReferencedIn } : {}),
          },
        })
        .then((r) => r.data.users),
    enabled,
    staleTime: 30_000,
    // Department switches re-key the query — keep the previous roster on screen so
    // member boards don't flash empty while the scoped list loads.
    placeholderData: keepPreviousData,
  });
}

export function useInviteUser() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (payload: InviteUserPayload) =>
      api.post('/api/users/invite', payload).then((r) => r.data as InviteResult),
    onSuccess: (data) => {
      qc.invalidateQueries({ queryKey: ['users'] });
      qc.invalidateQueries({ queryKey: ['departments'] });
      toast({
        title: data.email_sent ? 'Invitation sent' : 'User created — email not sent',
        description: data.email_sent
          ? `${data.user.email} can now set a password or sign in with Google.`
          : `Could not email the invite. Copy this link to share it manually: ${data.invite_url}`,
        variant: data.email_sent ? undefined : 'destructive',
      });
    },
    onError: (err) =>
      toast({
        title: 'Could not invite user',
        description: extractApiError(err, 'Failed to invite user'),
        variant: 'destructive',
      }),
  });
}

export function useSendInvite() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      api.post(`/api/users/${id}/invite`).then((r) => r.data as InviteResult),
    onSuccess: (data) => {
      qc.invalidateQueries({ queryKey: ['users'] });
      toast({
        title: data.email_sent ? 'Invitation sent' : 'Invite link ready — email not sent',
        description: data.email_sent
          ? `${data.user.email} can now set a password or sign in with Google.`
          : `Could not email the invite. Copy this link to share it manually: ${data.invite_url}`,
        variant: data.email_sent ? undefined : 'destructive',
      });
    },
    onError: (err) =>
      toast({
        title: 'Could not send invite',
        description: extractApiError(err, 'Failed to send invite'),
        variant: 'destructive',
      }),
  });
}

export function useUpdateUser() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, payload }: { id: string; payload: UpdateUserPayload }) =>
      api.patch(`/api/users/${id}`, payload).then((r) => r.data.user as UserRow),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['users'] }),
    onError: (err) =>
      toast({
        title: 'Update failed',
        description: extractApiError(err, 'Could not update user'),
        variant: 'destructive',
      }),
  });
}

export function useDeactivateUser() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.delete(`/api/users/${id}`).then((r) => r.data),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['users'] }),
    onError: (err) =>
      toast({
        title: 'Deactivate failed',
        description: extractApiError(err, 'Could not deactivate user'),
        variant: 'destructive',
      }),
  });
}

export function useDeleteUser() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.delete(`/api/users/${id}/permanent`).then((r) => r.data),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['users'] }),
    onError: (err) =>
      toast({
        title: 'Delete failed',
        description: extractApiError(err, 'Could not delete user'),
        variant: 'destructive',
      }),
  });
}

export function useRevokeLogin() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      api.post(`/api/users/${id}/revoke-login`).then((r) => r.data.user as UserRow),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['users'] }),
    onError: (err) =>
      toast({
        title: 'Could not disable login',
        description: extractApiError(err, 'Failed to disable login'),
        variant: 'destructive',
      }),
  });
}

export function useUpdateMe() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (payload: UpdateMePayload) =>
      api.patch('/api/users/me', payload).then((r) => r.data.user as UserRow),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['users'] }),
    onError: (err) =>
      toast({
        title: 'Update failed',
        description: extractApiError(err, 'Could not update your profile'),
        variant: 'destructive',
      }),
  });
}

export interface AvatarResult {
  avatar_url: string | null;
}

/** Upload/replace a profile photo. `userId` omitted → self (`/me/avatar`, no capability check);
 *  provided → admin-on-behalf-of (`/:id/avatar`, `canDo('update','User')` server-side). */
export function useSetAvatar(userId?: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (file: File) => {
      const form = new FormData();
      form.append('file', file);
      const path = userId ? `/api/users/${userId}/avatar` : '/api/users/me/avatar';
      return api
        .post(path, form, { headers: { 'Content-Type': 'multipart/form-data' } })
        .then((r) => r.data as AvatarResult);
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ['users'] }),
    onError: (err) =>
      toast({
        title: 'Upload failed',
        description: extractApiError(err, 'Could not upload photo'),
        variant: 'destructive',
      }),
  });
}

/** Remove a profile photo, reverting to the initials tile. Same `userId` convention as useSetAvatar. */
export function useDeleteAvatar(userId?: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => {
      const path = userId ? `/api/users/${userId}/avatar` : '/api/users/me/avatar';
      return api.delete(path).then((r) => r.data as AvatarResult);
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ['users'] }),
    onError: (err) =>
      toast({
        title: 'Remove failed',
        description: extractApiError(err, 'Could not remove photo'),
        variant: 'destructive',
      }),
  });
}

export function useChangeMyPassword() {
  return useMutation({
    // SECURITY (review #4): the backend requires + re-verifies the current password.
    mutationFn: ({ currentPassword, newPassword }: { currentPassword: string; newPassword: string }) =>
      api
        .post('/api/users/me/password', { current_password: currentPassword, password: newPassword })
        .then((r) => r.data),
    onError: (err) =>
      toast({
        title: 'Password change failed',
        description: extractApiError(err, 'Could not change your password'),
        variant: 'destructive',
      }),
  });
}

// ─── Per-user permission overrides (RBAC Phase 2) ───

export type OverrideState = 'inherit' | 'allow' | 'deny';

export interface UserCapability {
  action: string;
  subject: string;
  label: string;
  description: string;
  roleDefault: 'allowed' | 'not-in-role';
  override: OverrideState;
  effective: boolean;
}

export interface UserPermissions {
  user_id: string;
  editable: boolean;
  capabilities: UserCapability[];
}

export interface PermissionOverrideInput {
  action: string;
  subject: string;
  effect: 'allow' | 'deny';
}

export function useUserPermissions(id: string | null) {
  return useQuery<UserPermissions>({
    queryKey: ['user-permissions', id],
    queryFn: () => api.get(`/api/users/${id}/permissions`).then((r) => r.data),
    enabled: !!id,
  });
}

export function useUpdateUserPermissions() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, overrides }: { id: string; overrides: PermissionOverrideInput[] }) =>
      api.put(`/api/users/${id}/permissions`, { overrides }).then((r) => r.data),
    onSuccess: (_data, vars) => {
      qc.invalidateQueries({ queryKey: ['user-permissions', vars.id] });
      qc.invalidateQueries({ queryKey: ['users'] });
      toast({ title: 'Permissions updated' });
    },
    onError: (err) =>
      toast({
        title: 'Update failed',
        description: extractApiError(err, 'Could not update permissions'),
        variant: 'destructive',
      }),
  });
}
