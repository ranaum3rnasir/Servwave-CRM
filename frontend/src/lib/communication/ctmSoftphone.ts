/**
 * Slice 4 — CTM WebRTC softphone wrapper.
 *
 * A thin, typed adapter over CallTrackingMetrics' first-party `ctm-phone-embed`
 * web component so the rest of the app depends on a STABLE interface, not CTM's
 * element API. The office softphone talks *through the browser* (WebRTC) instead
 * of the callback bridge.
 *
 * The exact element method/event/attribute names come from reading the shipped
 * `ctm-phone-embed-1.0.js`; anywhere that is confirmed + fine-tuned against the
 * live component during Slice 4 QA is marked `LIVE-QA`. Because every CTM
 * specific is contained here, that tuning is a localized edit — nothing else in
 * the app changes.
 *
 * Auth: the embed never sees the agency keys. It authenticates with a short-lived
 * per-agent token minted by our backend (`requestPhoneAccessToken`, slice 1).
 * Cross-origin is token-authorized (no CTM console allowlist — Phase 0). The
 * component requests the token by firing `ctm:requiresToken`; we answer with the
 * FULL phone_access payload (it binds the device via account_id / user.account —
 * a bare token string does not). The WebRTC device (`ctm-device-embed`) runs in
 * THIS page (loaded from *.cloudfront.net), so mic/audio permission is on our own
 * origin; the cross-origin `phoneapp/embed` iframe is only the UI — no iframe
 * mic-delegation needed.
 */

const CTM_EMBED_SRC = 'https://app.calltrackingmetrics.com/ctm-phone-embed-1.0.js';
const CTM_ELEMENT_TAG = 'ctm-phone-embed';
// Once a token authenticates, the component appends a SIBLING <ctm-device-embed>
// to the document — the parent-page WebRTC device (mic + signalling websocket).
// destroy() must remove this too, or it outlives the UI until a full page reload.
const CTM_DEVICE_TAG = 'ctm-device-embed';
const CTM_HIDE_STYLE_ID = 'ctm-phone-embed-hide-style';

// CTM's own phone panel (the cross-origin `phoneapp/embed` iframe inside
// <ctm-phone-embed>) must never be visible — ServWave renders 100% of the call
// UI itself. That iframe is confirmed cross-origin (contentDocument is null), so
// we can only style the host element, not restyle its internals. `display:none`
// is avoided: it risks unloading the cross-origin iframe and severing the
// postMessage command/event bridge the wrapper depends on (el.call(), ctm:*
// events), so the host is visually suppressed instead of removed from the
// render tree. Injected once per document (idempotent) so it applies no matter
// where the element ends up mounted (today document.body; the /phone popout
// page later).
function ensureHiddenStyle(doc: Document) {
  if (doc.getElementById(CTM_HIDE_STYLE_ID)) return;
  const style = doc.createElement('style');
  style.id = CTM_HIDE_STYLE_ID;
  style.textContent = `${CTM_ELEMENT_TAG} { position: fixed; width: 0; height: 0; overflow: hidden; opacity: 0; pointer-events: none; clip-path: inset(50%); }`;
  (doc.head ?? doc.documentElement).appendChild(style);
}

export type SoftphoneEvent = 'ready' | 'start' | 'end' | 'incoming' | 'error';

/** The CTM phone_access payload our backend proxies through. The component's
 *  `accessToken` setter reads account_id / user.account off it, so it must be
 *  handed over WHOLE — a bare token string leaves the device unable to bind. */
export interface PhoneAccessResponse {
  token: string;
  valid_until?: number;
  [key: string]: unknown;
}

export interface CtmSoftphone {
  /** Resolves once the script is loaded and the element is mounted (the token
   *  handshake is then armed). Does NOT wait for the device to authenticate —
   *  subscribe to the 'ready' event for device-live. Rejects on script-load
   *  failure. */
  ready: Promise<void>;
  /** Place an outbound call through the browser. Set the caller ID via
   *  `dialFrom` FIRST when a number is resolved. */
  call(e164: string): void;
  /** Per-call caller ID: the CTM tracking-number id ("TPN…"). */
  dialFrom(trackingNumberId: string): void;
  answer(): void;
  hangup(): void;
  mute(on: boolean): void;
  /** Subscribe to a lifecycle event; returns an unsubscribe fn. */
  on(event: SoftphoneEvent, cb: (payload?: unknown) => void): () => void;
  destroy(): void;
}

