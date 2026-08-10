import { useEffect } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';

import { hasV2Page, isUiV2Enabled } from './uiV2';

/**
 * With VITE_UI_V2=true, sends a legacy path that has a v2 counterpart to its
 * /v2 route.
 *
 * Deliberately a redirect rather than a second set of <Route> entries at the
 * legacy paths: duplicate paths in one route table make which one wins depend
 * on React Router's ranking, and a silent tie-break is the wrong thing to rest
 * a whole migration on. This way the route table has exactly one definition per
 * path, and the flag's effect is a single obvious hop.
 *
 * Renders nothing. With the flag off it is inert - `hasV2Page` is not even
 * consulted. Delete this component and its mount to remove the flag.
 */
export function V2FlagRedirect() {
  const location = useLocation();
  const navigate = useNavigate();

  useEffect(() => {
    if (!isUiV2Enabled()) return;
    if (location.pathname.startsWith('/v2')) return;
    if (!hasV2Page(location.pathname)) return;
    navigate(`/v2${location.pathname}${location.search}${location.hash}`, { replace: true });
  }, [location, navigate]);

  return null;
}
