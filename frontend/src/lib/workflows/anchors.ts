/**
 * anchors.ts — the AnchorKey type: entity DATE fields an anchored WAIT step or
 * a date-anchored trigger can target ("wait until 1 day before the
 * walkthrough" instead of "wait 1 day"). Mirrors backend/src/services/
 * automations/anchors.ts's AnchorKey (Task A1).
 *
 * The DATA this used to hand-sync (which anchors exist, their labels, which
 * entity offers which) is no longer duplicated here — it's served by the
 * catalog (GET /api/workflows/catalog → `anchors`, sourced from backend
 * catalog.ts's ANCHOR_OPTIONS) and read via `WorkflowCatalog['anchors']`
 * (lib/api/workflows.ts). This file is types only, so the anchor vocabulary
 * has a single source of truth (the catalog) while the shapes that reference
 * an anchor key (DateAnchorTriggerConfig, WaitForm's `anchor` prop) stay
 * compiler-checked against the real 4-member set.
 */

export type AnchorKey =
  | 'job.scheduled_start'
  | 'lead.walkthrough_scheduled_at'
  | 'invoice.due_date'
  | 'estimate.valid_until';

export type WaitDirection = 'before' | 'after';
