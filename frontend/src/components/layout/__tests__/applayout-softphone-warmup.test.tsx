/// <reference types="@testing-library/jest-dom/vitest" />
// Instant-dialer warm-up (2026-07-20) — AppLayout mounts <OfficeSoftphoneWarmup/>
// so the CTM WebRTC voice device warms on the user's FIRST gesture. Click-to-call
// is then instant instead of paying the multi-second "Connecting…" wait on the
// first dialer-open (the device registers once, up front, and stays warm all
// session). This reverses the earlier Task A1 guard, which had REMOVED the
// warm-up from AppLayout. Re-mounting it is safe only because the browser
// softphone is now OUTBOUND-ONLY (BROWSER_INBOUND_ANSWER_ENABLED = false): a warm
// device presents no in-browser answer path, so it can never race / double-ring
// the staff cell that CTM Smart-Router rings for inbound.
//
// This guard wraps the REAL OfficeSoftphoneWarmup export in a spy (its actual
// gesture-listening logic still runs) and forces its own `enabled` gate open
// (communication access + the softphone flag both true), so a document gesture
// genuinely reaches ensureOfficeSoftphone — proving the warm-up is not just
// mounted but wired end-to-end.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, screen } from '@testing-library/react';
import { Route, Routes } from 'react-router-dom';
import { renderWithProviders } from '@/__tests__/helpers';
import { buildAbility } from '@/lib/ability';

vi.mock('@/components/communication/phone/OfficeSoftphoneWarmup', async (importOriginal) => {
  const actual = await importOriginal<
    typeof import('@/components/communication/phone/OfficeSoftphoneWarmup')
  >();
  return { ...actual, OfficeSoftphoneWarmup: vi.fn(actual.OfficeSoftphoneWarmup) };
});
vi.mock('@/lib/communication/officeSoftphone', () => ({
  ensureOfficeSoftphone: vi.fn(),
  teardownOfficeSoftphone: vi.fn(),
}));
vi.mock('@/lib/entitlements', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/entitlements')>();
  return { ...actual, useFeature: vi.fn(() => true) };
});
vi.mock('@/lib/communication/ctmSoftphone', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/communication/ctmSoftphone')>();
  return { ...actual, isCtmSoftphoneEnabled: vi.fn(() => true) };
});

import { OfficeSoftphoneWarmup } from '@/components/communication/phone/OfficeSoftphoneWarmup';
import { ensureOfficeSoftphone } from '@/lib/communication/officeSoftphone';
import AppLayout from '../AppLayout';

const adminAbility = buildAbility([{ action: 'manage', subject: 'all' }]);

function renderAppLayout() {
  return renderWithProviders(
    <Routes>
      <Route element={<AppLayout />}>
        <Route path="/" element={<div>Dashboard Screen</div>} />
      </Route>
    </Routes>,
    { initialEntries: ['/'], ability: adminAbility }
  );
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('AppLayout — CTM softphone warm-up (instant dialer)', () => {
  it('mounts OfficeSoftphoneWarmup so the office device can warm', () => {
    renderAppLayout();

    expect(screen.getByText('Dashboard Screen')).toBeInTheDocument();
    expect(OfficeSoftphoneWarmup).toHaveBeenCalled();
  });

  it('warms the office softphone on the first user gesture', () => {
    renderAppLayout();

    // Nothing warms on mount — the device only boots on a real user gesture
    // (WebRTC audio needs user activation; warming on mount breaks the device).
    expect(ensureOfficeSoftphone).not.toHaveBeenCalled();

    fireEvent.pointerDown(document);

    expect(ensureOfficeSoftphone).toHaveBeenCalledTimes(1);
  });

  it('warms only once, however many gestures follow', () => {
    renderAppLayout();

    fireEvent.pointerDown(document);
    fireEvent.keyDown(document, { key: 'Tab' });
    fireEvent.touchStart(document);

    expect(ensureOfficeSoftphone).toHaveBeenCalledTimes(1);
  });
});
