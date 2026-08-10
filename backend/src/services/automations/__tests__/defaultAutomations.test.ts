import { describe, it, expect } from 'vitest';
import { DEFAULT_AUTOMATIONS } from '../defaultAutomations';
import { validateWorkflowDefinition } from '../workflowValidation';
import { TRIGGERS } from '../catalog';

describe('DEFAULT_AUTOMATIONS', () => {
  it('has a unique builtin_key per entry, all prefixed "default-" (distinct from the template_key namespace)', () => {
    const keys = DEFAULT_AUTOMATIONS.map((a) => a.builtin_key);
    expect(new Set(keys).size).toBe(keys.length);
    for (const key of keys) {
      expect(key.startsWith('default-'), `${key} must be prefixed "default-"`).toBe(true);
    }
  });

  it('covers one entry per migratable trigger from the migration plan — 13 built-ins, no duplicate trigger_type', () => {
    expect(DEFAULT_AUTOMATIONS).toHaveLength(13);
    const triggers = DEFAULT_AUTOMATIONS.map((a) => a.trigger_type);
    expect(new Set(triggers).size).toBe(triggers.length);
  });

  // A tripwire, not a description. Enabling a default while its hard-coded
  // sender still fires double-emails every customer of every org — the one
  // sequencing mistake in this migration that is customer-visible. Keeping the
  // cut-over set in a test means a key cannot be switched on as a side effect of
  // editing the registry: you have to come here and say so deliberately, in the
  // same change that deletes the sender.
  //
  // Add a key to this list ONLY in the commit that deletes its hard-coded sender.
  // Phase 3 slice 1 = jobs, slice 2 = walkthroughs, slice 3 = estimates.
  it('only entries whose hard-coded sender has been deleted seed enabled', () => {
    const CUT_OVER: string[] = [
      'default-job-scheduled',
      'default-job-rescheduled',
      'default-tech-assigned',
      'default-tech-unassigned',
      'default-job-en-route',
      'default-walkthrough-scheduled',
      'default-walkthrough-rescheduled',
      'default-walkthrough-performer-assigned',
      'default-walkthrough-performer-removed',
      'default-walkthrough-completed',
      'default-walkthrough-cancelled',
      'default-estimate-approved-notify-creator',
      'default-estimate-declined-notify-creator',
    ];

    for (const a of DEFAULT_AUTOMATIONS) {
      expect(
        a.seed_enabled,
        `${a.builtin_key}: seed_enabled must be ${CUT_OVER.includes(a.builtin_key)} — a default may only seed enabled once its hard-coded sender is gone`,
      ).toBe(CUT_OVER.includes(a.builtin_key));
    }
  });

  // The real publish-tier gate — same validator PATCH/publish runs through
  // (workflow.controller.ts), so a green result here is a genuine guarantee
  // this definition is publishable as-is: legal trigger, legal recipients
  // (audiencesFor — trigger-scoped, not just entity-scoped), every
  // {{merge.field}} the copy references actually exists for this trigger.
  it('every entry validates cleanly as a one-step SEND_EMAIL workflow (the exact shape the seeder writes)', () => {
    for (const a of DEFAULT_AUTOMATIONS) {
      const issues = validateWorkflowDefinition({
        trigger_type: a.trigger_type,
        trigger_config: null,
        send_window: 'ANYTIME',
        steps: [
          {
            position: 0,
            step_type: 'SEND_EMAIL',
            config: { recipients: a.recipients, subject: a.subject, body: a.body },
          },
        ],
      });
      expect(issues, `${a.builtin_key}: ${JSON.stringify(issues)}`).toEqual([]);
    }
  });

  it('every trigger_type is a real, defined catalog trigger', () => {
    for (const a of DEFAULT_AUTOMATIONS) {
      expect(TRIGGERS[a.trigger_type], `${a.builtin_key}: unknown trigger ${a.trigger_type}`).toBeDefined();
    }
  });

  it('the two cancellation-adjacent entries are the only ones referencing {{event.reason}}', () => {
    const withReason = DEFAULT_AUTOMATIONS.filter((a) => a.body.includes('{{event.reason}}'));
    expect(withReason.map((a) => a.builtin_key)).toEqual(['default-walkthrough-cancelled']);
  });

  // {{technician.names}} renders the WHOLE crew ("Carlos Tran, Mike Turner, Dre
  // Patel"), so any copy that makes it the subject of a verb reads as broken
  // English the moment a job has more than one person on it — "Carlos Tran, Mike
  // Turner, Dre Patel is heading to…". Presenting it as a labelled list instead
  // reads correctly at every crew size, which is the shape Ran chose on
  // 2026-07-27 over dropping back to a single name.
  it('every entry naming the crew presents {{technician.names}} as a labelled list, never a sentence subject', () => {
    const withCrew = DEFAULT_AUTOMATIONS.filter((a) => a.body.includes('{{technician.names}}'));
    expect(withCrew.length).toBeGreaterThan(0);
    for (const a of withCrew) {
      expect(
        a.body,
        `${a.builtin_key}: {{technician.names}} must follow "Who's coming: " so the copy survives a multi-person crew`,
      ).toContain("Who's coming: {{technician.names}}");
    }
  });

  // Same reason, one level up: a subject line that says "The technician" is
  // wrong for a three-person crew, so the crew-facing subjects stay count-neutral.
  it('no subject line hard-codes a singular technician', () => {
    for (const a of DEFAULT_AUTOMATIONS) {
      expect(a.subject.toLowerCase(), `${a.builtin_key}: subject assumes exactly one technician`).not.toContain(
        'the technician',
      );
    }
  });

  it('the two "removed" entries target removed_user, matching their trigger', () => {
    const unassigned = DEFAULT_AUTOMATIONS.find((a) => a.trigger_type === 'TECH_UNASSIGNED');
    const performerRemoved = DEFAULT_AUTOMATIONS.find((a) => a.trigger_type === 'WALKTHROUGH_PERFORMER_REMOVED');
    expect(unassigned?.recipients).toEqual(['removed_user']);
    expect(performerRemoved?.recipients).toEqual(['removed_user']);
  });
});
