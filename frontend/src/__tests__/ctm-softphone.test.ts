// Slice 4 — the CTM softphone wrapper. Unit-tests OUR adapter (token wiring,
// call/dialFrom proxying, event bridging, teardown) against a fake element.
// The REAL ctm-phone-embed behavior (audio, cross-origin load, exact events) is
// verified in the live two-device QA — this suite guards the seam we control.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  createCtmSoftphone,
  isCtmSoftphoneEnabled,
  computeTokenRefreshDelayMs,
  type CtmPhoneElement,
} from '@/lib/communication/ctmSoftphone';

/* eslint-disable @typescript-eslint/no-explicit-any */

/** A real jsdom element (so addEventListener/dispatchEvent/append/remove are
 *  native) with the CTM methods mocked. */
function makeFakeElement(): CtmPhoneElement & {
  call: ReturnType<typeof vi.fn>;
  answer: ReturnType<typeof vi.fn>;
  hangup: ReturnType<typeof vi.fn>;
  mute: ReturnType<typeof vi.fn>;
} {
  const el = document.createElement('div') as any;
  el.call = vi.fn();
  el.answer = vi.fn();
  el.hangup = vi.fn();
  el.mute = vi.fn();
  return el;
}

function makeSoftphone(overrides: Record<string, any> = {}) {
  const el = makeFakeElement();
  // The full phone_access payload — the device binds via account_id / user.account.
  const getToken = vi.fn().mockResolvedValue({
    token: 'TKN-123',
    valid_until: 1799999999,
    account_id: '596375',
    user: { account: '596375' },
  });
  const sp = createCtmSoftphone({
    getToken,
    documentRef: document,
    scriptLoader: vi.fn().mockResolvedValue(undefined),
    elementFactory: () => el,
    ...overrides,
  });
  return { sp, el, getToken };
}

beforeEach(() => {
  document.body.innerHTML = '';
  try {
    localStorage.clear();
  } catch {
    /* ignore */
  }
});
afterEach(() => vi.clearAllMocks());

describe('isCtmSoftphoneEnabled', () => {
  it('defaults ON (WebRTC softphone is the pilot office path now)', () => {
    // The default flipped from OFF → ON for the Alpha Doors pilot. On the
    // staging branch this makes /phone use the real WebRTC device without any
    // per-browser toggle; prod stays on the pre-flip code until promotion.
    expect(isCtmSoftphoneEnabled()).toBe(true);
  });
  it('can be turned off per-browser via the localStorage kill-switch', () => {
    localStorage.setItem('ctm_softphone', 'off');
    expect(isCtmSoftphoneEnabled()).toBe(false);
  });
  it('stays on when explicitly set on', () => {
    localStorage.setItem('ctm_softphone', 'on');
    expect(isCtmSoftphoneEnabled()).toBe(true);
  });
  it('treats an unrecognized localStorage value as the default (on)', () => {
    localStorage.setItem('ctm_softphone', 'maybe');
    expect(isCtmSoftphoneEnabled()).toBe(true);
  });
});

