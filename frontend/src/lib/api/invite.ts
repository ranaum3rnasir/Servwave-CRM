import api from '@/lib/axios';

export interface InviteInfo {
  email: string;
  first_name: string;
}

/**
 * Validate the invite token and fetch who it's for (to greet the page).
 * POST (not GET) so the single-use token stays in the request body, never the
 * URL — keeps it out of backend request logs and proxy access logs.
 */
export async function getInviteInfo(token: string): Promise<InviteInfo> {
  const { data } = await api.post('/api/auth/invite', { token });
  return data as InviteInfo;
}

/** Set the password for an invited user + record ToS/Privacy acceptance. Resolves on success; throws on failure. */
export async function acceptInvite(token: string, password: string, acceptedTerms: boolean): Promise<void> {
  await api.post('/api/auth/accept-invite', { token, password, accepted_terms: acceptedTerms });
}

/** Record ToS/Privacy acceptance for an invited user WITHOUT setting a password (Google path). */
export async function recordInviteConsent(token: string): Promise<void> {
  await api.post('/api/auth/accept-invite/terms', { token, accepted_terms: true });
}
