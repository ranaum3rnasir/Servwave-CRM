import { useEffect, useRef } from 'react';
import { useAuthStore } from '@/stores/auth.store';
import { useFeature } from '@/lib/entitlements';
import { requestPhoneAccessToken } from '@/lib/api/phoneNumbers';
import { isCtmSoftphoneEnabled } from '@/lib/communication/ctmSoftphone';
import { ensureOfficeSoftphone, teardownOfficeSoftphone } from '@/lib/communication/officeSoftphone';
import { useSoftphoneWarmLeader } from '@/lib/communication/warmLeader';

/**
 * Fix B — warms the CTM office softphone the moment the authenticated app
 * shell mounts, instead of waiting for the user to open the dialer for the
 * first time. Renders nothing; its only job is to call ensureOfficeSoftphone()
 * so the embed script + WebRTC device finish booting BEFORE the dialer is
 * first opened (see officeSoftphone.ts for the warm-singleton itself).
 *
 * Gesture-gated warm-up (live regression fix, 2026-07-16): warming eagerly on
 * MOUNT (page load, no click yet) breaks the device. Browsers only grant a
 * page "user activation" after a real gesture (click/keydown/touch); WebRTC
 * audio playback for the answered call requires that activation, and CTM's
 * device never reaches `ctm:ready` without it — confirmed live: the shared
 * device sat on "Connecting…" indefinitely after a warm reload, mic
 * permission already granted, no duplicate elements, ctm:ready never fired.
 * Before Fix B, the device was created inside the dialer-open click handler —
 * always inside a real gesture, so it always worked. This restores that same
 * gesture-gated timing while keeping Fix B's whole point (device already
 * warm by the time the dialer opens, for any click that isn't itself the
 * dialer-open): instead of warming on mount, this arms one-time listeners for
 * the first pointerdown/keydown/touchstart anywhere on the page and warms on
 * that — the user's actual first interaction with the app, whatever it is.
 *
 * Gating mirrors useCtmSoftphone's `enabled` exactly: an office user (not a
 * technician) of a communication-enabled org — orgs on the `phone` plan
 * entitlement, per useFeature('phone') — with the ctm_softphone flag on. That
 * flag defaults ON (VITE_CTM_SOFTPHONE !== 'false'), with a per-browser
 * localStorage kill-switch, so for those pilot/demo office users this warms the
 * device on their first gesture; every other org fails the comm-access gate and
 * this stays inert. Mounted once, app-wide, in AppLayout — kept warm all session
 * for instant click-to-call. Safe because the browser softphone is outbound-only
 * (BROWSER_INBOUND_ANSWER_ENABLED = false): a warm device presents no in-browser
 * answer path, so it can't race the staff cell that CTM rings for inbound.
 *
 * Teardown ownership: this is the ONE place that may call
 * teardownOfficeSoftphone(), and it does so from a DEDICATED effect with an
 * empty dependency array, so its cleanup runs exactly once — on this
 * component's real unmount — and never merely because `enabled` recomputed.
 * That distinction matters because AppLayout (frontend/src/components/layout/
 * AppLayout.tsx) is the only place this mounts: it sits behind ProtectedRoute,
 * which renders <Navigate to="/login"/> instead of <Outlet/> once
 * isAuthenticated flips false (auth.store.ts logout()) — so AppLayout, and
 * everything under it including this component, only ever fully unmounts on a
 * REAL end of session. "Cleanup on unmount" correctly means "logout" here —
 * but only because the teardown effect is deliberately kept independent of
 * `enabled`'s dependency array. A single effect keyed on `[enabled]` would
 * re-fire its cleanup on every recompute of `enabled` (flag / comm-access /
 * role), which is an incidental re-render, not a logout, and would tear the
 * shared device down out from under every other consumer with no session
 * having actually ended. The `warmedRef` below carries "did THIS mounted
 * lifetime ever actually warm the device" across the two effects without
 * relying on either effect's closure staying fresh.
 *
 * (Dev-only note: React 18 StrictMode double-invokes effects on mount — one
 * extra listener-attach/detach cycle per page load in dev, harmless and
 * absent in production builds.)
 */

// Any one of these firing anywhere in the document counts as the user's
// first real interaction with the page — capture-phase + document-level so a
// descendant's stopPropagation() can't hide it from us.
const ACTIVATION_EVENTS = ['pointerdown', 'keydown', 'touchstart'] as const;

export function OfficeSoftphoneWarmup() {
  const role = useAuthStore((s) => s.user?.role);
  const canComm = useFeature('phone');
  const isTechnician = role === 'TECHNICIAN';
  const enabled = isCtmSoftphoneEnabled() && canComm && !isTechnician;

  // Single-tab leader guard: only the leader tab eagerly warms an idle device;
  // follower tabs stay dormant and warm on demand when their own dialer opens
  // (useCtmSoftphone, untouched). No Web Locks API → isLeader is true, i.e. the
  // prior every-tab-warms behavior. Safe either way under the outbound-only lock
  // — this only trims N redundant idle devices + token-refresh loops. See
  // warmLeader.ts.
  const isLeader = useSoftphoneWarmLeader(enabled);
  const armed = enabled && isLeader;

  const warmedRef = useRef(false);

  // Arm activation listeners whenever `armed` (enabled AND this is the warm-leader
  // tab) is or becomes true; warm the device on the first gesture, then remove
  // them. `armed` flipping false (leadership lost or the gate closed, no gesture
  // yet) just detaches the listeners via this effect's cleanup — it must never
  // tear down an already-warm device; only the unmount-only effect below may.
  useEffect(() => {
    if (!armed) return;

    const warm = () => {
      ACTIVATION_EVENTS.forEach((type) => document.removeEventListener(type, warm, true));
      ensureOfficeSoftphone({ getToken: requestPhoneAccessToken });
      warmedRef.current = true;
    };
    ACTIVATION_EVENTS.forEach((type) => document.addEventListener(type, warm, true));

    return () => {
      ACTIVATION_EVENTS.forEach((type) => document.removeEventListener(type, warm, true));
    };
  }, [armed]);

  // Real-unmount-only teardown: the empty dependency array means this effect
  // is set up once and its cleanup fires exactly once, on true unmount.
  useEffect(() => {
    return () => {
      if (warmedRef.current) teardownOfficeSoftphone();
    };
  }, []);

  return null;
}
