/**
 * TriggerReadback — the live plain-English summary that sits directly below
 * the two-mode trigger builder (SubjectPicker → ModeFork → EventModePanel/
 * DateModePanel). Always mounted while the builder is open and re-rendering
 * on every pick, so the user sees exactly what they're building as a single
 * flowing sentence — plus, for a `before` date selection only, the "what
 * happens at the edges" rule-1 note.
 *
 * Mirrors md_files/specs/automations/2026-07-17-timing-builder/index.html's
 * `renderReadback()` / `timingPhrase()` / `offsetChip()` / `articleize()` /
 * `plural()` functions (lines ~470-546) — the sentence templates, the 0/1-day
 * special cases, and the rule-1 note copy are sourced verbatim from there
 * (cross-checked against the task brief, which matches it):
 *   - n===0            → "Just before {anchor}, " / "Right after {anchor}, "
 *   - n===1 && days     → "The day before {anchor}, " / "The day after {anchor}, "
 *   - everything else   → "{N} {unit} before/after {anchor}, " — the unit is
 *                         only singularized when N===1 (e.g. "1 hour before
 *                         …", never "1 hours"; a non-day unit never gets the
 *                         "The day …" treatment even at N===1).
 *   - event mode        → "The moment {article}{label lowercased}, " where
 *                         the article ("a"/"an") is chosen from the label's
 *                         first word, exactly like the mockup's `articleize()`
 *                         ("Invoice is paid" → "an invoice is paid").
 *
 * Deliberate correction to the task brief's Step 1 illustration, confirmed by
 * reading triggerModel.ts (Task B1) directly: that illustration shows an
 * event sentence with an optional "wait N, then " clause spliced in between
 * the lead-in and "send the customer an email." `TriggerSelection` has no
 * field anywhere for an event-mode wait duration — its only event-mode field
 * is `eventTrigger`. The multi-step engine already models "wait after the
 * trigger fires" as a separate WAIT step later in the workflow (a
 * pre-existing, pre-Part-A concept — see WaitForm.tsx's own anchored-wait
 * readback line, reused as this component's chrome precedent below), not as
 * trigger-level config, so there is nothing here to render a wait clause
 * from. This component therefore always renders the mockup's `wait:'now'`
 * branch (`map.now === ''`) for event mode — i.e. no wait clause, ever.
 *
 * Two further deliberate deviations, flagged here rather than silently
 * guessed:
 * 1. Empty/incomplete-selection copy. `TriggerSelection.subject`/`.mode` are
 *    non-optional, so the mockup's "Pick a subject…" / "Choose how it should
 *    start…" placeholders can never occur through this component's actual
 *    prop contract (a `TriggerSelection` value literally cannot exist without
 *    both) — they're dropped. The mockup's event-mode "Pick the event that
 *    starts it." placeholder IS reachable here (`mode==='event'` with
 *    `eventTrigger` still undefined) and is reused verbatim. Date mode has no
 *    mockup equivalent for "mode chosen, timing not yet" (the mockup's local
 *    state always seeds a default timing the instant it enters date mode);
 *    reachable here because `anchor`/`direction`/`offsetMinutes` are
 *    independently-optional on `TriggerSelection`, so a small original
 *    placeholder in the same terse style ("Choose a timing to complete
 *    this.") is used instead of leaving the strip blank or fabricating a
 *    timing that was never chosen.
 * 2. Visual chrome. The mockup's `.readback` box is a two-stop CSS gradient
 *    (raw hex) with a raw-hex border — disallowed by the "never write a raw
 *    hex" design-system rule, and no gradient-from-tokens recipe exists
 *    anywhere in this component family to reach for instead. This uses a
 *    flat `bg-background-light` (canvas token) card, the same kind of
 *    simplification DateModePanel's own docblock already made for the
 *    mockup's pill-shaped segmented control. The sentence/emphasis styling
 *    otherwise mirrors WaitForm.tsx's pre-existing "Wait **X** before the
 *    next step." readback line (`rounded bg-background-light px-3 py-2
 *    text-sm font-medium text-text-primary` + a bold inline span) — the
 *    closest existing precedent in this codebase for "a computed
 *    plain-English timing summary" — rather than inventing new chrome.
 *
 * `role="status"` on the sentence paragraph (not present in the mockup) is
 * added because this strip is a live region by definition — its whole job is
 * to reflect every pick the user makes — so assistive tech gets the same
 * "here's what you just built" feedback sighted users get from watching the
 * text change. It also gives a single stable node to read `.textContent`
 * from in tests, despite the sentence being built from several inline spans
 * (so the highlighted lead-in/"email" can be styled like the mockup's `.hl`
 * without fragmenting the byte-for-byte text assertions across nodes).
 */

import { Clock, Info } from 'lucide-react';
import type { TriggerSelection } from '@/lib/workflows/triggerModel';
import type { WorkflowCatalog } from '@/lib/api/workflows';
import { splitOffset, type OffsetUnit } from '@/lib/workflows/timing';

export interface TriggerReadbackProps {
  selection: TriggerSelection;
  catalog: WorkflowCatalog;
}

/** Mirrors the mockup's `plural(n,u)` — singularizes the unit word only when n===1. */
function pluralizeUnit(n: number, unit: OffsetUnit): string {
  if (n === 1) return `1 ${unit.replace(/s$/, '')}`;
  return `${n} ${unit}`;
}

/**
 * Mirrors the mockup's `timingPhrase()` date branch. Every return value here
 * already starts with an uppercase letter or a digit, so — unlike the
 * mockup, which applies a separate `cap()` pass — no capitalization step is
 * needed on top.
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

/**
 * Mirrors the mockup's `articleize()` — "Invoice is paid" -> "an invoice is paid".
 * The `?? ''` fallbacks are for `noUncheckedIndexedAccess` only (TS can't see that
 * `(\w+)` and `(.*)` always capture something once `match` itself is truthy).
 */
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
  let lead: string | null = null; // the highlighted lead-in clause, INCLUDING its trailing ", "
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
    <div className="rounded-card border border-border bg-background-light p-4">
      <div className="mb-1.5 flex items-center gap-1.5 text-[10.5px] font-extrabold uppercase tracking-wide text-primary-light">
        <Clock className="h-[13px] w-[13px]" aria-hidden />
        This automation will…
      </div>

      <p role="status" className="text-[14.5px] font-semibold leading-snug text-text-primary">
        {lead === null ? (
          <span className="text-text-soft">{emptyMessage}</span>
        ) : (
          <>
            <span className="font-extrabold text-primary">{lead}</span>
            {'send the customer an '}
            <span className="font-extrabold text-primary">email</span>
            {'.'}
          </>
        )}
      </p>

      {showRuleOneNote && (
        <div
          data-testid="trigger-readback-note"
          className="mt-2.5 flex items-start gap-1.5 border-t border-dashed border-border pt-2.5 text-xs text-text-secondary"
        >
          <Info className="mt-0.5 h-[13px] w-[13px] shrink-0" aria-hidden />
          <span>
            {'If '}
            {noteAnchorLabel}
            {' is '}
            <span className="font-bold text-text-primary">still coming up</span>
            {' but it’s too late for the full head start, we send right away. If '}
            {noteAnchorLabel}
            {' has '}
            <span className="font-bold text-text-primary">already passed</span>
            {', we skip it — no reminder for something that’s over.'}
          </span>
        </div>
      )}
    </div>
  );
}
