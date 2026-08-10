// Slice 6 FE — TextPage seed-merge (the seed-clobber fix, §5.4).
//
// mergeServerThreads replaces the wholesale setThreads(seedThreads) clobber:
// server rows win by id, optimistic local-only threads survive, and a local
// customer thread is dropped once the server's thread for that customer lands
// (the POST's find-or-create) so 20s polling never duplicates a conversation.
// It must be pure + convergent — merge(merge(prev, seed), seed) === merge(prev,
// seed) — so the seed effect can re-run safely (jsdom seed-effect-loop hazard).
import { describe, it, expect } from 'vitest';
import { mergeServerThreads } from '@/pages/communication/TextPage';
import type { MessageThread } from '@/lib/api/communication';

const thread = (overrides: Partial<MessageThread>): MessageThread => ({
  id: 'thr_x',
  customerId: '',
  channel: 'sms',
  campaignType: 'customer_care',
  unread: 0,
  messages: [],
  ...overrides,
});

const SERVER_A = thread({ id: 'srv-a', customerId: 'cust-1', unread: 2 });
const SERVER_B = thread({ id: 'srv-b', customerId: 'cust-2' });

describe('mergeServerThreads', () => {
  it('server rows win for known ids (no stale local copy survives)', () => {
    const localStale = thread({ id: 'srv-a', customerId: 'cust-1', unread: 0 });
    const merged = mergeServerThreads([localStale], [SERVER_A, SERVER_B]);
    expect(merged).toHaveLength(2);
    expect(merged.find((t) => t.id === 'srv-a')?.unread).toBe(2);
  });

  it('keeps optimistic local-only threads (unsaved team lanes) on top', () => {
    const localTeam = thread({ id: 'thr_1751970000', kind: 'team', title: 'Mike Reyes' });
    const merged = mergeServerThreads([localTeam, SERVER_A], [SERVER_A, SERVER_B]);
    expect(merged[0]).toBe(localTeam);
    expect(merged).toHaveLength(3);
  });

  it('drops a local customer thread once the server thread for that customer arrives', () => {
    const optimistic = thread({ id: 'thr_1751970001', customerId: 'cust-1' });
    const merged = mergeServerThreads([optimistic], [SERVER_A, SERVER_B]);
    expect(merged).toHaveLength(2);
    expect(merged.some((t) => t.id === 'thr_1751970001')).toBe(false);
  });

  it('keeps a local customer thread while the server has no row for that customer yet', () => {
    const optimistic = thread({ id: 'thr_1751970002', customerId: 'cust-99' });
    const merged = mergeServerThreads([optimistic], [SERVER_A]);
    expect(merged.map((t) => t.id)).toEqual(['thr_1751970002', 'srv-a']);
  });

  it('is convergent: re-merging the same seed changes nothing (no effect loop)', () => {
    const localTeam = thread({ id: 'thr_team', kind: 'team', title: 'Crew' });
    const once = mergeServerThreads([localTeam], [SERVER_A, SERVER_B]);
    const twice = mergeServerThreads(once, [SERVER_A, SERVER_B]);
    expect(twice).toEqual(once);
  });

  it('handles an empty local state (first seed) and an empty seed', () => {
    expect(mergeServerThreads([], [SERVER_A])).toEqual([SERVER_A]);
    const localTeam = thread({ id: 'thr_team', kind: 'team' });
    expect(mergeServerThreads([localTeam], [])).toEqual([localTeam]);
  });
});
