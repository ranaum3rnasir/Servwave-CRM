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

// CTM's own phone UI must never be visible — ServWave renders 100% of the call
// UI itself. BOTH vendor hosts need suppressing, not just the obvious one:
//
//   <ctm-phone-embed>  — wraps the cross-origin `phoneapp/embed` panel iframe.
//   <ctm-device-embed> — the sibling the component appends once the token
//                        authenticates. Its child iframe (`phoneapp/embed_device`)
//                        carries the vendor's own `width:100%; min-height:400px;
//                        height:100%`, so left unstyled it lays out full-width and
//                        400px+ tall directly after #root, doubling
//                        body.scrollHeight. It paints blank while the device is
//                        healthy — which is why this went unnoticed — but it is
//                        the frame the "Check Station to Get Started" gate renders
//                        into, so in the failure state it is a full-width vendor
//                        panel. It stayed off-screen only because the app shell
//                        happens to set overflow:hidden on html/body; that is a
//                        layout accident, not containment, and one shell change
//                        undoes it.
//
// Both iframes are cross-origin (contentDocument is null), so we can only style
// the host elements, never restyle their internals. `display:none` is avoided:
// it risks unloading the iframes and severing the postMessage command/event
// bridge the wrapper depends on (el.call(), ctm:* events) — and for the device
// host it would put a live WebRTC session and its mic in a frame detached from
// layout — so the hosts are visually suppressed instead of removed from the
// render tree. `position: fixed` additionally takes them out of flow, which is
// what stops the device host contributing its height to the page.
//
// Injected once per document (idempotent) and keyed on the TAG NAMES rather than
// on nodes, so it applies no matter when or where each element is mounted — the
// device host is appended by vendor code we never call, at a moment we do not
// control, long after this style is in the document.
function ensureHiddenStyle(doc: Document) {
  if (doc.getElementById(CTM_HIDE_STYLE_ID)) return;
  const style = doc.createElement('style');
  style.id = CTM_HIDE_STYLE_ID;
  style.textContent = `${CTM_ELEMENT_TAG}, ${CTM_DEVICE_TAG} { position: fixed; width: 0; height: 0; overflow: hidden; opacity: 0; pointer-events: none; clip-path: inset(50%); }`;
  (doc.head ?? doc.documentElement).appendChild(style);
}

export type SoftphoneEvent = 'ready' | 'start' | 'end' | 'incoming' | 'error' | 'fault';

/**
 * Why the device gave up, and when. Emitted at most once per instance as the
 * 'fault' event, and only while the device is NOT ready — a booted device has
 * no fault. Each value maps 1:1 to one sentence the user can act on; that
 * mapping lives in the UI, not here, so this module stays vendor-facing and the
 * rendered copy stays ServWave's own.
 *
 *  • 'locked-out'    — another tab holds the exclusive device lock. Terminal and
 *                      self-inflicted: the fix is to close the other tab.
 *  • 'station-check' — the microphone gate is what is holding boot up.
 *  • 'unknown'       — the boot budget expired with nothing to pin it on.
 */
export type SoftphoneFault = 'locked-out' | 'station-check' | 'unknown';

/** The CTM phone_access payload our backend proxies through. The component's
 *  `accessToken` setter reads account_id / user.account off it, so it must be
 *  handed over WHOLE — a bare token string leaves the device unable to bind. */
