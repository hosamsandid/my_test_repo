// Pure view helpers for SSH commit signing (#2938). React-free so they
// unit-test with `node --test`.
//
// A stored SSH key becomes a SIGNING key when it carries `signing: { name,
// email }` — the commit identity it signs as. The runtime resolves one per run,
// personal → team → global (orchestrator/commit-signing.js); with none, commits
// stay unsigned as before. Nothing here decides a tier: it only words the form,
// the hints and the effective-identity row.

// In-app setup steps: the SSH Keys page opens its New-key panel with signing on
// (SshKeys.jsx reads `?new=signing`), where the steps are shown next to the form.
export const SIGNING_SETUP_HREF = '/ssh-keys?new=signing';
export const GITHUB_SIGNING_DOCS_HREF = 'https://docs.github.com/en/authentication/managing-commit-signature-verification/about-commit-signature-verification#ssh-commit-signature-verification';

export const SIGNING_UPLOAD_HINT = 'Add this public key on GitHub as a Signing Key (Settings → SSH and GPG keys → New SSH key → Key type: Signing Key) to the account whose verified email is the commit email. Commits only show as Verified when that email is verified on that account.';

const EMAIL_RE = /^[^\s@<>"',;]+@[^\s@<>"',;]+\.[^\s@<>"',;]+$/;

/** Initial form state from a stored key (or a blank one). */
export function signingFormValue(cred, { enabled = false } = {}) {
  const s = cred && cred.signing;
  return s ? { enabled: true, name: s.name || '', email: s.email || '' } : { enabled, name: '', email: '' };
}

/** Field error for the signing form, or null. Mirrors api/ssh-signing.js. */
export function signingFormError(v) {
  if (!v || !v.enabled) return null;
  const name = String(v.name || '').trim();
  const email = String(v.email || '').trim();
  if (!name) return 'Enter the commit name this key signs as.';
  if (name.length > 100 || /[\r\n<>]/.test(name)) return 'The commit name must be at most 100 characters, without < or >.';
  if (!email) return 'Enter the commit email this key signs as.';
  if (!EMAIL_RE.test(email)) return 'Enter a valid email address.';
  return null;
}

/**
 * The `signing` body field. Create: undefined when off (field omitted). Edit:
 * null when switched off on a key that had it (clears), undefined when nothing changed.
 */
export function signingPayload(v, { previous = null } = {}) {
  if (v && v.enabled) return { name: String(v.name || '').trim(), email: String(v.email || '').trim() };
  return previous ? null : undefined;
}

/** "Signs as Bot <bot@corp.com>" for a table cell, or null. */
export function signingCell(row) {
  const s = row && row.signing;
  if (!s || !s.email) return null;
  return { label: `Signs as ${s.name ? `${s.name} <${s.email}>` : s.email}`, email: s.email };
}

const SCOPE_WORD = { personal: 'personal', team: 'team', system: 'global' };

/**
 * The non-blocking recommendation (AC10). `keys` are the SSH keys the caller
 * can see; a hint is shown while none of them signs commits. Never an error:
 * without a key commits are simply unsigned.
 * @returns {{ text: string, href: string }|null}
 */
export function signingRecommendation(keys, { context = 'ssh' } = {}) {
  const list = Array.isArray(keys) ? keys : [];
  if (list.some((k) => k && k.signing && k.signing.email)) return null;
  const subject = context === 'github'
    ? 'Commits your agents push with these tokens are unsigned:'
    : context === 'team'
      ? "This team's commits are unsigned:"
      : 'Agent commits are unsigned:';
  return {
    text: `${subject} no SSH signing key is set up. A signing key is recommended, and mandatory on GitHub instances that enforce verified commits (Accenture GitHub Enterprise from 2026-10-23) — pushes of unsigned commits are rejected there.`,
    href: SIGNING_SETUP_HREF,
  };
}

/** Which tiers the caller can see a signing key in — for the SSH Keys page hint detail. */
export function signingScopesPresent(keys) {
  const out = new Set();
  for (const k of Array.isArray(keys) ? keys : []) {
    if (k && k.signing && k.signing.email) out.add(SCOPE_WORD[k.scope] || 'team');
  }
  return [...out];
}

/**
 * The signing row of the team's "Effective GitHub identity" box. Input is the
 * redacted `signing` view from api/effective-github-identity.js.
 * @returns {{ headline: string, detail: string, tone: 'ok'|'info'|'warning' }}
 */
export function describeEffectiveSigning(view) {
  const v = view || {};
  const as = v.identity?.email ? ` — signs as ${v.identity.name ? `${v.identity.name} <${v.identity.email}>` : v.identity.email}` : '';
  if (v.source === 'personal') {
    return v.owner?.isYou
      ? { headline: `Your personal signing key${v.credential ? ` — ${v.credential.name || v.credential.id}` : ''}`, detail: `Commits are signed${as}.`, tone: 'info' }
      : { headline: `Team Admin's personal signing key — ${v.owner?.label || 'the Team Admin'}`, detail: 'Automatic runs sign their commits with it.', tone: 'info' };
  }
  if (v.source === 'team') {
    return { headline: `Team signing key — ${v.credential?.name || v.credential?.id || ''}`, detail: `Commits are signed${as}.`, tone: 'ok' };
  }
  if (v.source === 'global') {
    return { headline: 'Global signing key', detail: `No personal or team signing key, so the platform-wide one is used${as}.`, tone: 'ok' };
  }
  return { headline: 'None configured', detail: 'Commits are unsigned.', tone: 'warning' };
}
