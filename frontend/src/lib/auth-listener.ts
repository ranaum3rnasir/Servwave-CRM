import { supabase, getAccessToken } from './supabase';
import { useAuthStore } from '@/stores/auth.store';
import { setCachedUser } from '@/stores/auth.store';

// On this route the AuthCallbackPage owns the OAuth completion (finalize gatekeeper);
// the global listener must not race it by calling checkAuth() in parallel.
const OAUTH_CALLBACK_PATH = '/auth/callback';

let initialized = false;

export function initAuthListener(): void {
  if (initialized) return;
  initialized = true;

  supabase.auth.onAuthStateChange((event, session) => {
    const { checkAuth } = useAuthStore.getState();

    switch (event) {
      case 'INITIAL_SESSION':
        if (window.location.pathname === OAUTH_CALLBACK_PATH) break;
        // Session restored from storage — validate with backend
        if (session) {
          checkAuth();
        } else {
          useAuthStore.setState({ user: null, isAuthenticated: false, isLoading: false });
        }
        break;

      case 'SIGNED_IN':
        if (window.location.pathname === OAUTH_CALLBACK_PATH) break;
        // Re-auth the realtime socket so private channels keep a fresh JWT.
        {
          const token = getAccessToken();
          if (token) supabase.realtime.setAuth(token);
        }
        // Covers cross-tab sign-in (login() action handles the primary tab already)
        checkAuth();
        break;

      case 'SIGNED_OUT':
        // Cross-tab sign-out sync
        setCachedUser(null);
        useAuthStore.setState({ user: null, isAuthenticated: false, isLoading: false, error: null });
        break;

      case 'TOKEN_REFRESHED':
        // Re-auth the realtime socket with the refreshed JWT so private
        // channels (e.g. notification subscriptions) keep a valid token.
        {
          const token = getAccessToken();
          if (token) supabase.realtime.setAuth(token);
        }
        break;
    }
  });
}