/** The subset of the CTM element we drive. All optional — a live capability
 *  probe, and so the wrapper degrades instead of throwing if a method is absent. */
export interface CtmPhoneElement extends HTMLElement {
  accessToken?: PhoneAccessResponse;
  dialFrom?: { id: string };
  call?(number: string, options?: Record<string, unknown>): void;
  answer?(): void;
  hangup?(): void;
  mute?(on: boolean): void;
  addEventListener(type: string, listener: (ev: Event) => void): void;
}

export interface CreateCtmSoftphoneOptions {
  /** Mints the per-agent token (`requestPhoneAccessToken`) — the FULL payload. */
  getToken: () => Promise<PhoneAccessResponse>;
  /** Test seams (default to real DOM behavior). */
  documentRef?: Document;
  scriptLoader?: () => Promise<void>;
  elementFactory?: (doc: Document) => CtmPhoneElement;
}

/**
 * Feature flag — default ON (flipped from OFF for the Alpha Doors pilot after
 * live two-device QA verified the embed). The WebRTC softphone is now the office
 * outbound/inbound path on the `/phone` tab. Because the flip lives in code on
 * the staging branch, prod keeps the pre-flip (default-OFF) behavior until this
 * is promoted to `main` — branch separation is the prod gate, no env var needed.
 *
 * Escape hatches:
 *  - Per-browser kill-switch (no redeploy): `localStorage.ctm_softphone = 'off'`.
 *  - Explicit per-browser opt-in (unchanged): `localStorage.ctm_softphone = 'on'`.
 *  - Build-time force-off (e.g. to keep a promoted prod dark): `VITE_CTM_SOFTPHONE=false`.
 */
export function isCtmSoftphoneEnabled(): boolean {
  try {
    if (typeof localStorage !== 'undefined') {
      const v = localStorage.getItem('ctm_softphone');
      if (v === 'off') return false; // per-browser kill-switch wins
      if (v === 'on') return true; // explicit opt-in
    }
  } catch {
    /* SSR / storage blocked — fall through to the default */
  }
  // Default ON; only an explicit build-time 'false' forces it off.
  return (import.meta as unknown as { env?: Record<string, string> }).env?.VITE_CTM_SOFTPHONE !== 'false';
}

/**
 * Browser softphone is OUTBOUND-ONLY (2026-07-20 product decision).
 *
 * Inbound calls to ServWave tracking numbers are answered on the staff member's
 * CELL via the CTM mobile app — CTM's Smart-Router routes inbound to the cells,
 * not to this browser device. The browser must therefore never present a
 * competing in-browser answer path, or a warm device would race / double-ring
 * the cell. The backend still ingests EVERY inbound call from CTM's webhook into
 * the Communication hub and auto-attaches it to the customer; only the
 * in-BROWSER ring/answer UI is suppressed.
 *
 * This is also the safety prerequisite for keeping a warm outbound device alive
 * app-wide for instant click-to-call: a device that cannot answer inbound cannot
 * double-ring. Flip to `true` to restore in-app answering (the old Task C1/C2).
 */
export const BROWSER_INBOUND_ANSWER_ENABLED = false;

/** Inject the CTM embed script once; resolve when it loads (or immediately if a
 *  prior call already added it). Rejects on load error. */
export function loadCtmEmbedScript(doc: Document = document): Promise<void> {
  const existing = doc.querySelector<HTMLScriptElement>(`script[data-ctm-embed]`);
  if (existing) {
    if (existing.dataset.loaded === 'true') return Promise.resolve();
    return new Promise<void>((resolve, reject) => {
      existing.addEventListener('load', () => resolve());
      existing.addEventListener('error', () => reject(new Error('Softphone embed script failed to load')));
    });
  }
  return new Promise<void>((resolve, reject) => {
    const s = doc.createElement('script');
    s.src = CTM_EMBED_SRC;
    s.async = true;
    s.dataset.ctmEmbed = 'true';
    s.addEventListener('load', () => {
      s.dataset.loaded = 'true';
      resolve();
    });
    s.addEventListener('error', () => reject(new Error('Softphone embed script failed to load')));
    (doc.head ?? doc.body ?? doc.documentElement).appendChild(s);
  });
}

