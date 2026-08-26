import { useMemo, useState } from 'react';
import { Plus } from 'lucide-react';

import { useServicePlans, describeRecurrence, type ServicePlan } from '@/lib/api/service-plans';

import { EmptyState } from '@/ui-kit/components/data/emptyState';
import { StatCard, StatCardGroup } from '@/ui-kit/components/data/statCard';
import { PageHeader } from '@/ui-kit/components/layout/pageHeader';
import { Button } from '@/ui-kit/components/ui/button';
import { Card } from '@/ui-kit/components/ui/card';
import { Spinner } from '@/ui-kit/components/ui/spinner';
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '@/ui-kit/components/ui/table';

import { useRecordVisit } from '../pageBreadcrumbs';
import { StatusChip } from '../_shared/statusChip';
import { TabPanel, TabStrip } from '../_shared/tabs';
import { PlanBuilderDialog } from '../_shared/planBuilderDialog';
import { PlanDetailSheet } from './components/planDetailSheet';
import { customerName, date, money, property } from '../_shared/planShared';

/**
 * Overview: five read-only KPI tiles over the same `plans` array the other two
 * tabs read.
 *
 * The arithmetic is the legacy page's, asymmetries included: `Active` counts
 * the server-derived `effective_status` while `Drafts` counts the raw `status`,
 * and `Visits remaining` sums every plan regardless of either. Collapsing them
 * onto one field would change what the tiles say.
 *
 * The tiles are not clickable, exactly as today - there is no filter on this
 * page for a KPI to apply - so they carry no `onClick` and the kit renders them
 * as divs rather than buttons.
 */
function OverviewTab({ plans, isLoading }: { plans: ServicePlan[]; isLoading: boolean }) {
  const k = useMemo(() => {
    let active = 0, drafts = 0, revenue = 0, remaining = 0;
    for (const p of plans) {
      if (p.effective_status === 'ACTIVE') { active++; revenue += Number(p.contract_price); }
      if (p.status === 'DRAFT') drafts++;
      remaining += p.visits_remaining ?? 0;
    }
    return { active, drafts, revenue, remaining, total: plans.length };
  }, [plans]);

  return (
    <StatCardGroup className="xl:grid-cols-5">
      <StatCard label="Total plans" value={k.total} loading={isLoading} />
      <StatCard label="Active" value={k.active} loading={isLoading} />
      <StatCard label="Drafts" value={k.drafts} loading={isLoading} />
      <StatCard label="Contract revenue (active)" value={money(k.revenue)} loading={isLoading} />
      <StatCard label="Visits remaining" value={k.remaining} loading={isLoading} />
    </StatCardGroup>
  );
}

/**
 * The plans list.
 *
 * Plain kit table primitives, not the kit's DataTable: this list has no
 * sorting, no search, no column menu and no pagination today, and DataTable
 * brings a footer of paging controls with it. Adding them would be a feature,
 * not a restyle.
 */
function PlansTab({ plans, onOpen }: { plans: ServicePlan[]; onOpen: (id: string) => void }) {
  if (plans.length === 0) return <EmptyState title="No service plans yet." />;
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Plan</TableHead>
          <TableHead>Customer</TableHead>
          <TableHead>Property</TableHead>
          <TableHead>Cadence</TableHead>
          <TableHead>Next due</TableHead>
          <TableHead>Remaining</TableHead>
          <TableHead>Status</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {plans.map((p) => (
          <TableRow key={p.id} className="cursor-pointer" onClick={() => onOpen(p.id)}>
            <TableCell className="font-medium">{p.service_plan_number}</TableCell>
            <TableCell>{customerName(p)}</TableCell>
            <TableCell>{property(p)}</TableCell>
            <TableCell>{describeRecurrence(p)}</TableCell>
            <TableCell>
              {/* `emphasized` is server-derived (due soon / overdue). The legacy
                  table said this with the app table's `tone="highlight"`; the
                  kit's cell has no tone, so the emphasis goes on the value
                  itself rather than as an appearance override on the cell. */}
              {p.emphasized
                ? <span className="text-destructive font-medium">{date(p.next_due)}</span>
                : date(p.next_due)}
            </TableCell>
            {/* `??`, not `||`: a plan with 0 visits left reads "0", never "Ongoing". */}
            <TableCell>{p.visits_remaining ?? 'Ongoing'}</TableCell>
            <TableCell><StatusChip domain="servicePlan" status={p.effective_status} /></TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

/**
 * Completed visits across every plan, flattened.
 *
 * The row key is `${plan.id}-${visit.scheduled_date}`, which collides if one
 * plan completes two visits on the same scheduled date. That is today's key and
 * it is reproduced rather than fixed - see the gap ledger.
 */
function HistoryTab({ plans }: { plans: ServicePlan[] }) {
  const rows = useMemo(
    () =>
      plans.flatMap((p) =>
        (p.visits ?? [])
          .filter((v) => v.status === 'COMPLETED')
          .map((v) => ({
            id: `${p.id}-${v.scheduled_date}`,
            plan: p.service_plan_number,
            customer: customerName(p),
            when: v.completed_at ?? v.scheduled_date,
          })),
      ),
    [plans],
  );

  if (rows.length === 0) return <EmptyState title="No completed visits yet." />;
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Plan</TableHead>
          <TableHead>Customer</TableHead>
          <TableHead>Completed</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((r) => (
          <TableRow key={r.id}>
            <TableCell className="font-medium">{r.plan}</TableCell>
            <TableCell>{r.customer}</TableCell>
            <TableCell>{date(r.when)}</TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

/**
 * /v2/service-plans - the service plans hub on the CRM UI kit.
 *
 * One `useServicePlans()` query feeds all three tabs, so switching tabs never
 * refetches. The active tab is local state starting at `plans` (NOT `overview`)
 * with no `?tab=` param, exactly as today.
 *
 * There is no permission gating on this page and there was none before: every
 * control renders for anyone who reaches the route, and enforcement is entirely
 * server-side. Adding a CASL gate here would change who can do what, which is
 * outside a restyle - it is recorded in the gap ledger instead.
 */
export default function ServicePlansPage() {
  useRecordVisit('service-plans');
  const { data: plans = [], isLoading } = useServicePlans();
  const [builderOpen, setBuilderOpen] = useState(false);
  const [detailId, setDetailId] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState('plans');

  return (
    <div>
      <PageHeader
        title="Service Plans"
        actions={
          <Button onClick={() => setBuilderOpen(true)}>
            <Plus />
            New Plan
          </Button>
        }
      />

      <Card>
        <TabStrip
          value={activeTab}
          onValueChange={setActiveTab}
          tabs={[
            { value: 'overview', label: 'Overview' },
            { value: 'plans', label: 'Plans' },
            { value: 'history', label: 'History' },
          ]}
        />

        <TabPanel value="overview" activeValue={activeTab}>
          <div className="p-4">
            <OverviewTab plans={plans} isLoading={isLoading} />
          </div>
        </TabPanel>

        <TabPanel value="plans" activeValue={activeTab}>
          {isLoading ? (
            <div className="flex items-center justify-center py-12">
              <Spinner size="lg" />
            </div>
          ) : (
            <PlansTab plans={plans} onOpen={setDetailId} />
          )}
        </TabPanel>

        <TabPanel value="history" activeValue={activeTab}>
          <HistoryTab plans={plans} />
        </TabPanel>
      </Card>

      <PlanBuilderDialog open={builderOpen} onOpenChange={setBuilderOpen} />
      <PlanDetailSheet id={detailId} onClose={() => setDetailId(null)} />
    </div>
  );
}
