import { Suspense, useEffect, type MouseEvent } from 'react';
import { Link, Outlet, useLocation, useNavigate } from 'react-router-dom';
import {
  LogOut, Mail, MessageSquare, Settings as SettingsIcon, Sparkles,
} from 'lucide-react';

import { AppShell } from '@/ui-kit/components/layout/appShell';
import {
  Sidebar, SidebarFooter, SidebarHeader, SidebarItem,
} from '@/ui-kit/components/layout/nav/sidebar';
import {
  TopBar, TopBarAction, TopBarActions, TopBarBrand, TopBarDivider, TopBarPill,
  TopBarUser, TopBarWorkspace,
} from '@/ui-kit/components/layout/nav/topBar';
import { Spinner } from '@/ui-kit/components/ui/spinner';
import { TooltipProvider } from '@/ui-kit/components/ui/tooltip';
import { initialsFor, tintFor } from '@/ui-kit/components/ui/avatar';

import { ServWaveMark } from '@/components/brand/ServWaveMark';
import { AiCenterModal } from '@/components/ai-center/AiCenterModal';
import CopilotProvider from '@/components/copilot/CopilotProvider';
import { OfficeSoftphoneWarmup } from '@/components/communication/phone/OfficeSoftphoneWarmup';
import { SpiderNotificationPopup } from '@/components/notifications/SpiderNotificationPopup';
import { BrowserAutomationIndicator } from '@/components/notifications/BrowserAutomationIndicator';
import { useSyncSpiderWatcherLive } from '@/stores/spiderWatcherStore';

// Legacy components with no kit counterpart. The kit ships chrome for these -
// an inert search input, an icon that can carry a badge - but not the surfaces
// behind them: no search backend or results list, no notification panel, no
// dialer, no geofenced clock. Rendering the kit's chrome alone would have left
// the v2 shell looking complete while doing nothing, so the working components
// are reused as-is and recorded in UI_KIT_MISSING_COMPONENTS.md.
import GlobalSearch from '@/components/layout/GlobalSearch';
import { NotificationBell } from '@/components/notifications/NotificationBell';
import { GlobalDialer } from '@/components/communication/phone/Dialer';
import { ClockInOutMenu } from '@/components/timeclock/ClockInOutMenu';

// The KIT's menu, not the app's. ClockInOutMenu renders plain content rather
// than menu items - it builds from Button alone - so nothing in this menu is
// tied to the legacy dropdown, and the user menu can be kit throughout.
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel,
  DropdownMenuSeparator, DropdownMenuTrigger,
} from '@/ui-kit/components/ui/dropdownMenu';

import { useAppAbility } from '@/contexts/AbilityContext';
import { useAuthStore } from '@/stores/auth.store';
import { useSettingsGuard } from '@/stores/settingsGuard.store';
import { useAiCenterStore } from '@/stores/aiCenterStore';
import { useCopilotStore } from '@/stores/copilotStore';
import { useOrganization } from '@/lib/api/organization';
import { useUnreadCounts } from '@/lib/api/communication';
import { setOrgFormattingPrefs } from '@/lib/org-format';
import { useFeature } from '@/lib/entitlements';

import { fallbackLabelFor, useNavHistory } from './navHistory.store';
import { V2Breadcrumbs } from './pageBreadcrumbs';
import { SidebarCreateMenu } from './SidebarCreateMenu';
import { V2SidebarNav } from './V2SidebarNav';
import { preferV2Path } from './uiV2';

/**
 * A comms count as the kit's badge wants it: absent at zero rather than a "0"
 * bubble, and capped so a four-digit inbox cannot widen the action row.
 */
function commBadge(count: number): string | undefined {
  if (!count) return undefined;
  return count > 99 ? '99+' : String(count);
}

/**
 * The module a pathname belongs to - `/v2/leads/42` and `/v2/leads` are both
 * `/v2/leads`. Used as the Suspense key below.
 */
function moduleKeyOf(pathname: string): string {
  return pathname.split('/').slice(0, 3).join('/');
}

/**
 * Does this route take the whole canvas - no gutter, no page chrome?
 *
 * Schedule, and so far only Schedule. The board IS the page there: it manages
 * its own scrolling in two axes, so it wants every pixel and it wants the
 * canvas not to scroll underneath it. That single fact decides two things at
 * once, which is why they share one predicate rather than two that have to be
 * kept in step:
 *
 *   - the canvas runs FLUSH (see AppShell's `flush`), and
 *   - no breadcrumb row is drawn, since it would be the only chrome between
 *     the top bar and the grid, costing a row of hours to say what the
 *     highlighted sidebar entry already says.
 *
 * Schedule still RECORDS itself, so passing through it leaves a step in
 * everyone else's trail; it just does not draw one of its own.
 */
function isFullCanvasPage(pathname: string): boolean {
  return /^\/schedule(\/|$)/i.test(pathname);
}

