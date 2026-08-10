import { addReceivingToTracking, createVoiceMenu } from './client';

/**
 * CTM inbound-routing helpers (master plan Phase C, Task C3 — resolves #44
 * / open item #1). Automates ONLY what's a live-verified, documented CTM REST
 * endpoint; everything CTM's Postman workspace lists but doesn't publicly
 * document a request body for (Queue creation, Agent assignment, a Queue's
 * No-Answer target, Distribute mode) is a one-time MANUAL CTM-UI scaffold —
 * `describeManualQueueScaffold` turns that gap into a clear instruction
 * instead of a silent no-op. **Never touches CTM Smart-Router routing.**
 *
 * CONFIRMED and automated here:
 *  - POST /accounts/{accountId}/voice_menus          → ensureVoicemailMenu
 *  - PUT  /accounts/{accountId}/numbers/{id}/dial_routes → routeNumberToVoiceMenu
 *
 * If a future session gets live sandbox CTM credentials and confirms the
 * Queue/Agent endpoints, swap `describeManualQueueScaffold`'s call site (D2)
 * for a real API call — one function per concern here, so that swap doesn't
 * touch `ensureVoicemailMenu` / `routeNumberToVoiceMenu`.
 */

export interface EnsureVoicemailMenuOpts {
  /** Voice menu display name, e.g. "Art Nakamura — Voicemail". */
  name: string;
  /** Whether CTM should transcribe the voicemail (default false — recording only). */
  transcribe?: boolean;
  /**
   * A voice menu id already known to us (persisted by the caller — Task D2 —
   * after the first creation). CTM has no confirmed "list voice menus"
   * endpoint to check for an existing one, so idempotency is enforced from
   * OUR side: when present, this is a no-op and the id is returned unchanged.
   */
  existingId?: string;
}

function extractVoiceMenuId(response: Record<string, unknown>): string | null {
  const direct = response.id ?? response.voice_menu_id;
  if (direct != null && direct !== '') return String(direct);
  const nested = response.voice_menu;
  if (nested && typeof nested === 'object' && 'id' in nested) {
    const nestedId = (nested as Record<string, unknown>).id;
    if (nestedId != null && nestedId !== '') return String(nestedId);
  }
  return null;
}

/**
 * Creates a voicemail voice menu (CONFIRMED endpoint) and returns its id.
 * Idempotent from our side via `opts.existingId` — skips the POST entirely
 * when a known id is passed in.
 */
export async function ensureVoicemailMenu(
  accountId: string,
  opts: EnsureVoicemailMenuOpts,
): Promise<string> {
  if (opts.existingId) return opts.existingId;

  const response = await createVoiceMenu(accountId, {
    name: opts.name,
    items: [
      {
        voice_action_type: 'message',
        recording: '1',
        transcribe: opts.transcribe ? '1' : '0',
        play_beep: '1',
        timer: '120',
      },
    ],
  });

  const id = extractVoiceMenuId(response);
  if (!id) {
    throw new Error(
      'The phone system did not return a voice menu id for the created voicemail menu.',
    );
  }
  return id;
}

/**
 * Points a number's dial route at a Voice Menu (CONFIRMED endpoint + body
 * shape). Reuses the existing generic dial_routes PUT wrapper in client.ts.
 */
export async function routeNumberToVoiceMenu(
  accountId: string,
  numberId: string,
  voiceMenuId: string,
): Promise<void> {
  await addReceivingToTracking(accountId, numberId, {
    virtual_phone_number: { dial_route: 'voice_menu', voice_menu_id: voiceMenuId },
  });
}

export interface ManualQueueScaffoldInput {
  /** The CTM agent's display name, if known — used to make the instruction
   * concrete. Omitted → generic "this user's CTM agent" wording. */
  ctmAgentName?: string;
  /** The (already-created, via ensureVoicemailMenu) voicemail Voice Menu id. */
  voiceMenuId: string;
  /** The voicemail Voice Menu's display name, so the admin can find it by
   * name in the CTM UI without needing the id. */
  voiceMenuName: string;
  /** Human-formatted number, e.g. "(555) 555-0212". */
  numberFormatted: string;
}

export interface ManualQueueScaffoldInstructions {
  title: string;
  summary: string;
  steps: string[];
}

/**
 * PURE — no API call. The upstream Queue creation / Agent assignment /
 * No-Answer target / Distribute mode aren't confirmed API-drivable, so one
 * call-routing step per user/org still has to be done by ServWave support in
 * the provider console. This copy is RENDERED TO ORG ADMINS
 * (PhoneNumbersSettingsPage), so it must never name or describe the upstream
 * provider — it hands the admin the details support needs and stops there.
 */
export function describeManualQueueScaffold(
  input: ManualQueueScaffoldInput,
): ManualQueueScaffoldInstructions {
  const agentLabel = input.ctmAgentName ? `"${input.ctmAgentName}"` : 'this user';
  return {
    title: `One-time setup step needed for ${input.numberFormatted}`,
    summary:
      'Everything ServWave can configure automatically is done — the voicemail box and this ' +
      "number's routing are already set up. One call-routing step still has to be completed by " +
      'ServWave support. Contact support with the details below and they will finish it for you.',
    steps: [
      `Number to set up: ${input.numberFormatted}.`,
      `Ring this number to: ${agentLabel}.`,
      `Send unanswered calls to voicemail box "${input.voiceMenuName}" (reference: ${input.voiceMenuId}).`,
    ],
  };
}
