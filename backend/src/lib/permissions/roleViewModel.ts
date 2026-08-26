import type { Grant } from './defineAbility';

export type ScopeValue = 'All' | 'Owned' | 'Team' | 'Location';
export type CrudCell = { read: boolean; create: boolean; update: boolean; delete: boolean };

// The modules shown as a CRUD matrix in the Roles UI. MANAGED_KEYS in role.controller.ts
// derives from this list, so adding a row here automatically brings it under Save/Reset
// management — keep this list in lockstep with the subjects the inventory/purchasing
// pages actually gate on (subject split: inventory P0, D11).
export const MODULES = [
  { subject: 'Customer', label: 'Customers' },
  { subject: 'Lead', label: 'Leads' },
  { subject: 'Estimate', label: 'Estimates' },
  { subject: 'Job', label: 'Jobs' },
  { subject: 'Invoice', label: 'Invoices' },
  { subject: 'Inventory', label: 'Inventory' },
  { subject: 'PurchaseOrder', label: 'Purchase Orders' },
  { subject: 'Vendor', label: 'Vendors' },
  { subject: 'ServicePlan', label: 'Service Plans' },
  { subject: 'LogisticOrder', label: 'Logistic Orders' },
  // SRVW-139 - full grant surface. All 8 already have real canDo() gates and DEFAULT_GRANTS rows
  // (SHARED_BASELINE + per-role) today; this just brings them onto the editable matrix.
  { subject: 'Communication', label: 'Communication' },
  { subject: 'Task', label: 'Tasks' },
  { subject: 'PriceBook', label: 'Price Book' },
  { subject: 'Attachment', label: 'Attachments' },
  { subject: 'User', label: 'Users' },
  { subject: 'Department', label: 'Departments' },
  { subject: 'Location', label: 'Locations' },
  { subject: 'Automation', label: 'Automations' },
  // Calendar Entries (Slice 01, spec §4). The Roles editor cannot see or toggle a grant that has
  // no MODULES row (the D15 "complete Job" shape - see the TOGGLES comment further down) - this
  // row is what makes the DEFAULT_GRANTS CalendarEntry rows editable, under the user-facing label.
  { subject: 'CalendarEntry', label: 'Events' },
] as const;

// Only these entities have an ownership chain → all four scope chips are real.
// Customer/Inventory have no ownership field → "All" only (UI disables the others).
export const SCOPE_ENTITIES = [
  { subject: 'Lead', label: 'Leads' },
  { subject: 'Job', label: 'Jobs' },
  { subject: 'Estimate', label: 'Estimates' },
  { subject: 'Invoice', label: 'Invoices' },
] as const;

export const SENSITIVE = {
  // SRVW-140 - "See financial data" writes the grant that actually gates every cost, price and
  // margin: `read Pricing`, the single subject `canSeePricing` (lib/permissions/enforce.ts) keys
  // on. It used to write `read Report`, which gates only the /api/reports routes and the
  // Reports/Billing nav and appears NOWHERE in the cost path - so the switch could read OFF while
  // the role saw every cost. It is a distinct (action, subject) pair on purpose: pointing it at
  // `read Invoice` would make viewModelToGrants emit read:Invoice TWICE (matrix row with the
  // data-scope condition, then this bundle with conditions:null), and putRolePermissions upserts
  // in order, so the unconditional copy would land last and strip the role's row scope.
  seeFinancials: [{ action: 'read', subject: 'Pricing' }],
  // `read Report` needs its own honest control: seeFinancials was its ONLY writer, and
  // MANAGED_KEYS (role.controller.ts) derives from what this emitter can emit - so without this
  // bundle the 13 canDo('read','Report') routes and the 8 Report nav entries would keep their
  // existing grants but become permanently uneditable.
  viewReports: [{ action: 'read', subject: 'Report' }],
  managePayments: [
    { action: 'record_payment', subject: 'Invoice' },
    { action: 'record_payment', subject: 'Estimate' },
    // Unified refund (entity-redesign §8) — covers deposit refunds via the kind=DEPOSIT
    // invoice, replacing the removed refund_deposit/Estimate action.
    { action: 'refund', subject: 'Invoice' },
  ],
  // Editable record IDs (2026-08-19 plan, decision #7) - permission plumbing for a NOT-YET-BUILT
  // capability (the PATCH .../:id/number endpoints ship in a later PR). ADMIN reaches every
  // subject via the manage-all bypass; this bundle is what the Roles UI "Edit record ID numbers"
  // switch writes/reads for every other role.
  editRecordIds: [
    { action: 'renumber', subject: 'Customer' },
    { action: 'renumber', subject: 'Lead' },
    { action: 'renumber', subject: 'Estimate' },
    { action: 'renumber', subject: 'Job' },
    { action: 'renumber', subject: 'Invoice' },
  ],
} as const;

