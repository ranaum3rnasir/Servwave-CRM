import { useState } from 'react';
import { Phone, Star, PhoneForwarded, AlertTriangle, X } from 'lucide-react';
import { useAppAbility } from '@/contexts/AbilityContext';
import { useFeature } from '@/lib/entitlements';
import { fmtPhone } from '@/lib/api/communication';
import {
  useNumberAssignments,
  useSetNumberAssignments,
  useSetUserDefaultNumber,
  useSetOrgDefaultNumber,
  type NumberAssignmentRow,
  type RoutingSyncResult,
} from '@/lib/api/phoneNumbers';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Checkbox } from '@/components/ui/checkbox';
import { Skeleton } from '@/components/ui/skeleton';
import { EmptyState } from '@/components/ui/empty-state';
import { cn } from '@/lib/utils';

/**
 * Settings → Caller ID (phone-system slice 3). An admin manages which users may
 * send from each phone number, each user's default number, and the single org
 * default. This is exactly what the backend outbound resolver reads to choose
 * the "from" number.
 *
 * Gating mirrors the module's conventions: the SettingsLayout nav entry is CASL
 * `update Organization` + communication-access gated, and this page repeats the
 * gate defensively (a direct URL hit by a non-admin / non-comm org renders
 * nothing — AND gate over `canManage` + `canComm`; missing either value keeps
 * the page locked, despite `useFeature('phone')` failing open by design).
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

  // Task D2 — the most recent CTM inbound-routing sync result (from an
  // assignment or org-default mutation), shown as a guidance banner until
  // dismissed or replaced by the next one. `null` responses (e.g. unassigning
  // to zero users, or unsetting the org default) intentionally leave whatever
  // notice is already showing alone — see the backend controller for why
  // those actions make no CTM call.
  const [routingNotice, setRoutingNotice] = useState<{
    numberFormatted: string;
    result: RoutingSyncResult;
  } | null>(null);

  // Fail closed: the query above is disabled when !gated (no admin fetch), and
  // the page renders nothing.
  if (!gated) return null;

  if (isLoading) {
    return (
      <div className="space-y-4">
        {[0, 1].map((i) => (
          <Card key={i} className="space-y-3">
            <Skeleton className="h-4 w-48" />
            <Skeleton className="h-3 w-64" />
            <Skeleton className="h-8 w-full" />
          </Card>
        ))}
      </div>
    );
  }

  if (isError || !data) {
    return (
      <Card>
        <p className="text-sm text-danger">
          Couldn&apos;t load caller-ID settings — refresh the page to try again.
        </p>
      </Card>
    );
  }

  const { numbers, users } = data;

  if (numbers.length === 0) {
    return (
      <Card padding="lg">
        <EmptyState
          icon={Phone}
          title="No phone numbers yet"
          description="Once your organization has numbers, you can choose which users send from each one and set the org default caller ID here."
        />
      </Card>
    );
  }

  const toggleAssignment = (row: NumberAssignmentRow, userId: string, currentlyAssigned: boolean) => {
    const assignedIds = row.assignments.map((a) => a.user_id);
    const next = currentlyAssigned
      ? assignedIds.filter((id) => id !== userId)
      : [...assignedIds, userId];
    setAssignments.mutate(
      { id: row.id, userIds: next },
      {
        onSuccess: (data) => {
          if (data.routing) setRoutingNotice({ numberFormatted: fmtPhone(row.e164), result: data.routing });
        },
      },
    );
  };

  const toggleUserDefault = (userId: string, numberId: string, isDefault: boolean) =>
    setUserDefault.mutate({ userId, phoneNumberId: isDefault ? null : numberId });

  const toggleOrgDefault = (row: NumberAssignmentRow) =>
    setOrgDefault.mutate(
      { id: row.id, isOrgDefault: !row.is_org_default },
      {
        onSuccess: (data) => {
          if (data.routing) setRoutingNotice({ numberFormatted: fmtPhone(row.e164), result: data.routing });
        },
      },
    );

  return (
    <div className="space-y-6">
      <p className="text-sm text-text-secondary">
        Choose which team members can place calls and send texts from each number, set each
        person&apos;s default, and pick the organization&apos;s default caller ID.
      </p>

      {routingNotice && (
        <RoutingGuidancePanel
          numberFormatted={routingNotice.numberFormatted}
          result={routingNotice.result}
          onDismiss={() => setRoutingNotice(null)}
        />
      )}

      <div className="space-y-4">
        {numbers.map((row) => {
          const assignedIds = new Set(row.assignments.map((a) => a.user_id));
          const orgDefaultPending =
            setOrgDefault.isPending && setOrgDefault.variables?.id === row.id;
          const assignPending = setAssignments.isPending && setAssignments.variables?.id === row.id;

          return (
            <Card key={row.id} className="space-y-4">
              {/* Number header + org-default toggle */}
              <div className="flex items-start justify-between gap-4">
                <div className="flex min-w-0 items-center gap-3">
                  <div className="grid h-10 w-10 shrink-0 place-content-center rounded-control bg-primary-subtle text-primary">
                    <Phone className="h-4 w-4" />
                  </div>
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <p className="truncate font-semibold text-text-primary">{fmtPhone(row.e164)}</p>
                      {row.is_org_default && (
                        <Badge variant="secondary" className="shrink-0">
                          Org default
                        </Badge>
                      )}
                    </div>
                    {row.label && (
                      <p className="truncate text-xs text-text-secondary">{row.label}</p>
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
                  <Star
                    className={cn(
                      'h-4 w-4',
                      row.is_org_default ? 'fill-primary text-primary' : 'text-text-soft',
                    )}
                  />
                  {row.is_org_default ? 'Org default' : 'Set org default'}
                </Button>
              </div>

              {/* Assigned users */}
              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <p className="text-[11px] font-semibold uppercase tracking-widest text-text-secondary/70">
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
                  <p className="text-sm italic text-text-secondary">No users assigned yet.</p>
                ) : (
                  <div className="flex flex-wrap gap-2">
                    {row.assignments.map((a) => (
                      <span
                        key={a.user_id}
                        className="inline-flex items-center gap-1.5 rounded-control border border-border bg-background-light px-2.5 py-1 text-xs font-medium text-text-primary"
                      >
                        {a.user_name}
                        {/* Icon-only toggle (aria-pressed) inside a chip with no hover treatment at
                            all; every Button variant adds a hover background/text change, which this
                            site never had - left raw to avoid inventing a visual state. */}
                        <button
                          type="button"
                          className="rounded-control p-0.5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
                          aria-pressed={a.is_default}
                          aria-label={
                            a.is_default
                              ? `Clear ${a.user_name}'s default number`
                              : `Make this ${a.user_name}'s default number`
                          }
                          onClick={() => toggleUserDefault(a.user_id, row.id, a.is_default)}
                        >
                          <Star
                            className={cn(
                              'h-3.5 w-3.5',
                              a.is_default ? 'fill-primary text-primary' : 'text-text-soft',
                            )}
                          />
                        </button>
                      </span>
                    ))}
                  </div>
                )}

                {/* Inline assignment checklist (no portal — deterministic) */}
                {editingId === row.id && (
                  <div className="mt-2 space-y-1 rounded-control border border-border p-3">
                    {users.length === 0 ? (
                      <p className="text-sm italic text-text-secondary">No users in this org.</p>
                    ) : (
                      users.map((u) => {
                        const assigned = assignedIds.has(u.id);
                        return (
                          // Checkbox row (label wraps its Checkbox control) - not a
                          // FormField-shape site, left raw.
                          <label
                            key={u.id}
                            className="flex cursor-pointer items-center gap-2 rounded-control px-1.5 py-1 text-sm text-text-primary hover:bg-background-light"
                          >
                            <Checkbox
                              checked={assigned}
                              disabled={assignPending}
                              aria-label={u.name}
                              onCheckedChange={() => toggleAssignment(row, u.id, assigned)}
                            />
                            <span>{u.name}</span>
                          </label>
                        );
                      })
                    )}
                  </div>
                )}
              </div>
            </Card>
          );
        })}
      </div>
    </div>
  );
}

