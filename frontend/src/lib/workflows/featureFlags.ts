/**
 * featureFlags.ts — the "Send text" step's per-org authoring lock.
 *
 * Whether an org can author a SEND_TEXT step is a fact about that org, not a
 * global switch: has it connected CTM, cleared A2P, left its own kill switch
 * on, and is it entitled to `phone`. GET /api/workflows/catalog computes all
 * four (backend/src/controllers/workflow.controller.ts) and serves the result
 * as `capabilities.sms_available` (SERV10X-70). A catalog that hasn't loaded
 * yet, or a stale fixture missing the field, is treated as locked — fail
 * closed, never show a step the org can't actually run.
 */
import type { WorkflowCatalog, WorkflowStepType } from '@/lib/api/workflows';

/** Pill shown on a locked step row. */
export const SMS_LOCKED_BADGE = 'Not connected';

/** Hover/focus tooltip explaining the locked step. */
export const SMS_LOCKED_TOOLTIP =
  'Connect a phone number in Communication settings to text customers from an automation.';

/** Conservative fallback for callers that don't yet know the org's capability. */
export const DEFAULT_LOCKED_STEP_TYPES: WorkflowStepType[] = ['SEND_TEXT'];

/** Step types the org cannot author yet, given the catalog's per-org capabilities. */
export function lockedStepTypesFor(catalog: WorkflowCatalog | undefined): WorkflowStepType[] {
  return catalog?.capabilities?.sms_available ? [] : ['SEND_TEXT'];
}
