// Fix B — the office-softphone warm-up. Renders null; its only observable
// behavior is calling ensureOfficeSoftphone() on the first real user gesture
// (not merely on mount — see the gesture-gating note in OfficeSoftphoneWarmup.tsx)
// and teardownOfficeSoftphone() on unmount, but only if it ever actually warmed.
// AppLayout (where this mounts) only fully unmounts on a REAL logout —
// ProtectedRoute swaps <Outlet/> for <Navigate to="/login"/> once
// isAuthenticated flips false — so "unmount = logout" holds here (case (a)).
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, fireEvent } from '@testing-library/react';

vi.mock('@/lib/communication/ctmSoftphone', () => ({
  isCtmSoftphoneEnabled: vi.fn(),
}));
vi.mock('@/lib/communication/officeSoftphone', () => ({
  ensureOfficeSoftphone: vi.fn(),
  teardownOfficeSoftphone: vi.fn(),
}));
vi.mock('@/lib/entitlements', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/entitlements')>()),
  useFeature: vi.fn(),
}));
vi.mock('@/lib/api/phoneNumbers', () => ({
  requestPhoneAccessToken: vi.fn().mockResolvedValue({ token: 'T' }),
}));

import { OfficeSoftphoneWarmup } from '@/components/communication/phone/OfficeSoftphoneWarmup';
import { isCtmSoftphoneEnabled } from '@/lib/communication/ctmSoftphone';
import {
  ensureOfficeSoftphone,
  teardownOfficeSoftphone,
} from '@/lib/communication/officeSoftphone';
import { requestPhoneAccessToken } from '@/lib/api/phoneNumbers';
import { useFeature } from '@/lib/entitlements';
import { useAuthStore } from '@/stores/auth.store';

/* eslint-disable @typescript-eslint/no-explicit-any */

function setup({ role = 'ADMIN', comm = true, flag = true } = {}) {
  vi.mocked(useAuthStore).mockImplementation((sel: any) => sel({ user: { role } }));
  vi.mocked(useFeature).mockReturnValue(comm);
  vi.mocked(isCtmSoftphoneEnabled).mockReturnValue(flag);
}

beforeEach(() => vi.clearAllMocks());

