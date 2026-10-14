// Pure view helpers for SSH commit signing (#2938). React-free so they
// unit-test with `node --test`.
//
// A stored SSH key becomes a SIGNING key when it carries `signing: { name,
// email }` — the commit identity it signs as. The runtime resolves one per run,
// personal → team → global (orchestrator/commit-signing.js); with none, commits
// stay unsigned as before. Nothing here decides a tier: it only words the form,
// the hints and the effective-identity row.

import { personalUsageCell, personalCredentialChangeNotice } from './effective-identity-view.js';

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

// ── Which key signs, on the SSH Keys page (#2959) ───────────────────────────
// Signing is resolved independently of git transport: the owner's first
// personal key WITH a signing identity signs, whatever key carries transport.
// GET /api/ssh-keys marks every signing-capable row with `signingUsage`
// (api/ssh-signing-usage.js); `teams` is GET /api/me/baseline-teams — the
// caller's Agent Teams with their effective `signing` view.

const keyLabel = (rows, id) => {
  const r = (Array.isArray(rows) ? rows : []).find((x) => x && String(x.id) === String(id));
  return r && r.name && r.name !== r.id ? `${r.name} (${r.id})` : String(id);
};
const credLabel = (c) => (c ? (c.name && c.name !== c.id ? `${c.name} (${c.id})` : c.id) : '');
const teamName = (t) => t.displayName || t.agentId;
const signsAs = (row) => {
  const s = row && row.signing;
  if (!s || !s.email) return '';
  return ` as ${s.name ? `${s.name} <${s.email}>` : s.email}`;
};

/** The caller's teams whose commits `keyId` (their own personal key) signs. */
export function personalSigningTeams(teams, keyId) {
  return (Array.isArray(teams) ? teams : []).filter((t) => t?.signing?.source === 'personal'
    && t.signing.owner?.isYou && t.signing.credential?.id === String(keyId));
}

/**
 * The signing line of the "Used by" cell, or null for a key without a signing
 * identity. Personal: signs (and for which teams) or which key signs first.
 * Team/system: the environments it signs for.
 * @returns {{ label: string, title: string, active: boolean }|null}
 */
export function signingUsageLine(row, { rows = [], teams = [] } = {}) {
  const su = row && row.signingUsage;
  if (!su) return null;
  if (su.tier === 'personal') {
    if (su.active) {
      const ts = personalSigningTeams(teams, row.id);
      const names = ts.map(teamName).join(', ');
      return {
        label: `Signs commits (personal)${names ? ` — ${names}` : ''}`,
        title: `This key signs the commits of your chat turns${names ? ` and the automatic work of ${names}, where you are Team Admin` : ''}${signsAs(row)}. `
          + 'Signing is chosen separately from git transport: your first personal SSH key with a signing identity signs.',
        active: true,
      };
    }
    const first = su.signsFirstId ? keyLabel(rows, su.signsFirstId) : 'another key';
    return {
      label: `Signing identity set — not used: ${first} signs first`,
      title: `Only your first personal SSH key with a signing identity signs commits. Delete ${first} or clear its signing identity to sign with this one.`,
      active: false,
    };
  }
  const envs = Array.isArray(su.environments) ? su.environments : [];
  if (envs.length === 0) {
    return {
      label: 'Signing identity set — not used',
      title: 'No environment you can see signs with this key: another team or global signing key comes first, or no environment belongs to its team.',
      active: false,
    };
  }
  const names = envs.map((e) => e.name || e.id).join(', ');
  return {
    label: `Signs commits — ${envs.length === 1 ? names : `${envs.length} environments`}`,
    title: `Signs the commits of ${names}${signsAs(row)}, unless the Team Admin's personal signing key takes precedence.`,
    active: true,
  };
}

/**
 * The whole "Used by" cell of a personal SSH key: transport (#2655) plus
 * signing. Never "Not in use" for a key that signs. Null for a non-personal row.
 * @returns {{ label: string, title: string, active: boolean, signing: object|null }|null}
 */
export function personalSshUsageCell(row, ctx = {}) {
  const base = personalUsageCell(row, 'ssh');
  if (!base) return null;
  const signing = signingUsageLine(row, ctx);
  if (!base.active && signing?.active) {
    return {
      label: 'Not used for git transport', active: true, signing,
      title: 'Only one personal SSH key authenticates git transport — the one you added first. This key signs commits.',
    };
  }
  return { ...base, signing };
}

const FALLBACK_SIGNING = {
  team: (fb) => `signed with the team signing key ${credLabel(fb.credential)}`,
  global: () => 'signed with the global signing key',
  none: () => 'unsigned',
};

function sharedFallbackText(fb) {
  if (!fb || !FALLBACK_SIGNING[fb.source]) return "signed with the team's or the global signing key, or unsigned";
  const f = fb;
  if (f.source === 'team' && !f.credential) {
    return `signed with the team signing key ${f.name && f.name !== f.keyId ? `${f.name} (${f.keyId})` : f.keyId}`;
  }
  return FALLBACK_SIGNING[f.source](f);
}

