/// <reference types="@testing-library/jest-dom/vitest" />
// Task A4 — regression guard: "still says Ready" (the ground-truth root
// cause in the master plan, §A) is provably gone. This ties A1 (no warm
// singleton mounted in AppLayout) + A2 (the dialer hook's surface gate) +
// A3 (`/phone`/PhoneShell is the sole device-owner surface) together at an
// INTEGRATION level: unlike softphone-connecting-state.test.tsx (which
// stubs `useCtmSoftphone` itself), this file uses the REAL hook so the
// actual surface-gating logic runs. Only the CTM-adjacent seams
// (officeSoftphone.ts's device singleton, the flag, comm access, the
// communication data hooks) are mocked.
//
// Conditions are deliberately set to the ones that used to cold-boot the
// #813 warm singleton pre-fix: softphone flag ON + a comm-enabled org +
// a non-technician (ADMIN, the setup.ts default). If A1 or A2 regressed,
// the "never boots the device" assertion below would fail for the main
// app, and the "/phone" suite proves the ONLY legitimate way to see
// "Ready" is a real device-ready transition.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

vi.mock('@/lib/api/communication', () => ({
  BUSINESS_NUMBER: '(555) 555-0208',
  fmtPhone: (n: string) => n,
  usePhoneCustomers: () => ({ data: [] }),
  usePlaceCall: () => ({ mutate: vi.fn(), isPending: false }),
  useCallOutcome: () => ({ data: null }),
  useStashCallAttribution: () => ({
    mutate: vi.fn(),
    mutateAsync: vi.fn().mockResolvedValue({ queued: true }),
    isPending: false,
  }),
  // PhoneShell now hosts the full DialerWorkspace (search + softphone + panel);
  // its data hooks are out of scope for this "still says Ready" guard — stub to
  // empty so the search never fires and the panel stays idle.
  useCalls: () => ({ data: [] }),
  useDialerSearch: () => ({ data: undefined, isFetching: false }),
}));

vi.mock('@/lib/api/phoneNumbers', () => ({
  requestPhoneAccessToken: vi.fn().mockResolvedValue({ token: 'T' }),
  // Task B3 — PhoneShell's caller-ID picker is out of scope for this "still
  // says Ready" regression guard; stub it to no data (covered separately by
  // phone-shell-caller-id-picker.test.tsx).
  useMyNumbers: () => ({ data: undefined }),
}));

// Task B2 — the resolved caller-ID fetch is out of scope for this "still
// says Ready" regression guard; stub it to no data (covered separately by
// softphone-dialfrom.test.tsx).
vi.mock('@/lib/api/myOutboundNumber', () => ({
  useMyOutboundNumber: () => ({ data: undefined }),
}));

// A comm-enabled org — one of the two conditions (with the flag) that used
// to be enough to cold-boot the warm singleton.
vi.mock('@/lib/entitlements', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/entitlements')>()),
  useFeature: vi.fn(() => true),
}));

// The softphone feature flag — ON, per the task brief.
vi.mock('@/lib/communication/ctmSoftphone', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/communication/ctmSoftphone')>();
  return { ...actual, isCtmSoftphoneEnabled: vi.fn(() => true) };
});

// The only thing genuinely mocked here: the CTM device singleton itself.
// `subscribeOfficeSoftphoneReady` captures its callbacks in a real Set so a
// test can fire a "ctm:ready" transition by invoking them directly — the
// same shape officeSoftphone.ts uses in production (the underlying
// device's real 'ready' event flips the latch and notifies subscribers).
const readySubscribers = vi.hoisted(() => new Set<() => void>());

vi.mock('@/lib/communication/officeSoftphone', () => ({
  ensureOfficeSoftphone: vi.fn(),
  isOfficeSoftphoneReady: vi.fn(() => false),
  subscribeOfficeSoftphoneReady: vi.fn((cb: () => void) => {
    readySubscribers.add(cb);
    return () => readySubscribers.delete(cb);
  }),
}));

/* eslint-disable @typescript-eslint/no-explicit-any */

import { Softphone } from '../Softphone';
import { PhoneShell } from '@/pages/phone/PhoneShell';
import { ensureOfficeSoftphone } from '@/lib/communication/officeSoftphone';

function fakeDevice() {
  return { call: vi.fn(), dialFrom: vi.fn(), mute: vi.fn(), hangup: vi.fn(), on: vi.fn(() => () => {}) };
}

beforeEach(() => {
  vi.clearAllMocks();
  readySubscribers.clear();
});

describe('Main app (GlobalDialer\'s Softphone, no surface) — "still says Ready" is gone', () => {
  it('never boots the CTM device, even with the flag on + comm access granted — a "Ready" pill here can ONLY be the plain fallback', () => {
    // Exactly `<Softphone prefillNumber={...} .../>` at Dialer.tsx:450 — the
    // main-app GlobalDialer's call site, which passes no `surface` prop.
    render(<Softphone />);

    // The device is never created at all — not merely "not ready yet".
    // With no instance, there is no way a live CTM event produced the pill
    // text below; it can only be the `officeSoftphone === null` fallback.
    expect(ensureOfficeSoftphone).not.toHaveBeenCalled();

    expect(screen.getByText('Ready')).toBeInTheDocument();
    expect(screen.queryByText('Connecting…')).not.toBeInTheDocument();
  });
});

describe('/phone (PhoneShell, Task A3) — "Ready" only after a real ctm:ready event', () => {
  it('reads "Connecting…", not "Ready", before the device fires ready', () => {
    vi.mocked(ensureOfficeSoftphone).mockReturnValue(fakeDevice() as any);

    render(
      <MemoryRouter>
        <PhoneShell />
      </MemoryRouter>,
    );

    // PhoneShell is the sole caller that boots a device at all.
    expect(ensureOfficeSoftphone).toHaveBeenCalledTimes(1);
    expect(screen.getByText('Connecting…')).toBeInTheDocument();
    expect(screen.queryByText('Ready')).not.toBeInTheDocument();
  });

  it('flips to "Ready" only once the mocked ctm:ready transition fires — never before', () => {
    vi.mocked(ensureOfficeSoftphone).mockReturnValue(fakeDevice() as any);

    render(
      <MemoryRouter>
        <PhoneShell />
      </MemoryRouter>,
    );
    expect(screen.getByText('Connecting…')).toBeInTheDocument();

    // Simulate the real device's 'ready' event (bridged in officeSoftphone.ts
    // by flipping its isReady latch and notifying subscribers) — the exact
    // path a genuine `ctm:ready` from CTM drives in production.
    act(() => {
      readySubscribers.forEach((cb) => cb());
    });

    expect(screen.getByText('Ready')).toBeInTheDocument();
    expect(screen.queryByText('Connecting…')).not.toBeInTheDocument();
  });
});
