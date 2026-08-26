// Fix B — CTM softphone warm-singleton. officeSoftphone.ts wraps
// createCtmSoftphone in module-scope state so the device survives the dialer
// popup opening/closing: at most one instance ever exists, and late
// subscribers (a dialer opened after the device already finished booting) can
// read the ready latch synchronously instead of waiting for a 'ready' event
// that already fired in the past.
//
// Mocked the same way use-ctm-softphone.test.tsx mocks createCtmSoftphone
// today. This module's state is real module-level `let`s — it PERSISTS across
// `it` blocks in this file unless reset, so every test tears the singleton
// down in afterEach (a known singleton-testing pitfall).
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('@/lib/communication/ctmSoftphone', () => ({
  createCtmSoftphone: vi.fn(),
}));

import { createCtmSoftphone } from '@/lib/communication/ctmSoftphone';
import {
  ensureOfficeSoftphone,
  getOfficeSoftphone,
  getOfficeSoftphoneFault,
  isOfficeSoftphoneReady,
  subscribeOfficeSoftphoneReady,
  subscribeOfficeSoftphoneFault,
  teardownOfficeSoftphone,
} from '@/lib/communication/officeSoftphone';

/* eslint-disable @typescript-eslint/no-explicit-any */

function fakeSp() {
  const handlers: Record<string, ((p?: unknown) => void)[]> = {};
  return {
    ready: Promise.resolve(),
    call: vi.fn(),
    dialFrom: vi.fn(),
    mute: vi.fn(),
    hangup: vi.fn(),
    answer: vi.fn(),
    on: (ev: string, cb: (p?: unknown) => void) => {
      (handlers[ev] ??= []).push(cb);
      return () => {};
    },
    destroy: vi.fn(),
    __emit: (ev: string, p?: unknown) => (handlers[ev] ?? []).forEach((cb) => cb(p)),
  };
}

const getToken = vi.fn().mockResolvedValue({ token: 'T' });

beforeEach(() => vi.clearAllMocks());
// The singleton is module-scope state, not React state — it outlives any one
// test unless explicitly reset here.
afterEach(() => teardownOfficeSoftphone());

