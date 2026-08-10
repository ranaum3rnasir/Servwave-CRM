import { lazy, Suspense } from 'react';
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import * as Sentry from '@sentry/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import ProtectedRoute from '@/components/ProtectedRoute';
import DemoOnlyRoute from '@/components/DemoOnlyRoute';
import RequireCommunicationCreate from '@/components/RequireCommunicationCreate';
import RequireFeature from '@/components/RequireFeature';
import AppLayout from '@/components/layout/AppLayout';
import LoginPage from '@/pages/LoginPage';
import AuthCallbackPage from '@/pages/AuthCallbackPage';
const AcceptInvitePage = lazy(() => import('@/pages/AcceptInvitePage'));
import { initAuthListener } from '@/lib/auth-listener';
import { Toaster } from '@/components/ui/toaster';
import { Toaster as KitToaster } from '@/ui-kit/components/ui/sonner';
import { TooltipProvider as KitTooltipProvider } from '@/ui-kit/components/ui/tooltip';
import { V2FlagRedirect } from '@/pages/v2/V2FlagRedirect';
import { v2Routes } from '@/pages/v2/V2Routes';
import { AbilityProvider } from '@/contexts/AbilityContext';
import { ErrorBoundary } from '@/components/ErrorBoundary';
import { useAuthStore } from '@/stores/auth.store';

initAuthListener();

const HomeRoute = lazy(() => import('@/components/layout/HomeRoute'));
const CustomersPage = lazy(() => import('@/pages/CustomersPage'));
const LeadsPage = lazy(() => import('@/pages/LeadsPage'));
const EstimatesPage = lazy(() => import('@/pages/EstimatesPage'));
const JobsPage = lazy(() => import('@/pages/JobsPage'));
const JobFormPage = lazy(() => import('@/pages/JobFormPage'));
const JobDetailPage = lazy(() => import('@/pages/JobDetailPage'));
const SchedulePage = lazy(() => import('@/pages/SchedulePage'));
const InvoicesPage = lazy(() => import('@/pages/InvoicesPage'));
const ServicePlansPage = lazy(() => import('@/pages/service-plans/ServicePlansPage'));
const WorkflowsHome = lazy(() => import('@/pages/workflows/WorkflowsHome'));
const WorkflowBuilderPage = lazy(() => import('@/pages/workflows/WorkflowBuilderPage'));
const ReportsPage = lazy(() => import('@/pages/ReportsPage'));
const ReportRoute = lazy(() => import('@/pages/reports/ReportRoute'));
const MarketingAnalyticsPage = lazy(() => import('@/pages/MarketingAnalyticsPage'));
const UsersPage = lazy(() => import('@/pages/UsersPage'));
const UpgradePage = lazy(() => import('@/pages/UpgradePage'));

// Organization Settings module
const SettingsLayout = lazy(() => import('@/pages/settings/SettingsLayout'));
const CompanyProfilePage = lazy(() => import('@/pages/settings/CompanyProfilePage'));
const BrandingPage = lazy(() => import('@/pages/settings/BrandingPage'));
const LocationsPage = lazy(() => import('@/pages/settings/LocationsPage'));
const UsersTeamsPage = lazy(() => import('@/pages/settings/UsersTeamsPage'));
const RolesPage = lazy(() => import('@/pages/settings/RolesPage'));
const SecurityPage = lazy(() => import('@/pages/settings/SecurityPage'));
const PaymentsListsPage = lazy(() => import('@/pages/settings/PaymentsListsPage'));
const JobSubStatusesPage = lazy(() => import('@/pages/settings/JobSubStatusesPage'));
const LeadStatusesPage = lazy(() => import('@/pages/settings/LeadStatusesPage'));
const TaxRatesPage = lazy(() => import('@/pages/settings/TaxRatesPage'));
const PhoneSmsPage = lazy(() => import('@/pages/settings/PhoneSmsPage'));
const PhoneNumbersSettingsPage = lazy(() => import('@/pages/settings/PhoneNumbersSettingsPage'));
const EmailSenderPage = lazy(() => import('@/pages/settings/EmailSenderPage'));
const InventorySettingsPage = lazy(() => import('@/pages/settings/InventorySettingsPage'));
const CustomFieldsPage = lazy(() => import('@/pages/settings/CustomFieldsPage'));
const MyProfilePage = lazy(() => import('@/pages/settings/MyProfilePage'));
const CustomerDetailPage = lazy(() => import('@/pages/CustomerDetailPage'));
const CustomerFormPage = lazy(() => import('@/pages/CustomerFormPage'));
const LeadDetailPage = lazy(() => import('@/pages/LeadDetailPage'));
const LeadFormPage = lazy(() => import('@/pages/LeadFormPage'));
const NewEstimateRedirect = lazy(() => import('@/pages/NewEstimateRedirect'));
const EstimateWorkspacePage = lazy(() => import('@/pages/EstimateWorkspacePage'));
const PublicEstimatePage = lazy(() => import('@/pages/PublicEstimatePage'));
const InvoiceDetailPage = lazy(() => import('@/pages/InvoiceDetailPage'));
const StandaloneInvoiceFormPage = lazy(() => import('@/pages/StandaloneInvoiceFormPage'));
const PublicInvoicePage = lazy(() => import('@/pages/PublicInvoicePage'));
const StatementPage = lazy(() => import('@/pages/StatementPage'));

