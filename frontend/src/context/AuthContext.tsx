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
 * On mount we call GET /api/auth/me. In deployed environments the Kanopy SSO
 * gateway has already authenticated the request and injected the JWT, so this
 * returns the real signed-in user. Locally (AUTH_DEV_BYPASS) it returns the dev
 * user. The email is shown as the read-only user-id badge and used by
 * ChatContext as the `user_id` for memory/thread scoping.
 */
interface AuthContextValue {
  email: string;
  username: string;
  groups: string[];
  isLoading: boolean;
  error: string | null;
}

const AuthContext = createContext<AuthContextValue | null>(null);

const INITIAL: AuthContextValue = {
  email: '',
  username: '',
  groups: [],
  isLoading: true,
  error: null,
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