/** Shown in the canvas while an incoming page's chunk loads. */
function PageLoading() {
  return (
    <div role="status" aria-live="polite" className="flex items-center justify-center py-24">
      <Spinner />
      <span className="sr-only">Loading page</span>
    </div>
  );
}

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
  useSyncSpiderWatcherLive();
  const ability = useAppAbility();
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const requestLeave = useSettingsGuard((s) => s.requestLeave);

  const user = useAuthStore((s) => s.user);
  const logout = useAuthStore((s) => s.logout);

  const openAiCenter = useAiCenterStore((s) => s.openModal);
  const openCopilot = useCopilotStore((s) => s.setOpen);

  // Per-channel unread counts for the comms shortcuts, and the entitlement that
  // decides whether those shortcuts exist at all. `phone` is the master switch
  // for the entire Communication module, so an org without it must not be shown
  // an inbox it cannot open - the legacy header hides them for the same reason.
  const unread = useUnreadCounts();
  const canAccessComm = useFeature('phone');

  // Load THIS user's breadcrumb trail out of localStorage, and reload it if the
  // signed-in user changes without a page load. Done here rather than at the
  // store's module scope because that module is pulled in by page chunks that
  // can evaluate before auth has a user, which would read no key and cache an
  // empty trail for the session.
  const hydrateNavHistory = useNavHistory((s) => s.hydrate);
  const userId = user?.id ?? null;
  useEffect(() => {
    hydrateNavHistory(userId);
  }, [hydrateNavHistory, userId]);

  // The safety net under the trail: any v2 page that did not record itself gets
  // recorded here under a name derived from its path. A page's own effects run
  // before this one, so a page that DID record keeps its better label and this
  // is a no-op. See `visitFallback`.
  const visitFallback = useNavHistory((s) => s.visitFallback);
  useEffect(() => {
    visitFallback(pathname, fallbackLabelFor(pathname));
  }, [visitFallback, pathname]);

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

  const displayName = user ? `${user.first_name} ${user.last_name}`.trim() : 'Account';

  // The organisation's own identity, sourced and defaulted exactly as
  // `components/layout/Header.tsx` does it:
  //
  //   const title = org?.name ?? '';
  //   alt={org?.name ? `${org.name} logo` : 'Company logo'}
  //
  // so a shell with no organisation loaded shows no name (rather than a
  // placeholder), and a logo with no name behind it is still announced.
  const orgName = organization?.name ?? '';
  const orgLogoAlt = orgName ? `${orgName} logo` : 'Company logo';

  return (
    <TooltipProvider delayDuration={200}>
      <AppShell
        // Schedule takes the whole canvas: no gutter, no page scroll. Same
        // route test the breadcrumb uses, and for the same reason - the board
        // is the page there.
        flush={isFullCanvasPage(pathname)}
        topbar={
          <TopBar>
            <TopBarBrand asChild mark={<ServWaveMark />} label="ServWave">
              <Link to="/" aria-label="ServWave home" onClick={guardNavigation('/')} />
            </TopBarBrand>

            {/* Which organisation you are signed in to. The legacy header makes
                this the bar's title; the kit's bar reserves the gap right of
                the brand for it. Rendered only when there is a name, matching
                the legacy `org?.name ?? ''` - an empty title there occupies no
                space either. */}
            {orgName && <TopBarWorkspace name={orgName} />}

            {/* The kit's TopBarSearch is presentation only - an input, an icon
                and a shortcut hint, wired to nothing. The app's search has a
                debounce, a query, a grouped result list, keyboard navigation
                and the settings-guard on select, none of which the kit ships.
                Positioned with the same rule the kit's own field uses:
                margin-left auto, capped at 320px. */}
            <GlobalSearch
              className="ml-auto w-full min-w-0 max-w-[320px]"
              placeholder="Search everything..."
            />

            <TopBarActions>
              <TopBarPill onClick={() => openCopilot(true)} aria-label="Open Servy, the AI copilot">
                <Sparkles />
                Servy
              </TopBarPill>
              <TopBarDivider />

              {/* Comms shortcuts. Gated on the `phone` entitlement, exactly as
                  the legacy header gates them: `phone` is the master switch for
                  the whole Communication module, so without it these two lead
                  to routes the org cannot open. They previously rendered here
                  unconditionally and inert, which showed every org an inbox it
                  had no access to.

                  Counts are per channel, not the notification count - an inbox
                  badge that moved when an unrelated notification arrived would
                  be actively misleading.

                  WhatsApp is deliberately NOT one of them: the row is down to
                  the two channels this bar shortcuts to, and WhatsApp is still
                  reachable from the Communication section in the sidebar. */}
              {canAccessComm && (
                <>
                  <TopBarAction
                    label="Text messages"
                    badge={commBadge(unread.sms)}
                    onClick={() => requestLeave(() => navigate(preferV2Path('/communication/phone')))}
                  >
                    <MessageSquare />
                  </TopBarAction>
                  <TopBarAction
                    label="Inbox"
                    badge={commBadge(unread.email)}
                    onClick={() => requestLeave(() => navigate(preferV2Path('/communication/inbox')))}
                  >
                    <Mail />
                  </TopBarAction>

                  {/* Click-to-call from any page. Renders its own trigger and
                      call surface; the kit has no dialer to replace it with. */}
                  <GlobalDialer />
                </>
              )}

              {/* The AI Agentic Farm launcher lives in the sidebar footer, and
                  only there. Two entry points to one modal made the sparkle in
                  this row read as a second, different feature. */}
              <TopBarDivider />

              {/* Owns its own badge, realtime subscription, mark-seen-on-open
                  and the panel itself, so it is mounted whole rather than
                  reduced to the kit's icon-with-a-number. */}
              <NotificationBell />

              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  {/* `avatarSrc` puts the org's branding on the same chip the
                      legacy header puts it on, falling back to the user's
                      initials when there is no logo - which is what that
                      header does too. */}
                  <TopBarUser
                    name={displayName}
                    role={user?.role}
                    initials={initialsFor(displayName)}
                    tint={tintFor(displayName)}
                    avatarSrc={organization?.logo_url ?? undefined}
                    avatarAlt={orgLogoAlt}
                  />
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="w-52">
                  <DropdownMenuLabel>
                    <span className="block text-sm font-medium">{displayName}</span>
                    <span className="block text-xs text-text-secondary">{user?.email}</span>
                  </DropdownMenuLabel>
                  <DropdownMenuSeparator />
                  {/* Geofenced clock in/out - anchored to "me", as in the
                      legacy header. No kit equivalent. */}
                  <ClockInOutMenu />
                  <DropdownMenuSeparator />
                  {/* No "My Profile" row: Settings opens the same settings shell
                      that carries the profile page in its own nav, so the menu
                      offered two doors onto one destination. Settings is the
                      one that reaches everything. */}
                  <DropdownMenuItem
                    onClick={() => requestLeave(() => navigate(preferV2Path('/settings/company')))}
                  >
                    <SettingsIcon />
                    Settings
                  </DropdownMenuItem>
                  <DropdownMenuSeparator />
                  {/* `variant`, not a call-site colour class. The kit's item
                      owns what destructive looks like; the legacy header sets
                      text-danger here, and the layering guard counts every one
                      of those as appearance that escaped its component. */}
                  <DropdownMenuItem variant="destructive" onClick={() => logout()}>
                    <LogOut />
                    Sign Out
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </TopBarActions>
          </TopBar>
        }
        sidebar={
          <Sidebar>
            {/* Create New - above the first group, so the action that makes a
                record heads the navigation column. It is chrome, not page
                furniture: it has to be reachable from every page, and it must
                not sit next to the page header's own primary action or the two
                read as duplicates of each other. */}
            <SidebarHeader>
              <SidebarCreateMenu />
            </SidebarHeader>

            {/* The destination list. Its own component because it resolves the
                stored layout against the ability, the org's entitlements and
                the section map before a single row exists - and because
                `useNavLayout()` has to be a single instance, since the hook
                seeds its own state from localStorage and two copies would
                drift apart. */}
            <V2SidebarNav />

            {/* AI Agentic Farm - pinned at the bottom, exactly as the legacy
                sidebar pins it, and behind the same `read AiCenter` grant.
                Outside SidebarNav on purpose: the footer does not scroll with
                the list, and the travelling rail only measures rows inside the
                nav, so a launcher that is never a destination cannot be
                mistaken for one. SidebarItem carries it through rail mode -
                the label collapses and the tooltip takes over, like every
                other row.

                `emphasis="ai"` is the kit's version of the three signals the
                legacy sidebar gives it: the footer's hairline above, the
                lavender glyph, and a tinted surface of its own, so it does not
                read as one more destination in a list of twenty-odd. */}
            {ability.can('read', 'AiCenter') && (
              <SidebarFooter>
                <SidebarItem
                  emphasis="ai"
                  icon={<Sparkles />}
                  label="AI Agentic Farm"
                  onClick={() => openAiCenter()}
                />
              </SidebarFooter>
            )}
          </Sidebar>
        }
      >
        {/* Every v2 page is `lazy`, and react-router runs navigation inside a
            transition: while the incoming chunk loads, React keeps the OUTGOING
            page on screen. The URL and the sidebar highlight have already moved
            by then, so a chunk that takes a moment reads as "the route changed
            but the page did not" - the single most common complaint about this
            layer.

            Keying the boundary per MODULE gives React a fresh boundary on a
            cross-module navigation, which shows the fallback instead of the
            stale page. It is deliberately not keyed on the full pathname: that
            would also remount on `/leads/1` -> `/leads/2`, throwing away
            detail-page state that survives today. */}
        {/* The trail, drawn ONCE for every route, above whatever the route
            renders. Outside the Suspense boundary on purpose: it is chrome, it
            is already correct for the incoming URL, and re-mounting it with
            each page chunk would blink it out on every cross-module move. */}
        {!isFullCanvasPage(pathname) && <V2Breadcrumbs />}

        <Suspense key={moduleKeyOf(pathname)} fallback={<PageLoading />}>
          <Outlet />
        </Suspense>
      </AppShell>

      {/* Visual Browser Automation Indicator (Ambient Glowing Viewport Border + Live Status Banner) */}
      <BrowserAutomationIndicator />

      {/* Spider persistent notification pop-up box in lower section */}
      <SpiderNotificationPopup />

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
