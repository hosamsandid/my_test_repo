// repository-fields-view.js — pure state decisions for the shared repository
// configuration card (#2067). Kept out of the JSX per the #651 convention so
// it can be node:test covered.
//
// The Working Environment's repository card is the one place a repository is
// configured in this console, and #2067 D2 says the agent-scoped form must
// mirror it — same fields, same helper copy, no reduced and no invented form.
// The way to keep that true is to render ONE component on both surfaces (the
// #1928/#1929 extraction discipline), which leaves exactly one thing that
// legitimately differs: WHERE the reader is pointed for the GitHub token.
//
// On the environment form the token field is literally below the card. On the
// agent surfaces there is no token field at all — an agent-scoped repository
// carries no credential of its own (D5) and uses the environment's token — so
// "set below" would be a false instruction. Only that pointer clause varies;
// the SSH-vs-HTTPS substance is identical, which is what AC2 asks for. The
// marked-up copy itself stays in the JSX (it carries <code>/<em>); this module
// owns which of the two variants applies and when the hint shows at all.

export const TOKEN_TARGETS = ['form', 'environment'];

// Unknown/absent → 'form', the environment form's own behaviour, so a caller
// that forgets the prop gets the pre-#2067 card rather than a blank pointer.
export function normalizeTokenTarget(target) {
  return TOKEN_TARGETS.includes(target) ? target : 'form';
}

// True when the token lives somewhere the reader has to navigate to (the
// Working Environment) rather than in this very form.
export function tokenIsElsewhere(target) {
  return normalizeTokenTarget(target) === 'environment';
}

// A private HTTPS repository fails the probe when no GitHub token is bound.
// SSH keys do not apply to HTTPS transports, so the hint must point at the
// token rather than let the reader try a key — the client-side twin of the
// server's AC19 refusal. Deliberately only on a FAILED probe: an HTTPS URL
// that resolves fine (a public repo) needs no nudge.
export function shouldShowTokenHint(check, url, githubTokenId) {
  const status = check && check.status;
  const isHttps = /^https:\/\//i.test(String(url || '').trim());
  return status === 'error' && isHttps && !githubTokenId;
}

// One repository row's edit state, normalised for the form. Mirrors the
// environment form's `initialRepositories` per-entry shape (empty strings, not
// nulls, so the inputs stay controlled).
export function blankRepositoryRow() {
  return { url: '', branch: '', sshKeyId: '', readOnly: false };
}

// The submit payload for one row: the API contract's four fields, with the
// form's empty strings folded back to nulls. Same shaping the environment
// form's submit does, so the two produce byte-identical entries.
export function repositoryRowPayload(row) {
  const r = row && typeof row === 'object' ? row : {};
  return {
    url: String(r.url || '').trim(),
    branch: String(r.branch || '').trim() || null,
    sshKeyId: r.sshKeyId || null,
    readOnly: r.readOnly === true,
  };
}
