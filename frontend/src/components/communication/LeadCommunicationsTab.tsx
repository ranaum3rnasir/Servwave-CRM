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
import { useState } from 'react';
import { MessageSquare, Phone } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
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

  const [body, setBody] = useState('');
  // Row → detail drawer (calls only in this slice), gated on comms access.
  const [selectedCallId, setSelectedCallId] = useState<string | null>(null);
  const [selectedSmsCustomerId, setSelectedSmsCustomerId] = useState<string | null>(null);

  const handleSend = () => {
    const trimmed = body.trim();
    if (!trimmed || sendSms.isPending || !customerId) return;
    sendSms.mutate({ customerId, body: trimmed }, { onSuccess: () => setBody('') });
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
                <Skeleton className="h-4 w-48" />
                <Skeleton className="h-3 w-72" />
              </div>
            </div>
          ))}
        </div>
      ) : isError ? (
        <div className="flex flex-col items-center justify-center py-12 text-center">
          <p className="text-sm text-danger">Failed to load communications.</p>
        </div>
      ) : timeline.length === 0 ? (
        <EmptyState
          icon={MessageSquare}
          title="No communication on this lead yet."
         
        />
      ) : (
        <ol className="space-y-0.5">
          {timeline.map((it) => (
            <CommRow
              key={it.id}
              item={it}
              formatTimestamp={formatAt}
              currentLeadId={leadId}
              customerId={customerId}
              onSelect={
                canAccessComms
                  ? it.channel === 'call'
                    ? () => setSelectedCallId(it.id)
                    : it.channel === 'sms' && customerId
                      ? () => setSelectedSmsCustomerId(customerId ?? null)
                      : undefined
                  : undefined
              }
              className="rounded-lg px-2 py-2.5 hover:bg-background-light"
            />
          ))}
        </ol>
      )}

      {/* Composer — texts sent here are stamped with this lead at origin.
          Rendered only for comms-enabled orgs + users with create Communication;
          everyone else gets the clean read-only timeline. */}
      {canCompose && (
        <div className="mt-4 border-t border-border pt-3">
          <div className="flex items-end gap-2">
            <Textarea
              rows={2}
              value={body}
              onChange={(e) => setBody(e.target.value)}
              onKeyDown={(e) => {
                if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
                  e.preventDefault();
                  handleSend();
                }
              }}
              placeholder={`Text ${customerName ?? 'customer'}…`}
              className="min-h-0 flex-1 resize-none"
            />
            <Button
              variant="solid" tone="business"
              onClick={handleSend}
              disabled={sendSms.isPending || !body.trim()}
            >
              Send
            </Button>
          </div>
          {sendSms.isError && (
            <p className="mt-1.5 text-sm text-danger">
              {extractApiError(sendSms.error, 'Failed to send text')}
            </p>
          )}
          <p className="mt-1.5 flex items-center gap-2 text-[11px] text-text-soft">
            <span className="text-text-secondary/70">⌘↵ to send</span>·
            <span>
              Texts sent from this lead are tagged {leadLabel ?? 'to this lead'} automatically.
            </span>
          </p>
        </div>
      )}

      {selectedCallId && (
        <EntityCallDrawer callId={selectedCallId} onClose={() => setSelectedCallId(null)} />
      )}
      {selectedSmsCustomerId && (
        <EntitySmsDrawer
          customerId={selectedSmsCustomerId}
          customerName={customerName}
          onClose={() => setSelectedSmsCustomerId(null)}
        />
      )}
    </div>
  );
}
