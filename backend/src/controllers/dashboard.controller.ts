import { Request, Response } from 'express';
import type { LeadStatus } from '@prisma/client';
import { prisma } from '../lib/prisma';
import { logger } from '../lib/logger';
import { tenantWhere } from '../lib/tenant';
import { arOutstandingWhere } from '../lib/ar';
import { ESTIMATE_STATUS } from '../constants/estimateStatus';
import { signAvatarPaths, resolveAvatarUrl } from '../lib/avatar';
import { NO_LIVE_VISIT_WHERE, resolveNextJobVisit } from '../services/walkthrough.service';
import { LIVE_VISIT_STATUSES } from '../lib/visit-status';
import { jobCrewIds } from '../lib/job-crew';
import { resolveDeletedTaskLabels } from '../lib/tasks/deletion';
import {
  buildScoreboard,
  buildJobsByStatus,
  buildComingUp,
  buildPipeline,
  buildLeadSources,
  buildRevenueByJobType,
  buildRecurring,
  buildScheduleLanes,
} from '../services/dashboard-metrics';

const OPEN_LEAD_STATUSES: LeadStatus[] = [
  'NEW',
  'CONTACTED',
  'ESTIMATED',
];

/**
 * S8 repoint (D14): "does this job have a trip in this window" — the reference pattern from
 * `buildJobListWhere` (job.controller.ts:948-972). Composed under `AND` by every call site below
 * (never assigned onto `where.visits`) so a future row-scope on this endpoint can never be
 * clobbered. The second OR arm exists because a CANCELLED job holds nothing but cancelled trips
 * (D19 keeps the rows) — on the KPI tiles below that already exclude CANCELLED at the top level
 * the arm is inert, but it is kept so every site written against this helper shares one shape
 * with the shipped reference rather than each reasoning separately about when it's safe to drop.
 */
function visitInWindowClause(window: { gte?: Date; lte?: Date; lt?: Date; gt?: Date }): Record<string, unknown> {
  return {
    OR: [
      { visits: { some: { scheduled_at: window, status: { not: 'CANCELLED' } } } },
      { status: 'CANCELLED' as const, visits: { some: { scheduled_at: window } } },
    ],
  };
}

// Prisma cannot ORDER BY a to-many relation's resolved value, so the two genuinely
// forward-looking queries below (site 3 "needs attention: past start" and site 6 "coming up")
// cannot ask the DB to sort/limit by "the winning live visit's instant" directly. Both over-fetch
// a generous, bounded cap and resolve/sort/slice in application code instead — the same
// trade-off search.controller.ts's SCHEDULE_OVERFETCH already makes for an analogous bounded,
// non-paginated UI slot (a dashboard tile, not a report).
const ATTENTION_OVERFETCH = 25; // widget shows top 3
const COMING_UP_OVERFETCH = 40; // widget shows top 6

