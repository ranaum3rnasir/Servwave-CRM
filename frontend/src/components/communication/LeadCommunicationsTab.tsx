/**
 * Lead page Communication tab (slice E4-FE + verification follow-up) — a unified
 * timeline over GET /api/leads/:id/communications: STRICTLY the rows attributed
 * to this lead by lead_id, matching the Job tab's job_id scoping exactly (full
 * job-parity ruling, 2026-07-22 — no customer-history union). A row whose
 * lead_id is null — e.g. a phone-matched call never explicitly tied to THIS
 * lead — will not surface here, same as an unattributed row on a job's timeline.
 *
 * Rendering rides the shared CommRow (E6): navigable job chips + the gated
 * attach/move/detach menu on call/sms/email rows, and the lead chip suppressed for
 * THIS lead's own rows (no self-link).
 *
 * Compose parity with the Job tab: a "Call customer" entry (in-app dialer with
 * lead context) + an SMS composer that stamps outgoing texts with this lead at
 * origin — both gated on comms-module access + create ability (a composer would
 * 403 for non-pilot orgs). Email-from-lead is intentionally omitted (the email
 * endpoint stamps job_id only, no lead_id yet).
 */
import { useState, useEffect } from 'react';
import { useSearchParams } from 'react-router-dom';
import { MessageSquare, Phone } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import { extractApiError } from '@/lib/utils';
import { useAppAbility } from '@/contexts/AbilityContext';
import { useFeature } from '@/lib/entitlements';
import { requestCall } from '@/lib/communication/phoneTabHandoff';
import { CommRow } from '@/components/communication/shared/CommRow';
import { EntityCallDrawer } from '@/components/communication/shared/EntityCallDrawer';
import { EntitySmsDrawer } from '@/components/communication/shared/EntitySmsDrawer';
import { EmptyState } from '@/components/ui/empty-state';
import { useLeadCommunications, useSendLeadSms } from '@/lib/api/jobCommunications';
import { useSpiderWatcherStore } from '@/stores/spiderWatcherStore';

