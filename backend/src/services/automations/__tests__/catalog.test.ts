import { describe, it, expect } from 'vitest';
import { AutomationTriggerType, AutomationActionType, WorkflowStepType } from '@prisma/client';
import {
  TRIGGERS,
  ACTIONS,
  TEMPLATES,
  MERGE_FIELD_LABELS,
  SAMPLE_CONTEXT,
  recipientsFor,
  audiencesFor,
  AUDIENCES,
  ANCHOR_OPTIONS,
  type AutomationTemplate,
} from '../catalog';
import { validateWorkflowDefinition } from '../workflowValidation';

const ALL_TRIGGERS = Object.values(AutomationTriggerType);
const ALL_ACTIONS = Object.values(AutomationActionType);

/** Extract {{merge.fields}} used in a piece of template copy. */
function fieldsIn(text: string): string[] {
  return [...text.matchAll(/\{\{([a-z_.]+)\}\}/g)].map((m) => m[1]);
}

describe('automation catalog — triggers', () => {
  it('defines every AutomationTriggerType with label, description, entity and category', () => {
    for (const t of ALL_TRIGGERS) {
      const def = TRIGGERS[t];
      expect(def, `missing TRIGGERS entry for ${t}`).toBeDefined();
      expect(def.label.length).toBeGreaterThan(3);
      expect(def.description.length).toBeGreaterThan(10);
      expect(['job', 'estimate', 'invoice', 'lead']).toContain(def.entity);
      expect(['events', 'timed', 'date']).toContain(def.category);
    }
  });

  it('time-based triggers carry a positive default offset; event triggers none', () => {
    for (const t of ALL_TRIGGERS) {
      const def = TRIGGERS[t];
      if (def.category === 'timed') {
        expect(def.timeBased).toBe(true);
        expect(def.defaultOffsetMinutes, `${t} needs defaultOffsetMinutes`).toBeGreaterThan(0);
      } else {
        expect(def.timeBased).toBe(false);
        expect(def.defaultOffsetMinutes).toBeUndefined();
      }
    }
  });

  it('every trigger exposes org + customer merge fields at minimum', () => {
    for (const t of ALL_TRIGGERS) {
      expect(TRIGGERS[t].mergeFields).toEqual(
        expect.arrayContaining(['org.name', 'customer.first_name']),
      );
    }
  });
});

describe('automation catalog — actions & recipients', () => {
  it('defines every AutomationActionType', () => {
    for (const a of ALL_ACTIONS) {
      expect(ACTIONS[a], `missing ACTIONS entry for ${a}`).toBeDefined();
    }
  });

  it('only offers assigned_techs recipients on job-entity triggers', () => {
    expect(recipientsFor('TECH_ASSIGNED', 'NOTIFY_TEAM')).toContain('assigned_techs');
    expect(recipientsFor('BEFORE_JOB_START', 'SEND_EMAIL')).toContain('assigned_techs');
    expect(recipientsFor('INVOICE_OVERDUE', 'SEND_EMAIL')).not.toContain('assigned_techs');
    expect(recipientsFor('LEAD_CREATED', 'NOTIFY_TEAM')).not.toContain('assigned_techs');
  });

  it('SMS is customer-only (no SMS provider for team numbers yet)', () => {
    for (const t of ALL_TRIGGERS) {
      expect(recipientsFor(t, 'SEND_SMS')).toEqual(['customer']);
    }
  });
});

describe('automation catalog — merge-field registry', () => {
  it('labels and sample values exist for every merge field any trigger offers', () => {
    const all = new Set(ALL_TRIGGERS.flatMap((t) => TRIGGERS[t].mergeFields));
    for (const f of all) {
      expect(MERGE_FIELD_LABELS[f], `missing label for {{${f}}}`).toBeTruthy();
      expect(SAMPLE_CONTEXT[f], `missing sample value for {{${f}}}`).toBeTruthy();
    }
  });
});