// Inventory module (Emanuel port)
const InventoryPage = lazy(() => import('@/pages/inventory/InventoryPage'));
const InventoryPriceBookPage = lazy(() => import('@/pages/inventory/PriceBookPage'));
const PurchaseOrdersPage = lazy(() => import('@/pages/inventory/PurchaseOrdersPage'));
const VendorsPage = lazy(() => import('@/pages/inventory/VendorsPage'));

// Communication module (Emanuel port)
const PhonePage = lazy(() => import('@/pages/communication/PhonePage'));
const WhatsAppPage = lazy(() => import('@/pages/communication/WhatsAppPage'));
const InboxPage = lazy(() => import('@/pages/communication/InboxPage'));
const TextPage = lazy(() => import('@/pages/communication/TextPage'));

// Dedicated `/phone` tab (Task A3) — the sole CTM softphone device-owner
// surface, distinct from the Communication module's `/communication/phone`
// integration hub above (hence the distinct name — both files are named
// PhonePage.tsx, in different directories).
const PhoneTabPage = lazy(() => import('@/pages/phone/PhonePage'));

// Tasks module
const TasksHubPage = lazy(() => import('@/pages/tasks/TasksHubPage'));


const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: 1,
      staleTime: 5 * 60 * 1000,
      refetchOnWindowFocus: false,
    },
  },
});

function PageLoader() {
  return (
    <div className="flex items-center justify-center py-12">
      <div className="text-text-secondary">Loading...</div>
    </div>
  );
}

// Wraps React Router's <Routes> so Sentry names navigation transactions by the
// matched route pattern (e.g. "/jobs/:id") instead of the raw URL.
const SentryRoutes = Sentry.withSentryReactRouterV7Routing(Routes);

