/**
 * Walkthrough-as-entity redesign (spec md_files/specs/leads/2026-07-28-walkthrough-as-entity.md,
 * plan md_files/plans/leads/2026-07-28-walkthrough-as-entity-phase-2.md).
 *
 * Owns the visit lifecycle that used to live inline in lead.controller.ts: performer replace/
 * validate/conflict-detect (moved here verbatim, now keyed by walkthrough_id instead of lead_id),
 * plus the create-or-update/complete/cancel/unschedule transitions on the Walkthrough row itself,
 * plus D15's "current visit" resolution (reused by updateWalkthrough's write target, the four
 * legacy-shaped SELECT/serialize sites, and the automation merge fields). PR-D2 dropped the 9
 * legacy Lead.walkthrough_* columns and deleted the dual-write helper
 * (`stampLegacyWalkthroughColumns`) that used to mirror every lifecycle write onto them - the
 * Walkthrough table is now the sole source of truth, no bridge left to maintain.
 *
 * D2/D5: the lead's OWN status is never gated on visit state and visit events never pull it
 * backward - that policy lives in the controller (it needs the lead's current status, which this
 * module does not load), not here.
 */
import type { Request } from 'express';
import { Prisma, VisitStatus, JobStatus } from '@prisma/client';
import { prisma } from '../lib/prisma';
import { tenantWhere } from '../lib/tenant';
import { isAssignable } from '../lib/permissions/assignableRoles';
import { deriveJobStatus } from '../lib/job-status';

// Matches every other lib/service in this codebase (tenantWhere, scopeWhereForReq, etc.) - the
// real Express Request, not a hand-rolled structural stand-in.
type Req = Request;

// ─── D15: "current visit" resolution ───────────────────────────────────────
//
// "Current visit" = the next upcoming live visit; if none upcoming, the most recent visit that
// happened (completed or cancelled). One rule, used by updateWalkthrough's write target, the four
// legacy-shaped SELECT/serialize sites (so their JSON responses keep the OLD flat field names
// while sourcing from the relation), and the automation merge fields/staleness guard/date-anchor.
//
// Multi-visit S1 makes this rule load-bearing for the first time. It used to collapse to "the
// lead's one SCHEDULED row", because at most one non-terminal row could exist per lead by
// construction. That invariant is now LIFTED - a lead can hold several live visits at once - so
// "next upcoming" has to actually order by time rather than pick the only candidate.
//
// Note this resolves ONE visit for the legacy flat response shape. It is a compatibility shim,
// not the multi-visit interface: callers that want every visit read the `visits` relation (or
// GET /api/leads/:id/visits) instead.

export type WalkthroughSnapshotRow = {
  id: string;
  /**
   * D13 - creation-order number, the one the customer's email names. Never renumbered.
   *
   * Optional on the TYPE, always present in `walkthroughSnapshotSelect`: a few narrower
   * selects (the automation context's, and older fixtures) build this shape by hand and do
   * not need the number, and making it required there would be churn for no behaviour.
   */
  visit_seq?: number | null;
  status: VisitStatus;
  scheduled_at: Date | null;
  duration_minutes: number | null;
  completed_at: Date | null;
  notes: string | null;
  cancelled_at: Date | null;
  cancelled_reason: string | null;
  cancelled_by: string | null;
  customer_email_sent_at: Date | null;
  created_at: Date;
  canceller?: { id: string; first_name: string; last_name: string } | null;
};

/**
 * The Prisma `select` shape for a lead's `walkthroughs` relation wherever a controller needs
 * D15's "current visit" resolution to source a legacy-shaped JSON response (lead.controller.ts's
 * leadListSelect/leadDetailSelect, estimate/job's lead-nested selects, search's LEAD_SELECT).
 * ONE shared shape so every one of those SELECT sites stays in sync with
 * `WalkthroughSnapshotRow`/`resolveCurrentWalkthrough`.
 */
export const walkthroughSnapshotSelect = {
  id: true,
  // D13 - the customer-facing number. It rides in their email subject, so the lead's own
  // history has to be able to name the same trip the customer was told about (MV-LEAD-13).
  visit_seq: true,
  status: true,
  scheduled_at: true,
  duration_minutes: true,
  completed_at: true,
  notes: true,
  cancelled_at: true,
  cancelled_reason: true,
  cancelled_by: true,
  customer_email_sent_at: true,
  created_at: true,
  canceller: { select: { id: true, first_name: true, last_name: true } },
} as const;

/**
 * Repoints a lead (or lead-nested) object's legacy walkthrough_* fields onto its `walkthroughs`
 * relation (selected via `walkthroughSnapshotSelect`), in place of the raw legacy columns -
 * SOURCED from the relation while KEEPING the response field NAMES exactly as they are today,
 * so the frontend needs zero changes. A no-op when `walkthroughs` was not part of the select at
 * all (the `in` check, not a falsy check, so an empty array still projects to "no current
 * visit" rather than being skipped) - callers whose select genuinely never touched the relation
 * are left alone rather than having null keys forced onto them.
 *
 * The performer set is renamed on the same principle. A Prisma relation name IS the JSON key, so
 * S1 renaming `Lead.walkthrough_performers` to `visit_assignees` silently changed the API's
 * public shape and every frontend reader - lead hero, walkthrough tab, the board's crew, the
 * copilot handler - started getting `undefined` (#1637). The model keeps the new name; the
 * response keeps the old one, which is the whole point of this projection.
 */
export function projectLeadWalkthroughFields<
  T extends { visits?: WalkthroughSnapshotRow[]; visit_assignees?: unknown },
>(
  lead: T,
  opts: { full: boolean },
): Omit<T, 'visits' | 'visit_assignees'> {
  // Independent of the `visits` rename below: a select may carry one relation and not the other,
  // and the early return for untouched callers must not swallow the performers.
  const withPerformers = ((): T => {
    if (!('visit_assignees' in (lead as object))) return lead;
    const { visit_assignees, ...rest } = lead;
    return { ...rest, walkthrough_performers: visit_assignees } as unknown as T;
  })();

  type Out = Omit<T, 'visits' | 'visit_assignees'>;
  if (!('visits' in (withPerformers as object))) return withPerformers as unknown as Out;
  const { visits, ...rest } = withPerformers;
  return { ...rest, ...projectLegacyWalkthroughFields(visits, opts) } as unknown as Out;
}

// The live-visit rule moved to lib/visit-status.ts in S4 so lib/job-status.ts can read it without
// the service and the D12 derivation importing each other. Re-exported here unchanged: every
// existing importer still reads it off this module, and there is still exactly one list.
export { LIVE_VISIT_STATUSES, isLiveVisit } from '../lib/visit-status';
import { LIVE_VISIT_STATUSES, isLiveVisit } from '../lib/visit-status';

/**
 * D15's rule, applied to an already-fetched list of a parent's visits (any order).
 *
 * Ordering by scheduled_at is what changed in S1: with several live visits the first match in
 * array order is an arbitrary one, so this picks the EARLIEST upcoming trip - the one the hero
 * and the legacy flat fields should describe. A live visit with no time yet sorts last among
 * live ones rather than winning by accident.
 */
export function resolveCurrentWalkthrough<T extends WalkthroughSnapshotRow>(visits: T[]): T | null {
  const live = visits.filter(isLiveVisit);
  if (live.length > 0) {
    return live.reduce((earliest, v) => {
      if (v.scheduled_at === null) return earliest;
      if (earliest.scheduled_at === null) return v;
      return v.scheduled_at.getTime() < earliest.scheduled_at.getTime() ? v : earliest;
    });
  }

  const happened = visits.filter((w) => w.status === 'COMPLETED' || w.status === 'CANCELLED');
  if (happened.length === 0) return null;

  return happened.reduce((latest, w) => {
    const wTime = (w.completed_at ?? w.cancelled_at ?? w.created_at).getTime();
    const latestTime = (latest.completed_at ?? latest.cancelled_at ?? latest.created_at).getTime();
    return wTime > latestTime ? w : latest;
  });
}

/**
 * Projects the resolved current visit onto the legacy FLAT field NAMES (walkthrough_scheduled_at,
 * etc.) for JSON-response byte-compatibility while the frontend still reads the old Lead-column
 * shape (PR-C2/PR-D2 cut it over). `full: false` (list responses) omits the detail-only keys
 * (notes, cancellation detail, customer-email flag) that list selects never carried either.
 *
 * Deliberately does NOT just echo the raw column values dual-write already stamped on Lead -
 * dual-write intentionally preserves the OLD incoherence bug byte-for-byte (rescheduling never
 * cleared walkthrough_completed_at), and multiple visits make the raw columns mix data across
 * visits. Sourcing from the resolved CURRENT visit here is what actually fixes both.
 */
