// Repository identity helpers, extracted from api.js so the URL parsing can be
// unit-tested in isolation (node --test) without spinning up the server
// (#667 — E2E F1 needs team creation to tolerate a non-github in-stack remote).
//
// Two functions:
//   - parseGitHubUrl:    strict github.com parser (behaviour unchanged from the
//                        original in-file definition — the golden reference).
//   - deriveRepoIdentity: tolerant resolver used at the team-creation call sites.
//                        GitHub URLs parse exactly as before; a non-github remote
//                        (self-hosted / GitLab / Gitea / the in-stack e2e remote)
//                        derives a best-effort {org, repo} from the URL path
//                        instead of hard-failing with a 400. This keeps the #586
//                        repo-required guardrail intact — it only stops assuming
//                        every repository lives on github.com.

// Character class shared by both the github.com parser and the tolerant
// fallback, so a derived owner/name can never smuggle odd strings into the
// member trigger repo fields that a parsed github identity couldn't.
const SEGMENT_RE = /^[A-Za-z0-9._-]+$/;

function parseGitHubUrl(input) {
  const raw = String(input || '').trim();
  if (!raw) throw new Error('GitHub URL is required');

  // git@github.com:org/repo(.git)
  let m = raw.match(/^git@github\.com:([^/]+)\/([^/]+?)(?:\.git)?\/?$/i);
  if (!m) {
    // ssh://git@github.com/org/repo(.git)
    m = raw.match(/^ssh:\/\/git@github\.com\/([^/]+)\/([^/]+?)(?:\.git)?\/?$/i);
  }
  if (!m) {
    // https://github.com/org/repo(.git) or http(s) with optional trailing path
    m = raw.match(/^https?:\/\/(?:www\.)?github\.com\/([^/]+)\/([^/]+?)(?:\.git)?\/?$/i);
  }
  if (!m) {
    // Bare github.com/org/repo
    m = raw.match(/^github\.com\/([^/]+)\/([^/]+?)(?:\.git)?\/?$/i);
  }
  if (!m) throw new Error('Could not parse a GitHub repository URL (expected github.com/<org>/<repo>)');

  const org = m[1];
  const repo = m[2];
  if (!SEGMENT_RE.test(org) || !SEGMENT_RE.test(repo)) {
    throw new Error('GitHub URL contains unexpected characters');
  }
  return {
    org,
    repo,
    sshUrl: `git@github.com:${org}/${repo}.git`,
    httpsUrl: `https://github.com/${org}/${repo}.git`,
  };
}

// Derive {org, repo, sshUrl, httpsUrl} for member trigger repo fields.
//
// A github.com URL keeps its EXACT current parse (delegates to parseGitHubUrl,
// including the canonical ssh/https rewrites). A non-github remote derives a
// best-effort owner/name from the last two path segments and preserves the
// original URL as httpsUrl (there is no canonical ssh form for it, so sshUrl is
// null). The derived segments pass the same character validation as a parsed
// github identity — an unparseable/odd URL still throws, so callers 400 exactly
// as they do today for genuinely malformed input.
function deriveRepoIdentity(url) {
  try {
    return parseGitHubUrl(url); // github.com — byte-for-byte unchanged
  } catch {
    const raw = String(url || '').trim();
    // A non-github remote reaches this point only as a real URL with a scheme
    // (a scheme-less string is unclonable — `git clone` treats it as a local
    // path). Take the last two *path* segments (never the host) as owner/repo.
    let segments = [];
    try {
      const parsed = new URL(raw);
      segments = parsed.pathname.replace(/\.git$/i, '').split('/').filter(Boolean);
    } catch {
      segments = [];
    }
    const repo = segments.pop();
    const org = segments.pop();
    if (!org || !repo || !SEGMENT_RE.test(org) || !SEGMENT_RE.test(repo)) {
      throw new Error(`Could not derive owner/repo from '${url}'`);
    }
    return { org, repo, sshUrl: null, httpsUrl: raw };
  }
}

module.exports = { parseGitHubUrl, deriveRepoIdentity };
