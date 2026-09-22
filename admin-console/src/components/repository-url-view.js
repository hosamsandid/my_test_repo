// repository-url-view.js — pure GitHub URL canonicalization for the shared
// repository card (#2345). Kept out of the JSX per the #651 convention so it
// can be node:test covered, exactly like its sibling `repository-fields-view.js`.
//
// The card takes a repository URL as typed and never reconciles it against the
// selected credential: paste an `https://github.com/<org>/<repo>` URL, pick an
// SSH key, and the live reachability probe runs an unauthenticated HTTPS
// `git ls-remote` (Git follows the URL's own scheme, ignoring the key) and
// surfaces the raw `fatal: could not read Username…` failure. The platform
// already normalizes a pasted GitHub URL to its canonical SSH form for the
// one-shot `POST /api/quickstart` flow (`admin-console/api/repo-identity.js`'s
// `parseGitHubUrl`/`sshUrl`); this module ports that golden logic into a
// frontend-usable ESM so the same rewrite can happen field-by-field on the
// repository card (#2345), consolidating the partial regex copies that had been
// duplicated across the client (e.g. `process/edit-adapters.js`).

// Mirrors SEGMENT_RE in admin-console/api/repo-identity.js — a parsed
// owner/name can only be the same safe character class the backend accepts.
const SEGMENT_RE = /^[A-Za-z0-9._-]+$/;

// Frontend mirror of `parseGitHubUrl` in admin-console/api/repo-identity.js
// (the golden reference). Recognizes a github.com URL in any of its forms —
// `git@github.com:org/repo`, `ssh://git@github.com/org/repo`,
// `https://[www.]github.com/org/repo`, and bare `github.com/org/repo` — each
// tolerant of an optional `.git` suffix and a trailing slash. Returns
// `{ org, repo, sshUrl, httpsUrl }`, or `null` for anything that is not a
// parseable github.com URL. The one deliberate difference from the backend
// twin: this returns `null` where the server throws, because a pure form helper
// wants a value it can branch on, not an exception (non-github remotes have no
// canonical SSH form — `deriveRepoIdentity` returns `sshUrl: null` for them, so
// they are left untouched here too).
export function parseGitHubUrl(input) {
  const raw = String(input || '').trim();
  if (!raw) return null;

  // git@github.com:org/repo(.git)
  let m = raw.match(/^git@github\.com:([^/]+)\/([^/]+?)(?:\.git)?\/?$/i);
  if (!m) {
    // ssh://git@github.com/org/repo(.git)
    m = raw.match(/^ssh:\/\/git@github\.com\/([^/]+)\/([^/]+?)(?:\.git)?\/?$/i);
  }
  if (!m) {
    // https://[www.]github.com/org/repo(.git) with an optional trailing slash
    m = raw.match(/^https?:\/\/(?:www\.)?github\.com\/([^/]+)\/([^/]+?)(?:\.git)?\/?$/i);
  }
  if (!m) {
    // Bare github.com/org/repo
    m = raw.match(/^github\.com\/([^/]+)\/([^/]+?)(?:\.git)?\/?$/i);
  }
  if (!m) return null;

  const org = m[1];
  const repo = m[2];
  if (!SEGMENT_RE.test(org) || !SEGMENT_RE.test(repo)) return null;
  return {
    org,
    repo,
    sshUrl: `git@github.com:${org}/${repo}.git`,
    httpsUrl: `https://github.com/${org}/${repo}.git`,
  };
}

// True when the URL is already in one of github.com's SSH forms. Used to make
// the rewrite a no-op for a URL the user already typed as SSH (AC8), preserving
// an `ssh://git@github.com/…` URL as the user left it rather than folding it to
// the `git@github.com:…` scp-style form.
export function isGitHubSshUrl(url) {
  const raw = String(url || '').trim();
  return /^git@github\.com:/i.test(raw) || /^ssh:\/\/git@github\.com\//i.test(raw);
}

// The URL that should be committed for a repository row given its current URL
// text and whether an SSH key is selected. Rewrites a github.com HTTPS (or bare)
// URL to its canonical `git@github.com:<org>/<repo>.git` form ONLY when a key is
// selected and the URL is not already an SSH URL; returns the URL byte-for-byte
// unchanged in every other case:
//   • no SSH key selected            → untouched (AC10; the reverse HTTPS rule is unchanged)
//   • non-github.com remote          → untouched (AC7; no canonical SSH form exists)
//   • already an SSH github.com URL   → no-op    (AC8; no re-rewrite, no double `.git`)
//   • unparseable / still-typing text → untouched
// The rewritten URL always ends in `.git` regardless of the pasted suffix (AC4),
// because it is rebuilt from the parsed `{org, repo}` (AC1–AC3). No other field
// is consulted or returned (AC5) — the caller applies this to the URL alone.
export function canonicalizeRepoUrlForSshKey(url, sshKeyId) {
  if (!sshKeyId) return url;            // AC10 — no key: leave HTTPS as the user typed it
  if (isGitHubSshUrl(url)) return url;  // AC8  — already SSH: no-op
  const parsed = parseGitHubUrl(url);
  if (!parsed) return url;              // AC7  — non-github / unparseable: untouched
  return parsed.sshUrl;                 // AC1–AC4 — canonical SSH form, always `.git`
}
