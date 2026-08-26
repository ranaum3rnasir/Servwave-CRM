import { useEffect, useRef, useState } from 'react';
import { useAuthStore } from '@/stores/auth.store';
import { useFeature } from '@/lib/entitlements';
import { requestPhoneAccessToken } from '@/lib/api/phoneNumbers';
import { isCtmSoftphoneEnabled, type CtmSoftphone, type SoftphoneFault } from './ctmSoftphone';
import {
  ensureOfficeSoftphone,
  getOfficeSoftphoneFault,
  isOfficeSoftphoneReady,
  subscribeOfficeSoftphoneReady,
  subscribeOfficeSoftphoneFault,
} from './officeSoftphone';

/**
 * Slice 4 — office WebRTC softphone lifecycle.
 *
 * Returns a handle ONLY for an office user (not a technician) of a
 * communication-enabled org WHEN the softphone flag is on AND the caller is
 * the `/phone` tab (`surface: 'phone-tab'`); otherwise `null`, and the caller
 * keeps the existing callback-bridge / `tel:` path unchanged. This is
 * the "device axis": role selects the transport, it does not fork the code.
 *
 * The flag defaults OFF, so this changes no current behavior until it is flipped
 * on for the pilot during live QA.
 *
 * Fix B (warm singleton): this hook is a SUBSCRIBER, not an owner. The actual
 * CtmSoftphone device lives in officeSoftphone.ts as a page-load-scoped
 * singleton that survives this hook mounting/unmounting (i.e. the dialer
 * popup opening/closing) — only a dedicated warm-up owner
 * (OfficeSoftphoneWarmup) creates it eagerly and tears it down on real logout.
 * `ready` is seeded synchronously from the singleton's latch (isOfficeSoftphoneReady)
 * so a hook mounted AFTER the device already finished booting reports ready
 * immediately, then this hook subscribes for any FUTURE ready transition.
 *
 * Task A2 (the OTHER boot path): the warm-up owner isn't the only thing that
 * could cold-boot the device — this hook's own mount effect could too, for
 * ANY caller. The `surface` gate closes that: `ensureOfficeSoftphone` only
 * runs when `surface === 'phone-tab'`. It defaults to `'inline'` (no boot),
 * so the main-app GlobalDialer popup (the only current caller, via
 * `Softphone.tsx`) never registers a device — the `/phone` route (Task A3)
 * is the sole surface that passes `'phone-tab'`.
 */
/** The caller-info payload carried by the device's 'incoming' event
 *  (bridged from CTM's `ctm:incomingCall` in ctmSoftphone.ts). The exact
 *  field names are unconfirmed pending live QA (see ctmSoftphone.ts's
 *  EVENT_MAP note), so this is passed through opaquely rather than parsed. */
export type IncomingCallInfo = Record<string, unknown>;

export interface OfficeSoftphone {
  /** True once the embed script loaded, the device mounted, and the token set. */
  ready: boolean;
  /**
   * Why the device is not ready, once that is knowable — null while it is
   * simply still booting, and null again if it eventually boots. Mutually
   * exclusive with `ready` (officeSoftphone.ts enforces it).
   *
   * This rides the SAME handle as `ready` deliberately. Every surface that can
   * show a softphone — the main app's GlobalDialer popup and the dedicated
   * `/phone` tab alike — reads the device only through this hook, so one field
   * here covers both. It stays null on the bridge/`tel:` path for the same
   * reason `ready` is irrelevant there: the hook returns null outright, so no
   * inline caller can ever be told a device failed that it never booted.
   */
  fault: SoftphoneFault | null;
  /** Place an outbound call through the browser (optionally with a resolved
   *  caller-ID TPN — the per-call picker lands in slice 5). */
  call(e164: string, fromTpnId?: string): void;
  mute(on: boolean): void;
  hangup(): void;
  /** Answer the ringing call on the REAL device (Task C1) — calls the
   *  wrapper's device answer(), not a local state simulation. */
  answer(): void;
  /** Subscribe to a real inbound ring (Task C1). Fires with the caller info
   *  carried by the device's 'incoming' event. Returns an unsubscribe fn. */
  onIncoming(cb: (info: IncomingCallInfo) => void): () => void;
}

