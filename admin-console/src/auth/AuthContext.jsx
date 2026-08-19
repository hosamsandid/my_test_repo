import React, { createContext, useContext, useState, useEffect, useCallback, useMemo } from 'react';

// Auth state for the whole console (#276). Backed by an HttpOnly session cookie
// the server sets on login, so a browser refresh re-validates via
// GET /api/auth/session rather than re-prompting. This context is intentionally
// provider-agnostic: when SSO replaces the password check server-side, only the
// login() call's transport changes — `authenticated`/`user`/`logout` stay.
//
// `user` carries the server's authorization descriptor (#584): besides
// `username` it has `admin` (env admin OR System-Admin → full visibility),
// `envAdmin`, `systemAdmin`, `userId`, and `teams: [{teamId, role}]`. The UI
// reads `user.admin` to hide System-Admin-only pages and `user.teams` roles to
// gate per-team management actions.

const AuthContext = createContext(null);

// Dispatched by the API layer (useApi) when a request returns 401, so an
// expired/cleared session anywhere in the app drops the user back to login.
export const UNAUTHORIZED_EVENT = 'aee-unauthorized';

export function AuthProvider({ children }) {
  const [state, setState] = useState({ loading: true, authenticated: false, user: null });

  const refresh = useCallback(async () => {
    try {
      const res = await fetch('/api/auth/session');
      const data = await res.json();
      setState({ loading: false, authenticated: !!data.authenticated, user: data.user || null });
    } catch {
      // On a network error, fail closed (show login) rather than leak the console.
      setState({ loading: false, authenticated: false, user: null });
    }
  }, []);

  useEffect(() => { refresh(); }, [refresh]);

  // A 401 from any API call means the session is gone — reflect it immediately.
  useEffect(() => {
    const onUnauthorized = () =>
      setState(s => (s.authenticated ? { ...s, authenticated: false, user: null } : s));
    window.addEventListener(UNAUTHORIZED_EVENT, onUnauthorized);
    return () => window.removeEventListener(UNAUTHORIZED_EVENT, onUnauthorized);
  }, []);

  const login = useCallback(async (username, password) => {
    const res = await fetch('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password }),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error || 'Login failed');
    }
    const data = await res.json();
    setState({ loading: false, authenticated: true, user: data.user || null });
  }, []);

  const logout = useCallback(async () => {
    try {
      await fetch('/api/auth/logout', { method: 'POST' });
    } finally {
      setState({ loading: false, authenticated: false, user: null });
    }
  }, []);

  // Memoized so a provider re-render with unchanged inputs keeps a stable
  // `value` identity and doesn't invalidate every consumer's bailout. `state`
  // is replaced (never mutated) on each change, so depending on it is correct;
  // login/logout/refresh are already useCallback-stable.
  const value = useMemo(
    () => ({ ...state, login, logout, refresh }),
    [state, login, logout, refresh],
  );

  return (
    <AuthContext.Provider value={value}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within an AuthProvider');
  return ctx;
}