describe('automation catalog — prebuilt templates', () => {
  it('ships a meaningful gallery with unique keys across the three categories', () => {
    expect(TEMPLATES.length).toBeGreaterThanOrEqual(12);
    const keys = TEMPLATES.map((t) => t.key);
    expect(new Set(keys).size).toBe(keys.length);
    for (const c of ['customer', 'team', 'money']) {
      expect(TEMPLATES.some((t) => t.category === c), `no templates in category ${c}`).toBe(true);
    }
  });

  it('includes the two canonical recipes: 24h customer reminder + instant tech-assignment alert', () => {
    const reminder = TEMPLATES.find(
      (t) => t.trigger_type === 'BEFORE_JOB_START' && t.trigger_config?.offset_minutes === 24 * 60,
    );
    expect(reminder).toBeDefined();
    expect(reminder!.action_type).toBe('SEND_SMS');
    const techAlert = TEMPLATES.find((t) => t.trigger_type === 'TECH_ASSIGNED');
    expect(techAlert).toBeDefined();
    expect(techAlert!.action_type).toBe('NOTIFY_TEAM');
    expect((techAlert!.action_config as { recipient: string }).recipient).toBe('assigned_techs');
  });

  it('every template is internally valid against the catalog', () => {
    for (const tpl of TEMPLATES) {
      const trig = TRIGGERS[tpl.trigger_type];
      expect(trig, `${tpl.key}: unknown trigger`).toBeDefined();
      expect(ACTIONS[tpl.action_type], `${tpl.key}: unknown action`).toBeDefined();

      // timing config matches trigger kind
      if (trig.timeBased) {
        expect(tpl.trigger_config?.offset_minutes, `${tpl.key}: offset required`).toBeGreaterThan(0);
      } else {
        expect(tpl.trigger_config).toBeUndefined();
      }

      // recipient must be offered for this trigger+action pair
      const cfg = tpl.action_config as { recipient: string; subject?: string; body: string };
      expect(
        recipientsFor(tpl.trigger_type, tpl.action_type),
        `${tpl.key}: recipient ${cfg.recipient} not allowed`,
      ).toContain(cfg.recipient);

      // copy constraints
      expect(cfg.body.length).toBeGreaterThan(20);
      if (tpl.action_type === 'SEND_EMAIL') {
        expect(cfg.subject, `${tpl.key}: email needs subject`).toBeTruthy();
      }
      if (tpl.action_type === 'SEND_SMS') {
        expect(cfg.body.length, `${tpl.key}: SMS too long`).toBeLessThanOrEqual(320);
      }

      // every {{field}} used must be valid for the trigger
      const used = [...fieldsIn(cfg.body), ...fieldsIn(cfg.subject ?? '')];
      for (const f of used) {
        expect(trig.mergeFields, `${tpl.key}: {{${f}}} not valid for ${tpl.trigger_type}`).toContain(f);
      }
    }
  });
});

describe('automation catalog — multi-step templates', () => {
  const STEP_TYPE_FOR_ACTION: Record<AutomationActionType, WorkflowStepType> = {
    SEND_SMS: 'SEND_TEXT',
    SEND_EMAIL: 'SEND_EMAIL',
    NOTIFY_TEAM: 'NOTIFY_TEAM',
  };

  /**
   * Mirrors the FE's templateToWorkflowBody folding (describeWorkflow.ts),
   * backend-side, for validation only: explicit `steps` win verbatim, else
   * the single action_config folds into one step.
   */
  function stepsForTemplate(
    tpl: AutomationTemplate,
  ): Array<{ position: number; step_type: WorkflowStepType; config: unknown }> {
    if (tpl.steps) {
      return tpl.steps.map((step, position) => ({ position, step_type: step.step_type, config: step.config }));
    }
    const step_type = STEP_TYPE_FOR_ACTION[tpl.action_type];
    const { recipient, body, subject, custom_email, user_id } = tpl.action_config;
    let config: Record<string, unknown>;
    if (step_type === 'SEND_TEXT') {
      config = { recipient, body };
    } else if (step_type === 'SEND_EMAIL') {
      config = { recipient, subject: subject ?? '', body, ...(custom_email ? { custom_email } : {}) };
    } else {
      config = { recipient, body, ...(user_id ? { user_id } : {}) };
    }
    return [{ position: 0, step_type, config }];
  }

  it('walkthrough-scheduled-confirmation is a single-action SEND_EMAIL recipe on WALKTHROUGH_SCHEDULED', () => {
    const tpl = TEMPLATES.find((t) => t.key === 'walkthrough-scheduled-confirmation');
    expect(tpl).toBeDefined();
    expect(tpl!.trigger_type).toBe('WALKTHROUGH_SCHEDULED');
    expect(tpl!.action_type).toBe('SEND_EMAIL');
    expect(tpl!.steps).toBeUndefined();
  });

  it('walkthrough-reminder-1d carries an explicit two-step sequence: anchored WAIT then SEND_EMAIL', () => {
    const tpl = TEMPLATES.find((t) => t.key === 'walkthrough-reminder-1d');
    expect(tpl).toBeDefined();
    expect(tpl!.steps).toHaveLength(2);
    expect(tpl!.steps![0].step_type).toBe('WAIT');
    expect(tpl!.steps![0].config).toMatchObject({
      mode: 'anchored',
      anchor: 'lead.walkthrough_scheduled_at',
      direction: 'before',
    });
    expect(tpl!.steps![1].step_type).toBe('SEND_EMAIL');
  });

  it('every template — single-action or explicit steps — validates cleanly end to end', () => {
    for (const tpl of TEMPLATES) {
      const issues = validateWorkflowDefinition({
        trigger_type: tpl.trigger_type,
        trigger_config: tpl.trigger_config ?? null,
        send_window: tpl.send_window,
        steps: stepsForTemplate(tpl),
      });
      expect(issues, `${tpl.key}: ${JSON.stringify(issues)}`).toEqual([]);
    }
  });
});

