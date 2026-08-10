import { Fragment, useEffect, type MouseEvent } from 'react';
import { Link, Outlet, useLocation, useNavigate } from 'react-router-dom';
import {
  Bell, HelpCircle, Mail, MessageCircle, MessageSquare, Phone, Sparkles,
} from 'lucide-react';

import { AppShell } from '@/ui-kit/components/layout/appShell';
import {
  Sidebar, SidebarGroupLabel, SidebarItem, SidebarNav,
} from '@/ui-kit/components/layout/nav/sidebar';
import {
  TopBar, TopBarAction, TopBarActions, TopBarBrand, TopBarDivider, TopBarPill,
  TopBarSearch, TopBarUser,
} from '@/ui-kit/components/layout/nav/topBar';
import { TooltipProvider } from '@/ui-kit/components/ui/tooltip';
import { initialsFor, tintFor } from '@/ui-kit/components/ui/avatar';

import { ServWaveMark } from '@/components/brand/ServWaveMark';
import { AiCenterModal } from '@/components/ai-center/AiCenterModal';
import CopilotProvider from '@/components/copilot/CopilotProvider';
import { OfficeSoftphoneWarmup } from '@/components/communication/phone/OfficeSoftphoneWarmup';

import { useAppAbility } from '@/contexts/AbilityContext';
import { useAuthStore } from '@/stores/auth.store';
import { useSettingsGuard } from '@/stores/settingsGuard.store';
import { useAiCenterStore } from '@/stores/aiCenterStore';
import { useCopilotStore } from '@/stores/copilotStore';
import { useIsDemoOrg } from '@/lib/useIsDemoOrg';
import { useOrganization } from '@/lib/api/organization';
import { useUnreadCount } from '@/lib/api/notifications';
import { setOrgFormattingPrefs } from '@/lib/org-format';
import {
  PLAN_LABELS, requiredPlanFor, useEntitlementsReady, useOrgFeatures,
} from '@/lib/entitlements';
import {
  getDestination, hasNavFeature, isDemoDestUnlockedForOrg, resolveNavHref,
  visibleNavChildren, type NavAccess, type NavDestination,
} from '@/components/layout/nav-registry';
import { useNavLayout } from '@/components/layout/useNavLayout';

/**
 * Sections for the v2 sidebar.
 *
 * The nav registry is a FLAT list - the legacy sidebar renders it as one column
 * of shortcuts - but the kit's shell groups destinations under headings, and the
 * first heading shares its row with the collapse control. So the grouping lives
 * here, keyed by registry key, rather than being invented in the registry (which
 * the legacy sidebar also reads and which this branch must not touch).
 *
 * Order inside a section still comes from the user's own layout, so a reorder
 * made in the legacy sidebar is honoured here. A key the user has pinned that no
 * section claims falls into the last one, so nothing can silently disappear.
 */
const NAV_SECTIONS: { section: string; keys: readonly string[] }[] = [
  { section: 'Workspace', keys: ['dashboard', 'schedule', 'tasks', 'leads', 'jobs', 'clients'] },
  { section: 'Billing', keys: ['estimates', 'invoices', 'service-plans'] },
  {
    section: 'Operations',
    keys: ['automations', 'pricebook', 'billing', 'reports', 'inventory', 'communication', 'marketing'],
  },
];

/**
 * The v2 chrome: the CRM UI kit's shell, wired to the real app.
 *
 * Replaces `AppLayout` for `/v2/*` ONLY. The legacy layout is untouched, so
 * every legacy route keeps rendering exactly as it does today.
 *
 * What is replaced is chrome and only chrome - AppLayout's `Sidebar` and
 * `Header`. Everything else it mounts is behaviour that a page underneath it
 * depends on, and dropping any of it would silently remove a feature from every
 * v2 page rather than restyle it:
 *
 *   CopilotProvider         Servy, the docked copilot, and its keyboard path
 *   AiCenterModal           the AI farm modal, opened from the action bar
 *   OfficeSoftphoneWarmup   warms the WebRTC device so click-to-call is instant
 *   useSettingsGuard        blocks navigation away from a dirty settings form
 *   setOrgFormattingPrefs   hydrates org currency / date formatting (#126)
 *
 * so all five are carried across verbatim.
 */