describe('officeSoftphone (warm singleton)', () => {
  it('creates exactly one instance across repeated ensureOfficeSoftphone calls', () => {
    const sp = fakeSp();
    vi.mocked(createCtmSoftphone).mockReturnValue(sp as any);

    const first = ensureOfficeSoftphone({ getToken });
    const second = ensureOfficeSoftphone({ getToken });

    expect(first).toBe(sp);
    expect(second).toBe(sp);
    expect(createCtmSoftphone).toHaveBeenCalledTimes(1);
    expect(getOfficeSoftphone()).toBe(sp);
  });

  it('isOfficeSoftphoneReady() is false before the instance emits ready, true after', () => {
    const sp = fakeSp();
    vi.mocked(createCtmSoftphone).mockReturnValue(sp as any);

    ensureOfficeSoftphone({ getToken });
    expect(isOfficeSoftphoneReady()).toBe(false);

    sp.__emit('ready');
    expect(isOfficeSoftphoneReady()).toBe(true);
  });

  it('getOfficeSoftphone() is null until an instance is created', () => {
    expect(getOfficeSoftphone()).toBeNull();
    const sp = fakeSp();
    vi.mocked(createCtmSoftphone).mockReturnValue(sp as any);
    ensureOfficeSoftphone({ getToken });
    expect(getOfficeSoftphone()).toBe(sp);
  });

  it("subscribeOfficeSoftphoneReady's callback fires when ready emits, not merely from registering", () => {
    const sp = fakeSp();
    vi.mocked(createCtmSoftphone).mockReturnValue(sp as any);
    ensureOfficeSoftphone({ getToken });

    const cb = vi.fn();
    subscribeOfficeSoftphoneReady(cb);
    expect(cb).not.toHaveBeenCalled(); // registering alone must not invoke it

    sp.__emit('ready');
    expect(cb).toHaveBeenCalledTimes(1);
  });

  it('the returned unsubscribe function stops further delivery', () => {
    const sp = fakeSp();
    vi.mocked(createCtmSoftphone).mockReturnValue(sp as any);
    ensureOfficeSoftphone({ getToken });

    const cb = vi.fn();
    const unsubscribe = subscribeOfficeSoftphoneReady(cb);
    unsubscribe();

    sp.__emit('ready');
    expect(cb).not.toHaveBeenCalled();
  });

  it('teardownOfficeSoftphone() destroys the instance, and a later ensureOfficeSoftphone() creates a NEW one', () => {
    const sp1 = fakeSp();
    vi.mocked(createCtmSoftphone).mockReturnValue(sp1 as any);
    ensureOfficeSoftphone({ getToken });
    sp1.__emit('ready');
    expect(isOfficeSoftphoneReady()).toBe(true);

    teardownOfficeSoftphone();

    expect(sp1.destroy).toHaveBeenCalledTimes(1);
    expect(getOfficeSoftphone()).toBeNull();
    expect(isOfficeSoftphoneReady()).toBe(false); // latch resets too

    const sp2 = fakeSp();
    vi.mocked(createCtmSoftphone).mockReturnValue(sp2 as any);
    const next = ensureOfficeSoftphone({ getToken });

    expect(next).toBe(sp2);
    expect(createCtmSoftphone).toHaveBeenCalledTimes(2); // a real second device
  });

  it('teardownOfficeSoftphone() clears ready-subscribers so a stale callback never fires again', () => {
    const sp1 = fakeSp();
    vi.mocked(createCtmSoftphone).mockReturnValue(sp1 as any);
    ensureOfficeSoftphone({ getToken });
    const cb = vi.fn();
    subscribeOfficeSoftphoneReady(cb);

    teardownOfficeSoftphone();

    const sp2 = fakeSp();
    vi.mocked(createCtmSoftphone).mockReturnValue(sp2 as any);
    ensureOfficeSoftphone({ getToken });
    sp2.__emit('ready');

    expect(cb).not.toHaveBeenCalled();
  });

  it('is a safe no-op when no instance exists', () => {
    expect(() => teardownOfficeSoftphone()).not.toThrow();
    expect(getOfficeSoftphone()).toBeNull();
    expect(isOfficeSoftphoneReady()).toBe(false);
  });
});

