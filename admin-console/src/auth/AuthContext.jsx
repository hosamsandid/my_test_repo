import React, { createContext, useContext, useState, useEffect, useCallback } from 'react';

// Auth state for the whole console (#276). Backed by an HttpOnly session cookie
// the server sets on login, so a browser refresh re-validates via
// GET /api/auth/session rather than re-prompting. This context is intentionally
// provider-agnostic: when SSO replaces the password check server-side, only the
// login() call's transport changes — `authenticated`/`user`/`logout` stay.

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

  return (
    <AuthContext.Provider value={{ ...state, login, logout, refresh }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within an AuthProvider');
  return ctx;
}