/**
 * Multi-visit S8 (D6): the lead's walkthrough crew, flattened back onto the `visit_assignees`
 * key that the lead selects have always carried.
 *
 * That key is INTERNAL, not the wire key. projectLeadWalkthroughFields renames it to
 * `walkthrough_performers` immediately after this runs (#1637/#1642), which is what every
 * frontend reader consumes. Calling it a wire key here would be the same stale-comment trap S6
 * hit, so it is named for what it is: the intermediate this function produces.
 *
 * `visit_assignees.lead_id` is dropped, so the crew is reached one array level deeper, through
 * `lead.visits[].assignees`. The projected shape and user set are unchanged - INCLUDING the
 * absence of dedupe: a person on two of the lead's visits appears twice today and still does,
 * because that is what every reader of this key was written against.
 *
 * A no-op when `visits` was not part of the select (the `in` check, matching
 * projectLegacyWalkthroughFields' own guard, so "selected but empty" still projects []).
 */
export function projectLeadVisitCrew<T extends Record<string, unknown>>(lead: T): T {
  if (!('visits' in lead)) return lead;
  const visits = lead.visits as Array<{ assignees?: unknown[] | null }> | null | undefined;
  return { ...lead, visit_assignees: (visits ?? []).flatMap((v) => v.assignees ?? []) };
}

export function projectLegacyWalkthroughFields(
  visits: WalkthroughSnapshotRow[] | undefined,
  opts: { full: boolean },
): Record<string, unknown> {
  const list = visits ?? [];
  const current = resolveCurrentWalkthrough(list);
  const base = {
    walkthrough_scheduled_at: current?.scheduled_at ?? null,
    walkthrough_completed_at: current?.status === 'COMPLETED' ? current.completed_at : null,
    walkthrough_duration_minutes: current?.duration_minutes ?? null,
  };
  if (!opts.full) return base;
  return {
    ...base,
    walkthrough_notes: current?.notes ?? null,
    walkthrough_cancelled_at: current?.status === 'CANCELLED' ? current.cancelled_at : null,
    walkthrough_cancelled_reason: current?.status === 'CANCELLED' ? current.cancelled_reason : null,
    walkthrough_cancelled_by: current?.cancelled_by ?? null,
    walkthrough_canceller: current?.canceller ?? null,
    walkthrough_customer_email_sent_at: current?.customer_email_sent_at ?? null,
    // PR-C2: WALKTHROUGH_SCHEDULED/WALKTHROUGH_COMPLETED left LeadStatus, so the lead detail
    // page can no longer infer "how many visits, and what happened on the earlier ones" from
    // lead.status. Full mode only (list selects have never carried per-visit detail, same
    // reasoning as walkthrough_notes above) - newest-first so callers can render it directly.
    walkthrough_count: list.length,
    walkthrough_history: [...list]
      .sort((a, b) => b.created_at.getTime() - a.created_at.getTime())
      .map((w) => ({
        id: w.id,
        // Without this the lead surface had no number to render at all, and the only
        // endpoint that returns one - GET /api/leads/:id/visits - has no frontend caller.
        // The job surface honours D13/D19 here; the lead surface silently did not.
        visit_seq: w.visit_seq ?? null,
        status: w.status,
        scheduled_at: w.scheduled_at,
        duration_minutes: w.duration_minutes,
        completed_at: w.completed_at,
        cancelled_at: w.cancelled_at,
        cancelled_reason: w.cancelled_reason,
        created_at: w.created_at,
      })),
  };
}

// ─── Query where-clause helper ─────────────────────────────────────────────

/**
 * Merges `patch` into `where.visits`'s existing `some` clause instead of assigning a fresh
 * one. `where.visits` may already carry a row-scope condition (a TECHNICIAN's
 * OWN_WALKTHROUGH read grant - see defaultGrants.ts) that a plain overwrite would silently
 * CLOBBER (RBAC bypass) - merging is also the semantically correct read ("my own walkthrough
 * that ALSO matches this filter", not two independent `some` checks). Shared by
 * lead.controller.ts's buildLeadListWhere (walkthrough_after/before) and lead.filters.ts's
 * walkthrough_status facet - both need this identical guard.
 */
export function mergeWalkthroughsSome(
  where: Record<string, unknown>,
  patch: Record<string, unknown>,
): { some: Record<string, unknown> } {
  const existingSome = (where.visits as { some?: Record<string, unknown> } | undefined)?.some;
  return { some: { ...(existingSome ?? {}), ...patch } };
}

// ─── D8/D9: send-time instrumentation ──────────────────────────────────────

/**
 * Whether the lead has ever had a COMPLETED visit - silent instrumentation recorded on an
 * estimate's SENT timeline event (see estimate.controller.ts's send()/markSent()), replacing the
 * removed require_walkthrough_before_send enforcement gate. Not a gate itself: `null` (a
 * lead-less, customer-anchored estimate) is trivially false - there is no lead to have visited.
 */
export async function hasCompletedWalkthrough(leadId: string | null): Promise<boolean> {
  if (!leadId) return false;
  return (await prisma.visit.count({ where: { lead_id: leadId, status: 'COMPLETED' } })) > 0;
}

// ─── Performer helpers (moved from lead.controller.ts, now keyed by walkthrough_id) ──
//
// Mirror the job-crew side (replaceJobCrew / validateCrew / detectCrewConflicts).
// Walkthrough performers are MULTI with REPLACE semantics; lead owner is SINGLE.

export type PerformerMember = { id: string; email: string | null; first_name: string; last_name: string };

/**
 * REPLACE semantics: the array IS the new performer set for THIS visit. Diffs against the
 * visit's current performers inside the transaction and applies the delta. Writes visit_id
 * (load-bearing). S8 dropped `visit_assignees.lead_id`: the dual-write existed only so the
 * `Lead.visit_assignees` back-relation could be read directly, and all seven of those readers now
 * traverse `lead.visits[].assignees` instead.
 * Returns {added, removed} (user-id arrays) for diff-emails.
 *
 * Multi-visit S3 (D3, D6): `leadId` widens to `string | null` because the JOB side reuses this
 * exact writer rather than forking a twin - the diff/REPLACE semantics and the not-tenant-filtered
 * invariant below must not be able to drift between the two parents. A job-parented visit has no
 * lead, so it passes null and the key is OMITTED from the written row rather than written as an
 * explicit null: stamping a lead_id onto a job-parented visit would typecheck, pass every mocked
 * test, and fail only against a real Postgres - the same trap createJobVisit's docstring names for
 * `visits_exactly_one_parent`.
 *
 * NOTE (unchanged invariant from the pre-redesign code): findMany/deleteMany here are NOT
 * tenant-filtered - safe only because every caller has already tenant-checked the lead/job/visit
 * before reaching this function.
 */
export async function replaceWalkthroughPerformers(
  tx: Prisma.TransactionClient,
  walkthroughId: string,
  leadId: string | null,
  orgId: string,
  userIds: string[],
): Promise<{ added: string[]; removed: string[] }> {
  const current = await tx.visitAssignee.findMany({ where: { visit_id: walkthroughId }, select: { user_id: true } });
  const currentIds = new Set(current.map((c) => c.user_id));
  const next = new Set(userIds);
  const added = [...next].filter((id) => !currentIds.has(id));
  const removed = [...currentIds].filter((id) => !next.has(id));
  if (removed.length) await tx.visitAssignee.deleteMany({ where: { visit_id: walkthroughId, user_id: { in: removed } } });
  if (added.length) {
    await tx.visitAssignee.createMany({
      data: added.map((user_id) => ({
        visit_id: walkthroughId,
        user_id,
        organization_id: orgId,
      })),
    });
  }
  return { added, removed };
}

/**
 * Per-member eligibility: every performer id must resolve to an ACTIVE in-org user whose
 * role `isAssignable`. Returns the resolved performers on success, or a {status, error}.
 */
export async function validatePerformers(
  req: Req,
  performerIds: string[],
): Promise<{ ok: true; users: PerformerMember[] } | { ok: false; status: number; error: string }> {
  const users: PerformerMember[] = [];
  for (const userId of performerIds) {
    const u = await prisma.user.findUnique({
      where: { id: userId, ...tenantWhere(req) },
      select: { id: true, role: true, is_active: true, email: true, first_name: true, last_name: true },
    });
    if (!u) return { ok: false, status: 400, error: 'Performer not found or inactive' };
    if (!u.is_active) return { ok: false, status: 400, error: 'Performer not found or inactive' };
    if (!isAssignable(u.role)) return { ok: false, status: 400, error: 'This user is not eligible to perform walkthroughs' };
    users.push({ id: u.id, email: u.email, first_name: u.first_name, last_name: u.last_name });
  }
  return { ok: true, users };
}