// Bridged to our stable events. Cross-checked against the shipped
// ctm-phone-embed-1.0.js: the component re-dispatches inbound iframe messages on
// its OWN listener registry (el.addEventListener → internal listeners, not native
// DOM bubbling), and its message handler treats `ctm:end-activity` as the call
// teardown signal — that is the confirmed INBOUND terminal event. `ctm:hangup` is
// the parent's OUTBOUND command, kept here only as a defensive fallback in case
// the device also echoes it inbound. There is no ctm:incoming / ctm:error —
// inbound is ctm:incomingCall and errors surface via our own emit('error').
// `ctm:requiresToken` is handled separately (auth handshake). LIVE-QA: confirm
// the exact inbound start / answer / end names against the running device in the
// two-device session before the flag is enabled for the pilot.
const EVENT_MAP: Record<string, SoftphoneEvent> = {
  'ctm:ready': 'ready',
  'ctm:start': 'start',
  'ctm:answer': 'start',
  'ctm:end-activity': 'end',
  'ctm:hangup': 'end',
  'ctm:incomingCall': 'incoming',
};

// ─── Proactive token refresh ─────────────────────────────────────────────────
// CTM mints a short-lived softphone token (`valid_until` ≈ now + 600s, set by
// CTM — we can't request longer) and never refreshes it. Left alone, an idle
// session lets the token lapse and the WebRTC device silently de-register, so
// the next click-to-call eats a reconnect — the very lag the warm device
// removed. So we re-mint BEFORE expiry and re-assign `el.accessToken`; the embed
// forwards the fresh token into the already-running device iframe in place (no
// reload — see device_embed's `accessGranted`), mirroring Twilio's
// tokenWillExpire → updateToken pattern. The device stays registered; the UI
// never shows a reconnect.
const TOKEN_REFRESH_SKEW_MS = 90_000; // re-mint this far before valid_until
const TOKEN_REFRESH_MIN_MS = 20_000; // floor — never hot-loop on a near/at-expiry token
const TOKEN_REFRESH_MAX_MS = 30 * 60_000; // ceiling — also guards setTimeout's 32-bit overflow
const TOKEN_REFRESH_FALLBACK_MS = 8 * 60_000; // when CTM omits valid_until (some plans do)

/**
 * ms until the next re-mint, derived from CTM's `valid_until` (epoch seconds).
 * Absent/garbled → a safe fixed fallback; the result is always clamped to
 * [MIN, MAX]. `now` is injectable so the math is deterministically testable.
 */
export function computeTokenRefreshDelayMs(validUntil: unknown, now: number = Date.now()): number {
  if (typeof validUntil === 'number' && Number.isFinite(validUntil) && validUntil > 0) {
    const delay = validUntil * 1000 - now - TOKEN_REFRESH_SKEW_MS;
    return Math.min(TOKEN_REFRESH_MAX_MS, Math.max(TOKEN_REFRESH_MIN_MS, delay));
  }
  return TOKEN_REFRESH_FALLBACK_MS;
}