function AppRoutes() {
  return (
    <Suspense fallback={<PageLoader />}>
      <SentryRoutes>
        <Route path="/login" element={<LoginPage />} />
        <Route path="/auth/callback" element={<AuthCallbackPage />} />
        <Route path="/accept-invite" element={<AcceptInvitePage />} />
        <Route path="/p/estimates/:id" element={<PublicEstimatePage />} />
        <Route path="/p/invoices/:id" element={<PublicInvoicePage />} />

        {/* Dedicated `/phone` tab (Task A3) — the sole CTM softphone
            device-owner surface. Deliberately OUTSIDE AppLayout: it's a
            standalone tab a user keeps open alongside the app, not a page
            embedded in the app chrome. Any authenticated
            role may reach it (no allowedRoles) — access is gated purely by
            RequireCommunicationCreate (org comm access + the role-agnostic
            `create Communication` CASL grant), never a hardcoded role list. */}
        <Route element={<ProtectedRoute />}>
          <Route element={<RequireCommunicationCreate />}>
            <Route path="/phone" element={<PhoneTabPage />} />
          </Route>
        </Route>

        {/* Upgrade page — reachable by every authenticated role (including
            TECHNICIAN). The 402 interceptor is global, so a technician who
            trips a 402 must be able to land here without being bounced by a
            role-restricted ProtectedRoute; mirrors the /phone precedent above. */}
        <Route element={<ProtectedRoute />}>
          <Route element={<AppLayout />}>
            <Route path="/upgrade" element={<UpgradePage />} />
          </Route>
        </Route>

        {/* The whole app — technicians included since Spec A. What each role can reach is
            decided by CASL nav filtering and per-route sub-gates, not by this list. */}
        <Route element={<ProtectedRoute allowedRoles={['ADMIN', 'SALES', 'DISPATCHER', 'TECHNICIAN']} />}>
          <Route element={<AppLayout />}>
            <Route path="/" element={<HomeRoute />} />
            <Route path="/customers" element={<CustomersPage />} />
            <Route path="/customers/new" element={<CustomerFormPage />} />
            <Route path="/customers/:id/edit" element={<CustomerFormPage />} />
            <Route path="/customers/:id" element={<CustomerDetailPage />} />
            <Route path="/customers/:customerId/statement" element={<StatementPage />} />
            <Route element={<RequireFeature feature="leads" />}>
              <Route path="/leads" element={<LeadsPage />} />
              <Route path="/leads/new" element={<LeadFormPage />} />
              <Route path="/leads/:id/edit" element={<LeadFormPage />} />
              <Route path="/leads/:id" element={<LeadDetailPage />} />
            </Route>
            <Route path="/estimates" element={<EstimatesPage />} />
            {/* Create=edit: `/estimates/new` eagerly creates an empty DRAFT (anchored by a
                lead_id/customer_id/job_id query param) and redirects to the workspace below.
                There is no separate edit page - the workspace IS the editor. */}
            <Route path="/estimates/new" element={<NewEstimateRedirect />} />
            <Route path="/estimates/:id" element={<EstimateWorkspacePage />} />
            <Route path="/jobs" element={<JobsPage />} />
            <Route path="/jobs/new" element={<JobFormPage />} />
            <Route path="/jobs/:id" element={<JobDetailPage />} />
            <Route path="/jobs/:jobId/statement" element={<StatementPage />} />
            <Route path="/tasks" element={<TasksHubPage />} />
            <Route path="/schedule" element={<SchedulePage />} />
            <Route path="/invoices" element={<InvoicesPage />} />
            {/* Standalone invoice authoring — ADMIN + DISPATCHER only (matches the
                backend 403 + `create Invoice` grant; technicians invoice only via
                their own job). Must precede /invoices/:id. */}
            <Route element={<ProtectedRoute allowedRoles={['ADMIN', 'DISPATCHER']} fallback />}>
              <Route path="/invoices/new" element={<StandaloneInvoiceFormPage />} />
            </Route>
            <Route path="/invoices/:id" element={<InvoiceDetailPage />} />
            <Route element={<RequireFeature feature="service_plans" />}>
              <Route path="/service-plans" element={<ServicePlansPage />} />
            </Route>
            {/* Automations (Workflow Builder) — Admin + Dispatcher only (backend
                403s Sales/Tech on /api/workflows/*; grants live in defaultGrants.ts). */}
            <Route element={<ProtectedRoute allowedRoles={['ADMIN', 'DISPATCHER']} fallback />}>
              <Route element={<RequireFeature feature="automations" />}>
                <Route path="/automations" element={<WorkflowsHome />} />
                <Route path="/automations/new" element={<WorkflowBuilderPage />} />
                <Route path="/automations/:id" element={<WorkflowBuilderPage />} />
                {/* Old deep links to the legacy single-action editor land on the
                    new builder for the same id, instead of 404-ing to "/".
                    relative="path" is required here: all parent routes are
                    pathless (AppLayout/ProtectedRoute), so with the default
                    relative="route" a single ".." strips the whole
                    "automations/:id/edit" leaf and resolves to "/" instead
                    of "/automations/:id". */}
                <Route
                  path="/automations/:id/edit"
                  element={<Navigate to=".." relative="path" replace />}
                />
              </Route>
            </Route>
            {/* Reports — Admin + Dispatcher only (backend 403s Sales on /api/reports/*).
                Coarse route gate stays role-based; in-page/nav gating uses CASL. */}
            <Route element={<ProtectedRoute allowedRoles={['ADMIN', 'DISPATCHER']} fallback />}>
              <Route path="/reports" element={<ReportsPage />} />
              <Route path="/reports/:slug" element={<ReportRoute />} />
            </Route>
            {/* Marketing — demo-only (mock page, no /api/marketing backend). Real
                orgs are redirected to the dashboard; demo orgs get the full view.
                `navKey` lets the guard honour the registry's demoOnlyUnlockOrgIds
                allowlist, so an allowlisted real org reaches the page too. */}
            <Route element={<DemoOnlyRoute navKey="marketing" />}>
              <Route path="/marketing" element={<MarketingAnalyticsPage />} />
            </Route>

            {/* Inventory module (Emanuel port) */}
            <Route element={<RequireFeature feature="inventory" />}>
              <Route path="/inventory" element={<InventoryPage />} />
              <Route path="/inventory/staging" element={<InventoryPage />} />
              <Route path="/inventory/assets" element={<InventoryPage />} />
              {/* P5 — deep-linkable view tabs (low-stock list + movements action log). */}
              <Route path="/inventory/low-stock" element={<InventoryPage />} />
              <Route path="/inventory/activity" element={<InventoryPage />} />
              <Route path="/inventory/logistic-orders" element={<InventoryPage />} />
              {/* Stock-approvals is feature-parked (P0 §C / QA-901) — no dead deep-links. */}
              <Route path="/inventory/approvals" element={<Navigate to="/inventory" replace />} />
              <Route path="/inventory/price-book" element={<InventoryPriceBookPage />} />
              <Route path="/inventory/purchase-orders" element={<PurchaseOrdersPage />} />
              <Route path="/inventory/vendors" element={<VendorsPage />} />
            </Route>

            {/* Communication module (Emanuel port). Two entitlements, not one:
                the CTM channels stay on `phone` (Pro+), email is its own
                `email` key (every plan) - see nav-registry + the backend
                catalog. Gating email on `phone` would put a feature every plan
                includes behind a Pro-only master switch. */}
            <Route element={<RequireFeature feature="phone" />}>
              <Route path="/communication/phone" element={<PhonePage />} />
              <Route path="/communication/phone/:tab" element={<PhonePage />} />
              <Route path="/communication/text" element={<TextPage />} />
              <Route path="/communication/text/:tab" element={<TextPage />} />
              {/* WhatsApp has no connected Business account for a real org, so
                  the sidebar locks the row. A nav lock without a route guard is
                  theatre - the URL still resolves - hence DemoOnlyRoute. */}
              <Route element={<DemoOnlyRoute />}>
                <Route path="/communication/whatsapp" element={<WhatsAppPage />} />
              </Route>
            </Route>
            <Route element={<RequireFeature feature="email" />}>
              <Route path="/communication/inbox" element={<InboxPage />} />
            </Route>

            <Route element={<ProtectedRoute allowedRoles={['ADMIN']} fallback />}>
              <Route path="/users" element={<UsersPage />} />
            </Route>

            {/* Organization Settings module — CASL-filtered per menu item (not ADMIN-gated) */}
            <Route path="/settings" element={<SettingsLayout />}>
              <Route index element={<Navigate to="company" replace />} />
              <Route path="company" element={<CompanyProfilePage />} />
              <Route path="branding" element={<BrandingPage />} />
              <Route path="locations" element={<LocationsPage />} />
              <Route path="users" element={<UsersTeamsPage />} />
              <Route path="roles" element={<RolesPage />} />
              <Route path="security" element={<SecurityPage />} />
              <Route path="payments" element={<PaymentsListsPage />} />
              <Route path="job-sub-statuses" element={<JobSubStatusesPage />} />
              <Route path="lead-statuses" element={<LeadStatusesPage />} />
              <Route path="tax-rates" element={<TaxRatesPage />} />
              <Route path="phone-sms" element={<PhoneSmsPage />} />
              <Route path="phone-numbers" element={<PhoneNumbersSettingsPage />} />
              <Route path="email-sender" element={<EmailSenderPage />} />
              <Route path="inventory" element={<InventorySettingsPage />} />
              <Route path="custom-fields" element={<CustomFieldsPage />} />
              <Route path="profile" element={<MyProfilePage />} />
            </Route>
          </Route>
        </Route>

        {/* v2 presentation layer (CRM UI kit). Additive: every route below is
            new, and no route above changes. See pages/v2/uiV2.ts. */}
        {v2Routes()}
        <Route path="*" element={<Navigate to="/" replace />} />
      </SentryRoutes>
    </Suspense>
  );
}