function formatAt(at: string) {
  return new Date(at).toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

export function LeadCommunicationsTab({
  leadId,
  leadLabel,
  customerId,
  customerName,
  customerPhone,
}: {
  leadId: string;
  /** The lead's L-number — stamped into the composer caption + call context. */
  leadLabel?: string;
  /** The lead's customer — powers the open-jobs attach menu, SMS routing + call. */
  customerId?: string;
  customerName?: string;
  customerPhone?: string;
}) {
  const { data: items, isLoading, isError } = useLeadCommunications(leadId);
  const sendSms = useSendLeadSms(leadId);
  const ability = useAppAbility();
  const canAccessComms = useFeature('phone');
  // Composer + call entry: the org must have comms-module access AND the user
  // the create ability, and we need a customer to route SMS / bind the call —
  // otherwise this tab stays a clean read-only timeline.
  const canCompose =
    canAccessComms && ability.can('create', 'Communication') && !!customerId;

  const [searchParams, setSearchParams] = useSearchParams();
  const [body, setBody] = useState(() => searchParams.get('draft') || '');

  // Pre-fill composer if a draft message was provided via URL (e.g. from Spider Notification)
  useEffect(() => {
    const draft = searchParams.get('draft');
    if (draft && draft !== body) {
      setBody(draft);
    }
  }, [searchParams]);

  // Row → detail drawer (calls only in this slice), gated on comms access.
  const [selectedCallId, setSelectedCallId] = useState<string | null>(null);
  const [selectedSmsCustomerId, setSelectedSmsCustomerId] = useState<string | null>(null);

  const handleSend = () => {
    const trimmed = body.trim();
    if (!trimmed || sendSms.isPending || !customerId) return;
    sendSms.mutate({ customerId, body: trimmed }, {
      onSuccess: () => {
        setBody('');
        // Mark active Spider Lead notifications as read upon successfully sending message
        useSpiderWatcherStore.getState().markLeadNotificationsRead(leadId);
        if (searchParams.has('draft')) {
          const next = new URLSearchParams(searchParams);
          next.delete('draft');
          setSearchParams(next, { replace: true });
        }
      },
    });
  };

  // Backend returns ascending (oldest first); the roll-up reads newest-first,
  // matching the Customer page convention.
  const timeline = items ? [...items].sort((a, b) => b.at.localeCompare(a.at)) : [];

  return (
    <div>
      {canCompose && customerPhone && (
        <div className="mb-3 flex items-center justify-end">
          {/* Interactive chrome → ocean (default), never sage. */}
          <Button
            size="sm"
            onClick={() =>
              requestCall(customerPhone, {
                leadId,
                leadLabel,
                customerId,
                customerName,
              })
            }
          >
            <Phone className="mr-1.5 h-3.5 w-3.5" />
            Call customer
          </Button>
        </div>
      )}

      {isLoading ? (
        <div className="space-y-3">
          {Array.from({ length: 4 }).map((_, i) => (
            <div key={i} className="flex gap-3 px-2 py-2.5">
              <Skeleton className="h-4 w-4 shrink-0" />
              <div className="flex-1 space-y-2">
                <Skeleton className="h-4 w-1/3" />
                <Skeleton className="h-3 w-3/4" />
              </div>
            </div>
          ))}
        </div>
      ) : isError ? (
        <EmptyState
          title="Could not load communications"
          description="Please refresh or try again later."
        />
      ) : timeline.length === 0 ? (
        <EmptyState
          title="No communication on this lead yet."
          description={
            canCompose
              ? 'Send an SMS below to start the conversation for this lead.'
              : 'Communications tied to this lead will appear here.'
          }
        />
      ) : (
        <ul className="divide-y divide-border/60">
          {timeline.map((item) => (
            <CommRow
              key={`${item.channel}-${item.id}`}
              item={item}
              formatTimestamp={formatAt}
              currentLeadId={leadId}
              customerId={customerId}
              onSelect={
                canAccessComms
                  ? (row) => {
                      if (row.channel === 'call') setSelectedCallId(row.id);
                      if (row.channel === 'sms' && customerId) setSelectedSmsCustomerId(customerId);
                    }
                  : undefined
              }
            />
          ))}
        </ul>
      )}

      {/* ── SMS Composer ────────────────────────────────────────────── */}
      {canCompose && (
        <div className="mt-4 rounded-lg border border-border bg-surface-light p-3">
          <Label size="xs" weight="semibold" tone="subtle" className="mb-1.5 block">
            Send SMS
            {leadLabel && (
              <span className="ml-1 text-text-soft">· Tied to {leadLabel}</span>
            )}
          </Label>
          <Textarea
            value={body}
            onChange={(e) => setBody(e.target.value)}
            placeholder={customerName ? `Text ${customerName}...` : 'Type a message...'}
            className="min-h-[72px] resize-y text-xs"
            disabled={sendSms.isPending}
          />
          {sendSms.error && (
            <p className="mt-1.5 text-xs text-danger">
              {extractApiError(sendSms.error, 'Failed to send SMS')}
            </p>
          )}
          <div className="mt-2 flex items-center justify-between">
            <span className="text-[11px] text-text-soft">
              {body.length > 0 && `${body.length} character${body.length === 1 ? '' : 's'}`}
            </span>
            <Button
              size="sm"
              onClick={handleSend}
              disabled={!body.trim() || sendSms.isPending}
            >
              <MessageSquare className="mr-1.5 h-3.5 w-3.5" />
              Send
            </Button>
          </div>
        </div>
      )}

      {/* Detail drawers (interactive drill-in from timeline rows) */}
      {selectedCallId && (
        <EntityCallDrawer
          callId={selectedCallId}
          onClose={() => setSelectedCallId(null)}
        />
      )}
      {selectedSmsCustomerId && (
        <EntitySmsDrawer
          customerId={selectedSmsCustomerId}
          onClose={() => setSelectedSmsCustomerId(null)}
        />
      )}
    </div>
  );
}
