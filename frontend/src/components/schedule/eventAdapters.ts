import type { SchedulableEvent } from './scheduleModel';
import { DEFAULT_DURATION_MIN } from './scheduleModel';
import { crewPeopleOf, ownerOf } from './eventPeople';
import { toWallClock, addMsToWallClock, type WallClock } from '@/lib/schedule-tz';

type CustomerLike = { first_name?: string; last_name?: string; company_name?: string | null } | null | undefined;

// Board display policy: company name first (company-dominant for field crew clarity).
// This is intentionally different from src/lib/customer-name.ts customerDisplayName, which is
// person-first (used in office/sales views). Do not unify — the contexts differ.
export function customerName(c: CustomerLike): string {
  if (!c) return 'Customer';
  if (c.company_name?.trim()) return c.company_name.trim();
  const n = `${c.first_name ?? ''} ${c.last_name ?? ''}`.trim();
  return n || 'Customer';
}

const ids = (people: { id?: string }[]): string[] =>
  people.map((p) => p.id).filter((id): id is string => Boolean(id));

/**
 * job/lead API payload -> board event. This is the read boundary (schedule-tz.ts): every
 * timestamp the payload carries is an Instant, and everything downstream of this function
 * (RBC, grid layout math) needs a WallClock in the org's `tz` instead - see there for why.
 */
export function jobToEvent(job: Record<string, unknown>, tz: string): SchedulableEvent {
  // The parameter stays `Record<string, unknown>` - the shape `raw`, crewPeopleOf and
  // ownerOf all speak - and the fields this function actually reads are narrowed once
  // here rather than cast one by one at each use.
  const j = job as {
    id: string;
    job_number: string;
    scope_notes?: string | null;
    scheduled_start?: string | null;
    scheduled_end?: string | null;
    customer?: CustomerLike;
    tags?: SchedulableEvent['tags'];
  };
  const start: WallClock | null = j.scheduled_start ? toWallClock(new Date(j.scheduled_start), tz) : null;
  const end: WallClock | null = j.scheduled_end
    ? toWallClock(new Date(j.scheduled_end), tz)
    : start
      ? addMsToWallClock(start, DEFAULT_DURATION_MIN.job * 60_000)
      : null;
  return {
    id: j.id,
    type: 'job',
    number: j.job_number,
    title: j.scope_notes?.trim() || customerName(j.customer),
    customer: customerName(j.customer),
    crew: ids(crewPeopleOf('job', job)),
    ownerId: ownerOf('job', job)?.id ?? null,
    start,
    end,
    tags: j.tags ?? [],
    raw: job,
  };
}

export function walkthroughToEvent(lead: Record<string, unknown>, tz: string): SchedulableEvent {
  // Same narrowing as jobToEvent - see the note there.
  const l = lead as {
    id: string;
    lead_number: string;
    walkthrough_scheduled_at?: string | null;
    walkthrough_duration_minutes?: number | null;
    customer?: CustomerLike;
    tags?: SchedulableEvent['tags'];
  };
  const start: WallClock | null = l.walkthrough_scheduled_at
    ? toWallClock(new Date(l.walkthrough_scheduled_at), tz)
    : null;
  const durMin = l.walkthrough_duration_minutes ?? DEFAULT_DURATION_MIN.walkthrough;
  const end: WallClock | null = start ? addMsToWallClock(start, durMin * 60_000) : null;
  return {
    id: `wt-${l.id}`,
    type: 'walkthrough',
    number: l.lead_number,
    title: `Walkthrough · ${customerName(l.customer)}`,
    customer: customerName(l.customer),
    crew: ids(crewPeopleOf('walkthrough', lead)),
    ownerId: ownerOf('walkthrough', lead)?.id ?? null,
    start,
    end,
    tags: (lead.tags as SchedulableEvent['tags']) ?? [],
    raw: lead,
  };
}