type ScopeConds = Record<ScopeValue, Record<string, unknown> | null>;
const SCOPE_CONDITIONS: Record<string, ScopeConds> = {
  Lead: {
    All: null,
    Owned: { lead_assignees: { some: { user_id: '{{userId}}' } } },
    Team: { lead_assignees: { some: { user: { department_id: '{{teamId}}' } } } },
    Location: { lead_assignees: { some: { user: { location_id: '{{locationId}}' } } } },
  },
  // Multi-visit S8 (D6): crew lives on the visit, so every Job scope nests through `visits.some`.
  // This table is the EMITTER - the migration repairs today's stored rows, and this is what stops
  // the first admin Save after deploy from writing the dead path straight back in.
  Job: {
    All: null,
    Owned: { visits: { some: { assignees: { some: { user_id: '{{userId}}' } } } } },
    Team: { visits: { some: { assignees: { some: { user: { department_id: '{{teamId}}' } } } } } },
    Location: { visits: { some: { assignees: { some: { user: { location_id: '{{locationId}}' } } } } } },
  },
  Estimate: {
    All: null,
    Owned: { lead: { lead_assignees: { some: { user_id: '{{userId}}' } } } },
    Team: { lead: { lead_assignees: { some: { user: { department_id: '{{teamId}}' } } } } },
    Location: { lead: { lead_assignees: { some: { user: { location_id: '{{locationId}}' } } } } },
  },
  Invoice: {
    All: null,
    Owned: { job: { visits: { some: { assignees: { some: { user_id: '{{userId}}' } } } } } },
    Team: { job: { visits: { some: { assignees: { some: { user: { department_id: '{{teamId}}' } } } } } } },
    Location: { job: { visits: { some: { assignees: { some: { user: { location_id: '{{locationId}}' } } } } } } },
  },
};

// Extra condition shapes a chip must RECOGNISE but never emits. The editor speaks four values per
// subject; the grant table has always been free to hold shapes outside that vocabulary, and since
// the technician-ownership spec (Part C) it actually does - TECHNICIAN's `read Job` is
// assigned-OR-created. Without an entry here that grant matches no chip, the UI renders "All", and
// the admin is shown a scope the role does not have.
//
// Recognition ONLY. `SCOPE_CONDITIONS` above is still the sole emitter, and a Save is stopped from
// overwriting an unrepresentable condition by `isRepresentableScopeCondition` below - not by this
// table. Adding an alias here is therefore safe: the worst case is a chip label, never a grant.
const SCOPE_CONDITION_ALIASES: Record<string, Partial<Record<ScopeValue, Record<string, unknown>[]>>> = {
  Job: {
    // Creation confers control: a job you MADE is "yours" in the same sense as one you are
    // assigned to, which is what the Owned chip means to a contractor reading this screen.
    Owned: [
      {
        OR: [
          { visits: { some: { assignees: { some: { user_id: '{{userId}}' } } } } },
          { created_by_id: '{{userId}}' },
        ],
      },
    ],
  },
};

