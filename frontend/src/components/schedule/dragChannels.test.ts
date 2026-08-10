import { describe, it, expect } from 'vitest';
import {
  JOB_ID,
  WALKTHROUGH_ID,
  GRID_EVENT_ID,
  parseBoardDragId,
  resolveBoardDropId,
  hasBoardDragPayload,
} from './dragChannels';

describe('parseBoardDragId (board-id → kind + entity id)', () => {
  it('bare id → job', () =>
    expect(parseBoardDragId('abc-123')).toEqual({ kind: 'job', entityId: 'abc-123' }));
  it('wt- prefix → walkthrough with the lead id stripped', () =>
    expect(parseBoardDragId('wt-lead-1')).toEqual({ kind: 'walkthrough', entityId: 'lead-1' }));
  it('pv- prefix → plan-visit with the plan id stripped', () =>
    expect(parseBoardDragId('pv-plan-9')).toEqual({ kind: 'plan-visit', entityId: 'plan-9' }));
});

describe('resolveBoardDropId (every channel normalized to a BOARD id)', () => {
  const dt = (data: Record<string, string>) => ({ getData: (k: string) => data[k] ?? '' });

  it('job-id channel passes through (bare job id IS the board id)', () =>
    expect(resolveBoardDropId(dt({ [JOB_ID]: 'j1' }))).toBe('j1'));
  it('walkthrough-id channel restores the wt- prefix (the bare lead id used to misroute as a job)', () =>
    expect(resolveBoardDropId(dt({ [WALKTHROUGH_ID]: 'lead-1' }))).toBe('wt-lead-1'));
  it('grid-event-id passes through (already a board id, wt- included)', () =>
    expect(resolveBoardDropId(dt({ [GRID_EVENT_ID]: 'wt-lead-2' }))).toBe('wt-lead-2'));
  it('falls back to the live-drag ref, else null', () => {
    expect(resolveBoardDropId(dt({}), 'pv-77')).toBe('pv-77');
    expect(resolveBoardDropId(dt({}))).toBeNull();
  });
});

describe('hasBoardDragPayload (drag-over accept gate)', () => {
  it('true for any board channel, false otherwise', () => {
    expect(hasBoardDragPayload([JOB_ID])).toBe(true);
    expect(hasBoardDragPayload([WALKTHROUGH_ID])).toBe(true);
    expect(hasBoardDragPayload([GRID_EVENT_ID])).toBe(true);
    expect(hasBoardDragPayload(['text/plain'])).toBe(false);
  });
});