export type WalkthroughConflict =
  | { type: 'job'; id: string; number: string; start: Date | null; end: Date | null }
  | { type: 'walkthrough'; id: string; number: string; start: Date | null; end: Date };

/**
 * Per-member conflict detection. For each candidate performer, finds overlapping
 * SCHEDULED/IN_PROGRESS jobs (crew M2M) and other SCHEDULED walkthroughs (performer M2M, any
 * lead) in the same window. Returns conflicts in the EXACT 409 entry shape used by the job side
 * (type/id/number/start/end) - kept byte-stable for the FE retry path. `id`/`number` on a
 * walkthrough conflict are the LEAD's (not the Walkthrough row's) - that is what the FE retry
 * path and the /leads/{id} link expect.
 */
export async function detectPerformerConflicts(
  req: Req,
  opts: { leadId: string; userIds: string[]; schedStart: Date; schedEnd: Date },
): Promise<WalkthroughConflict[]> {
  if (opts.userIds.length === 0) return [];
  const { schedStart, schedEnd } = opts;
  const tw = tenantWhere(req);

  // Repointed off the Job.scheduled_start/scheduled_end MIRROR onto the job's own VISITS relation
  // - the identical repoint job.controller.ts's detectCrewConflicts got in multi-visit S6 (D14):
  // the mirror only ever holds the job's NEXT upcoming visit, so a clash against a job's SECOND or
  // THIRD visit - at a window the mirror does not hold - went unwarned when the conflict was
  // checked from the LEAD side (booking a walkthrough against a technician already busy on that
  // later trip). The crew predicate and the window predicate stay two SEPARATE `visits: { some }`
  // clauses under AND, same reason as the job-side twin: merging them into one `some` would ask
  // "is there a trip that BOTH overlaps AND carries this person", which stops warning about a
  // person on the job's OTHER trip - the deliberate over-warn Q7 ratified on the job side.
  const jobVisitOverlap = {
    status: { not: 'CANCELLED' as const },
    scheduled_at: { lt: schedEnd },
    scheduled_end: { gt: schedStart },
  };

  const [jobConflicts, walkthroughConflicts] = await Promise.all([
    prisma.job.findMany({
      where: {
        ...tw,
        // S8 (D6): crew lives on the trips, so the conflict predicate traverses them.
        AND: [{ visits: { some: { assignees: { some: { user_id: { in: opts.userIds } } } } } }],
        // Spec B1 (Task 5): mirrors job.controller.ts's detectCrewConflicts identical fix --
        // a technician physically on site still occupies the slot. Kept byte-identical to that
        // twin through S4's enum narrowing: widening one without the other reintroduces exactly
        // the drift these two comments exist to stop.
        status: { in: ['SCHEDULED', 'IN_PROGRESS'] },
        visits: { some: jobVisitOverlap },
      },
      // The SAME predicate on the nested read, so each overlapping trip maps to exactly one
      // conflict entry - a job whose other trips sit elsewhere contributes only the clashing one.
      select: {
        id: true,
        job_number: true,
        visits: { where: jobVisitOverlap, select: { id: true, scheduled_at: true, scheduled_end: true } },
      },
    }),
    prisma.visit.findMany({
      where: {
        ...tw,
        // Multi-visit S3: `lead_id: { not: null }` is the guard, and `NOT: { lead_id }` is the
        // exclusion of THIS lead's own visits. They used to be one predicate, `{ not: opts.leadId }`,
        // which does not do the first job: Prisma keeps NULL rows in a `not` on a nullable column,
        // so once S3 gave job visits crew a job-parented row (D5: no lead) matched `assignees.some`
        // and reached the lead dereference below. Splitting them says what is meant without
        // depending on the reader knowing that NULL semantics, and matches the guard the job-side
        // twin and dashboard.controller.ts carry. The two detectors were written as twins and must
        // stay twins.
        lead_id: { not: null },
        NOT: { lead_id: opts.leadId },
        assignees: { some: { user_id: { in: opts.userIds } } },
        status: 'SCHEDULED',
        scheduled_at: { not: null },
      },
      select: { id: true, scheduled_at: true, duration_minutes: true, lead: { select: { id: true, lead_number: true } } },
    }),
  ]);

  // The `wt.lead` narrowing is real rather than a `!` assertion: the `lead_id: { not: null }`
  // predicate above is what guarantees a lead, so dropping that predicate must break the TYPECHECK
  // instead of throwing at runtime on whichever org double-books first.
  const wtConflicts = walkthroughConflicts.filter(
    (wt): wt is typeof wt & { scheduled_at: Date; lead: { id: string; lead_number: string } } => {
      if (!wt.scheduled_at || !wt.lead) return false;
      const wtStart = new Date(wt.scheduled_at);
      const wtEnd = new Date(wtStart.getTime() + (wt.duration_minutes || 60) * 60_000);
      return wtStart < schedEnd && wtEnd > schedStart;
    },
  );

  return [
    // The entry keeps the JOB's id/number and the VISIT's own times - one entry per overlapping
    // trip, so a job whose other trips sit elsewhere contributes only the clashing one. Byte-stable
    // shape: WalkthroughConflict is unchanged, only WHICH window feeds it changed.
    ...jobConflicts.flatMap((j) =>
      j.visits.map((v) => ({ type: 'job' as const, id: j.id, number: j.job_number, start: v.scheduled_at, end: v.scheduled_end as Date })),
    ),
    ...wtConflicts.map((w) => ({
      type: 'walkthrough' as const, id: w.lead.id, number: w.lead.lead_number,
      start: w.scheduled_at,
      end: new Date(new Date(w.scheduled_at).getTime() + (w.duration_minutes || 60) * 60_000),
    })),
  ];
}

// ─── Visit lifecycle ──────────────────────────────────────────────────────

/**
 * Every visit on a lead, newest-scheduled last. The multi-visit read: callers that need the whole
 * set (the lead page, the visits collection endpoint, the seq allocator) use this rather than
 * resolving down to one row.
 */
export async function listLeadVisits(req: Req, leadId: string) {
  return prisma.visit.findMany({
    where: { ...tenantWhere(req), lead_id: leadId },
    include: { assignees: { select: { user_id: true } } },
    orderBy: [{ scheduled_at: 'asc' }, { created_at: 'asc' }],
  });
}

/**
 * D13: the next per-parent visit number.
 *
 * Taken from MAX(visit_seq), not from a row count: a number that has been in a customer's inbox
 * must never be handed to a different trip, and a count would reuse one as soon as a row was
 * removed. Cancelled visits therefore still consume their number.
 *
 * An aggregate rather than "load every visit and reduce" so booking a visit does not read the
 * whole history to learn one integer.
 *
 * TAKES THE TRANSACTION CLIENT, exactly as nextVisitSeqForJob does, and the symmetry is
 * load-bearing rather than tidiness. This previously read the module-level `prisma` from inside
 * the caller's `$transaction` callback. Under DB_TENANT_GUARD=on that global is the tenant-guard
 * Proxy, and each of its model ops opens a transaction of its own - so the aggregate asked the
 * pool for a SECOND connection while the outer interactive transaction still held the first. A
 * roomy pool hides it; the deployed staging service does not, and every lead-walkthrough booking
 * returned 500 with Prisma P2024 after the pool timeout. Reading through `tx` needs no second
 * connection, and as a side effect the MAX now happens INSIDE the transaction, closing the race
 * the job twin's docstring predicted.
 */
export async function nextVisitSeqForLead(
  tx: Prisma.TransactionClient,
  orgId: string,
  leadId: string,
): Promise<number> {
  const agg = await tx.visit.aggregate({
    where: { organization_id: orgId, lead_id: leadId },
    _max: { visit_seq: true },
  });
  return (agg._max.visit_seq ?? 0) + 1;
}

/**
 * The visit the legacy single-visit endpoints act on: the EARLIEST still-coming trip.
 *
 * Was "the ONE non-terminal row" - the invariant S1 lifts. It stays a findFirst rather than
 * taking the head of a list so it does not share a query surface with detectPerformerConflicts'
 * unrelated cross-lead findMany; ordering, not uniqueness, is what picks the row now.
 */
