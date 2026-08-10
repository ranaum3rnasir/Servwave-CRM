// Multi-tab leader guard for the warm CTM office device. Only ONE tab should
// keep an eagerly-warmed idle device + token-refresh loop; the rest stay dormant
// (they warm on demand if their own dialer opens). Election is via the Web Locks
// API. Multi-tab is already SAFE under the outbound-only lock — this is resource
// hygiene, not correctness — so when the Web Locks API is absent, every tab is
// its own leader (the prior behavior).
import { describe, it, expect, vi } from 'vitest';
import { acquireWarmLeadership, SOFTPHONE_WARM_LOCK } from '@/lib/communication/warmLeader';

/* eslint-disable @typescript-eslint/no-explicit-any */

// A controllable fake of navigator.locks. `grant: true` → this context wins the
// lock immediately (callback runs); `grant: false` → the request stays queued
// (another context holds it), so this tab never becomes leader.
function fakeLocks(grant: boolean) {
  const state: any = { released: false, aborted: false };
  const request = vi.fn((name: string, opts: any, cb: () => Promise<unknown>) => {
    state.name = name;
    state.mode = opts?.mode;
    opts?.signal?.addEventListener('abort', () => {
      state.aborted = true;
    });
    if (grant) {
      const held = cb(); // callback holds the lock; resolves when released
      Promise.resolve(held).then(() => {
        state.released = true;
      });
      return Promise.resolve(held);
    }
    return new Promise((_resolve, reject) => {
      opts?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
    });
  });
  return { locks: { request }, state };
}

describe('acquireWarmLeadership', () => {
  it('elects this context immediately (no-op release) when the Web Locks API is unavailable', () => {
    const onLeader = vi.fn();
    const release = acquireWarmLeadership(onLeader, undefined);
    expect(onLeader).toHaveBeenCalledTimes(1); // prior behavior: every tab warms
    expect(() => release()).not.toThrow();
  });

  it('requests one exclusive lock by the shared name and elects on grant', () => {
    const onLeader = vi.fn();
    const { locks, state } = fakeLocks(true);
    acquireWarmLeadership(onLeader, locks as any);
    expect(locks.request).toHaveBeenCalledTimes(1);
    expect(state.name).toBe(SOFTPHONE_WARM_LOCK);
    expect(state.mode).toBe('exclusive');
    expect(onLeader).toHaveBeenCalledTimes(1);
  });

  it('does NOT elect while another context holds the lock (request stays queued)', () => {
    const onLeader = vi.fn();
    const { locks } = fakeLocks(false);
    acquireWarmLeadership(onLeader, locks as any);
    expect(locks.request).toHaveBeenCalledTimes(1);
    expect(onLeader).not.toHaveBeenCalled(); // follower: never became leader
  });

  it('release() aborts a still-queued request (stops waiting for leadership)', () => {
    const onLeader = vi.fn();
    const { locks, state } = fakeLocks(false);
    const release = acquireWarmLeadership(onLeader, locks as any);
    release();
    expect(state.aborted).toBe(true);
  });

  it('release() relinquishes the held lock once elected, so another tab can take over', async () => {
    const onLeader = vi.fn();
    const { locks, state } = fakeLocks(true);
    const release = acquireWarmLeadership(onLeader, locks as any);
    expect(state.released).toBe(false);
    release();
    await Promise.resolve();
    expect(state.released).toBe(true); // held promise resolved → lock freed
  });
});
