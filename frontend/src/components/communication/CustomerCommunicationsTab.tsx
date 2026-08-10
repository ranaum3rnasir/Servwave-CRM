/**
 * Customer page communications roll-up (Communication ↔ Jobs, Surface 3).
 * One unified Variant-A timeline across ALL channels (calls / SMS / email /
 * WhatsApp), newest first, every row badged by job — "badge it, don't hide it":
 * the muted "no job" pill keeps per-job legibility even for unattributed rows.
 */
import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { MessageSquare } from 'lucide-react';
import api from '@/lib/axios';
import { Skeleton } from '@/components/ui/skeleton';
import { useFeature } from '@/lib/entitlements';
import { CommRow } from '@/components/communication/shared/CommRow';
import { EntityCallDrawer } from '@/components/communication/shared/EntityCallDrawer';
import { EntitySmsDrawer } from '@/components/communication/shared/EntitySmsDrawer';
import { EmptyState } from '@/components/ui/empty-state';
// Shared CommItem contract — single frontend declaration, field names FROZEN
// (mirrors the backend mapper).
import type { CommItem } from '@/lib/api/jobCommunications';

function formatAt(at: string) {
  return new Date(at).toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

export function CustomerCommunicationsTab({ customerId }: { customerId: string }) {
  const canAccessComms = useFeature('phone');
  // Row → detail drawer (calls only in this slice), gated on comms access — the
  // call/recording/transcript endpoints 404 for non-pilot orgs.
  const [selectedCallId, setSelectedCallId] = useState<string | null>(null);
  const [selectedSmsCustomerId, setSelectedSmsCustomerId] = useState<string | null>(null);
  const { data: items, isLoading, isError } = useQuery({
    queryKey: ['customer-communications', customerId],
    queryFn: async () => {
      const { data } = await api.get(`/api/customers/${customerId}/communications`);
      return data.items as CommItem[];
    },
    enabled: Boolean(customerId),
    // Live refresh — a call/text lands as a webhook row seconds after hangup;
    // poll + refetch on focus so it appears without a manual reload (house
    // pattern, notifications.ts).
    refetchInterval: 15_000,
    refetchOnWindowFocus: true,
  });

  if (isLoading) {
    return (
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
    );
  }

  if (isError) {
    return (
      <div className="flex flex-col items-center justify-center py-12 text-center">
        <p className="text-sm text-danger">Failed to load communications.</p>
      </div>
    );
  }

  if (!items || items.length === 0) {
    return (
      <EmptyState
        icon={MessageSquare}
        title="No communication with this customer yet."
       
      />
    );
  }

  // Backend returns ascending (oldest first); the roll-up reads newest-first,
  // matching the page's "most recent" convention on the sibling tabs.
  const timeline = [...items].sort((a, b) => b.at.localeCompare(a.at));

  return (
    <>
      <ol className="space-y-0.5">
        {timeline.map((it) => (
          // Shared row (slice E6): same standard line as the Job/Lead tabs —
          // direction · who (· answered by) with navigable lead/job chips and
          // the gated attach/move/detach menu on call/sms/email rows.
          <CommRow
            key={it.id}
            item={it}
            formatTimestamp={formatAt}
            customerId={customerId}
            onSelect={
              canAccessComms
                ? it.channel === 'call'
                  ? () => setSelectedCallId(it.id)
                  : it.channel === 'sms'
                    ? () => setSelectedSmsCustomerId(customerId)
                    : undefined
                : undefined
            }
            className="rounded-lg px-2 py-2.5 hover:bg-background-light"
          />
        ))}
      </ol>
      {selectedCallId && (
        <EntityCallDrawer callId={selectedCallId} onClose={() => setSelectedCallId(null)} />
      )}
      {selectedSmsCustomerId && (
        <EntitySmsDrawer
          customerId={selectedSmsCustomerId}
          onClose={() => setSelectedSmsCustomerId(null)}
        />
      )}
    </>
  );
}
