import { Plus } from 'lucide-react';
import { useNavigate } from 'react-router-dom';

import { quickCreateItems } from '@/components/layout/nav-config';
import { useAppAbility } from '@/contexts/AbilityContext';
import { useSettingsGuard } from '@/stores/settingsGuard.store';
import { useSidebar } from '@/ui-kit/components/layout/appShell';
import { Button } from '@/ui-kit/components/ui/button';
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger,
} from '@/ui-kit/components/ui/dropdownMenu';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/ui-kit/components/ui/tooltip';

import { preferV2Path } from './uiV2';

/**
 * The global "Create New" action, pinned to the head of the sidebar.
 *
 * The list is `quickCreateItems` - imported from the shared nav module rather
 * than forked, filtered by the same `ability.can(action, subject)` check, so a
 * role that cannot create a Job never sees the row. Its hrefs are the app's
 * plain paths and are used as they are; `preferV2Path` around them is a no-op
 * shim left in place, not a rewrite (see `uiV2.ts`).
 *
 * Its own component, not markup inside V2AppLayout, because it needs
 * `useSidebar()` - which only resolves for a component RENDERED inside AppShell.
 * V2AppLayout builds the sidebar element but is itself outside the provider.
 *
 * Rail mode collapses it to the same 38px square as a nav row and moves the
 * label into a tooltip, matching SidebarItem exactly; the geometry is in
 * shell.css under `.sb-create`.
 */
export function SidebarCreateMenu() {
  const ability = useAppAbility();
  const navigate = useNavigate();
  const requestLeave = useSettingsGuard((s) => s.requestLeave);
  const { isRail, isMobile, closeDrawer } = useSidebar();

  const items = quickCreateItems.filter((item) => ability.can(item.action, item.subject));
  if (items.length === 0) return null;

  const trigger = (
    <DropdownMenuTrigger asChild>
      <Button size="sm" className="sb-create">
        <Plus />
        <span className="sb-label">Create New</span>
      </Button>
    </DropdownMenuTrigger>
  );

  return (
    <DropdownMenu>
      {isRail ? (
        <Tooltip>
          <TooltipTrigger asChild>{trigger}</TooltipTrigger>
          <TooltipContent side="right">Create New</TooltipContent>
        </Tooltip>
      ) : (
        trigger
      )}

      {/* To the right of the column, like legacy - a menu that dropped below
          would cover the first nav group it sits on top of. */}
      <DropdownMenuContent side="right" align="start">
        {items.map((item) => (
          <DropdownMenuItem
            key={item.href}
            onSelect={() => {
              // A dirty settings form gets to intercept, exactly as it does for
              // every other navigation in this shell. On mobile the sidebar is
              // an overlay drawer, so it also has to get out of the way or the
              // page you just asked for arrives underneath it.
              if (isMobile) closeDrawer();
              // Ported modules keep the user in v2; the rest still open their
              // legacy page, which is the only one they have.
              requestLeave(() => navigate(preferV2Path(item.href)));
            }}
          >
            <item.icon />
            {item.label}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
