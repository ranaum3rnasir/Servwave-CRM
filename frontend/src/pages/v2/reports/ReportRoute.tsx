import { Suspense, lazy } from 'react';
import { useParams } from 'react-router-dom';

import { canShowReport, findReport } from '@/lib/reports/report-catalog';
import { useIsDemoOrg } from '@/lib/useIsDemoOrg';
import { useHasFeature } from '@/lib/entitlements';

import { Spinner } from '@/ui-kit/components/ui/spinner';

import { reportComponents } from './reports-registry';
import ReportStubPage from './ReportStubPage';

const GenericReport = lazy(() => import('./reports/GenericReport'));

/**
 * Dispatcher for `/v2/reports/:slug`. The three-step resolution is the legacy
 * one, in the same order, because the order IS the gate:
 *
 *   1. ORG GATE FIRST. `canShowReport` runs before anything is chosen, so a
 *      real (non-demo) org that types the URL of a not-yet-backed report gets
 *      the stub instead of fabricated numbers. The landing grid already hides
 *      those cards; this defends direct navigation, which is the only path
 *      that can reach them. `notInPlan` splits the two stub copies: by the
 *      time `canShowReport` is false with a report in hand, demo and
 *      missing-report are already ruled out, so the only remaining reason is
 *      the declared-feature check.
 *   2. a bespoke report component from this module's registry;
 *   3. otherwise the generic data-rich report for any known catalog slug;
 *   4. otherwise the "not found" stub.
 *
 * `useIsDemoOrg` and `useHasFeature` are the app's own hooks, imported.
 * Re-deriving either would put a second definition of "is this org entitled"
 * in the tree, and the failure mode is a report that shows one thing in the
 * grid and another on its own page.
 */
export default function ReportRoute() {
  const { slug } = useParams<{ slug: string }>();
  const isDemoOrg = useIsDemoOrg();
  const hasFeature = useHasFeature();

  const report = findReport(slug);
  if (report && !canShowReport(report, isDemoOrg, hasFeature)) {
    const notInPlan = !!report.feature && !hasFeature(report.feature);
    return <ReportStubPage reason={notInPlan ? 'not-in-plan' : 'coming-soon'} />;
  }

  const Built = slug ? reportComponents[slug] : undefined;

  const fallback = (
    <div className="text-muted-foreground flex items-center gap-2 p-6 text-sm">
      <Spinner />
      Loading report...
    </div>
  );

  if (Built) {
    return (
      <Suspense fallback={fallback}>
        <Built />
      </Suspense>
    );
  }

  if (report) {
    return (
      <Suspense fallback={fallback}>
        <GenericReport report={report} />
      </Suspense>
    );
  }

  return <ReportStubPage />;
}
