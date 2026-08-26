// The bridge dialer's ended state.
//
// Click-to-call rings the agent's phone and then dials the customer, so the
// browser is never on the call and gets no lifecycle events. Before this, the
// console entered a terminal "Call placed" and stayed there: reported live on
// 2026-08-06 after a real conversation, where the screen never moved once the
// call was over and the only affordance was "Dismiss".
//
// The 'end' webhook is the only thing that knows the call finished (it writes
// the CallSession ~30-40s after hangup), so the console polls for exactly that
// row and flips to a real ended state with the real duration when it lands.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';

const placeCall = vi.hoisted(() => ({
  mutate: vi.fn(),
  isPending: false,
}));
// What the outcome poll currently sees: null while the webhook has not landed,
// then the ingested CallSession.
const outcome = vi.hoisted(() => ({ current: null as null | Record<string, unknown> }));
// Captures the (toNumber, since) the console asks about, so we can prove the
// poll is pinned to THIS call rather than "any call to this number, ever".
const outcomeArgs = vi.hoisted(() => ({ current: [] as unknown[] }));

vi.mock('@/lib/api/communication', () => ({
  BUSINESS_NUMBER: '(551) 282-7064',
  fmtPhone: (n: string) => n,
  usePhoneCustomers: () => ({ data: [] }),
  usePlaceCall: () => placeCall,
  useCallOutcome: (...args: unknown[]) => {
    outcomeArgs.current = args;
    return { data: outcome.current };
  },
  useStashCallAttribution: () => ({
    mutate: vi.fn(),
    mutateAsync: vi.fn().mockResolvedValue({ queued: true }),
    isPending: false,
  }),
}));

vi.mock('@/lib/api/myOutboundNumber', () => ({
  useMyOutboundNumber: () => ({ data: undefined }),
}));

// null throughout: this suite is the BRIDGE path, the only one that can reach
// the "placed" state at all.
vi.mock('@/lib/communication/useCtmSoftphone', () => ({
  useCtmSoftphone: () => null,
}));

import { Softphone } from '../Softphone';

/** Place a call and let the bridge mutation succeed, landing in "placed". */
function placeACall() {
  fireEvent.click(screen.getByRole('button', { name: 'Call' }));
  // noUncheckedIndexedAccess makes calls[0] possibly-undefined, and asserting it
  // is better than silencing it: if the Call click ever stops reaching the
  // mutation, every test here would otherwise fail on a confusing render
  // assertion rather than on the thing that actually broke.
  const dial = placeCall.mutate.mock.calls[0];
  if (!dial) throw new Error('Call was never placed - usePlaceCall().mutate was not invoked');
  const onSuccess = (dial[1] as { onSuccess: () => void }).onSuccess;
  // The bridge mutation is mocked, so its success callback is invoked by hand -
  // inside act() so the resulting "placed" render flushes before assertions.
  act(() => {
    onSuccess();
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  outcome.current = null;
  outcomeArgs.current = [];
});

describe('Softphone - bridge call ended state', () => {
  it('still reads "Call placed" while the end webhook has not landed', () => {
    render(<Softphone prefillNumber="9294039424" />);
    placeACall();

    expect(screen.getAllByText('Call placed').length).toBeGreaterThanOrEqual(2);
    expect(screen.queryByText(/Call ended/)).not.toBeInTheDocument();
    // The pre-existing "your phone rings first" guidance is the right copy
    // while the call may still be in progress.
    expect(screen.getByText(/Your phone will ring first/)).toBeInTheDocument();
  });

  it('flips to a real ended state with the call duration once the row lands', () => {
    outcome.current = { id: 'ca-1', status: 'completed', durationSec: 19 };
    render(<Softphone prefillNumber="9294039424" />);
    placeACall();

    // Both surfaces that reported "Call placed" must now agree: the status pill
    // and the in-console status line. Leaving either stale is the same bug.
    expect(screen.getAllByText('Call ended').length).toBeGreaterThanOrEqual(2);
    expect(screen.getByText('0:19')).toBeInTheDocument();
    expect(screen.queryByText('Call placed')).not.toBeInTheDocument();
    // "Dismiss" implies discarding something in progress; once the call is over
    // the action is an acknowledgement.
    expect(screen.getByRole('button', { name: 'Done' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Dismiss' })).not.toBeInTheDocument();
  });

  it('formats a call over a minute as m:ss, not raw seconds', () => {
    outcome.current = { id: 'ca-2', status: 'completed', durationSec: 154 };
    render(<Softphone prefillNumber="9294039424" />);
    placeACall();

    expect(screen.getByText('2:34')).toBeInTheDocument();
  });

  // Guards the bug this endpoint's `since` floor exists to prevent: without a
  // dial-time floor the first poll matches an OLDER call to the same customer
  // and reports its duration as this call's.
  it('pins the poll to this destination and to the moment it dialled', () => {
    const before = Date.now();
    render(<Softphone prefillNumber="9294039424" />);
    placeACall();

    const [toNumber, since] = outcomeArgs.current as [string | null, string | null];
    expect(toNumber).toBe('+19294039424');
    expect(since).toBeTruthy();
    const dialedAt = Date.parse(since as string);
    expect(Number.isNaN(dialedAt)).toBe(false);
    expect(dialedAt).toBeGreaterThanOrEqual(before - 1000);
  });

  it('asks nothing while idle - the poll is scoped to a placed call', () => {
    render(<Softphone prefillNumber="9294039424" />);

    const [toNumber, since] = outcomeArgs.current as [string | null, string | null];
    expect(toNumber).toBeNull();
    expect(since).toBeNull();
  });
});
