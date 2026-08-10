import { Request, Response } from 'express';
import type { LeadStatus } from '@prisma/client';
import { prisma } from '../lib/prisma';
import { logger } from '../lib/logger';
import { tenantWhere } from '../lib/tenant';
import { arOutstandingWhere } from '../lib/ar';
import { ESTIMATE_STATUS } from '../constants/estimateStatus';
import { signAvatarPaths, resolveAvatarUrl } from '../lib/avatar';
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
      // 1. Jobs today grouped by status
      prisma.job.groupBy({
        by: ['status'],
        where: {
          ...orgWhere,
          scheduled_start: { gte: todayStart, lte: todayEnd },
          status: { not: 'CANCELLED' },
        },
        _count: { _all: true },
      }),

      // 2. Jobs yesterday count (for delta)
      prisma.job.count({
        where: {
          ...orgWhere,
          scheduled_start: { gte: yesterdayStart, lte: yesterdayEnd },
          status: { not: 'CANCELLED' },
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
        select: { id: true, lead_assignees: { select: { user_id: true } }, contacted_at: true },
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
        // Jobs past their scheduled start time (still SCHEDULED)
        prisma.job.findMany({
          where: {
            ...orgWhere,
            status: 'SCHEDULED',
            scheduled_start: { gte: todayStart, lt: now },
          },
          select: {
            id: true,
            job_number: true,
            scheduled_start: true,
            scope_notes: true,
            assignees: { select: { user: { select: { first_name: true, last_name: true } } } },
          },
          orderBy: { scheduled_start: 'asc' },
          take: 3,
        }),
        // Leads requiring walkthrough, not yet scheduled.
        //
        // Walkthrough-as-entity redesign, PR-B2: repointed onto Walkthrough.status = REQUESTED,
        // the same collapsed bucket definition used everywhere else (lead.filters.ts's
        // walkthrough_status=needs_scheduling facet). This is a real, intentional behavior
        // shift: the old query additionally required lead status NEW/CONTACTED, which the
        // bucket collapse deliberately drops (D11/D12 — a cancelled visit with nothing
        // rebooked, or a REQUESTED visit on a lead that has moved past CONTACTED, both belong
        // in "needs scheduling"). The attention list can surface more leads than before.
        prisma.lead.findMany({
          where: {
            ...orgWhere,
            walkthroughs: { some: { status: 'REQUESTED' } },
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

      // 12. Schedule jobs for selected date (optionally filtered by assignee's department)
      prisma.job.findMany({
        where: {
          ...orgWhere,
          scheduled_start: { gte: scheduleDateStart, lte: scheduleDateEnd },
          status: { not: 'CANCELLED' },
          ...(scheduleDepartmentId
            ? { assignees: { some: { user: { department_id: scheduleDepartmentId } } } }
            : {}),
        },
        select: {
          id: true,
          job_number: true,
          status: true,
          scope_notes: true,
          scheduled_start: true,
          scheduled_end: true,
          assignees: { select: { user: { select: { id: true, first_name: true, last_name: true, avatar_path: true } } } },
          customer: { select: { first_name: true, last_name: true, company_name: true } },
          service_location: { select: { address_line1: true, city: true } },
        },
        orderBy: { scheduled_start: 'asc' },
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
      prisma.walkthrough.findMany({
        where: {
          ...orgWhere,
          scheduled_at: { gte: scheduleDateStart, lte: scheduleDateEnd },
          status: { in: ['SCHEDULED', 'COMPLETED'] },
          ...(scheduleDepartmentId
            ? { performers: { some: { user: { department_id: scheduleDepartmentId } } } }
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
          performers: {
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

      // 19. Jobs scheduled this week
      prisma.job.count({
        where: {
          ...orgWhere,
          scheduled_start: { gte: weekStart, lte: weekEnd },
          status: { not: 'CANCELLED' },
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
        select: { amount_invoiced: true, assignees: { select: { user_id: true } } },
      }),

      // 23. Coming up — next upcoming scheduled jobs
      prisma.job.findMany({
        where: {
          ...orgWhere,
          scheduled_start: { gt: now },
          status: { notIn: ['CANCELLED', 'COMPLETED'] },
        },
        select: {
          id: true,
          scheduled_start: true,
          customer: { select: { first_name: true, last_name: true, company_name: true } },
          service_location: { select: { address_line1: true, city: true } },
        },
        orderBy: { scheduled_start: 'asc' },
        take: 6,
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
      for (const a of j.assignees) {
        const cur = techAgg.get(a.user_id) ?? { revenue: 0, jobs: 0 };
        cur.revenue += rev;
        cur.jobs += 1;
        techAgg.set(a.user_id, cur);
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
    const needFollowupCount = openLeads.filter((l) => !l.contacted_at).length;

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
      jobsPastStart,
      walkthroughsNeeded,
    ] = attentionData;

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

    for (const job of jobsPastStart) {
      const minutesPast = Math.floor((now.getTime() - job.scheduled_start!.getTime()) / 60_000);
      // Crew job: surface the first assignee (the board's lead tech).
      const crewLead = job.assignees[0]?.user;
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
    const scheduleOut = buildScheduleLanes(
      scheduleJobs,
      scheduleWalkthroughs.map((w) => ({
        id: w.lead.id,
        lead_number: w.lead.lead_number,
        service_request: w.lead.service_request,
        // Non-null: query 12b filters scheduled_at within the day.
        walkthrough_scheduled_at: w.scheduled_at!,
        walkthrough_duration_minutes: w.duration_minutes,
        walkthrough_completed_at: w.completed_at,
        customer: w.lead.customer,
        service_location: w.lead.service_location,
        performers: w.performers.map((p) => p.user),
      })),
    );

    // Today's Schedule avatars — `avatar_path` already rode along on SchedulePerson/ScheduleLane
    // (the jobs/walkthroughs queries above already select it on assignees/performers), so this
    // is one batched sign over the lanes buildScheduleLanes already built, not a second query.
    const scheduleAvatarSigned = await signAvatarPaths(scheduleOut.map((lane) => lane.avatar_path));
    const scheduleOutWithAvatars = scheduleOut.map(({ avatar_path, ...lane }) => ({
      ...lane,
      avatar_url: resolveAvatarUrl(avatar_path, scheduleAvatarSigned),
    }));

    // Activity feed
    const activity = activityFeed.map((e) => ({
      id: e.id,
      event_type: e.event_type,
      description: e.description,
      entity_type: e.entity_type,
      entity_id: e.entity_id,
      created_at: e.created_at.toISOString(),
      creator_name: e.creator ? `${e.creator.first_name} ${e.creator.last_name}` : null,
    }));

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

    const comingUp = buildComingUp(
      comingUpRows.map((j) => {
        const c = j.customer;
        const title = c.company_name || [c.first_name, c.last_name].filter(Boolean).join(' ') || 'Customer';
        const address = j.service_location
          ? `${j.service_location.address_line1}, ${j.service_location.city}`
          : '';
        return { id: j.id, scheduled_start: j.scheduled_start, title, address };
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
          // readout dropped EN_ROUTE/ON_SITE. Fold them in, same as job.controller.ts's KPIs.
          in_progress: (jobsByStatus['IN_PROGRESS'] ?? 0) + (jobsByStatus['EN_ROUTE'] ?? 0) + (jobsByStatus['ON_SITE'] ?? 0),
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
          need_followup_today: needFollowupCount,
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