describe('automation catalog — v2.1 recipient audiences (audiencesFor)', () => {
  it('a job trigger + SEND_EMAIL advertises all 7 entity audiences plus custom', () => {
    const keys = audiencesFor('JOB_SCHEDULED', 'SEND_EMAIL').map((a) => a.key);
    expect(keys).toEqual([
      'customer',
      'assigned_team',
      'dispatcher',
      'salesperson',
      'all_admins',
      'all_dispatchers',
      'specific_user',
      'custom',
    ]);
  });

  it('SEND_SMS is customer-only for every trigger (no SMS provider for team numbers yet)', () => {
    for (const t of ALL_TRIGGERS) {
      expect(audiencesFor(t, 'SEND_SMS').map((a) => a.key)).toEqual(['customer']);
    }
  });

  it('NOTIFY_TEAM excludes customer and custom', () => {
    const keys = audiencesFor('JOB_SCHEDULED', 'NOTIFY_TEAM').map((a) => a.key);
    expect(keys).not.toContain('customer');
    expect(keys).not.toContain('custom');
    expect(keys).toEqual(['assigned_team', 'dispatcher', 'salesperson', 'all_admins', 'all_dispatchers', 'specific_user']);
  });

  it('an invoice trigger has no salesperson (or dispatcher/assigned_team/creator)', () => {
    const keys = audiencesFor('INVOICE_SENT', 'SEND_EMAIL').map((a) => a.key);
    expect(keys).toEqual(['customer', 'all_admins', 'all_dispatchers', 'specific_user', 'custom']);
  });

  it('an estimate trigger offers creator but not dispatcher/assigned_team', () => {
    const keys = audiencesFor('ESTIMATE_SENT', 'SEND_EMAIL').map((a) => a.key);
    expect(keys).toContain('creator');
    expect(keys).not.toContain('dispatcher');
    expect(keys).not.toContain('assigned_team');
  });

  it('carries a plain-English label for every advertised audience', () => {
    for (const t of ALL_TRIGGERS) {
      for (const a of ALL_ACTIONS) {
        for (const opt of audiencesFor(t, a)) {
          expect(opt.label.length, `${t}/${a}/${opt.key} needs a label`).toBeGreaterThan(2);
        }
      }
    }
  });

  it('carries a hint only for the not-guaranteed audiences (salesperson/dispatcher/creator/assigned_team)', () => {
    const NOT_GUARANTEED = new Set(['salesperson', 'dispatcher', 'creator', 'assigned_team']);
    for (const t of ALL_TRIGGERS) {
      for (const a of ALL_ACTIONS) {
        for (const opt of audiencesFor(t, a)) {
          if (NOT_GUARANTEED.has(opt.key)) {
            expect(opt.hint, `${t}/${a}/${opt.key} needs a hint`).toBeTruthy();
          } else {
            expect(opt.hint, `${t}/${a}/${opt.key} shouldn't have a hint`).toBeUndefined();
          }
        }
      }
    }
  });

  it('the salesperson hint matches the documented copy', () => {
    const opt = audiencesFor('JOB_SCHEDULED', 'SEND_EMAIL').find((a) => a.key === 'salesperson');
    expect(opt?.hint).toBe('Skipped if no salesperson is set.');
  });

  it('assigned_team label + hint differ for lead (walkthrough team) vs job (assigned crew)', () => {
    const jobOpt = audiencesFor('JOB_SCHEDULED', 'SEND_EMAIL').find((a) => a.key === 'assigned_team');
    const leadOpt = audiencesFor('LEAD_CREATED', 'SEND_EMAIL').find((a) => a.key === 'assigned_team');
    expect(jobOpt?.label).toBe('the assigned crew');
    expect(leadOpt?.label).toBe('the walkthrough team');
    expect(jobOpt?.hint).not.toBe(leadOpt?.hint);
  });

  it('every trigger × action combo is present in the served AUDIENCES map, identical to audiencesFor()', () => {
    for (const t of ALL_TRIGGERS) {
      for (const a of ALL_ACTIONS) {
        expect(AUDIENCES[t][a]).toEqual(audiencesFor(t, a));
      }
    }
  });
});