// SRVW-139 - a bundle for an action the CRUD matrix can't host: Dashboard/Notification have no
// `create` action (a matrix row would be permanently half-dead), and reopen/cancel Job are single
// lifecycle verbs, not a CRUD cell. Same on/off mechanism as SENSITIVE, generalized to carry an
// explicit `conditions` per grant - unlike SENSITIVE (always org-wide), `notifications` is always
// self-scoped, and hardcoding null here would let a Save silently widen it to every user's
// notifications org-wide (there is no "All" this toggle can mean - see the emitter below).
type ToggleGrant = { action: string; subject: string; conditions: Record<string, unknown> | null };

const OWN_NOTIFICATION = { recipients: { some: { recipient_id: '{{userId}}' } } };

// Multi-visit close-out (Q9, 2026-08-23) - same shape as defaultGrants.ts's OWN_JOB and
// userCapabilities.ts's OWN_JOB, re-declared here for the same reason those two do: this module
// is self-contained. Used ONLY as the seed condition for a toggle's FIRST-EVER grant on a role -
// see the preserve-on-save note above the five entries below.
const OWN_JOB = { visits: { some: { assignees: { some: { user_id: '{{userId}}' } } } } };

export const TOGGLES = {
  dashboard: [{ action: 'read', subject: 'Dashboard', conditions: null }],
  accountSettings: [
    { action: 'read', subject: 'Organization', conditions: null },
    { action: 'update', subject: 'Organization', conditions: null },
  ],
  notifications: [
    { action: 'read', subject: 'Notification', conditions: OWN_NOTIFICATION },
    { action: 'update', subject: 'Notification', conditions: OWN_NOTIFICATION },
    { action: 'delete', subject: 'Notification', conditions: OWN_NOTIFICATION },
  ],
  modifyDoneJobs: [{ action: 'reopen', subject: 'Job', conditions: null }],
  cancelJobs: [{ action: 'cancel', subject: 'Job', conditions: null }],
  // Multi-visit close-out (Q9). D15 stopped seeding `complete Job` for TECHNICIAN as a per-org
  // toggle, but the Roles & Permissions page had no cell for it - or for its four milestone
  // siblings - anywhere in MODULES/SENSITIVE/TOGGLES, so an admin could not see or grant any of
  // them there (only on the per-user Permissions page, userCapabilities.ts). This bundle is what
  // makes each one visible and toggleable at the role level.
  //
  // `conditions: OWN_JOB` is ONLY the seed for a role's FIRST-EVER grant of the action (no
  // existing row). It is NOT what gets written on every Save: role.controller.ts's
  // putRolePermissions preserves whatever condition an EXISTING row already carries for every key
  // in TOGGLE_KEYS, rather than re-stamping this default over it. That preserve step is load-
  // bearing here in a way it wasn't for modifyDoneJobs/cancelJobs above: confirmed on staging
  // (redacted-staging-ref, 2026-08-23), DISPATCHER holds all five of these grants UNCONDITIONALLY
  // (org-wide) while TECHNICIAN holds them OWN_JOB-scoped. A single hardcoded condition applied
  // unconditionally on Save would silently narrow every DISPATCHER's complete/start/arrive/
  // en_route/reschedule authority to "own job only" the next time anyone saved that role's page
  // for ANY reason. Do not remove the preserve step without re-verifying this against live data.
  enRouteJobs: [{ action: 'en_route', subject: 'Job', conditions: OWN_JOB }],
  arriveJobs: [{ action: 'arrive', subject: 'Job', conditions: OWN_JOB }],
  startJobs: [{ action: 'start', subject: 'Job', conditions: OWN_JOB }],
  completeJobs: [{ action: 'complete', subject: 'Job', conditions: OWN_JOB }],
  rescheduleJobs: [{ action: 'reschedule', subject: 'Job', conditions: OWN_JOB }],
} satisfies Record<string, ToggleGrant[]>;