export async function findActiveWalkthrough(req: Req, leadId: string) {
  return prisma.visit.findFirst({
    where: {
      ...tenantWhere(req),
      lead_id: leadId,
      status: { in: [...LIVE_VISIT_STATUSES] },
    },
    include: { assignees: { select: { user_id: true } } },
    orderBy: [{ scheduled_at: 'asc' }, { created_at: 'asc' }],
  });
}

/** Back-compat alias - complete/cancel act on the same earliest live visit. */
export async function findScheduledWalkthrough(req: Req, leadId: string) {
  return findActiveWalkthrough(req, leadId);
}

/**
 * Whether the lead has any still-coming visit. D22a: this is what replaces the retired REQUESTED
 * bucket - "needs scheduling" is the ABSENCE of a live visit, not the presence of a placeholder
 * row. Expressed as a Prisma `where` fragment so the three read sites can compose it.
 */
export const NO_LIVE_VISIT_WHERE = {
  visits: { none: { status: { in: [...LIVE_VISIT_STATUSES] } } },
};

/**
 * D15's current-visit resolution, fetched fresh for a single lead - used by updateWalkthrough
 * (the notes/duration-only save endpoint) to find the row it should actually write to.
 */
export async function findCurrentWalkthroughForLead(req: Req, leadId: string) {
  const visits = await prisma.visit.findMany({
    where: { ...tenantWhere(req), lead_id: leadId },
  });
  return resolveCurrentWalkthrough(visits);
}

/**
 * Book a NEW visit on a lead - the multi-visit create. Distinct from rescheduling: this never
 * touches an existing row, which is exactly what lets a lead hold several live visits at once
 * (user stories 6 and 7).
 */
export async function createLeadVisit(
  tx: Prisma.TransactionClient,
  opts: {
    leadId: string;
    orgId: string;
    visitSeq: number;
    scheduledAt: Date;
    scheduledEnd: Date;
    durationMinutes: number;
    notes?: string | null;
    stampCustomerEmailSentAt: boolean;
  },
) {
  return tx.visit.create({
    data: {
      organization_id: opts.orgId,
      lead_id: opts.leadId,
      purpose: 'WALKTHROUGH',
      visit_seq: opts.visitSeq,
      status: 'SCHEDULED',
      scheduled_at: opts.scheduledAt,
      // #1699: both ends of the span, from the one the caller already computed. The job-shaped
      // writers set the pair together; these two lead-shaped ones were the only writes that did
      // not, so a lead visit was born with a null end no reader could trust.
      scheduled_end: opts.scheduledEnd,
      duration_minutes: opts.durationMinutes,
      ...(opts.notes !== undefined ? { notes: opts.notes } : {}),
      ...(opts.stampCustomerEmailSentAt ? { customer_email_sent_at: new Date() } : {}),
    },
  });
}

/**
 * (Re)schedule the lead's active visit into SCHEDULED. Reuses the live row when there is one - a
 * genuine reschedule of the SAME visit - and otherwise books a fresh one.
 *
 * This is the LEGACY single-visit path, kept so the existing scheduling dialog keeps working
 * unchanged while S1 lands. Booking an ADDITIONAL visit alongside a live one goes through
 * createLeadVisit / POST /api/leads/:id/visits instead: this function still collapses onto one
 * row by design, because that is what "reschedule the appointment" means.
 */
export async function scheduleActiveWalkthrough(
  tx: Prisma.TransactionClient,
  opts: {
    leadId: string;
    orgId: string;
    activeWalkthroughId: string | null;
    wasAlreadyScheduled: boolean;
    visitSeq: number;
    scheduledAt: Date;
    scheduledEnd: Date;
    durationMinutes: number;
    stampCustomerEmailSentAt: boolean;
  },
) {
  const data = {
    status: 'SCHEDULED' as VisitStatus,
    scheduled_at: opts.scheduledAt,
    // #1699: the end MUST move with the start. Writing only `scheduled_at` left the row holding
    // the end of its previous slot, so a walkthrough moved later finished before it began.
    scheduled_end: opts.scheduledEnd,
    duration_minutes: opts.durationMinutes,
    ...(opts.stampCustomerEmailSentAt ? { customer_email_sent_at: new Date() } : {}),
  };
  const walkthrough = opts.activeWalkthroughId
    ? await tx.visit.update({ where: { id: opts.activeWalkthroughId }, data })
    : await tx.visit.create({
        data: {
          organization_id: opts.orgId,
          lead_id: opts.leadId,
          purpose: 'WALKTHROUGH',
          visit_seq: opts.visitSeq,
          ...data,
        },
      });
  return { walkthrough, isReschedule: opts.wasAlreadyScheduled };
}

/**
 * Unschedule a visit.
 *
 * D16/D19/D22a: with REQUESTED retired there is no "booked but timeless" state to fall back to -
 * an unscheduled trip IS a cancelled row, and "this lead needs a visit" is now expressed by the
 * lead having no live visit at all. The row is kept (never deleted) because the customer may hold
 * an email naming it, and because deleting it would make the first-time-fix / callback data
 * (SRVW-41) unrecoverable.
 */
export async function unscheduleWalkthroughRow(tx: Prisma.TransactionClient, walkthroughId: string) {
  return tx.visit.update({
    where: { id: walkthroughId },
    data: { status: 'CANCELLED', cancelled_at: new Date(), cancelled_reason: 'Unscheduled' },
  });
}

/**
 * Live → COMPLETED, and only from live. Returns whether THIS call was the one that completed it.
 *
 * The status test lives in the WHERE rather than in a preceding read, for exactly the reason
 * `stampLeadClock` puts its null test there. The completion door resolves its target with a read
 * that runs BEFORE the transaction opens, so two requests arriving together both see the same live
 * visit and both reach this writer. Unconditional, the second one overwrote the first one's
 * `completed_at` — which is how a lead ended up carrying a first-completion stamp that matched
 * neither of its own visits, the lead clock having survived (it is written through a guarded
 * statement) while the visit row did not.
 *
 * Postgres settles it: under READ COMMITTED the second writer blocks on the row lock, then
 * re-evaluates this WHERE against the row the winner committed, whose status is no longer live —
 * so it matches nothing and truthfully reports `count: 0` instead of clobbering. `updateMany`
 * rather than `update` because `update` turns a no-match into a P2025 throw rather than a fact the
 * caller can act on — the same trade `stampLeadClock` documents.
 *
 * The accept-set is LIVE_VISIT_STATUSES, matching `findActiveWalkthrough`'s own filter, so this
 * rejects exactly the rows that read would never have handed over and no others. Guarding on
 * SCHEDULED alone would silently narrow the endpoint, which today completes any live visit.
 */
export async function completeWalkthroughRow(
  tx: Prisma.TransactionClient,
  walkthroughId: string,
  completedAt: Date,
): Promise<boolean> {
  const { count } = await tx.visit.updateMany({
    where: { id: walkthroughId, status: { in: [...LIVE_VISIT_STATUSES] } },
    data: { status: 'COMPLETED', completed_at: completedAt },
  });
  return count > 0;
}

/**
 * Live → CANCELLED (scheduled_at kept as history - D15 needs it to resolve "the most recent visit
 * that happened").
 *
 * D22a: this no longer mints a replacement placeholder row. It used to create a fresh REQUESTED
 * visit so the lead reappeared in the scheduler bucket; with REQUESTED retired, the lead
 * reappears there simply by having no live visit, and minting a row would be actively wrong under
 * multi-visit - cancelling ONE of three trips must not put the lead in "needs scheduling" while
 * two are still booked (D24/user story 24).
 *
 * `rebooked` stays in the return shape as null so callers keep compiling; it is removed when the
 * legacy endpoints are retired.
 */
export async function cancelWalkthroughRow(
  tx: Prisma.TransactionClient,
  // S4: `leadId` is optional because the job side calls this same writer, and a job visit has no
  // lead. It was already unused by the body - a job-side twin would only be a second copy of the
  // cancel shape for the two parents to drift apart on (D3).
  opts: { walkthroughId: string; leadId?: string; orgId: string; cancelledAt: Date; reason: string; cancelledBy: string },
) {
  const cancelled = await tx.visit.update({
    where: { id: opts.walkthroughId },
    data: {
      status: 'CANCELLED',
      cancelled_at: opts.cancelledAt,
      cancelled_reason: opts.reason,
      cancelled_by: opts.cancelledBy,
    },
  });
  const rebooked = null;
  return { cancelled, rebooked };
}

