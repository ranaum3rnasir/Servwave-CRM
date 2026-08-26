import type { MessageThread } from '@/lib/api/communication';

/** Merge server threads into local state by id - server rows win, optimistic
 * local-only threads (unsaved team/group lanes, still-posting customer
 * threads) stay on top. A local customer thread is dropped once the server's
 * thread for that customer arrives (the send's find-or-create lands in the
 * seed), so polling never duplicates a conversation. Pure + convergent -
 * merge(merge(prev, seed), seed) === merge(prev, seed) - so the seed effect
 * can re-run safely (the jsdom seed-effect-loop hazard). */
export function mergeServerThreads(
  local: MessageThread[],
  server: MessageThread[],
): MessageThread[] {
  const serverIds = new Set(server.map((t) => t.id));
  const serverCustomerIds = new Set(server.map((t) => t.customerId).filter(Boolean));
  const localOnly = local.filter(
    (t) => !serverIds.has(t.id) && !(t.customerId && serverCustomerIds.has(t.customerId)),
  );
  return [...localOnly, ...server];
}
