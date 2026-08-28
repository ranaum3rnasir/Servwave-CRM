import { useState } from 'react';
import { Phone, Star } from 'lucide-react';

import { useAppAbility } from '@/contexts/AbilityContext';
import { useFeature } from '@/lib/entitlements';
import { fmtPhone } from '@/lib/api/communication';
import {
  useNumberAssignments,
  useSetNumberAssignments,
  useSetUserDefaultNumber,
  useSetOrgDefaultNumber,
  type NumberAssignmentRow,
} from '@/lib/api/phoneNumbers';

import { Badge } from '@/ui-kit/components/ui/badge';
import { Button } from '@/ui-kit/components/ui/button';
import { Card } from '@/ui-kit/components/ui/card';
import { Checkbox } from '@/ui-kit/components/ui/checkbox';
import { EmptyState } from '@/ui-kit/components/data/emptyState';
import { Label } from '@/ui-kit/components/ui/label';
import { Skeleton } from '@/ui-kit/components/ui/skeleton';
import { cn } from '@/ui-kit/lib/utils';

import { Section } from './components/section';

/**
 * Settings > Caller ID (phone-system slice 3). An admin manages which users may
 * send from each phone number, each user's default number, and the single org
 * default. This is exactly what the backend outbound resolver reads to choose
 * the "from" number.
 *
 * `phone` is the master switch for the ENTIRE Communication module, and this
 * page is one of the two settings tabs behind it. The gate is reproduced
 * exactly: the SettingsLayout nav entry is CASL `update Organization` PLUS
 * comm-gated, and this page repeats the gate defensively - a direct URL hit by a
 * non-admin or a non-comm org renders nothing. It is an AND over `canManage` and
 * `canComm`, so missing either value keeps the page locked despite
 * `useFeature('phone')` failing open by design.
 */
