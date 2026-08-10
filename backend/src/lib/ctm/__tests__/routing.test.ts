// Task C3 — CTM routing helpers. Automates the two CONFIRMED endpoints
// (voicemail voice-menu creation + number->voice-menu dial_routes) and
// documents the rest (Queue/Agent scaffold — unconfirmed via API) as a pure
// instruction generator. Mocks the CTM client (`setup.ts`) — never hits the
// network. Master plan Phase C, Task C3.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as ctmClient from '../client';
import { ensureVoicemailMenu, routeNumberToVoiceMenu, describeManualQueueScaffold } from '../routing';

/* eslint-disable @typescript-eslint/no-explicit-any */
const client = ctmClient as any;

const ACCOUNT_ID = '596375';

beforeEach(() => {
  vi.clearAllMocks();
});

describe('ensureVoicemailMenu', () => {
  it('posts a voicemail-message voice menu and returns the id CTM assigns', async () => {
    client.createVoiceMenu.mockResolvedValue({ id: 'VOM123' });

    const id = await ensureVoicemailMenu(ACCOUNT_ID, { name: 'Art Nakamura — Voicemail' });

    expect(client.createVoiceMenu).toHaveBeenCalledWith(ACCOUNT_ID, {
      name: 'Art Nakamura — Voicemail',
      items: [
        {
          voice_action_type: 'message',
          recording: '1',
          transcribe: '0',
          play_beep: '1',
          timer: '120',
        },
      ],
    });
    expect(id).toBe('VOM123');
  });

  it('requests transcription when opted in', async () => {
    client.createVoiceMenu.mockResolvedValue({ id: 'VOM124' });

    await ensureVoicemailMenu(ACCOUNT_ID, { name: 'Voicemail', transcribe: true });

    expect(client.createVoiceMenu).toHaveBeenCalledWith(
      ACCOUNT_ID,
      expect.objectContaining({
        items: [expect.objectContaining({ transcribe: '1' })],
      }),
    );
  });

  it('skips the POST entirely when an existing id is already known (idempotent from our side)', async () => {
    const id = await ensureVoicemailMenu(ACCOUNT_ID, { name: 'Voicemail', existingId: 'VOM-OLD' });

    expect(id).toBe('VOM-OLD');
    expect(client.createVoiceMenu).not.toHaveBeenCalled();
  });

  it('throws if CTM does not echo back an id (nothing to persist)', async () => {
    client.createVoiceMenu.mockResolvedValue({});

    await expect(ensureVoicemailMenu(ACCOUNT_ID, { name: 'Voicemail' })).rejects.toThrow();
  });

  it('extracts the id from a nested voice_menu envelope if that is what CTM returns', async () => {
    client.createVoiceMenu.mockResolvedValue({ voice_menu: { id: 'VOM777' } });

    const id = await ensureVoicemailMenu(ACCOUNT_ID, { name: 'Voicemail' });

    expect(id).toBe('VOM777');
  });
});

describe('routeNumberToVoiceMenu', () => {
  it('PUTs dial_routes with dial_route:"voice_menu" and the given voice menu id', async () => {
    client.addReceivingToTracking.mockResolvedValue({});

    await routeNumberToVoiceMenu(ACCOUNT_ID, 'TPN789', 'VOM123');

    expect(client.addReceivingToTracking).toHaveBeenCalledWith(ACCOUNT_ID, 'TPN789', {
      virtual_phone_number: { dial_route: 'voice_menu', voice_menu_id: 'VOM123' },
    });
  });
});

describe('describeManualQueueScaffold', () => {
  it('returns instructions containing the given voice menu id, name and number', () => {
    const instructions = describeManualQueueScaffold({
      ctmAgentName: 'Art Nakamura',
      voiceMenuId: 'VOM123',
      voiceMenuName: 'Art Nakamura — Voicemail',
      numberFormatted: '(555) 555-0212',
    });

    const joined = [instructions.title, instructions.summary, ...instructions.steps].join(' ');
    expect(joined).toContain('VOM123');
    expect(joined).toContain('Art Nakamura — Voicemail');
    expect(joined).toContain('(555) 555-0212');
    expect(joined).toContain('Art Nakamura');
  });

  it('falls back to generic wording when no agent name is given', () => {
    const instructions = describeManualQueueScaffold({
      voiceMenuId: 'VOM1',
      voiceMenuName: 'Voicemail',
      numberFormatted: '(555) 123-4567',
    });

    const joined = instructions.steps.join(' ');
    expect(joined).toMatch(/this user/i);
    expect(joined).toContain('VOM1');
    expect(joined).toContain('(555) 123-4567');
  });

  // This copy is rendered to org admins on the Phone Numbers settings page, so
  // it must never name the upstream telephony vendor.
  it('never names the upstream provider in any user-visible field', () => {
    for (const input of [
      { ctmAgentName: 'Art Nakamura', voiceMenuId: 'VOM123', voiceMenuName: 'Art Nakamura — Voicemail', numberFormatted: '(555) 555-0212' },
      { voiceMenuId: 'VOM1', voiceMenuName: 'Voicemail', numberFormatted: '(555) 123-4567' },
    ]) {
      const i = describeManualQueueScaffold(input);
      const joined = [i.title, i.summary, ...i.steps].join(' ');
      expect(joined).not.toMatch(/\bCTM\b/i);
      expect(joined).not.toMatch(/calltrackingmetrics/i);
    }
  });

  it('is a pure function — never calls the CTM client', () => {
    describeManualQueueScaffold({
      voiceMenuId: 'VOM1',
      voiceMenuName: 'Voicemail',
      numberFormatted: '(555) 123-4567',
    });

    expect(client.createVoiceMenu).not.toHaveBeenCalled();
    expect(client.addReceivingToTracking).not.toHaveBeenCalled();
  });
});
