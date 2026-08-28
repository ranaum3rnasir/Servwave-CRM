import type { Grant } from './defineAbility';

type RoleGrant = Grant & { role: 'SALES' | 'DISPATCHER' | 'TECHNICIAN' };

// #925: the pre-recipients-split shape (`{ recipient_id }`) named a column that lives on
// NotificationRecipient, not Notification. `recipients.some.recipient_id` is the real relation
// path (Notification -> recipients[] -> NotificationRecipient.recipient_id), mirroring the
// `lead_assignees.some` idiom used below.
const OWN_NOTIFICATION       = { recipients: { some: { recipient_id: '{{userId}}' } } } as const;
const OWN_LEAD               = { lead_assignees: { some: { user_id: '{{userId}}' } } } as const;
// Multi-visit S8 (D6): crew lives on the VISIT, so "my job" is "a job with a trip I am on".
// Byte-identical in shape to OWN_WALKTHROUGH below, deliberately - one relation path, one
// meaning. This is NOT an equivalence-preserving rename: `Job.assignees` was S3's add-only
// union superset and this is a strict subset, so the S8 migration repoints the STORED value in
// role_permissions.conditions in the same PR. Changing this constant without that UPDATE
// reddens check-role-permission-drift --strict for every org; doing the UPDATE without this
// change re-seeds the dead path into the next org created.
const OWN_JOB                = { visits: { some: { assignees: { some: { user_id: '{{userId}}' } } } } } as const;
const OWN_JOB_VIA_ESTIMATE   = { estimate: { lead: { lead_assignees: { some: { user_id: '{{userId}}' } } } } } as const;
const OWN_INVOICE_VIA_JOB    = { job: { visits: { some: { assignees: { some: { user_id: '{{userId}}' } } } } } } as const;
const OWN_INVOICE_VIA_LEAD   = { job: { estimate: { lead: { lead_assignees: { some: { user_id: '{{userId}}' } } } } } } as const;
const OWN_ESTIMATE_VIA_LEAD  = { lead: { lead_assignees: { some: { user_id: '{{userId}}' } } } } as const;
// SERV10X-61 §8 - a SALES/row-scoped user owns an estimate either through the parent lead
// (lead-anchored) OR, for a lead-less (customer-anchored) estimate, by having created it. This
// mirrors canAccessEstimate's getById gate (lead ? owns-lead : created_by === self) so LIST and
// detail agree. The `lead_id: null` guard keeps the creator branch from broadening scope on
// lead-anchored rows (those stay own-via-lead only). substituteConditions.walk recurses into
// OR/AND arrays, so the nested {{userId}} is substituted correctly.
const OWN_ESTIMATE_VIA_LEAD_OR_CREATOR = {
  OR: [
    { lead: { lead_assignees: { some: { user_id: '{{userId}}' } } } },
    { AND: [{ lead_id: null }, { created_by: '{{userId}}' }] },
  ],
} as const;
// Walkthrough-as-entity redesign, PR-B2: performers now belong to a Walkthrough row, not the
// lead directly, so OWN_WALKTHROUGH is re-expressed as a nested relation through the join
// (Lead -> walkthroughs -> performers -> user_id) instead of the old direct
// `walkthrough_performers` relation. A technician who performed on ANY of a lead's visits
// (past or present) keeps read access to the lead - matching the pre-redesign behavior, where a
// lead had at most one walkthrough so "any visit" and "the current visit" were the same set.
const OWN_WALKTHROUGH        = { visits: { some: { assignees: { some: { user_id: '{{userId}}' } } } } } as const;
// CREATION CONFERS CONTROL (technician-ownership spec, Part B). Usable on ANY subject that carries
// a `created_by_id` column - the rule is system-wide, not a technician rule, so a role added later
// gets it with no per-role special case. A bare scalar condition: substituteConditions.walk
// recurses objects and arrays alike, so `{{userId}}` resolves here exactly as it does inside the
// nested relation shapes above.
//
// The grant it produces is PERMANENT and deliberately so: `created_by_id` is immutable, there is
// no transfer story, and a technician who made a job still controls it after a dispatcher hands
// the work to someone else. That permanence is the point of the design, not a side effect.
const CREATED_BY_ME          = { created_by_id: '{{userId}}' } as const;
// Read scope for a role that both works jobs and creates them. The OR is what makes the creator's
// access survive being taken off the crew - without it, an unassigned creator cannot see the job
// they made, and every downstream creator-scoped verb becomes unreachable (canActOnRow intersects
// the verb's scope with THIS one). Precedent: OWN_ESTIMATE_VIA_LEAD_OR_CREATOR above.
const OWN_OR_CREATED_JOB     = { OR: [OWN_JOB, CREATED_BY_ME] } as const;

