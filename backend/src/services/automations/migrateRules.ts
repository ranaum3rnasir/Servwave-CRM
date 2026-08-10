/**
 * migrateRules.ts — pure fold of a legacy AutomationRule into a published,
 * one-step Workflow (+ its v1 definition).
 *
 * Every AutomationRule that existed before the workflow builder shipped folds
 * into an equivalent single-step Workflow, so the new engine can serve it
 * from day one with ZERO behavior change: same trigger, same send window,
 * same single action, just re-homed as step 0 of a 1-step workflow.
 *
 * This module is the executable spec for that fold. The idempotent SQL
 * backfill (prisma/migrations/<ts>_workflow_backfill_rules/migration.sql)
 * inserts the same three rows (workflow, step, version) directly in the DB
 * and must stay in lockstep with the semantics here — each file
 * cross-references the other.
 */

import { AutomationRule, WorkflowStepType, AutomationActionType } from '@prisma/client';

/** AutomationActionType → WorkflowStepType for the fold. Mirrored by the CASE in the backfill SQL. */
export function mapActionToStepType(action: AutomationActionType): WorkflowStepType {
  switch (action) {
    case 'SEND_EMAIL':
      return 'SEND_EMAIL';
    case 'SEND_SMS':
      return 'SEND_TEXT';
    case 'NOTIFY_TEAM':
      return 'NOTIFY_TEAM';
    default: {
      const unhandled: never = action;
      throw new Error(`mapActionToStepType: unhandled AutomationActionType ${String(unhandled)}`);
    }
  }
}

export interface FoldedWorkflow {
  workflow: {
    name: string;
    status: 'PUBLISHED';
    is_enabled: boolean;
    trigger_type: AutomationRule['trigger_type'];
    trigger_config: unknown | null; // passthrough
    send_window: AutomationRule['send_window'];
    template_key: string | null;
    legacy_rule_id: string;
    trigger_count: number;
    last_triggered_at: Date | null;
    created_by_id: string | null;
    organization_id: string;
  };
  step: {
    position: 0;
    step_type: WorkflowStepType;
    config: unknown; // action_config passthrough, IDENTICAL shape
    organization_id: string;
  };
  versionDefinition: {
    trigger_type: AutomationRule['trigger_type'];
    trigger_config: unknown | null;
    send_window: AutomationRule['send_window'];
    steps: Array<{ position: 0; step_type: WorkflowStepType; config: unknown }>;
  };
}

/** Pure fold: one AutomationRule → one published 1-step Workflow (+ v1 definition). */
export function foldRuleToWorkflow(rule: AutomationRule): FoldedWorkflow {
  const step_type = mapActionToStepType(rule.action_type);
  const step = {
    position: 0 as const,
    step_type,
    config: rule.action_config,
    organization_id: rule.organization_id,
  };

  return {
    workflow: {
      name: rule.name,
      status: 'PUBLISHED',
      is_enabled: rule.is_enabled,
      trigger_type: rule.trigger_type,
      trigger_config: rule.trigger_config,
      send_window: rule.send_window,
      template_key: rule.template_key,
      legacy_rule_id: rule.id,
      trigger_count: rule.trigger_count,
      last_triggered_at: rule.last_triggered_at,
      created_by_id: rule.created_by_id,
      organization_id: rule.organization_id,
    },
    step,
    versionDefinition: {
      trigger_type: rule.trigger_type,
      trigger_config: rule.trigger_config,
      send_window: rule.send_window,
      steps: [{ position: step.position, step_type: step.step_type, config: step.config }],
    },
  };
}
