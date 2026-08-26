import { useEffect, useState } from 'react';
import { useForm } from 'react-hook-form';

import { useAuthStore } from '@/stores/auth.store';
import { useUpdateMe, useChangeMyPassword, type UpdateMePayload } from '@/lib/api/users';
import MyTimeLog from '@/components/timeclock/MyTimeLog';
import { formatPhone, formatPhoneInput } from '@/lib/utils';

import { Button } from '@/ui-kit/components/ui/button';
import { Input } from '@/ui-kit/components/ui/input';
import { toast } from '@/ui-kit/components/ui/sonner';

import { useSettingsBar } from './settingsBar';
import { Section } from './components/section';
import { Field } from './components/field';

interface ProfileFormValues {
  first_name: string;
  last_name: string;
  phone: string;
  phone_ext: string;
}

function dirtyValues(
  dirtyFields: Record<string, unknown>,
  values: ProfileFormValues,
): UpdateMePayload {
  const out: UpdateMePayload = {};
  if (dirtyFields.first_name) out.first_name = values.first_name;
  if (dirtyFields.last_name) out.last_name = values.last_name;
  if (dirtyFields.phone) out.phone = values.phone || null;
  if (dirtyFields.phone_ext) out.phone_ext = values.phone_ext || null;
  return out;
}

/**
 * Settings > My Profile.
 *
 * The password card here goes through the API (`POST /api/users/me/password`,
 * where the backend re-verifies the current password). Login & Security has a
 * SECOND, divergent implementation that talks to supabase-js directly. Both are
 * carried across unchanged: unifying them is a behaviour change, and this is a
 * presentation swap.
 */
export default function MyProfilePage() {
  const user = useAuthStore((s) => s.user);
  // Merge the saved row back into the cached auth user so the header (name) and
  // this page reflect the change immediately - no full /api/auth/me re-fetch.
  const applyUserPatch = useAuthStore((s) => s.applyUserPatch);
  const updateMe = useUpdateMe();
  const changePassword = useChangeMyPassword();
  const { registerSaver } = useSettingsBar();

  const form = useForm<ProfileFormValues>({
    defaultValues: { first_name: '', last_name: '', phone: '', phone_ext: '' },
  });
  const { register, reset, handleSubmit, formState, watch, setValue } = form;
  const isDirty = formState.isDirty;

  useEffect(() => {
    if (user) {
      reset({
        first_name: user.first_name ?? '',
        last_name: user.last_name ?? '',
        phone: formatPhone(user.phone ?? ''),
        phone_ext: user.phone_ext ?? '',
      });
    }
  }, [user, reset]);

  const onSubmit = handleSubmit(async (values) => {
    const payload = dirtyValues(formState.dirtyFields as Record<string, unknown>, values);
    if (Object.keys(payload).length === 0) return;
    const updated = await updateMe.mutateAsync(payload);
    // Refresh the cached auth user so the header / store reflect the new name/phone.
    applyUserPatch({
      first_name: updated.first_name,
      last_name: updated.last_name,
      phone: updated.phone,
      phone_ext: updated.phone_ext,
      has_login: updated.has_login,
    });
    reset(values);
  });

  useEffect(() => {
    registerSaver({ save: onSubmit, discard: () => user && reset(), isDirty });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isDirty]);

  // -- Password change (separate, self-contained form) ---------------------
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const passwordTooShort = newPassword.length > 0 && newPassword.length < 8;
  const passwordMismatch = confirmPassword.length > 0 && newPassword !== confirmPassword;
  // SECURITY (review #4): the current password is required - the backend re-authenticates with it
  // before changing the password, so a stolen session can't silently reset credentials.
  const canSubmitPassword =
    currentPassword.length > 0 &&
    newPassword.length >= 8 &&
    newPassword === confirmPassword &&
    !changePassword.isPending;

  const submitPassword = async () => {
    if (!canSubmitPassword) return;
    await changePassword.mutateAsync({ currentPassword, newPassword });
    toast.success('Password updated');
    setCurrentPassword('');
    setNewPassword('');
    setConfirmPassword('');
  };

  // Hide the password card only for seats with no login at all (`has_login` ===
  // false). Password and Google-login users both keep it (Google users can also
  // set a password). `has_login` now comes from /api/auth/me; default to showing.
  const showPasswordSection = user?.has_login !== false;

  return (
    <div className="space-y-6">
      <Section title="My Details">
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Field label="First name" required>
            <Input {...register('first_name', { required: true })} />
          </Field>
          <Field label="Last name" required>
            <Input {...register('last_name', { required: true })} />
          </Field>
          <Field label="Phone">
            <Input
              type="tel"
              value={watch('phone') ?? ''}
              onChange={(e) => setValue('phone', formatPhoneInput(e.target.value), { shouldDirty: true })}
            />
          </Field>
          <Field label="Phone extension">
            <Input {...register('phone_ext')} />
          </Field>
          <Field label="Email">
            <Input value={user?.email ?? ''} disabled readOnly />
          </Field>
          <Field label="Role">
            <Input value={user?.role ?? ''} disabled readOnly />
          </Field>
        </div>
        <p className="text-muted-foreground text-xs">
          Your role, team, and access are managed by an administrator.
        </p>
      </Section>

      {/* No kit counterpart: MyTimeLog owns a geofenced clock, its own queries and
          its own entry list. Reused whole and recorded in the ledger. */}
      <MyTimeLog />

      {showPasswordSection && (
        <Section title="Change Password">
          <div className="grid max-w-md gap-4">
            <Field label="Current password">
              <Input
                type="password"
                value={currentPassword}
                onChange={(e) => setCurrentPassword(e.target.value)}
                autoComplete="current-password"
              />
            </Field>
            <Field label="New password">
              <Input
                type="password"
                value={newPassword}
                onChange={(e) => setNewPassword(e.target.value)}
                autoComplete="new-password"
              />
              {passwordTooShort && (
                <p className="text-destructive text-xs">Password must be at least 8 characters.</p>
              )}
            </Field>
            <Field label="Confirm new password">
              <Input
                type="password"
                value={confirmPassword}
                onChange={(e) => setConfirmPassword(e.target.value)}
                autoComplete="new-password"
              />
              {passwordMismatch && <p className="text-destructive text-xs">Passwords do not match.</p>}
            </Field>
            <div>
              <Button size="sm" disabled={!canSubmitPassword} onClick={() => void submitPassword()}>
                {changePassword.isPending ? 'Updating...' : 'Update Password'}
              </Button>
            </div>
          </div>
        </Section>
      )}
    </div>
  );
}