export interface PhoneAccessResponse {
  token: string;
  valid_until?: number;
  /** Opt out of CTM's microphone "station check" gate. NOT minted by our backend
   *  — the wrapper stamps it onto the copy it hands the element (see
   *  provisionToken for why the gate is unsatisfiable in our UI). The index
   *  signature below already permits it; it is spelled out so the intent, and
   *  the fact that it is ours and not CTM's, survives the next reader. */
  disableStationCheck?: boolean;
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

// ─── Device boot watchdog (the station-check rescue) ─────────────────────────
// `disableStationCheck` (see provisionToken) is the vendor-supported opt-out from
// CTM's 8-hourly microphone gate, but it lands ONE BEAT TOO LATE to rescue the
// load that needs it:
//
//   • The gate is evaluated inside the CROSS-ORIGIN `phoneapp/embed_device`
//     document, not in our page. (Our-side `CtmDeviceEmbed.connectedCallback`
//     only wires a message listener and checks sessionStorage — the
//     `pendingStationCheck = !hasStationChecked()` logic lives in the iframe's own
//     bundle.) That document reads its localStorage at parse time, as it loads.
//   • The parent only posts `ctm:accessGranted` (the message whose handler writes
//     a fresh `ctm.stationCheck`) on `iframe.onload` — strictly later.
//
// So on a cold load whose 8-hour check has lapsed, the flag is written AFTER the
// gate has already been evaluated: the device still renders "Check Station to Get
// Started", still never calls bootPhone(), and ctm:ready never fires. The flag
// only takes effect on the NEXT device creation. Live QA confirmed exactly this —
// the working fix took two passes: seed the flag, then destroy and recreate the
// device.
//
// This watchdog forces that second pass automatically: if ctm:ready has not fired
// this long after the element mounts, build a fresh device, which now reads the
// seeded flag as its document parses and boots. Removing the stale node is not
// cosmetic — CTM's device takes a
// navigator.locks.request("ctm.phone.device", {ifAvailable:true, mode:"exclusive"})
// and a loser skips boot() entirely, so the stale context MUST leave the document
// (releasing its lock) or the replacement cannot boot at all.
//
// THE BUDGET. This is not timing one request, it is timing a four-step chain:
//   1. our token endpoint — TWO hops (browser → Render, which then POSTs CTM),
//      and a cold Render dyno adds seconds on its own;
//   2. a second CloudFront fetch for the device element script;
//   3. the cross-origin `phoneapp/embed_device` document plus its own bundle;
//   4. WebRTC registration / signalling websocket.
// On a cold load with an unwarmed dyno on poor wifi that chain finishes around
// 11s. At 8s the watchdog fired INSIDE a healthy boot, tore the device out
// mid-registration and roughly DOUBLED the user's connect time. The asymmetry
// settles the number: a real station-check hang is INFINITE, so making a gated
// user wait 15s instead of 8s costs almost nothing, while every false positive
// costs a healthy user a doubled boot and a wasted mint. Raise this, never lower
// it, unless the chain above has measurably shortened.
const STATION_CHECK_REBUILD_MS = 15_000;

// A rescue that cannot mint must not retry for ever. A `phone`-entitled org with
// no `ctm_account_id` gets 409 CTM_NOT_CONNECTED on EVERY call, so an unbounded
// re-arm would be an endless 409 loop, each one re-raising the connect banner via
// emit('error') — far worse than the hang it set out to fix. Two attempts total:
// one retry, then stop permanently. Because the rescue now mints BEFORE it
// destroys anything (see rebuildDeviceForStationCheck), stopping leaves the page
// exactly as it was, never worse.
const MAX_RESCUE_ATTEMPTS = 2;

// ─── Boot-fault detection (making the remaining failures legible) ────────────
// The watchdog above can rescue ONE cause. Everything else it cannot fix used to
// render as an eternal "Connecting…" — honest about not being ready, silent
// about why, and with no way to ever stop saying it. These signals are what let
// the UI say something true instead.
//
// WHAT REACHES OUR PAGE, verified against the shipped bundles (2026-08-25):
//   device_embed-f302d977…js (runs in OUR document, defines <ctm-device-embed>)
//     builds `<iframe src="https://app.calltrackingmetrics.com/phoneapp/embed_device?…">`
//     as its own child — so that iframe's `window.parent` IS our window.
//   device-fdd25abe…js (runs INSIDE that iframe) does, verbatim:
//     async ensureSingleTab(){ await navigator.locks.request("ctm.phone.device",
//       {ifAvailable:!0,mode:"exclusive"}, async e=>{
//         if(e) return window.parent.postMessage({action:"ctm.device.locked_in"},"*"),
//                       this.locked=!1, await this.boot(), … ;
//         window.parent.postMessage({action:"ctm.device.locked_out"},"*"),
//         this.locked=!0, this.renderLocked() }) }
//     i.e. the LOSER of the lock never calls boot(), so ctm:ready can never fire
//     for it — no timeout will ever save it. It also posts
//     {action:"ctm.device.inline_ready"} at the very END of stationCheckHandler(),
//     once the mic gate has passed AND the device has registered.
//   Those are the only three parent-directed messages carrying an `action` key,
//   and `action` is all the handler below reads. The bundles DO post other things
//   to window.parent — `grep -o 'window\.parent\.postMessage({[^}]*}'` returns 6
//   across the three files (embed.js 2, device_embed 1, device 3) — but the other
//   three are `{eventName, eventDetail}` UI-bridge messages, which cannot reach
//   any branch here.
//
// WHAT DOES NOT REACH OUR PAGE: there is no station-check signal. The device
// announces the gate with `this.channel.postMessage({action:"ctm.device.station_check"…})`
// where `this.channel = new BroadcastChannel("__phone_device")`, and
// BroadcastChannel is partitioned by ORIGIN — that channel belongs to
// app.calltrackingmetrics.com, not to us. The parent embed bundle never mentions
// the station check at all (case-insensitive grep for "station": 0 hits in both
// ctm-phone-embed-1.0.js and device_embed-*.js). So the gate is INFERRED from
// CTM's own control flow instead, below.
//
// SECURITY. Both bundles post with targetOrigin "*", so the messages are
// broadcast, and any page holding a handle to our window (an opener, an embedder)
// could forge one and drive our softphone state. `event.origin` is the only
// trustworthy discriminator and is checked before a payload is read at all;
// `event.source` identity is deliberately NOT used as the check, since a
// same-window-graph frame satisfies it without being CTM.
const CTM_MESSAGE_ORIGIN = 'https://app.calltrackingmetrics.com';
const DEVICE_LOCKED_IN = 'ctm.device.locked_in';
const DEVICE_LOCKED_OUT = 'ctm.device.locked_out';
const DEVICE_INLINE_READY = 'ctm.device.inline_ready';

// How long the device gets to announce itself before the UI stops saying
// "Connecting…" and says something true.
//
// This one is armed at CONSTRUCTION, not after the embed script loads, because a
// script load that never settles (appended, network hangs, no `error` event ever
// fired) is one of the failures it has to cover — and nothing downstream of
// `await load()` runs in that case. That zero point is what sets the number:
//
//   ~3s   fetching ctm-phone-embed-1.0.js itself
//   15s   STATION_CHECK_REBUILD_MS — the rescue's own deadline, measured from
//         the element mounting
//   ~11s  the rebuilt device's boot chain (token → CloudFront → the cross-origin
//         embed_device document → WebRTC registration), the cold-load figure the
//         15s budget above was itself derived from
//   ≈29s  a HEALTHY boot that needed the rescue
//
// So 2 × STATION_CHECK_REBUILD_MS = 30s sits right on top of that, and a rescued
// boot would flash "Audio check required" for a moment before self-correcting to
// "Ready". 40s keeps the margin. Raise it, don't lower it: the failure worth
// fixing is the INFINITE wait, not the 30-second one, and every false positive
// spends a healthy user's trust. A fault raised over a still-in-flight boot is
// not sticky in any case — officeSoftphone.ts retracts it the instant ctm:ready
// lands.
const BOOT_FAULT_DEADLINE_MS = 40_000;

export function createCtmSoftphone(opts: CreateCtmSoftphoneOptions): CtmSoftphone {
  const doc = opts.documentRef ?? document;
  const listeners = new Map<SoftphoneEvent, Set<(p?: unknown) => void>>();
  const emit = (ev: SoftphoneEvent, payload?: unknown) =>
    listeners.get(ev)?.forEach((cb) => cb(payload));

  let el: CtmPhoneElement | null = null;
  let destroyed = false;
  let refreshTimer: ReturnType<typeof setTimeout> | null = null;
  // Boot-watchdog state (see STATION_CHECK_REBUILD_MS above).
  let bootWatchdogTimer: ReturnType<typeof setTimeout> | null = null;
  let readyFired = false; // the real ctm:ready — i.e. the device actually booted
  let rebuiltOnce = false; // a rescue that actually rebuilt is final
  let rescueAttempts = 0; // bounded by MAX_RESCUE_ATTEMPTS — see above
  // Boot-fault state (see BOOT_FAULT_DEADLINE_MS above). All three flags are set
  // ONLY from origin-verified CTM messages.
  let lockedOut = false; // the device lost navigator.locks("ctm.phone.device")
  let lockedIn = false; // …or won it, and therefore entered boot()
  let inlineReady = false; // …and got all the way through the mic gate
  let faultRaised = false; // one fault per instance, ever
  let faultTimer: ReturnType<typeof setTimeout> | null = null;

  const clearRefreshTimer = () => {
    if (refreshTimer !== null) {
      clearTimeout(refreshTimer);
      refreshTimer = null;
    }
  };

  const clearBootWatchdog = () => {
    if (bootWatchdogTimer !== null) {
      clearTimeout(bootWatchdogTimer);
      bootWatchdogTimer = null;
    }
  };

  const clearFaultDeadline = () => {
    if (faultTimer !== null) {
      clearTimeout(faultTimer);
      faultTimer = null;
    }
  };

  /** Announce the fault exactly once, and never for a device that is already
   *  live or already gone. */
  const raiseFault = (fault: SoftphoneFault) => {
    if (destroyed || readyFired || faultRaised) return;
    faultRaised = true;
    clearFaultDeadline();
    emit('fault', fault);
  };

  /**
   * What to blame when the boot budget runs out.
   *
   * `lockedIn && !inlineReady` is the station-check inference. Between those two
   * messages the vendor's device has exactly one place it parks indefinitely:
   *
   *   this.hasStationChecked()
   *     ? (this.pendingStationCheck = !1, await this.stationCheckHandler())   // → inline_ready
   *     : (this.pendingStationCheck = !0,
   *        this.button.innerHTML = "Check Station to Get Started", …)          // → waits for a click
   *
   * and that button renders inside the host `ensureHiddenStyle` deliberately
   * makes invisible and unclickable, so nobody is ever going to click it. The
   * only other non-arriving path is stationCheckHandler() throwing, whose own
   * vendor copy is "Reconnect your headset, then try again" — the same remedy.
   *
   * HONEST LIMIT: a boot that wedges BEFORE reaching that branch (WebRTC
   * registration itself failing, say) is misattributed to the audio check by this
   * rule. That is accepted rather than hidden — the alternative is the eternal
   * "Connecting…" this slice exists to kill, and a wrong-but-actionable message
   * beats no message. Narrowing it needs a signal CTM does not currently send us.
   *
   * 'locked-out' is deliberately NOT a case here. That one is raised eagerly the
   * moment the message lands (there is nothing left to wait for), which stands
   * this deadline down — so a lockedOut branch in here would be unreachable.
   */
  const classifyBootFault = (): SoftphoneFault =>
    lockedIn && !inlineReady ? 'station-check' : 'unknown';

  const armFaultDeadline = () => {
    if (destroyed || readyFired || faultRaised) return;
    clearFaultDeadline();
    faultTimer = setTimeout(() => {
      faultTimer = null;
      raiseFault(classifyBootFault());
    }, BOOT_FAULT_DEADLINE_MS);
  };

  /**
   * The ONLY reader of CTM's parent-directed device messages.
   *
   * The origin check is the whole security boundary: both bundles broadcast with
   * targetOrigin "*", so without it any page that can reach our window could
   * post {action:"ctm.device.locked_out"} and put a permanent "Phone active in
   * another tab" on a perfectly healthy phone (or, via locked_in, steer the fault
   * classification). It is checked BEFORE `ev.data` is read at all.
   */
  const onDeviceMessage = (ev: MessageEvent) => {
    if (ev.origin !== CTM_MESSAGE_ORIGIN) return;
    const action = (ev.data as { action?: unknown } | null | undefined)?.action;
    if (action === DEVICE_LOCKED_IN) {
      lockedIn = true;
      return;
    }
    if (action === DEVICE_INLINE_READY) {
      inlineReady = true;
      return;
    }
    if (action !== DEVICE_LOCKED_OUT) return;
    lockedOut = true;
    // Suppress the slice-2 rescue. A lock loser skipped boot() entirely; the
    // replacement would ask for the same exclusive lock and lose it to the same
    // holder, so a rebuild is a guaranteed-futile token mint. The honest message
    // is the fix, and it can be raised NOW — there is nothing left to wait for.
    clearBootWatchdog();
    raiseFault('locked-out');
  };

  // Registered here, synchronously with construction, so a message that lands
  // while the embed script is still downloading is not missed. Removed in
  // destroy() — see the teardown there.
  const win: Window | null =
    doc.defaultView ?? (typeof window !== 'undefined' ? window : null);
  win?.addEventListener('message', onDeviceMessage);

  // Armed HERE — synchronously, before anything can hang — and deliberately NOT
  // after the element mounts. Everything below lives downstream of `await load()`
  // in the construction IIFE, so a script load that never settles would leave no
  // deadline armed at all and put the eternal "Connecting…" straight back. The
  // rejecting case is handled separately in that IIFE's .catch (nothing to wait
  // for once the script is known to be blocked); this covers the case that never
  // rejects either.
  armFaultDeadline();

  // Mint a token and hand the FULL access object to the device. The component's
  // `accessToken` setter reads account_id / user.account off it and forwards the
  // whole object to the device iframe — a bare token string can't bind the
  // account. Driven by the component's `ctm:requiresToken` request (fired on
  // connect AND whenever the device (re)boots) AND by our own refresh timer, so
  // the token is renewed before it can lapse and the device never de-registers.
  //
  // `prepareAssign` runs AFTER the mint resolves and IMMEDIATELY BEFORE the
  // payload reaches the element; returning false abandons the assignment, leaving
  // the refresh timer exactly as it was. Only the rescue passes it — it is the
  // seam that lets a device teardown sit inside this one mint/stamp/schedule path
  // instead of forking a second copy of it. Resolves true only if the element
  // actually received a token.
  const provisionToken = async (prepareAssign?: () => boolean): Promise<boolean> => {
    if (destroyed || !el) return false; // torn down before the mint — don't even ask CTM
    try {
      const access = await opts.getToken();
      if (destroyed || !el) return false; // torn down mid-mint — don't apply to a dead device
      if (prepareAssign && !prepareAssign()) return false; // caller withdrew post-mint
      // Hand over a COPY carrying `disableStationCheck` — `access` itself must not
      // be mutated, it is still read for its valid_until on the next line.
      //
      // CTM's device gates boot behind a microphone "station check" that expires
      // every 8 hours (it stores `ctm.stationCheck` = {checked, timestamp} and
      // treats timestamp + 288e5 < now as lapsed). Once lapsed the device renders
      // a blocking "Check Station to Get Started" screen and never calls
      // bootPhone() — the ONLY emitter of ctm:ready — so the softphone sits on
      // "Connecting…" for ever with no error. That screen renders inside the
      // DEVICE host's iframe, not the phone host's — the string lives only in the
      // `phoneapp/embed_device` bundle — and ensureHiddenStyle above suppresses
      // both hosts, because ServWave renders 100% of the call UI itself. Either
      // way the user is blocked behind a button they cannot press: before that
      // style covered the device host the gate was merely off-screen, parked
      // below an overflow:hidden shell. CTM's own bootstrap honours this flag — on
      // the `ctm:accessGranted` message it writes a fresh `ctm.stationCheck`
      // itself — so this is the vendor-supported opt-out, not a hack.
      //
      // ORDERING CAVEAT: CTM writes that entry when its iframe RECEIVES the
      // message, which is AFTER its connectedCallback has already read
      // localStorage. The flag therefore only takes effect on the NEXT device
      // creation, so on its own it does not rescue a cold load whose check has
      // already lapsed. STATION_CHECK_REBUILD_MS below is what forces that next
      // creation; the two halves are useless apart.
      el.accessToken = { ...access, disableStationCheck: true };
      // Renew before this token expires. The fresh token is handed to the LIVE
      // device in place (no reload); the timer self-perpetuates all session.
      scheduleTokenRefresh(access.valid_until);
      return true;
    } catch (err) {
      if (!destroyed) emit('error', err);
      return false;
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

  // The station-check rescue. At most MAX_RESCUE_ATTEMPTS attempts, only while the
  // device has failed to announce itself, and never after teardown.
  //
  // ORDER IS LOAD-BEARING: mint FIRST, tear down LAST. The obvious shape —
  // destroy, then mint, then assign — has two defects, both proved with probes:
  //
  //   • A failing mint leaves NOTHING. The old device is already gone and the
  //     assignment that would recreate it never happens, so the page carries no
  //     device at all until the surviving refresh timer next fires — up to ~510s
  //     of dead phone. Minting first means a failed rescue destroys nothing and
  //     leaves the page exactly as it found it.
  //   • ctm:ready can land mid-mint. It arrives as a window postMessage relayed by
  //     the phone-embed's handler, which survives device removal, so one already in
  //     flight at the deadline resolves ~1ms after the pre-mint guard passed. The
  //     post-await re-check below is what stops us rebuilding a device that just
  //     announced itself.
  //
  // The removal must stay IMMEDIATELY ADJACENT to the assignment: CTM's
  // ensureDeviceEmbed() de-dupes on `document.querySelector("ctm-device-embed")`,
  // so if the node still exists the setter merely re-posts into the SAME iframe and
  // the station-check gate is never re-evaluated — the rescue would do nothing at
  // all. Removing first, in the same synchronous block, is what forces a create.
  //
  // That adjacency is safe for the Web Lock too. The replacement asks for
  // "ctm.phone.device" with {ifAvailable:true} and silently skips boot() if it
  // loses, but it only asks once ITS document has loaded and run its bundle —
  // hundreds of ms after remove() — which is ample for the discarded context to
  // release. (The lock window comes from the replacement's own load, NOT from the
  // mint round-trip: under this ordering the mint has already completed before
  // anything is removed.)
  const rebuildDeviceForStationCheck = async () => {
    if (destroyed || readyFired || rebuiltOnce || lockedOut || rescueAttempts >= MAX_RESCUE_ATTEMPTS || !el)
      return;
    rescueAttempts += 1;

    const assigned = await provisionToken(() => {
      // Post-mint, pre-assign. Re-check everything the pre-mint guard checked —
      // the await is a window in which ctm:ready, destroy(), or a locked_out
      // message can land. (A device iframe slow enough to resolve its lock after
      // the 15s deadline reaches exactly this window; without `lockedOut` here
      // the rescue would tear down and re-mint for a device that had just told
      // us it will never boot.)
      if (destroyed || readyFired || rebuiltOnce || lockedOut || !el) return false;
      rebuiltOnce = true; // one-shot: a rebuild loop would thrash the mic + websocket
      try {
        doc.querySelectorAll(CTM_DEVICE_TAG).forEach((node) => node.remove());
      } catch {
        /* nothing to detach */
      }
      return true;
    });
    if (assigned) return; // rebuilt — done for the life of this softphone

    // We minted nothing and destroyed nothing. Allow one more go; armBootWatchdog's
    // own guards make this a no-op if the reason we didn't assign was ctm:ready or
    // destroy(), and MAX_RESCUE_ATTEMPTS makes a persistently failing mint stop
    // permanently rather than re-arm for ever.
    armBootWatchdog();
  };

  // Armed at mount, and re-armed ONLY by a rescue that minted nothing. It can
  // never loop: every attempt increments rescueAttempts, and the guard below
  // refuses to arm past MAX_RESCUE_ATTEMPTS. If a rebuilt device still cannot
  // boot, the cause is not the station check and retrying buys nothing —
  // reporting that honestly to the user is a separate change.
  const armBootWatchdog = () => {
    if (destroyed || readyFired || rebuiltOnce || rescueAttempts >= MAX_RESCUE_ATTEMPTS) return;
    clearBootWatchdog();
    bootWatchdogTimer = setTimeout(() => {
      bootWatchdogTimer = null;
      void rebuildDeviceForStationCheck();
    }, STATION_CHECK_REBUILD_MS);
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

    // Device-live, tracked internally. A DEDICATED listener rather than piggy-
    // backing on the EVENT_MAP bridge above: that bridge exists to serve external
    // subscribers, and the watchdog must not depend on anyone having subscribed
    // (nor on the bridge's mapping surviving a future edit). Registered here,
    // BEFORE the element is appended, so a ctm:ready dispatched synchronously from
    // connectedCallback cannot slip past us and leave a watchdog armed against an
    // already-booted device.
    el.addEventListener('ctm:ready', () => {
      readyFired = true;
      clearBootWatchdog();
      clearFaultDeadline(); // a live device has nothing to report
    });

    ensureHiddenStyle(doc);
    if (!doc.body?.contains(el)) {
      (doc.body ?? doc.documentElement).appendChild(el);
    }

    // Mounted — the device now has STATION_CHECK_REBUILD_MS to announce itself.
    // Armed after the append (the listener above is already in place, so an
    // instant ctm:ready has set readyFired and this becomes a no-op).
    armBootWatchdog();
    // The fault deadline is NOT (re-)armed here: it started ticking at
    // construction, and re-arming would restart its clock from the point the
    // script finished loading — i.e. exclude the very load time it is budgeted
    // to cover.
  })().catch((err) => {
    // Script-load failure. Token failures surface via provisionToken's own catch;
    // device-live is the 'ready' event, driven by the real ctm:ready.
    emit('error', err);
    // …and a fault, for the same reason locked_out raises one eagerly: there is
    // nothing left to wait for. `emit` is fire-and-forget with no latch, and on a
    // warm-up boot this fires with ZERO 'error' subscribers — the only onError
    // handler lives in Softphone.tsx, which mounts later — so without this the
    // failure is dropped on the floor and the dialer opened afterwards reads
    // "Connecting…" for ever. This is an ordinary failure, not an exotic one:
    // a call-TRACKING host is squarely on privacy blocklists, and a corporate
    // proxy or CSP blocks it just as well.
    raiseFault('unknown');
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
      clearBootWatchdog(); // …and the boot watchdog, so it can't rebuild a dead device
      clearFaultDeadline(); // …and the fault deadline, so it can't accuse a dead device
      // The window listener outlives the element unless we take it off — it was
      // added to the window, not to a node the removals below reach.
      win?.removeEventListener('message', onDeviceMessage);
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
