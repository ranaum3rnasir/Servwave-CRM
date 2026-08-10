// Fix B — the softphone's honest "Connecting…" loading state. While the
// shared office device (useCtmSoftphone's handle) is non-null but not yet
// ready, the status pill reads "Connecting…" instead of "Ready" and the Call
// button is disabled — so a user can't press Call into a device that hasn't
// finished booting. The bridge/tel path (officeSoftphone === null) must be
// byte-for-byte unchanged; that path is exercised by the existing
// softphone-entity-context suite (which never sets a device), and re-asserted
// here as a baseline.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';

const placeCall = vi.hoisted(() => ({
  mutate: vi.fn(),
  isPending: false,
}));

vi.mock('@/lib/api/communication', () => ({
  BUSINESS_NUMBER: '(555) 555-0208',
  fmtPhone: (n: string) => n,
  usePhoneCustomers: () => ({ data: [] }),
  usePlaceCall: () => placeCall,
  useCallOutcome: () => ({ data: null }),
  useStashCallAttribution: () => ({
    mutate: vi.fn(),
    mutateAsync: vi.fn().mockResolvedValue({ queued: true }),
    isPending: false,
  }),
}));

// Task B2 — the resolved caller-ID fetch is out of scope for this suite;
// stub it to no data so the office-softphone `call()` assertions below stay
// on their pre-B2 single-argument shape (covered separately by
// softphone-dialfrom.test.tsx).
vi.mock('@/lib/api/myOutboundNumber', () => ({
  useMyOutboundNumber: () => ({ data: undefined }),
}));

type FakeDevice = {
  ready: boolean;
  call: ReturnType<typeof vi.fn>;
  mute: ReturnType<typeof vi.fn>;
  hangup: ReturnType<typeof vi.fn>;
};
// null by default (bridge/tel path) — a test sets it to a fake handle to
// exercise the office-softphone path.
const softphone = vi.hoisted(() => ({ current: null as null | FakeDevice }));

vi.mock('@/lib/communication/useCtmSoftphone', () => ({
  useCtmSoftphone: () => softphone.current,
}));

import { Softphone } from '../Softphone';

beforeEach(() => {
  vi.clearAllMocks();
  softphone.current = null;
});

describe('Softphone — Connecting state (Fix B)', () => {
  it('reads "Ready" on the bridge/tel path (officeSoftphone null) — unchanged', () => {
    render(<Softphone />);
    expect(screen.getByText('Ready')).toBeInTheDocument();
    expect(screen.queryByText('Connecting…')).not.toBeInTheDocument();
  });

  it('reads "Connecting…" and disables Call while the shared device is still booting', () => {
    softphone.current = { ready: false, call: vi.fn(), mute: vi.fn(), hangup: vi.fn() };
    render(<Softphone prefillNumber="5555550212" />);

    expect(screen.getByText('Connecting…')).toBeInTheDocument();
    expect(screen.queryByText('Ready')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Call' })).toBeDisabled();
  });

  it('reads "Ready" and enables Call once the shared device finishes booting', () => {
    softphone.current = { ready: true, call: vi.fn(), mute: vi.fn(), hangup: vi.fn() };
    render(<Softphone prefillNumber="5555550212" />);

    expect(screen.getByText('Ready')).toBeInTheDocument();
    expect(screen.queryByText('Connecting…')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Call' })).not.toBeDisabled();
  });

  it('still disables Call with no dial value even once ready (pre-existing rule, untouched)', () => {
    softphone.current = { ready: true, call: vi.fn(), mute: vi.fn(), hangup: vi.fn() };
    render(<Softphone />);
    expect(screen.getByRole('button', { name: 'Call' })).toBeDisabled();
  });

  // The disabled Call button only blocks a mouse click on it — three other
  // paths call startOutbound()/reach sp.call() directly: autoCallNumber ("Call
  // back" from a call detail drawer), the global Enter keydown handler, and
  // the dial input's own Enter keydown. All three must respect the same
  // readiness guard as the button, or a user can place a call on a device
  // that hasn't finished booting (no auth token set yet).
  it('does not place a call via autoCallNumber while the shared device is still booting', () => {
    softphone.current = { ready: false, call: vi.fn(), mute: vi.fn(), hangup: vi.fn() };
    render(<Softphone autoCallNumber="5555550212" />);

    expect(softphone.current!.call).not.toHaveBeenCalled();
    // The guard returns before any state transition — still "Connecting…",
    // never "Calling…".
    expect(screen.getByText('Connecting…')).toBeInTheDocument();
    expect(screen.queryByText('Calling…')).not.toBeInTheDocument();
  });

  it('does not place a call via the global Enter keydown handler while still booting', () => {
    softphone.current = { ready: false, call: vi.fn(), mute: vi.fn(), hangup: vi.fn() };
    render(<Softphone prefillNumber="5555550212" />);

    // Move focus off the dial input so the WINDOW-level Enter handler runs
    // instead of the input's own onKeyDown (covered separately below).
    (document.activeElement as HTMLElement | null)?.blur();
    fireEvent.keyDown(window, { key: 'Enter' });

    expect(softphone.current!.call).not.toHaveBeenCalled();
  });

  it("does not place a call via the dial input's own Enter keydown while still booting", () => {
    softphone.current = { ready: false, call: vi.fn(), mute: vi.fn(), hangup: vi.fn() };
    render(<Softphone />);

    const input = screen.getByPlaceholderText('Enter a number');
    fireEvent.change(input, { target: { value: '5555550212' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    expect(softphone.current!.call).not.toHaveBeenCalled();
  });

  it('places the call via autoCallNumber once the shared device is ready (happy path — now behind the server pre-dial gate)', async () => {
    softphone.current = { ready: true, call: vi.fn(), mute: vi.fn(), hangup: vi.fn() };
    render(<Softphone autoCallNumber="5555550212" />);

    // The dial awaits the /calls/attribution authorize round-trip (O-0 gate),
    // so it lands a microtask after render rather than synchronously.
    await vi.waitFor(() => expect(softphone.current!.call).toHaveBeenCalledWith('+15555550212'));
  });
});
