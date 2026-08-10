import { describe, it, expect } from 'vitest';
import { selectionToTrigger, triggerToSelection, DATE_ANCHORED_BY_SUBJECT, type WorkflowCatalog } from '../triggerModel';

/**
 * Minimal slice of the real served catalog (backend/src/services/automations/
 * catalog.ts TRIGGERS + ANCHOR_OPTIONS) — only the trigger types and anchor
 * labels these tests actually exercise, shaped exactly like the real thing
 * (`triggers` keyed by type with `entity`, plus `anchors` keyed by entity).
 */
const catalogFixture: WorkflowCatalog = {
  triggers: {
    JOB_COMPLETED: { entity: 'job' },
    BEFORE_JOB_START: { entity: 'job' },
    INVOICE_DATE_ANCHORED: { entity: 'invoice' },
    JOB_SUB_STATUS_ENTERED: { entity: 'job' },
  },
  anchors: {
    invoice: [{ key: 'invoice.due_date', label: 'the invoice due date' }],
  },
};

describe('triggerModel', () => {
  describe('selectionToTrigger', () => {
    it('maps a date selection to the entity date-anchored trigger', () => {
      expect(
        selectionToTrigger({ subject: 'invoice', mode: 'date', anchor: 'invoice.due_date', direction: 'before', offsetMinutes: 1440 }),
      ).toEqual({
        trigger_type: 'INVOICE_DATE_ANCHORED',
        trigger_config: { anchor: 'invoice.due_date', direction: 'before', offset_minutes: 1440 },
      });
    });

    it('maps an event selection with no config', () => {
      expect(selectionToTrigger({ subject: 'job', mode: 'event', eventTrigger: 'JOB_COMPLETED' })).toEqual({
        trigger_type: 'JOB_COMPLETED',
        trigger_config: null,
      });
    });

    it('returns null for an incomplete date selection (the brief-given example: nothing set)', () => {
      expect(selectionToTrigger({ subject: 'invoice', mode: 'date' })).toBeNull();
    });

    it('returns null for a date selection missing only the anchor', () => {
      expect(
        selectionToTrigger({ subject: 'invoice', mode: 'date', direction: 'before', offsetMinutes: 1440 }),
      ).toBeNull();
    });

    it('returns null for a date selection missing only the direction', () => {
      expect(
        selectionToTrigger({ subject: 'invoice', mode: 'date', anchor: 'invoice.due_date', offsetMinutes: 1440 }),
      ).toBeNull();
    });

    it('returns null for a date selection missing only offsetMinutes', () => {
      expect(
        selectionToTrigger({ subject: 'invoice', mode: 'date', anchor: 'invoice.due_date', direction: 'before' }),
      ).toBeNull();
    });

    it('does NOT treat an offsetMinutes of 0 as missing (0 is a valid "immediately" offset)', () => {
      expect(
        selectionToTrigger({ subject: 'job', mode: 'date', anchor: 'job.scheduled_start', direction: 'after', offsetMinutes: 0 }),
      ).toEqual({
        trigger_type: 'JOB_DATE_ANCHORED',
        trigger_config: { anchor: 'job.scheduled_start', direction: 'after', offset_minutes: 0 },
      });
    });

    it('returns null for an event selection with no eventTrigger chosen', () => {
      expect(selectionToTrigger({ subject: 'job', mode: 'event' })).toBeNull();
    });

    it('ignores a stale eventTrigger left over from a previous mode when mode is "date"', () => {
      expect(
        selectionToTrigger({
          subject: 'invoice',
          mode: 'date',
          eventTrigger: 'INVOICE_PAID',
          anchor: 'invoice.due_date',
          direction: 'before',
          offsetMinutes: 1440,
        }),
      ).toEqual({
        trigger_type: 'INVOICE_DATE_ANCHORED',
        trigger_config: { anchor: 'invoice.due_date', direction: 'before', offset_minutes: 1440 },
      });
    });

    it('ignores stale date fields left over from a previous mode when mode is "event"', () => {
      expect(
        selectionToTrigger({
          subject: 'invoice',
          mode: 'event',
          eventTrigger: 'INVOICE_PAID',
          anchor: 'invoice.due_date',
          direction: 'before',
          offsetMinutes: 1440,
        }),
      ).toEqual({
        trigger_type: 'INVOICE_PAID',
        trigger_config: null,
      });
    });

    // SRVW-113 — JOB_SUB_STATUS_ENTERED is the one event trigger that still needs a
    // trigger_config (which sub-status), unlike every other event trigger's bare null.
    it('maps a JOB_SUB_STATUS_ENTERED selection to a sub_status_id trigger_config', () => {
      expect(
        selectionToTrigger({ subject: 'job', mode: 'event', eventTrigger: 'JOB_SUB_STATUS_ENTERED', subStatusId: 'sub-1' }),
      ).toEqual({
        trigger_type: 'JOB_SUB_STATUS_ENTERED',
        trigger_config: { sub_status_id: 'sub-1' },
      });
    });

    it('returns null for JOB_SUB_STATUS_ENTERED with no sub-status picked yet', () => {
      expect(
        selectionToTrigger({ subject: 'job', mode: 'event', eventTrigger: 'JOB_SUB_STATUS_ENTERED' }),
      ).toBeNull();
    });

    it('ignores a stale subStatusId when the event trigger is something else', () => {
      expect(
        selectionToTrigger({ subject: 'job', mode: 'event', eventTrigger: 'JOB_COMPLETED', subStatusId: 'sub-1' }),
      ).toEqual({
        trigger_type: 'JOB_COMPLETED',
        trigger_config: null,
      });
    });
  });

  describe('round-trips through selectionToTrigger -> triggerToSelection', () => {
    it('round-trips a date selection back out of a saved workflow', () => {
      const sel = {
        subject: 'invoice' as const,
        mode: 'date' as const,
        anchor: 'invoice.due_date' as const,
        direction: 'before' as const,
        offsetMinutes: 1440,
      };
      const saved = selectionToTrigger(sel)!;
      expect(triggerToSelection(saved.trigger_type, saved.trigger_config, catalogFixture)).toEqual(sel);
    });

    it('round-trips an event selection back out of a saved workflow', () => {
      const sel = { subject: 'job' as const, mode: 'event' as const, eventTrigger: 'JOB_COMPLETED' as const };
      const saved = selectionToTrigger(sel)!;
      expect(triggerToSelection(saved.trigger_type, saved.trigger_config, catalogFixture)).toEqual(sel);
    });

    it('round-trips a JOB_SUB_STATUS_ENTERED selection back out of a saved workflow', () => {
      const sel = { subject: 'job' as const, mode: 'event' as const, eventTrigger: 'JOB_SUB_STATUS_ENTERED' as const, subStatusId: 'sub-1' };
      const saved = selectionToTrigger(sel)!;
      expect(triggerToSelection(saved.trigger_type, saved.trigger_config, catalogFixture)).toEqual(sel);
    });
  });

  describe('triggerToSelection — combinations that do not cleanly map back', () => {
    it('returns null for a trigger_type the catalog does not describe', () => {
      expect(triggerToSelection('JOB_CANCELLED', null, catalogFixture)).toBeNull();
    });

    it('returns null for a legacy timed trigger (bare offset config has no home in the two-mode shape)', () => {
      expect(triggerToSelection('BEFORE_JOB_START', { offset_minutes: 1440 }, catalogFixture)).toBeNull();
    });

    it('returns null for a date-anchored trigger whose config is missing anchor/direction', () => {
      expect(triggerToSelection('INVOICE_DATE_ANCHORED', { offset_minutes: 1440 }, catalogFixture)).toBeNull();
    });

    it('returns null when the config anchor does not belong to the trigger entity', () => {
      expect(
        triggerToSelection(
          'INVOICE_DATE_ANCHORED',
          { anchor: 'job.scheduled_start', direction: 'before', offset_minutes: 1440 },
          catalogFixture,
        ),
      ).toBeNull();
    });

    it('returns null when the catalog lists no anchors at all for the entity (not just a mismatched one)', () => {
      const catalogWithoutJobAnchors: WorkflowCatalog = {
        triggers: { JOB_DATE_ANCHORED: { entity: 'job' } },
        anchors: {}, // no 'job' entry
      };
      expect(
        triggerToSelection(
          'JOB_DATE_ANCHORED',
          { anchor: 'job.scheduled_start', direction: 'before', offset_minutes: 60 },
          catalogWithoutJobAnchors,
        ),
      ).toBeNull();
    });

    it('returns null for JOB_SUB_STATUS_ENTERED with a null config (unlike every other event trigger, null is incomplete here)', () => {
      expect(triggerToSelection('JOB_SUB_STATUS_ENTERED', null, catalogFixture)).toBeNull();
    });

    it('returns null for JOB_SUB_STATUS_ENTERED with a malformed config', () => {
      expect(
        triggerToSelection('JOB_SUB_STATUS_ENTERED', { offset_minutes: 60 } as never, catalogFixture),
      ).toBeNull();
    });
  });

  describe('DATE_ANCHORED_BY_SUBJECT', () => {
    it('is a complete lookup covering all four subjects', () => {
      expect(DATE_ANCHORED_BY_SUBJECT).toEqual({
        job: 'JOB_DATE_ANCHORED',
        estimate: 'ESTIMATE_DATE_ANCHORED',
        invoice: 'INVOICE_DATE_ANCHORED',
        lead: 'LEAD_DATE_ANCHORED',
      });
    });
  });
});