describe('OfficeSoftphoneWarmup', () => {
  it('renders nothing', () => {
    setup();
    const { container } = render(<OfficeSoftphoneWarmup />);
    expect(container).toBeEmptyDOMElement();
  });

  it('does NOT warm the device merely on mount (must wait for a real user gesture)', () => {
    setup({ role: 'ADMIN' });
    render(<OfficeSoftphoneWarmup />);
    expect(ensureOfficeSoftphone).not.toHaveBeenCalled();
  });

  it('warms the shared device on the first pointerdown for a qualifying office user', () => {
    setup({ role: 'ADMIN' });
    render(<OfficeSoftphoneWarmup />);
    fireEvent.pointerDown(document);
    expect(ensureOfficeSoftphone).toHaveBeenCalledTimes(1);
    expect(ensureOfficeSoftphone).toHaveBeenCalledWith({ getToken: requestPhoneAccessToken });
  });

  it('warms the shared device on the first keydown', () => {
    setup();
    render(<OfficeSoftphoneWarmup />);
    fireEvent.keyDown(document, { key: 'Tab' });
    expect(ensureOfficeSoftphone).toHaveBeenCalledTimes(1);
  });

  it('warms the shared device on the first touchstart', () => {
    setup();
    render(<OfficeSoftphoneWarmup />);
    fireEvent.touchStart(document);
    expect(ensureOfficeSoftphone).toHaveBeenCalledTimes(1);
  });

  it('only warms once even if multiple activation events fire in sequence', () => {
    setup();
    render(<OfficeSoftphoneWarmup />);
    fireEvent.pointerDown(document);
    fireEvent.keyDown(document, { key: 'Tab' });
    fireEvent.touchStart(document);
    expect(ensureOfficeSoftphone).toHaveBeenCalledTimes(1);
  });

  it('does not warm the device for a technician, even after a user gesture', () => {
    setup({ role: 'TECHNICIAN' });
    render(<OfficeSoftphoneWarmup />);
    fireEvent.pointerDown(document);
    expect(ensureOfficeSoftphone).not.toHaveBeenCalled();
  });

  it('does not warm the device when the flag is off (default), even after a user gesture', () => {
    setup({ flag: false });
    render(<OfficeSoftphoneWarmup />);
    fireEvent.pointerDown(document);
    expect(ensureOfficeSoftphone).not.toHaveBeenCalled();
  });

  it('does not warm the device for a comm-disabled org, even after a user gesture', () => {
    setup({ comm: false });
    render(<OfficeSoftphoneWarmup />);
    fireEvent.pointerDown(document);
    expect(ensureOfficeSoftphone).not.toHaveBeenCalled();
  });

  it('tears down the shared device when it unmounts after warming (AppLayout unmounts only on real logout)', () => {
    setup();
    const { unmount } = render(<OfficeSoftphoneWarmup />);
    fireEvent.pointerDown(document);
    unmount();
    expect(teardownOfficeSoftphone).toHaveBeenCalledTimes(1);
  });

  it('does not tear down when it never warmed the device (disabled path)', () => {
    setup({ flag: false });
    const { unmount } = render(<OfficeSoftphoneWarmup />);
    unmount();
    expect(teardownOfficeSoftphone).not.toHaveBeenCalled();
  });

  it('does not tear down when it unmounts BEFORE any user gesture occurred', () => {
    setup();
    const { unmount } = render(<OfficeSoftphoneWarmup />);
    unmount();
    expect(teardownOfficeSoftphone).not.toHaveBeenCalled();
  });

  // `enabled` recomputing false (flag/comm-access/role) while AppLayout stays
  // mounted is NOT a logout — only a real component unmount is. A cleanup
  // that fires whenever the `[enabled]` dependency changes (rather than only
  // on true unmount) would tear down the shared device out from under every
  // other consumer with no session having actually ended.
  it('does NOT tear down when `enabled` flips false while still mounted (not a real unmount)', () => {
    setup();
    const { rerender } = render(<OfficeSoftphoneWarmup />);
    fireEvent.pointerDown(document);
    expect(ensureOfficeSoftphone).toHaveBeenCalledTimes(1);

    vi.mocked(isCtmSoftphoneEnabled).mockReturnValue(false);
    rerender(<OfficeSoftphoneWarmup />);

    expect(teardownOfficeSoftphone).not.toHaveBeenCalled();
  });

  it('removes its activation listeners once `enabled` flips false, so a later gesture cannot warm a stale instance', () => {
    setup();
    const { rerender } = render(<OfficeSoftphoneWarmup />);

    vi.mocked(isCtmSoftphoneEnabled).mockReturnValue(false);
    rerender(<OfficeSoftphoneWarmup />);

    fireEvent.pointerDown(document);
    expect(ensureOfficeSoftphone).not.toHaveBeenCalled();
  });
});

// Multi-tab leader guard: only ONE tab keeps an eagerly-warmed idle device.
// jsdom has no Web Locks API, so the suite above exercises the fallback (every
// tab is its own leader). These stub navigator.locks to drive the two roles.
describe('OfficeSoftphoneWarmup — multi-tab leader guard', () => {
  afterEach(() => {
    if ('locks' in navigator) {
      // remove the stubbed Web Locks so other suites see jsdom's default (absent)
      delete (navigator as any).locks;
    }
  });

  it('a follower tab (another tab holds the lock) stays dormant — no eager warm on a gesture', () => {
    // Web Locks present but the request never grants → this tab never leads.
    Object.defineProperty(navigator, 'locks', {
      configurable: true,
      value: { request: vi.fn(() => new Promise(() => {})) },
    });
    setup({ role: 'ADMIN' });
    render(<OfficeSoftphoneWarmup />);
    fireEvent.pointerDown(document);
    expect(ensureOfficeSoftphone).not.toHaveBeenCalled();
  });

  it('the leader tab (it wins the lock) warms on the first gesture', () => {
    // Web Locks present and this tab is granted the lock immediately.
    Object.defineProperty(navigator, 'locks', {
      configurable: true,
      value: {
        request: vi.fn((_name: string, _opts: any, cb: () => Promise<unknown>) => {
          cb(); // grant → callback runs → this tab becomes the leader
          return new Promise(() => {});
        }),
      },
    });
    setup({ role: 'ADMIN' });
    render(<OfficeSoftphoneWarmup />);
    fireEvent.pointerDown(document);
    expect(ensureOfficeSoftphone).toHaveBeenCalledTimes(1);
  });
});
