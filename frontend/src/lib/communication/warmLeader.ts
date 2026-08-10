import { useEffect, useState } from 'react';

/**
 * Multi-tab leader guard for the warm CTM office softphone.
 *
 * With the app-wide warm-up (OfficeSoftphoneWarmup) mounted in every tab, N open
 * tabs each register their own WebRTC device and each run their own token-refresh
 * loop — N× the CTM `phone_access` mint traffic + N idle WebSocket registrations.
 * Under the outbound-only lock this is SAFE (no inbound routing to these browser
 * agents, so no double-ring) — it's resource hygiene, not correctness.
 *
 * This elects a single "warm leader" tab via the Web Locks API: only the leader
 * keeps an eagerly-warmed idle device; follower tabs stay dormant and warm on
 * demand only if their own dialer is opened (useCtmSoftphone, untouched). When
 * the leader tab closes, the browser releases the lock and a follower is promoted
 * automatically (Web Locks are tied to the browsing-context lifetime, so even a
 * hard tab-close frees the lock). Mirrors the single-active-session model of
 * production softphones (Twilio Flex, Aircall).
 *
 * When the Web Locks API is unavailable (older Safari), every tab is its own
 * leader — the prior behavior — which stays safe under the outbound-only lock.
 */

/** Web Locks name for the single warm office-softphone device per browser profile. */
export const SOFTPHONE_WARM_LOCK = 'servwave-ctm-softphone-warm';

type LockManagerLike = {
  request: (
    name: string,
    options: { mode?: 'exclusive' | 'shared'; signal?: AbortSignal },
    callback: () => Promise<unknown>,
  ) => Promise<unknown>;
};

function defaultLocks(): LockManagerLike | undefined {
  const nav = typeof navigator !== 'undefined' ? (navigator as Navigator & { locks?: LockManagerLike }) : undefined;
  return nav?.locks && typeof nav.locks.request === 'function' ? nav.locks : undefined;
}

/**
 * Try to become the single warm-leader tab. `onLeader` fires once this context
 * holds the exclusive lock. Returns a release fn that relinquishes the lock — or
 * cancels a still-queued request if leadership was never granted. `locks` is
 * injectable for tests; it defaults to `navigator.locks` (undefined → elect
 * immediately, the prior every-tab-warms behavior).
 */
export function acquireWarmLeadership(
  onLeader: () => void,
  locks: LockManagerLike | undefined = defaultLocks(),
): () => void {
  if (!locks) {
    onLeader(); // no Web Locks API → this tab is its own leader (prior behavior)
    return () => {};
  }

  const abort = new AbortController();
  let release: (() => void) | null = null;
  let released = false;

  locks
    .request(SOFTPHONE_WARM_LOCK, { mode: 'exclusive', signal: abort.signal }, () => {
      // Lock held → this tab is the leader. Keep holding it until release() by
      // returning a promise that resolves only then.
      onLeader();
      return new Promise<void>((resolve) => {
        if (released) resolve(); // released before the grant landed — don't hold
        else release = resolve;
      });
    })
    .catch(() => {
      /* AbortError when a queued request is cancelled before it's granted — expected */
    });

  return () => {
    released = true;
    abort.abort(); // cancel if still queued (no-op once granted)
    release?.(); // release the held lock if we were elected
  };
}

/**
 * Hook wrapper: `true` once this tab holds the warm-leader lock. Re-elects when
 * `enabled` toggles; releases the lock on unmount so another tab can take over.
 */
export function useSoftphoneWarmLeader(enabled: boolean): boolean {
  const [isLeader, setIsLeader] = useState(false);

  useEffect(() => {
    if (!enabled) {
      setIsLeader(false);
      return;
    }
    const release = acquireWarmLeadership(() => setIsLeader(true));
    return () => {
      setIsLeader(false);
      release();
    };
  }, [enabled]);

  return isLeader;
}