/**
 * Auto-cancel the lead's SCHEDULED visit as a side effect of the LEAD itself leaving the
 * pipeline (cancelLead / markLost) - unlike cancelWalkthroughRow, this never rebooks a fresh
 * REQUESTED row: the lead is terminal (CANCELLED/LOST), so it must not reappear in the "needs
 * scheduling" bucket. No-op when there is no SCHEDULED visit.
 */
export async function autoCancelScheduledWalkthroughOnLeadExit(
  tx: Prisma.TransactionClient,
  scheduled: { id: string } | null,
  opts: { cancelledAt: Date; reason: string; cancelledBy: string },
): Promise<void> {
  if (!scheduled) return;
  await tx.visit.update({
    where: { id: scheduled.id },
    data: {
      status: 'CANCELLED',
      cancelled_at: opts.cancelledAt,
      cancelled_reason: opts.reason,
      cancelled_by: opts.cancelledBy,
    },
  });
}

// ─── Job visits (multi-visit S2) ───────────────────────────────────────────
//
// D3: a visit is a visit - only the parent and the purpose differ. These live in the SAME module
// as the lead helpers above rather than in a job-side fork, so the LIVE_VISIT_STATUSES rule and
// the [{scheduled_at:'asc'},{created_at:'asc'}] ordering cannot drift between the two parents.
// That drift is exactly what #1551 spent a PR undoing.

/**
 * Book a NEW visit on a job. Sets `job_id` and leaves `lead_id` unset: D5's
 * `visits_exactly_one_parent` CHECK is a raw DB constraint Prisma cannot see, so a copy of the
 * lead helper that also stamped lead_id would typecheck, pass every mocked test, and fail only
 * against a real Postgres.
 *
 * Writes `duration_minutes` derived from the span alongside `scheduled_end`: every lead-shaped
 * reader (projectLegacyWalkthroughFields, detectPerformerConflicts) still reasons in minutes.
 * That is two representations of one fact in one row - every S2 write path sets them together.
 */
export async function createJobVisit(
  tx: Prisma.TransactionClient,
  opts: {
    jobId: string;
    orgId: string;
    visitSeq: number;
    scheduledAt: Date;
    scheduledEnd: Date;
    isAllDay: boolean;
    notes?: string | null;
    /**
     * S7: byte-parallel to createLeadVisit's option of the same name. ONE write, so the row that
     * gets emailed about and the row that records having been emailed about cannot be two writes
     * that disagree - that split is #1522's shape.
     */
    stampCustomerEmailSentAt?: boolean;
  },
) {
  return tx.visit.create({
    data: {
      organization_id: opts.orgId,
      job_id: opts.jobId,
      purpose: 'WORK',
      visit_seq: opts.visitSeq,
      status: 'SCHEDULED',
      scheduled_at: opts.scheduledAt,
      scheduled_end: opts.scheduledEnd,
      is_all_day: opts.isAllDay,
      duration_minutes: Math.max(
        1,
        Math.round((opts.scheduledEnd.getTime() - opts.scheduledAt.getTime()) / 60_000),
      ),
      ...(opts.notes !== undefined ? { notes: opts.notes } : {}),
      ...(opts.stampCustomerEmailSentAt ? { customer_email_sent_at: new Date() } : {}),
    },
  });
}

/**
 * D13: the next visit number on a job, taken from MAX(visit_seq) rather than from a row count -
 * a number that has been in a customer's inbox must never be handed to a different trip, so a
 * cancelled visit still consumes its number.
 *
 * Takes the TRANSACTION client, so the MAX read happens inside the transaction. That narrows the
 * race but does not close it - the read takes no lock, so two concurrent transactions can still
 * see the same MAX. Since 20260821120000 there IS a unique index on (job_id, visit_seq) and on
 * (lead_id, visit_seq) to catch it when they do, and `withVisitSeqRetry` re-runs the whole
 * transaction so the loser re-reads rather than 500ing (section 4.4 of the multi-visit QA run).
 * The lead-side twin was the outstanding follow-up this docstring used to name; it now takes `tx`
 * on the same terms, after the global-client read turned out to deadlock on the pool under
 * DB_TENANT_GUARD as well as race.
 *
 * Tenant-scoped by orgId (the caller has already tenant-probed the job).
 */
/**
 * The two unique indexes that mean "another writer took the number we just allocated".
 *
 * Prisma reports P2002 with `meta.target` as either the index NAME or the column list,
 * depending on the connector and the error path, so both spellings are matched.
 */
export const VISIT_SEQ_UNIQUE_TARGETS = [
  'visits_job_id_visit_seq_key',
  'visits_lead_id_visit_seq_key',
  'job_id_visit_seq',
  'lead_id_visit_seq',
] as const;

function isVisitSeqCollision(err: unknown): boolean {
  const e = err as { code?: string; meta?: { target?: unknown } } | null;
  if (!e || e.code !== 'P2002') return false;
  const target = e.meta?.target;
  const asText = Array.isArray(target) ? target.join('_') : String(target ?? '');
  return VISIT_SEQ_UNIQUE_TARGETS.some((t) => asText.includes(t) || t.includes(asText));
}

/**
 * Re-run a visit-creating unit of work when two writers allocate the same visit_seq.
 *
 * The number comes from MAX(visit_seq) + 1 with no lock, so concurrent creates can read the
 * same MAX. The unique index added in 20260821120000 turns that from a silent duplicate -
 * two trips sharing one number, in two customer emails that cannot be told apart - into a
 * failed write; this turns the failed write back into a correct number.
 *
 * `fn` must be the WHOLE transaction, not just the insert: a unique violation aborts the
 * transaction it happens in, so the MAX has to be re-read inside a fresh one. Bounded at
 * three attempts, because a collision that survives that many re-reads is not contention
 * any more and should surface rather than spin.
 *
 * Only the visit_seq indexes are retried. Any other P2002 is a real error, and retrying it
 * would repeat the same failure while hiding its cause.
 */
export async function withVisitSeqRetry<T>(fn: () => Promise<T>, attempts = 3): Promise<T> {
  let lastErr: unknown;
  for (let i = 0; i < attempts; i += 1) {
    try {
      return await fn();
    } catch (err) {
      if (!isVisitSeqCollision(err)) throw err;
      lastErr = err;
    }
  }
  throw lastErr;
}

export async function nextVisitSeqForJob(
  tx: Prisma.TransactionClient,
  orgId: string,
  jobId: string,
): Promise<number> {
  const agg = await tx.visit.aggregate({
    where: { organization_id: orgId, job_id: jobId },
    _max: { visit_seq: true },
  });
  return (agg._max.visit_seq ?? 0) + 1;
}

/**
 * The next UPCOMING trip: the row Job.scheduled_start mirrors (D14 (ii)).
 *
 * "Upcoming" is measured on the visit's END, not its start, so a visit under way right now still
 * wins - handing the mirror to next week's trip while the crew is on site would drop today's job
 * off today's board. Among upcoming visits the earliest wins; a live visit with no time yet sorts
 * last and never wins; creation order breaks a tie - the same
 * [{scheduled_at:'asc'},{created_at:'asc'}] ordering listLeadVisits and findActiveWalkthrough
 * apply, so the lead side and the job side cannot disagree about what "next" means.
 *
 * When every live visit has already elapsed the EARLIEST is returned rather than nothing. S2's
 * reason for that ("a job visit has no way to leave SCHEDULED, so an untouched job accumulates
 * elapsed live rows") is VOID from S4 - cancel and complete exist now, and an elapsed visit can be
 * taken off the live set deliberately. The behaviour survives on a different, re-derived reason: a
 * past visit that is STILL LIVE is one nobody has actioned - the crew did not complete it and the
 * office did not cancel it - and that trip should keep holding the board slot until somebody says
 * what happened to it. Returning null there would blank Job.scheduled_start (still the column the
 * board, search and reports read until S6) and quietly drop the job off the board instead.
 *
 * The genuinely empty case is different and is D16's collapse, handled by syncJobFromVisits: no
 * LIVE visit at all means the schedule columns go to null and the job derives UNSCHEDULED.
 */
export function resolveNextJobVisit<
  T extends { scheduled_at: Date | null; scheduled_end?: Date | null; created_at: Date },
