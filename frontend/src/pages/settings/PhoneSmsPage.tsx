import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useOrganization } from '@/lib/api/organization';
import { useAppAbility } from '@/contexts/AbilityContext';
import api from '@/lib/axios';
import { toast } from '@/components/ui/use-toast';
import { extractApiError } from '@/lib/utils';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Heading } from '@/components/ui/heading';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogFooter,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog';

/**
 * Settings → Phone & SMS (master plan §5.6). Mirrors PaymentsListsPage's
 * gating pattern (`hasStripe` → `hasCtm`) with two additions Payments lacks:
 * a loading skeleton while the org loads and an error row on query failure.
 * Connection state is read from the org record; connect / disconnect /
 * check-a2p are page-local mutations against /api/organization (admin-only —
 * the same `update Organization` ability that reveals this nav entry).
 */
export default function PhoneSmsPage() {
  const { data: org, isLoading, isError } = useOrganization();
  const ability = useAppAbility();
  const canManage = ability.can('update', 'Organization');
  const qc = useQueryClient();

  const [accountId, setAccountId] = useState('');
  const [confirmDisconnect, setConfirmDisconnect] = useState(false);

  const connect = useMutation({
    mutationFn: (ctm_account_id: string) =>
      api.post('/api/organization/connect-ctm', { ctm_account_id }).then((r) => r.data),
    onSuccess: (data: { numbers_imported?: number; sms_ready?: boolean; warnings?: string[] }) => {
      qc.invalidateQueries({ queryKey: ['organization'] });
      setAccountId('');
      toast({
        title: 'Phone system connected',
        description: [
          `${data.numbers_imported ?? 0} number(s) imported.`,
          data.sms_ready ? 'SMS is ready.' : 'SMS not ready yet — check A2P status below.',
          ...(data.warnings ?? []),
        ].join(' '),
      });
    },
    onError: (err) =>
      toast({
        variant: 'destructive',
        title: "Couldn't connect the phone system",
        description: extractApiError(err, 'Connection failed — try again.'),
      }),
  });

  const checkA2p = useMutation({
    mutationFn: () => api.post('/api/organization/connect-ctm/check-a2p').then((r) => r.data),
    onSuccess: (data: { sms_ready?: boolean }) => {
      qc.invalidateQueries({ queryKey: ['organization'] });
      toast({
        title: data.sms_ready ? 'SMS is ready' : 'SMS not ready yet',
        description: data.sms_ready
          ? 'The A2P campaign is approved — outgoing texts are enabled.'
          : 'The A2P campaign is not approved yet. Check again later.',
      });
    },
    onError: (err) =>
      toast({
        variant: 'destructive',
        title: "Couldn't check A2P status",
        description: extractApiError(err, 'Status check failed — try again.'),
      }),
  });

  const disconnect = useMutation({
    mutationFn: () => api.post('/api/organization/disconnect-ctm').then((r) => r.data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['organization'] });
      setConfirmDisconnect(false);
      toast({ title: 'Phone system disconnected' });
    },
    onError: (err) => {
      setConfirmDisconnect(false);
      toast({
        variant: 'destructive',
        title: "Couldn't disconnect the phone system",
        description: extractApiError(err, 'Disconnect failed — try again.'),
      });
    },
  });

  // Loading skeleton (§5.6 — an addition over the Payments page).
  if (isLoading) {
    return (
      <div className="grid items-start gap-6 lg:grid-cols-2">
        {[0, 1].map((i) => (
          <Card key={i} className="space-y-3">
            <Skeleton className="h-4 w-40" />
            <Skeleton className="h-3 w-full" />
            <Skeleton className="h-14 w-full" />
          </Card>
        ))}
      </div>
    );
  }

  // Error row (§5.6 — an addition over the Payments page).
  if (isError || !org) {
    return (
      <Card>
        <p className="text-sm text-danger">
          Couldn&apos;t load the phone &amp; SMS settings — refresh the page to try again.
        </p>
      </Card>
    );
  }

  const hasCtm = Boolean(org.ctm_account_id);

  return (
    <div className="space-y-6">
      <div className="grid items-start gap-6 lg:grid-cols-2">
        {/* Connection card */}
        <Card className="space-y-4">
          <div>
            <Heading level={3}>Phone System</Heading>
            <p className="text-xs text-text-secondary">
              Calls and texts run through the organization&apos;s connected phone system. Numbers
              are managed under Communication → Phone → Numbers.
            </p>
          </div>

          {hasCtm ? (
            <div className="flex items-center justify-between gap-3 rounded-lg border border-border p-3">
              <div className="min-w-0">
                <p className="text-sm font-medium text-text-primary">Connected</p>
                <p className="truncate text-xs text-text-secondary">
                  Phone system account ID:{' '}
                  <span className="font-mono">{org.ctm_account_id}</span>
                </p>
              </div>
              {canManage && (
                <Button
                  variant="solid" tone="danger"
                  size="sm"
                  onClick={() => setConfirmDisconnect(true)}
                  disabled={disconnect.isPending}
                >
                  Disconnect
                </Button>
              )}
            </div>
          ) : canManage ? (
            <div className="space-y-2">
              <Label className="text-xs">Phone system account ID</Label>
              <div className="flex gap-2">
                <Input
                  value={accountId}
                  onChange={(e) => setAccountId(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && accountId.trim() && !connect.isPending) {
                      e.preventDefault();
                      connect.mutate(accountId.trim());
                    }
                  }}
                  placeholder="Account ID"
                  className="flex-1"
                  maxLength={40}
                />
                <Button
                  size="sm"
                  onClick={() => connect.mutate(accountId.trim())}
                  disabled={!accountId.trim() || connect.isPending}
                >
                  {connect.isPending ? 'Connecting…' : 'Connect'}
                </Button>
              </div>
              <p className="text-xs text-text-secondary">
                Numbers and webhooks are imported automatically on connect.
              </p>
            </div>
          ) : (
            <p className="text-sm text-text-secondary">
              (Phone system not connected — contact support)
            </p>
          )}
        </Card>

        {/* SMS readiness card */}
        <Card className="space-y-4">
          <div>
            <Heading level={3}>Text Messaging (SMS)</Heading>
            <p className="text-xs text-text-secondary">
              Outgoing texts require an approved A2P campaign on the connected phone system
              account.
            </p>
          </div>

          {hasCtm ? (
            <div className="flex items-center justify-between gap-3 rounded-lg border border-border p-3">
              <div className="flex min-w-0 items-center gap-2">
                <Badge intent={org.ctm_sms_ready ? 'success' : 'warning'}>
                  {org.ctm_sms_ready ? 'SMS ready' : 'Not ready'}
                </Badge>
                {!org.ctm_sms_ready && (
                  <span className="truncate text-xs text-text-secondary">
                    A2P campaign pending approval
                  </span>
                )}
              </div>
              {canManage && (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => checkA2p.mutate()}
                  disabled={checkA2p.isPending}
                >
                  {checkA2p.isPending ? 'Checking…' : 'Check A2P status'}
                </Button>
              )}
            </div>
          ) : (
            <p className="text-sm italic text-text-secondary">
              Connect the phone system to enable texting.
            </p>
          )}
        </Card>
      </div>

      {/* Manual per-org phone-system onboarding steps (owner-executed — plan §2):
          the consent greeting + recording retention live with the provider, never
          here. Provider is never named in user-facing copy. */}
      <p className="text-xs text-text-secondary">
        Manual setup: the recording-consent greeting and the recording retention policy are
        configured with your phone system provider, not in ServWave. Contact support if you need
        these changed.
      </p>

      <Dialog open={confirmDisconnect} onOpenChange={(o) => !o && setConfirmDisconnect(false)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Disconnect the phone system?</DialogTitle>
            <DialogDescription>
              Calls and texts will stop syncing into ServWave. Your phone system account, its
              numbers, and its call history are not affected, and you can reconnect at any time.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setConfirmDisconnect(false)}>
              Keep connected
            </Button>
            <Button
              variant="solid" tone="danger"
              onClick={() => disconnect.mutate()}
              disabled={disconnect.isPending}
            >
              {disconnect.isPending ? 'Disconnecting…' : 'Disconnect'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