describe('createCtmSoftphone', () => {
  it('mounts the element inline (no dead mode attr) and defers the token until asked', async () => {
    const { sp, el, getToken } = makeSoftphone();
    await sp.ready;

    // `ready` = script loaded + element mounted. The token is minted on demand —
    // the component asks via ctm:requiresToken — so getToken has NOT run yet.
    expect(document.body.contains(el)).toBe(true);
    expect(el.getAttribute('mode')).toBeNull(); // 'mode' is not a real CTM attribute
    expect(getToken).not.toHaveBeenCalled();
  });

  it('answers ctm:requiresToken by handing the FULL access object to the device', async () => {
    const access = {
      token: 'TKN-123',
      valid_until: 1799999999,
      account_id: '596375',
      user: { account: '596375' },
    };
    const getToken = vi.fn().mockResolvedValue(access);
    const { sp, el } = makeSoftphone({ getToken });
    await sp.ready;

    // The real component requests a token via this event; the wrapper answers it.
    el.dispatchEvent(new CustomEvent('ctm:requiresToken', {}));
    await vi.waitFor(() => expect(getToken).toHaveBeenCalledTimes(1));

    // The device receives the WHOLE payload (account_id / user) — NOT the bare
    // token string, which dropped the account binding and broke authentication.
    expect(el.accessToken).toEqual(access);
    expect(el.accessToken).not.toBe('TKN-123');
  });

  it('injects hide CSS for the CTM host element so its native panel never renders visibly', async () => {
    const { sp } = makeSoftphone();
    await sp.ready;

    const style = document.getElementById('ctm-phone-embed-hide-style');
    expect(style).not.toBeNull();
    expect(style?.tagName).toBe('STYLE');
    expect(style?.textContent).toContain('ctm-phone-embed');
    expect(style?.textContent).toContain('opacity: 0');
    expect(style?.textContent).toContain('pointer-events: none');
    // display:none is NOT used — it can unload the embed's cross-origin iframe
    // and sever the postMessage command/event bridge the wrapper depends on.
    expect(style?.textContent).not.toMatch(/display:\s*none/);
  });

  it('does not inject the hide style twice for repeated softphone instances', async () => {
    const { sp: sp1 } = makeSoftphone();
    await sp1.ready;
    const { sp: sp2 } = makeSoftphone();
    await sp2.ready;

    const styles = document.head.querySelectorAll('#ctm-phone-embed-hide-style');
    expect(styles.length).toBe(1);
  });

  it('does NOT emit ready on mount — only on the real ctm:ready (mount ≠ device-live)', async () => {
    const { sp, el } = makeSoftphone();
    // Subscribe BEFORE mount resolves so a regression that re-adds a premature
    // mount-time emit('ready') would be caught here.
    const onReady = vi.fn();
    sp.on('ready', onReady);
    await sp.ready;
    expect(onReady).not.toHaveBeenCalled(); // mounting must NOT flip device-live

    el.dispatchEvent(new CustomEvent('ctm:ready', { detail: { agent: { id: 1 } } }));
    expect(onReady).toHaveBeenCalledTimes(1);
  });

  it('sets the caller ID (dialFrom) then places the call', async () => {
    const { sp, el } = makeSoftphone();
    await sp.ready;

    sp.dialFrom('TPN-A');
    sp.call('+15551234567');

    expect(el.dialFrom).toEqual({ id: 'TPN-A' });
    expect(el.call).toHaveBeenCalledWith('+15551234567');
  });

  it('bridges CTM element events to stable lifecycle events', async () => {
    const { sp, el } = makeSoftphone();
    await sp.ready;

    const onStart = vi.fn();
    const onEnd = vi.fn();
    sp.on('start', onStart);
    sp.on('end', onEnd);

    el.dispatchEvent(new CustomEvent('ctm:start', { detail: { sid: 'c1' } }));
    el.dispatchEvent(new CustomEvent('ctm:hangup', { detail: { sid: 'c1' } }));

    expect(onStart).toHaveBeenCalledWith({ sid: 'c1' });
    expect(onEnd).toHaveBeenCalledWith({ sid: 'c1' });
  });

  it('treats ctm:end-activity as the call-end signal (the confirmed inbound terminal event)', async () => {
    const { sp, el } = makeSoftphone();
    await sp.ready;
    const onEnd = vi.fn();
    sp.on('end', onEnd);

    // The component's message handler emits ctm:end-activity on teardown (ctm:hangup
    // is only its OUTBOUND command) — 'end' must fire off this or the call UI hangs.
    el.dispatchEvent(new CustomEvent('ctm:end-activity', { detail: { sid: 'c1' } }));
    expect(onEnd).toHaveBeenCalledWith({ sid: 'c1' });
  });

  it('proxies mute / hangup / answer to the element', async () => {
    const { sp, el } = makeSoftphone();
    await sp.ready;

    sp.mute(true);
    sp.hangup();
    sp.answer();

    expect(el.mute).toHaveBeenCalledWith(true);
    expect(el.hangup).toHaveBeenCalledTimes(1);
    expect(el.answer).toHaveBeenCalledTimes(1);
  });

  it('unsubscribes a listener and stops delivering to it', async () => {
    const { sp, el } = makeSoftphone();
    await sp.ready;
    const cb = vi.fn();
    const off = sp.on('start', cb);
    off();
    el.dispatchEvent(new CustomEvent('ctm:start', { detail: {} }));
    expect(cb).not.toHaveBeenCalled();
  });

  it('destroy removes the element and clears listeners', async () => {
    const { sp, el } = makeSoftphone();
    await sp.ready;
    const cb = vi.fn();
    sp.on('end', cb);

    sp.destroy();
    expect(document.body.contains(el)).toBe(false);
    // A dangling dispatch after destroy delivers to nobody.
    el.dispatchEvent(new CustomEvent('ctm:hangup', { detail: {} }));
    expect(cb).not.toHaveBeenCalled();
  });

  it('destroy tears down the spawned ctm-device-embed and releases the call (no orphaned mic/WebRTC)', async () => {
    const { sp, el } = makeSoftphone();
    await sp.ready;
    // Simulate the component having authenticated and appended its parent-page
    // WebRTC device as a sibling in the document.
    const device = document.createElement('ctm-device-embed');
    document.body.appendChild(device);

    sp.destroy();

    expect(el.hangup).toHaveBeenCalledTimes(1); // best-effort mic/WebRTC release
    expect(document.body.querySelector('ctm-device-embed')).toBeNull(); // not orphaned
  });

  it('does not mint a token after destroy — a torn-down device is never re-provisioned', async () => {
    const { sp, el, getToken } = makeSoftphone();
    await sp.ready;
    sp.destroy();

    // A late ctm:requiresToken (device reboot racing unmount) must not trigger a
    // mint or touch the dead device — the pre-mint `destroyed || !el` guard holds.
    el.dispatchEvent(new CustomEvent('ctm:requiresToken', {}));
    await Promise.resolve();

    expect(getToken).not.toHaveBeenCalled();
    expect(el.accessToken).toBeUndefined();
  });

  it('emits an error event when token minting fails (no throw escapes)', async () => {
    const getToken = vi.fn().mockRejectedValue(new Error('CTM_TOKEN_FAILED'));
    const { sp, el } = makeSoftphone({ getToken });
    const onError = vi.fn();
    sp.on('error', onError);
    await sp.ready;

    // The failure surfaces when the component asks for a token and getToken rejects.
    el.dispatchEvent(new CustomEvent('ctm:requiresToken', {}));
    await vi.waitFor(() => expect(onError).toHaveBeenCalledTimes(1));
  });
});