>(visits: T[], now: Date = new Date()): T | null {
  // `!= null` (not `!== null`): a real Prisma select never OMITS a selected column, so
  // `scheduled_at` is always an explicit `Date` or an explicit `null` in production - but the
  // mocked-Prisma seam this codebase's whole backend test suite runs on can and does build a
  // fixture that leaves the key `undefined`, which `!== null` lets through only to crash two
  // lines down on `.getTime()`. Found via job-schedule-projection.test.ts (S8, A5) exercising this
  // function through a new caller (resolveJobScheduleWindow) that a sloppier fixture could reach.
  const timed = visits.filter((v) => v.scheduled_at != null);
  if (timed.length === 0) return null;
  const earliestOf = (rows: T[]) =>
    rows.reduce((earliest, v) => {
      const a = v.scheduled_at!.getTime();
      const b = earliest.scheduled_at!.getTime();
      if (a !== b) return a < b ? v : earliest;
      return v.created_at.getTime() < earliest.created_at.getTime() ? v : earliest;
    });
  const upcoming = timed.filter(
    (v) => (v.scheduled_end ?? v.scheduled_at!).getTime() > now.getTime(),
  );
  return earliestOf(upcoming.length > 0 ? upcoming : timed);
}

/**
 * The trip the crew is ON RIGHT NOW, for the job-level verbs - a different question from the one
 * resolveNextJobVisit answers.
 *
 * The board mirror wants the next UPCOMING trip. A technician pressing Start on the job page wants
 * the trip in front of them, and those two part company the moment a job runs late: with visit 1
 * booked 09:00-11:30 today and visit 2 next week, a press at 11:45 finds visit 1 no longer
 * "upcoming" and resolveNextJobVisit hands back NEXT WEEK's trip. Stamping that one leaves today's
 * visit SCHEDULED for ever, shows next week as already under way, and dates the per-visit history
 * behind the customer's "Visit 2" email a week early.
 *
 * So a visit that has BEGUN wins over one that has not: begun by the clock (its start time has
 * passed) or begun by hand (its status has left SCHEDULED, which is the crew who arrived early).
 * The LATEST such row wins, because a job holding two elapsed unactioned trips is one whose crew
 * is at the more recent of them. With nothing begun this defers to resolveNextJobVisit, so the
 * ordinary case - every trip still ahead - is the earliest upcoming, exactly as the mirror sees it.
 *
 * Untimed rows are ignored here for the same reason resolveNextJobVisit ignores them: a visit with
 * no time cannot be the one anybody is standing at.
 */
export function resolveCurrentJobVisit<
  T extends {
    status: VisitStatus;
    scheduled_at: Date | null;
    scheduled_end?: Date | null;
    created_at: Date;
  },
>(visits: T[], now: Date = new Date()): T | null {
  const begun = visits.filter(
    (v) => v.scheduled_at !== null && (v.status !== 'SCHEDULED' || v.scheduled_at.getTime() <= now.getTime()),
  );
  if (begun.length === 0) return resolveNextJobVisit(visits, now);
  return begun.reduce((latest, v) => {
    const a = v.scheduled_at!.getTime();
    const b = latest.scheduled_at!.getTime();
    if (a !== b) return a > b ? v : latest;
    return v.created_at.getTime() > latest.created_at.getTime() ? v : latest;
  });
}

/**
 * Multi-visit S4 (D7): move ONE visit along its lifecycle and stamp the matching column.
 *
 * One writer for every door - the per-visit routes and the job-level start/arrive/en-route verbs
 * that now act on the job's current visit both come through here, so a job-level copy and a
 * visit-level copy cannot drift. That drift is what #1551 spent a PR undoing.
 *
 * Writes the status, the stamp and the LATER stamps this move rewinds - no visit_seq (D13 - the
 * number never moves), no schedule columns (a lifecycle write is not a reschedule), no parent.
 *
 * The rewind is job-milestones.ts's rule applied to the row that now owns these columns, and it is
 * load-bearing rather than tidy: D12 reads IN_PROGRESS off `started_at`, so a backward move that
 * left the later stamp in place would be a no-op the moment anything re-derived - the job would
 * keep answering IN_PROGRESS, and the next syncJobFromVisits would mirror the surviving stamp back
 * onto Job.started_at, silently undoing the dispatcher's correction. There is no route that can
 * un-stamp a visit, so nothing else could ever put it right. An earlier draft of this writer left
 * the later stamps alone on the grounds that "on a visit a later stamp is history": history is
 * exactly what a backward move on the lifecycle bar is asked to rewrite, and the job row's own
 * twin (milestoneClears) has always rewritten it.
 */
export const VISIT_MILESTONE_COLUMNS = {
  en_route: { status: 'EN_ROUTE', column: 'en_route_at', clears: ['on_site_at', 'started_at', 'completed_at'] },
  on_site: { status: 'ON_SITE', column: 'on_site_at', clears: ['started_at', 'completed_at'] },
  started: { status: 'IN_PROGRESS', column: 'started_at', clears: ['completed_at'] },
  completed: { status: 'COMPLETED', column: 'completed_at', clears: [] },
} as const;

export type VisitMilestone = keyof typeof VISIT_MILESTONE_COLUMNS;

export async function stampVisitMilestone(
  tx: Prisma.TransactionClient,
  visitId: string,
  milestone: VisitMilestone,
  at: Date,
) {
  const { status, column, clears } = VISIT_MILESTONE_COLUMNS[milestone];
  const rewind: Record<string, null> = {};
  for (const later of clears) rewind[later] = null;
  return tx.visit.update({
    where: { id: visitId },
    data: { status: status as VisitStatus, [column]: at, ...rewind },
  });
}

/**
 * Multi-visit S4 (B9): apply a milestone to the job's CURRENT visit, for the job-level verbs.
 *
 * POST /:id/en-route, /:id/arrive and /:id/start are the door the shipped JobLifecycleBar, the
 * copilot's update_job_status and POST /:id/status all press, and they must keep working
 * unchanged while the truth moves to the visit underneath them. So they resolve the job's current
 * trip - resolveCurrentJobVisit, which is the mirror's rule with one difference: a trip that has
 * already begun beats one that has not yet, so a crew running past their slot stamps the visit
 * they are standing at rather than next week's - and stamp it through the SAME writer the
 * per-visit routes use. A job-level copy and a visit-level copy of this write is the drift #1551
 * spent a PR undoing.
 *
 * Returns null when the job holds no live visit, which is not an error: a job can be started
 * before anyone has booked a trip for it, and the caller falls back to stamping the job row alone.
 *
 * Takes a client rather than requiring a transaction: the three job-level verbs write their
 * timeline event and their job row on the global client today, and wrapping them would silently
 * break every suite that exercises them without wiring $transaction (setup.ts leaves it a bare
 * vi.fn(), so an unwired callback never runs at all).
 */
export async function stampCurrentJobVisitMilestone(
  client: Prisma.TransactionClient,
  opts: { jobId: string; orgId: string; milestone: VisitMilestone; at: Date },
): Promise<string | null> {
  const live = await client.visit.findMany({
    where: {
      organization_id: opts.orgId,
      job_id: opts.jobId,
      status: { in: [...LIVE_VISIT_STATUSES] },
    },
  });
  const current = resolveCurrentJobVisit(live);
  if (!current) return null;
  await stampVisitMilestone(client, current.id, opts.milestone, opts.at);
  return current.id;
}

/**
 * D14 (ii) + D12 + D16: keep the job row true to its visit set, in the SAME transaction as the
 * visit write that changed it.
 *
 * THREE jobs in one function now, not four - S8 (RATIFIED, A5) dropped the forward-looking
 * schedule mirror (`scheduled_start`/`scheduled_end`/`is_all_day`) from `jobs` entirely. Those
 * three wire keys are served on READ, computed fresh off `job.visits[]` by
 * `lib/job-schedule-projection.ts` (the same "next upcoming live visit" rule this function used to
 * write here) - nothing is written for them any more, by this function or any other:
 *  - the milestone mirror (started_at only, now) is the EARLIEST non-null across the WHOLE set.
 *    S5 repointed the lifecycle bar onto the visit set, so en_route_at/on_site_at had no reader at
 *    all before S8 dropped their JOB-level columns outright; started_at is NOT symmetric and still
 *    feeds deriveJobStatus's urgent-workflow branch, so its write stays;
 *  - the BACKWARD-LOOKING duration span (S8 §4, A2+) - first_visit_start / last_visit_end /
 *    last_visit_completed_at - is MIN/MAX over the NON-CANCELLED set, unconditionally (see
 *    spanStamp below: unlike the milestone mirror, these three have no direct job-level writer to
 *    protect, so "no qualifying visit" is always NULL, not "write nothing");
 *  - Job.status is DERIVED (D12) from the same post-write set.
 *
 * It ALWAYS writes now. S2's version returned early when no live visit remained, with a comment
 * saying D16's collapse "arrives with S4's cancel/complete" - this is that collapse: with no live
 * visit the projection reads NULL (computed on read, nothing to write here for it) and the
 * derivation answers UNSCHEDULED, so a job whose last trip was called off stops sitting inside the
 * board's date-range query.
 *
 * It reads the job's CURRENT status on the TRANSACTION client rather than taking the caller's
 * pre-transaction `existing.status`. A status another writer changed between the two reads would
 * otherwise decide this derivation, and the derivation's whole job is to not fight a human-set
 * COMPLETED or CANCELLED.
 *
 * What it must NEVER do: route through assign() or reuse its data fragment. assign() spreads
 * `...(scheduled_start ? milestoneClears('scheduled') : {})`, so adding visit 3 to an in-flight job
 * would wipe visit 1's arrival and completion timestamps and revive a cancelled job. It also never
 * writes Job.completed_at in either direction - D7 says completing the last visit does not complete
 * the job, and the job-level fact stays explicitly set by complete()/reopen().
 */
