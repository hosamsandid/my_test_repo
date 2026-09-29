import React from 'react';
import { CheckCircle2, AlertTriangle } from 'lucide-react';
import { classifyGithubToken } from '../pages/github-token-view';

/**
 * Live "does this look like a GitHub token" feedback shown directly under a
 * token textarea. The GitHub Tokens create and replace forms render this same
 * component so the guidance — and its wording — stay identical. Purely informational: it never blocks submit.
 *
 * Renders nothing until the user has typed something (kind === 'empty').
 */
export default function GithubTokenHint({ value }) {
  const { tone, message } = classifyGithubToken(value);
  if (!message) return null;

  const ok = tone === 'ok';
  const color = ok ? 'var(--eb-status-success)' : 'var(--eb-status-warning)';
  const Icon = ok ? CheckCircle2 : AlertTriangle;

  return (
    <div
      role="status"
      style={{
        display: 'flex',
        alignItems: 'flex-start',
        gap: 'var(--eb-space-1)',
        marginTop: 'var(--eb-space-1)',
        fontSize: 'var(--eb-text-xs)',
        color,
      }}
    >
      <Icon size={13} style={{ flexShrink: 0, marginTop: 1 }} aria-hidden="true" />
      <span>{message}</span>
    </div>
  );
}