describe('catalog — date-anchored triggers', () => {
  it('defines one date-anchored trigger per entity', () => {
    expect(TRIGGERS.JOB_DATE_ANCHORED.entity).toBe('job');
    expect(TRIGGERS.LEAD_DATE_ANCHORED.entity).toBe('lead');
    expect(TRIGGERS.INVOICE_DATE_ANCHORED.entity).toBe('invoice');
    expect(TRIGGERS.ESTIMATE_DATE_ANCHORED.entity).toBe('estimate');
  });

  it('marks them category=date and NOT timeBased (their config is anchored, not a bare offset)', () => {
    for (const key of ['JOB_DATE_ANCHORED', 'LEAD_DATE_ANCHORED', 'INVOICE_DATE_ANCHORED', 'ESTIMATE_DATE_ANCHORED'] as const) {
      expect(TRIGGERS[key].category).toBe('date');
      expect(TRIGGERS[key].timeBased).toBe(false);
    }
  });

  it('carries the same merge fields as its entity event triggers', () => {
    expect(TRIGGERS.INVOICE_DATE_ANCHORED.mergeFields).toEqual(TRIGGERS.INVOICE_SENT.mergeFields);
    expect(TRIGGERS.JOB_DATE_ANCHORED.mergeFields).toEqual(TRIGGERS.JOB_SCHEDULED.mergeFields);
  });

  it('advertises one anchor option per entity for the builder', () => {
    expect(ANCHOR_OPTIONS.invoice).toEqual([{ key: 'invoice.due_date', label: 'the invoice due date' }]);
    expect(ANCHOR_OPTIONS.job).toEqual([{ key: 'job.scheduled_start', label: 'the appointment' }]);
    expect(ANCHOR_OPTIONS.estimate).toEqual([{ key: 'estimate.valid_until', label: 'the estimate expiration' }]);
    expect(ANCHOR_OPTIONS.lead).toEqual([{ key: 'lead.walkthrough_scheduled_at', label: 'the walkthrough' }]);
  });
});

// ── the hard-coded → Automation Center migration's new triggers ────────────

