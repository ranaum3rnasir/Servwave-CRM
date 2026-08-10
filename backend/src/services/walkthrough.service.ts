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
import { Prisma, WalkthroughStatus } from '@prisma/client';
import { prisma } from '../lib/prisma';
import { tenantWhere } from '../lib/tenant';
import { isAssignable } from '../lib/permissions/assignableRoles';

// Matches every other lib/service in this codebase (tenantWhere, scopeWhereForReq, etc.) - the
// real Express Request, not a hand-rolled structural stand-in.
type Req = Request;

// ─── D15: "current visit" resolution ───────────────────────────────────────
//
// "Current visit" = the next upcoming SCHEDULED visit; if none upcoming, the most recent visit
// that happened (completed or cancelled). One rule, used by updateWalkthrough's write target, the
// four legacy-shaped SELECT/serialize sites (so their JSON responses keep the OLD flat field names
// while sourcing from the relation), and the automation merge fields/staleness guard/date-anchor.
//
// At most one non-terminal (REQUESTED/SCHEDULED) walkthrough exists per lead by construction (see
// findActiveWalkthrough below), so "the next upcoming SCHEDULED visit" collapses to "the lead's one
// SCHEDULED row, if any" - there is never more than one to pick between.

export type WalkthroughSnapshotRow = {
  id: string;
  status: WalkthroughStatus;
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
 */
export function projectLeadWalkthroughFields<T extends { walkthroughs?: WalkthroughSnapshotRow[] }>(
  lead: T,
  opts: { full: boolean },
): Omit<T, 'walkthroughs'> {
  if (!('walkthroughs' in (lead as object))) return lead as Omit<T, 'walkthroughs'>;
  const { walkthroughs, ...rest } = lead;
  return { ...rest, ...projectLegacyWalkthroughFields(walkthroughs, opts) } as Omit<T, 'walkthroughs'>;
}

/** D15's rule, applied to an already-fetched list of a lead's walkthroughs (any order). */
export function resolveCurrentWalkthrough<T extends WalkthroughSnapshotRow>(walkthroughs: T[]): T | null {
  const scheduled = walkthroughs.find((w) => w.status === 'SCHEDULED');
  if (scheduled) return scheduled;

  const happened = walkthroughs.filter((w) => w.status === 'COMPLETED' || w.status === 'CANCELLED');
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
export function projectLegacyWalkthroughFields(
  walkthroughs: WalkthroughSnapshotRow[] | undefined,
  opts: { full: boolean },
): Record<string, unknown> {
  const list = walkthroughs ?? [];
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
 * Merges `patch` into `where.walkthroughs`'s existing `some` clause instead of assigning a fresh
 * one. `where.walkthroughs` may already carry a row-scope condition (a TECHNICIAN's
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
  const existingSome = (where.walkthroughs as { some?: Record<string, unknown> } | undefined)?.some;
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
  return (await prisma.walkthrough.count({ where: { lead_id: leadId, status: 'COMPLETED' } })) > 0;
}

// ─── Performer helpers (moved from lead.controller.ts, now keyed by walkthrough_id) ──
//
// Mirror the job-crew side (replaceJobCrew / validateCrew / detectCrewConflicts).
// Walkthrough performers are MULTI with REPLACE semantics; lead owner is SINGLE.

export type PerformerMember = { id: string; email: string | null; first_name: string; last_name: string };

/**
 * REPLACE semantics: the array IS the new performer set for THIS visit. Diffs against the
 * visit's current performers inside the transaction and applies the delta. Writes BOTH
 * walkthrough_id (load-bearing) and lead_id (dual-write - every other reader of
 * `Lead.walkthrough_performers` still keys off lead_id until PR-D2) on every created row.
 * Returns {added, removed} (user-id arrays) for diff-emails.
 *
 * NOTE (unchanged invariant from the pre-redesign code): findMany/deleteMany here are NOT
 * tenant-filtered - safe only because every caller has already tenant-checked the lead/walkthrough
 * before reaching this function.
 */
export async function replaceWalkthroughPerformers(
  tx: Prisma.TransactionClient,
  walkthroughId: string,
  leadId: string,
  orgId: string,
  userIds: string[],
): Promise<{ added: string[]; removed: string[] }> {
  const current = await tx.leadWalkthroughPerformer.findMany({ where: { walkthrough_id: walkthroughId }, select: { user_id: true } });
  const currentIds = new Set(current.map((c) => c.user_id));
  const next = new Set(userIds);
  const added = [...next].filter((id) => !currentIds.has(id));
  const removed = [...currentIds].filter((id) => !next.has(id));
  if (removed.length) await tx.leadWalkthroughPerformer.deleteMany({ where: { walkthrough_id: walkthroughId, user_id: { in: removed } } });
  if (added.length) {
    await tx.leadWalkthroughPerformer.createMany({
      data: added.map((user_id) => ({ walkthrough_id: walkthroughId, lead_id: leadId, user_id, organization_id: orgId })),
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

  const [jobConflicts, walkthroughConflicts] = await Promise.all([
    prisma.job.findMany({
      where: {
        ...tw,
        assignees: { some: { user_id: { in: opts.userIds } } },
        // Spec B1 (Task 5): mirrors job.controller.ts's detectCrewConflicts identical fix --
        // a technician physically on site (or en route) still occupies the slot.
        status: { in: ['SCHEDULED', 'EN_ROUTE', 'ON_SITE', 'IN_PROGRESS'] },
        scheduled_start: { lt: schedEnd },
        scheduled_end: { gt: schedStart },
      },
      select: { id: true, job_number: true, scheduled_start: true, scheduled_end: true },
    }),
    prisma.walkthrough.findMany({
      where: {
        ...tw,
        lead_id: { not: opts.leadId },
        performers: { some: { user_id: { in: opts.userIds } } },
        status: 'SCHEDULED',
        scheduled_at: { not: null },
      },
      select: { id: true, scheduled_at: true, duration_minutes: true, lead: { select: { id: true, lead_number: true } } },
    }),
  ]);

  const wtConflicts = walkthroughConflicts.filter((wt) => {
    if (!wt.scheduled_at) return false;
    const wtStart = new Date(wt.scheduled_at);
    const wtEnd = new Date(wtStart.getTime() + (wt.duration_minutes || 60) * 60_000);
    return wtStart < schedEnd && wtEnd > schedStart;
  });

  return [
    ...jobConflicts.map((j) => ({ type: 'job' as const, id: j.id, number: j.job_number, start: j.scheduled_start, end: j.scheduled_end })),
    ...wtConflicts.map((w) => ({
      type: 'walkthrough' as const, id: w.lead.id, number: w.lead.lead_number,
      start: w.scheduled_at,
      end: new Date(new Date(w.scheduled_at!).getTime() + (w.duration_minutes || 60) * 60_000),
    })),
  ];
}

// ─── Visit lifecycle ──────────────────────────────────────────────────────

/** The lead's non-terminal (REQUESTED or SCHEDULED) walkthrough, if any - the visit that a
 *  schedule/setPerformers call acts on. At most one such row exists per lead by construction
 *  (every transition below either updates this row or replaces it with a fresh REQUESTED one). */
export async function findActiveWalkthrough(req: Req, leadId: string) {
  return prisma.walkthrough.findFirst({
    where: { ...tenantWhere(req), lead_id: leadId, status: { in: ['REQUESTED', 'SCHEDULED'] } },
    include: { performers: { select: { user_id: true } } },
    orderBy: { created_at: 'desc' },
  });
}

/** The lead's current SCHEDULED walkthrough, if any - the visit that complete/cancel act on. */
export async function findScheduledWalkthrough(req: Req, leadId: string) {
  return prisma.walkthrough.findFirst({
    where: { ...tenantWhere(req), lead_id: leadId, status: 'SCHEDULED' },
    orderBy: { created_at: 'desc' },
  });
}

/**
 * D15's current-visit resolution, fetched fresh for a single lead - used by updateWalkthrough
 * (the notes/duration-only save endpoint) to find the row it should actually write to.
 */
export async function findCurrentWalkthroughForLead(req: Req, leadId: string) {
  const walkthroughs = await prisma.walkthrough.findMany({
    where: { ...tenantWhere(req), lead_id: leadId },
  });
  return resolveCurrentWalkthrough(walkthroughs);
}

/**
 * Create-or-update the lead's active visit into SCHEDULED. Reuses an existing REQUESTED/
 * SCHEDULED row (a genuine (re)schedule of the SAME visit); creates a fresh row when the lead's
 * last visit already finished (COMPLETED/CANCELLED) - that is a NEW visit, per D1.
 * `wasAlreadyScheduled` tells the caller whether this is a time change on an existing
 * appointment (-> WALKTHROUGH_RESCHEDULED timeline event) vs a first booking (->
 * WALKTHROUGH_SCHEDULED) - the walkthrough-row analogue of the old lead-status-based heuristic.
 */
export async function scheduleActiveWalkthrough(
  tx: Prisma.TransactionClient,
  opts: {
    leadId: string;
    orgId: string;
    activeWalkthroughId: string | null;
    wasAlreadyScheduled: boolean;
    scheduledAt: Date;
    durationMinutes: number;
    stampCustomerEmailSentAt: boolean;
  },
) {
  const data = {
    status: 'SCHEDULED' as WalkthroughStatus,
    scheduled_at: opts.scheduledAt,
    duration_minutes: opts.durationMinutes,
    ...(opts.stampCustomerEmailSentAt ? { customer_email_sent_at: new Date() } : {}),
  };
  const walkthrough = opts.activeWalkthroughId
    ? await tx.walkthrough.update({ where: { id: opts.activeWalkthroughId }, data })
    : await tx.walkthrough.create({ data: { organization_id: opts.orgId, lead_id: opts.leadId, ...data } });
  return { walkthrough, isReschedule: opts.wasAlreadyScheduled };
}

/** SCHEDULED → REQUESTED, scheduled_at cleared. Performers are left untouched (crew ⟂ schedule). */
export async function unscheduleWalkthroughRow(tx: Prisma.TransactionClient, walkthroughId: string) {
  return tx.walkthrough.update({
    where: { id: walkthroughId },
    data: { status: 'REQUESTED', scheduled_at: null },
  });
}

/** SCHEDULED → COMPLETED. */
export async function completeWalkthroughRow(tx: Prisma.TransactionClient, walkthroughId: string, completedAt: Date) {
  return tx.walkthrough.update({
    where: { id: walkthroughId },
    data: { status: 'COMPLETED', completed_at: completedAt },
  });
}

/**
 * SCHEDULED → CANCELLED (scheduled_at kept as history - D15 needs it to resolve "the most recent
 * visit that happened"), plus a FRESH REQUESTED row for the same lead so it reappears in the
 * scheduler bucket (D12). The new row carries no performers - a dismissed/cancelled crew is not
 * assumed to be the crew for whatever gets rebooked next.
 */
export async function cancelWalkthroughRow(
  tx: Prisma.TransactionClient,
  opts: { walkthroughId: string; leadId: string; orgId: string; cancelledAt: Date; reason: string; cancelledBy: string },
) {
  const cancelled = await tx.walkthrough.update({
    where: { id: opts.walkthroughId },
    data: {
      status: 'CANCELLED',
      cancelled_at: opts.cancelledAt,
      cancelled_reason: opts.reason,
      cancelled_by: opts.cancelledBy,
    },
  });
  const rebooked = await tx.walkthrough.create({
    data: { organization_id: opts.orgId, lead_id: opts.leadId, status: 'REQUESTED' },
  });
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
  await tx.walkthrough.update({
    where: { id: scheduled.id },
    data: {
      status: 'CANCELLED',
      cancelled_at: opts.cancelledAt,
      cancelled_reason: opts.reason,
      cancelled_by: opts.cancelledBy,
    },
  });
}
