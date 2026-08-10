import { format } from 'date-fns';
import { Calendar, Mail, ArrowRight, Users } from 'lucide-react';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';

interface RescheduleConfirmDialogProps {
  open: boolean;
  eventType: 'job' | 'walkthrough';
  eventNumber: string;
  oldStart: Date;
  oldEnd: Date;
  newStart: Date;
  newEnd: Date;
  /** The event's whole crew — a reschedule moves TIME only (crew ⟂ schedule), so the
   *  crew is identical on both sides and shown ONCE. Empty = "No crew" (state 4). */
  crewNames: string[];
  emailRecipients: string[];
  onConfirm: () => void;
  onCancel: () => void;
  isLoading?: boolean;
}

export function RescheduleConfirmDialog({
  open,
  eventType,
  eventNumber,
  oldStart,
  oldEnd,
  newStart,
  newEnd,
  crewNames,
  emailRecipients,
  onConfirm,
  onCancel,
  isLoading = false,
}: RescheduleConfirmDialogProps) {
  const title = eventType === 'job' ? 'Reschedule Job?' : 'Reschedule Walkthrough?';

  return (
    <ConfirmDialog
      open={open}
      onOpenChange={(next) => { if (!next) onCancel(); }}
      icon={Calendar}
      title={title}
      description={eventNumber}
      confirmLabel="Confirm & Notify"
      onConfirm={onConfirm}
      isLoading={isLoading}
      className="max-w-md"
    >
      {/* FROM → TO panel */}
      <div className="bg-background-light rounded-lg p-4">
        <div className="flex items-center gap-3">
          {/* FROM */}
          <div className="flex-1 min-w-0">
            <p className="text-xs font-medium text-text-secondary uppercase tracking-wide mb-1">From</p>
            <p className="text-sm text-text-secondary">{format(oldStart, 'EEE, MMM d')}</p>
            <p className="text-sm text-text-secondary">
              {format(oldStart, 'h:mm a')} – {format(oldEnd, 'h:mm a')}
            </p>
          </div>

          {/* Arrow */}
          <div className="flex-shrink-0">
            <ArrowRight className="w-5 h-5 text-text-secondary" />
          </div>

          {/* TO */}
          <div className="flex-1 min-w-0 text-right">
            <p className="text-xs font-medium text-primary uppercase tracking-wide mb-1">To</p>
            <p className="text-sm font-semibold text-text-primary">{format(newStart, 'EEE, MMM d')}</p>
            <p className="text-sm font-semibold text-text-primary">
              {format(newStart, 'h:mm a')} – {format(newEnd, 'h:mm a')}
            </p>
          </div>
        </div>

        {/* Crew — unchanged by the move (crew ⟂ schedule), so listed once, not from→to */}
        <div className="mt-3 pt-3 border-t border-border/60 flex items-start gap-2">
          <Users className="w-4 h-4 text-text-secondary flex-shrink-0 mt-0.5" />
          <p className="text-sm text-text-secondary min-w-0">
            Crew (unchanged):{' '}
            <span className={crewNames.length > 0 ? 'font-medium text-text-primary' : 'italic'}>
              {crewNames.length > 0 ? crewNames.join(', ') : 'No crew'}
            </span>
          </p>
        </div>
      </div>

      {/* Email notice */}
      {emailRecipients.length > 0 && (
        <div className="mt-4 bg-warning-surface border border-warning-border rounded-lg p-4">
          <div className="flex items-start gap-2">
            <Mail className="w-4 h-4 text-warning-text flex-shrink-0 mt-0.5" />
            <div>
              <p className="text-sm font-medium text-warning-text">Notification emails will be sent to:</p>
              <ul className="mt-1 space-y-0.5">
                {emailRecipients.map((recipient) => (
                  <li key={recipient} className="text-sm text-warning-text">
                    • {recipient}
                  </li>
                ))}
              </ul>
            </div>
          </div>
        </div>
      )}
    </ConfirmDialog>
  );
}