export function useCtmSoftphone(handlers: {
  onStart?: () => void;
  onEnd?: () => void;
  onError?: (err: unknown) => void;
  /**
   * Device-boot gate (Task A2 — the dialer hook's "second boot path", the
   * other half of the #813 warm-singleton fix). Only the dedicated `/phone`
   * tab may cold-boot the shared CTM device; every inline caller (the
   * main-app GlobalDialer popup, entity call buttons, anything mounted
   * inside AppLayout) must stay a null handle so it falls back to the
   * existing callback-bridge / `tel:` path unchanged. Defaults to 'inline'
   * so every pre-existing call site is safe with zero changes — the future
   * `/phone` shell (Task A3) passes 'phone-tab' explicitly.
   */
  surface?: 'phone-tab' | 'inline';
}): OfficeSoftphone | null {
  const role = useAuthStore((s) => s.user?.role);
  const canComm = useFeature('phone');
  const isTechnician = role === 'TECHNICIAN';
  const surface = handlers.surface ?? 'inline';
  const enabled =
    isCtmSoftphoneEnabled() && canComm && !isTechnician && surface === 'phone-tab';

  const spRef = useRef<CtmSoftphone | null>(null);
  // Seed synchronously from the shared singleton's latch — a late subscriber
  // (a dialer opened after the device already finished booting) sees
  // ready=true on the very first render, with no need to wait for a fresh
  // 'ready' event (the event already fired once, in the past, and won't fire
  // again for this instance).
  const [ready, setReady] = useState(() => enabled && isOfficeSoftphoneReady());
  // Seeded from the getter for the same reason `ready` is: the 'fault' event
  // fires once, in the past, and a dialer opened afterwards must still see it.
  const [fault, setFault] = useState<SoftphoneFault | null>(() =>
    enabled ? getOfficeSoftphoneFault() : null,
  );

  // Keep handlers in a ref so the mount effect doesn't re-run when they change.
  const handlersRef = useRef(handlers);
  handlersRef.current = handlers;

  useEffect(() => {
    if (!enabled) return;
    // Get-or-create the ONE shared device — idempotent, officeSoftphone.ts
    // owns whether this actually creates anything.
    const sp = ensureOfficeSoftphone({ getToken: requestPhoneAccessToken });
    spRef.current = sp;
    const offStart = sp.on('start', () => handlersRef.current.onStart?.());
    const offEnd = sp.on('end', () => handlersRef.current.onEnd?.());
    const offErr = sp.on('error', (e) => handlersRef.current.onError?.(e));
    // Future transitions to ready — the "already ready" case is covered by the
    // synchronous seed above; this only fires for a device that boots WHILE
    // this hook is mounted.
    const offReady = subscribeOfficeSoftphoneReady(() => setReady(true));
    // RE-READ, don't assume: this channel also transitions back to null when a
    // slow device finally boots, so the notification alone says "changed", not
    // "faulted".
    const offFault = subscribeOfficeSoftphoneFault(() => setFault(getOfficeSoftphoneFault()));
    return () => {
      offStart();
      offEnd();
      offErr();
      offReady();
      offFault();
      // The device is a page-load-scoped singleton, not owned by this hook —
      // it survives unmount (the dialer closing). Only a dedicated warm-up
      // owner (OfficeSoftphoneWarmup) tears it down, on real session end.
    };
  }, [enabled]);

  if (!enabled) return null;
  return {
    ready,
    fault,
    call(e164: string, fromTpnId?: string) {
      if (fromTpnId) spRef.current?.dialFrom(fromTpnId);
      spRef.current?.call(e164);
    },
    mute(on: boolean) {
      spRef.current?.mute(on);
    },
    hangup() {
      spRef.current?.hangup();
    },
    answer() {
      // Task C1: the REAL device answer (ctmSoftphone.ts's answer() calls
      // el.answer?.()) — no local state simulation lives in this hook.
      spRef.current?.answer();
    },
    onIncoming(cb: (info: IncomingCallInfo) => void) {
      const off = spRef.current?.on('incoming', (payload) =>
        cb((payload ?? {}) as IncomingCallInfo),
      );
      return () => off?.();
    },
  };
}