export type ToggleKey = keyof typeof TOGGLES;

// Every (action,subject) pair any TOGGLES bundle can emit. Used by role.controller.ts's
// putRolePermissions to decide when a Save must PRESERVE the grant's existing stored condition
// instead of re-emitting the bundle's hardcoded seed - see the comment on the milestone-verb
// toggles above for why that distinction matters and is not merely defensive.
const TOGGLE_GRANT_KEYS = new Set(
  Object.values(TOGGLES).flatMap((bundle) => bundle.map((g) => `${g.action}:${g.subject}`)),
);
export function isToggleGrant(action: string, subject: string): boolean {
  return TOGGLE_GRANT_KEYS.has(`${action}:${subject}`);
}

export interface RoleViewModel {
  role: string;
  matrix: Record<string, CrudCell>;
  sensitive: { seeFinancials: boolean; managePayments: boolean; viewReports: boolean; editRecordIds: boolean };
  toggles: Record<ToggleKey, boolean>;
  scope: Record<string, ScopeValue>;
  general: { description: string };
}

const ACTION_BY_CELL = { read: 'read', create: 'create', update: 'update', delete: 'delete' } as const;

// Order-independent stringify so condition objects compare structurally.
function stableStringify(o: unknown): string {
  if (o === null || typeof o !== 'object') return JSON.stringify(o);
  if (Array.isArray(o)) return `[${o.map(stableStringify).join(',')}]`;
  return `{${Object.keys(o as object)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${stableStringify((o as Record<string, unknown>)[k])}`)
    .join(',')}}`;
}

/**
 * Which chip, if any, does this persisted condition correspond to? `null` means the editor has no
 * way to express it - see `isRepresentableScopeCondition`.
 */
function chipFor(subject: string, conditions: unknown): ScopeValue | null {
  if (conditions == null) return 'All';
  const conds = SCOPE_CONDITIONS[subject];
  if (!conds) return null;
  const condStr = stableStringify(conditions);
  for (const sv of ['Owned', 'Team', 'Location'] as ScopeValue[]) {
    if (stableStringify(conds[sv]) === condStr) return sv;
    if ((SCOPE_CONDITION_ALIASES[subject]?.[sv] ?? []).some((a) => stableStringify(a) === condStr)) {
      return sv;
    }
  }
  return null;
}

/**
 * Can the Roles editor REPRODUCE this persisted condition?
 *
 * Note the difference from `chipFor`, and it is the whole point: recognition is generous (an alias
 * lets the widened Job read display as "Owned"), reproduction is EXACT. The editor emits only
 * `SCOPE_CONDITIONS`, so an aliased shape can be shown but never re-written - a Save that stamped
 * the chip over it would silently replace assigned-OR-created with assigned-only, or creator-only
 * with assigned-only. The first loses access, the second GRANTS it to every assignee. Both are
 * changes the admin never asked for and could not see on screen.
 *
 * `putRolePermissions` consults this and preserves such rows verbatim. Unticking the box still
 * deletes the row, so an admin's ability to revoke is unaffected.
 */
export function isRepresentableScopeCondition(subject: string, conditions: unknown): boolean {
  if (conditions == null) return true;
  const conds = SCOPE_CONDITIONS[subject];
  if (!conds) return true; // not a scope subject - the emitter writes null and always could
  const condStr = stableStringify(conditions);
  return (['Owned', 'Team', 'Location'] as ScopeValue[]).some(
    (sv) => stableStringify(conds[sv]) === condStr,
  );
}

export function assembleRoleViewModel(role: string, grants: Grant[]): RoleViewModel {
  const has = (action: string, subject: string) =>
    grants.some((g) => g.action === action && g.subject === subject);

  const matrix: Record<string, CrudCell> = {};
  for (const m of MODULES) {
    matrix[m.subject] = {
      read: has('read', m.subject),
      create: has('create', m.subject),
      update: has('update', m.subject),
      delete: has('delete', m.subject),
    };
  }

  const scope: Record<string, ScopeValue> = {};
  for (const e of SCOPE_ENTITIES) {
    const readGrant = grants.find((g) => g.action === 'read' && g.subject === e.subject);
    scope[e.subject] = 'All';
    if (readGrant?.conditions) {
      scope[e.subject] = chipFor(e.subject, readGrant.conditions) ?? 'All';
    }
  }

  const sensitive = {
    seeFinancials: SENSITIVE.seeFinancials.every((s) => has(s.action, s.subject)),
    managePayments: SENSITIVE.managePayments.every((s) => has(s.action, s.subject)),
    viewReports: SENSITIVE.viewReports.every((s) => has(s.action, s.subject)),
    editRecordIds: SENSITIVE.editRecordIds.every((s) => has(s.action, s.subject)),
  };

  const toggles = {} as Record<ToggleKey, boolean>;
  for (const key of Object.keys(TOGGLES) as ToggleKey[]) {
    toggles[key] = TOGGLES[key].every((g) => has(g.action, g.subject));
  }

  return { role, matrix, sensitive, toggles, scope, general: { description: '' } };
}

export function viewModelToGrants(vm: RoleViewModel): Grant[] {
  const grants: Grant[] = [];
  const scopeSubjects = new Set<string>(SCOPE_ENTITIES.map((e) => e.subject));

  for (const m of MODULES) {
    const cell = vm.matrix[m.subject] ?? { read: false, create: false, update: false, delete: false };
    for (const key of ['read', 'create', 'update', 'delete'] as const) {
      if (!cell[key]) continue;
      const action = ACTION_BY_CELL[key];
      let conditions: Record<string, unknown> | null = null;
      // #106a: the owner/team/location condition must ride on read AND update AND
      // delete (mirroring the seed's OWN_* rows) — otherwise a Roles-UI Save strips
      // the scope off update/delete, leaving condition-less rules that match every row.
      // 'create' is deliberately excluded: it is structurally unenforceable in CASL
      // (there is no existing row to condition on), so it always persists as null.
      if (action !== 'create' && scopeSubjects.has(m.subject)) {
        const sv = (vm.scope[m.subject] ?? 'All') as ScopeValue;
        conditions = SCOPE_CONDITIONS[m.subject][sv];
      }
      grants.push({ action, subject: m.subject, conditions });
    }
  }

  if (vm.sensitive.seeFinancials)
    for (const s of SENSITIVE.seeFinancials) grants.push({ action: s.action, subject: s.subject, conditions: null });
  if (vm.sensitive.managePayments)
    for (const s of SENSITIVE.managePayments) grants.push({ action: s.action, subject: s.subject, conditions: null });
  // Read STRICTLY - no `?? vm.sensitive.seeFinancials` fallback. In the grant direction such a
  // fallback is a privilege escalation (a body with seeFinancials true and no viewReports would
  // hand the role the whole Reports and Billing surface), and this emitter cannot see the role's
  // `existing` rows, so it could never be lossless anyway. The legacy-body accommodation lives in
  // role.controller.ts's putRolePermissions, where `existing` IS in scope.
  if (vm.sensitive.viewReports)
    for (const s of SENSITIVE.viewReports) grants.push({ action: s.action, subject: s.subject, conditions: null });
  if (vm.sensitive.editRecordIds)
    for (const s of SENSITIVE.editRecordIds) grants.push({ action: s.action, subject: s.subject, conditions: null });

  // Each bundle carries its OWN conditions (see TOGGLES above) - never hardcode null here, or
  // `notifications` would emit an org-wide grant instead of the self-scope it actually means.
  for (const key of Object.keys(TOGGLES) as ToggleKey[]) {
    if (!vm.toggles?.[key]) continue;
    for (const g of TOGGLES[key]) grants.push({ action: g.action, subject: g.subject, conditions: g.conditions });
  }

  return grants;
}