// The CTM softphone token has a short (~10-min) TTL and CTM never refreshes it.
// Left alone, an idle session lets the WebRTC device de-register and the next
// click-to-call eats a reconnect — reintroducing exactly the lag the warm device
// removed. So the wrapper re-mints BEFORE `valid_until` and hands the fresh token
// to the LIVE device in place (Twilio's tokenWillExpire → updateToken pattern),
// which the embed forwards into the running device iframe with no reload — the
// device never de-registers and the UI never shows a reconnect.
describe('computeTokenRefreshDelayMs', () => {
  const NOW = 1_700_000_000_000; // fixed base (ms) so the math is deterministic

  it('re-mints ~90s before a normal ~10-min token expires', () => {
    const validUntil = Math.floor(NOW / 1000) + 600; // epoch seconds, now + 600s
    expect(computeTokenRefreshDelayMs(validUntil, NOW)).toBe(600_000 - 90_000);
  });

  it('clamps an implausibly far-future expiry to the 30-min max (also guards setTimeout overflow)', () => {
    expect(computeTokenRefreshDelayMs(1799999999, NOW)).toBe(30 * 60_000);
  });

  it('floors a near/at-expiry token to a 20s minimum instead of hot-looping', () => {
    const almostGone = Math.floor(NOW / 1000) + 30; // only 30s left (< skew)
    expect(computeTokenRefreshDelayMs(almostGone, NOW)).toBe(20_000);
  });

  it('falls back to a fixed 8-min interval when CTM omits valid_until', () => {
    expect(computeTokenRefreshDelayMs(undefined, NOW)).toBe(8 * 60_000);
    expect(computeTokenRefreshDelayMs(null, NOW)).toBe(8 * 60_000);
    expect(computeTokenRefreshDelayMs('nope', NOW)).toBe(8 * 60_000);
  });
});

