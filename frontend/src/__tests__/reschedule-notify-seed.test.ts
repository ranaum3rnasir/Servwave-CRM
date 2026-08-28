/**
 * seedNotify - the composer's prefilled message (SRVW-243).
 *
 * The seed is prose the admin edits, not a template they learn, so it has to
 * read correctly as-is. The first real send on prod arrived greeting the
 * customer twice: the HTML template opens with "Hi {customer}," and the seed
 * opened with it again. composeNotifyText now prepends the same greeting to the
 * text part too, so a greeting in the seed would double up in BOTH parts.
 *
 * These pin the seed's contract with the templates that wrap it.
 *
 * ─── WHERE THE SEED LIVES NOW ────────────────────────────────────────────────
 *
 * Multi-visit S7 lifted the composer's brain out of the unrouted `pages/SchedulePage.tsx` into
 * `lib/notifyCompose`, which the ROUTED v2 board and the v2 job page's visit dialog both use.
 * This file follows it there, so it now pins the seed the live surfaces actually render.
 *
 * The old header on this file claimed the v2 confirm dialog "still renders the amber panel"
 * reading "Notification emails will be sent to:". That was already false before S7 - the panel
 * had been removed - and the prose is not trustworthy as a description of v2 behaviour. What was
 * true, and what S7 fixed, is that the v2 board sent no notify key on any of its mutations.
 */

import { describe, it, expect } from 'vitest';
import { seedNotify } from '@/lib/notifyCompose';

const JOB = {
  id: 'job-1',
  type: 'job' as const,
  customer: 'John Doe',
  raw: { customer: { email: 'john@doe.com' } },
};

const WALKTHROUGH = { ...JOB, id: 'w-1', type: 'walkthrough' as const };

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const seed = (event: any, at: Date) => seedNotify(event, at as any);

describe('seedNotify', () => {
  const WHEN = new Date('2026-08-14T10:30:00');

  it('does not greet - the template and the text part both do that already', () => {
    const { message } = seed(JOB, WHEN);

    expect(message).not.toMatch(/^Hi\b/i);
    expect(message).not.toContain('John Doe');
  });

  it('states the new time in prose the admin can send unedited', () => {
    const { message } = seed(JOB, WHEN);

    expect(message).toContain('Friday, August 14');
    expect(message).toContain('10:30 AM');
    expect(message).toContain('appointment');
  });

  it('calls a walkthrough a site visit, not an appointment', () => {
    const { message } = seed(WALKTHROUGH, WHEN);

    expect(message).toContain('site visit');
    expect(message).not.toContain('appointment');
  });

  it('prefills the recipient from the customer record and starts open (D23: defaulted on)', () => {
    const result = seed(JOB, WHEN);

    expect(result.to).toBe('john@doe.com');
    expect(result.enabled).toBe(true);
    expect(result.cc).toEqual([]);
  });

  it('leaves the recipient empty when the customer has no address on file', () => {
    // Empty is legal - the server falls back to the address it holds. What must
    // not happen is inventing one.
    const result = seed({ ...JOB, raw: { customer: { email: null } } }, WHEN);

    expect(result.to).toBe('');
  });
});
