import { lazy } from 'react';
import { Route } from 'react-router-dom';

import ProtectedRoute from '@/components/ProtectedRoute';
import V2AppLayout from './V2AppLayout';

/**
 * The `/v2/*` route block.
 *
 * Returned as a fragment of <Route> elements so App.tsx can splice it into the
 * existing tree without restructuring it. Module branches add their pages here
 * and to V2_ROUTES in uiV2.ts.
 *
 * Guards: a v2 route reuses the SAME ProtectedRoute / RequireFeature wrappers
 * as its legacy counterpart. Reproducing a page without its guard would change
 * who can reach it, which is a behaviour change, not a restyle.
 *
 * Chrome: everything here nests under V2AppLayout, the kit shell, instead of the
 * app's AppLayout. That swap is scoped to this block - AppLayout still wraps
 * every legacy route and is not modified.
 */

const KitReferencePage = lazy(() => import('./_reference/KitReferencePage'));

export function v2Routes() {
  return (
    <>
      {/* The kit's own reference implementation, kept as the visual baseline to
          diff against crm-ui-kit-previews/previews/jobsPagePreview.html. Not a
          product page: it renders the kit's static fixture data.

          Behind ProtectedRoute despite holding no real data. It is unreleased
          UI, and leaving it open would contradict the rule stated above it. */}
      <Route element={<ProtectedRoute />}>
        <Route element={<V2AppLayout />}>
          <Route path="/v2/_kit-reference" element={<KitReferencePage />} />
          {/* Module pages land here. */}
        </Route>
      </Route>
    </>
  );
}