/**
 * What deleting a key does to commit signing (AC3), or null when it signs
 * nothing. `items` name each team / environment and what it falls back to.
 * @returns {{ intro: string, items: string[] }|null}
 */
export function signingDeleteImpact(row, { rows = [], teams = [] } = {}) {
  const su = row && row.signingUsage;
  if (!su) return null;
  if (su.tier === 'personal') {
    if (!su.active) return null;
    const next = su.nextId ? `signed with your personal signing key ${keyLabel(rows, su.nextId)}` : null;
    const ts = personalSigningTeams(teams, row.id);
    if (ts.length === 0) {
      return {
        intro: `This key signs the commits of your chat turns. After deleting it they are ${next || "signed with the team's or the global signing key, or unsigned"}.`,
        items: [],
      };
    }
    return {
      intro: `This key signs commits. Deleting it changes the signing identity of ${ts.length === 1 ? 'your team' : `${ts.length} of your teams`}:`,
      items: ts.map((t) => `${teamName(t)} — then ${next || sharedFallbackText(t.signing.fallback)}`),
    };
  }
  const envs = Array.isArray(su.environments) ? su.environments : [];
  if (envs.length === 0) return null;
  return {
    intro: `This key signs commits. Deleting it changes the signing identity of ${envs.length === 1 ? '1 environment' : `${envs.length} environments`} (where no Team Admin's personal signing key takes precedence):`,
    items: envs.map((e) => `${e.name || e.id} — then ${sharedFallbackText(e.fallback)}`),
  };
}

const AFTER_SIGNING = {
  personal: (s) => `signs with your personal SSH key ${credLabel(s.credential)}`,
  team: (s) => `signs with the team signing key ${credLabel(s.credential)}`,
  global: () => 'signs with the global signing key',
  none: () => 'creates unsigned commits',
};

/**
 * The notice after adding or deleting a personal SSH key (AC2): the transport
 * outcome (#2655 `personalCredentialChangeNotice`) and, separately, the
 * signing outcome. Never says "not in use" about a key that signs.
 *   added:   `signing` — the new key's signing identity (or null).
 *   deleted: `signedTeamsBefore` — teams the deleted key signed for (read
 *            before the delete); `wasTransport` — it carried git transport.
 * `teams` is GET /api/me/baseline-teams AFTER the change.
 * @returns {string|null}
 */
export function personalSshChangeNotice({ action, teams, credentialId, restarted, signing = null, signedTeamsBefore = [], wasTransport = true } = {}) {
  const list = Array.isArray(teams) ? teams : [];
  if (action === 'added') {
    const transport = personalCredentialChangeNotice({ kind: 'ssh', action, teams: list, credentialId, restarted });
    if (!signing || !signing.email) return transport;
    const signed = personalSigningTeams(list, credentialId);
    if (signed.length) {
      const names = signed.map(teamName).join(', ');
      const signSentence = `Your new SSH key now signs the commits of ${signed.length === 1 ? 'your team' : `${signed.length} of your teams`} `
        + `(${names})${signsAs({ signing })} from their next run.`;
      const transportUsed = list.some((t) => t?.ssh?.source === 'personal' && t.ssh.owner?.isYou && t.ssh.credential?.id === String(credentialId));
      if (transportUsed) return `${signSentence} ${transport}`;
      const other = list.find((t) => t?.ssh?.source === 'personal' && t.ssh.owner?.isYou && t.ssh.credential);
      return other
        ? `${signSentence} Git transport keeps using your personal SSH key ${credLabel(other.ssh.credential)} — only the one added first authenticates git. No agent was restarted.`
        : signSentence;
    }
    const first = list.find((t) => t?.signing?.source === 'personal' && t.signing.owner?.isYou && t.signing.credential);
    if (!first) return transport;
    const shadow = `Its signing identity is not used: your personal SSH key ${credLabel(first.signing.credential)} signs first — only your first personal key with a signing identity signs.`;
    return transport ? `${transport} ${shadow}` : shadow;
  }
  if (action === 'deleted') {
    const transport = wasTransport ? personalCredentialChangeNotice({ kind: 'ssh', action, teams: list, credentialId, restarted }) : null;
    const before = Array.isArray(signedTeamsBefore) ? signedTeamsBefore : [];
    if (before.length === 0) return transport;
    const parts = before.map((b) => {
      const now = list.find((t) => t && t.agentId === b.agentId)?.signing || { source: 'none' };
      return `${teamName(b)} now ${(AFTER_SIGNING[now.source] || AFTER_SIGNING.none)(now)}`;
    });
    const sentence = `Commit signing changed: ${parts.join('; ')}.`;
    return transport ? `${transport} ${sentence}` : sentence;
  }
  return null;
}

/** Best-effort fetch of the baseline teams, then `personalSshChangeNotice`. */
export async function loadPersonalSshChangeNotice(fetchJson, args = {}) {
  try {
    const r = await fetchJson('/api/me/baseline-teams');
    return personalSshChangeNotice({ ...args, teams: r?.teams });
  } catch {
    return null;
  }
}