function AppWithAbility() {
  const ability = useAuthStore((s) => s.ability);
  return (
    <AbilityProvider ability={ability}>
      {/* One TooltipProvider for the whole app so every kit <Tooltip> shares a
          single delay timer - sweeping across a toolbar does not re-pay the
          open delay on each icon. Harmless for the legacy pages, which do not
          use the kit's tooltip. */}
      <KitTooltipProvider delayDuration={320}>
        <BrowserRouter>
          <ErrorBoundary>
            {/* Inside the boundary: it runs on every navigation, and a throw
                here would otherwise take the whole app down unguarded. */}
            <V2FlagRedirect />
            <AppRoutes />
          </ErrorBoundary>
          <Toaster />
          {/* The kit's sonner toaster, mounted alongside the app's own. Two
              separate systems: legacy pages keep calling the app's toast, v2
              pages call sonner's. Neither intercepts the other.

              The hotkey is a SENTINEL, not an empty array. sonner registers its
              document keydown listener unconditionally - no prop removes it -
              and tests `hotkey.every(k => event[k] || event.code === k)`.
              `[].every(...)` is vacuously TRUE, so an empty array makes every
              keystroke an expand-and-focus press, which is worse than the
              default it was meant to disable. A string that is neither a
              KeyboardEvent property nor a valid event.code can never match,
              which is as close to off as the API allows. The default, Alt+T,
              would otherwise pull focus into the toast list from any legacy
              page. */}
          <KitToaster hotkey={['__sonner_hotkey_disabled__']} />
        </BrowserRouter>
      </KitTooltipProvider>
    </AbilityProvider>
  );
}

export default function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <AppWithAbility />
    </QueryClientProvider>
  );
}
