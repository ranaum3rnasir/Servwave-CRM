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

/** PUT numbers/:id/assignments and PUT numbers/:id/org-default both return
 *  this. Assignment is a pure DB write: it records who is responsible for a
 *  number, and deliberately does NOT change where that number rings (routing
 *  lives on the number itself - see `useUpdateNumberForwarding`). */
export type AssignmentMutationResponse = { ok: true };

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
 *  The set is absolute - what is sent is what the number ends up with. */
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
 *  Setting one clears any prior; `isOrgDefault: false` unsets. */
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
 * free text. Backs the from-number dropdown in `PhoneTabPage`.
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
