import { describe, it, expect, vi } from 'vitest';
import { resolveDefaultLeadStatus } from '../lead-status-override';

describe('resolveDefaultLeadStatus', () => {
  it('returns the org-configured default status', async () => {
    const client = { leadStatusOverride: { findFirst: vi.fn().mockResolvedValue({ status: 'CONTACTED' }) } };
    expect(await resolveDefaultLeadStatus(client as never, 'org-1')).toBe('CONTACTED');
    expect(client.leadStatusOverride.findFirst).toHaveBeenCalledWith({
      where: { organization_id: 'org-1', is_default: true },
      select: { status: true },
    });
  });

  it('falls back to NEW when the org has no configured default', async () => {
    const client = { leadStatusOverride: { findFirst: vi.fn().mockResolvedValue(null) } };
    expect(await resolveDefaultLeadStatus(client as never, 'org-1')).toBe('NEW');
  });
});