describe('createCtmSoftphone — proactive token refresh', () => {
  it('re-mints and hands a fresh token to the LIVE device before valid_until (no requiresToken, no teardown)', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-20T00:00:00Z'));
    const nowSec = Math.floor(Date.now() / 1000);
    const getToken = vi
      .fn()
      .mockResolvedValueOnce({ token: 'T1', valid_until: nowSec + 600, account_id: '596375', user: { account: '596375' } })
      .mockResolvedValueOnce({ token: 'T2', valid_until: nowSec + 600, account_id: '596375', user: { account: '596375' } });
    const { sp, el } = makeSoftphone({ getToken });
    await sp.ready;

    // First token (device connect).
    el.dispatchEvent(new CustomEvent('ctm:requiresToken', {}));
    await vi.advanceTimersByTimeAsync(0);
    expect(getToken).toHaveBeenCalledTimes(1);
    expect((el.accessToken as { token: string }).token).toBe('T1');

    // Cross the refresh point (valid_until − 90s ≈ 510s). No ctm:requiresToken and
    // no destroy — the refresh timer alone drives a silent re-mint into the device.
    await vi.advanceTimersByTimeAsync(511_000);
    expect(getToken).toHaveBeenCalledTimes(2);
    expect((el.accessToken as { token: string }).token).toBe('T2');

    sp.destroy();
    vi.useRealTimers();
  });

  it('keeps refreshing across cycles (self-reschedules for the whole session)', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-20T00:00:00Z'));
    const getToken = vi.fn().mockImplementation(() =>
      Promise.resolve({
        token: 'T',
        valid_until: Math.floor(Date.now() / 1000) + 600,
        account_id: 'x',
        user: { account: 'x' },
      }),
    );
    const { sp, el } = makeSoftphone({ getToken });
    await sp.ready;

    el.dispatchEvent(new CustomEvent('ctm:requiresToken', {}));
    await vi.advanceTimersByTimeAsync(0);
    expect(getToken).toHaveBeenCalledTimes(1);

    // Three refresh windows → three more mints, each rescheduling the next.
    await vi.advanceTimersByTimeAsync(511_000);
    await vi.advanceTimersByTimeAsync(511_000);
    await vi.advanceTimersByTimeAsync(511_000);
    expect(getToken).toHaveBeenCalledTimes(4);

    sp.destroy();
    vi.useRealTimers();
  });

  it('stops the refresh loop on destroy (no mint after teardown)', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-20T00:00:00Z'));
    const getToken = vi.fn().mockResolvedValue({
      token: 'T1',
      valid_until: Math.floor(Date.now() / 1000) + 600,
      account_id: 'x',
      user: { account: 'x' },
    });
    const { sp, el } = makeSoftphone({ getToken });
    await sp.ready;
    el.dispatchEvent(new CustomEvent('ctm:requiresToken', {}));
    await vi.advanceTimersByTimeAsync(0);
    expect(getToken).toHaveBeenCalledTimes(1);

    sp.destroy();
    await vi.advanceTimersByTimeAsync(30 * 60_000); // well past any refresh point
    expect(getToken).toHaveBeenCalledTimes(1); // the timer was cleared on destroy

    vi.useRealTimers();
  });

  it('still refreshes on the fallback interval when CTM omits valid_until', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-20T00:00:00Z'));
    const getToken = vi
      .fn()
      .mockResolvedValueOnce({ token: 'T1', account_id: 'x', user: { account: 'x' } }) // no valid_until
      .mockResolvedValueOnce({ token: 'T2', account_id: 'x', user: { account: 'x' } });
    const { sp, el } = makeSoftphone({ getToken });
    await sp.ready;
    el.dispatchEvent(new CustomEvent('ctm:requiresToken', {}));
    await vi.advanceTimersByTimeAsync(0);
    expect(getToken).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(8 * 60_000 + 1000); // past the 8-min fallback
    expect(getToken).toHaveBeenCalledTimes(2);
    expect((el.accessToken as { token: string }).token).toBe('T2');

    sp.destroy();
    vi.useRealTimers();
  });
});
