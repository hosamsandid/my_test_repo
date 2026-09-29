// Pure, framework-free helper that gives a user *immediate* feedback on the
// GitHub token they are pasting, before they submit the form. The GitHub Tokens
// page (GithubTokens.jsx) used to accept the secret blind: a stray line break, a
// copied "ghp_…" placeholder, or the wrong string only surfaced as a late server
// error. `classifyGithubToken` reads the raw textarea value and returns a small
// verdict object the form renders, so the guidance is consistent and a
// first-time user gets a green "recognised" tick (or a plain-language
// warning) the moment they paste.
//
// It is a hint, never a hard gate: an "unknown" verdict must NOT block submit
// (GitHub may add new prefixes, and self-hosted setups differ). The forms keep
// their existing "non-empty" submit rule; this only informs.
//
// Contract: classifyGithubToken(raw) → { kind, tone, message }.
//   kind: 'empty' | 'fine-grained' | 'classic' | 'other-github' | 'whitespace' | 'unknown'
//   tone: 'muted' (say nothing / neutral) | 'ok' (looks right) | 'warn' (double-check)
//   message: a short, plain-language line ('' when kind === 'empty').
// Unit-tested without a React/DOM runtime.

// The single source of truth for the "what a GitHub token looks like" hint,
// shared by both forms so their copy can no longer drift apart.
export const GITHUB_TOKEN_PREFIX_HINT =
  'Fine-grained tokens start with github_pat_, classic tokens with ghp_.';

// Known GitHub secret prefixes. The two a person pastes into these forms are
// the fine-grained and classic PATs; the rest are recognised as valid GitHub
// tokens so we never cry wolf on a legitimate value.
const RECOGNISED = [
  { re: /^github_pat_/, kind: 'fine-grained', message: 'Looks like a fine-grained personal access token.' },
  { re: /^ghp_/,        kind: 'classic',      message: 'Looks like a classic personal access token.' },
  { re: /^gho_/,        kind: 'other-github', message: 'Looks like a GitHub OAuth token.' },
  { re: /^gh[su]_/,     kind: 'other-github', message: 'Looks like a GitHub App token.' },
  { re: /^ghr_/,        kind: 'other-github', message: 'Looks like a GitHub refresh token.' },
];

export function classifyGithubToken(raw) {
  const value = raw == null ? '' : String(raw);
  const trimmed = value.trim();

  if (trimmed === '') {
    return { kind: 'empty', tone: 'muted', message: '' };
  }

  // A space or line break *inside* the token is the most common paste mistake
  // (a wrapped copy, or two values pasted together). Leading/trailing space is
  // fine — both forms .trim() before saving — so only flag internal whitespace.
  if (/\s/.test(trimmed)) {
    return {
      kind: 'whitespace',
      tone: 'warn',
      message: 'This contains a space or line break — paste only the token value, with nothing before or after it.',
    };
  }

  for (const p of RECOGNISED) {
    if (p.re.test(trimmed)) {
      return { kind: p.kind, tone: 'ok', message: p.message };
    }
  }

  return {
    kind: 'unknown',
    tone: 'warn',
    message: `This doesn't look like a GitHub token. ${GITHUB_TOKEN_PREFIX_HINT}`,
  };
}