export function createCtmSoftphone(opts: CreateCtmSoftphoneOptions): CtmSoftphone {
  const doc = opts.documentRef ?? document;
  const listeners = new Map<SoftphoneEvent, Set<(p?: unknown) => void>>();
  const emit = (ev: SoftphoneEvent, payload?: unknown) =>
    listeners.get(ev)?.forEach((cb) => cb(payload));

  let el: CtmPhoneElement | null = null;
  let destroyed = false;
  let refreshTimer: ReturnType<typeof setTimeout> | null = null;

  const clearRefreshTimer = () => {
    if (refreshTimer !== null) {
      clearTimeout(refreshTimer);
      refreshTimer = null;
    }
  };

  // Mint a token and hand the FULL access object to the device. The component's
  // `accessToken` setter reads account_id / user.account off it and forwards the
  // whole object to the device iframe — a bare token string can't bind the
  // account. Driven by the component's `ctm:requiresToken` request (fired on
  // connect AND whenever the device (re)boots) AND by our own refresh timer, so
  // the token is renewed before it can lapse and the device never de-registers.
  const provisionToken = async () => {
    if (destroyed || !el) return; // torn down before the mint — don't even ask CTM
    try {
      const access = await opts.getToken();
      if (destroyed || !el) return; // torn down mid-mint — don't apply to a dead device
      el.accessToken = access;
      // Renew before this token expires. The fresh token is handed to the LIVE
      // device in place (no reload); the timer self-perpetuates all session.
      scheduleTokenRefresh(access.valid_until);
    } catch (err) {
      if (!destroyed) emit('error', err);
    }
  };

  // (Re)arm the single refresh timer from the freshly-minted token's expiry. The
  // reactive ctm:requiresToken path also routes through here, so mint and timer
  // never double up: each successful mint clears and reschedules exactly one.
  const scheduleTokenRefresh = (validUntil: unknown) => {
    clearRefreshTimer();
    if (destroyed) return;
    refreshTimer = setTimeout(() => {
      refreshTimer = null;
      void provisionToken();
    }, computeTokenRefreshDelayMs(validUntil));
  };

  const ready = (async () => {
    const load = opts.scriptLoader ?? (() => loadCtmEmbedScript(doc));
    await load();
    if (destroyed) return;

    el = opts.elementFactory
      ? opts.elementFactory(doc)
      : (doc.createElement(CTM_ELEMENT_TAG) as CtmPhoneElement);

    // Arm the token handshake BEFORE mounting: the component's connectedCallback
    // dispatches ctm:requiresToken synchronously on append, so the listener must
    // already be registered.
    el.addEventListener('ctm:requiresToken', () => void provisionToken());

    // Bridge the component's lifecycle events → our stable lifecycle events.
    for (const [ctmEvent, mapped] of Object.entries(EVENT_MAP)) {
      el.addEventListener(ctmEvent, (ev: Event) =>
        emit(mapped, (ev as CustomEvent).detail),
      );
    }

    ensureHiddenStyle(doc);
    if (!doc.body?.contains(el)) {
      (doc.body ?? doc.documentElement).appendChild(el);
    }
  })().catch((err) => {
    // Script-load failure. Token failures surface via provisionToken's own catch;
    // device-live is the 'ready' event, driven by the real ctm:ready.
    emit('error', err);
  });

  return {
    ready,
    call(e164: string) {
      el?.call?.(e164);
    },
    dialFrom(trackingNumberId: string) {
      if (el) el.dialFrom = { id: trackingNumberId };
    },
    answer() {
      el?.answer?.();
    },
    hangup() {
      el?.hangup?.();
    },
    mute(on: boolean) {
      el?.mute?.(on);
    },
    on(event: SoftphoneEvent, cb: (payload?: unknown) => void) {
      let set = listeners.get(event);
      if (!set) {
        set = new Set();
        listeners.set(event, set);
      }
      set.add(cb);
      return () => set!.delete(cb);
    },
    destroy() {
      destroyed = true;
      clearRefreshTimer(); // stop the token-refresh loop before tearing down
      // Best-effort: end any active call so the device releases the mic + WebRTC
      // session before it is detached (not just orphaned).
      try {
        el?.hangup?.();
      } catch {
        /* ignore */
      }
      try {
        el?.remove();
      } catch {
        /* already detached */
      }
      // Removing only the phone-embed leaves the sibling <ctm-device-embed> (the
      // parent-page WebRTC device: mic + websocket) running until a page reload.
      // Tear it down too. There is one softphone globally, so removing every
      // device element in the document is safe.
      try {
        doc.querySelectorAll(CTM_DEVICE_TAG).forEach((node) => node.remove());
      } catch {
        /* ignore */
      }
      el = null;
      listeners.clear();
    },
  };
}
