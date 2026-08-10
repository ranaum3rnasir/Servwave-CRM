import { describe, it, expect } from 'vitest';
import { lockedStepTypesFor } from './featureFlags';
import type { WorkflowCatalog } from '@/lib/api/workflows';

function catalogWith(sms_available: boolean): WorkflowCatalog {
  return { capabilities: { sms_available } } as unknown as WorkflowCatalog;
}

describe('lockedStepTypesFor', () => {
  it('unlocks SEND_TEXT when the org can text', () => {
    expect(lockedStepTypesFor(catalogWith(true))).toEqual([]);
  });

  it('locks SEND_TEXT when the org cannot text', () => {
    expect(lockedStepTypesFor(catalogWith(false))).toEqual(['SEND_TEXT']);
  });

  it('fails closed (locked) while the catalog is still loading', () => {
    expect(lockedStepTypesFor(undefined)).toEqual(['SEND_TEXT']);
  });

  it('fails closed (locked) for a stale fixture missing capabilities', () => {
    expect(lockedStepTypesFor({} as unknown as WorkflowCatalog)).toEqual(['SEND_TEXT']);
  });
});