export async function syncJobFromVisits(
  tx: Prisma.TransactionClient,
  opts: {
    jobId: string;
    orgId: string;
    /**
     * Set false by a handler that is itself deciding the status - job-level cancel and
     * reopen. Those two write the job row by hand and mean the status they set, so
     * re-deriving here would fight them; but they still need the BACKWARD-LOOKING SPAN
     * (first_visit_start / last_visit_end / last_visit_completed_at, S8 §4) re-derived - those
     * three have no other writer, so a stale pre-write value would survive the very request that
     * cancelled or restored the visit it describes (section 4.2 of the multi-visit QA run named
     * this exact hazard against the now-dropped forward mirror; the span carries the identical
     * risk under a different name).
     */
    deriveStatus?: boolean;
  },
) {
  // The WHOLE set, not just the live subset: D12's derivation needs the completed rows (a job
  // whose only visit just finished is IN_PROGRESS, not UNSCHEDULED), and the milestone mirror
  // reads stamps off rows that have already left the live set.
  const all = await tx.visit.findMany({
    where: { organization_id: opts.orgId, job_id: opts.jobId },
  });

  const job = await tx.job.findUnique({
    where: { id: opts.jobId },
    // started_at joins the select so the mirror below can tell a stamp that came FROM a visit
    // from one the urgent workflow set on the job itself. en_route_at/on_site_at are GONE from
    // `jobs` (S8, RATIFIED) - nothing here reads or writes them at the job level any more; the
    // VISIT's own en_route_at/on_site_at (read a few lines down, off `all`) are untouched.
    select: { status: true, started_at: true },
  });

  // CANCELLED rows are excluded on the same grounds deriveJobStatusFromVisits excludes them:
  // the row is kept as history (D19) and keeps its stamps, so a trip that was started and
  // then called off is not evidence of work in flight.
  const notCalledOff = all.filter((v) => v.status !== 'CANCELLED');

  /**
   * Has ANY trip on this job ever been worked - including one since cancelled, whose stamps
   * are kept as history (D19)?
   *
   * This is what separates the two reasons a live set can carry no start stamp. If a trip
   * WAS worked, the visit set is the authority and the job's columns mirror it, nulls
   * included: that is the dispatcher's backward correction, or a started trip since called
   * off. If NOTHING on this job has ever been worked, the job's own stamp is the only
   * evidence there is - the urgent workflow, where a job is created UNSCHEDULED and started
   * on the spot with no visit at all (story 45) - and booking the return trip must not read
   * "this visit has not started" as "the job has not started".
   */
  const anyVisitWorked = all.some(
    (v) => v.en_route_at != null || v.on_site_at != null || v.started_at != null
      || v.completed_at != null || v.status === 'COMPLETED',
  );

  /**
   * Earliest stamp across the live set, and NULL when the live set has none but some trip
   * was worked.
   *
   * The old version returned {} - "write nothing" - whenever the live set had no stamp,
   * which made these columns write-once: a backward move nulled the VISIT's stamp and the
   * job's copy survived, so D12 kept reading IN_PROGRESS off a job whose trips had all been
   * rewound or called off, and no route existed that could ever put it right (section 4.1).
   */
  // S8 (RATIFIED): only ever called with 'started_at' now - en_route_at/on_site_at are gone from
  // `jobs`. The parameter stays generic-shaped (rather than hard-coding the one column) because
  // `v[column]` still reads off the VISIT row `notCalledOff` holds, which keeps its own
  // en_route_at/on_site_at columns untouched by this drop.
  const mirrorMilestone = (column: 'started_at') => {
    const stamps = notCalledOff
      .map((v) => v[column])
      .filter((d): d is Date => d instanceof Date);
    if (stamps.length > 0) {
      return { [column]: stamps.reduce((a, b) => (a.getTime() <= b.getTime() ? a : b)) };
    }
    if (!anyVisitWorked) return {};
    return { [column]: null };
  };
  const milestones = mirrorMilestone('started_at') as Partial<Record<'started_at', Date | null>>;

  /**
   * A2+ (multi-visit S8 §4, D14(i)): the BACKWARD-LOOKING duration span, over the SAME
   * `notCalledOff` set the milestone mirror above uses - a cancelled trip is not evidence of
   * planned or actual work (D19) here either.
   *
   * Unlike mirrorMilestone, there is no "write nothing" branch: these three columns have no
   * job-level, visit-independent writer to protect the way started_at protects the urgent
   * workflow's direct job-level stamp. first_visit_start / last_visit_end /
   * last_visit_completed_at are ONLY ever a fact about the visit set, so "no qualifying visit"
   * always means an unconditional NULL, on every call - including the one that just cancelled a
   * job's only visit. That is the #1550-class bug mirrorMilestone's own comment describes,
   * avoided here by never having a write-once branch to fall into in the first place.
   */
  const spanStamp = (
    field: 'scheduled_at' | 'scheduled_end' | 'completed_at',
    pick: (a: Date, b: Date) => Date,
  ): Date | null => {
    const stamps = notCalledOff
      .map((v) => v[field])
      .filter((d): d is Date => d instanceof Date);
    return stamps.length > 0 ? stamps.reduce(pick) : null;
  };
  // first_visit_start - MIN(scheduled_at). PLANNED start.
  const firstVisitStart = spanStamp('scheduled_at', (a, b) => (a.getTime() <= b.getTime() ? a : b));
  // last_visit_end - MAX(scheduled_end). PLANNED end - a booked window, not a completion.
  const lastVisitEnd = spanStamp('scheduled_end', (a, b) => (a.getTime() >= b.getTime() ? a : b));
  // last_visit_completed_at - MAX(completed_at). The only ACTUAL stamp of the three; pairs with
  // jobs.started_at (mirrorMilestone('started_at') above), not with first_visit_start.
  const lastVisitCompletedAt = spanStamp('completed_at', (a, b) => (a.getTime() >= b.getTime() ? a : b));

  // Derive off the started_at this write is ABOUT to set, not the one the row still holds.
  // Reading the stale value leaves the status behind its own mirror: the rewind cleared the
  // column and D12 went on answering IN_PROGRESS off the value being cleared in the very
  // same statement.
  const nextStartedAt = 'started_at' in milestones
    ? milestones.started_at ?? null
    : job?.started_at ?? null;
  const derived = job ? deriveJobStatus(job.status, all, nextStartedAt) : undefined;

  await tx.job.update({
    where: { id: opts.jobId },
    data: {
      // S8 (RATIFIED, A5): scheduled_start/scheduled_end/is_all_day are DROPPED from `jobs` -
      // nothing writes them here (or anywhere) any more. The wire keys are served on READ,
      // computed off `job.visits[]` by lib/job-schedule-projection.ts using the identical "next
      // upcoming live visit" rule this function used to apply on WRITE.
      first_visit_start: firstVisitStart,
      last_visit_end: lastVisitEnd,
      last_visit_completed_at: lastVisitCompletedAt,
      ...milestones,
      // Spread only when the derivation actually has an answer. `undefined` means "this job's
      // status is a human-set COMPLETED or CANCELLED, write nothing" - see lib/job-status.ts for
      // why that is not the same as writing the current value back.
      ...(opts.deriveStatus !== false && derived !== undefined ? { status: derived } : {}),
    },
  });
}

