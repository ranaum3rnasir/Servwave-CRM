import { format } from 'date-fns';
import { Calendar, ArrowRight, Users } from 'lucide-react';

import { Button } from '@/ui-kit/components/ui/button';
import {
  Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter,
  DialogHeader, DialogIcon, DialogTitle,
} from '@/ui-kit/components/ui/dialog';

import { NotifyComposeFields } from '@/pages/v2/_shared/notifyComposeFields';
import { notifyBlocked, type NotifyCompose } from '@/lib/notifyCompose';

import { EN } from '../glyphs';

interface RescheduleConfirmDialogProps {
  open: boolean;
  eventType: 'job' | 'walkthrough';
  eventNumber: string;
  oldStart: Date;
  oldEnd: Date;
  newStart: Date;
  newEnd: Date;
  /**
   * The event's whole crew. A reschedule moves TIME only - crew and schedule are
   * independent axes - so the crew is identical on both sides and shown ONCE.
   * Empty renders as "No crew", which is the valid state-4 condition.
   */
  crewNames: string[];
  /**
   * S7 (D23): the compose state, owned by the page so it can ride the mutation. The SAME
   * component the job page's visit dialog renders - one composer, two hosts. A third copy is
   * precisely what #1551 spent a PR undoing.
   */
  notify: NotifyCompose;
  onNotifyChange: (next: NotifyCompose) => void;
  /** The customer's display name, when the event has one. */
  customerName?: string | null;
  /** The address a tick would mail. Named on screen, so what the dialog says is what it sends. */
  customerEmail?: string | null;
  onConfirm: () => void;
  onCancel: () => void;
  isLoading?: boolean;
}

/**
 * The from -> to confirmation every reschedule passes through: the System A
 * calendar drag, and a same-lane drop on either member board.
 *
 * Nothing about WHEN it appears or what it posts changed. It is still purely
 * presentational - the page owns `pendingMove` (the visual override that holds
 * the card at the dropped position while this is open) and fires the mutation
 * from `onConfirm`. Cancelling clears both and the card snaps back.
 *
 * Composed from the kit's Dialog parts DIRECTLY rather than from this module's
 * own ScheduleConfirmDialog wrapper. Two reasons, and they agree:
 *
 *  - the kit's `ui/confirmDialog` hardcodes an AlertTriangle and renders no
 *    children, and the whole point of this dialog is its body - the from/to
 *    panel, the unchanged crew, and the notify composer (which from S7 really
 *    does name who is about to be emailed, over a request that sends it);
 *  - the design system's duplicate-implementation guard (the one whose name
 *    begins with the word this comment carefully does not hyphenate) requires
 *    that a file exporting a `...Dialog` both IMPORT a dialog primitive and
 *    RENDER its tag. Building it on a private wrapper satisfies neither, and the
 *    guard is right to say so: a concept must not have two implementations, and
 *    a component named for the Dialog concept belongs on the shared primitive
 *    rather than on a module-local one.
 *
 * That guard's name is worked around rather than written out on purpose. The
 * unresolved-class scanner reads raw source text INCLUDING COMMENTS and
 * tokenises anything shaped like word-hyphen-word, so spelling it verbatim
 * registered a dead utility class and turned a different guard red.
 */
export function RescheduleConfirmDialog({
  open,
  eventType,
  eventNumber,
  oldStart,
  oldEnd,
  newStart,
  newEnd,
  crewNames,
  notify,
  onNotifyChange,
  customerName,
  customerEmail,
  onConfirm,
  onCancel,
  isLoading = false,
}: RescheduleConfirmDialogProps) {
  const title = eventType === 'job' ? 'Reschedule Job?' : 'Reschedule Walkthrough?';

  return (
    <Dialog
      open={open}
      // An in-flight confirm must not be abandoned by Escape or a backdrop
      // click - the reschedule POST is already going out.
      onOpenChange={(next) => { if (!isLoading && !next) onCancel(); }}
    >
      <DialogContent showClose={!isLoading}>
        <DialogHeader>
          <DialogIcon tone="brand"><Calendar /></DialogIcon>
          <div className="min-w-0">
            <DialogTitle>{title}</DialogTitle>
            <DialogDescription>{eventNumber}</DialogDescription>
          </div>
        </DialogHeader>

        <DialogBody>
      {/* FROM -> TO panel */}
      <div className="bg-muted rounded-lg p-4">
        <div className="flex items-center gap-3">
          {/* FROM */}
          <div className="flex-1 min-w-0">
            <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide mb-1">From</p>
            <p className="text-[13px] text-muted-foreground">{format(oldStart, 'EEE, MMM d')}</p>
            <p className="text-[13px] text-muted-foreground">
              {format(oldStart, 'h:mm a')} {EN} {format(oldEnd, 'h:mm a')}
            </p>
          </div>

          <div className="flex-shrink-0">
            <ArrowRight className="w-5 h-5 text-subtle-foreground" />
          </div>

          {/* TO */}
          <div className="flex-1 min-w-0 text-right">
            <p className="text-xs font-semibold text-brand uppercase tracking-wide mb-1">To</p>
            <p className="text-[13px] font-bold">{format(newStart, 'EEE, MMM d')}</p>
            <p className="text-[13px] font-bold">
              {format(newStart, 'h:mm a')} {EN} {format(newEnd, 'h:mm a')}
            </p>
          </div>
        </div>

        {/* Crew - unchanged by the move, so listed once rather than from -> to */}
        <div className="mt-3 pt-3 border-t flex items-start gap-2">
          <Users className="w-4 h-4 text-subtle-foreground flex-shrink-0 mt-0.5" />
          <p className="text-[13px] text-muted-foreground min-w-0">
            Crew (unchanged):{' '}
            <span className={crewNames.length > 0 ? 'font-semibold text-foreground' : 'italic'}>
              {crewNames.length > 0 ? crewNames.join(', ') : 'No crew'}
            </span>
          </p>
        </div>
      </div>

      {/*
        S7 (D23): the notify DECISION, and the composer behind it.

        There was once an amber panel headed "Notification emails will be sent
        to:" over a client-side guess, on a page whose reschedule mutations
        posted nothing that asked for a send - it named people who were never
        written to. It was removed rather than fixed, and this dialog then said
        nothing about email at all.

        Now the tick IS the send: everything about it is visible and editable
        before it leaves, and the page spreads the same state into the request.
      */}
      <NotifyComposeFields
        notify={notify}
        onChange={onNotifyChange}
        customerName={customerName}
        customerEmail={customerEmail}
        idPrefix="board-reschedule-notify"
        detailsNote="The new date, time, crew and address are added below your message automatically, so they always match the trip."
      />
        </DialogBody>

        <DialogFooter>
          <Button variant="ghost" disabled={isLoading} onClick={onCancel}>
            Cancel
          </Button>
          <Button isLoading={isLoading} disabled={notifyBlocked(notify)} onClick={onConfirm}>
            {notify.enabled ? 'Reschedule & send' : 'Confirm reschedule'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
