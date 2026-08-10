import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { V2_ROUTES, hasV2Page, matchesPattern } from '../uiV2';

const V2_ROUTES_SRC = readFileSync(join(__dirname, '..', 'V2Routes.tsx'), 'utf8');

/** Every `path="/v2/…"` literal declared in the v2 route block. */
function declaredRoutePaths(): string[] {
  return [...V2_ROUTES_SRC.matchAll(/path="(\/v2\/[^"]*)"/g)].map((m) => m[1]!);
}

describe('V2_ROUTES registry', () => {
  /**
   * The registry and the route block are two hand-maintained lists. An entry in
   * V2_ROUTES with no matching <Route> is not a dead link - it is a redirect
   * loop: /x sends you to /v2/x, which misses every route, falls to path="*",
   * and navigates back to "/". If "/" is also registered, that cycles.
   */
  it('every registered path has a matching /v2 route', () => {
    const declared = declaredRoutePaths();
    const missing = V2_ROUTES.filter((p) => !declared.includes(`/v2${p}`));
    expect(missing, `V2_ROUTES entries with no <Route> in V2Routes.tsx: ${missing.join(', ')}`)
      .toEqual([]);
  });

  it('registered paths are absolute, slash-prefixed and free of trailing slashes', () => {
    for (const p of V2_ROUTES) {
      expect(p.startsWith('/'), `"${p}" must start with /`).toBe(true);
      expect(p === '/' || !p.endsWith('/'), `"${p}" must not end with /`).toBe(true);
      expect(p.startsWith('/v2'), `"${p}" is a LEGACY path; do not prefix it with /v2`).toBe(false);
    }
  });
});

describe('hasV2Page', () => {
  it('returns false for a path no module has registered', () => {
    // Durable rather than a phase freeze: asserting V2_ROUTES is empty would
    // start failing on the first module branch, which is not a regression.
    expect(hasV2Page('/__not-a-registered-route__')).toBe(false);
  });

  it('agrees with the registry - every registered pattern matches a concrete path', () => {
    for (const pattern of V2_ROUTES) {
      // Substitute a value for each :param to build a matching URL.
      const concrete = pattern.replace(/:[^/]+/g, 'sample');
      expect(hasV2Page(concrete), `hasV2Page("${concrete}") should match "${pattern}"`).toBe(true);
    }
  });

  it('matches segment-wise, so a shorter pattern cannot swallow a longer path', () => {
    // Exercises the REAL matcher. An earlier version of this test reimplemented
    // the matching rules inline, which meant deleting them from uiV2.ts left it
    // green - it was asserting against a copy of the code.
    expect(matchesPattern('/jobs', '/jobs')).toBe(true);
    expect(matchesPattern('/jobs', '/jobs/new')).toBe(false);
    expect(matchesPattern('/jobs/:id', '/jobs/123')).toBe(true);
    expect(matchesPattern('/jobs/:id', '/jobs')).toBe(false);
    expect(matchesPattern('/jobs/:id', '/leads/123')).toBe(false);
    expect(matchesPattern('/jobs/', '/jobs')).toBe(true); // trailing slash normalised
    expect(matchesPattern('/jobs', '/Jobs')).toBe(true); // router is case-insensitive
    expect(matchesPattern('/JOBS', '/jobs')).toBe(true); // ...in both directions
    expect(matchesPattern('/', '/')).toBe(true);
  });
});