export default function PhoneNumbersSettingsPage() {
  const ability = useAppAbility();
  const canManage = ability.can('update', 'Organization');
  const canComm = useFeature('phone');
  // Only an admin of a communication-enabled org may see or fetch this.
  const gated = canManage && canComm;

  const { data, isLoading, isError } = useNumberAssignments(gated);
  const setAssignments = useSetNumberAssignments();
  const setUserDefault = useSetUserDefaultNumber();
  const setOrgDefault = useSetOrgDefaultNumber();

  // Which number's assignment checklist is expanded (inline, no portal).
  const [editingId, setEditingId] = useState<string | null>(null);

  // No routing notice any more. Assignment used to reroute the number in CTM and
  // hand back a sync result to explain what it had done; upstream made assignment
  // stop rerouting and forwarding separately editable, so the mutation now returns
  // `{ ok: true }` with nothing to report. The legacy page dropped this banner in
  // the same change.

  // Fail closed: the query above is disabled when !gated (no admin fetch), and
  // the page renders nothing.
  if (!gated) return null;

  if (isLoading) {
    return (
      <div className="space-y-4">
        {[0, 1].map((i) => (
          <Card key={i}>
            <div className="space-y-3 p-5">
              <Skeleton className="h-4 w-48" />
              <Skeleton className="h-3 w-64" />
              <Skeleton className="h-8 w-full" />
            </div>
          </Card>
        ))}
      </div>
    );
  }

  if (isError || !data) {
    return (
      <Section>
        <p className="text-destructive text-sm">
          Couldn&apos;t load caller-ID settings - refresh the page to try again.
        </p>
      </Section>
    );
  }

  const { numbers, users } = data;

  if (numbers.length === 0) {
    return (
      <Section>
        <EmptyState
          icon={<Phone />}
          title="No phone numbers yet"
          description="Once your organization has numbers, you can choose which users send from each one and set the org default caller ID here."
        />
      </Section>
    );
  }

  const toggleAssignment = (row: NumberAssignmentRow, userId: string, currentlyAssigned: boolean) => {
    const assignedIds = row.assignments.map((a) => a.user_id);
    const next = currentlyAssigned
      ? assignedIds.filter((id) => id !== userId)
      : [...assignedIds, userId];
    setAssignments.mutate(
      { id: row.id, userIds: next },
    );
  };

  const toggleUserDefault = (userId: string, numberId: string, isDefault: boolean) =>
    setUserDefault.mutate({ userId, phoneNumberId: isDefault ? null : numberId });

  const toggleOrgDefault = (row: NumberAssignmentRow) =>
    setOrgDefault.mutate(
      { id: row.id, isOrgDefault: !row.is_org_default },
    );

  return (
    <div className="space-y-6">
      <p className="text-muted-foreground text-sm">
        Choose which team members can place calls and send texts from each number, set each
        person&apos;s default, and pick the organization&apos;s default caller ID.
      </p>

      <div className="space-y-4">
        {numbers.map((row) => {
          const assignedIds = new Set(row.assignments.map((a) => a.user_id));
          const orgDefaultPending =
            setOrgDefault.isPending && setOrgDefault.variables?.id === row.id;
          const assignPending = setAssignments.isPending && setAssignments.variables?.id === row.id;

          return (
            <Card key={row.id}>
              <div className="space-y-4 p-5">
                {/* Number header + org-default toggle */}
                <div className="flex items-start justify-between gap-4">
                  <div className="flex min-w-0 items-center gap-3">
                    <div className="bg-brand-subtle text-brand grid h-10 w-10 shrink-0 place-content-center rounded-md">
                      <Phone className="size-4" />
                    </div>
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <p className="truncate font-semibold">{fmtPhone(row.e164)}</p>
                        {row.is_org_default && (
                          <Badge variant="softNeutral" size="pill" className="shrink-0">
                            Org default
                          </Badge>
                        )}
                      </div>
                      {row.label && (
                        <p className="text-muted-foreground truncate text-xs">{row.label}</p>
                      )}
                    </div>
                  </div>

                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={orgDefaultPending}
                    aria-pressed={row.is_org_default}
                    aria-label={
                      row.is_org_default
                        ? 'Remove as organization default'
                        : 'Set as organization default'
                    }
                    onClick={() => toggleOrgDefault(row)}
                  >
                    <Star className={cn(row.is_org_default && 'fill-brand text-brand')} />
                    {row.is_org_default ? 'Org default' : 'Set org default'}
                  </Button>
                </div>

                {/* Assigned users */}
                <div className="space-y-2">
                  <div className="flex items-center justify-between">
                    <p className="text-muted-foreground text-[11px] font-semibold uppercase tracking-widest">
                      Can send from this number
                    </p>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => setEditingId((cur) => (cur === row.id ? null : row.id))}
                    >
                      {editingId === row.id ? 'Done' : 'Edit users'}
                    </Button>
                  </div>

                  {row.assignments.length === 0 ? (
                    <p className="text-muted-foreground text-sm italic">No users assigned yet.</p>
                  ) : (
                    <div className="flex flex-wrap gap-2">
                      {row.assignments.map((a) => (
                        <span
                          key={a.user_id}
                          className="border-border bg-muted inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1 text-xs font-medium"
                        >
                          {a.user_name}
                          {/* A kit Button, not a raw <button>: the raw-tag ratchet
                              sits at its floor. */}
                          <Button
                            type="button"
                            variant="ghost"
                            size="icon-sm"
                            className="size-5"
                            aria-pressed={a.is_default}
                            aria-label={
                              a.is_default
                                ? `Clear ${a.user_name}'s default number`
                                : `Make this ${a.user_name}'s default number`
                            }
                            onClick={() => toggleUserDefault(a.user_id, row.id, a.is_default)}
                          >
                            <Star className={cn(a.is_default && 'fill-brand text-brand')} />
                          </Button>
                        </span>
                      ))}
                    </div>
                  )}

                  {/* Inline assignment checklist (no portal - deterministic) */}
                  {editingId === row.id && (
                    <div className="border-border mt-2 space-y-1 rounded-md border p-3">
                      {users.length === 0 ? (
                        <p className="text-muted-foreground text-sm italic">No users in this org.</p>
                      ) : (
                        users.map((u) => {
                          const assigned = assignedIds.has(u.id);
                          return (
                            <Label
                              key={u.id}
                              className="hover:bg-muted flex cursor-pointer items-center gap-2 rounded-md px-1.5 py-1 text-sm font-normal"
                            >
                              <Checkbox
                                checked={assigned}
                                disabled={assignPending}
                                aria-label={u.name}
                                onCheckedChange={() => toggleAssignment(row, u.id, assigned)}
                              />
                              <span>{u.name}</span>
                            </Label>
                          );
                        })
                      )}
                    </div>
                  )}
                </div>
              </div>
            </Card>
          );
        })}
      </div>
    </div>
  );
}