export async function getDashboard(req: Request, res: Response) {
  try {
    const orgWhere = tenantWhere(req);
    const now = new Date();

    // ── Date boundaries ──────────────────────────────────────────────────
    const todayStart = new Date(now);
    todayStart.setHours(0, 0, 0, 0);
    const todayEnd = new Date(now);
    todayEnd.setHours(23, 59, 59, 999);

    const yesterdayStart = new Date(todayStart);
    yesterdayStart.setDate(yesterdayStart.getDate() - 1);
    const yesterdayEnd = new Date(todayEnd);
    yesterdayEnd.setDate(yesterdayEnd.getDate() - 1);

    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
    const lastMonthStart = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    const lastMonthEnd = new Date(now.getFullYear(), now.getMonth(), 0, 23, 59, 59, 999);

    const thirtyDaysAgo = new Date(now);
    thirtyDaysAgo.setDate(now.getDate() - 30);
    const sixtyDaysAgo = new Date(now);
    sixtyDaysAgo.setDate(now.getDate() - 60);

    // Current week (Sunday → Saturday) for the "Jobs This Week" KPI
    const weekStart = new Date(todayStart);
    weekStart.setDate(todayStart.getDate() - todayStart.getDay());
    const weekEnd = new Date(weekStart);
    weekEnd.setDate(weekStart.getDate() + 6);
    weekEnd.setHours(23, 59, 59, 999);

    // ── Schedule date (from query param, default = today) ────────────────
    const scheduleDateStr = req.query.date as string | undefined;
    let scheduleDate = new Date(now);
    if (scheduleDateStr && /^\d{4}-\d{2}-\d{2}$/.test(scheduleDateStr)) {
      scheduleDate = new Date(scheduleDateStr + 'T00:00:00');
    }
    const scheduleDateStart = new Date(scheduleDate);
    scheduleDateStart.setHours(0, 0, 0, 0);
    const scheduleDateEnd = new Date(scheduleDate);
    scheduleDateEnd.setHours(23, 59, 59, 999);

    // ── Chart period ─────────────────────────────────────────────────────
    const periodStr = (req.query.period as string) || '6M';
    const monthCount = periodStr === '3M' ? 3 : periodStr === '12M' ? 12 : 6;
    const chartPeriodStart = new Date(now.getFullYear(), now.getMonth() - monthCount + 1, 1);

    // ── Schedule department filter (UUID, optional) ──────────────────────
    const rawDepartmentId = req.query.department_id;
    const scheduleDepartmentId =
      typeof rawDepartmentId === 'string' &&
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(rawDepartmentId)
        ? rawDepartmentId
        : undefined;

    // ── All queries in parallel ──────────────────────────────────────────
    const [
      jobsTodayGroups,
      jobsYesterdayCount,
      invoicedMtdAgg,
      collectedMtdAgg,
      collectedLastMonthAgg,
      revenueTargetSetting,
      openInvoicesForAr,
      openLeads,
      closeRateCurrent,
      closeRatePrior,
      attentionData,
      scheduleJobs,
      scheduleWalkthroughs,
      activityFeed,
      chartPaymentsRaw,
      chartInvoicesRaw,
      // ── Redesigned dashboard: net-new metrics ──
      collectedTodayAgg,
      jobsDoneTodayCount,
      avgTicketAgg,
      jobsWeekCompletedCount,
      jobsWeekScheduledCount,
      depositsAwaitingAgg,
      jobsByStatusGroups,
      techScoreboardJobs,
      comingUpRows,
      leadsMtdCount,
      estimatesMtdAgg,
      approvedMtdAgg,
      depositMtdAgg,
      jobAmountMtdAgg,
      // ── Demo widgets: lead sources, revenue-by-type, dispatch board, recurring ──
      leadSourceCountGroups,
      completedJobsWithEstimate,
      dispatchScoreboardGroups,
      activePlans,
    ] = await Promise.all([
      // 1. Jobs today grouped by status. S8 repoint (D14): backward-looking — "did this job have
      // a trip today", so it reads the visit set, not the (to-be-dropped) scheduled_start mirror.
      // Free bug fix (see PR body): the mirror NULLs for a COMPLETED job once its last live visit
      // leaves the live set (D16), so this tile has been under-counting completed work today.
      prisma.job.groupBy({
        by: ['status'],
        where: {
          ...orgWhere,
          status: { not: 'CANCELLED' },
          AND: [visitInWindowClause({ gte: todayStart, lte: todayEnd })],
        },
        _count: { _all: true },
      }),

      // 2. Jobs yesterday count (for delta). Same repoint as #1.
      prisma.job.count({
        where: {
          ...orgWhere,
          status: { not: 'CANCELLED' },
          AND: [visitInWindowClause({ gte: yesterdayStart, lte: yesterdayEnd })],
        },
      }),

      // 3. Invoiced MTD (excludes DEPOSIT invoices — unearned until applied, #496)
      prisma.invoice.aggregate({
        where: { ...orgWhere, kind: { not: 'DEPOSIT' }, created_at: { gte: monthStart }, status: { not: 'VOIDED' } },
        _sum: { total_amount: true },
      }),

      // 4. Collected MTD (payments via invoice relation for org scoping).
      // Exclude voided payments + DEPOSIT-invoice payments: an applied deposit is
      // counted once, via its DEPOSIT-CREDIT payment on the STANDARD invoice —
      // same semantics as the revenue report (report.controller.ts getRevenueReport).
      prisma.payment.aggregate({
        where: {
          paid_at: { gte: monthStart },
          voided_at: null,
          invoice: { ...orgWhere, kind: { not: 'DEPOSIT' } },
        },
        _sum: { amount: true },
      }),

      // 5. Collected last month (same voided/DEPOSIT exclusions as #4)
      prisma.payment.aggregate({
        where: {
          paid_at: { gte: lastMonthStart, lte: lastMonthEnd },
          voided_at: null,
          invoice: { ...orgWhere, kind: { not: 'DEPOSIT' } },
        },
        _sum: { amount: true },
      }),

      // 6. Revenue target from AppSetting — per-org composite key set in Task 23
      prisma.appSetting.findUnique({ where: { organization_id_key: { organization_id: orgWhere.organization_id, key: 'revenue_target_monthly' } } }),

      // 7. Open invoices for AR aging
      prisma.invoice.findMany({
        where: { ...orgWhere, ...arOutstandingWhere },
        select: { amount_due: true, due_date: true },
      }),

      // 8. Open leads
      prisma.lead.findMany({
        where: { ...orgWhere, status: { in: OPEN_LEAD_STATUSES } },
        select: {
          id: true,
          lead_assignees: { select: { user_id: true } },
        },
      }),

      // 9. Close rate — current 30 days
      prisma.lead.groupBy({
        by: ['status'],
        where: { ...orgWhere, status: { in: ['WON', 'LOST'] }, updated_at: { gte: thirtyDaysAgo } },
        _count: { _all: true },
      }),

      // 10. Close rate — prior 30 days (for delta)
      prisma.lead.groupBy({
        by: ['status'],
        where: { ...orgWhere, status: { in: ['WON', 'LOST'] }, updated_at: { gte: sixtyDaysAgo, lt: thirtyDaysAgo } },
        _count: { _all: true },
      }),

      // 11. Needs attention (5 sub-queries in parallel)
      Promise.all([
        // Overdue invoices
        prisma.invoice.findMany({
          where: { ...orgWhere, status: { in: ['SENT', 'PARTIAL'] }, due_date: { lt: now } },
          select: {
            id: true,
            invoice_number: true,
            due_date: true,
            amount_due: true,
            job: {
              select: {
                customer: { select: { first_name: true, last_name: true, company_name: true } },
              },
            },
          },
          orderBy: { due_date: 'asc' },
          take: 3,
        }),
        // D16 (2026-07-21) — the internal expiry sweep is retired; estimates no longer
        // auto-archive on a lapsed valid_until, so surfacing them here as "at risk" no longer
        // matches reality (nothing is about to happen to them). Removed rather than left
        // querying a signal nothing acts on.
        // Oldest unassigned lead (for meta text)
        prisma.lead.findMany({
          where: { ...orgWhere, lead_assignees: { none: {} }, status: { in: OPEN_LEAD_STATUSES } },
          select: {
            id: true,
            lead_number: true,
            created_at: true,
            customer: { select: { first_name: true, last_name: true, company_name: true } },
          },
          orderBy: { created_at: 'asc' },
          take: 1,
        }),
        // Unassigned lead count
        prisma.lead.count({
          where: { ...orgWhere, lead_assignees: { none: {} }, status: { in: OPEN_LEAD_STATUSES } },
        }),
        // Jobs past their scheduled start time (still SCHEDULED — no visit has begun, or
        // deriveJobStatusFromVisits would already read IN_PROGRESS).
        //
        // S8 repoint (D14): forward-looking. Resolves each candidate's WINNING live visit with
        // the same `resolveNextJobVisit` the retired mirror was written from, then keeps only the
        // ones whose winning visit is actually overdue today — this is deliberately a fresh
        // resolution, not "does any live visit fall in this window": a job holding both an
        // unactioned 9am trip and a booked-next-week trip now resolves to the FUTURE one (matching
        // what a live mirror write would say), and correctly drops off this list. See the PR body.
        //
        // The WHERE below is a widening pre-filter only (candidates must have SOME overdue live
        // visit), not the final answer — ATTENTION_OVERFETCH + the post-processing resolve/filter/
        // sort below is what decides membership, because Prisma cannot ORDER BY a to-many
        // relation's resolved value.
        prisma.job.findMany({
          where: {
            ...orgWhere,
            status: 'SCHEDULED',
            AND: [
              { visits: { some: { status: { in: [...LIVE_VISIT_STATUSES] }, scheduled_at: { gte: todayStart, lt: now } } } },
            ],
          },
          select: {
            id: true,
            job_number: true,
            scope_notes: true,
            // S8 (D6): crew through the trips. Unfiltered by date/status beyond LIVE — the full
            // live-visit set is what resolveNextJobVisit needs to resolve correctly below.
            visits: {
              where: { status: { in: [...LIVE_VISIT_STATUSES] } },
              select: {
                scheduled_at: true,
                scheduled_end: true,
                created_at: true,
                assignees: { select: { user: { select: { first_name: true, last_name: true } } } },
              },
            },
          },
          take: ATTENTION_OVERFETCH,
        }),
        // Leads requiring a visit, none booked.
        //
        // Multi-visit D22a: flipped off the retired REQUESTED placeholder onto the ABSENCE of a
        // live visit. REQUESTED encoded "this lead needs a visit booked", which is not a state of
        // a visit at all - it is the absence of one - and it cannot survive multi-visit, because
        // with several live visits per lead there is no single row for the placeholder to be.
        //
        // The `none` phrasing is what makes this correct under multi-visit rather than merely
        // equivalent: a lead holding three trips, one of them cancelled, must NOT appear here.
        prisma.lead.findMany({
          where: {
            ...orgWhere,
            ...NO_LIVE_VISIT_WHERE,
          },
          select: {
            id: true,
            lead_number: true,
            service_request: true,
            customer: { select: { first_name: true, last_name: true, company_name: true } },
          },
          orderBy: { created_at: 'asc' },
          take: 2,
        }),
      ]),

      // 12. Schedule jobs for selected date (optionally filtered by assignee's department).
      //
      // S8 repoint (D14): backward-looking — "does this job have a trip today", the visit set,
      // not the (to-be-dropped) scheduled_start/scheduled_end mirror. The window clause and the
      // department clause are BOTH `visits.some.*` shapes now, so both are pushed into `AND` as
      // separate array entries rather than either being a bare `where.visits` key — a second bare
      // assignment here would silently overwrite the first (house rule: composed under AND, never
      // assigned onto `where.visits`). Free bug fix: same D16-collapse under-count as sites #1/#2
      // applies to any COMPLETED job showing on this strip.
      prisma.job.findMany({
        where: {
          ...orgWhere,
          status: { not: 'CANCELLED' },
          AND: [
            visitInWindowClause({ gte: scheduleDateStart, lte: scheduleDateEnd }),
            // S8 (D6): crew through the trips. `Job.assignees` went with `job_assignees`, and a
            // conditional spread is exempt from excess-property checking, so tsc cannot see a
            // dead relation name here. The sibling clause on query 12b below looks identical but
            // is on `prisma.visit`, where `assignees` is the real relation - do not "tidy" the
            // two into one shape. Every dashboard query shares one Promise.all, so getting this
            // wrong 500s the whole endpoint rather than just this strip.
            ...(scheduleDepartmentId
              ? [{ visits: { some: { assignees: { some: { user: { department_id: scheduleDepartmentId } } } } } }]
              : []),
          ],
        },
        select: {
          id: true,
          job_number: true,
          status: true,
          scope_notes: true,
          // scheduled_start/scheduled_end are no longer read directly here (S8 retires that
          // mirror) — scheduleJobsWithVisitTimes below derives them per job from the matching
          // trip(s) in `visits`, keyed on scheduled_at/scheduled_end so a job with an unrelated
          // trip on a DIFFERENT day never lends this widget the wrong time.
          visits: {
            select: {
              scheduled_at: true,
              scheduled_end: true,
              status: true,
              assignees: { select: { user: { select: { id: true, first_name: true, last_name: true, avatar_path: true } } } },
            },
          },
          customer: { select: { first_name: true, last_name: true, company_name: true } },
          service_location: { select: { address_line1: true, city: true } },
        },
        // No DB-level orderBy: buildScheduleLanes re-sorts each lane by the DERIVED
        // scheduled_start below, so the fetch order here doesn't matter.
      }),

      // 12b. Scheduled walkthroughs for selected date (optionally filtered by
      // performer's department).
      //
      // Walkthrough-as-entity redesign, PR-B2: repointed onto the Walkthrough row itself.
      // SCHEDULED/COMPLETED are shown (parity with the /schedule calendar: a walkthrough
      // completed today still belongs on today's board); REQUESTED (never scheduled) and
      // CANCELLED are excluded. This is an explicit status filter rather than the old
      // "null-out-the-timestamp" trick — cancelling a visit now KEEPS its scheduled_at as
      // history (D15 needs it to resolve "the most recent visit that happened"), so an
      // implicit not-null check on scheduled_at would wrongly keep a cancelled visit visible.
      prisma.visit.findMany({
        where: {
          ...orgWhere,
          // LEAD visits only. `visits` holds a job's trips too from multi-visit S2 (D5: exactly
          // one parent, so a job visit carries no lead at all), and its migration backfills one
          // per already-scheduled job - without this predicate every such job turns up in the
          // walkthrough lane of the dashboard. Job visits get their own lane in S6.
          lead_id: { not: null },
          scheduled_at: { gte: scheduleDateStart, lte: scheduleDateEnd },
          status: { in: ['SCHEDULED', 'COMPLETED'] },
          ...(scheduleDepartmentId
            ? { assignees: { some: { user: { department_id: scheduleDepartmentId } } } }
            : {}),
        },
        select: {
          id: true,
          scheduled_at: true,
          duration_minutes: true,
          completed_at: true,
          lead: {
            select: {
              id: true,
              lead_number: true,
              service_request: true,
              customer: { select: { first_name: true, last_name: true, company_name: true } },
              service_location: { select: { address_line1: true, city: true } },
            },
          },
          assignees: {
            select: { user: { select: { id: true, first_name: true, last_name: true, avatar_path: true } } },
          },
        },
        orderBy: { scheduled_at: 'asc' },
      }),

      // 13. Activity feed (recent timeline events — org-scoped via Task 22)
      prisma.timelineEvent.findMany({
        where: { ...orgWhere },
        select: {
          id: true,
          event_type: true,
          description: true,
          entity_type: true,
          entity_id: true,
          created_at: true,
          creator: { select: { first_name: true, last_name: true } },
        },
        orderBy: { created_at: 'desc' },
        take: 20,
      }),

      // 14a. Revenue chart — collected per month (join invoices for org filter;
      // exclude voided payments + DEPOSIT-invoice payments, matching KPI queries #4/#5/#15)
      prisma.$queryRaw<Array<{ month: Date; collected: string | null }>>`
        SELECT DATE_TRUNC('month', p.paid_at) AS month, SUM(p.amount) AS collected
        FROM payments p
        JOIN invoices i ON p.invoice_id = i.id
        WHERE p.paid_at >= ${chartPeriodStart}
          AND p.voided_at IS NULL
          AND i.kind != 'DEPOSIT'
          AND i.organization_id = ${orgWhere.organization_id}::uuid
        GROUP BY 1
        ORDER BY 1
      `,

      // 14b. Revenue chart — invoiced per month
      prisma.$queryRaw<Array<{ month: Date; invoiced: string | null }>>`
        SELECT DATE_TRUNC('month', created_at) AS month, SUM(total_amount) AS invoiced
        FROM invoices
        WHERE created_at >= ${chartPeriodStart}
          AND status != 'VOIDED'
          AND kind != 'DEPOSIT'
          AND organization_id = ${orgWhere.organization_id}::uuid
        GROUP BY 1
        ORDER BY 1
      `,

      // 15. Collected today (org-scoped via invoice relation; same voided/DEPOSIT
      // exclusions as #4)
      prisma.payment.aggregate({
        where: {
          paid_at: { gte: todayStart, lte: todayEnd },
          voided_at: null,
          invoice: { ...orgWhere, kind: { not: 'DEPOSIT' } },
        },
        _sum: { amount: true },
      }),

      // 16. Jobs completed today (for collected_today.jobs_done)
      prisma.job.count({
        where: { ...orgWhere, status: 'COMPLETED', completed_at: { gte: todayStart, lte: todayEnd } },
      }),

      // 17. Avg ticket — mean paid-invoice total over the last 30 days (excludes DEPOSIT, #496)
      prisma.invoice.aggregate({
        where: { ...orgWhere, kind: { not: 'DEPOSIT' }, status: 'PAID', updated_at: { gte: thirtyDaysAgo } },
        _avg: { total_amount: true },
      }),

      // 18. Jobs completed this week
      prisma.job.count({
        where: { ...orgWhere, status: 'COMPLETED', completed_at: { gte: weekStart, lte: weekEnd } },
      }),

      // 19. Jobs scheduled this week. S8 repoint (D14): same backward-looking repoint as #1/#2/#12.
      prisma.job.count({
        where: {
          ...orgWhere,
          status: { not: 'CANCELLED' },
          AND: [visitInWindowClause({ gte: weekStart, lte: weekEnd })],
        },
      }),

      // 20. Deposits awaiting — unpaid deposit-kind invoices
      prisma.invoice.aggregate({
        where: { ...orgWhere, kind: 'DEPOSIT', status: { in: ['SENT', 'PARTIAL'] } },
        _sum: { amount_due: true },
        _count: { _all: true },
      }),

      // 21. Jobs by status (operational backlog, excluding cancelled)
      prisma.job.groupBy({
        by: ['status'],
        where: { ...orgWhere, status: { not: 'CANCELLED' } },
        _count: { _all: true },
      }),

      // 22. Tech scoreboard — completed jobs + invoiced revenue per crew member (M2M).
      // A job shared by multiple crew counts toward each (scheduler-assignment-redesign).
      prisma.job.findMany({
        where: { ...orgWhere, status: 'COMPLETED' },
        select: { amount_invoiced: true, visits: { select: { assignees: { select: { user_id: true } } } } },
      }),

      // 23. Coming up — next upcoming scheduled jobs.
      //
      // S8 repoint (D14(ii)): genuinely forward-looking — "when is this job next happening" — so
      // this resolves each candidate's next live visit with `resolveNextJobVisit`, the same
      // function the retired mirror was written from, rather than reading the mirror itself.
      // The WHERE is a widening pre-filter (candidate must have SOME visit `resolveNextJobVisit`
      // could call "upcoming" — mirroring its own `(scheduled_end ?? scheduled_at) > now` rule so
      // an in-progress-by-schedule trip whose window straddles `now` isn't missed); the
      // post-processing resolve/filter/sort/slice below (COMING_UP_OVERFETCH) is what actually
      // decides the final 6, because Prisma cannot ORDER BY a to-many relation's resolved value.
      prisma.job.findMany({
        where: {
          ...orgWhere,
          status: { notIn: ['CANCELLED', 'COMPLETED'] },
          AND: [
            {
              visits: {
                some: {
                  status: { in: [...LIVE_VISIT_STATUSES] },
                  OR: [{ scheduled_end: { gt: now } }, { scheduled_end: null, scheduled_at: { gt: now } }],
                },
              },
            },
          ],
        },
        select: {
          id: true,
          customer: { select: { first_name: true, last_name: true, company_name: true } },
          service_location: { select: { address_line1: true, city: true } },
          // Unfiltered by time beyond LIVE — resolveNextJobVisit needs the full live-visit set.
          visits: {
            where: { status: { in: [...LIVE_VISIT_STATUSES] } },
            select: { scheduled_at: true, scheduled_end: true, created_at: true },
          },
        },
        take: COMING_UP_OVERFETCH,
      }),

      // 24. Pipeline — leads created MTD (funnel head)
      prisma.lead.count({ where: { ...orgWhere, created_at: { gte: monthStart } } }),

      // 25. Pipeline — estimates issued MTD (non-draft)
      prisma.estimate.aggregate({
        where: { ...orgWhere, created_at: { gte: monthStart }, status: { notIn: ['DRAFT', ESTIMATE_STATUS.ARCHIVED] } },
        _sum: { total_amount: true },
      }),

      // 26. Pipeline — estimates approved MTD
      prisma.estimate.aggregate({
        where: { ...orgWhere, status: ESTIMATE_STATUS.WON, approved_at: { gte: monthStart } },
        _sum: { total_amount: true },
      }),

      // 27. Pipeline — deposit invoices raised MTD
      prisma.invoice.aggregate({
        where: { ...orgWhere, kind: 'DEPOSIT', created_at: { gte: monthStart } },
        _sum: { total_amount: true },
      }),

      // 28. Pipeline — jobs completed MTD (invoiced value)
      prisma.job.aggregate({
        where: { ...orgWhere, status: 'COMPLETED', completed_at: { gte: monthStart } },
        _sum: { amount_invoiced: true },
      }),

      // 29. Lead sources — lead counts grouped by Lead.source (exclude null)
      prisma.lead.groupBy({
        by: ['source'],
        where: { ...orgWhere, source: { not: null } },
        _count: { _all: true },
      }),

      // 30. Completed jobs that carry an estimate — feeds both Lead-Sources revenue
      //     (job → estimate → lead.source) and Revenue-by-Job-Type (estimate.job_type).
      prisma.job.findMany({
        where: { ...orgWhere, status: 'COMPLETED', estimate_id: { not: null } },
        select: {
          amount_invoiced: true,
          estimate: { select: { job_type: true, lead: { select: { source: true } } } },
        },
      }),

      // 31. Dispatch scoreboard — completed jobs grouped by dispatcher (exclude null)
      prisma.job.groupBy({
        by: ['dispatcher_id'],
        where: { ...orgWhere, status: 'COMPLETED', dispatcher_id: { not: null } },
        _sum: { amount_invoiced: true },
        _count: { _all: true },
      }),

      // 32. Recurring — active service plans (count + contract price / term for MRR)
      prisma.servicePlan.findMany({
        where: { ...orgWhere, status: 'ACTIVE' },
        select: { contract_price: true, start_date: true, end_date: true },
      }),
    ]);

    // Tech scoreboard (M2M crews): aggregate completed jobs + invoiced revenue per crew
    // member. A job shared by N crew counts toward each (scheduler-assignment-redesign).
    const techAgg = new Map<string, { revenue: number; jobs: number }>();
    for (const j of techScoreboardJobs) {
      const rev = Number(j.amount_invoiced ?? 0);
      for (const userId of jobCrewIds(j)) {
        const cur = techAgg.get(userId) ?? { revenue: 0, jobs: 0 };
        cur.revenue += rev;
        cur.jobs += 1;
        techAgg.set(userId, cur);
      }
    }
    // Resolve names for both the tech crews and the dispatchers in one lookup.
    const dispatcherIds = dispatchScoreboardGroups
      .map((g) => g.dispatcher_id)
      .filter((id): id is string => id !== null);
    const scoreboardUserIds = [...new Set([...techAgg.keys(), ...dispatcherIds])];
    const scoreboardUsers = scoreboardUserIds.length
      ? await prisma.user.findMany({
          where: { id: { in: scoreboardUserIds } },
          select: { id: true, first_name: true, last_name: true },
        })
      : [];
    const techUserById = new Map(scoreboardUsers.map((u) => [u.id, u]));

    // ── Post-processing ──────────────────────────────────────────────────

    // Jobs Today KPI
    const jobsByStatus: Record<string, number> = {};
    for (const g of jobsTodayGroups) {
      jobsByStatus[g.status as string] = g._count._all;
    }
    const jobsTodayTotal = Object.values(jobsByStatus).reduce((a, b) => a + b, 0);

    // Revenue MTD KPI
    const invoicedMtd = Number(invoicedMtdAgg._sum.total_amount ?? 0);
    const collectedMtd = Number(collectedMtdAgg._sum.amount ?? 0);
    const collectedLastMonth = Number(collectedLastMonthAgg._sum.amount ?? 0);
    const revenueTarget = revenueTargetSetting ? Number(revenueTargetSetting.value) : 55000;
    const pctOfGoal = revenueTarget > 0 ? Math.round((collectedMtd / revenueTarget) * 100) : 0;
    const vsLastMonthPct =
      collectedLastMonth > 0
        ? Math.round(((collectedMtd - collectedLastMonth) / collectedLastMonth) * 100)
        : 0;

    // AR Aging KPI
    let arCurrent = 0;
    let arOver30 = 0;
    let arOver60 = 0;
    for (const inv of openInvoicesForAr) {
      const amt = Number(inv.amount_due);
      if (!inv.due_date) {
        arCurrent += amt;
      } else {
        const daysPastDue = Math.floor((now.getTime() - inv.due_date.getTime()) / 86_400_000);
        if (daysPastDue <= 0) arCurrent += amt;
        else if (daysPastDue < 60) arOver30 += amt;
        else arOver60 += amt;
      }
    }
    const arTotal = arCurrent + arOver30 + arOver60;

    // Open Leads KPI
    const leadsOpenCount = openLeads.length;
    const unassignedLeadsCount = openLeads.filter((l) => l.lead_assignees.length === 0).length;

    // Close Rate KPI
    const crCurrentMap: Record<string, number> = {};
    for (const g of closeRateCurrent) crCurrentMap[g.status as string] = g._count._all;
    const crPriorMap: Record<string, number> = {};
    for (const g of closeRatePrior) crPriorMap[g.status as string] = g._count._all;

    const wonCurrent = crCurrentMap['WON'] ?? 0;
    const lostCurrent = crCurrentMap['LOST'] ?? 0;
    const totalCurrent = wonCurrent + lostCurrent;
    const closeRateValue = totalCurrent > 0 ? Math.round((wonCurrent / totalCurrent) * 100) : 0;

    const wonPrior = crPriorMap['WON'] ?? 0;
    const lostPrior = crPriorMap['LOST'] ?? 0;
    const totalPrior = wonPrior + lostPrior;
    const closeRatePriorValue = totalPrior > 0 ? Math.round((wonPrior / totalPrior) * 100) : 0;
    const closeRateDelta = closeRateValue - closeRatePriorValue;

    // Needs Attention items
    const [
      overdueInvoices,
      oldestUnassignedLeads,
      unassignedLeadCount,
      jobsPastStartCandidates,
      walkthroughsNeeded,
    ] = attentionData;

    // S8 repoint (D14): resolve each candidate's winning live visit (`resolveNextJobVisit` — the
    // same function the retired mirror was written from) and keep only the ones whose winning
    // visit is actually overdue today. See the query comment (site 3) for why this is a fresh
    // resolution rather than "any live visit in window".
    const jobsPastStart = jobsPastStartCandidates
      .map((job) => ({ job, visit: resolveNextJobVisit(job.visits, now) }))
      .filter(
        (x): x is { job: (typeof jobsPastStartCandidates)[number]; visit: NonNullable<typeof x.visit> & { scheduled_at: Date } } =>
          x.visit !== null && x.visit.scheduled_at !== null && x.visit.scheduled_at >= todayStart && x.visit.scheduled_at < now,
      )
      .sort((a, b) => a.visit.scheduled_at.getTime() - b.visit.scheduled_at.getTime())
      .slice(0, 3);

    type AttentionItem = {
      id: string;
      type: string;
      severity: 'danger' | 'warning' | 'info';
      title: string;
      meta: string;
      badge: string;
      link: string;
    };

    const attentionItems: AttentionItem[] = [];

    for (const inv of overdueInvoices) {
      const daysPast = Math.floor((now.getTime() - inv.due_date!.getTime()) / 86_400_000);
      const c = inv.job?.customer;
      const name = c?.company_name || `${c?.first_name ?? ''} ${c?.last_name ?? ''}`.trim() || 'Customer';
      attentionItems.push({
        id: inv.id,
        type: 'overdue_invoice',
        severity: 'danger',
        title: `Invoice ${inv.invoice_number} overdue`,
        meta: `${name} · ${daysPast} days past due · $${Math.round(Number(inv.amount_due)).toLocaleString()}`,
        badge: `${daysPast}d`,
        link: `/invoices/${inv.id}`,
      });
    }

    if (unassignedLeadCount > 0) {
      const oldest = oldestUnassignedLeads[0];
      const oldestName = oldest
        ? ([oldest.customer.first_name, oldest.customer.last_name].filter(Boolean).join(' ') || oldest.customer.company_name || 'Customer')
        : '';
      const oldestDays = oldest
        ? Math.floor((now.getTime() - oldest.created_at.getTime()) / 86_400_000)
        : 0;
      attentionItems.push({
        id: 'unassigned-leads',
        type: 'unassigned_leads',
        severity: 'info',
        title: `${unassignedLeadCount} lead${unassignedLeadCount !== 1 ? 's' : ''} unassigned`,
        meta: oldest
          ? `Oldest: ${oldestName} · ${oldestDays} day${oldestDays !== 1 ? 's' : ''} without assignment`
          : 'Assign leads to your sales team',
        badge: String(unassignedLeadCount),
        link: '/leads',
      });
    }

    for (const { job, visit } of jobsPastStart) {
      // S8 repoint (D14): the winning visit's OWN instant, not the retired mirror.
      const minutesPast = Math.floor((now.getTime() - visit.scheduled_at.getTime()) / 60_000);
      // Crew: the winning visit's own assignees (not a union across every trip the job has) —
      // the lead tech for THIS overdue trip, exactly as this attention item is about.
      const crewLead = visit.assignees[0]?.user;
      const techName = crewLead
        ? `${crewLead.first_name} ${crewLead.last_name}`
        : 'Unassigned';
      const badge = minutesPast >= 60 ? `${Math.floor(minutesPast / 60)}h` : `${minutesPast}m`;
      attentionItems.push({
        id: job.id,
        type: 'job_past_start',
        severity: 'danger',
        title: `${job.job_number} past start time`,
        meta: `${techName} · started ${badge} ago, no check-in`,
        badge,
        link: `/jobs/${job.id}`,
      });
    }

    for (const lead of walkthroughsNeeded) {
      const name = [lead.customer.first_name, lead.customer.last_name].filter(Boolean).join(' ') || lead.customer.company_name || 'Customer';
      attentionItems.push({
        id: lead.id,
        type: 'walkthrough_needed',
        severity: 'warning',
        title: 'Walkthrough not scheduled',
        meta: `${lead.lead_number} — ${name} · requires walk before estimate`,
        badge: 'Req.',
        link: `/leads/${lead.id}`,
      });
    }

    // Sort: danger → warning → info
    const severityOrder: Record<string, number> = { danger: 0, warning: 1, info: 2 };
    attentionItems.sort((a, b) => severityOrder[a.severity] - severityOrder[b.severity]);

    // Schedule — group jobs + walkthroughs into per-tech lanes (pure builder)
    //
    // Walkthrough-as-entity redesign, PR-B2: `id` here MUST stay the LEAD's id, not the
    // Walkthrough row's — the frontend widget (TodaySchedule.tsx) navigates to `/leads/${id}`
    // for a `entity: 'walkthrough'` row, and that wire contract does not change in this PR.
    // S8 repoint (D14): derive each job's DISPLAYED time from the trip(s) that actually fall
    // inside the viewed day, not the retired scheduled_start/scheduled_end mirror. Crew fan-out
    // (S8/D6, already shipped) is untouched — buildScheduleLanes still unions assignees across
    // `visits` exactly as before; only the two fields it reads for the time badge are recomputed.
    const scheduleJobsWithVisitTimes = scheduleJobs.map((job) => {
      const inWindow = job.visits
        .filter(
          (v) =>
            v.scheduled_at !== null &&
            v.scheduled_at >= scheduleDateStart &&
            v.scheduled_at <= scheduleDateEnd &&
            v.status !== 'CANCELLED',
        )
        .sort((a, b) => a.scheduled_at!.getTime() - b.scheduled_at!.getTime());
      const winner = inWindow[0] ?? null;
      return {
        ...job,
        scheduled_start: winner?.scheduled_at ?? null,
        scheduled_end: winner?.scheduled_end ?? null,
      };
    });

    const scheduleOut = buildScheduleLanes(
      scheduleJobsWithVisitTimes,
      // `lead` became nullable when visits gained a job parent (multi-visit D5). Query 12b is
      // lead-scoped, so a job visit cannot reach here - and the filter below is the belt to that
      // braces: a lead-less row must be skipped, never dereferenced. Dropping the predicate
      // above used to mean a TypeError that 500'd the WHOLE dashboard for any org holding a job
      // scheduled on the viewed day. Job visits get their own lane in S6.
      scheduleWalkthroughs.flatMap((w) => (w.lead === null ? [] : [{
        id: w.lead.id,
        lead_number: w.lead.lead_number,
        service_request: w.lead.service_request,
        // Non-null: query 12b filters scheduled_at within the day.
        walkthrough_scheduled_at: w.scheduled_at!,
        walkthrough_duration_minutes: w.duration_minutes,
        walkthrough_completed_at: w.completed_at,
        customer: w.lead.customer,
        service_location: w.lead.service_location,
        performers: w.assignees.map((p) => p.user),
      }])),
    );

    // Today's Schedule avatars — `avatar_path` already rode along on SchedulePerson/ScheduleLane
    // (the jobs/walkthroughs queries above already select it on assignees/performers), so this
    // is one batched sign over the lanes buildScheduleLanes already built, not a second query.
    const scheduleAvatarSigned = await signAvatarPaths(scheduleOut.map((lane) => lane.avatar_path));
    const scheduleOutWithAvatars = scheduleOut.map(({ avatar_path, ...lane }) => ({
      ...lane,
      avatar_url: resolveAvatarUrl(avatar_path, scheduleAvatarSigned),
    }));

    // Activity feed.
    //
    // Issue 04 - this query carries NO entity filter, so once a task's timeline outlives the task
    // it can land here pointing at a row that is gone. `entity_deleted` says so and `entity_label`
    // carries the snapshot taken at delete time, which is the only identity the task has left.
    // A client must not offer navigation to an `entity_deleted` event.
    const deletedTaskLabels = await resolveDeletedTaskLabels(orgWhere.organization_id, activityFeed);
    const activity = activityFeed.map((e) => {
      // Keyed on the pair, not the id alone: the feed carries every entity type, and a
      // lookup by id alone would mislabel a same-id event of another type.
      const deletedLabel = e.entity_type === 'TASK' ? deletedTaskLabels.get(e.entity_id) ?? null : null;
      return {
        id: e.id,
        event_type: e.event_type,
        description: e.description,
        entity_type: e.entity_type,
        entity_id: e.entity_id,
        entity_deleted: deletedLabel !== null,
        entity_label: deletedLabel,
        created_at: e.created_at.toISOString(),
        creator_name: e.creator ? `${e.creator.first_name} ${e.creator.last_name}` : null,
      };
    });

    // Revenue chart — build month slots and fill
    const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    const chartMonths: Array<{ month: string; invoiced: number; collected: number; is_current: boolean }> = [];

    for (let i = 0; i < monthCount; i++) {
      const d = new Date(now.getFullYear(), now.getMonth() - monthCount + 1 + i, 1);
      chartMonths.push({
        month: MONTH_NAMES[d.getMonth()],
        invoiced: 0,
        collected: 0,
        is_current: d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth(),
      });
    }

    for (const row of chartPaymentsRaw) {
      const d = new Date(row.month);
      const idx =
        (d.getFullYear() - chartPeriodStart.getFullYear()) * 12 +
        (d.getMonth() - chartPeriodStart.getMonth());
      if (idx >= 0 && idx < chartMonths.length) {
        chartMonths[idx].collected = Number(row.collected ?? 0);
      }
    }

    for (const row of chartInvoicesRaw) {
      const d = new Date(row.month);
      const idx =
        (d.getFullYear() - chartPeriodStart.getFullYear()) * 12 +
        (d.getMonth() - chartPeriodStart.getMonth());
      if (idx >= 0 && idx < chartMonths.length) {
        chartMonths[idx].invoiced = Number(row.invoiced ?? 0);
      }
    }

    // ── Redesigned-dashboard metrics (net-new) ───────────────────────────
    const collectedToday = Number(collectedTodayAgg._sum.amount ?? 0);
    const avgTicket = Math.round(Number(avgTicketAgg._avg.total_amount ?? 0));
    const depositsAwaitingAmount = Number(depositsAwaitingAgg._sum.amount_due ?? 0);
    const depositsAwaitingCount = depositsAwaitingAgg._count._all;

    const jobsByStatusSlices = buildJobsByStatus(
      jobsByStatusGroups.map((g) => ({ status: g.status as string, count: g._count._all })),
    );

    const techScoreboard = buildScoreboard(
      [...techAgg.entries()].map(([user_id, agg]) => {
        const u = techUserById.get(user_id);
        const name = u ? `${u.first_name} ${u.last_name}`.trim() : 'Unassigned';
        return { user_id, name, revenue: agg.revenue, jobs: agg.jobs };
      }),
      5,
    );

    // S8 repoint (D14(ii)): resolve each candidate's next live visit (`resolveNextJobVisit`) —
    // see the query comment (site 6) for why the WHERE alone isn't the final answer.
    const comingUpResolved = comingUpRows
      .map((j) => ({ j, visit: resolveNextJobVisit(j.visits, now) }))
      .filter(
        (x): x is { j: (typeof comingUpRows)[number]; visit: NonNullable<typeof x.visit> & { scheduled_at: Date } } =>
          x.visit !== null &&
          x.visit.scheduled_at !== null &&
          (x.visit.scheduled_end ?? x.visit.scheduled_at).getTime() > now.getTime(),
      )
      .sort((a, b) => a.visit.scheduled_at.getTime() - b.visit.scheduled_at.getTime())
      .slice(0, 6);

    const comingUp = buildComingUp(
      comingUpResolved.map(({ j, visit }) => {
        const c = j.customer;
        const title = c.company_name || [c.first_name, c.last_name].filter(Boolean).join(' ') || 'Customer';
        const address = j.service_location
          ? `${j.service_location.address_line1}, ${j.service_location.city}`
          : '';
        return { id: j.id, scheduled_start: visit.scheduled_at, title, address };
      }),
      now,
    );

    const pipeline = buildPipeline({
      leads: leadsMtdCount,
      estimatesAmount: Number(estimatesMtdAgg._sum.total_amount ?? 0),
      approvedAmount: Number(approvedMtdAgg._sum.total_amount ?? 0),
      depositAmount: Number(depositMtdAgg._sum.total_amount ?? 0),
      jobAmount: Number(jobAmountMtdAgg._sum.amount_invoiced ?? 0),
      invoicedAmount: invoicedMtd,
      paidAmount: collectedMtd,
    });

    // ── Demo widgets ─────────────────────────────────────────────────────
    // Lead-source revenue (job → estimate → lead.source) and revenue-by-job-type
    // (estimate.job_type) are both derived from the completed-jobs-with-estimate set.
    const leadSourceRevenue = new Map<string, number>();
    const jobTypeRevenue = new Map<string, number>();
    for (const j of completedJobsWithEstimate) {
      const rev = Number(j.amount_invoiced ?? 0);
      const src = j.estimate?.lead?.source;
      if (src) leadSourceRevenue.set(src, (leadSourceRevenue.get(src) ?? 0) + rev);
      const jt = j.estimate?.job_type;
      if (jt) jobTypeRevenue.set(jt, (jobTypeRevenue.get(jt) ?? 0) + rev);
    }

    const leadSources = buildLeadSources(
      leadSourceCountGroups
        .filter((g): g is typeof g & { source: string } => g.source !== null)
        .map((g) => ({
          source: g.source,
          leads: g._count._all,
          revenue: leadSourceRevenue.get(g.source) ?? 0,
        })),
    );

    const revenueByJobType = buildRevenueByJobType(
      [...jobTypeRevenue.entries()].map(([job_type, revenue]) => ({ job_type, revenue })),
    );

    const dispatchScoreboard = buildScoreboard(
      dispatchScoreboardGroups.map((g) => {
        const u = g.dispatcher_id ? techUserById.get(g.dispatcher_id) : undefined;
        const name = u ? `${u.first_name} ${u.last_name}`.trim() : 'Unassigned';
        return {
          user_id: g.dispatcher_id,
          name,
          revenue: Number(g._sum.amount_invoiced ?? 0),
          jobs: g._count._all,
        };
      }),
      5,
    );

    // MRR = contract_price normalized to a monthly figure over the plan's term.
    const MONTH_MS = 30 * 86_400_000;
    let mrrSum = 0;
    for (const p of activePlans) {
      // Open-ended plans (no end date) have no finite term to normalize against — they still count
      // as active, but contribute no term-based MRR until a cadence-based MRR model lands
      // (see project-fluid-cadence-recurrence). Guards the now-nullable end_date.
      if (p.end_date === null) continue;
      const termMs = p.end_date.getTime() - p.start_date.getTime();
      const months = termMs > 0 ? termMs / MONTH_MS : 1;
      mrrSum += Number(p.contract_price) / Math.max(months, 1);
    }
    const recurring = buildRecurring({ active_plans: activePlans.length, mrr: mrrSum });

    // ── Response ─────────────────────────────────────────────────────────
    res.json({
      kpis: {
        jobs_today: {
          total: jobsTodayTotal,
          scheduled: jobsByStatus['SCHEDULED'] ?? 0,
          // Spec B1 (Task 5): the groupBy already returns every non-cancelled status; only this
          // S4 (D17): EN_ROUTE/ON_SITE retired from JobStatus, so there is nothing left to fold.
          in_progress: jobsByStatus['IN_PROGRESS'] ?? 0,
          completed: jobsByStatus['COMPLETED'] ?? 0,
          vs_yesterday: jobsTodayTotal - jobsYesterdayCount,
        },
        revenue_mtd: {
          invoiced: invoicedMtd,
          collected: collectedMtd,
          target: revenueTarget,
          pct_of_goal: pctOfGoal,
          vs_last_month_pct: vsLastMonthPct,
        },
        ar: {
          total: arTotal,
          current: arCurrent,
          over_30: arOver30,
          over_60: arOver60,
        },
        leads_open: {
          count: leadsOpenCount,
          unassigned: unassignedLeadsCount,
        },
        close_rate: {
          rate: closeRateValue,
          won: wonCurrent,
          lost: lostCurrent,
          vs_last_period_pp: closeRateDelta,
        },
        // ── net-new KPIs ──
        collected_today: { amount: collectedToday, jobs_done: jobsDoneTodayCount },
        // Active service plans → monthly-normalized MRR (null when no active plans).
        recurring,
        avg_ticket: { amount: avgTicket, period_days: 30 },
        jobs_week: { completed: jobsWeekCompletedCount, scheduled: jobsWeekScheduledCount },
        deposits_awaiting: { amount: depositsAwaitingAmount, count: depositsAwaitingCount },
      },
      revenue_chart: chartMonths,
      needs_attention: attentionItems,
      schedule_today: scheduleOutWithAvatars,
      pipeline,
      tech_scoreboard: techScoreboard,
      dispatch_scoreboard: dispatchScoreboard,
      lead_sources: leadSources,
      jobs_by_status: jobsByStatusSlices,
      revenue_by_job_type: revenueByJobType,
      coming_up: comingUp,
      activity,
      generated_at: now.toISOString(),
    });
  } catch (err) {
    logger.error('Error fetching dashboard:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
}
