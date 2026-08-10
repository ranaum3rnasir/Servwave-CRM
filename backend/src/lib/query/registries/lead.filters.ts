import { LeadStatus } from '@prisma/client';
import { equalsOrIn, relationSome, FacetDef } from '../filterEngine';
import { mergeWalkthroughsSome } from '../../../services/walkthrough.service';

/**
 * Lead list facet registry (Task 4 — first entity wired to the shared filter
 * engine). Exported as a FUNCTION of `scopeWhere`, not a static array, solely
 * because of the `assigned_to` facet below — see its comment for why.
 *
 * `param` names here are the wire contract the frontend registry (Task 9)
 * must match.
 */
export function leadFacets(scopeWhere: Record<string, unknown>): FacetDef[] {
  return [
    // `status` is a strict Prisma enum column: passing an invalid literal
    // through `{ in: [...] }` unguarded throws a Prisma validation error
    // (500) instead of the desired "silently ignore garbage" behavior.
    {
      key: 'status',
      kind: 'multi',
      param: 'status',
      apply: (where, values) => {
        const validStatuses = values.filter((v) => Object.values(LeadStatus).includes(v as LeadStatus));
        equalsOrIn('status')(where, validStatuses);
      },
    },
    // Plain direct Lead column — the shared engine's equalsOrIn is correct as-is.
    { key: 'job_type', kind: 'multi', param: 'job_type', apply: equalsOrIn('job_type') },
    // ad_source lives on the Customer relation, NOT a direct Lead column.
    // Merges into any existing `where.customer` rather than overwriting it
    // (defensive — nothing else currently sets `where.customer`, but this
    // mirrors relationSome's merge-safety pattern in case that changes).
    {
      key: 'ad_source',
      kind: 'multi',
      param: 'ad_source',
      apply: (where, values) => {
        if (values.length === 0) return;
        where.customer = {
          ...((where.customer as Record<string, unknown> | undefined) ?? {}),
          ad_source: values.length === 1 ? values[0] : { in: values },
        };
      },
    },
    // Synthetic/derived facet — NOT a real column. Today the only valid value in the system is
    // 'needs_scheduling' (confirmed via grep of both this controller and the frontend's
    // WALKTHROUGH_FILTERS list).
    //
    // Walkthrough-as-entity redesign, PR-B2: the bucket is now `Walkthrough.status = REQUESTED`
    // — no lead status involved at all, which is what structurally deletes the reported bug (the
    // three previously-divergent "needs scheduling" definitions collapse to this one). The old
    // array-order dependency on `status` running first (so this facet could DEFAULT it) is gone
    // with it — this facet no longer touches `where.status`.
    //
    // SECURITY: same clobber-guard as `assigned_to` below and the hand-rolled walkthrough_after/
    // before filter in lead.controller.ts's buildLeadListWhere — `where.walkthroughs` may
    // already carry a TECHNICIAN's OWN_WALKTHROUGH row-scope (defaultGrants.ts), so
    // mergeWalkthroughsSome merges into the SAME `some` clause instead of overwriting the key.
    {
      key: 'walkthrough_status',
      kind: 'multi',
      param: 'walkthrough_status',
      apply: (where, values) => {
        if (!values.includes('needs_scheduling')) return;
        where.walkthroughs = mergeWalkthroughsSome(where, { status: 'REQUESTED' });
      },
    },
    // SECURITY-CRITICAL: `scopeWhereForReq(req, 'Lead')` already narrows
    // `where.lead_assignees` for row-scoped roles (e.g. SALES/TECHNICIAN, who
    // may only see their OWN assigned leads). If this facet applied
    // unconditionally, a row-scoped user could pass `?assigned_to=<someone-
    // else>` and have the filter engine SET `where.lead_assignees` to
    // something that widens or replaces their row-scope restriction — an
    // RBAC bypass / cross-user data leak. Must be a no-op whenever
    // `scopeWhere.lead_assignees` is already defined, exactly as the
    // pre-engine hand-rolled code enforced. This is why `leadFacets` is a
    // function of `scopeWhere` rather than a static array: it lets this
    // `apply` closure see the per-request scope without any change to the
    // shared `filterEngine.ts` (which has no concept of scopeWhere at all).
    {
      key: 'assigned_to',
      kind: 'multi',
      param: 'assigned_to',
      apply: (where, values) => {
        if (scopeWhere.lead_assignees !== undefined) return;
        if (values.length === 0) return;
        if (values.includes('UNASSIGNED')) {
          where.lead_assignees = { none: {} };
          return;
        }
        relationSome('lead_assignees', 'user_id')(where, values);
      },
    },
    // Plain direct Lead column, scalar today — made array-capable per the audit.
    { key: 'customer_id', kind: 'multi', param: 'customer_id', apply: equalsOrIn('customer_id') },
    { key: 'created', kind: 'dateRange', afterParam: 'created_after', beforeParam: 'created_before', column: 'created_at' },
    { key: 'estimates', kind: 'countRange', minParam: 'estimates_min', maxParam: 'estimates_max', countOn: { model: 'estimate', groupField: 'lead_id' } },
    // SRVW-58. Deliberately NOT `relationSome('lead_tags', 'tag_id')`: that legacy
    // LeadTag join is the only real Prisma tag relation on Lead, so it compiles - but
    // nothing writes it any more (report.controller.ts is its last reader) and it holds
    // zero rows, so the filter would silently narrow to nothing off dead data. Live tags
    // are polymorphic TagAssignment rows, which the `tags` facet kind resolves.
    { key: 'tags', kind: 'tags', param: 'tags', entityType: 'LEAD' },
  ];
}