const ALL_ROLES = ['SALES', 'DISPATCHER', 'TECHNICIAN'] as const;

// Baseline grants held by every role, regardless of role-specific capability — a future role
// inherits these automatically with zero work. `create Communication` lives here rather than in
// a per-role list: phone/comm access is gated at the org level (`requireFeature('phone')` /
// `useFeature('phone')`) and the user-ability check (`ability.can('create',
// 'Communication')`) is meant to be role-agnostic — any role in a comm-enabled org must pass it
// (ADMIN already does via `manage all`).
const SHARED_BASELINE: Omit<RoleGrant, 'role'>[] = [
  { action: 'create', subject: 'Communication' },
];

export const DEFAULT_GRANTS: RoleGrant[] = [
  // ─── SHARED BASELINE (every role) ────────────────────────────────────
  ...ALL_ROLES.flatMap((role) => SHARED_BASELINE.map((g) => ({ role, ...g }))),

  // ─── SALES ───────────────────────────────────────────────────────────
  // Multi-assignee design §3: NO `assign Task` row here (nor for DISPATCHER/TECHNICIAN below).
  // Tasks are an office tool, but opening work for OTHER people is an admin/manager capability;
  // ADMIN holds it through `manage all` (defineAbility.ts:90) and a custom role can be given it
  // from the catalog entry. Without it a caller may only ever put themselves on a task.
  { role: 'SALES', action: 'read',                 subject: 'Task'         },
  { role: 'SALES', action: 'create',               subject: 'Task'         },
  { role: 'SALES', action: 'update',               subject: 'Task'         },
  { role: 'SALES', action: 'delete',               subject: 'Task'         },
  // SALES intentionally has NO `read Dashboard` (MISS-1): the company dashboard aggregates
  // org-wide financials (revenue, AR aging, per-technician scoreboard) and SALES is row-scoped
  // everywhere else — the dashboard is admin/dispatcher-only.
  { role: 'SALES', action: 'read',                 subject: 'Customer'     },
  { role: 'SALES', action: 'update',               subject: 'Customer'     },
  { role: 'SALES', action: 'export',               subject: 'Customer'     },
  { role: 'SALES', action: 'create',               subject: 'Lead'         },
  { role: 'SALES', action: 'read',                 subject: 'Lead',         conditions: OWN_LEAD },
  { role: 'SALES', action: 'update',               subject: 'Lead',         conditions: OWN_LEAD },
  { role: 'SALES', action: 'contact',              subject: 'Lead',         conditions: OWN_LEAD },
  { role: 'SALES', action: 'mark_lost',            subject: 'Lead',         conditions: OWN_LEAD },
  { role: 'SALES', action: 'cancel',               subject: 'Lead',         conditions: OWN_LEAD },
  { role: 'SALES', action: 'delete',               subject: 'Lead',         conditions: OWN_LEAD },
  { role: 'SALES', action: 'schedule_walkthrough', subject: 'Lead',         conditions: OWN_LEAD },
  { role: 'SALES', action: 'perform_walkthrough',  subject: 'Lead',         conditions: OWN_LEAD },
  { role: 'SALES', action: 'create',               subject: 'Estimate'     },
  { role: 'SALES', action: 'read',                 subject: 'Estimate',     conditions: OWN_ESTIMATE_VIA_LEAD_OR_CREATOR },
  { role: 'SALES', action: 'update',               subject: 'Estimate'     },
  { role: 'SALES', action: 'delete',               subject: 'Estimate'     },
  { role: 'SALES', action: 'send',                 subject: 'Estimate'     },
  // 'cancel' + 'archive' both granted — 'archive' is the new action name (catalog.ts); 'cancel'
  // stays a legacy alias for persisted UserPermissionOverride rows. Same grant either way.
  { role: 'SALES', action: 'cancel',               subject: 'Estimate'     },
  { role: 'SALES', action: 'archive',              subject: 'Estimate'     },
  { role: 'SALES', action: 'duplicate',            subject: 'Estimate'     },
  { role: 'SALES', action: 'revise',               subject: 'Estimate'     },
  // R4 (2026-07-21) — lifecycle verbs (port-plan §5). approve-internal/decline-internal are
  // SALES-grantable (the same population that can send/cancel); void_approval (D13's guarded
  // unwind) is deliberately ADMIN-only — no grant row for it, ADMIN reaches it via `manage all`.
  { role: 'SALES', action: 'approve',              subject: 'Estimate'     },
  { role: 'SALES', action: 'decline',              subject: 'Estimate'     },
  { role: 'SALES', action: 'read',                 subject: 'Job',          conditions: OWN_JOB_VIA_ESTIMATE },
  { role: 'SALES', action: 'read',                 subject: 'Invoice',      conditions: OWN_INVOICE_VIA_LEAD },
  { role: 'SALES', action: 'manage_lines',         subject: 'Invoice',      conditions: OWN_INVOICE_VIA_LEAD },
  { role: 'SALES', action: 'read',                 subject: 'PriceBook'    },
  // SRVW-140 - `read Pricing` is what canSeePricing keys on (the Roles UI "See financial data"
  // switch). SALES keeps cost/price visibility because a salesperson cannot author an estimate
  // without prices; this row preserves exactly what SALES saw before the repoint.
  { role: 'SALES', action: 'read',                 subject: 'Pricing'      },
  { role: 'SALES', action: 'read',                 subject: 'Tag'          },
  { role: 'SALES', action: 'create',               subject: 'Tag'          },
  { role: 'SALES', action: 'read',                 subject: 'Department'   },
  { role: 'SALES', action: 'read',                 subject: 'StateTaxRate' },
  { role: 'SALES', action: 'read',                 subject: 'AppSetting'   },
  { role: 'SALES', action: 'read',                 subject: 'Organization' },
  { role: 'SALES', action: 'create',               subject: 'Attachment'   },
  { role: 'SALES', action: 'read',                 subject: 'Attachment'   },
  { role: 'SALES', action: 'update',               subject: 'Attachment'   },
  { role: 'SALES', action: 'delete',               subject: 'Attachment'   },
  { role: 'SALES', action: 'read',                 subject: 'Inventory'    },
  { role: 'SALES', action: 'read',                 subject: 'Communication' },
  // Logistic Orders (LO-1): SALES raises material requests and submits them for approval, but
  // never approves (capability-only) and never processes (that deducts stock — dispatcher/admin).
  { role: 'SALES', action: 'read',                 subject: 'LogisticOrder' },
  { role: 'SALES', action: 'create',               subject: 'LogisticOrder' },
  { role: 'SALES', action: 'submit',               subject: 'LogisticOrder' },

  // ─── DISPATCHER ──────────────────────────────────────────────────────
  // NOTE: no `assign Task` — see the SALES block above.
  { role: 'DISPATCHER', action: 'read',                 subject: 'Task'         },
  { role: 'DISPATCHER', action: 'create',               subject: 'Task'         },
  { role: 'DISPATCHER', action: 'update',               subject: 'Task'         },
  { role: 'DISPATCHER', action: 'delete',               subject: 'Task'         },
  { role: 'DISPATCHER', action: 'read',                 subject: 'Dashboard'    },
  { role: 'DISPATCHER', action: 'create',               subject: 'Customer'     },
  { role: 'DISPATCHER', action: 'read',                 subject: 'Customer'     },
  { role: 'DISPATCHER', action: 'update',               subject: 'Customer'     },
  { role: 'DISPATCHER', action: 'delete',               subject: 'Customer'     },
  { role: 'DISPATCHER', action: 'export',               subject: 'Customer'     },
  { role: 'DISPATCHER', action: 'archive',              subject: 'Customer'     },
  // Editable record IDs - DISPATCHER holds this by default (plan decision #7); ADMIN gets it via
  // manage-all, no row needed.
  { role: 'DISPATCHER', action: 'renumber',             subject: 'Customer'     },
  { role: 'DISPATCHER', action: 'create',               subject: 'Lead'         },
  { role: 'DISPATCHER', action: 'read',                 subject: 'Lead'         },
  { role: 'DISPATCHER', action: 'update',               subject: 'Lead'         },
  { role: 'DISPATCHER', action: 'assign',               subject: 'Lead'         },
  { role: 'DISPATCHER', action: 'contact',              subject: 'Lead'         },
  { role: 'DISPATCHER', action: 'mark_lost',            subject: 'Lead'         },
  { role: 'DISPATCHER', action: 'cancel',               subject: 'Lead'         },
  { role: 'DISPATCHER', action: 'delete',               subject: 'Lead'         },
  { role: 'DISPATCHER', action: 'schedule_walkthrough', subject: 'Lead'         },
  { role: 'DISPATCHER', action: 'perform_walkthrough',  subject: 'Lead'         },
  // Editable record IDs - DISPATCHER holds this by default (plan decision #7); ADMIN gets it via
  // manage-all, no row needed.
  { role: 'DISPATCHER', action: 'renumber',             subject: 'Lead'         },
  { role: 'DISPATCHER', action: 'read',                 subject: 'Estimate'     },
  { role: 'DISPATCHER', action: 'record_payment',       subject: 'Estimate'     },
  { role: 'DISPATCHER', action: 'waive_deposit',        subject: 'Estimate'     },
  // reactivate_deposit folded out (Phase 5) — unified Invoice refund replaces deposit refund.
  // Editable record IDs - DISPATCHER holds this by default (plan decision #7); ADMIN gets it via
  // manage-all, no row needed.
  { role: 'DISPATCHER', action: 'renumber',             subject: 'Estimate'     },
  { role: 'DISPATCHER', action: 'create',               subject: 'Job'          },
  { role: 'DISPATCHER', action: 'read',                 subject: 'Job'          },
  { role: 'DISPATCHER', action: 'update',               subject: 'Job'          },
  // Split out of `update Job` (technician-ownership spec, Part C). Granted wherever `update Job`
  // is granted, under the SAME condition, so no role's effective access changes: the split only
  // creates the seam that PR 3 then moves.
  { role: 'DISPATCHER', action: 'manage_lines',         subject: 'Job'          },
  { role: 'DISPATCHER', action: 'delete',               subject: 'Job'          },
  { role: 'DISPATCHER', action: 'assign',               subject: 'Job'          },
  { role: 'DISPATCHER', action: 'unassign',             subject: 'Job'          },
  { role: 'DISPATCHER', action: 'en_route',             subject: 'Job'          },
  { role: 'DISPATCHER', action: 'arrive',               subject: 'Job'          },
  { role: 'DISPATCHER', action: 'start',                subject: 'Job'          },
  { role: 'DISPATCHER', action: 'complete',             subject: 'Job'          },
  { role: 'DISPATCHER', action: 'cancel',               subject: 'Job'          },
  // D14 (Spec A, 2026-07-21): `reschedule` is a brand-new action with no prior grant anywhere.
  // DISPATCHER already holds unconditional `update Job`; reschedule must follow the same
  // authority or the D14 guard would 403 dispatchers on their own jobs. ADMIN passes via
  // manage-all with no row needed here.
  { role: 'DISPATCHER', action: 'reschedule',           subject: 'Job'          },
  // Editable record IDs - DISPATCHER holds this by default (plan decision #7); ADMIN gets it via
  // manage-all, no row needed.
  { role: 'DISPATCHER', action: 'renumber',             subject: 'Job'          },
  { role: 'DISPATCHER', action: 'create',               subject: 'Invoice'      },
  { role: 'DISPATCHER', action: 'read',                 subject: 'Invoice'      },
  { role: 'DISPATCHER', action: 'update',               subject: 'Invoice'      },
  { role: 'DISPATCHER', action: 'manage_lines',         subject: 'Invoice'      },
  { role: 'DISPATCHER', action: 'delete',               subject: 'Invoice'      },
  { role: 'DISPATCHER', action: 'send',                 subject: 'Invoice'      },
  { role: 'DISPATCHER', action: 'record_payment',       subject: 'Invoice'      },
  // Editable record IDs - DISPATCHER holds this by default (plan decision #7); ADMIN gets it via
  // manage-all, no row needed.
  { role: 'DISPATCHER', action: 'renumber',             subject: 'Invoice'      },
  { role: 'DISPATCHER', action: 'read',                 subject: 'PriceBook'    },
  { role: 'DISPATCHER', action: 'read',                 subject: 'Tag'          },
  { role: 'DISPATCHER', action: 'create',               subject: 'Tag'          },
  { role: 'DISPATCHER', action: 'read',                 subject: 'Department'   },
  { role: 'DISPATCHER', action: 'read',                 subject: 'Report'       },
  // SRVW-140 - see the SALES row above. DISPATCHER owns ops and already saw every cost.
  { role: 'DISPATCHER', action: 'read',                 subject: 'Pricing'      },
  { role: 'DISPATCHER', action: 'read',                 subject: 'StateTaxRate' },
  { role: 'DISPATCHER', action: 'read',                 subject: 'AppSetting'   },
  { role: 'DISPATCHER', action: 'read',                 subject: 'Organization' },
  { role: 'DISPATCHER', action: 'read',                 subject: 'User'         },
  { role: 'DISPATCHER', action: 'create',               subject: 'Attachment'   },
  { role: 'DISPATCHER', action: 'read',                 subject: 'Attachment'   },
  { role: 'DISPATCHER', action: 'update',               subject: 'Attachment'   },
  { role: 'DISPATCHER', action: 'delete',               subject: 'Attachment'   },
  { role: 'DISPATCHER', action: 'read',                 subject: 'Inventory'    },
  { role: 'DISPATCHER', action: 'create',               subject: 'Inventory'    },
  { role: 'DISPATCHER', action: 'update',               subject: 'Inventory'    },
  { role: 'DISPATCHER', action: 'delete',               subject: 'Inventory'    },
  // Purchasing split (inventory P0, D11): POs + vendors are dispatcher/admin-only by default.
  { role: 'DISPATCHER', action: 'read',                 subject: 'PurchaseOrder' },
  { role: 'DISPATCHER', action: 'create',               subject: 'PurchaseOrder' },
  { role: 'DISPATCHER', action: 'update',               subject: 'PurchaseOrder' },
  { role: 'DISPATCHER', action: 'delete',               subject: 'PurchaseOrder' },
  { role: 'DISPATCHER', action: 'read',                 subject: 'Vendor'        },
  { role: 'DISPATCHER', action: 'create',               subject: 'Vendor'        },
  { role: 'DISPATCHER', action: 'update',               subject: 'Vendor'        },
  { role: 'DISPATCHER', action: 'delete',               subject: 'Vendor'        },
  // Logistic Orders (LO-1, D11-style posture): dispatcher/admin own the fulfilment side —
  // read/create/update the order and `process` it (the stock-deducting step) or `cancel` it.
  // NO `submit` (that is the requester's verb) and NO `approve` (capability-only, per-user —
  // kept out of role_permissions by viewModelToGrants' emittable surface plus putRolePermissions'
  // isCatalogEntry filter; see the gate note in catalog.ts, NOT by catalog membership alone).
  //
  // ⚠️ LO-2+ CONTROLLER AUTHORS: these reads are UNCONDITIONAL, which makes scopeWhereFor return
  // {} and therefore makes canAccessRow(req,'LogisticOrder',…) return true WITHOUT running any
  // tenancy query — it is NOT a cross-org gate for this subject. Spread tenantWhere(req) into
  // every LO where clause yourself. Full explanation: the LogisticOrder banner in scopeWhereFor.ts.
  { role: 'DISPATCHER', action: 'read',                 subject: 'LogisticOrder' },
  { role: 'DISPATCHER', action: 'create',               subject: 'LogisticOrder' },
  { role: 'DISPATCHER', action: 'update',               subject: 'LogisticOrder' },
  { role: 'DISPATCHER', action: 'process',              subject: 'LogisticOrder' },
  { role: 'DISPATCHER', action: 'cancel',               subject: 'LogisticOrder' },
  { role: 'DISPATCHER', action: 'read',                 subject: 'Communication' },
  // `create Communication` for DISPATCHER now comes from the shared baseline above.
  { role: 'DISPATCHER', action: 'update',               subject: 'Communication' },
  { role: 'DISPATCHER', action: 'delete',               subject: 'Communication' },
  { role: 'DISPATCHER', action: 'read',                 subject: 'Location'      },
  { role: 'DISPATCHER', action: 'read',                 subject: 'ServicePlan'   },
  { role: 'DISPATCHER', action: 'create',               subject: 'ServicePlan'   },
  { role: 'DISPATCHER', action: 'update',               subject: 'ServicePlan'   },
  { role: 'DISPATCHER', action: 'delete',               subject: 'ServicePlan'   },
  // Automation Center — org-level config; DISPATCHER manages, SALES/TECHNICIAN have no access
  { role: 'DISPATCHER', action: 'read',                 subject: 'Automation'    },
  { role: 'DISPATCHER', action: 'create',               subject: 'Automation'    },
  { role: 'DISPATCHER', action: 'update',               subject: 'Automation'    },
  { role: 'DISPATCHER', action: 'delete',               subject: 'Automation'    },
  // Calendar Entries (Slice 01, spec §4). Default grant is ADMIN + DISPATCHER; ADMIN reaches it
  // via the manage-all bypass (no row needed), so DISPATCHER holds the only explicit rows here.
  // No conditions: visibility is org-wide (ADR 0002) - there is no ownership chain to scope on.
  // SALES and TECHNICIAN deliberately get NO rows - a SALES user who needs it gets it through
  // UserPermissionOverride (userCapabilities.ts), never by role.
  { role: 'DISPATCHER', action: 'read',                 subject: 'CalendarEntry' },
  { role: 'DISPATCHER', action: 'create',               subject: 'CalendarEntry' },
  { role: 'DISPATCHER', action: 'update',               subject: 'CalendarEntry' },
  { role: 'DISPATCHER', action: 'delete',               subject: 'CalendarEntry' },

  // ─── TECHNICIAN (strict default — Phase B) ───────────────────────────
  // A technician by default can read their assigned job, read + perform the walkthrough on their
  // assigned lead, upload/download attachments, plus the infra reads the app shell needs. The
  // intermediate advance verbs (en_route/arrive/start) and create/update Job·Invoice·Lead·Estimate,
  // record_payment remain opt-in per-user toggles.
  //
  // Multi-visit S4 (D15): `complete Job` is NO LONGER seeded. Closing the JOB is a dispatcher/admin
  // capability by default (D7a); what a technician closes is their own VISIT, which rides the
  // `start Job` gate they still hold. Removing the row here - and nothing else - produces exactly
  // "on for existing orgs, off by default for new ones", because role grants are per-org
  // role_permissions rows seeded from this table ONLY at org creation. That is the whole mechanism;
  // there is deliberately no migration. See PRESERVED_ON_RESET below for the other half.
  // `perform_walkthrough` is the narrow lead capability that replaces the broad `update Lead`
  // a tech used to hold via OWN_WALKTHROUGH (the only thing a tech does on a lead).
  { role: 'TECHNICIAN', action: 'read',                subject: 'Task'     },
  { role: 'TECHNICIAN', action: 'create',              subject: 'Task'     },
  { role: 'TECHNICIAN', action: 'update',              subject: 'Task'     },
  // NOTE: TECHNICIAN intentionally has NO delete:Task grant. The one thing they can still delete
  // is a to-do they created AND are the sole assignee of - a row-level exception inside
  // task.controller.remove (design §3), NOT a grant, so an office task they merely reached
  // through a linked job stays undeletable.
  // NOTE: and no assign:Task - see the SALES block above.
  { role: 'TECHNICIAN', action: 'read',                subject: 'Lead',    conditions: OWN_WALKTHROUGH },
  { role: 'TECHNICIAN', action: 'perform_walkthrough', subject: 'Lead',    conditions: OWN_WALKTHROUGH },
  // Technician-ownership spec, Part C. Two scopes now, and the split is the whole design:
  //   OWN_JOB              - the WORK surface. What an assignee does on a job somebody handed them.
  //   CREATED_BY_ME        - the CONTROL surface. What only the person who made the job may do.
  //   OWN_OR_CREATED_JOB   - read, which must cover both or the control surface is unreachable.
  // Enforced per-instance by canActOnRow (lib/permissions/enforce.ts), which intersects the verb's
  // scope with the read scope. A route guard alone cannot tell these apart: canDo is subject-level.
  { role: 'TECHNICIAN', action: 'read',                subject: 'Job',     conditions: OWN_OR_CREATED_JOB },
  // `create Job` was a per-user toggle; it is a role default now. The creator is auto-assigned by
  // job.controller.create's row-scoped-creator branch, so a technician's own new job is an
  // assigned job from the first moment - the creator scope is what keeps it theirs afterwards.
  { role: 'TECHNICIAN', action: 'create',              subject: 'Job'      },
  // The control surface. `delete` stays bounded by the pre-existing integrity rule (a job carrying
  // ANY invoice, voided included, cannot be deleted at all). assign/unassign are Ran's "they can
  // take people off the job".
  { role: 'TECHNICIAN', action: 'assign',              subject: 'Job',     conditions: CREATED_BY_ME },
  { role: 'TECHNICIAN', action: 'unassign',            subject: 'Job',     conditions: CREATED_BY_ME },
  { role: 'TECHNICIAN', action: 'delete',              subject: 'Job',     conditions: CREATED_BY_ME },
  // Prices, totals, job cost and margin. Org-wide, not row-scoped: `Pricing` is not a
  // ScopeResource, so a condition here would be inert AND misleading. This is the same grant the
  // Roles UI "See financial data" switch writes, and canSeePricing (enforce.ts) is its only reader.
  { role: 'TECHNICIAN', action: 'read',                subject: 'Pricing'  },
  // Standalone estimates. Attaching one to an EXISTING job is not a route - estimates carry no
  // job_id, the link is Job.estimate_id - so it lands on PATCH /:id's field-level manage_lines
  // check (PR 2), not here.
  { role: 'TECHNICIAN', action: 'create',              subject: 'Estimate' },
  // Live QA, 2026-08-05: `create Estimate` above landed with no matching `read`, so a technician's
  // own standalone estimate was invisible to its own creator (list scope resolved to
  // MATCH_NOTHING). A technician's estimate is always lead-less, so it lands on the creator arm of
  // OWN_ESTIMATE_VIA_LEAD_OR_CREATOR - the same condition SALES already holds for this shape, and
  // the one canAccessEstimate's getById gate mirrors, so list and detail agree.
  { role: 'TECHNICIAN', action: 'read',                subject: 'Estimate', conditions: OWN_ESTIMATE_VIA_LEAD_OR_CREATOR },
  // Main-app migration (Spec A D3, 2026-07-21). `update` is the single gate on notes, line items
  // and job field edits — see D14 for why rescheduling still needs its own field-level check.
  // `start`/`arrive` are pre-grants for Spec B1: no Start button or On Site node exists in the
  // main app yet, so neither verb is reachable until B1 ships. Granted here so the role
  // definition lands in one migration rather than two.
  // ⚠️ `update Job` is the one grant left on OWN_JOB - it gates notes, tags and sub-status after
  // PR 2's split, and Part C's table says keep. Note the condition here is NOT what actually gates
  // those routes: addNote/setSubStatus check `canAccessRow`, which derives from the READ grant, so
  // an unassigned creator reaches them anyway (pinned in job-creator-control.test.ts). The grant
  // condition and the enforced condition therefore disagree for exactly this row. Widening it to
  // OWN_OR_CREATED_JOB would make them agree and change no behaviour; not taken here because Part C
  // says keep and the call is Ran's.
  { role: 'TECHNICIAN', action: 'update',              subject: 'Job',     conditions: OWN_JOB },
  // Line items, scopes of work, and the job's tax/discount fields. PR 2 landed this on OWN_JOB
  // purely for neutrality; this is the re-point it existed for. Money follows CREATION, not
  // assignment - the live-QA bug that started the spec was an assigned technician typing a price
  // into a line item and having it silently discarded.
  { role: 'TECHNICIAN', action: 'manage_lines',        subject: 'Job',     conditions: CREATED_BY_ME },
  { role: 'TECHNICIAN', action: 'start',               subject: 'Job',     conditions: OWN_JOB },
  { role: 'TECHNICIAN', action: 'arrive',              subject: 'Job',     conditions: OWN_JOB },
  // Inventory P3: the catalog is org-wide reference data (same as SALES/DISPATCHER above) — the
  // tech picker feed + /api/inventory/my-van gate on it. Cost fields stay stripped server-side
  // (canSeePricing = the `read Pricing` grant written by the Roles UI "See financial data"
  // switch, which a bare tech lacks - SRVW-140; it was `read Invoice` before). Backfilled for
  // existing orgs by 20260717120000_technician_pricebook_read_backfill.
  { role: 'TECHNICIAN', action: 'read',                subject: 'PriceBook'    },
  { role: 'TECHNICIAN', action: 'read',                subject: 'Department'   },
  { role: 'TECHNICIAN', action: 'read',                subject: 'AppSetting'   },
  { role: 'TECHNICIAN', action: 'read',                subject: 'Organization' },
  // Crew names on the technician's own calendar and job pages (main-app migration, ruled
  // 2026-07-21: unconditional — a technician seeing their coworkers is a company directory, not
  // a leak, and `User` is not a ScopeResource so a conditional grant here would be inert).
  // tenantWhere keeps this org-local.
  { role: 'TECHNICIAN', action: 'read',                subject: 'User'         },
  { role: 'TECHNICIAN', action: 'create',              subject: 'Attachment'   },
  { role: 'TECHNICIAN', action: 'read',                subject: 'Attachment'   },
  // Communication visibility (email slice 8a). UNCONDITIONAL at the subject level, exactly as
  // SALES holds it - `Communication` is not a ScopeResource, so a condition here would be inert
  // AND misleading (it would read as if the grant carried the row scope). The row scope comes
  // from lib/permissions/anchorVisibility.ts, which rides the OWN_JOB / OWN_WALKTHROUGH grants
  // above: a technician sees the comms hanging off a job they are assigned to (and a lead they
  // walked), plus every unanchored / customer-only / vendor-only row, which is org-wide by
  // design. Backfilled for existing orgs by 20260804210000_technician_communication_read_backfill.
  //
  // ⚠️ THIS GRANT IS ONLY SAFE BECAUSE OF THAT ROW FILTER. Before slice 8a the four comm list
  // endpoints were tenant-only findManys, so without the filter this grant shows every technician
  // every conversation in the org. `update`/`delete Communication` stay DISPATCHER+.
  { role: 'TECHNICIAN', action: 'read',                subject: 'Communication' },
  // Logistic Orders: NO TECHNICIAN grant in v1 (spec §12 rec 5, signed). There is no technician
  // LO surface to read, and an own-job-scoped read would widen scope for a UI that does not exist.
  // Re-add with the new tech app as:
  //   { role: 'TECHNICIAN', action: 'read', subject: 'LogisticOrder', conditions: OWN_INVOICE_VIA_JOB }
  // (an LO anchored by job_id takes the identical `{ job: { assignees: … } }` shape).

  // ─── NOTIFICATIONS (own-row grants — ADMIN gets this via manage-all) ──
  { role: 'SALES',       action: 'read',   subject: 'Notification', conditions: OWN_NOTIFICATION },
  { role: 'SALES',       action: 'update', subject: 'Notification', conditions: OWN_NOTIFICATION },
  { role: 'SALES',       action: 'delete', subject: 'Notification', conditions: OWN_NOTIFICATION },
  { role: 'DISPATCHER',  action: 'read',   subject: 'Notification', conditions: OWN_NOTIFICATION },
  { role: 'DISPATCHER',  action: 'update', subject: 'Notification', conditions: OWN_NOTIFICATION },
  { role: 'DISPATCHER',  action: 'delete', subject: 'Notification', conditions: OWN_NOTIFICATION },
  { role: 'TECHNICIAN',  action: 'read',   subject: 'Notification', conditions: OWN_NOTIFICATION },
  { role: 'TECHNICIAN',  action: 'update', subject: 'Notification', conditions: OWN_NOTIFICATION },
  { role: 'TECHNICIAN',  action: 'delete', subject: 'Notification', conditions: OWN_NOTIFICATION },
];

/**
 * Grants the platform deliberately STOPPED seeding but must never take away from an org that
 * already holds them (D15a).
 *
 * Reset-to-defaults rebuilds an org's rows purely from DEFAULT_GRANTS, so without this list the
 * first admin who pressed "reset to defaults" would silently strip their technicians of a
 * capability they had been using for months - the exact opposite of what D15 promises them. The
 * drift checker reads the same list, so a live org carrying the row stops being reported as
 * carrying an extra one.
 *
 * A grant belongs here only when it was REMOVED from DEFAULT_GRANTS on purpose while remaining
 * valid for orgs that have it. It is not a place to park a grant that should simply be seeded.
 */
export const PRESERVED_ON_RESET: readonly { action: string; subject: string }[] = [
  // Multi-visit S4 (D15): technician job completion.
  { action: 'complete', subject: 'Job' },
];
