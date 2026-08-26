// Resolve the people shown on a schedule event from PR A's M2M payloads.
//   job         → assignees[].user                 (crew)
//   walkthrough → lead.walkthrough_performers[].user (crew)
//   owner       → lead.commission_owner (off-board); jobs reach it via estimate.lead.
// Replaces the pre-PR-A single-FK readers (assigned_user / walkthrough_performer), which the
// assignment redesign deleted.

export interface PersonRef { id?: string; first_name?: string; last_name?: string }
// Mirrors scheduleModel's EventType. Service-plan visits are Jobs under the hood, so they
// resolve people through the job branch (assignees / estimate.lead.commission_owner).
// 'calendar-entry' (slice 03, ADR 0002) resolves to no crew and no owner - a calendar entry's
// participants are not crew and are not read here at all; folding them in is a LATER slice's
// decision (§3: "participants are added as a separate field, never folded into crew").
export type ScheduleEventType = 'job' | 'walkthrough' | 'service-plan' | 'calendar-entry';

type UserWrap = { user?: PersonRef | null };

/** Display name for a person, or null when absent / unnamed. */
export function fullName(p: PersonRef | null | undefined): string | null {
  if (!p) return null;
  const name = `${p.first_name ?? ''} ${p.last_name ?? ''}`.trim();
  return name || null;
}

/** The crew (performers) on an event, as display people, in payload order. */
export function crewPeopleOf(type: ScheduleEventType, raw: Record<string, unknown>): PersonRef[] {
  if (type === 'calendar-entry') return [];
  const key = type === 'walkthrough' ? 'walkthrough_performers' : 'assignees';
  const rows = (raw[key] as UserWrap[] | undefined) ?? [];
  return rows.map((r) => r.user).filter((u): u is PersonRef => Boolean(u));
}

/** The commission owner (off-board). Walkthroughs read lead.commission_owner; jobs reach it via estimate.lead. */
export function ownerOf(type: ScheduleEventType, raw: Record<string, unknown>): PersonRef | null {
  if (type === 'calendar-entry') return null;
  if (type === 'walkthrough') return (raw.commission_owner as PersonRef | null) ?? null;
  const estimate = raw.estimate as { lead?: { commission_owner?: PersonRef | null } } | undefined;
  return estimate?.lead?.commission_owner ?? null;
}
