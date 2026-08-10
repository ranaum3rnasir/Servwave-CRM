/**
 * The v2 presentation layer - registry and feature flag.
 *
 * Every v2 page is reachable at `/v2<path>` for side-by-side comparison against
 * the original at `<path>`. Both layers are live at once; the old pages are
 * never modified.
 *
 * With `VITE_UI_V2=true`, visiting a legacy path that has a v2 counterpart
 * redirects to the v2 route, so the new layer can be exercised as if it were
 * the app. Unset the flag to roll back.
 *
 * Adding a module: append its paths to V2_ROUTES and add the matching <Route>
 * entries in V2Routes.tsx. Nothing else in the router changes.
 */

/** Legacy paths that have a v2 counterpart. Route patterns, not live URLs. */
export const V2_ROUTES: readonly string[] = [
  // Populated per module branch, e.g. '/jobs', '/jobs/:id'.
];

/** Is the flag on? Reads at call time so tests can stub import.meta.env. */
export function isUiV2Enabled(): boolean {
  return import.meta.env.VITE_UI_V2 === 'true';
}

/**
 * Does `pathname` correspond to a v2 page?
 *
 * Compares segment by segment so `:id`-style params match any single segment.
 * A pattern only matches a path with the same segment count, so `/jobs` never
 * swallows `/jobs/new`.
 */
/**
 * Does one route pattern match one pathname?
 *
 * Exported so tests can exercise the real matcher. While V2_ROUTES is empty
 * `hasV2Page` returns false for every input, so a test written against it alone
 * cannot tell a working matcher from a broken one.
 */
export function matchesPattern(pattern: string, pathname: string): boolean {
  const norm = (s: string) => s.replace(/\/+$/, '') || '/';
  // Both sides lowercased because React Router matches case-insensitively:
  // without it, /Jobs would render the legacy page while /jobs redirected, so
  // the flag would silently only half-apply. Patterns are normalised too - a
  // stray trailing slash on an entry would otherwise make it unmatchable and
  // the entry silently dead.
  const a = norm(pattern).toLowerCase().split('/');
  const b = norm(pathname).toLowerCase().split('/');
  // Equal segment counts, so '/jobs' can never swallow '/jobs/new'.
  if (a.length !== b.length) return false;
  return a.every((seg, i) => seg.startsWith(':') || seg === b[i]);
}

export function hasV2Page(pathname: string): boolean {
  return V2_ROUTES.some((pattern) => matchesPattern(pattern, pathname));
}
