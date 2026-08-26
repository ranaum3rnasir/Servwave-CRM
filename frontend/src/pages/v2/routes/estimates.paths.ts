/**
 * Module 4 - Estimates. Legacy paths that have a v2 counterpart.
 *
 * Paths live in their own `.paths.ts` file, separate from the `.routes.tsx`
 * that declares the JSX, because `uiV2.ts` reads the collected paths and is
 * itself imported by every v2 page. If the collector pulled in the route files
 * it would pull in the pages, and the pages import `uiV2` - an import cycle.
 *
 * These are LEGACY paths, without the `/v2` prefix. `v2Path` adds it.
 *
 * THREE paths, not four. `/estimates/:id/edit` no longer exists: estimates are
 * create=edit, so `/estimates/new` eagerly creates an empty DRAFT and redirects
 * to the workspace at `/estimates/:id`, which IS the editor. See App.tsx.
 */
export const ESTIMATES_V2_PATHS = [
  '/estimates',
  '/estimates/new',
  '/estimates/:id',
] as const;