// Slice 3 — the fault channel. Deliberately the same shape as the ready channel
// above (getter + subscribe-for-future-transitions + cleared by teardown), and
// tested case-for-case against it, because "not ready" is not a diagnosis: every
// distinguishable boot failure used to render as the same eternal "Connecting…".
describe('officeSoftphone — fault channel', () => {
  it('getOfficeSoftphoneFault() is null before the instance emits a fault, and the value after', () => {
    const sp = fakeSp();
    vi.mocked(createCtmSoftphone).mockReturnValue(sp as any);

    ensureOfficeSoftphone({ getToken });
    expect(getOfficeSoftphoneFault()).toBeNull();

    sp.__emit('fault', 'locked-out');
    expect(getOfficeSoftphoneFault()).toBe('locked-out');
  });

  it("subscribeOfficeSoftphoneFault's callback fires when a fault emits, not merely from registering", () => {
    const sp = fakeSp();
    vi.mocked(createCtmSoftphone).mockReturnValue(sp as any);
    ensureOfficeSoftphone({ getToken });

    const cb = vi.fn();
    subscribeOfficeSoftphoneFault(cb);
    expect(cb).not.toHaveBeenCalled(); // registering alone must not invoke it

    sp.__emit('fault', 'station-check');
    expect(cb).toHaveBeenCalledTimes(1);
  });

  it('the returned unsubscribe function stops further delivery', () => {
    const sp = fakeSp();
    vi.mocked(createCtmSoftphone).mockReturnValue(sp as any);
    ensureOfficeSoftphone({ getToken });

    const cb = vi.fn();
    const unsubscribe = subscribeOfficeSoftphoneFault(cb);
    unsubscribe();

    sp.__emit('fault', 'unknown');
    expect(cb).not.toHaveBeenCalled();
  });

  it('does not re-notify for a repeat of the fault it already holds', () => {
    const sp = fakeSp();
    vi.mocked(createCtmSoftphone).mockReturnValue(sp as any);
    ensureOfficeSoftphone({ getToken });

    const cb = vi.fn();
    subscribeOfficeSoftphoneFault(cb);
    sp.__emit('fault', 'unknown');
    sp.__emit('fault', 'unknown');

    expect(cb).toHaveBeenCalledTimes(1);
  });

  // The invariant the UI leans on: a pill can read "Ready" or it can read why
  // the phone is unavailable, never both at once.
  it('a device that becomes ready RETRACTS its fault, and tells fault-subscribers so', () => {
    const sp = fakeSp();
    vi.mocked(createCtmSoftphone).mockReturnValue(sp as any);
    ensureOfficeSoftphone({ getToken });
    const cb = vi.fn();
    subscribeOfficeSoftphoneFault(cb);

    sp.__emit('fault', 'station-check');
    expect(getOfficeSoftphoneFault()).toBe('station-check');

    sp.__emit('ready');

    expect(isOfficeSoftphoneReady()).toBe(true);
    expect(getOfficeSoftphoneFault()).toBeNull();
    expect(cb).toHaveBeenCalledTimes(2); // raised, then retracted
  });

  it('never faults a device that is already ready', () => {
    const sp = fakeSp();
    vi.mocked(createCtmSoftphone).mockReturnValue(sp as any);
    ensureOfficeSoftphone({ getToken });
    const cb = vi.fn();
    subscribeOfficeSoftphoneFault(cb);

    sp.__emit('ready');
    sp.__emit('fault', 'unknown');

    expect(getOfficeSoftphoneFault()).toBeNull();
    expect(isOfficeSoftphoneReady()).toBe(true);
    expect(cb).not.toHaveBeenCalled();
  });

  it('teardownOfficeSoftphone() clears the fault, exactly as it clears the ready latch', () => {
    const sp1 = fakeSp();
    vi.mocked(createCtmSoftphone).mockReturnValue(sp1 as any);
    ensureOfficeSoftphone({ getToken });
    sp1.__emit('fault', 'locked-out');
    expect(getOfficeSoftphoneFault()).toBe('locked-out');

    teardownOfficeSoftphone();

    expect(getOfficeSoftphoneFault()).toBeNull();
  });

  it('teardownOfficeSoftphone() clears fault-subscribers so a stale callback never fires again', () => {
    const sp1 = fakeSp();
    vi.mocked(createCtmSoftphone).mockReturnValue(sp1 as any);
    ensureOfficeSoftphone({ getToken });
    const cb = vi.fn();
    subscribeOfficeSoftphoneFault(cb);

    teardownOfficeSoftphone();

    const sp2 = fakeSp();
    vi.mocked(createCtmSoftphone).mockReturnValue(sp2 as any);
    ensureOfficeSoftphone({ getToken });
    sp2.__emit('fault', 'unknown');

    expect(cb).not.toHaveBeenCalled();
  });

  it('reading the fault is a safe no-op when no instance exists', () => {
    expect(getOfficeSoftphoneFault()).toBeNull();
    expect(() => subscribeOfficeSoftphoneFault(vi.fn())()).not.toThrow();
  });

  // Belt-and-braces on the ready channel: adding a second Set must not have made
  // the two channels notify each other.
  it('a fault does not notify ready-subscribers', () => {
    const sp = fakeSp();
    vi.mocked(createCtmSoftphone).mockReturnValue(sp as any);
    ensureOfficeSoftphone({ getToken });
    const readyCb = vi.fn();
    subscribeOfficeSoftphoneReady(readyCb);

    sp.__emit('fault', 'locked-out');

    expect(readyCb).not.toHaveBeenCalled();
    expect(isOfficeSoftphoneReady()).toBe(false);
  });
});
