import React, {
  createContext,
  useContext,
  useEffect,
  useState,
} from 'react';
import { fetchMe, type CurrentUser } from '../api/client';

/**
 * Spec 550: SSO identity for the app.
 *
 * On mount we call GET /api/auth/me. In an SSO deployment the platform gateway has
 * already authenticated the request, so this returns the real signed-in user. Locally
 * (AUTH_MODE=local) it returns the dev user. The email is shown as the read-only user-id
 * badge and used by ChatContext as the `user_id` for memory/thread scoping.
 */
interface AuthContextValue {
  email: string;
  username: string;
  groups: string[];
  isLoading: boolean;
  error: string | null;
  // When true (public AI4 domain), the SPA must show the attendee capture gate.
  leadGate: boolean;
  // When true (public AI4 domain), the SPA shows only the stateless, cache-safe demo prompts.
  curatedPresets: boolean;
}

const AuthContext = createContext<AuthContextValue | null>(null);

const INITIAL: AuthContextValue = {
  email: '',
  username: '',
  groups: [],
  isLoading: true,
  error: null,
  leadGate: false,
  curatedPresets: false,
};

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [state, setState] = useState<AuthContextValue>(INITIAL);

  useEffect(() => {
    let cancelled = false;
    fetchMe()
      .then((user: CurrentUser) => {
        if (cancelled) return;
        setState({
          email: user.email,
          username: user.username,
          groups: user.groups ?? [],
          isLoading: false,
          error: null,
          leadGate: user.leadGate === true,
          curatedPresets: user.curatedPresets === true,
        });
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setState({
          ...INITIAL,
          isLoading: false,
          error: err instanceof Error ? err.message : 'not authenticated',
        });
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return <AuthContext.Provider value={state}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within AuthProvider');
  return ctx;
}
