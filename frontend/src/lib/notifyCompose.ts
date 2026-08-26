/**
 * notifyCompose - the SRVW-243 compose state, in one place for every host that offers it.
 *
 * Lifted verbatim out of pages/SchedulePage.tsx (the unrouted v1 board), which was the only
 * place in the repo the composer's brain existed. Copying it into a second host instead of
 * lifting it is precisely #1551's failure mode: a fix shipped in one tree, silently reverted by
 * the copy in the other.
 *
 * THREE NOTIFY VOCABULARIES SURVIVE ON THE WIRE, so this module exposes ONE key bag under TWO
 * wrappers rather than one payload builder that quietly fits neither:
 *   - `notifyKeys`      -> FLAT top-level keys, for POST /api/jobs/:id/assign and
 *                          POST /api/leads/:id/walkthrough/schedule.
 *   - `notifyVisitBody` -> the NESTED `notify` object, for every visit route on both parents.
 * Posting flat keys at the nested schema is not an error the user ever sees: Zod strips unknown
 * keys, so the request 200s, the toast says it worked, and no email is sent.
 *
 * Q1 (RATIFIED, both halves shipped - the default is ON per D23/user story 42, and the decline is
 * expressible on the wire): `notifyKeysShown` / `notifyVisitBodyShown` exist so a host that
 * ACTUALLY SHOWED the composer can make an explicit decline reach the wire as
 * `notify_customer: false`, instead of the `{}` a genuinely silent caller sends. That distinction
 * is NOT made inside the plain `notifyKeys` / `notifyVisitBody` below - see their doc - it is a
 * call the HOST makes, because only the host knows whether this particular attempt actually
 * rendered a composer for the user to decide with.
 */
import { format } from 'date-fns';

/** The compose state, owned by whichever component hosts the dialog. */
export interface NotifyCompose {
  enabled: boolean;
  to: string;
  cc: string[];
  message: string;
}

/**
 * A closed composer. Also the reset value on every dialog close.
 *
 * `enabled: true` is the spec, not a preference: D23 says every scheduling dialog offers the
 * opt-out "defaulted on", and user story 42 says the box "defaults to sending". The blast radius
 * of this default is exactly the hosts that render a composer - every wire effect goes through
 * `notifyKeysShown`/`notifyVisitBodyShown`, which only a host with the composer on screen may
 * call, so no dialog-less path can send because of this value.
 */
export const EMPTY_NOTIFY: NotifyCompose = { enabled: true, to: '', cc: [], message: '' };

/** What a seeding caller has to know about the thing being moved. */
export interface NotifySeedSource {
  /** 'walkthrough' reads as "site visit" to the customer; anything else is an appointment. */
  type?: string | null;
  raw?: { customer?: { email?: string | null } | null } | null;
}

/**
 * The composer's seed for one specific move.
 *
 * "Prefill with the real values" rather than {{merge}} syntax: the admin sees a finished
 * sentence and edits prose, instead of learning a template language to send one email.
 *
 * Pure, and meant to be called at the site that OPENS the dialog rather than from an effect
 * watching it. Seeding in an effect meant a render with stale compose state before the seed
 * landed, and cost a cascading re-render on every open. Computing it with the move that caused
 * it also makes "re-seed on a new move, never clobber an in-progress edit" structural: there is
 * no later pass that could overwrite what was typed.
 *
 * `when` must already be a wall-clock Date in the ORG zone. Every caller converts through
 * lib/schedule-tz; formatting a raw instant here would render the browser's zone and tell the
 * customer an hour nobody in the org would recognise (#1551's second defect).
 */
export function seedNotify(event: NotifySeedSource, when: Date): NotifyCompose {
  const whenText = `${format(when, 'EEEE, MMMM d')} at ${format(when, 'h:mm a')}`;
  const what = event.type === 'walkthrough' ? 'site visit' : 'appointment';
  return {
    enabled: true,
    to: event.raw?.customer?.email ?? '',
    cc: [],
    // Deliberately no greeting. The HTML template opens with "Hi {customer}," and
    // composeNotifyText prepends the same line to the text part, so a greeting here reaches the
    // customer twice - it did, in the first real send on prod.
    message:
      `We've moved your ${what} to ${whenText}. ` +
      `Sorry for any inconvenience - please let us know if that time doesn't work for you.`,
  };
}

/**
 * The compose state as request keys. Returns {} when the user did not ask for a send, so every
 * OTHER caller of these mutations (drag-resize, crew swap, plan-visit drop - none of which show
 * a dialog) stays silent BY CONSTRUCTION rather than by remembering to pass a flag.
 *
 * Empty strings are dropped rather than sent: an untouched To means "use the customer's saved
 * address", and an empty message means "use the default wording" - both of which the server
 * already does. Sending '' would instead fail email validation, or blank the email body.
 */
export function notifyKeys(n?: NotifyCompose) {
  if (!n?.enabled) return {};
  const to = n.to.trim();
  const message = n.message.trim();
  return {
    notify_customer: true as const,
    ...(to ? { notify_recipient_email: to } : {}),
    ...(n.cc.length > 0 ? { notify_cc_emails: n.cc } : {}),
    ...(message ? { notify_message: message } : {}),
  };
}

/** The same key bag, nested, for the visit routes on both parents. */
export function notifyVisitBody(n?: NotifyCompose) {
  const keys = notifyKeys(n);
  return 'notify_customer' in keys ? { notify: keys } : {};
}

/**
 * `notifyKeys`, but for a host that ACTUALLY RENDERED the composer for this specific submission.
 *
 * Q1 (RATIFIED): through plain `notifyKeys` an untick is byte-identical on the wire to a dialog
 * that never opened - `{}` either way - and the backend reads an absent `notify` as "let the
 * automation handle it", which is how a box labelled "Notify the customer" used to email the
 * customer when it was left OFF. `n` is required (not optional) here on purpose: calling this at
 * all is the host asserting "a composer was on screen for this attempt", so there is no bare
 * `undefined` case to silently do the wrong thing with. A host with no dialog must keep calling
 * plain `notifyKeys` (or send no notify key at all) - never this.
 */
export function notifyKeysShown(n: NotifyCompose) {
  if (!n.enabled) return { notify_customer: false as const };
  return notifyKeys(n);
}

/** The nested-object twin of `notifyKeysShown`, for the visit routes. */
export function notifyVisitBodyShown(n: NotifyCompose) {
  const keys = notifyKeysShown(n);
  return 'notify_customer' in keys ? { notify: keys } : {};
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Should the host block its confirm button?
 *
 * A "To" that is present but malformed blocks the send. An EMPTY one does not: the server falls
 * back to the customer's saved address, and the field is only ever prefilled with that address
 * in the first place.
 */
export function notifyBlocked(notify: NotifyCompose): boolean {
  return notify.enabled && Boolean(notify.to.trim()) && !EMAIL_RE.test(notify.to.trim());
}