describe('catalog — removed-recipient triggers (TECH_UNASSIGNED, WALKTHROUGH_PERFORMER_REMOVED, JOB_EN_ROUTE)', () => {
  it('TECH_UNASSIGNED and JOB_EN_ROUTE are job events; WALKTHROUGH_PERFORMER_REMOVED is a lead event', () => {
    expect(TRIGGERS.TECH_UNASSIGNED).toMatchObject({ entity: 'job', category: 'events', timeBased: false });
    expect(TRIGGERS.JOB_EN_ROUTE).toMatchObject({ entity: 'job', category: 'events', timeBased: false });
    expect(TRIGGERS.WALKTHROUGH_PERFORMER_REMOVED).toMatchObject({ entity: 'lead', category: 'events', timeBased: false });
  });

  it('reuse the same merge fields as their sibling ASSIGNED/SCHEDULED triggers — no info the built-in email had is unavailable here', () => {
    expect(TRIGGERS.TECH_UNASSIGNED.mergeFields).toEqual(TRIGGERS.TECH_ASSIGNED.mergeFields);
    expect(TRIGGERS.JOB_EN_ROUTE.mergeFields).toEqual(TRIGGERS.JOB_SCHEDULED.mergeFields);
    expect(TRIGGERS.WALKTHROUGH_PERFORMER_REMOVED.mergeFields).toEqual(TRIGGERS.WALKTHROUGH_PERFORMER_ASSIGNED.mergeFields);
  });

  it('removed_user is offered ONLY on the two REMOVED triggers, for SEND_EMAIL/NOTIFY_TEAM but not SEND_SMS', () => {
    expect(audiencesFor('TECH_UNASSIGNED', 'SEND_EMAIL').map((a) => a.key)).toContain('removed_user');
    expect(audiencesFor('TECH_UNASSIGNED', 'NOTIFY_TEAM').map((a) => a.key)).toContain('removed_user');
    expect(audiencesFor('TECH_UNASSIGNED', 'SEND_SMS').map((a) => a.key)).not.toContain('removed_user');
    expect(audiencesFor('WALKTHROUGH_PERFORMER_REMOVED', 'SEND_EMAIL').map((a) => a.key)).toContain('removed_user');

    // Not offered anywhere else — it's meaningless outside these two triggers.
    expect(audiencesFor('JOB_SCHEDULED', 'SEND_EMAIL').map((a) => a.key)).not.toContain('removed_user');
    expect(audiencesFor('TECH_ASSIGNED', 'SEND_EMAIL').map((a) => a.key)).not.toContain('removed_user');
    expect(audiencesFor('JOB_EN_ROUTE', 'SEND_EMAIL').map((a) => a.key)).not.toContain('removed_user');
  });

  it('removed_user carries a plain-English label and no hint (always populated at dispatch time)', () => {
    const opt = audiencesFor('TECH_UNASSIGNED', 'SEND_EMAIL').find((a) => a.key === 'removed_user');
    expect(opt?.label).toBe('the removed technician');
    expect(opt?.hint).toBeUndefined();
  });

  it('assigned_user is offered ONLY on the two ASSIGNED triggers, for SEND_EMAIL/NOTIFY_TEAM but not SEND_SMS', () => {
    expect(audiencesFor('TECH_ASSIGNED', 'SEND_EMAIL').map((a) => a.key)).toContain('assigned_user');
    expect(audiencesFor('TECH_ASSIGNED', 'NOTIFY_TEAM').map((a) => a.key)).toContain('assigned_user');
    expect(audiencesFor('TECH_ASSIGNED', 'SEND_SMS').map((a) => a.key)).not.toContain('assigned_user');
    expect(audiencesFor('WALKTHROUGH_PERFORMER_ASSIGNED', 'SEND_EMAIL').map((a) => a.key)).toContain('assigned_user');

    // Not offered anywhere else — it's meaningless outside these two triggers.
    expect(audiencesFor('JOB_SCHEDULED', 'SEND_EMAIL').map((a) => a.key)).not.toContain('assigned_user');
    expect(audiencesFor('TECH_UNASSIGNED', 'SEND_EMAIL').map((a) => a.key)).not.toContain('assigned_user');
    expect(audiencesFor('JOB_EN_ROUTE', 'SEND_EMAIL').map((a) => a.key)).not.toContain('assigned_user');
  });

  it('assigned_user carries a plain-English label and no hint (always populated at dispatch time)', () => {
    const opt = audiencesFor('TECH_ASSIGNED', 'SEND_EMAIL').find((a) => a.key === 'assigned_user');
    expect(opt?.label).toBe('the assigned technician');
    expect(opt?.hint).toBeUndefined();
  });
});

describe('catalog — event.reason (cancellation triggers)', () => {
  // The cancellation reason is request-time text (req.body.cancelled_reason)
  // — no live column an entity load could re-derive it from — so it only
  // reaches an automation body via event_payload.mergeFields (context.ts),
  // and only the two cancellation triggers can legally reference it.
  it('JOB_CANCELLED and WALKTHROUGH_CANCELLED advertise event.reason; their siblings do not', () => {
    expect(TRIGGERS.JOB_CANCELLED.mergeFields).toContain('event.reason');
    expect(TRIGGERS.WALKTHROUGH_CANCELLED.mergeFields).toContain('event.reason');
    expect(TRIGGERS.JOB_COMPLETED.mergeFields).not.toContain('event.reason');
    expect(TRIGGERS.WALKTHROUGH_COMPLETED.mergeFields).not.toContain('event.reason');
  });

  it('has a label and sample value (covered by the generic merge-field-registry test too, asserted explicitly here for intent)', () => {
    expect(MERGE_FIELD_LABELS['event.reason']).toBeTruthy();
    expect(SAMPLE_CONTEXT['event.reason']).toBeTruthy();
  });
});
