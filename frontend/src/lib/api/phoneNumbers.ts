import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import api from '@/lib/axios';

/**
 * Slice 3 — Caller-ID admin (phone-number ↔ user assignments).
 *
 * Reads/writes the tenant-scoped, admin-only endpoints under
 * `/api/communication` that the outbound resolver uses to pick a user's "from"
 * number:
 *   - which users may send from a number (the assignment set),
 *   - each user's personal default number,
 *   - the single org-wide default number.
 *
 * Same http client + query-key idiom as the sibling communication hooks
 * (`@/lib/api/communication`). Every mutation invalidates the one list query so
 * the page always renders server truth after a write.
 */

/** One user permitted to send from a number, with their per-number default flag. */
export type NumberAssignmentUser = {
  user_id: string;
  user_name: string;
  /** True when this number is the user's default caller ID. */
  is_default: boolean;
};

/** A phone number plus who can send from it and whether it's the org default. */
export type NumberAssignmentRow = {
  id: string;
  e164: string;
  label: string | null;
  is_org_default: boolean;
  assignments: NumberAssignmentUser[];
};

/** An org user — the pool the assignment checklist draws from. */
export type OrgUserOption = {
  id: string;
  name: string;
};

/** GET /api/communication/number-assignments response shape. */
export type NumberAssignmentsResponse = {
  numbers: NumberAssignmentRow[];
  users: OrgUserOption[];
};

/**
 * Master plan Task D2 — the one-time manual CTM-UI scaffold instructions
 * (`describeManualQueueScaffold` on the backend) for the half of inbound
 * routing that isn't confirmed API-drivable (Queue creation / Agent
 * assignment / No-Answer target / Distribute mode). Mirrors
 * `backend/src/lib/ctm/routing.ts`'s `ManualQueueScaffoldInstructions`.
 */
export type ManualQueueScaffoldInstructions = {
  title: string;
  summary: string;
  steps: string[];
};

/**
 * Result of the backend's CTM inbound-routing sync (Task D2), returned by
 * the assignment + org-default mutations. `synced:true` means the CONFIRMED
 * half (voicemail voice-menu + number dial-route) succeeded, and
 * `manual_scaffold` is the exact instructions for the one remaining manual
 * CTM step. `synced:false` means the sync didn't happen (CTM not
 * configured/connected, a bring-your-own number, or a live API failure) —
 * `reason` is safe, human-readable text for a warning banner.
 */
export type RoutingSyncResult =
  | {
      synced: true;
      voice_menu_id: string;
      voice_menu_name: string;
      manual_scaffold: ManualQueueScaffoldInstructions;
    }
  | { synced: false; reason: string };

/** PUT numbers/:id/assignments and PUT numbers/:id/org-default both return
 *  this shape — `routing` is `null` when no sync was attempted (e.g.
 *  unassigning to zero users, or unsetting the org default — see the
 *  backend controller for why that's a deliberate no-op, not a bug). */
export type AssignmentMutationResponse = { ok: true; routing: RoutingSyncResult | null };

/** Shared query key — mutations invalidate this exact key. */
const NUMBER_ASSIGNMENTS_KEY = ['communication', 'number-assignments'] as const;

/** The org's numbers with their user assignments + the org user pool.
 *  `enabled` gates the fetch — a non-admin / non-comm caller never requests the
 *  admin-only data (defence in depth on top of the page's fail-closed render). */
export function useNumberAssignments(enabled = true) {
  return useQuery<NumberAssignmentsResponse>({
    queryKey: NUMBER_ASSIGNMENTS_KEY,
    enabled,
    queryFn: () =>
      api.get('/api/communication/number-assignments').then((r) => r.data as NumberAssignmentsResponse),
  });
}

/** Set the exact set of users assigned to a number (PUT numbers/:id/assignments).
 *  The response's `routing` (Task D2) is what the page shows as post-assignment
 *  CTM setup guidance. */
export function useSetNumberAssignments() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, userIds }: { id: string; userIds: string[] }) =>
      api
        .put(`/api/communication/numbers/${id}/assignments`, { user_ids: userIds })
        .then((r) => r.data as AssignmentMutationResponse),
    onSuccess: () => qc.invalidateQueries({ queryKey: NUMBER_ASSIGNMENTS_KEY }),
  });
}

/** Set/clear a user's default number (PUT users/:userId/default-number). The
 *  number must already be assigned to the user; `phoneNumberId: null` clears. */
export function useSetUserDefaultNumber() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ userId, phoneNumberId }: { userId: string; phoneNumberId: string | null }) =>
      api
        .put(`/api/communication/users/${userId}/default-number`, { phone_number_id: phoneNumberId })
        .then((r) => r.data),
    onSuccess: () => qc.invalidateQueries({ queryKey: NUMBER_ASSIGNMENTS_KEY }),
  });
}

/** Set/unset the single org-default number (PUT numbers/:id/org-default).
 *  Setting one clears any prior; `isOrgDefault: false` unsets. Same D2
 *  `routing` guidance shape as `useSetNumberAssignments`. */
export function useSetOrgDefaultNumber() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, isOrgDefault }: { id: string; isOrgDefault: boolean }) =>
      api
        .put(`/api/communication/numbers/${id}/org-default`, { is_org_default: isOrgDefault })
        .then((r) => r.data as AssignmentMutationResponse),
    onSuccess: () => qc.invalidateQueries({ queryKey: NUMBER_ASSIGNMENTS_KEY }),
  });
}

/**
 * Task B3 — the `/phone` tab's caller-ID PICKER allow-list. ONLY the current
 * user's own assigned numbers plus the org default (deduped) — never the full
 * org roster (that's `useNumberAssignments` above, ADMIN-gated) and never
 * free text. Backs the from-number dropdown in `PhoneShell`.
 */
export type MyNumberOption = {
  phone_number_id: string;
  ctm_number_id: string;
  formatted: string | null;
  is_org_default: boolean;
  is_user_default: boolean;
};

/** GET /api/communication/my-numbers response shape. */
export type MyNumbersResponse = { numbers: MyNumberOption[] };

/** Shared query key. */
const MY_NUMBERS_KEY = ['communication', 'my-numbers'] as const;

/** The current user's allow-listed caller-ID options. `enabled` gates the
 *  fetch — only the office-softphone path (the `/phone` tab) needs it. */
export function useMyNumbers(enabled = true) {
  return useQuery<MyNumbersResponse>({
    queryKey: MY_NUMBERS_KEY,
    enabled,
    queryFn: () => api.get('/api/communication/my-numbers').then((r) => r.data as MyNumbersResponse),
  });
}

/** The per-agent CTM softphone access payload (slice 1 endpoint). The embedded
 *  WebRTC device authenticates with this — the agency keys never reach the
 *  browser. The whole object must reach the embed's `accessToken` setter (it
 *  binds the device via account_id / user.account), so extra CTM fields are
 *  preserved via the index signature — never narrowed to `{ token }`. */
export type PhoneAccessToken = { token: string; valid_until?: number; [key: string]: unknown };

/** POST /api/communication/phone-access — the `getToken` the softphone wrapper
 *  calls. Kept as a plain async fn (not a hook) so the imperative embed wrapper
 *  can await it outside React. */
export async function requestPhoneAccessToken(): Promise<PhoneAccessToken> {
  const { data } = await api.post('/api/communication/phone-access');
  return data as PhoneAccessToken;
}
