import React, { useState } from 'react';
import { LogIn } from 'lucide-react';
import { useAuth } from '../auth/AuthContext';
import AccentureLogo from '../components/AccentureLogo';
import PasswordField from '../components/PasswordField';

// Full-screen login gate (#276). Rendered instead of the console whenever there
// is no active session. On success the AuthProvider flips to authenticated and
// the real console mounts.
export default function Login() {
  const { login } = useAuth();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState(null);
  const [submitting, setSubmitting] = useState(false);

  const onSubmit = async (e) => {
    e.preventDefault();
    if (submitting) return;
    setError(null);
    setSubmitting(true);
    try {
      await login(username, password);
    } catch (err) {
      setError(err.message || 'Login failed');
      setPassword('');
    } finally {
      setSubmitting(false);
    }
  };

  const fieldStyle = {
    width: '100%',
    padding: 'var(--eb-space-2) var(--eb-space-3)',
    background: 'var(--eb-bg-app)',
    border: '1px solid var(--eb-border-default)',
    borderRadius: 'var(--eb-radius-md)',
    color: 'var(--eb-text-primary)',
    fontSize: 'var(--eb-text-md)',
    fontFamily: 'inherit',
    boxSizing: 'border-box',
  };

  const labelStyle = {
    display: 'block',
    fontSize: 'var(--eb-text-sm)',
    color: 'var(--eb-text-secondary)',
    marginBottom: 'var(--eb-space-1)',
  };

  return (
    <div style={{
      position: 'fixed', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center',
      background: 'var(--eb-bg-app)', padding: 'var(--eb-space-6)',
    }}>
      <form
        onSubmit={onSubmit}
        style={{
          width: '100%', maxWidth: 360,
          background: 'var(--eb-bg-surface)',
          border: '1px solid var(--eb-border-default)',
          borderRadius: 'var(--eb-radius-lg)',
          padding: 'var(--eb-space-6)',
          boxShadow: 'var(--eb-shadow-lg, 0 10px 30px rgba(0,0,0,0.25))',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--eb-space-2)', marginBottom: 'var(--eb-space-2)' }}>
          <AccentureLogo size={24} style={{ color: 'var(--eb-accent-primary)' }} />
          <span style={{ fontWeight: 'var(--eb-font-semibold)', fontSize: 'var(--eb-text-lg)' }}>Agent Studio</span>
        </div>
        <p style={{ margin: `0 0 var(--eb-space-5)`, color: 'var(--eb-text-muted)', fontSize: 'var(--eb-text-sm)' }}>
          Sign in to continue
        </p>

        <div style={{ marginBottom: 'var(--eb-space-4)' }}>
          <label htmlFor="login-username" style={labelStyle}>Username</label>
          <input
            id="login-username"
            type="text"
            autoComplete="username"
            autoFocus
            value={username}
            onChange={e => setUsername(e.target.value)}
            style={fieldStyle}
          />
        </div>

        <div style={{ marginBottom: 'var(--eb-space-4)' }}>
          <label htmlFor="login-password" style={labelStyle}>Password</label>
          <PasswordField
            id="login-password"
            autoComplete="current-password"
            value={password}
            onChange={e => setPassword(e.target.value)}
            style={fieldStyle}
          />
        </div>

        {error && (
          <div role="alert" style={{
            marginBottom: 'var(--eb-space-4)',
            padding: 'var(--eb-space-2) var(--eb-space-3)',
            background: 'var(--eb-status-error-bg, rgba(220,38,38,0.12))',
            border: '1px solid var(--eb-status-error, #dc2626)',
            borderRadius: 'var(--eb-radius-md)',
            color: 'var(--eb-status-error, #dc2626)',
            fontSize: 'var(--eb-text-sm)',
          }}>
            {error}
          </div>
        )}

        <button
          type="submit"
          disabled={submitting}
          style={{
            width: '100%',
            display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 'var(--eb-space-2)',
            padding: 'var(--eb-space-2) var(--eb-space-3)',
            background: 'var(--eb-accent-primary)',
            color: 'var(--eb-bg-app)',
            border: 'none',
            borderRadius: 'var(--eb-radius-md)',
            fontSize: 'var(--eb-text-md)',
            fontWeight: 'var(--eb-font-semibold)',
            fontFamily: 'inherit',
            cursor: submitting ? 'default' : 'pointer',
            opacity: submitting ? 0.7 : 1,
          }}
        >
          <LogIn size={16} />
          {submitting ? 'Signing in…' : 'Sign in'}
        </button>
      </form>
    </div>
  );
}