/**
 * Task D2 — post-assignment CTM setup guidance. ServWave only automates the
 * CONFIRMED half of inbound routing (a voicemail fallback); the rest
 * (Queue/agent ring config) is a one-time manual step in CTM's dashboard.
 * This panel hands the admin exact values instead of leaving them to guess:
 * `synced:true` renders `describeManualQueueScaffold`'s instructions
 * (numbered, with the real voice-menu name/id already filled in);
 * `synced:false` is a plain warning explaining why nothing was set up (never
 * a silent gap).
 */
function RoutingGuidancePanel({
  numberFormatted,
  result,
  onDismiss,
}: {
  numberFormatted: string;
  result: RoutingSyncResult;
  onDismiss: () => void;
}) {
  if (!result.synced) {
    return (
      <Card padding="sm" tone="warning" className="flex items-start gap-3">
        <AlertTriangle className="h-5 w-5 shrink-0 text-warning" />
        <div className="min-w-0 flex-1 space-y-1">
          <p className="text-sm font-semibold text-text-primary">
            Couldn&apos;t sync inbound routing for {numberFormatted}
          </p>
          <p className="text-sm text-text-secondary">{result.reason}</p>
        </div>
        <Button variant="ghost" size="sm" aria-label="Dismiss" onClick={onDismiss}>
          <X className="h-4 w-4" />
        </Button>
      </Card>
    );
  }

  const { manual_scaffold: scaffold } = result;
  return (
    <Card padding="sm" tone="brand" className="flex items-start gap-3">
      <PhoneForwarded className="h-5 w-5 shrink-0 text-primary" />
      <div className="min-w-0 flex-1 space-y-2">
        <p className="text-sm font-semibold text-text-primary">{scaffold.title}</p>
        <p className="text-sm text-text-secondary">{scaffold.summary}</p>
        <ol className="list-decimal space-y-1 pl-4 text-sm text-text-primary">
          {scaffold.steps.map((step, i) => (
            <li key={i}>{step}</li>
          ))}
        </ol>
      </div>
      <Button variant="ghost" size="sm" aria-label="Dismiss" onClick={onDismiss}>
        <X className="h-4 w-4" />
      </Button>
    </Card>
  );
}
