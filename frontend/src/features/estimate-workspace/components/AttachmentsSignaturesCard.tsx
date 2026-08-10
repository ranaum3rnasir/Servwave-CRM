import { PenLine } from 'lucide-react';
import { AttachmentsPanel } from '@/components/crm/AttachmentsPanel';
import { Heading } from '@/components/ui/heading';

interface AttachmentsSignaturesCardProps {
  estimateId: string;
  signatureData?: string | null;
  signatureAt?: string | null;
}

/**
 * Attachments + Signatures for the bottom of the estimate workspace.
 *
 * Attachments are real (§P2 #13) — the same generic `AttachmentsPanel` used on Jobs/
 * Customers, wired to `entityType="ESTIMATE"`, backed by the real `/api/attachments` API.
 * Not gated on the estimate's lock state — supplementary files (site photos, permits) aren't
 * part of the quoted price/scope §A1 locks, so they stay attachable even on a locked estimate.
 * Signatures are read-only: the ONE real signature source is the customer's public-approval
 * capture (`Estimate.signature_data`) — there's no staff-side "add signature" endpoint, so we
 * don't fake one (§C: no control that shows success without a real backend write).
 */
export function AttachmentsSignaturesCard({ estimateId, signatureData, signatureAt }: AttachmentsSignaturesCardProps) {
  return (
    <div className="mt-4 grid gap-4 lg:grid-cols-2">
      <div className="rounded-card border border-border bg-surface-light p-6 shadow-card">
        <AttachmentsPanel entityType="ESTIMATE" entityId={estimateId} />
      </div>

      <div className="rounded-card border border-border bg-surface-light p-6 shadow-card">
        <div className="mb-4 flex items-center justify-between border-b border-border pb-3">
          <Heading level={3} scale="lg" weight="bold" className="flex items-center gap-2">
            <PenLine className="h-5 w-5" />
            Signature
          </Heading>
        </div>
        {signatureData ? (
          <div className="rounded-lg border border-border bg-surface-light p-2">
            <img src={signatureData} alt="Customer signature" className="h-20 w-full object-contain" />
            {signatureAt && (
              <p className="mt-1 text-xs text-text-secondary">
                Signed {new Date(signatureAt).toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' })}
              </p>
            )}
          </div>
        ) : (
          <p className="py-10 text-center text-sm text-text-secondary">No signature yet</p>
        )}
      </div>
    </div>
  );
}
