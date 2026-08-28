import { Clock, Info } from 'lucide-react';

import type { TriggerSelection } from '@/lib/workflows/triggerModel';
import type { WorkflowCatalog } from '@/lib/api/workflows';
import { splitOffset, type OffsetUnit } from '@/lib/workflows/timing';

import { ELLIPSIS, EM_DASH, RSQUO } from '../glyphs';

/**
 * The live plain-English summary under the trigger builder. Always mounted
 * while the builder is open, re-rendering on every pick, so the office sees
 * exactly what they are building as one flowing sentence.
 *
 * `role="status"` on the sentence paragraph makes it a live region and gives
 * tests one stable node to read `.textContent` from despite the sentence being
 * assembled out of several inline spans.
 *
 * KNOWN, PRESERVED: the sentence tail is hardcoded "send the customer an
 * email." even when the workflow's first step is a text or a team
 * notification. That is what the code does today; the migration preserves
 * behaviour, and the observation is recorded in the branch ledger.
 */
export interface TriggerReadbackProps {
  selection: TriggerSelection;
  catalog: WorkflowCatalog;
}

/** Singularizes the unit word only when n === 1. */
function pluralizeUnit(n: number, unit: OffsetUnit): string {
  if (n === 1) return `1 ${unit.replace(/s$/, '')}`;
  return `${n} ${unit}`;
}

/**
 * Every return value already starts with an uppercase letter or a digit, so no
 * separate capitalization pass is needed on top.
 */
function dateLeadPhrase(direction: 'before' | 'after', offsetMinutes: number, anchorLabel: string): string {
  const { value, unit } = splitOffset(offsetMinutes);
  const preposition = direction === 'before' ? 'before' : 'after';
  if (value === 0) {
    return `${direction === 'before' ? 'Just before' : 'Right after'} ${anchorLabel}, `;
  }
  if (value === 1 && unit === 'days') {
    return `The day ${preposition} ${anchorLabel}, `;
  }
  return `${pluralizeUnit(value, unit)} ${preposition} ${anchorLabel}, `;
}

/** "Invoice is paid" becomes "an invoice is paid". */
function articleizeEventLabel(label: string): string {
  const match = label.match(/^(\w+)(.*)$/);
  if (!match) return label.toLowerCase();
  const noun = (match[1] ?? '').toLowerCase();
  const rest = (match[2] ?? '').toLowerCase();
  const article = /^[aeiou]/i.test(noun) ? 'an' : 'a';
  return `${article} ${noun}${rest}`;
}

function findAnchorLabel(
  catalog: WorkflowCatalog,
  subject: TriggerSelection['subject'],
  anchor: TriggerSelection['anchor'],
): string | undefined {
  if (!anchor) return undefined;
  return catalog.anchors[subject]?.find((option) => option.key === anchor)?.label;
}

export default function TriggerReadback({ selection, catalog }: TriggerReadbackProps) {
  let lead: string | null = null; // the highlighted lead-in clause, INCLUDING its trailing comma
  let emptyMessage = '';
  let showRuleOneNote = false;
  let noteAnchorLabel = '';

  if (selection.mode === 'event') {
    const def = selection.eventTrigger ? catalog.triggers[selection.eventTrigger] : undefined;
    if (!def) {
      emptyMessage = 'Pick the event that starts it.';
    } else {
      lead = `The moment ${articleizeEventLabel(def.label)}, `;
    }
  } else {
    const anchorLabel = findAnchorLabel(catalog, selection.subject, selection.anchor);
    if (anchorLabel === undefined || selection.direction === undefined || selection.offsetMinutes === undefined) {
      emptyMessage = 'Choose a timing to complete this.';
    } else {
      lead = dateLeadPhrase(selection.direction, selection.offsetMinutes, anchorLabel);
      if (selection.direction === 'before') {
        showRuleOneNote = true;
        noteAnchorLabel = anchorLabel;
      }
    }
  }

  return (
    <div className="border-border bg-muted rounded-lg border p-4">
      <div className="text-brand mb-1.5 flex items-center gap-1.5 text-[10.5px] font-extrabold uppercase tracking-wide">
        <Clock className="size-[13px]" aria-hidden />
        {`This automation will${ELLIPSIS}`}
      </div>

      <p role="status" className="text-[14.5px] font-semibold leading-snug">
        {lead === null ? (
          <span className="text-subtle-foreground">{emptyMessage}</span>
        ) : (
          <>
            <span className="text-brand font-extrabold">{lead}</span>
            {'send the customer an '}
            <span className="text-brand font-extrabold">email</span>
            {'.'}
          </>
        )}
      </p>

      {showRuleOneNote && (
        <div
          data-testid="trigger-readback-note"
          className="border-border text-muted-foreground mt-2.5 flex items-start gap-1.5 border-t border-dashed pt-2.5 text-xs"
        >
          <Info className="mt-0.5 size-[13px] shrink-0" aria-hidden />
          <span>
            {'If '}
            {noteAnchorLabel}
            {' is '}
            <span className="text-foreground font-bold">still coming up</span>
            {` but it${RSQUO}s too late for the full head start, we send right away. If `}
            {noteAnchorLabel}
            {' has '}
            <span className="text-foreground font-bold">already passed</span>
            {`, we skip it ${EM_DASH} no reminder for something that${RSQUO}s over.`}
          </span>
        </div>
      )}
    </div>
  );
}
