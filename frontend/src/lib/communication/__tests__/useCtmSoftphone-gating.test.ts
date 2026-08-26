// Task A2 — device-boot gate. Ground truth (master plan §A, "still says
// Ready"): the CTM device has TWO boot paths — the warm singleton
// (OfficeSoftphoneWarmup, removed from AppLayout in Task A1) and this hook
// (useCtmSoftphone.ts:68, `ensureOfficeSoftphone`). This closes the second
// path: only the dedicated `/phone` tab ('phone-tab' surface) may cold-boot
// the shared device. Every inline caller (the main-app GlobalDialer popup,
// entity call buttons, anything mounted inside AppLayout) must get a
// null handle instead — the SAME shape as `enabled=false` — so it falls
// back to the existing callback-bridge / `tel:` path (Softphone's plain
// "Ready" pill, covered by softphone-connecting-state.test.tsx).
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook } from '@testing-library/react';

vi.mock('@/lib/communication/ctmSoftphone', () => ({
  isCtmSoftphoneEnabled: vi.fn(),
}));
vi.mock('@/lib/communication/officeSoftphone', () => ({
  ensureOfficeSoftphone: vi.fn(),
  isOfficeSoftphoneReady: vi.fn(),
  // Returns a real unsubscribe fn, like the new fault mock below: the hook's
  // cleanup CALLS whatever this returns, so a bare vi.fn() only survives because
  // every setup() here re-arms it. Self-sufficient is one keystroke cheaper than
  // that dependency.
  subscribeOfficeSoftphoneReady: vi.fn(() => () => {}),
  // Slice 3's fault channel. Healthy by default so every pre-existing case in
  // this file keeps exercising exactly the state it was written for.
  getOfficeSoftphoneFault: vi.fn(() => null),
  subscribeOfficeSoftphoneFault: vi.fn(() => () => {}),
}));
vi.mock('@/lib/entitlements', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/entitlements')>()),
  useFeature: vi.fn(),
}));
vi.mock('@/lib/api/phoneNumbers', () => ({
  requestPhoneAccessToken: vi.fn().mockResolvedValue({ token: 'T' }),
}));

import { useCtmSoftphone } from '@/lib/communication/useCtmSoftphone';
import { isCtmSoftphoneEnabled } from '@/lib/communication/ctmSoftphone';
import {
  ensureOfficeSoftphone,
  isOfficeSoftphoneReady,
  subscribeOfficeSoftphoneReady,
} from '@/lib/communication/officeSoftphone';
import { useFeature } from '@/lib/entitlements';
import { useAuthStore } from '@/stores/auth.store';

/* eslint-disable @typescript-eslint/no-explicit-any */

function setup({ role = 'ADMIN', comm = true, flag = true } = {}) {
  vi.mocked(useAuthStore).mockImplementation((sel: any) => sel({ user: { role } }));
  vi.mocked(useFeature).mockReturnValue(comm);
  vi.mocked(isCtmSoftphoneEnabled).mockReturnValue(flag);
  vi.mocked(isOfficeSoftphoneReady).mockReturnValue(false);
  vi.mocked(subscribeOfficeSoftphoneReady).mockReturnValue(() => {});
}

function fakeSp() {
  return {
    call: vi.fn(),
    dialFrom: vi.fn(),
    mute: vi.fn(),
    hangup: vi.fn(),
    on: () => () => {},
  };
}

beforeEach(() => vi.clearAllMocks());

describe('useCtmSoftphone — surface gate (Task A2)', () => {
  it("does NOT boot the device for the 'inline' surface (main app: GlobalDialer, entity call buttons)", () => {
    setup();
    const { result } = renderHook(() => useCtmSoftphone({ surface: 'inline' }));
    expect(ensureOfficeSoftphone).not.toHaveBeenCalled();
    expect(result.current).toBeNull();
  });

  it('does NOT boot the device when no surface is given — default is inline, so every pre-existing call site stays safe', () => {
    setup();
    const { result } = renderHook(() => useCtmSoftphone({}));
    expect(ensureOfficeSoftphone).not.toHaveBeenCalled();
    expect(result.current).toBeNull();
  });

  it("DOES boot the device for the 'phone-tab' surface (the dedicated /phone route)", () => {
    const sp = fakeSp();
    vi.mocked(ensureOfficeSoftphone).mockReturnValue(sp as any);
    setup();

    const { result } = renderHook(() => useCtmSoftphone({ surface: 'phone-tab' }));

    expect(ensureOfficeSoftphone).toHaveBeenCalledTimes(1);
    expect(result.current).not.toBeNull();
  });

  it('still returns null for the phone-tab surface when an existing gate (role/comm/flag) is closed — surface never bypasses them', () => {
    setup({ role: 'TECHNICIAN' });
    const { result } = renderHook(() => useCtmSoftphone({ surface: 'phone-tab' }));

    expect(ensureOfficeSoftphone).not.toHaveBeenCalled();
    expect(result.current).toBeNull();
  });
});