/**
 * The other direction of D14's mirror: keep the visit set in step with the ONE window a legacy
 * single-window writer just booked.
 *
 * /assign is that writer - the job page's Assign Technician dialog, the hero tile and the board
 * drag all POST it - and it writes Job.scheduled_start / scheduled_end / is_all_day directly.
 * Those three columns are a CACHE of the visit set from S2 onwards, so a booking that skips the
 * visits leaves the two disagreeing, and the next visit write recomputes the mirror from visits
 * alone and silently deletes the booking. The two entry points sit one click apart on the same
 * page.
 *
 * A job that already holds a live visit is being MOVED, so the next upcoming row is moved with it
 * (D19: same row, same visit_seq - the customer holds an email naming "Visit 1"). A job with no
 * live visit is being booked for the first time and gets one. Repointing /assign at the visit
 * layer wholesale is S6's job; this is the smallest thing that keeps the two representations
 * from contradicting each other in the meantime.
 *
 * Deliberately NOT followed by mirrorNextVisitOntoJob: assign() writes the job row itself, in the
 * same transaction, and re-deriving it here would fight that write.
 */
/**
 * S3: returns the ONE visit this call touched - the row it moved, or the row it created - so
 * /assign can land the crew it was given on exactly that visit and no other. `created` is part of
 * the answer because the two cases are different facts about crew: a trip this request invented has
 * no crew statement of its own and takes the one it was given, while a trip that already existed
 * carries a crew somebody chose per visit, which a job-level statement must not overwrite wholesale.
 * Callers that only wanted the window synced can keep ignoring the value.
 */
export async function syncJobWindowOntoVisits(
  tx: Prisma.TransactionClient,
  opts: { jobId: string; orgId: string; scheduledAt: Date; scheduledEnd: Date; isAllDay: boolean },
) {
  const live = await tx.visit.findMany({
    where: {
      organization_id: opts.orgId,
      job_id: opts.jobId,
      status: { in: [...LIVE_VISIT_STATUSES] },
    },
  });
  const next = resolveNextJobVisit(live);
  if (next) {
    await rescheduleVisitRow(tx, next.id, {
      scheduledAt: opts.scheduledAt,
      scheduledEnd: opts.scheduledEnd,
      isAllDay: opts.isAllDay,
    });
    return { id: next.id, created: false };
  }
  const created = await createJobVisit(tx, {
    jobId: opts.jobId,
    orgId: opts.orgId,
    visitSeq: await nextVisitSeqForJob(tx, opts.orgId, opts.jobId),
    scheduledAt: opts.scheduledAt,
    scheduledEnd: opts.scheduledEnd,
    isAllDay: opts.isAllDay,
  });
  return { id: created.id, created: true };
}

/**
 * Multi-visit S3 (D6, user story 10): land a JOB-level crew statement on ONE visit without letting
 * it fan out.
 *
 * /assign speaks job-level crew, and the Assign dialog seeds that array from `job.assignees` -
 * which from S3 is the UNION across every visit. Restating that array verbatim on the visit the
 * window sync touched writes the finish crew onto the pour trip: "the two techs who pour concrete
 * are not automatically the ones who come back to finish" is the story this exists to keep true,
 * and `JOIN LATERAL ... LIMIT 1` is how the S3 migration keeps the same thing true for the rows it
 * folded. The damage would compound rather than settle - the next Assign press re-seeds from the
 * grown union - and from S4/S7 the per-visit crew decides who may start the visit and who is
 * emailed about it.
 *
 * So the visit takes the CHANGE, not the statement: people the request newly names join the trip it
 * is booking, people it drops leave that trip, and everyone else's membership is left to the
 * per-visit surfaces that actually know. `previousJobCrew` is the union as it stood before this
 * request - the very set the dialog rendered - so the delta is what the dispatcher really did.
 *
 * A visit this request CREATED is the exception, and takes the crew wholesale: it has no crew
 * statement of its own to preserve, so the job-level one is the only information there is. This is
 * the going-forward twin of the migration folding job-level crew onto a job's first visit.
 *
 * Not tenant-filtered on the read, and safe for the same reason replaceWalkthroughPerformers is:
 * every caller has already tenant-checked the job before reaching here.
 */
export async function applyJobCrewStatementToVisit(
  tx: Prisma.TransactionClient,
  opts: {
    visitId: string;
    orgId: string;
    isNewVisit: boolean;
    previousJobCrew: string[];
    statedCrew: string[];
  },
): Promise<{ added: string[]; removed: string[] }> {
  if (opts.isNewVisit) {
    return replaceWalkthroughPerformers(tx, opts.visitId, null, opts.orgId, opts.statedCrew);
  }
  const before = new Set(opts.previousJobCrew);
  const stated = new Set(opts.statedCrew);
  const newlyNamed = [...stated].filter((id) => !before.has(id));
  const dropped = [...before].filter((id) => !stated.has(id));
  if (newlyNamed.length === 0 && dropped.length === 0) return { added: [], removed: [] };

  const current = await tx.visitAssignee.findMany({
    where: { visit_id: opts.visitId },
    select: { user_id: true },
  });
  const next = new Set(current.map((c) => c.user_id));
  for (const id of dropped) next.delete(id);
  for (const id of newlyNamed) next.add(id);
  return replaceWalkthroughPerformers(tx, opts.visitId, null, opts.orgId, [...next]);
}

/**
 * D19: reschedule is the SAME row with a new time, never a new visit. The customer holds an email
 * referencing "Visit 2", so the row's identity - and its visit_seq - must survive the move.
 * Sits beside the unscheduleWalkthroughRow / completeWalkthroughRow / cancelWalkthroughRow family.
 */
export async function rescheduleVisitRow(
  tx: Prisma.TransactionClient,
  visitId: string,
  opts: {
    scheduledAt: Date;
    scheduledEnd: Date;
    isAllDay?: boolean;
    notes?: string | null;
    /** S7: the FIRST announce of a trip booked silently. Same single-write rule as createJobVisit's. */
    stampCustomerEmailSentAt?: boolean;
  },
) {
  return tx.visit.update({
    where: { id: visitId },
    data: {
      scheduled_at: opts.scheduledAt,
      scheduled_end: opts.scheduledEnd,
      // Only when the caller actually said so: an undefined flag is "not part of this edit", and
      // writing false there silently converts an all-day visit - and, through the mirror, its
      // job - into a timed window nobody asked for.
      ...(opts.isAllDay !== undefined ? { is_all_day: opts.isAllDay } : {}),
      duration_minutes: Math.max(
        1,
        Math.round((opts.scheduledEnd.getTime() - opts.scheduledAt.getTime()) / 60_000),
      ),
      ...(opts.notes !== undefined && opts.notes !== null ? { notes: opts.notes } : {}),
      ...(opts.stampCustomerEmailSentAt ? { customer_email_sent_at: new Date() } : {}),
    },
  });
}

/**
 * Every visit on a job, earliest first. The job twin of listLeadVisits.
 *
 * D13: sorted by TIME, labelled by CREATION order - the ordering is applied here in code rather
 * than delegated to an `orderBy` so it is reachable from the API test seam (Prisma is mocked
 * across the backend suite, and a delegated orderBy is invisible there: a list that silently lost
 * its ordering would still look green).
 *
 * S3 (D6): each visit carries its own crew, so the collection serves it.
 *
 * The nested `user` select is a DELIBERATE divergence from listLeadVisits, which selects
 * `user_id` alone. The lead page gets crew NAMES from the separate flat projection
 * `lead.walkthrough_performers[].user`; the job side has no such projection, so copying the lead
 * shape verbatim would leave the job Visits card rendering raw UUIDs. The fields are byte-matched
 * to jobListSelect's assignee shape so the frontend types line up across both job reads.
 *
 * Tenancy: the outer where already spreads tenantWhere(req) and `assignees` is traversed from an
 * already-scoped row, so this does NOT inherit replaceWalkthroughPerformers' documented
 * not-tenant-filtered exception.
 */
export async function listJobVisits(req: Req, jobId: string) {
  const visits = await prisma.visit.findMany({
    where: { ...tenantWhere(req), job_id: jobId },
    include: {
      assignees: {
        select: { user_id: true, user: { select: { id: true, first_name: true, last_name: true } } },
      },
    },
  });
  return [...visits].sort((a, b) => {
    // A visit with no time yet sorts last, matching resolveNextJobVisit's rule.
    if (a.scheduled_at === null) return b.scheduled_at === null ? 0 : 1;
    if (b.scheduled_at === null) return -1;
    const delta = a.scheduled_at.getTime() - b.scheduled_at.getTime();
    return delta !== 0 ? delta : a.created_at.getTime() - b.created_at.getTime();
  });
}