export default function V2AppLayout() {
  const ability = useAppAbility();
  const navigate = useNavigate();
  const location = useLocation();
  const requestLeave = useSettingsGuard((s) => s.requestLeave);

  const user = useAuthStore((s) => s.user);
  const orgId = user?.organization_id;
  const orgFeatures = useOrgFeatures();
  const entitlementsReady = useEntitlementsReady();
  const isDemoOrg = useIsDemoOrg();
  const { keys } = useNavLayout();

  const openAiCenter = useAiCenterStore((s) => s.openModal);
  const openCopilot = useCopilotStore((s) => s.setOpen);
  const { data: unread } = useUnreadCount();

  // Hydrate org-aware currency/date formatting once the organization loads, so
  // the central formatters honour the org's configured currency + date_format.
  // Carried from AppLayout: a v2 page that formats money would otherwise fall
  // back to the default currency with no visible error.
  const { data: organization } = useOrganization();
  useEffect(() => {
    if (!organization) return;
    setOrgFormattingPrefs({
      currency: organization.currency,
      dateFormat: organization.date_format,
    });
  }, [organization]);

  /** A dirty settings form gets to intercept the navigation, exactly as in the
      legacy sidebar - the guard is app behaviour, not chrome. */
  const guardNavigation = (href: string) => (event: MouseEvent) => {
    if (!useSettingsGuard.getState().isDirty) return;
    event.preventDefault();
    requestLeave(() => navigate(href));
  };

  const isActive = (href: string) =>
    href === '/'
      ? location.pathname === '/'
      : location.pathname === href || location.pathname.startsWith(`${href}/`);

  /** Locked on either axis: an entitlement the org lacks, or a demo-only
      surface in a real org. Gated on entitlementsReady so a cold cache cannot
      grey out every module on first paint - same reasoning as useFeature
      failing open. */
  const access: NavAccess = {
    can: (action, subject) => ability.can(action, subject),
    orgFeatures,
    entitlementsReady,
    isDemoOrg,
  };

  const lockOf = (dest: NavDestination) => {
    const featureLocked = !hasNavFeature(dest.feature, access);
    const demoLocked = !!dest.demoOnly && !isDemoOrg && !isDemoDestUnlockedForOrg(dest, orgId);
    if (!featureLocked && !demoLocked) return null;
    // Only a PLAN lock may name a plan. A demo-only row that the org is fully
    // entitled to (WhatsApp on a Pro org) would otherwise be badged "Pro" and
    // read as an upsell for something already paid for.
    if (!featureLocked) return 'Soon';
    return PLAN_LABELS[requiredPlanFor(dest.feature) ?? ''] ?? 'Soon';
  };

  // Resolve the user's pinned keys to destinations, CASL-filter, then bucket
  // them by section keeping the user's order. Anything unclaimed lands in the
  // last section rather than vanishing.
  const visible = keys
    .map((key) => ({ key, dest: getDestination(key) }))
    .filter((x): x is { key: string; dest: NavDestination } =>
      !!x.dest && ability.can(x.dest.action, x.dest.subject));

  const claimed = new Set(NAV_SECTIONS.flatMap((s) => s.keys));
  const sections = NAV_SECTIONS.map((section, index) => ({
    section: section.section,
    items: visible
      .filter(({ key }) =>
        section.keys.includes(key) ||
        (index === NAV_SECTIONS.length - 1 && !claimed.has(key)))
      // A destination with `children` (Inventory, Communication) is an
      // expandable group in the legacy sidebar. The kit's nav has no
      // disclosure control - it groups under headings and keeps every row
      // flat - so the children are lifted to siblings rather than inventing
      // an affordance the design does not have. The parent is itself a
      // destination, so it stays and simply leads its own children.
      //
      // Each child is gated on its own ability AND its own entitlement, exactly
      // as the parent is; lifting a row must not lift its gates with it.
      // The parent also lands on its first REACHABLE child rather than its
      // declared href, which is a dead link for an org entitled to only some of
      // the group (email but not phone).
      .flatMap(({ key, dest }) => [
        { key, dest: { ...dest, href: resolveNavHref(dest, access) } },
        ...visibleNavChildren(dest, access).map((child) => ({
          key: child.key,
          dest: { ...child, home: dest.home } as NavDestination,
        })),
      ])
      // Deduplicate by destination. Some children repeat a row that already
      // exists at the top level - Price Book is both its own entry and an
      // Inventory child - and nesting hid that. Flattened, it renders twice.
      .filter((item, i, all) => all.findIndex((x) => x.dest.href === item.dest.href) === i),
  })).filter((section) => section.items.length > 0);

  const displayName = user ? `${user.first_name} ${user.last_name}`.trim() : 'Account';
  const unreadCount = unread?.unseen ?? 0;

  return (
    <TooltipProvider delayDuration={200}>
      <AppShell
        topbar={
          <TopBar>
            <TopBarBrand asChild mark={<ServWaveMark />} label="ServWave">
              <Link to="/v2" aria-label="ServWave home" onClick={guardNavigation('/v2')} />
            </TopBarBrand>

            <TopBarSearch placeholder="Search everything..." />

            <TopBarActions>
              <TopBarPill onClick={() => openCopilot(true)} aria-label="Open Servy, the AI copilot">
                <Sparkles />
                Servy
              </TopBarPill>
              <TopBarDivider />
              <TopBarAction label="Help and support"><HelpCircle /></TopBarAction>
              <TopBarAction label="Text messages"><MessageSquare /></TopBarAction>
              <TopBarAction label="WhatsApp"><MessageCircle /></TopBarAction>
              <TopBarAction label="Inbox"><Mail /></TopBarAction>
              <TopBarAction label="Open dialer"><Phone /></TopBarAction>
              {ability.can('read', 'AiCenter') && (
                <TopBarAction label="AI Agentic Farm" onClick={() => openAiCenter()}>
                  <Sparkles />
                </TopBarAction>
              )}
              <TopBarDivider />
              <TopBarAction
                label="Notifications"
                badge={unreadCount > 0 ? (unreadCount > 99 ? '99+' : unreadCount) : undefined}
              >
                <Bell />
              </TopBarAction>
              <TopBarUser
                name={displayName}
                role={user?.role}
                initials={initialsFor(displayName)}
                tint={tintFor(displayName)}
              />
            </TopBarActions>
          </TopBar>
        }
        sidebar={
          <Sidebar>
            <SidebarNav>
              {sections.map(({ section, items }, index) => (
                <Fragment key={section}>
                  {/* A fragment, not a wrapper element: the travelling rail
                      measures each row's offsetTop against the nav's own box,
                      so an extra positioned box between them would offset every
                      measurement by the wrapper's origin. */}
                  <SidebarGroupLabel withToggle={index === 0}>{section}</SidebarGroupLabel>
                  {items.map(({ key, dest }) => {
                    const lock = lockOf(dest);
                    const Icon = dest.icon;
                    if (lock) {
                      return (
                        <SidebarItem
                          key={key}
                          locked
                          icon={<Icon />}
                          label={dest.label}
                          count={lock}
                        />
                      );
                    }
                    return (
                      <SidebarItem
                        key={key}
                        asChild
                        active={isActive(dest.href)}
                        icon={<Icon />}
                        label={dest.label}
                      >
                        <Link to={dest.href} onClick={guardNavigation(dest.href)} />
                      </SidebarItem>
                    );
                  })}
                </Fragment>
              ))}
            </SidebarNav>
          </Sidebar>
        }
      >
        <Outlet />
      </AppShell>

      {/* Global AI Agentic Farm modal - opened from the action bar above. */}
      <AiCenterModal />

      {/* Servy - the docked AI copilot (opened from the pill / keyboard). */}
      <CopilotProvider />

      {/* CTM office softphone - warms the WebRTC voice device on the user's
          first gesture so click-to-call is instant. Renders nothing; gated to
          comm-enabled office users. */}
      <OfficeSoftphoneWarmup />
    </TooltipProvider>
  );
}
