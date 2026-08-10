import { createCtmSoftphone, type CreateCtmSoftphoneOptions, type CtmSoftphone } from './ctmSoftphone';

/**
 * Fix B — CTM softphone warm singleton.
 *
 * Root cause this fixes: every mounted <Softphone> previously owned its own
 * CtmSoftphone via useCtmSoftphone's create-on-mount / destroy-on-unmount
 * effect. Since <Softphone> only ever mounts while the dialer popup is open,
 * closing the dialer destroyed the whole CTM embed (script element + WebRTC
 * device + auth token) and reopening it cold-started the embed from scratch —
 * the multi-second latency this fix removes.
 *
 * This module gives the device a lifetime independent of any transient
 * popup: a single instance, created once and reused for the rest of the page
 * load, module-scope (not React state) so it survives component unmount.
 * useCtmSoftphone.ts (the per-consumer hook) goes through this module instead
 * of calling createCtmSoftphone directly; OfficeSoftphoneWarmup.tsx is the one
 * caller allowed to warm it up eagerly and tear it down on real logout.
 *
 * The `isReady` latch exists because the underlying 'ready' event fires at
 * most once per instance (real device-live handshake) — a subscriber that
 * shows up AFTER that already happened (e.g. a dialer opened after the device
 * finished booting) needs a synchronous way to see "already ready" instead of
 * waiting forever for an event that will never fire again.
 */

let instance: CtmSoftphone | null = null;
let isReady = false;
const readySubscribers = new Set<() => void>();

/** Return the existing instance, or create the ONE instance via
 *  createCtmSoftphone(opts) if none exists yet. Idempotent — at most one
 *  device ever exists at a time. */
export function ensureOfficeSoftphone(opts: CreateCtmSoftphoneOptions): CtmSoftphone {
  if (instance) return instance;
  instance = createCtmSoftphone(opts);
  instance.on('ready', () => {
    isReady = true;
    readySubscribers.forEach((cb) => cb());
  });
  return instance;
}

/** The current instance, or null if never created / torn down. */
export function getOfficeSoftphone(): CtmSoftphone | null {
  return instance;
}

/** The current latch value, synchronously — lets a late subscriber see
 *  ready=true immediately instead of waiting for a 'ready' event that already
 *  fired in the past. */
export function isOfficeSoftphoneReady(): boolean {
  return isReady;
}

/** Register cb for FUTURE transitions to ready (i.e. the next time the
 *  underlying 'ready' event fires). Does NOT fire immediately even if already
 *  ready — callers seed their own state via isOfficeSoftphoneReady() first and
 *  subscribe here only for subsequent changes. Returns an unsubscribe fn. */
export function subscribeOfficeSoftphoneReady(cb: () => void): () => void {
  readySubscribers.add(cb);
  return () => readySubscribers.delete(cb);
}

/** Destroy the instance (if any), and reset all singleton state. Safe to call
 *  when no instance exists. This is the ONLY teardown path — a dedicated
 *  warm-up owner calls it on real session end, never a transient consumer. */
export function teardownOfficeSoftphone(): void {
  instance?.destroy();
  instance = null;
  isReady = false;
  readySubscribers.clear();
}
